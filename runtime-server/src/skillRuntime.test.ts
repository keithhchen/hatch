import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentRuntime, RunContext } from "./agentRuntime.js";
import { ClientToolBroker } from "./clientBroker.js";
import type { OutboundMessage, RunStart } from "./protocol.js";
import { RunStateMachine } from "./runState.js";
import { ServerToolExecutor } from "./serverTools.js";
import { SkillRuntime } from "./skillRuntime.js";
import type { SkillRecord } from "./skills.js";
import { RuntimeStore } from "./store.js";
import { ToolBridge } from "./toolBridge.js";

const parentInput: RunStart = {
  type: "client.message",
  run_id: "parent-run",
  conversation_id: "skill-runtime-contract",
  message: { role: "user", content: "Run the protected workflow." }
};

function skillRecord(directory: string, name = "protected-contract"): SkillRecord {
  return {
    id: name,
    name,
    description: "A protected test workflow.",
    path: path.join(directory, "SKILL.md"),
    directory,
    root: directory,
    scope: "custom",
    manifest: {
      name,
      description: "A protected test workflow.",
      metadata: {}
    },
    openai: {
      policy: { allowImplicitInvocation: false, products: [] },
      dependencies: { tools: [] }
    },
    enabled: true,
    diagnostics: []
  };
}

function sessionSkills(skill: SkillRecord) {
  return {
    records: [skill],
    visibleRecords: [],
    rendered: {
      section: "",
      aliases: {},
      report: {
        total_count: 0,
        included_count: 0,
        omitted_count: 0,
        truncated_description_chars: 0,
        truncated_description_count: 0
      }
    }
  };
}

