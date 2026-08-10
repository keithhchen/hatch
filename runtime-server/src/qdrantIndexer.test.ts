import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  KnowledgeIndexUnavailable,
  QdrantKnowledgeIndexer,
  knowledgeIndexMaxResponseBytes,
  knowledgeIndexRequestTimeoutMs,
  type KnowledgeDocument,
} from "./qdrantIndexer.js";

const CORPUS_DIGEST = `sha256:${"a".repeat(64)}`;
const OLD_CORPUS_DIGEST = `sha256:${"b".repeat(64)}`;

test("knowledge index HTTP settings are bounded", () => {
  assert.equal(knowledgeIndexRequestTimeoutMs({}), 10_000);
  assert.equal(knowledgeIndexRequestTimeoutMs({ HATCH_KNOWLEDGE_INDEX_REQUEST_TIMEOUT_MS: "250" }), 250);
  assert.throws(
    () => knowledgeIndexRequestTimeoutMs({ HATCH_KNOWLEDGE_INDEX_REQUEST_TIMEOUT_MS: "10" }),
    /HATCH_KNOWLEDGE_INDEX_REQUEST_TIMEOUT_MS/,
  );
  assert.equal(knowledgeIndexMaxResponseBytes({}), 4 * 1024 * 1024);
  assert.throws(
    () => knowledgeIndexMaxResponseBytes({ HATCH_KNOWLEDGE_INDEX_MAX_RESPONSE_BYTES: "100" }),
    /HATCH_KNOWLEDGE_INDEX_MAX_RESPONSE_BYTES/,
  );
});

test("Qdrant stages points under corpus_digest and only deletes an explicitly old digest", async (context) => {
  const requests: Array<{ method: string; pathname: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const body = await readJsonBody(request);
    requests.push({ method: request.method ?? "", pathname: request.url ?? "", body });
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/embeddings")) {
      const input = Array.isArray(body.input) ? body.input : [];
      response.end(JSON.stringify({
        data: input.map(() => ({ embedding: Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0) })),
      }));
      return;
    }
    response.end(JSON.stringify({ result: { status: "ok" } }));
  });
  const baseUrl = await listen(server);
  context.after(() => closeServer(server));
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-qdrant-stage-"));
  await writeFile(path.join(root, "knowledge.md"), "# Evidence\n\nUse the staged version.\n", "utf8");
  const indexer = new QdrantKnowledgeIndexer(baseUrl, "qdrant-key", "dashscope-key", {
    collection: "test-corpus-digests",
    embeddingBaseUrl: baseUrl,
    requestTimeoutMs: 1_000,
  });

  await indexer.stageAgentDocuments("maya", "signal", CORPUS_DIGEST, root, [document()]);
  const requestsBeforeCleanup = [...requests];
  assert.equal(requestsBeforeCleanup.some((request) => request.pathname.includes("points/delete")), false);
  const upsert = requestsBeforeCleanup.find((request) => request.pathname.includes("/points?wait=true"));
  assert.ok(upsert);
  const points = upsert.body.points as Array<{ payload: Record<string, unknown> }>;
  assert.equal(points[0]?.payload.corpus_digest, CORPUS_DIGEST);

  await indexer.deleteAgentDocuments("maya", "signal", OLD_CORPUS_DIGEST);
  const deletion = [...requests].reverse().find((request) => request.pathname.includes("points/delete"));
  const must = ((deletion?.body.filter as Record<string, unknown>)?.must ?? []) as Array<Record<string, unknown>>;
  assert.deepEqual(must.at(-1), { key: "corpus_digest", match: { value: OLD_CORPUS_DIGEST } });
});

test("Qdrant and DashScope responses are bounded", async (context) => {
  let oversizedQdrant = true;
  const server = createServer(async (request, response) => {
    await readJsonBody(request);
    response.setHeader("content-type", "application/json");
    if (oversizedQdrant) {
      response.end(JSON.stringify({ padding: "x".repeat(4_096) }));
      return;
    }
    if (request.url?.endsWith("/embeddings")) {
      response.end(JSON.stringify({ padding: "x".repeat(4_096) }));
      return;
    }
    response.end(JSON.stringify({ result: {} }));
  });
  const baseUrl = await listen(server);
  context.after(() => closeServer(server));
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-qdrant-bounds-"));
  await writeFile(path.join(root, "knowledge.md"), "bounded", "utf8");
  const indexer = new QdrantKnowledgeIndexer(baseUrl, undefined, "dashscope-key", {
    embeddingBaseUrl: baseUrl,
    requestTimeoutMs: 1_000,
    maxResponseBytes: 1_024,
  });

  await assert.rejects(
    indexer.stageAgentDocuments("maya", "signal", CORPUS_DIGEST, root, []),
    (error) => error instanceof KnowledgeIndexUnavailable && /oversized/.test(error.message),
  );
  oversizedQdrant = false;
  await assert.rejects(
    indexer.stageAgentDocuments("maya", "signal", CORPUS_DIGEST, root, [document()]),
    (error) => error instanceof KnowledgeIndexUnavailable && /oversized/.test(error.message),
  );
});

test("Qdrant and DashScope fetches cannot outlive their request timeout", async (context) => {
  let stall: "qdrant" | "dashscope" = "qdrant";
  const server = createServer(async (request, response) => {
    await readJsonBody(request);
    if (stall === "qdrant" || request.url?.endsWith("/embeddings")) return;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ result: {} }));
  });
  const baseUrl = await listen(server);
  context.after(() => closeServer(server));
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-qdrant-timeout-"));
  await writeFile(path.join(root, "knowledge.md"), "timeout", "utf8");
  const indexer = new QdrantKnowledgeIndexer(baseUrl, undefined, "dashscope-key", {
    embeddingBaseUrl: baseUrl,
    requestTimeoutMs: 100,
  });

  await assert.rejects(
    indexer.stageAgentDocuments("maya", "signal", CORPUS_DIGEST, root, []),
    (error) => error instanceof KnowledgeIndexUnavailable && /timed out after 100ms/.test(error.message),
  );
  stall = "dashscope";
  await assert.rejects(
    indexer.stageAgentDocuments("maya", "signal", CORPUS_DIGEST, root, [document()]),
    (error) => error instanceof KnowledgeIndexUnavailable && /timed out after 100ms/.test(error.message),
  );
});

function document(): KnowledgeDocument {
  return {
    id: "knowledge",
    path: "knowledge.md",
    sha256: `sha256:${"c".repeat(64)}`,
    retrieval_only: true,
    source_summary: "Knowledge",
  };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) body += chunk.toString();
  return body ? JSON.parse(body) as Record<string, unknown> : {};
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
