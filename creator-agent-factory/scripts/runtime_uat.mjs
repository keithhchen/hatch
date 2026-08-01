#!/usr/bin/env node
/** Run a compiled Creator Release through the real Runtime using a replayable model adapter.
 *
 * The adapter supplies externally generated candidate responses; it does not
 * evaluate semantics.  This script proves Release resolution, private Skill
 * execution, entitlement binding, event flow, and final delivery without
 * baking any Creator or domain behavior into Factory code.
 */
import http from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";


function argsFrom(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument near ${key ?? "end"}`);
    result[key.slice(2)] = value;
  }
  return result;
}


function sse(res, chunks) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}


function finalResponse(res, content) {
  sse(res, [
    { choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
  ]);
}


function skillCall(res, skillId, task) {
  sse(res, [
    {
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: `call_${Math.random().toString(16).slice(2)}`,
            type: "function",
            function: { name: "skill_run", arguments: JSON.stringify({ skill_id: skillId, task, context_refs: [] }) }
          }]
        },
        finish_reason: null
      }]
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
  ]);
}


async function body(req) {
  let value = "";
  for await (const chunk of req) value += String(chunk);
  return value;
}


function holdoutId(messages) {
  const joined = messages.map((message) => String(message.content ?? "")).join("\n");
  return joined.match(/HOLDOUT_ID:\s*([A-Za-z0-9_-]+)/)?.[1];
}


async function main() {
  const args = argsFrom(process.argv.slice(2));
  for (const required of ["runtime-dist", "releases-root", "release-id", "digest", "inputs", "candidate-outputs", "output"]) {
    if (!args[required]) throw new Error(`missing --${required}`);
  }
  const runtimeDist = path.resolve(args["runtime-dist"]);
  const releasesRoot = path.resolve(args["releases-root"]);
  const inputs = JSON.parse(await readFile(path.resolve(args.inputs), "utf8"));
  const candidatePayload = JSON.parse(await readFile(path.resolve(args["candidate-outputs"]), "utf8"));
  const candidateById = new Map(candidatePayload.outputs.map((item) => [item.id, item.response]));
  if (inputs.some((item) => !candidateById.has(item.id))) throw new Error("candidate output is missing a holdout id");

  const [{ createRuntimeServer }, { CreatorReleaseResolver }, { FileEntitlementResolver }, { runLocalHarness }] = await Promise.all([
    import(path.join(runtimeDist, "index.js")),
    import(path.join(runtimeDist, "release.js")),
    import(path.join(runtimeDist, "entitlements.js")),
    import(path.join(runtimeDist, "localHarness.js"))
  ]);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-uat-"));
  const observations = { requests: 0, main_requests: 0, worker_requests: 0, worker_received_private_skill: false };
  let activeId = inputs[0]?.id;
  const modelServer = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404); res.end("not found"); return;
      }
      const request = JSON.parse(await body(req));
      observations.requests += 1;
      const messages = Array.isArray(request.messages) ? request.messages : [];
      const tools = (Array.isArray(request.tools) ? request.tools : []).map((tool) => tool.function?.name);
      const id = holdoutId(messages) ?? activeId;
      const response = candidateById.get(id);
      if (!id || !response) {
        throw new Error(`model adapter could not bind request to holdout output (id=${id ?? "none"}, active=${activeId ?? "none"})`);
      }
      activeId = id;
      const hasSkillRun = tools.includes("skill_run");
      if (!hasSkillRun) {
        observations.worker_requests += 1;
        const serialized = JSON.stringify(messages);
        observations.worker_received_private_skill ||= (
          serialized.includes("<creator_skills>")
          && serialized.includes("Fulfill this promise:")
        );
        finalResponse(res, response);
        return;
      }
      observations.main_requests += 1;
      if (messages.some((message) => message.role === "tool")) {
        finalResponse(res, response);
      } else {
        const task = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
        skillCall(res, args["product-id"] ?? args["release-id"].split("@")[0], String(task));
      }
    })().catch((error) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    });
  });

  try {
    await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
    const modelPort = modelServer.address().port;
    const entitlementPath = path.join(scratch, "entitlements.json");
    const entitlementId = "ent_runtime_uat";
    const licenseToken = "license_runtime_uat";
    await writeFile(entitlementPath, JSON.stringify([{
      license_token: licenseToken,
      entitlement_id: entitlementId,
      order_id: "order_runtime_uat",
      tenant_id: "tenant_runtime_uat",
      user_id: "user_runtime_uat",
      creator_id: args["creator-id"] ?? "creator_runtime_uat",
      product_id: args["product-id"] ?? args["release-id"].split("@")[0],
      release_id: args["release-id"],
      release_digest: args.digest,
      status: "active"
    }], null, 2));
    process.env.OPENAI_API_KEY = "runtime-uat-key";
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${modelPort}/v1`;
    process.env.HATCH_CREATOR_MODEL = "runtime-uat-model";
    process.env.HATCH_RUNTIME_DATA_DIR = path.join(scratch, "runtime-data");

    const runtime = createRuntimeServer({
      releaseResolver: new CreatorReleaseResolver(releasesRoot),
      entitlementResolver: new FileEntitlementResolver(entitlementPath)
    });
    await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
    const runtimePort = runtime.server.address().port;
    const results = [];
    try {
      for (const item of inputs) {
        activeId = item.id;
        const workspace = path.join(scratch, "workspace", item.id);
        await mkdir(workspace, { recursive: true });
        const run = await runLocalHarness({
          serverUrl: `ws://127.0.0.1:${runtimePort}/runtime`,
          workspace,
          conversationId: `uat_${item.id}`,
          prompt: `HOLDOUT_ID: ${item.id}\n\n${item.input}`,
          licenseToken,
          entitlementId,
          installationId: "runtime-uat-installation",
          localTools: [],
          allowShell: false,
          runIdFactory: () => `run_${item.id}`
        });
        const eventTypes = run.events.map((event) => event.type);
        results.push({
          id: item.id,
          input: item.input,
          output: run.finalText,
          matches_candidate_output: run.finalText === candidateById.get(item.id),
          skill_event_observed: eventTypes.some((type) => type.startsWith("skill.")),
          terminal_completed: run.events.some((event) => event.type === "turn.state" && event.status === "completed"),
          event_types: [...new Set(eventTypes)]
        });
      }
    } finally {
      await runtime.close();
    }
    const payload = {
      release_id: args["release-id"],
      release_digest: args.digest,
      execution_surface: "real Hatch Runtime with deterministic ChatCompletions replay adapter",
      semantic_source: "externally generated candidate outputs; adapter performs no semantic evaluation",
      observations,
      runs: results,
      passed: observations.worker_received_private_skill && results.every((item) => item.matches_candidate_output && item.skill_event_observed && item.terminal_completed)
    };
    const output = path.resolve(args.output);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(payload, null, 2) + "\n");
    console.log(JSON.stringify({ passed: payload.passed, runs: results.length, observations }));
    if (!payload.passed) process.exitCode = 2;
  } finally {
    await new Promise((resolve) => modelServer.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  }
}


main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 2;
});