async function createHarness(
  root: string,
  skill: SkillRecord,
  createWorkerRuntime: () => AgentRuntime,
  timeoutMs = 1_000
) {
  const store = new RuntimeStore(path.join(root, "runtime-data"));
  const state = new RunStateMachine(parentInput.run_id, parentInput.conversation_id, store);
  await state.start();
  const outbound: OutboundMessage[] = [];
  const broker = new ClientToolBroker(async (event) => {
    outbound.push(event);
  }, store, timeoutMs);
  const serverTools = new ServerToolExecutor(timeoutMs);
  const bridge = new ToolBridge(broker, serverTools);
  const runtime = new SkillRuntime({
    parentInput,
    parentState: state,
    sessionSkills: sessionSkills(skill),
    clientBroker: broker,
    serverTools,
    toolBridge: bridge,
    clientTools: ["file_read"],
    store,
    emit: async (event) => {
      outbound.push(event);
    },
    createWorkerRuntime
  });
  return { store, state, broker, outbound, runtime };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function workerDone(output = "worker complete"): AgentRuntime {
  return {
    async *run(input): AsyncIterable<OutboundMessage> {
      yield {
        type: "assistant.delta",
        run_id: input.run_id,
        delta: { kind: "text", content: output }
      };
      yield {
        type: "turn.completed",
        run_id: input.run_id,
        finish_reason: "stop"
      };
    }
  };
}

test("SkillRuntime converts a missing SKILL.md into a failed run and clears it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-skill-bad-"));
  try {
    const skill = skillRecord(path.join(root, "missing-skill"));
    await mkdir(skill.directory, { recursive: true });
    const harness = await createHarness(root, skill, () => workerDone());

    const result = await harness.runtime.execute({
      skill_id: skill.id,
      product: "Run the invalid protected workflow."
    });

    assert.equal(result.status, "failed");
    assert.equal((result.error as { code: string }).code, "skill_failed");
    const events = await harness.store.readEvents();
    assert.deepEqual(
      events.filter((event) => event.type === "skill.run").map((event) => event.status),
      ["requested", "failed"]
    );
    assert.ok(events.some((event) => event.type === "skill.session" && event.status === "failed"));
    assert.equal((harness.runtime as unknown as { active: Map<unknown, unknown> }).active.size, 0);
    await harness.runtime.cancelParentRun(parentInput.run_id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SkillRuntime cancellation is terminal and ignores a late protected-tool result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-skill-cancel-"));
  try {
    const skill = skillRecord(path.join(root, "cancel-skill"), "cancel-skill");
    await mkdir(skill.directory, { recursive: true });
    await writeFile(path.join(skill.directory, "SKILL.md"), [
      "---",
      "name: cancel-skill",
      "description: A protected cancellation workflow.",
      "---",
      "",
      "Wait for local context before completing."
    ].join("\n"), "utf8");

    let pendingTool: Promise<Record<string, unknown>> | undefined;
    const harness = await createHarness(root, skill, () => ({
      async *run(input, ctx): AsyncIterable<OutboundMessage> {
        pendingTool = ctx.toolBridge!.execute({
          scope: "skill_run",
          runId: input.run_id,
          skillRunId: ctx.skillRunId,
          toolCallId: "worker-pending-read",
          name: "file_read",
          arguments: { path: "notes.txt" },
          clientTools: ctx.clientTools,
          state: ctx.state
        });
        yield {
          type: "tool_call.delta",
          run_id: input.run_id,
          tool_call_id: "worker-pending-read",
          name: "file_read",
          locality: "client",
          approval: "auto",
          status: "requested",
          arguments: { path: "notes.txt" },
          scope: "skill_run",
          skill_run_id: ctx.skillRunId
        };
        await pendingTool;
        yield {
          type: "tool_call.delta",
          run_id: input.run_id,
          tool_call_id: "worker-pending-read",
          name: "file_read",
          locality: "client",
          approval: "auto",
          status: "completed",
          result: { content: "late" },
          scope: "skill_run",
          skill_run_id: ctx.skillRunId
        };
        yield {
          type: "turn.completed",
          run_id: input.run_id,
          finish_reason: "stop"
        };
      }
    }));

    const runPromise = harness.runtime.execute({
      skill_id: skill.id,
      product: "Read notes.txt and wait."
    });
    await waitUntil(() => harness.outbound.some((event) => event.type === "tool_call.request"));
    await harness.state.cancel("user stopped protected workflow");
    await harness.runtime.cancelParentRun(parentInput.run_id);
    assert.equal(await harness.broker.cancelRun(parentInput.run_id, "user stopped protected workflow"), 1);
    const result = await runPromise;

    assert.equal(result.status, "cancelled");
    assert.equal((result.error as { code: string }).code, "skill_cancelled");
    assert.equal(await harness.broker.handleResult({
      type: "tool_call.result",
      run_id: parentInput.run_id,
      tool_call_id: "worker-pending-read",
      status: "ok",
      result: { content: "late" }
    }), false);
    const events = await harness.store.readEvents();
    assert.ok(events.some((event) => event.type === "skill.run" && event.status === "cancelled"));
    assert.ok(!events.some((event) => event.type === "skill.run" && (event.status === "completed" || event.status === "failed")));
    assert.ok(events.some((event) => event.type === "tool.call" && event.scope === "skill_run" && event.status === "cancelled"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SkillRuntime contains MCP timeout as a failed terminal without reviving the worker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-skill-timeout-"));
  const server = createServer((_request, _response) => {
    // Keep the response open so the executor must enforce its own deadline.
  });
  const previousServers = process.env.HATCH_MCP_SERVERS;
  try {
    const port = await listen(server);
    process.env.HATCH_MCP_SERVERS = JSON.stringify({ slow: { url: `http://127.0.0.1:${port}/mcp` } });
    const skill = skillRecord(path.join(root, "timeout-skill"), "timeout-skill");
    await mkdir(skill.directory, { recursive: true });
    await writeFile(path.join(skill.directory, "SKILL.md"), [
      "---",
      "name: timeout-skill",
      "description: A protected timeout workflow.",
      "---",
      "",
      "Call the configured upstream and report failures."
    ].join("\n"), "utf8");
    const harness = await createHarness(root, skill, () => ({
      async *run(input, ctx): AsyncIterable<OutboundMessage> {
        yield {
          type: "tool_call.delta",
          run_id: input.run_id,
          tool_call_id: "worker-slow-mcp",
          name: "mcp.call",
          locality: "server",
          approval: "none",
          status: "requested",
          arguments: { server: "slow", tool: "wait" },
          scope: "skill_run",
          skill_run_id: ctx.skillRunId
        };
        try {
          await ctx.toolBridge!.execute({
            scope: "skill_run",
            runId: input.run_id,
            skillRunId: ctx.skillRunId,
            toolCallId: "worker-slow-mcp",
            name: "mcp.call",
            arguments: { server: "slow", tool: "wait" },
            clientTools: ctx.clientTools,
            state: ctx.state
          });
        } catch (error) {
          yield {
            type: "tool_call.delta",
            run_id: input.run_id,
            tool_call_id: "worker-slow-mcp",
            name: "mcp.call",
            locality: "server",
            approval: "none",
            status: "failed",
            error: { code: "mcp_timeout", message: error instanceof Error ? error.message : String(error) },
            scope: "skill_run",
            skill_run_id: ctx.skillRunId
          };
          throw error;
        }
      }
    }), 25);

    const started = Date.now();
    const result = await harness.runtime.execute({
      skill_id: skill.id,
      product: "Call the slow upstream."
    });
    assert.ok(Date.now() - started < 500, "MCP timeout should be bounded");
    assert.equal(result.status, "failed");
    assert.match(String((result.error as { message: string }).message), /timed out/);
    const events = await harness.store.readEvents();
    assert.deepEqual(
      events.filter((event) => event.type === "skill.run").map((event) => event.status),
      ["requested", "running", "failed"]
    );
    assert.ok(!events.some((event) => event.type === "skill.run" && event.status === "completed"));
  } finally {
    if (previousServers === undefined) delete process.env.HATCH_MCP_SERVERS;
    else process.env.HATCH_MCP_SERVERS = previousServers;
    server.closeAllConnections();
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
