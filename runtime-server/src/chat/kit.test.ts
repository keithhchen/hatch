// Test fixtures only. Nothing here is imported by product code.
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AgentCorpus, AgentCorpusResolver } from "../agentCorpus.js";
import type { AgentRuntime } from "../agentRuntime.js";
import { AttachmentFiles } from "../assets/files.js";
import { harness } from "../assets/kit.test.js";
import { InMemoryConversationRepository } from "../conversationRepository.js";
import { createRuntimeServer, type RuntimeServer } from "../index.js";
import type { ConversationMessage } from "../protocol.js";
import { RuntimeStore, localRuntimeAuthority } from "../store.js";
import type { Connection } from "../surfaces/contract.js";
import { ChatAssets } from "./assets.js";
import { SentMessageLimits } from "./contactBinding.js";
import type { ChatGateway } from "./gateway.js";

export const productId = "33333333-3333-4333-8333-333333333333";
export const creatorId = "22222222-2222-4222-8222-222222222222";
export const alice = { kind: "contact" as const, connectionId: "conn-1", contactId: "alice" };
export const bob = { ...alice, contactId: "bob" };
export const thread = { kind: "thread" as const, connectionId: "conn-1", threadId: "t1" };
export const dm = { client: "dm" as const };
export const text = (value: string) => [{ type: "text" as const, text: value }];
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The Run's final reply, once it has ended: what the channel layer learns by asking. */
export async function ended(chat: ChatGateway, runId: string) {
  for (let waited = 0; waited < 500; waited += 1) {
    const progress = await chat.progress(runId);
    if (progress?.ended) return progress.reply;
    await sleep(20);
  }
  throw new Error(`Run ${runId} did not end`);
}

export type Fixture = Awaited<ReturnType<typeof gatewayFixture>>;

export async function gatewayFixture(options: { noServiceToken?: boolean; localTools?: boolean; maxMessages?: number; assets?: boolean; moderator?: Parameters<typeof harness>[0]; runtime?: AgentRuntime } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-chat-gateway-"));
  const repository = new InMemoryConversationRepository(localRuntimeAuthority(dataDir));
  const store = new RuntimeStore(dataDir);
  const corpus = {
    root: "", digest: `sha256:${"b".repeat(64)}`,
    corpus: {
      agent_id: productId, creator: { id: creatorId, name: "Creator" },
      product: { id: productId, name: "Product", boundaries: [], presentation: {} },
      knowledge: { documents: [] },
      tools: options.localTools ? [{ id: "local", kind: "local_harness" }] : [{ id: "web", kind: "http_function" }]
    } as unknown as AgentCorpus
  };
  const connections = new Map<string, Connection>([["conn-1", {
    id: "conn-1", ownerAccountId: creatorId, channel: "instagram", client: "dm",
    target: { kind: "product", productId }, audience: "public", state: "active"
  }]]);
  const kit = await harness(options.moderator);
  const chatAssets = options.assets ? new ChatAssets({ pipeline: kit.pipeline, blobs: kit.blobs, files: new AttachmentFiles(kit.repository, kit.blobs) }) : undefined;
  const seen: ConversationMessage[][] = [];
  const runtime: RuntimeServer = createRuntimeServer({
    conversationStore: store,
    conversationRepository: repository,
    agentCorpusResolver: { resolve: async () => corpus, resolveByProduct: async () => corpus, list: async () => [] } as unknown as AgentCorpusResolver,
    connectionDirectory: { get: async (id) => connections.get(id) },
    ...(chatAssets ? { chatAssets } : {}),
    ...(options.noServiceToken ? {} : { chatServiceToken: "service-secret" }),
    ...(options.maxMessages ? { principalLimits: new SentMessageLimits(repository, options.maxMessages) } : {}),
    createRuntime: () => options.runtime ?? ({ async *run(input, ctx) {
      seen.push(ctx.messages);
      yield { type: "assistant.delta" as const, run_id: input.run_id, delta: { kind: "text" as const, content: `echo: ${input.message.content}` } };
      yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
    } })
  });
  await new Promise<void>((resolve) => (runtime.server as http.Server).listen(0, "127.0.0.1", () => resolve()));
  return { runtime, repository, kit, seen, port: ((runtime.server as http.Server).address() as { port: number }).port };
}

export async function withFixture(options: Parameters<typeof gatewayFixture>[0], body: (fixture: Fixture) => Promise<void>) {
  const fixture = await gatewayFixture(options);
  try { await body(fixture); } finally { await fixture.runtime.close(); }
}

