import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { DeterministicAgentRuntime } from "./agentRuntime.js";
import { buildCompactedHistory, RUNTIME_CONTEXT_PREFIX, runtimeMessagesTranscript, SUMMARY_PREFIX } from "./compaction.js";
import { clientToolTimeoutMs, createRuntimeServer, scopedConversationId, type RuntimeServer } from "./index.js";
import { executeLocalTool, LocalHarnessSession, runLocalHarness } from "./localHarness.js";
import type { OutboundMessage, ToolRequest } from "./protocol.js";
import { ClientToolNameSchema, parseInboundMessage, PROTOCOL_VERSION } from "./protocol.js";
import {
  discoverSkills,
  explicitDollarSkillMentions,
  explicitLinkedSkillMentions,
  explicitSkillReferences,
  explicitSkillMentions,
  includeSkillInstructions,
  listSkills,
  listSkillBundleResourcePaths,
  loadSkillByPath,
  readSkillResourceByPath,
  renderSkillsSection,
  skillMetadataCharBudget,
  skillResourceRoots,
  skillsRoot,
  visibleSkillsForPrompt
} from "./skills.js";
import { parseAllowedTools, toolPreapprovedBySkills } from "./skillPermissions.js";
import { RuntimeStore, type StoreEvent } from "./store.js";
import { modelToolSpecsForRun, requireClientToolEnabled, requireModelToolDispatch, requireTool } from "./tools.js";

let runtimeServer: RuntimeServer | undefined;
let tempDirs: string[] = [];
const initialCodexHome = process.env.CODEX_HOME;
const execFileAsync = promisify(execFile);

function createDeterministicRuntimeServer(): RuntimeServer {
  return createRuntimeServer({
    createRuntime: () => new DeterministicAgentRuntime()
  });
}

test("runtime protocol mirrors the canonical wire schema", async () => {
  const schemaPath = path.resolve("..", "packages", "protocol", "schemas", "hatch-wire-protocol.schema.json");
  const schema = JSON.parse(await readFile(schemaPath, "utf8")) as {
    $defs: {
      protocolVersion: { const: string };
      clientToolName: { enum: string[] };
    };
  };

  assert.equal(schema.$defs.protocolVersion.const, PROTOCOL_VERSION);
  assert.deepEqual(schema.$defs.clientToolName.enum, [...ClientToolNameSchema.options]);
});

test("Desktop write approval window is long enough for a deliberate user decision", () => {
  assert.equal(clientToolTimeoutMs(undefined), 300_000);
  assert.equal(clientToolTimeoutMs("900000"), 900_000);
  assert.throws(() => clientToolTimeoutMs("29999"), /HATCH_CLIENT_TOOL_TIMEOUT_MS/);
  assert.throws(() => clientToolTimeoutMs("forever"), /HATCH_CLIENT_TOOL_TIMEOUT_MS/);
});

test("runtime server exposes visible conversation history for client hydration", async () => {
  const dataDir = await tempWorkspace();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  const store = new RuntimeStore(dataDir);
  const historyBinding = {
    tenantId: "tenant-history",
    userId: "user-history",
    productId: "product-history",
    releaseId: "release-history",
    releaseDigest: `sha256:${"1".repeat(64)}`
  };
  const storedConversationId = scopedConversationId(historyBinding, "desktop-chat");
  await store.append({
    type: "message.created",
    conversation_id: storedConversationId,
    run_id: "run_old_1",
    role: "user",
    content: "Read the birthday dinner sheet."
  });
  await store.append({
    type: "conversation.model_message",
    conversation_id: storedConversationId,
    run_id: "run_old_1",
    message: {
      role: "tool",
      tool_call_id: "call_hidden",
      content: "tool-only model context"
    }
  });
  await store.append({
    type: "tool.call",
    conversation_id: storedConversationId,
    run_id: "run_old_1",
    tool_call_id: "call_file_read",
    name: "fs.read",
    arguments: { path: "2024 Birthday Dinner.xlsx" },
    status: "requested",
    locality: "client",
    approval: "auto"
  });
  await store.append({
    type: "tool.call",
    conversation_id: storedConversationId,
    run_id: "run_old_1",
    tool_call_id: "call_file_read",
    name: "fs.read",
    arguments: { path: "2024 Birthday Dinner.xlsx" },
    status: "completed",
    locality: "client",
    approval: "auto",
    result: { content: "birthday dinner rows" }
  });
  await store.append({
    type: "skill.activated",
    conversation_id: storedConversationId,
    run_id: "run_old_1",
    name: "contract-review",
    path: "/server/skills/contract-review/SKILL.md",
    scope: "server",
    directory: "/server/skills/contract-review",
    content: "# Contract Review",
    resource_paths: ["references/playbook.md"],
    resource_manifest_truncated: false
  });
  await store.append({
    type: "skill.invoked",
    conversation_id: storedConversationId,
    run_id: "run_old_1",
    name: "contract-review",
    path: "/server/skills/contract-review/SKILL.md",
    scope: "server",
    invocation_type: "implicit",
    reason: "skill_doc_read",
    source_tool_call_id: "call_file_read",
    trigger: {
      tool: "file_read",
      path: "/server/skills/contract-review/SKILL.md"
    }
  });
  await store.append({
    type: "message.created",
    conversation_id: storedConversationId,
    run_id: "run_old_1",
    role: "assistant",
    content: "I still need to read the spreadsheet."
  });

  runtimeServer = createDeterministicRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  const historyUrl = new URL(serverUrl);
  historyUrl.protocol = "http:";
  historyUrl.pathname = "/conversations/desktop-chat/messages";
  historyUrl.search = new URLSearchParams({
    tenant_id: historyBinding.tenantId,
    user_id: historyBinding.userId,
    product_id: historyBinding.productId,
    release_id: historyBinding.releaseId,
    release_digest: historyBinding.releaseDigest
  }).toString();
  const response = await fetch(historyUrl);
  assert.equal(response.status, 200);
  const payload = await response.json() as {
    conversation_id: string;
    messages: Array<{
      role: string;
      content: string;
      run_id: string;
      tool_calls?: Array<{
        tool_call_id: string;
        name: string;
        status: string;
        locality?: string;
        approval?: string;
        result?: Record<string, unknown>;
      }>;
      skill_events?: Array<{
        name: string;
        path: string;
        status: string;
        invocation_type: string;
        reason: string;
        source_tool_call_id?: string;
        trigger?: { tool: string; path?: string; command?: string };
      }>;
    }>;
  };
  assert.equal(payload.conversation_id, "desktop-chat");
  assert.deepEqual(payload.messages.map((message) => [message.role, message.content]), [
    ["user", "Read the birthday dinner sheet."],
    ["assistant", "I still need to read the spreadsheet."]
  ]);
  assert.equal(payload.messages[0]?.tool_calls, undefined);
  assert.equal(payload.messages[0]?.skill_events, undefined);
  assert.deepEqual(payload.messages[1]?.tool_calls?.map((toolCall) => [
    toolCall.tool_call_id,
    toolCall.name,
    toolCall.status,
    toolCall.locality,
    toolCall.approval,
    toolCall.result?.content
  ]), [[
    "call_file_read",
    "fs.read",
    "completed",
    "client",
    "auto",
    "birthday dinner rows"
  ]]);
  assert.deepEqual(payload.messages[1]?.skill_events?.map((skillEvent) => [
    skillEvent.name,
    skillEvent.status,
    skillEvent.invocation_type,
    skillEvent.reason,
    skillEvent.source_tool_call_id,
    skillEvent.trigger?.tool
  ]), [
    ["contract-review", "activated", "explicit", "explicit_mention", undefined, undefined],
    ["contract-review", "invoked", "implicit", "skill_doc_read", "call_file_read", "file_read"]
  ]);
});

beforeEach(() => {
  process.env.HATCH_TS_SKILLS_ROOT = path.resolve("skills");
  process.env.CODEX_HOME = path.join(os.tmpdir(), "hatch-runtime-empty-codex-home");
});

afterEach(async () => {
  if (runtimeServer) {
    await runtimeServer.close();
    runtimeServer = undefined;
  }

  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  delete process.env.HATCH_RUNTIME_DATA_DIR;
  delete process.env.HATCH_TS_SKILLS_ROOT;
  delete process.env.HATCH_SKILL_ROOTS;
  delete process.env.HATCH_SKILL_METADATA_BUDGET_CHARS;
  delete process.env.HATCH_SKILL_PRODUCT;
  delete process.env.HATCH_MODEL_CONTEXT_WINDOW_CHARS;
  delete process.env.HATCH_MODEL_CONTEXT_WINDOW_TOKENS;
  delete process.env.HATCH_AUTO_COMPACT_LIMIT_TOKENS;
  delete process.env.HATCH_SKILLS_CONFIG;
  if (initialCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = initialCodexHome;
  }
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  delete process.env.HATCH_CREATOR_MODEL;
  delete process.env.HATCH_COMPACTION_MODEL;
  delete process.env.HATCH_MCP_SERVERS;
  delete process.env.HATCH_LOCAL_RUNNER_BIN;
});

test("runs a full server-agent session with local client tool execution", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  await writeFile(
    path.join(workspace, "README.md"),
    [
      "# Hatch",
      "",
      "Hatch routes all LLM calls through the server.",
      "Filesystem tools execute locally through the client harness.",
      ""
    ].join("\n"),
    "utf8"
  );

  runtimeServer = createDeterministicRuntimeServer();
  const serverUrl = await listen(runtimeServer);

  const result = await runLocalHarness({
    serverUrl,
    workspace,
    prompt: "Find Hatch. Save the summary to \"agent-output.md\"."
  });

  assert.match(result.finalText, /Your work is ready/);
  assert.deepEqual(result.events.filter((event) => event.type === "tool_call.request").map((event) => event.name), [
    "fs.search",
    "fs.read",
    "fs.write"
  ]);
  assert.deepEqual(result.events.filter((event) => event.type === "tool_call.delta").map((event) => `${event.name}:${event.status}`), [
    "web.search:requested",
    "web.search:completed",
    "fs.search:requested",
    "fs.search:completed",
    "fs.read:requested",
    "fs.read:completed",
    "fs.write:requested",
    "fs.write:completed"
  ]);
  assert.ok(result.events.some((event) => event.type === "tool_call.delta" && event.name === "fs.write" && event.approval === "auto"));
  const completedWrite = result.events.find((event) => (
    event.type === "tool_call.delta"
    && event.name === "fs.write"
    && event.status === "completed"
  ));
  assert.ok(completedWrite && completedWrite.type === "tool_call.delta");
  assert.equal(completedWrite.result?.diff, undefined);
  const writeDiffIndex = result.events.findIndex((event) => event.type === "workspace.diff" && event.source_tool_call_id === completedWrite.tool_call_id);
  const writeCompletedIndex = result.events.indexOf(completedWrite);
  assert.ok(writeDiffIndex > writeCompletedIndex);
  const writeDiff = result.events[writeDiffIndex];
  assert.equal(writeDiff.type, "workspace.diff");
  assert.equal(writeDiff.path, "agent-output.md");
  assert.match(writeDiff.diff, /--- \/dev\/null/);
  assert.match(writeDiff.diff, /\+First local file: README\.md/);
  assert.deepEqual(result.events.filter((event) => event.type === "approval.request" || event.type === "approval.result"), []);
  assert.ok(result.events.some((event) => event.type === "assistant.delta" && event.delta.kind === "text"));
  assert.deepEqual(result.events.filter((event) => event.type === "turn.state").map((event) => event.status), [
    "queued",
    "running",
    "waiting_for_tool",
    "running",
    "waiting_for_tool",
    "running",
    "waiting_for_tool",
    "running",
    "completed"
  ]);
  const finalIndex = result.events.findIndex((event) => event.type === "turn.completed");
  const completedIndex = result.events.findIndex((event) => event.type === "turn.state" && event.status === "completed");
  assert.ok(finalIndex >= 0);
  assert.ok(completedIndex > finalIndex);

  const written = await readFile(path.join(workspace, "agent-output.md"), "utf8");
  assert.match(written, /First local file: README\.md/);
  assert.match(written, /Hatch routes all LLM calls through the server/);

  const events = await new RuntimeStore(dataDir).readEvents();
  assert.ok(events.some((event) => event.type === "session.started" && event.local_tools?.includes("fs.search")));
  assert.ok(events.some((event) => event.type === "message.created" && event.role === "user"));
  assert.ok(events.some((event) => event.type === "message.created" && event.role === "assistant"));
  assert.ok(events.some((event) => event.type === "tool.call" && event.status === "requested"));
  assert.ok(events.some((event) => event.type === "tool.call" && event.status === "completed"));
  assert.ok(events.some((event) => event.type === "tool.call" && event.name === "web.search" && event.status === "requested"));
  assert.ok(events.some((event) => event.type === "tool.call" && event.name === "web.search" && event.status === "completed"));
  assert.ok(events.every((event) => event.type !== "tool.call" || event.conversation_id === "local-dev-conversation"));
  assert.ok(events.every((event) => event.type !== "runtime.event" || !event.run_id || event.conversation_id === "local-dev-conversation"));
  const runId = "run_id" in result.events[0] ? result.events[0].run_id : undefined;
  assert.ok(runId);
  const persistedRunEvents = events
    .filter((event): event is Extract<StoreEvent, { type: "runtime.event" }> => event.type === "runtime.event" && event.run_id === runId)
    .map((event) => event.event);
  assert.deepEqual(persistedRunEvents, result.events);
  assert.ok(events.some((event) => (
    event.type === "runtime.event"
    && typeof event.event === "object"
    && event.event !== null
    && (event.event as Record<string, unknown>).type === "tool_call.request"
    && (event.event as Record<string, unknown>).name === "fs.write"
  )));
  assert.ok(!events.some((event) => (
    event.type === "runtime.event"
    && typeof event.event === "object"
    && event.event !== null
    && String((event.event as Record<string, unknown>).type).startsWith("approval.")
  )));
  assert.ok(events.some((event) => event.type === "turn.state" && event.to === "queued" && event.from === undefined));
  assert.ok(events.some((event) => event.type === "turn.state" && event.to === "completed"));
  const completedSearch = events.find((event) => event.type === "tool.call" && event.name === "fs.search" && event.status === "completed");
  assert.ok(completedSearch && completedSearch.type === "tool.call");
  assert.equal(completedSearch.arguments.query, "Hatch");
  assert.equal(completedSearch.arguments.path, ".");
});

test("deterministic runtime renders visible skills without auto-loading one", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const skillDir = path.join(workspace, ".agents", "skills", "auto-skill");
  await mkdir(skillDir, { recursive: true });
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "Hatch deterministic runtime.\n", "utf8");
  await writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: auto-skill",
    "description: Auto skill. Use when testing that Hatch does not server-select skills.",
    "---",
    "",
    "# Auto Skill",
    "",
    "This full SKILL.md body must not be loaded unless the model reads it."
  ].join("\n"), "utf8");

  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  delete process.env.HATCH_TS_SKILLS_ROOT;
  runtimeServer = createDeterministicRuntimeServer();
  const serverUrl = await listen(runtimeServer);

  const result = await runLocalHarness({
    serverUrl,
    workspace,
    prompt: "Find Hatch."
  });

  assert.match(result.finalText, /(?:Your work is ready|I finished reviewing)/);
  assert.doesNotMatch(result.finalText, /using auto-skill/);
  assert.ok(result.events.some((event) => (
    event.type === "assistant.delta"
    && event.delta.kind === "status"
    && event.delta.content === "Using the guidance included with this Agent."
  )));
  assert.ok(!result.events.some((event) => (
    event.type === "assistant.delta"
    && event.delta.kind === "status"
    && /Loaded skill auto-skill/.test(event.delta.content)
  )));
});

test("local harness can broker local tools through the Rust sidecar", async () => {
  const rustRunnerBin = await buildRustLocalRunnerBin();
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  await writeFile(
    path.join(workspace, "README.md"),
    [
      "# Hatch",
      "",
      "Hatch routes local filesystem tools through the Rust runner.",
      ""
    ].join("\n"),
    "utf8"
  );

  runtimeServer = createDeterministicRuntimeServer();
  const serverUrl = await listen(runtimeServer);

  const result = await runLocalHarness({
    serverUrl,
    workspace,
    prompt: "Find Hatch. Save the summary to \"agent-output.md\".",
    rustRunnerBin
  });

  assert.match(result.finalText, /Your work is ready/);
  assert.deepEqual(result.events.filter((event) => event.type === "tool_call.request").map((event) => event.name), [
    "fs.search",
    "fs.read",
    "fs.write"
  ]);
  assert.match(await readFile(path.join(workspace, "agent-output.md"), "utf8"), /Rust runner/);

  const audit = await readFile(path.join(workspace, "audit.jsonl"), "utf8");
  assert.match(audit, /"tool":"search"/);
  assert.match(audit, /"tool":"read"/);
  assert.match(audit, /"tool":"write_file"/);
});

test("local harness rejects filesystem paths outside the declared workspace", async () => {
  const workspace = await tempWorkspace();
  const request: ToolRequest = {
    type: "tool_call.request",
    run_id: "run_x",
    tool_call_id: "tool_x",
    name: "fs.read",
    arguments: { path: "../secret.txt" },
    approval: "auto"
  };

  const result = await executeLocalTool(request, workspace, false);
  assert.equal(result.type, "tool_call.result");
  assert.equal(result.status, "error");
  assert.equal((result.error as Record<string, unknown>).code, "tool_failed");
  assert.match(JSON.stringify(result), /Path escapes workspace/);
});

test("local harness fs.search matches workspace-relative file paths", async () => {
  const workspace = await tempWorkspace();
  await mkdir(path.join(workspace, "legal-samples"), { recursive: true });
  await writeFile(
    path.join(workspace, "legal-samples", "legal.local.md"),
    "Customer contract review positions.\n",
    "utf8"
  );
  const request: ToolRequest = {
    type: "tool_call.request",
    run_id: "run_search_path",
    tool_call_id: "tool_search_path",
    name: "fs.search",
    arguments: {
      path: ".",
      query: "legal.local.md",
      max_results: 10
    },
    approval: "auto"
  };

  const result = await executeLocalTool(request, workspace, false);
  assert.equal(result.status, "ok");
  assert.ok(JSON.stringify(result.result).includes("legal-samples/legal.local.md"));
});

test("local harness fs.write creates missing parent directories", async () => {
  const workspace = await tempWorkspace();
  const request: ToolRequest = {
    type: "tool_call.request",
    run_id: "run_write_parent",
    tool_call_id: "tool_write_parent",
    name: "fs.write",
    arguments: {
      path: "documents/hello.txt",
      content: "hello from Hatch\n"
    },
    approval: "auto"
  };

  const result = await executeLocalTool(request, workspace, false);
  assert.equal(result.type, "tool_call.result");
  assert.equal(result.status, "ok");
  assert.match(await readFile(path.join(workspace, "documents", "hello.txt"), "utf8"), /hello from Hatch/);
});

test("auto-permission local tool calls bypass client approval and execute", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  await writeFile(path.join(workspace, "README.md"), "Hatch approval test.\n", "utf8");

  runtimeServer = createDeterministicRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  const session = new LocalHarnessSession({
    serverUrl,
    workspace,
    approveTool: () => false
  });

  await session.connect();
  try {
    const result = await session.run("Find Hatch. Save the summary to \"agent-output.md\".");
    assert.match(result.finalText, /(?:Your work is ready|I finished reviewing)/);
    assert.deepEqual(result.events.filter((event) => event.type === "approval.request" || event.type === "approval.result"), []);
  } finally {
    session.close();
  }

  assert.match(await readFile(path.join(workspace, "agent-output.md"), "utf8"), /Hatch approval test/);
  const events = await new RuntimeStore(dataDir).readEvents();
  assert.ok(!events.some((event) => (
    event.type === "runtime.event"
    && typeof event.event === "object"
    && event.event !== null
    && String((event.event as Record<string, unknown>).type).startsWith("approval.")
  )));
  assert.ok(events.some((event) => (
    event.type === "runtime.event"
    && typeof event.event === "object"
    && event.event !== null
    && (event.event as Record<string, unknown>).type === "tool_call.delta"
    && (event.event as Record<string, unknown>).name === "fs.write"
    && (event.event as Record<string, unknown>).status === "completed"
  )));
});

test("local harness defaults to max local tool capability", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  const session = new LocalHarnessSession({
    serverUrl,
    workspace
  });

  await session.connect();
  session.close();

  const events = await new RuntimeStore(dataDir).readEvents();
  const started = events.find((event) => event.type === "session.started");
  assert.ok(started && started.type === "session.started");
  assert.deepEqual(started.local_tools, [
    "fs.list",
    "fs.search",
    "fs.read",
    "fs.write",
    "fs.patch",
    "git.diff",
    "shell.exec"
  ]);
});

test("client hello does not accept explicit skill selection", () => {
  assert.throws(() => parseInboundMessage({
    type: "client.hello",
    protocol_version: PROTOCOL_VERSION,
    installation_id: "install_x",
    license_token: "license_x",
    workspace_root: "/tmp/workspace",
    local_tools: [],
    skill_id: "repo-assistant"
  }), /Unrecognized key/);
});

test("run start accepts only the current user message, not a client transcript or capability list", () => {
  assert.throws(() => parseInboundMessage({
    type: "client.message",
    run_id: "run_x",
    conversation_id: "conv_x",
    input: [
      { role: "user", content: "message 1" },
      { role: "assistant", content: "response 1" },
      { role: "user", content: "message 2" }
    ]
  }), /Unrecognized key|message/);

  assert.throws(() => parseInboundMessage({
    type: "client.message",
    run_id: "run_x",
    conversation_id: "conv_x",
    message: { role: "user", content: "message 1" },
    enabled_tools: ["fs.read"]
  }), /Unrecognized key/);

  assert.doesNotThrow(() => parseInboundMessage({
    type: "client.message",
    run_id: "run_x",
    conversation_id: "conv_x",
    message: { role: "user", content: "message 1" }
  }));
});

test("client hello declares local workspace capability and rejects server tools", () => {
  assert.doesNotThrow(() => parseInboundMessage({
    type: "client.hello",
    protocol_version: PROTOCOL_VERSION,
    installation_id: "install_x",
    license_token: "license_x",
    workspace_root: "/tmp/workspace",
    local_tools: ["fs.read", "fs.search", "git.diff"]
  }));

  assert.throws(() => parseInboundMessage({
    type: "client.hello",
    protocol_version: PROTOCOL_VERSION,
    installation_id: "install_x",
    license_token: "license_x",
    workspace_root: "/tmp/workspace",
    local_tools: ["web.search"]
  }), /Invalid option/);
});

test("client hello requires explicit local workspace capability", () => {
  assert.throws(() => parseInboundMessage({
    type: "client.hello",
    protocol_version: PROTOCOL_VERSION,
    installation_id: "install_x",
    license_token: "license_x",
    workspace_root: "/tmp/workspace"
  }));

  assert.doesNotThrow(() => parseInboundMessage({
    type: "client.hello",
    protocol_version: PROTOCOL_VERSION,
    installation_id: "install_x",
    license_token: "license_x",
    local_tools: []
  }));

  assert.throws(() => parseInboundMessage({
    type: "client.hello",
    protocol_version: PROTOCOL_VERSION,
    installation_id: "install_x",
    license_token: "license_x",
    local_tools: ["fs.read"]
  }), /workspace_root is required/);
});

test("tool result requires a matching payload for its status", () => {
  assert.doesNotThrow(() => parseInboundMessage({
    type: "tool_call.result",
    run_id: "run_x",
    tool_call_id: "tool_x",
    status: "ok",
    result: { ok: true }
  }));

  assert.doesNotThrow(() => parseInboundMessage({
    type: "tool_call.result",
    run_id: "run_x",
    tool_call_id: "tool_x",
    status: "error",
    error: { code: "tool_failed", message: "failed" }
  }));

  assert.throws(() => parseInboundMessage({
    type: "tool_call.result",
    run_id: "run_x",
    tool_call_id: "tool_x",
    status: "ok"
  }), /result/);

  assert.throws(() => parseInboundMessage({
    type: "tool_call.result",
    run_id: "run_x",
    tool_call_id: "tool_x",
    status: "error"
  }), /error/);
});

test("skills expose official catalog metadata only", async () => {
  const catalog = await listSkills();
  const skill = catalog.find((item) => item.name === "repo-assistant");
  assert.ok(skill);
  assert.equal(Object.keys(skill).sort().join(","), "description,id,name,path");
});

test("skills follow official SKILL.md frontmatter naming semantics", async () => {
  const root = await tempWorkspace();
  const valid = path.join(root, "valid-skill");
  const looseName = path.join(root, "loose-name-dir");
  const mismatchedName = path.join(root, "mismatched-dir");
  const consecutiveHyphen = path.join(root, "bad--skill");
  const missingName = path.join(root, "missing-name");
  const invalidYaml = path.join(root, "invalid-yaml");
  const arrayAllowedTools = path.join(root, "array-allowed-tools");
  const numericMetadata = path.join(root, "numeric-metadata");
  const numericLicense = path.join(root, "numeric-license");
  await mkdir(valid, { recursive: true });
  await mkdir(looseName, { recursive: true });
  await mkdir(mismatchedName, { recursive: true });
  await mkdir(consecutiveHyphen, { recursive: true });
  await mkdir(missingName, { recursive: true });
  await mkdir(invalidYaml, { recursive: true });
  await mkdir(arrayAllowedTools, { recursive: true });
  await mkdir(numericMetadata, { recursive: true });
  await mkdir(numericLicense, { recursive: true });
  await writeFile(path.join(valid, "SKILL.md"), [
    "---",
    "name: valid-skill",
    "description: Use when validating official skill metadata parsing.",
    "license: Apache-2.0",
    "compatibility: Requires git.",
    "metadata:",
    "  short-description: Metadata parser",
    "allowed-tools: Read Bash(git:*)",
    "---",
    "",
    "# Valid Skill"
  ].join("\n"), "utf8");
  await writeFile(path.join(looseName, "SKILL.md"), [
    "---",
    "name: Bad_Skill",
    "description: Agent Skills names must be lowercase alphanumeric with hyphen separators.",
    "---",
    "",
    "# Loose Name"
  ].join("\n"), "utf8");
  await writeFile(path.join(mismatchedName, "SKILL.md"), [
    "---",
    "name: other-name",
    "description: Agent Skills names must match the parent skill directory.",
    "---",
    "",
    "# Mismatched Name"
  ].join("\n"), "utf8");
  await writeFile(path.join(consecutiveHyphen, "SKILL.md"), [
    "---",
    "name: bad--skill",
    "description: Agent Skills names cannot contain consecutive hyphens.",
    "---",
    "",
    "# Consecutive Hyphen"
  ].join("\n"), "utf8");
  await writeFile(path.join(missingName, "SKILL.md"), [
    "---",
    "description: The Agent Skills format requires name and description.",
    "---",
    "",
    "# Missing Name"
  ].join("\n"), "utf8");
  await writeFile(path.join(invalidYaml, "SKILL.md"), [
    "---",
    "name: invalid-yaml",
    "description: Malformed YAML must not be parsed by a lenient fallback.",
    "metadata: [unterminated",
    "---",
    "",
    "# Invalid YAML"
  ].join("\n"), "utf8");
  await writeFile(path.join(arrayAllowedTools, "SKILL.md"), [
    "---",
    "name: array-allowed-tools",
    "description: allowed-tools must be a space-separated string.",
    "allowed-tools:",
    "  - Read",
    "---",
    "",
    "# Array Allowed Tools"
  ].join("\n"), "utf8");
  await writeFile(path.join(numericMetadata, "SKILL.md"), [
    "---",
    "name: numeric-metadata",
    "description: metadata values must be strings.",
    "metadata:",
    "  version: 1",
    "---",
    "",
    "# Numeric Metadata"
  ].join("\n"), "utf8");
  await writeFile(path.join(numericLicense, "SKILL.md"), [
    "---",
    "name: numeric-license",
    "description: license must be a string when provided.",
    "license: 42",
    "---",
    "",
    "# Numeric License"
  ].join("\n"), "utf8");

  const skills = await discoverSkills(root);
  assert.deepEqual(skills.map((skill) => skill.name).sort(), ["valid-skill"]);
  const validSkill = skills.find((skill) => skill.name === "valid-skill");
  assert.equal(validSkill?.manifest.license, "Apache-2.0");
  assert.equal(validSkill?.manifest.compatibility, "Requires git.");
  assert.equal(validSkill?.manifest.allowedTools, "Read Bash(git:*)");
  assert.equal(validSkill?.shortDescription, "Metadata parser");
  const resourceRoot = await realpath(root);
  await assert.rejects(
    async () => loadSkillByPath(await realpath(path.join(looseName, "SKILL.md")), [resourceRoot]),
    /lowercase letters, numbers, and single hyphen separators/
  );
  await assert.rejects(
    async () => loadSkillByPath(await realpath(path.join(mismatchedName, "SKILL.md")), [resourceRoot]),
    /name must match parent directory name/
  );
  await assert.rejects(
    async () => loadSkillByPath(await realpath(path.join(arrayAllowedTools, "SKILL.md")), [resourceRoot]),
    /field `allowed-tools` must be a string/
  );
  await assert.rejects(
    async () => loadSkillByPath(await realpath(path.join(numericMetadata, "SKILL.md")), [resourceRoot]),
    /metadata.version must be a string/
  );
  await assert.rejects(
    async () => loadSkillByPath(await realpath(path.join(numericLicense, "SKILL.md")), [resourceRoot]),
    /field `license` must be a string/
  );
});

test("skill allowed-tools map official tool names to local tool grants", () => {
  const grants = parseAllowedTools("Read, Write Bash(git:*) Bash(jq:*)");
  assert.deepEqual(grants, [
    { tool: "fs.read" },
    { tool: "fs.write" },
    { tool: "shell.exec", shellPrefix: "git" },
    { tool: "shell.exec", shellPrefix: "jq" }
  ]);

  const skills = [{
    name: "allowed-tools-skill",
    path: "/skills/allowed-tools-skill/SKILL.md",
    directory: "/skills/allowed-tools-skill",
    content: "",
    allowed_tools: "Write Bash(git:*)",
    resource_paths: [],
    resource_manifest_truncated: false,
    activated_at: new Date(0).toISOString()
  }];
  assert.equal(toolPreapprovedBySkills(skills, "fs.write", { path: "out.md", content: "ok" }), true);
  assert.equal(toolPreapprovedBySkills(skills, "shell.exec", { command: "git --version" }), true);
  assert.equal(toolPreapprovedBySkills(skills, "shell.exec", { command: "printf hi" }), false);
  assert.equal(toolPreapprovedBySkills(skills, "fs.patch", { path: "out.md", patch: "" }), false);
});

test("configured server-side skill roots, symlinked skill folders, and implicit policy are discovered", async () => {
  const workspace = await tempWorkspace();
  const nested = path.join(workspace, "packages", "app");
  const rootSkills = path.join(workspace, ".agents", "skills");
  const nestedSkills = path.join(nested, ".agents", "skills");
  const symlinkTarget = path.join(workspace, "shared-skill");
  await mkdir(rootSkills, { recursive: true });
  await mkdir(nestedSkills, { recursive: true });
  await mkdir(path.join(rootSkills, "manual-skill", "agents"), { recursive: true });
  await mkdir(path.join(nestedSkills, "implicit-skill"), { recursive: true });
  await mkdir(symlinkTarget, { recursive: true });
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await writeFile(path.join(rootSkills, "manual-skill", "SKILL.md"), [
    "---",
    "name: manual-skill",
    "description: Manual skill. Use only when explicitly mentioned.",
    "---",
    "",
    "# Manual"
  ].join("\n"), "utf8");
  await writeFile(path.join(rootSkills, "manual-skill", "agents", "openai.yaml"), [
    "policy:",
    "  allow_implicit_invocation: false"
  ].join("\n"), "utf8");
  await writeFile(path.join(nestedSkills, "implicit-skill", "SKILL.md"), [
    "---",
    "name: implicit-skill",
    "description: Implicit skill. Use when nested workspace skill discovery is needed.",
    "---",
    "",
    "# Implicit"
  ].join("\n"), "utf8");
  await writeFile(path.join(symlinkTarget, "SKILL.md"), [
    "---",
    "name: shared-skill",
    "description: Shared symlink skill. Use when testing symlinked skill folders.",
    "---",
    "",
    "# Shared"
  ].join("\n"), "utf8");
  await symlink(symlinkTarget, path.join(rootSkills, "shared-skill"));
  delete process.env.HATCH_TS_SKILLS_ROOT;
  process.env.HATCH_SKILL_ROOTS = [rootSkills, nestedSkills].join(path.delimiter);

  const discovered = await discoverSkills({ workspaceRoot: nested });
  assert.ok(discovered.some((skill) => skill.name === "implicit-skill"));
  assert.ok(discovered.some((skill) => skill.name === "manual-skill"));
  assert.ok(discovered.some((skill) => skill.name === "shared-skill"));

  const implicitCatalog = await listSkills({ workspaceRoot: nested, prompt: "please inspect nested workspace skills" });
  assert.ok(implicitCatalog.some((skill) => skill.name === "implicit-skill"));
  assert.ok(!implicitCatalog.some((skill) => skill.name === "manual-skill"));
  const implicitVisible = visibleSkillsForPrompt(discovered, "please inspect nested workspace skills");
  const implicitResourceRoots = skillResourceRoots(implicitVisible);
  assert.ok(implicitResourceRoots.some((root) => root.endsWith("implicit-skill")));
  assert.ok(!implicitResourceRoots.some((root) => root.endsWith("manual-skill")));

  const explicitCatalog = await listSkills({ workspaceRoot: nested, prompt: "please use $manual-skill now" });
  assert.ok(explicitCatalog.some((skill) => skill.name === "manual-skill"));
  const explicitVisible = visibleSkillsForPrompt(discovered, "please use $manual-skill now");
  assert.ok(skillResourceRoots(explicitVisible).some((root) => root.endsWith("manual-skill")));
  const plainTextCatalog = await listSkills({ workspaceRoot: nested, prompt: "please use manual-skill now" });
  assert.ok(!plainTextCatalog.some((skill) => skill.name === "manual-skill"));
  assert.deepEqual(
    [...explicitSkillMentions("run $manual-skill, /shared-skill, and implicit-skill", ["manual-skill", "implicit-skill", "shared-skill"])],
    ["manual-skill"]
  );
  assert.deepEqual([...explicitDollarSkillMentions("run $manual-skill and implicit-skill")], ["manual-skill"]);
  assert.deepEqual([...explicitDollarSkillMentions("run $plugin:manual-skill and $OTHER_skill")], ["plugin:manual-skill", "OTHER_skill"]);
  assert.deepEqual([...explicitSkillMentions("run manual-skill but not manual-skill-extra", ["manual-skill"])], []);
  assert.deepEqual([...explicitSkillMentions("run /manual-skill", ["manual-skill"])], []);
  const linked = explicitLinkedSkillMentions(`run [$manual-skill](${path.join(rootSkills, "manual-skill", "SKILL.md")})`);
  assert.deepEqual([...linked.names], ["manual-skill"]);
  assert.deepEqual([...linked.paths], [path.join(rootSkills, "manual-skill", "SKILL.md").replaceAll("\\", "/")]);
});

test("skill discovery deduplicates canonical SKILL.md paths and keeps the first root", async () => {
  const workspace = await tempWorkspace();
  const realRoot = path.join(workspace, "real-root");
  const aliasRoot = path.join(workspace, "alias-root");
  const skillDir = path.join(realRoot, "duplicate-path-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: duplicate-path-skill",
    "description: Duplicate path skill. Use when testing canonical path dedupe.",
    "---",
    "",
    "# Duplicate Path"
  ].join("\n"), "utf8");
  await symlink(realRoot, aliasRoot);
  delete process.env.HATCH_TS_SKILLS_ROOT;

  const discovered = await discoverSkills({
    roots: [
      { path: aliasRoot, scope: "system" },
      { path: realRoot, scope: "repo" }
    ]
  });
  const matches = discovered.filter((skill) => skill.name === "duplicate-path-skill");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.scope, "system");
});

test("project .codex skills are ignored by default and only load from explicit roots", async () => {
  const workspace = await tempWorkspace();
  const nested = path.join(workspace, "services", "api");
  const rootSkillDir = path.join(workspace, ".codex", "skills", "project-skill");
  const nestedSkillDir = path.join(nested, ".codex", "skills", "nested-project-skill");
  await mkdir(rootSkillDir, { recursive: true });
  await mkdir(nestedSkillDir, { recursive: true });
  await mkdir(nested, { recursive: true });
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await writeFile(path.join(rootSkillDir, "SKILL.md"), [
    "---",
    "name: project-skill",
    "description: Project skill. Use when testing .codex skills discovery.",
    "---",
    "",
    "# Project"
  ].join("\n"), "utf8");
  await writeFile(path.join(nestedSkillDir, "SKILL.md"), [
    "---",
    "name: nested-project-skill",
    "description: Nested project skill. Use when testing closest .codex skills discovery.",
    "---",
    "",
    "# Nested Project"
  ].join("\n"), "utf8");
  delete process.env.HATCH_TS_SKILLS_ROOT;

  const discovered = await discoverSkills({ workspaceRoot: nested });
  const names = discovered.map((skill) => skill.name);
  assert.ok(!names.includes("project-skill"));
  assert.ok(!names.includes("nested-project-skill"));

  process.env.HATCH_SKILL_ROOTS = [
    path.join(workspace, ".codex", "skills"),
    path.join(nested, ".codex", "skills")
  ].join(path.delimiter);
  const configured = await discoverSkills({ workspaceRoot: nested });
  const configuredNames = configured.map((skill) => skill.name);
  assert.ok(configuredNames.includes("project-skill"));
  assert.ok(configuredNames.includes("nested-project-skill"));
  assert.ok(configured
    .filter((skill) => skill.name === "project-skill" || skill.name === "nested-project-skill")
    .every((skill) => skill.scope === "user"));
});

test("project root marker config does not trigger workspace skill discovery", async () => {
  const workspace = await tempWorkspace();
  const configDir = await tempWorkspace();
  const nested = path.join(workspace, "services", "api");
  const agentSkillDir = path.join(workspace, ".agents", "skills", "marker-agent-skill");
  const codexSkillDir = path.join(workspace, ".codex", "skills", "marker-codex-skill");
  await mkdir(agentSkillDir, { recursive: true });
  await mkdir(codexSkillDir, { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(workspace, "hatch-root.marker"), "", "utf8");
  await writeFile(path.join(agentSkillDir, "SKILL.md"), [
    "---",
    "name: marker-agent-skill",
    "description: Marker agent skill. Use when testing configured repo root markers.",
    "---",
    "",
    "# Marker Agent"
  ].join("\n"), "utf8");
  await writeFile(path.join(codexSkillDir, "SKILL.md"), [
    "---",
    "name: marker-codex-skill",
    "description: Marker Codex skill. Use when testing configured repo root markers.",
    "---",
    "",
    "# Marker Codex"
  ].join("\n"), "utf8");
  const configPath = path.join(configDir, "config.toml");
  await writeFile(configPath, 'project_root_markers = ["hatch-root.marker"]', "utf8");
  process.env.HATCH_SKILLS_CONFIG = configPath;
  delete process.env.HATCH_TS_SKILLS_ROOT;

  const discovered = await discoverSkills({ workspaceRoot: nested });
  const names = discovered.map((skill) => skill.name);
  assert.ok(!names.includes("marker-agent-skill"));
  assert.ok(!names.includes("marker-codex-skill"));

  process.env.HATCH_SKILL_ROOTS = path.join(workspace, ".agents", "skills");
  const configured = await discoverSkills({ workspaceRoot: nested });
  const configuredNames = configured.map((skill) => skill.name);
  assert.ok(configuredNames.includes("marker-agent-skill"));
  assert.ok(!configuredNames.includes("marker-codex-skill"));
  assert.equal(configured.find((skill) => skill.name === "marker-agent-skill")?.scope, "user");
});

test("workspace ancestor .agents skills are ignored unless configured as server roots", async () => {
  const workspace = await tempWorkspace();
  const configDir = await tempWorkspace();
  const nested = path.join(workspace, "services", "api");
  const rootSkillDir = path.join(workspace, ".agents", "skills", "root-marker-disabled-skill");
  const nestedSkillDir = path.join(nested, ".agents", "skills", "nested-marker-enabled-skill");
  await mkdir(rootSkillDir, { recursive: true });
  await mkdir(nestedSkillDir, { recursive: true });
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await writeFile(path.join(rootSkillDir, "SKILL.md"), [
    "---",
    "name: root-marker-disabled-skill",
    "description: Root skill. Use when testing disabled root marker discovery.",
    "---",
    "",
    "# Root Marker Disabled"
  ].join("\n"), "utf8");
  await writeFile(path.join(nestedSkillDir, "SKILL.md"), [
    "---",
    "name: nested-marker-enabled-skill",
    "description: Nested skill. Use when testing disabled root marker discovery.",
    "---",
    "",
    "# Nested Marker Enabled"
  ].join("\n"), "utf8");
  const configPath = path.join(configDir, "config.toml");
  await writeFile(configPath, "project_root_markers = []", "utf8");
  process.env.HATCH_SKILLS_CONFIG = configPath;
  delete process.env.HATCH_TS_SKILLS_ROOT;

  const discovered = await discoverSkills({ workspaceRoot: nested });
  const names = discovered.map((skill) => skill.name);
  assert.ok(!names.includes("root-marker-disabled-skill"));
  assert.ok(!names.includes("nested-marker-enabled-skill"));

  process.env.HATCH_SKILL_ROOTS = path.join(nested, ".agents", "skills");
  const configured = await discoverSkills({ workspaceRoot: nested });
  const configuredNames = configured.map((skill) => skill.name);
  assert.ok(!configuredNames.includes("root-marker-disabled-skill"));
  assert.ok(configuredNames.includes("nested-marker-enabled-skill"));
});

test("CODEX_HOME user, system cache, and plugin skill roots are ignored by default", async () => {
  const codexHome = await tempWorkspace();
  const userSkillDir = path.join(codexHome, "skills", "codex-home-skill");
  const systemSkillDir = path.join(codexHome, "skills", ".system", "system-cache-skill");
  const pluginRoot = path.join(codexHome, "plugins", "cache", "market", "plugin", "1.0.0");
  const pluginSkillDir = path.join(pluginRoot, "custom-skills", "plugin-skill");
  const defaultPluginSkillDir = path.join(pluginRoot, "skills", "default-plugin-skill");
  const fallbackPluginRoot = path.join(codexHome, "plugins", "cache", "market", "fallback", "1.0.0");
  const fallbackPluginSkillDir = path.join(fallbackPluginRoot, "skills", "fallback-plugin-skill");

  await mkdir(userSkillDir, { recursive: true });
  await mkdir(systemSkillDir, { recursive: true });
  await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
  await mkdir(path.join(fallbackPluginRoot, ".codex-plugin"), { recursive: true });
  await mkdir(pluginSkillDir, { recursive: true });
  await mkdir(defaultPluginSkillDir, { recursive: true });
  await mkdir(fallbackPluginSkillDir, { recursive: true });
  await writeFile(path.join(userSkillDir, "SKILL.md"), [
    "---",
    "name: codex-home-skill",
    "description: Use when testing CODEX_HOME user skill discovery.",
    "---",
    "",
    "# Codex Home"
  ].join("\n"), "utf8");
  await writeFile(path.join(systemSkillDir, "SKILL.md"), [
    "---",
    "name: system-cache-skill",
    "description: Use when testing CODEX_HOME system skill cache discovery.",
    "---",
    "",
    "# System Cache"
  ].join("\n"), "utf8");
  await writeFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "plugin",
    skills: "./custom-skills/"
  }), "utf8");
  await writeFile(path.join(fallbackPluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "fallback"
  }), "utf8");
  await writeFile(path.join(pluginSkillDir, "SKILL.md"), [
    "---",
    "name: plugin-skill",
    "description: Use when testing manifest-configured plugin skill roots.",
    "---",
    "",
    "# Plugin"
  ].join("\n"), "utf8");
  await writeFile(path.join(defaultPluginSkillDir, "SKILL.md"), [
    "---",
    "name: default-plugin-skill",
    "description: Use when testing manifest skill roots replace default plugin roots.",
    "---",
    "",
    "# Default Plugin"
  ].join("\n"), "utf8");
  await writeFile(path.join(fallbackPluginSkillDir, "SKILL.md"), [
    "---",
    "name: fallback-plugin-skill",
    "description: Use when testing default plugin skills root discovery.",
    "---",
    "",
    "# Fallback Plugin"
  ].join("\n"), "utf8");

  process.env.CODEX_HOME = codexHome;
  delete process.env.HATCH_TS_SKILLS_ROOT;

  const discovered = await discoverSkills();
  const byName = new Map(discovered.map((skill) => [skill.name, skill]));
  assert.equal(byName.has("codex-home-skill"), false);
  assert.equal(byName.has("system-cache-skill"), false);
  assert.equal(byName.has("plugin:plugin-skill"), false);
  assert.equal(byName.has("fallback:fallback-plugin-skill"), false);
});

test("system skill roots follow symlinked skill folders", async () => {
  const root = await tempWorkspace();
  const target = await tempWorkspace();
  await mkdir(path.join(target, "system-symlink-skill"), { recursive: true });
  await writeFile(path.join(target, "system-symlink-skill", "SKILL.md"), [
    "---",
    "name: system-symlink-skill",
    "description: Use when testing system skill symlink discovery.",
    "---",
    "",
    "# System Symlink Skill"
  ].join("\n"), "utf8");
  await symlink(path.join(target, "system-symlink-skill"), path.join(root, "system-symlink-skill"));
  process.env.HATCH_TS_SKILLS_ROOT = root;

  const discovered = await discoverSkills();
  assert.ok(discovered.some((skill) => skill.name === "system-symlink-skill"));
});

test("skills section renders declared tool dependencies from agents openai metadata", async () => {
  const root = await tempWorkspace();
  const skillDir = path.join(root, "dependency-skill");
  await mkdir(path.join(skillDir, "agents"), { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: dependency-skill",
    "description: Use when testing Agent Skills dependency metadata.",
    "---",
    "",
    "# Dependency Skill"
  ].join("\n"), "utf8");
  await writeFile(path.join(skillDir, "agents", "openai.yaml"), [
    "dependencies:",
    "  tools:",
    "    - type: mcp",
    "      value: openaiDeveloperDocs",
    "      description: OpenAI Docs MCP server",
    "      transport: streamable_http",
    "      url: https://developers.openai.com/mcp",
    "    - type: local",
    "      value: git",
    "      description: Git CLI"
  ].join("\n"), "utf8");

  const skills = await discoverSkills(root);
  assert.equal(skills[0]?.openai.dependencies.tools.length, 2);
  const { section } = renderSkillsSection(skills, { prompt: "Use dependency-skill." });
  assert.match(section, /- dependency-skill: .*tools: mcp:openaiDeveloperDocs, local:git/);
  assert.doesNotMatch(section, /# Dependency Skill/);
});

test("server discovers vendored OpenAI-format skills without loading their bodies into the catalog", async () => {
  const records = await discoverSkills(skillsRoot());
  const byName = new Map(records.map((skill) => [skill.name, skill]));

  for (const name of ["pdf", "security-best-practices", "gh-fix-ci"]) {
    const skill = byName.get(name);
    assert.ok(skill, `expected official OpenAI skill ${name} to be discovered`);
    assert.ok(skill.path.endsWith(`${path.sep}SKILL.md`));
    assert.ok(skill.openai.interface, `${name} should expose agents/openai.yaml interface metadata`);
    assert.ok(skill.openai.interface?.shortDescription);
    assert.ok(skill.openai.interface?.defaultPrompt);
    await access(path.join(skill.directory, "agents", "openai.yaml"));
  }

  const catalog = await listSkills(skillsRoot());
  assert.deepEqual(
    catalog.filter((skill) => ["pdf", "security-best-practices", "gh-fix-ci"].includes(skill.name)).map((skill) => skill.name).sort(),
    ["gh-fix-ci", "pdf", "security-best-practices"]
  );

  const { section } = renderSkillsSection(records, { prompt: "Review a PDF and inspect code security." });
  assert.match(section, /- pdf: /);
  assert.match(section, /- security-best-practices: /);
  assert.match(section, /- gh-fix-ci: /);
  assert.doesNotMatch(section, /# PDF Skill/);
  assert.doesNotMatch(section, /# Security Best Practices/);
  assert.doesNotMatch(section, /# GitHub Fix CI/);
});

test("skill policy products restrict model-visible discovery to the current product", async () => {
  const root = await tempWorkspace();
  for (const [name, products] of [
    ["codex-only-skill", ["codex"]],
    ["chatgpt-only-skill", ["chatgpt"]],
    ["unrestricted-skill", []]
  ] as const) {
    const skillDir = path.join(root, name);
    await mkdir(path.join(skillDir, "agents"), { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), [
      "---",
      `name: ${name}`,
      `description: Use when testing product restriction for ${name}.`,
      "---",
      "",
      `# ${name}`
    ].join("\n"), "utf8");
    await writeFile(path.join(skillDir, "agents", "openai.yaml"), [
      "policy:",
      "  products:",
      ...products.map((product) => `    - ${product}`)
    ].join("\n"), "utf8");
  }

  const defaultSkills = await discoverSkills(root);
  assert.deepEqual(defaultSkills.map((skill) => skill.name), ["unrestricted-skill"]);

  process.env.HATCH_SKILL_PRODUCT = "codex";
  const codexSkills = await discoverSkills(root);
  assert.deepEqual(codexSkills.map((skill) => skill.name).sort(), ["codex-only-skill", "unrestricted-skill"]);

  process.env.HATCH_SKILL_PRODUCT = "chatgpt";
  const chatgptSkills = await discoverSkills(root);
  assert.deepEqual(chatgptSkills.map((skill) => skill.name).sort(), ["chatgpt-only-skill", "unrestricted-skill"]);

  process.env.HATCH_SKILL_PRODUCT = "atlas-dev";
  const unknownProductSkills = await discoverSkills(root);
  assert.deepEqual(unknownProductSkills.map((skill) => skill.name), ["unrestricted-skill"]);
});

test("skills with the same name are not merged and linked mentions select exact paths", async () => {
  const root = await tempWorkspace();
  const first = path.join(root, "service-a", "duplicate-skill");
  const second = path.join(root, "service-b", "duplicate-skill");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await writeFile(path.join(first, "SKILL.md"), [
    "---",
    "name: duplicate-skill",
    "description: First duplicate skill. Use when testing duplicate skill discovery.",
    "---",
    "",
    "# First Duplicate"
  ].join("\n"), "utf8");
  await writeFile(path.join(second, "SKILL.md"), [
    "---",
    "name: duplicate-skill",
    "description: Second duplicate skill. Use when testing duplicate skill discovery.",
    "---",
    "",
    "# Second Duplicate"
  ].join("\n"), "utf8");

  const discovered = await discoverSkills(root);
  assert.equal(discovered.filter((skill) => skill.name === "duplicate-skill").length, 2);
  assert.equal(new Set(discovered.map((skill) => skill.id)).size, 2);

  const visible = visibleSkillsForPrompt(discovered, "Use duplicate-skill.");
  assert.equal(visible.length, 2);
  const { section } = renderSkillsSection(discovered, { prompt: "Use duplicate-skill." });
  assert.equal((section.match(/- duplicate-skill:/g) ?? []).length, 2);
  assert.match(section, /First duplicate skill/);
  assert.match(section, /Second duplicate skill/);

  const explicitOnly = discovered.map((skill) => ({
    ...skill,
    openai: {
      ...skill.openai,
      policy: {
        ...skill.openai.policy,
        allowImplicitInvocation: false
      }
    }
  }));
  const secondSkillPath = discovered.find((skill) => skill.path.includes("service-b"))?.path;
  assert.ok(secondSkillPath);
  const linked = visibleSkillsForPrompt(explicitOnly, `Use [$duplicate-skill](${secondSkillPath}).`);
  assert.deepEqual(linked.map((skill) => skill.path), [secondSkillPath]);
  const refs = explicitSkillReferences(`Use [$duplicate-skill](${secondSkillPath}).`, discovered.map((skill) => skill.name));
  assert.deepEqual([...refs.names], []);
  assert.deepEqual([...refs.paths], [secondSkillPath.replaceAll("\\", "/")]);
});

test("linked skill mentions select by path without plain-name fallback", async () => {
  const root = await tempWorkspace();
  const skillDir = path.join(root, "only-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: only-skill",
    "description: Only skill. Use when testing linked skill mention path semantics.",
    "---",
    "",
    "# Only Skill"
  ].join("\n"), "utf8");

  const discovered = (await discoverSkills(root)).map((skill) => ({
    ...skill,
    openai: {
      ...skill.openai,
      policy: {
        ...skill.openai.policy,
        allowImplicitInvocation: false
      }
    }
  }));
  const missingPath = path.join(root, "missing", "SKILL.md");
  const realPath = discovered[0]?.path;
  assert.ok(realPath);

  const missingRefs = explicitSkillReferences(`Use [$only-skill](${missingPath}).`, discovered.map((skill) => skill.name));
  assert.deepEqual([...missingRefs.names], []);
  assert.deepEqual([...missingRefs.paths], [missingPath.replaceAll("\\", "/")]);
  assert.deepEqual(visibleSkillsForPrompt(discovered, `Use [$only-skill](${missingPath}).`).map((skill) => skill.name), []);

  const realRefs = explicitSkillReferences(`Use [$only-skill](${realPath}).`, discovered.map((skill) => skill.name));
  assert.deepEqual([...realRefs.names], []);
  assert.deepEqual([...realRefs.paths], [realPath.replaceAll("\\", "/")]);
  assert.deepEqual(visibleSkillsForPrompt(discovered, `Use [$only-skill](${realPath}).`).map((skill) => skill.name), ["only-skill"]);

  assert.deepEqual([...explicitDollarSkillMentions(`Use [$only-skill](${realPath}).`)], []);
  assert.deepEqual([...explicitDollarSkillMentions("Use [$only-skill]().")], ["only-skill"]);
  assert.deepEqual([...explicitDollarSkillMentions("Use $PATH and $only-skill.")], ["only-skill"]);
  assert.deepEqual([...explicitDollarSkillMentions("Use $only-skill/reference.md and prefix$only-skill.")], ["only-skill"]);
  assert.deepEqual([...explicitDollarSkillMentions("Use $only-skill_extra but not $only-skill.")], ["only-skill_extra", "only-skill"]);
});

test("skills section shortens descriptions or omits entries to fit the metadata budget", async () => {
  const root = await tempWorkspace();
  for (const name of ["alpha-skill", "beta-skill", "gamma-skill"]) {
    const skillDir = path.join(root, name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), [
      "---",
      `name: ${name}`,
      `description: ${name} ${"long description ".repeat(30)}`,
      "---",
      "",
      `# ${name}`
    ].join("\n"), "utf8");
  }

  const skills = await discoverSkills(root);
  const { section, report } = renderSkillsSection(skills, { budgetChars: 260 });
  assert.ok(report.truncated_description_chars > 0 || report.omitted_count > 0);
  assert.ok(report.warning_message);
  assert.match(section, /Warning: /);
  assert.match(section, new RegExp(escapeRegExp(report.warning_message)));
  assert.ok(section.length > 0);
  assert.doesNotMatch(section, /long description long description long description long description long description long description long description long description/);
});

test("skills section keeps absolute paths when there is no catalog budget pressure", async () => {
  const root = await tempWorkspace();
  const skillDir = path.join(root, "absolute-skill");
  const skillPath = path.join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });
  await writeFile(skillPath, [
    "---",
    "name: absolute-skill",
    "description: Absolute skill. Use when testing unaliased skills catalog rendering.",
    "---",
    "",
    "# Absolute Skill"
  ].join("\n"), "utf8");

  const skills = await discoverSkills(root);
  const { section, report } = renderSkillsSection(skills, { budgetChars: 100_000 });
  const discoveredPath = skills[0]?.path;
  assert.ok(discoveredPath);

  assert.equal(report.included_count, 1);
  assert.equal(report.omitted_count, 0);
  assert.doesNotMatch(section, /### Skill roots/);
  assert.match(section, new RegExp(`\\(file: ${escapeRegExp(discoveredPath.replaceAll("\\", "/"))}\\)`));
});

test("skills section uses Codex-style root aliases when they allow more skills to fit", async () => {
  const parent = await tempWorkspace();
  const root = path.join(parent, ...Array.from({ length: 8 }, (_, index) => `long-shared-prefix-segment-${index}`));
  const skillCount = 40;
  for (let index = 0; index < skillCount; index += 1) {
    const name = `shared-root-skill-${String(index).padStart(2, "0")}`;
    const skillDir = path.join(root, name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), [
      "---",
      `name: ${name}`,
      `description: ${name} description.`,
      "---",
      "",
      `# ${name}`
    ].join("\n"), "utf8");
  }

  const skills = await discoverSkills(root);
  const absoluteMinimumCost = skills.reduce((sum, skill) => {
    const line = `- ${skill.name}: (file: ${skill.path.replaceAll("\\", "/")})\n`;
    return sum + Array.from(line).length;
  }, 0);
  const budget = Math.floor(absoluteMinimumCost / 2);
  const rendered = renderSkillsSection(skills, { budgetChars: budget });

  assert.ok(budget < absoluteMinimumCost);
  assert.equal(rendered.report.omitted_count, 0);
  assert.equal(rendered.report.included_count, skillCount);
  assert.match(rendered.section, /### Skill roots\n- `r0` = `/);
  assert.match(rendered.section, /\(file: r0\/shared-root-skill-00\/SKILL\.md\)/);
  assert.match(rendered.section, /\(file: r0\/shared-root-skill-39\/SKILL\.md\)/);
  assert.match(rendered.section, /expand the listed short `path` with the matching alias/);
});

test("skills metadata budget uses two percent of known context window or 8000 chars when unknown", () => {
  delete process.env.HATCH_SKILL_METADATA_BUDGET_CHARS;
  delete process.env.HATCH_MODEL_CONTEXT_WINDOW_CHARS;

  assert.equal(skillMetadataCharBudget(), 8000);
  assert.equal(skillMetadataCharBudget(100_000), 2000);

  process.env.HATCH_MODEL_CONTEXT_WINDOW_CHARS = "5000";
  assert.equal(skillMetadataCharBudget(), 100);

  process.env.HATCH_SKILL_METADATA_BUDGET_CHARS = "321";
  assert.equal(skillMetadataCharBudget(100_000), 321);
});

test("skill bundle resource manifests report truncation when capped", async () => {
  const skillDir = path.join(await tempWorkspace(), "many-resources-skill");
  const references = path.join(skillDir, "references");
  await mkdir(references, { recursive: true });
  for (let index = 0; index < 205; index += 1) {
    await writeFile(path.join(references, `resource-${String(index).padStart(3, "0")}.md`), "resource\n", "utf8");
  }

  const manifest = await listSkillBundleResourcePaths(skillDir);
  assert.equal(manifest.paths.length, 200);
  assert.equal(manifest.truncated, true);
  assert.ok(manifest.paths.every((item) => item.startsWith("references/")));
});

test("skills config can disable a skill by SKILL.md path", async () => {
  const root = await tempWorkspace();
  const configDir = await tempWorkspace();
  const skillDir = path.join(root, "disabled-skill");
  const skillPath = path.join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });
  await writeFile(skillPath, [
    "---",
    "name: disabled-skill",
    "description: Use when testing disabled skill configuration.",
    "---",
    "",
    "# Disabled"
  ].join("\n"), "utf8");
  const configPath = path.join(configDir, "config.toml");
  await writeFile(configPath, [
    "[[skills.config]]",
    `path = "${skillPath}"`,
    "enabled = false"
  ].join("\n"), "utf8");
  process.env.HATCH_SKILLS_CONFIG = configPath;

  const discovered = await discoverSkills(root);
  assert.ok(!discovered.some((skill) => skill.name === "disabled-skill"));
});

test("skills config supports name selectors and ordered overrides", async () => {
  const root = await tempWorkspace();
  const configDir = await tempWorkspace();
  const first = path.join(root, "first", "shared-skill");
  const second = path.join(root, "second", "shared-skill");
  const restored = path.join(root, "restored-skill");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await mkdir(restored, { recursive: true });
  for (const [skillDir, name, title] of [
    [first, "shared-skill", "First Shared"],
    [second, "shared-skill", "Second Shared"],
    [restored, "restored-skill", "Restored"]
  ]) {
    await writeFile(path.join(skillDir, "SKILL.md"), [
      "---",
      `name: ${name}`,
      `description: ${title}. Use when testing skills.config selectors.`,
      "---",
      "",
      `# ${title}`
    ].join("\n"), "utf8");
  }
  const firstPath = path.join(first, "SKILL.md");
  const restoredPath = path.join(restored, "SKILL.md");
  const configPath = path.join(configDir, "config.toml");
  await writeFile(configPath, [
    "[[skills.config]]",
    'name = "shared-skill"',
    "enabled = false",
    "",
    "[[skills.config]]",
    `path = "${firstPath}"`,
    "enabled = true",
    "",
    "[[skills.config]]",
    `path = "${restoredPath}"`,
    "enabled = false",
    "",
    "[[skills.config]]",
    'name = "restored-skill"',
    "enabled = true",
    "",
    "[[skills.config]]",
    'name = "shared-skill"',
    `path = "${second}"`,
    "enabled = false"
  ].join("\n"), "utf8");
  process.env.HATCH_SKILLS_CONFIG = configPath;

  const discovered = await discoverSkills(root);
  const shared = discovered.filter((skill) => skill.name === "shared-skill").map((skill) => skill.path);
  assert.equal(shared.length, 1);
  assert.ok(shared[0]?.replaceAll("\\", "/").endsWith("/first/shared-skill/SKILL.md"));
  assert.ok(discovered.some((skill) => skill.name === "restored-skill"));
});

test("skills config can disable bundled system skill roots", async () => {
  const codexHome = await tempWorkspace();
  const userSkill = path.join(codexHome, "skills", "user-skill");
  const systemSkill = path.join(codexHome, "skills", ".system", "bundled-skill");
  await mkdir(userSkill, { recursive: true });
  await mkdir(systemSkill, { recursive: true });
  await writeFile(path.join(userSkill, "SKILL.md"), [
    "---",
    "name: user-skill",
    "description: User skill. Use when testing bundled skill config.",
    "---",
    "",
    "# User"
  ].join("\n"), "utf8");
  await writeFile(path.join(systemSkill, "SKILL.md"), [
    "---",
    "name: bundled-skill",
    "description: Bundled skill. Use when testing bundled skill config.",
    "---",
    "",
    "# Bundled"
  ].join("\n"), "utf8");
  const configPath = path.join(codexHome, "config.toml");
  await writeFile(configPath, [
    "[skills.bundled]",
    "enabled = false"
  ].join("\n"), "utf8");
  process.env.HATCH_SKILLS_CONFIG = configPath;
  process.env.HATCH_SKILL_ROOTS = path.join(codexHome, "skills");
  delete process.env.HATCH_TS_SKILLS_ROOT;

  const discovered = await discoverSkills();
  assert.ok(discovered.some((skill) => skill.name === "user-skill"));
  assert.ok(!discovered.some((skill) => skill.name === "bundled-skill"));
  assert.ok(!discovered.some((skill) => skill.name === "repo-assistant"));
  assert.ok(discovered.every((skill) => skill.scope !== "system"));
});

test("skills config can suppress automatic skills instructions", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const configDir = await tempWorkspace();
  await mkdir(path.join(workspace, ".agents", "skills", "quiet-skill"), { recursive: true });
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await writeFile(path.join(workspace, ".agents", "skills", "quiet-skill", "SKILL.md"), [
    "---",
    "name: quiet-skill",
    "description: Quiet skill. Use when testing disabled skill instruction injection.",
    "---",
    "",
    "# Quiet"
  ].join("\n"), "utf8");
  const configPath = path.join(configDir, "config.toml");
  await writeFile(configPath, [
    "[skills]",
    "include_instructions = false"
  ].join("\n"), "utf8");
  process.env.HATCH_SKILLS_CONFIG = configPath;
  assert.equal(await includeSkillInstructions(), false);

  const mock = await createFinalOnlyChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";
  delete process.env.HATCH_TS_SKILLS_ROOT;

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  try {
    const result = await runLocalHarness({
      serverUrl,
      workspace,
      prompt: "Inspect whether the skills catalog is injected."
    });

    assert.match(result.finalText, /final turn 1/);
    assert.equal(mock.requests.length, 1);
    const contexts = runtimeContexts(mock.requests[0] ?? {}).join("\n");
    assert.doesNotMatch(contexts, /AVAILABLE SKILLS/);
    assert.doesNotMatch(contexts, /quiet-skill/);
    assert.doesNotMatch(contexts, /<skills_instructions>/);
  } finally {
    await mock.close();
  }
});

test("skills section renders Codex-style progressive disclosure without SKILL.md bodies", async () => {
  const catalog = await discoverSkills();
  const { section, report } = renderSkillsSection(catalog, { prompt: "Find Hatch." });

  assert.match(section, /## Skills/);
  assert.match(section, /- repo-assistant: .* \(file: .*SKILL\.md\)/);
  assert.match(section, /- review-contract: .* \(file: .*SKILL\.md\)/);
  assert.match(section, /must read its `SKILL\.md` completely/);
  assert.doesNotMatch(section, /# Repo Assistant/);
  assert.doesNotMatch(section, /# \/review-contract/);
  assert.ok(report.included_count >= 2);
});

test("chat completions runtime uses generic file_read for skill path loading", async () => {
  const runtimeSource = await readFile(new URL("../src/agentRuntime.ts", import.meta.url), "utf8");
  const toolsSource = await readFile(new URL("../src/tools.ts", import.meta.url), "utf8");
  const specs = modelToolSpecsForRun(["fs.read"], { hasMcpServers: false });
  const fileRead = specs.find((spec) => spec.name === "file_read");
  const fileList = specs.find((spec) => spec.name === "file_list");

  assert.match(runtimeSource, /chat\.completions\.create/);
  assert.match(runtimeSource, /modelToolSpecsForRun/);
  assert.doesNotMatch(runtimeSource, /function chatModelToolSpecs/);
  assert.match(toolsSource, /name: "file_read"[\s\S]*?locality: "hybrid"/);
  assert.match(toolsSource, /name: "file_list"[\s\S]*?locality: "hybrid"/);
  assert.equal(fileRead?.runtimeName, "fs.read");
  assert.equal(fileRead?.clientTool, "fs.read");
  assert.equal(fileRead?.locality, "hybrid");
  assert.equal(fileList?.runtimeName, "fs.list");
  assert.equal(fileList?.locality, "hybrid");
  assert.doesNotMatch(runtimeSource, /@openai\/agents/);
  assert.doesNotMatch(runtimeSource, /shellTool/);
  assert.doesNotMatch(runtimeSource, /read_skill_file/);
  assert.doesNotMatch(runtimeSource, /load_skill/);
});

test("tool registry owns model tool dispatch locality and event-name mapping", () => {
  const web = requireModelToolDispatch("web_search");
  assert.equal(web.target, "server");
  assert.equal(web.runtimeName, "web.search");
  assert.equal(web.eventName, "web.search");
  assert.equal(web.approval, "none");

  const fileSearch = requireModelToolDispatch("file_search");
  assert.equal(fileSearch.target, "client");
  assert.equal(fileSearch.clientTool, "fs.search");
  assert.equal(fileSearch.eventName, "fs.search");
  assert.equal(fileSearch.approval, "auto");

  const fileRead = requireModelToolDispatch("file_read");
  assert.equal(fileRead.target, "hybrid");
  assert.equal(fileRead.runtimeName, "fs.read");
  assert.equal(fileRead.clientTool, "fs.read");
  assert.equal(fileRead.serverEventName, "file_read");
  assert.equal(fileRead.clientEventName, "fs.read");

  assert.throws(() => requireClientToolEnabled(["fs.read"], "fs.search"), /Client tool is not enabled/);
  assert.throws(() => requireTool("fs.read").schema.parse({ path: "README.md", extra: true }), /Unrecognized key|unrecognized/i);
  assert.deepEqual(requireTool("web.search").schema.parse({ query: "Hatch" }), { query: "Hatch", limit: 5 });
  assert.throws(() => requireTool("web.search").schema.parse({ query: "Hatch", extra: true }), /Unrecognized key|unrecognized/i);
  assert.deepEqual(requireTool("shell.exec").schema.parse({
    command: "printf hatch",
    justification: "Inspect shell behavior"
  }), {
    command: "printf hatch",
    timeout_ms: 30000,
    justification: "Inspect shell behavior"
  });
  const shellSpec = modelToolSpecsForRun(["shell.exec"], { hasMcpServers: false }).find((tool) => tool.name === "shell_exec");
  assert.ok(shellSpec);
  assert.ok("justification" in shellSpec.properties);
});

test.skip("chat completions runtime progressively reads SKILL.md through file_read before final response", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const mock = await createMockChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  try {
    const result = await runLocalHarness({
      serverUrl,
      workspace,
      prompt: "Inspect the workspace with the relevant repository helper."
    });

    assert.match(result.finalText, /Skill loaded before final response/);
    assert.equal(result.events.filter((event) => event.type === "tool_call.request").length, 0);
    assert.equal(mock.requests.length, 2);
    const firstMessages = mock.requests[0]?.messages ?? [];
    const secondMessages = mock.requests[1]?.messages ?? [];
    assert.doesNotMatch(String(firstMessages[0]?.content ?? ""), /repo-assistant/);
    const firstSkillContext = runtimeContextContent(mock.requests[0] ?? {}, /repo-assistant/);
    assert.doesNotMatch(firstSkillContext, /# Repo Assistant/);
    assert.ok(secondMessages.some((message: Record<string, unknown>) => (
      message.role === "tool"
      && String(message.content ?? "").includes("# Repo Assistant")
    )));
    assert.ok(result.events.some((event) => event.type === "tool_call.delta" && event.name === "file_read" && event.locality === "server" && event.status === "completed"));
  } finally {
    await mock.close();
  }
});

test.skip("chat completions runtime resolves aliased skills catalog paths for server-side file_read", async () => {
  const parent = await tempWorkspace();
  const workspace = path.join(parent, ...Array.from({ length: 8 }, (_, index) => `long-workspace-segment-${index}`));
  const dataDir = await tempWorkspace();
  const skillsRoot = path.join(workspace, ".agents", "skills");
  await mkdir(skillsRoot, { recursive: true });
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  for (let index = 0; index < 40; index += 1) {
    const name = `shared-root-skill-${String(index).padStart(2, "0")}`;
    const skillDir = path.join(skillsRoot, name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), [
      "---",
      `name: ${name}`,
      `description: ${name} description. Use when testing aliased skill catalog paths.`,
      "---",
      "",
      `# ${name}`,
      "",
      "Aliased skill body."
    ].join("\n"), "utf8");
  }

  const mock = await createAliasedSkillPathChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";
  process.env.HATCH_SKILL_METADATA_BUDGET_CHARS = "5000";
  process.env.HATCH_SKILL_ROOTS = skillsRoot;
  delete process.env.HATCH_TS_SKILLS_ROOT;

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  try {
    const result = await runLocalHarness({
      serverUrl,
      workspace,
      prompt: "Use the shared root skill catalog."
    });

    assert.match(result.finalText, /Aliased skill path loaded/);
    assert.equal(result.events.filter((event) => event.type === "tool_call.request").length, 0);
    assert.ok(result.events.some((event) => (
      event.type === "tool_call.delta"
      && event.name === "file_read"
      && event.locality === "server"
      && event.status === "completed"
      && String(event.result?.path ?? "").endsWith("/shared-root-skill-00/SKILL.md")
    )));
  } finally {
    await mock.close();
  }
});

test.skip("model-driven SKILL.md file_read returns bundled resource manifest without eager resource content", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const skillDir = path.join(workspace, ".agents", "skills", "implicit-resource-skill");
  await mkdir(path.join(skillDir, "references"), { recursive: true });
  await mkdir(path.join(skillDir, "scripts"), { recursive: true });
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: implicit-resource-skill",
    "description: Implicit resource skill. Use when testing model-driven resource manifests.",
    "---",
    "",
    "# Implicit Resource Skill",
    "",
    "Use references/guide.md when more detail is required."
  ].join("\n"), "utf8");
  await writeFile(path.join(skillDir, "references", "guide.md"), "implicit reference payload\n", "utf8");
  await writeFile(path.join(skillDir, "scripts", "check.sh"), "echo implicit\n", "utf8");

  const mock = await createModelDrivenResourceManifestChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";
  process.env.HATCH_SKILL_ROOTS = path.join(workspace, ".agents", "skills");
  delete process.env.HATCH_TS_SKILLS_ROOT;

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  try {
    const result = await runLocalHarness({
      serverUrl,
      workspace,
      prompt: "Inspect resource manifest handling with the relevant helper."
    });

    assert.match(result.finalText, /Model-driven resource manifest observed/);
    assert.equal(mock.requests.length, 2);
    assert.ok(result.events.some((event) => (
      event.type === "tool_call.delta"
      && event.name === "file_read"
      && event.locality === "server"
      && event.status === "completed"
      && Array.isArray(event.result?.resource_paths)
      && event.result.resource_manifest_truncated === false
      && event.result.resource_paths.includes("references/guide.md")
      && event.result.resource_paths.includes("scripts/check.sh")
      && !String(event.result.content ?? "").includes("implicit reference payload")
    )));
  } finally {
    await mock.close();
  }
});

test.skip("model-driven skill allowed-tools are preserved while local tools run with auto permission", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const skillDir = path.join(workspace, ".agents", "skills", "implicit-write-skill");
  await mkdir(skillDir, { recursive: true });
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: implicit-write-skill",
    "description: Implicit write skill. Use when testing model-driven allowed-tools preapproval.",
    "allowed-tools: Write",
    "---",
    "",
    "# Implicit Write Skill",
    "",
    "Write the requested local file."
  ].join("\n"), "utf8");

  const mock = await createModelDrivenAllowedToolsChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";
  process.env.HATCH_SKILL_ROOTS = path.join(workspace, ".agents", "skills");
  delete process.env.HATCH_TS_SKILLS_ROOT;

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  try {
    const result = await runLocalHarness({
      serverUrl,
      workspace,
      prompt: "Write the file with the relevant implicit helper.",
      approveTool: (request) => request.approval !== "ask"
    });

    assert.match(result.finalText, /Model-driven allowed tools completed/);
    assert.equal(mock.requests.length, 3);
    assert.deepEqual(result.events.filter((event) => event.type === "tool_call.request").map((event) => `${event.name}:${event.approval}`), [
      "fs.write:auto"
    ]);
    assert.deepEqual(result.events.filter((event) => event.type === "approval.request" || event.type === "approval.result"), []);
    assert.ok(result.events.some((event) => event.type === "tool_call.delta" && event.name === "fs.write" && event.approval === "auto" && event.status === "requested"));
  } finally {
    await mock.close();
  }

  assert.match(await readFile(path.join(workspace, "model-driven-allowed.md"), "utf8"), /same-run preapproval/);
  const events = await new RuntimeStore(dataDir).readEvents();
  const activation = events.find((event) => event.type === "skill.activated" && event.name === "implicit-write-skill");
  assert.ok(activation && activation.type === "skill.activated");
  assert.equal(activation.allowed_tools, "Write");
});

test.skip("chat completions runtime does not carry activated skill instructions across turns unless re-mentioned", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const mock = await createSkillRetentionChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  const session = new LocalHarnessSession({
    serverUrl,
    workspace,
    conversationId: "conv_skill_retention"
  });

  await session.connect();
  try {
    const first = await session.run("Inspect the workspace with the relevant repository helper.");
    const second = await session.run("Continue with the same skill.");

    assert.match(first.finalText, /First skill turn complete/);
    assert.match(second.finalText, /No activated skill retained/);
    assert.equal(mock.requests.length, 3);
    const secondTurnRequest = mock.requests[2];
    assert.ok(!runtimeContexts(secondTurnRequest ?? {}).some((content) => (
      content.includes("<skill>")
      && content.includes("<name>repo-assistant</name>")
      && content.includes("# Repo Assistant")
    )));
  } finally {
    session.close();
    await mock.close();
  }

  const events = await new RuntimeStore(dataDir).readEvents();
  assert.ok(events.some((event) => event.type === "skill.activated" && event.conversation_id === "conv_skill_retention"));
});

test.skip("explicit-only skill resources are server-readable on later turns when re-mentioned", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const skillDir = path.join(workspace, ".agents", "skills", "manual-resource-skill");
  await mkdir(path.join(skillDir, "agents"), { recursive: true });
  await mkdir(path.join(skillDir, "references"), { recursive: true });
  await mkdir(path.join(skillDir, "scripts"), { recursive: true });
  await mkdir(path.join(skillDir, "assets"), { recursive: true });
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: manual-resource-skill",
    "description: Manual resource skill. Use only when explicitly mentioned.",
    "---",
    "",
    "# Manual Resource Skill",
    "",
    "For details, read references/guide.md."
  ].join("\n"), "utf8");
  await writeFile(path.join(skillDir, "agents", "openai.yaml"), [
    "policy:",
    "  allow_implicit_invocation: false"
  ].join("\n"), "utf8");
  await writeFile(path.join(skillDir, "references", "guide.md"), "manual reference payload\n", "utf8");
  await writeFile(path.join(skillDir, "scripts", "check.sh"), "echo check\n", "utf8");
  await writeFile(path.join(skillDir, "assets", "template.txt"), "template payload\n", "utf8");

  const mock = await createActivatedSkillResourceChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";
  process.env.HATCH_SKILL_ROOTS = path.join(workspace, ".agents", "skills");
  delete process.env.HATCH_TS_SKILLS_ROOT;

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  const session = new LocalHarnessSession({
    serverUrl,
    workspace,
    conversationId: "conv_activated_resource"
  });

  await session.connect();
  try {
    const first = await session.run("Use $manual-resource-skill.");
    const second = await session.run("Use $manual-resource-skill to continue by reading the referenced guide.");

    assert.match(first.finalText, /Manual resource skill activated/);
    assert.match(second.finalText, /Manual reference read through activated skill root/);
    assert.equal(mock.requests.length, 3);
    assert.ok(first.events.some((event) => (
      event.type === "skill.activated"
      && event.name === "manual-resource-skill"
      && event.invocation_type === "explicit"
      && event.reason === "explicit_mention"
      && event.resource_paths.includes("references/guide.md")
    )));
    assert.equal(first.events.filter((event) => event.type === "tool_call.delta").length, 0);
    assert.equal(second.events.filter((event) => event.type === "tool_call.request").length, 0);
    assert.ok(second.events.some((event) => (
      event.type === "tool_call.delta"
      && event.name === "file_read"
      && event.locality === "server"
      && event.status === "completed"
      && String(event.result?.content ?? "").includes("manual reference payload")
    )));
  } finally {
    session.close();
    await mock.close();
  }

  const events = await new RuntimeStore(dataDir).readEvents();
  const activation = events.find((event) => event.type === "skill.activated" && event.name === "manual-resource-skill");
  assert.ok(activation && activation.type === "skill.activated");
  assert.equal(activation.scope, "user");
  assert.ok(events.some((event) => (
    event.type === "tool.call"
    && event.conversation_id === "conv_activated_resource"
    && event.name === "file_read"
    && event.status === "completed"
    && typeof event.result === "object"
    && event.result !== null
    && String((event.result as Record<string, unknown>).content ?? "").includes("manual reference payload")
  )));
  assert.deepEqual(activation.resource_paths?.sort(), [
    "assets/template.txt",
    "references/guide.md",
    "scripts/check.sh"
  ]);
  assert.equal(activation.resource_manifest_truncated, false);
  assert.ok(events.some((event) => (
    event.type === "runtime.event"
    && typeof event.event === "object"
    && event.event !== null
    && (event.event as Record<string, unknown>).type === "skill.activated"
    && (event.event as Record<string, unknown>).name === "manual-resource-skill"
  )));
});

test.skip("explicitly activated skill instructions are injected fully and still readable on demand", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const skillDir = path.join(workspace, ".agents", "skills", "large-explicit-skill");
  const trailer = "FULL_SKILL_TRAILER_SHOULD_ONLY_APPEAR_AFTER_FILE_READ";
  await mkdir(skillDir, { recursive: true });
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: large-explicit-skill",
    "description: Large explicit skill. Use only when explicitly mentioned.",
    "---",
    "",
    "# Large Explicit Skill",
    "",
    "VISIBLE_START",
    "x".repeat(9000),
    trailer
  ].join("\n"), "utf8");

  const mock = await createFullExplicitSkillChatCompletionsServer(trailer);
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";
  process.env.HATCH_SKILL_ROOTS = path.join(workspace, ".agents", "skills");
  delete process.env.HATCH_TS_SKILLS_ROOT;

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  try {
    const result = await runLocalHarness({
      serverUrl,
      workspace,
      prompt: "Use $large-explicit-skill and then read its full SKILL.md."
    });

    assert.match(result.finalText, /Large explicit skill read completely/);
    assert.equal(mock.requests.length, 2);
    assert.ok(result.events.some((event) => (
      event.type === "tool_call.delta"
      && event.name === "file_read"
      && event.locality === "server"
      && event.status === "completed"
      && String(event.result?.content ?? "").includes(trailer)
    )));
  } finally {
    await mock.close();
  }
});

test.skip("relative activated skill resource paths fail when multiple active skills match", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  for (const name of ["first-resource-skill", "second-resource-skill"]) {
    const skillDir = path.join(workspace, ".agents", "skills", name);
    await mkdir(path.join(skillDir, "references"), { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), [
      "---",
      `name: ${name}`,
      `description: ${name}. Use only when explicitly mentioned.`,
      "---",
      "",
      `# ${name}`,
      "",
      "Read references/guide.md for details."
    ].join("\n"), "utf8");
    await writeFile(path.join(skillDir, "references", "guide.md"), `${name} guide\n`, "utf8");
  }

  const mock = await createAmbiguousRelativeSkillResourceChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";
  process.env.HATCH_SKILL_ROOTS = path.join(workspace, ".agents", "skills");
  delete process.env.HATCH_TS_SKILLS_ROOT;

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  try {
    await assert.rejects(runLocalHarness({
      serverUrl,
      workspace,
      prompt: "Use $first-resource-skill and $second-resource-skill, then read references/guide.md."
    }), /Ambiguous skill resource path: references\/guide\.md/);
  } finally {
    await mock.close();
  }

  const events = await new RuntimeStore(dataDir).readEvents();
  assert.equal(events.some((event) => (
    event.type === "runtime.event"
    && typeof event.event === "object"
    && event.event !== null
    && (event.event as Record<string, unknown>).type === "tool_call.request"
  )), false);
  assert.ok(events.some((event) => (
    event.type === "runtime.event"
    && typeof event.event === "object"
    && event.event !== null
    && (event.event as Record<string, unknown>).type === "tool_call.delta"
    && (event.event as Record<string, unknown>).status === "failed"
  )));
});

test.skip("re-mentioned skills refresh from current files within a fixed session catalog", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const skillDir = path.join(workspace, ".agents", "skills", "refresh-skill");
  const skillPath = path.join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await writeFile(skillPath, [
    "---",
    "name: refresh-skill",
    "description: Refresh skill. Use when testing activated skill refresh.",
    "---",
    "",
    "# Refresh Skill Version One"
  ].join("\n"), "utf8");

  const mock = await createActivatedSkillRefreshChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";
  process.env.HATCH_SKILL_ROOTS = path.join(workspace, ".agents", "skills");
  delete process.env.HATCH_TS_SKILLS_ROOT;

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  const session = new LocalHarnessSession({
    serverUrl,
    workspace,
    conversationId: "conv_skill_refresh"
  });

  await session.connect();
  try {
    const first = await session.run("Use $refresh-skill.");
    await writeFile(skillPath, [
      "---",
      "name: refresh-skill",
      "description: Refresh skill. Use when testing activated skill refresh.",
      "---",
      "",
      "# Refresh Skill Version Two"
    ].join("\n"), "utf8");
    const second = await session.run("Use $refresh-skill again.");

    assert.match(first.finalText, /refresh one/);
    assert.match(second.finalText, /refresh two/);
    assert.equal(mock.requests.length, 2);
  } finally {
    session.close();
    await mock.close();
  }
});

test("compaction transcript preserves prior checkpoint summaries for later handoff summaries", () => {
  const previousSummary = `${SUMMARY_PREFIX}\nPrevious compacted context that must survive.`;
  const runtimeContext = `${RUNTIME_CONTEXT_PREFIX}\nserver-rendered skill catalog`;
  const projectDocsContext = "# AGENTS.md instructions for /workspace\n\n<INSTRUCTIONS>\nproject-only instructions\n</INSTRUCTIONS>";
  const messages = [
    { role: "user", content: "retained user before first compact" },
    { role: "user", content: previousSummary },
    { role: "user", content: runtimeContext },
    { role: "user", content: projectDocsContext },
    { role: "assistant", content: "assistant work after first compact" },
    { role: "user", content: "new user after first compact" }
  ];

  const transcript = runtimeMessagesTranscript(messages);
  assert.match(transcript, /Previous compacted context that must survive/);
  assert.doesNotMatch(transcript, /server-rendered skill catalog/);
  assert.doesNotMatch(transcript, /project-only instructions/);

  const replacement = buildCompactedHistory(messages, `${SUMMARY_PREFIX}\nSecond compacted summary.`);
  assert.deepEqual(replacement, [
    { role: "user", content: "retained user before first compact" },
    { role: "user", content: "new user after first compact" },
    { role: "user", content: `${SUMMARY_PREFIX}\nSecond compacted summary.` }
  ]);
});

test("compaction checkpoints replace model-visible history while preserving append-only events", async () => {
  const dataDir = await tempWorkspace();
  const store = new RuntimeStore(dataDir);
  await store.append({
    type: "message.created",
    conversation_id: "conv_compaction_replay",
    run_id: "old_1",
    role: "user",
    content: "old user survives only in the append log"
  });
  await store.append({
    type: "message.created",
    conversation_id: "conv_compaction_replay",
    run_id: "old_1",
    role: "assistant",
    content: "old assistant should not be model-visible after checkpoint"
  });
  await store.append({
    type: "conversation.compacted",
    conversation_id: "conv_compaction_replay",
    run_id: "compact_1",
    trigger: "auto",
    phase: "pre_turn",
    reason: "context_limit",
    message: `${SUMMARY_PREFIX}\nsummary one`,
    replacement_history: [
      { role: "user", content: "recent retained user" },
      { role: "user", content: `${SUMMARY_PREFIX}\nsummary one` }
    ],
    window_number: 1,
    first_window_id: "first-window",
    window_id: "window-1"
  });
  await store.append({
    type: "message.created",
    conversation_id: "conv_compaction_replay",
    run_id: "new_1",
    role: "user",
    content: "new user after checkpoint"
  });

  const visible = await store.readConversation("conv_compaction_replay");
  assert.deepEqual(visible, [
    { role: "user", content: "recent retained user" },
    { role: "user", content: `${SUMMARY_PREFIX}\nsummary one` },
    { role: "user", content: "new user after checkpoint" }
  ]);
  const events = await store.readEvents();
  assert.ok(events.some((event) => event.type === "message.created" && event.content.includes("old assistant")));
  assert.ok(events.some((event) => event.type === "conversation.compacted" && event.replacement_history?.length === 2));
});

test("multiple compaction checkpoints replay from the latest replacement history and preserve window links", async () => {
  const dataDir = await tempWorkspace();
  const store = new RuntimeStore(dataDir);
  await store.append({
    type: "message.created",
    conversation_id: "conv_multi_compact",
    run_id: "old_1",
    role: "user",
    content: "original user before first checkpoint"
  });
  await store.append({
    type: "conversation.compacted",
    conversation_id: "conv_multi_compact",
    run_id: "compact_1",
    trigger: "auto",
    phase: "pre_turn",
    reason: "context_limit",
    message: `${SUMMARY_PREFIX}\nsummary one`,
    replacement_history: [
      { role: "user", content: "retained after first checkpoint" },
      { role: "user", content: `${SUMMARY_PREFIX}\nsummary one` }
    ],
    window_number: 1,
    first_window_id: "first-window",
    window_id: "window-1"
  });
  await store.append({
    type: "message.created",
    conversation_id: "conv_multi_compact",
    run_id: "between_1",
    role: "assistant",
    content: "assistant between checkpoints"
  });
  await store.append({
    type: "conversation.compacted",
    conversation_id: "conv_multi_compact",
    run_id: "compact_2",
    trigger: "auto",
    phase: "mid_turn",
    reason: "context_limit",
    message: `${SUMMARY_PREFIX}\nsummary two`,
    replacement_history: [
      { role: "user", content: "retained after second checkpoint" },
      { role: "user", content: `${SUMMARY_PREFIX}\nsummary two` }
    ],
    window_number: 2,
    first_window_id: "first-window",
    previous_window_id: "window-1",
    window_id: "window-2"
  });
  await store.append({
    type: "message.created",
    conversation_id: "conv_multi_compact",
    run_id: "after_2",
    role: "user",
    content: "new user after second checkpoint"
  });

  assert.deepEqual(await store.readConversation("conv_multi_compact"), [
    { role: "user", content: "retained after second checkpoint" },
    { role: "user", content: `${SUMMARY_PREFIX}\nsummary two` },
    { role: "user", content: "new user after second checkpoint" }
  ]);
  assert.deepEqual(await store.readCompactionState("conv_multi_compact"), {
    window_number: 2,
    first_window_id: "first-window",
    previous_window_id: "window-1",
    window_id: "window-2"
  });

  const events = await store.readEvents();
  assert.equal(events.filter((event) => event.type === "conversation.compacted").length, 2);
  assert.ok(events.some((event) => event.type === "message.created" && event.content.includes("assistant between checkpoints")));
});

test("pre-turn auto compaction appends a checkpoint and sends compacted history to the model", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const store = new RuntimeStore(dataDir);
  await store.append({
    type: "message.created",
    conversation_id: "conv_pre_compact",
    run_id: "old_pre",
    role: "user",
    content: `old pre-turn user ${"x".repeat(240)}`
  });
  await store.append({
    type: "message.created",
    conversation_id: "conv_pre_compact",
    run_id: "old_pre",
    role: "assistant",
    content: "old assistant payload should be summarized away"
  });

  const mock = await createPreTurnCompactionChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";
  process.env.HATCH_AUTO_COMPACT_LIMIT_TOKENS = "10";

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  const session = new LocalHarnessSession({
    serverUrl,
    workspace,
    conversationId: "conv_pre_compact"
  });

  await session.connect();
  try {
    const result = await session.run("current user after pre-turn compact");

    assert.match(result.finalText, /pre-turn final/);
    assert.ok(result.events.some((event) => event.type === "turn.state" && event.status === "compacting"));
    assert.ok(result.events.some((event) => event.type === "session.compacted" && event.phase === "pre_turn"));
    assert.equal(mock.requests.length, 2);
    assert.ok(mock.requests.every((request) => request.model === "kimi-k2.6"));
    assert.ok(mock.requests.every((request) => request.temperature === 0.6));
    assert.ok(mock.requests.every((request) => request.thinking?.type === "disabled"));
    const normalMessages = mock.requests[1]?.messages ?? [];
    assert.ok(normalMessages.some((message: Record<string, unknown>) => String(message.content ?? "").includes(SUMMARY_PREFIX)));
    assert.ok(normalMessages.some((message: Record<string, unknown>) => String(message.content ?? "").includes("current user after pre-turn compact")));
    assert.ok(!normalMessages.some((message: Record<string, unknown>) => String(message.content ?? "").includes("old assistant payload")));
  } finally {
    session.close();
    await mock.close();
  }

  const events = await new RuntimeStore(dataDir).readEvents();
  assert.ok(events.some((event) => event.type === "message.created" && event.content.includes("old assistant payload")));
  assert.ok(events.some((event) => event.type === "conversation.compacted" && event.phase === "pre_turn"));
  const visible = await new RuntimeStore(dataDir).readConversation("conv_pre_compact");
  assert.ok(visible.some((message) => String(message.content ?? "").includes(SUMMARY_PREFIX)));
  assert.ok(!visible.some((message) => String(message.content ?? "").includes("old assistant payload")));
});

test("manual /compact runs a standalone compaction turn without a normal agent response", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const store = new RuntimeStore(dataDir);
  await store.append({
    type: "message.created",
    conversation_id: "conv_manual_compact",
    run_id: "old_manual",
    role: "user",
    content: "manual compact prior user"
  });
  await store.append({
    type: "message.created",
    conversation_id: "conv_manual_compact",
    run_id: "old_manual",
    role: "assistant",
    content: "manual compact prior assistant"
  });

  const mock = await createManualCompactionChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  const session = new LocalHarnessSession({
    serverUrl,
    workspace,
    conversationId: "conv_manual_compact"
  });

  await session.connect();
  try {
    const result = await session.run("/compact");

    assert.equal(result.finalText, "Compaction complete.");
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0]?.model, "kimi-k2.6");
    assert.equal(mock.requests[0]?.temperature, 0.6);
    assert.equal(mock.requests[0]?.thinking?.type, "disabled");
    assert.ok(result.events.some((event) => event.type === "session.compacted" && event.trigger === "manual" && event.phase === "standalone_turn"));
    assert.ok(result.events.some((event) => event.type === "turn.state" && event.status === "compacting"));
  } finally {
    session.close();
    await mock.close();
  }

  const visible = await new RuntimeStore(dataDir).readConversation("conv_manual_compact");
  assert.deepEqual(visible, [
    { role: "user", content: "manual compact prior user" },
    { role: "user", content: `${SUMMARY_PREFIX}\nManual compacted summary.` }
  ]);
});

test("mid-turn auto compaction checkpoints tool context before continuing the tool loop", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const mock = await createMidTurnCompactionChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";
  process.env.HATCH_AUTO_COMPACT_LIMIT_TOKENS = "20";

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  try {
    const result = await runLocalHarness({
      serverUrl,
      workspace,
      conversationId: "conv_mid_compact",
      prompt: "Search web first, then continue after compaction."
    });

    assert.match(result.finalText, /mid-turn final/);
    assert.ok(result.events.some((event) => event.type === "tool_call.delta" && event.name === "web.search" && event.status === "completed"));
    assert.ok(result.events.some((event) => event.type === "session.compacted" && event.phase === "mid_turn"));
    assert.equal(mock.requests.length, 3);
    const finalMessages = mock.requests[2]?.messages ?? [];
    assert.ok(finalMessages.some((message: Record<string, unknown>) => String(message.content ?? "").includes(SUMMARY_PREFIX)));
    assert.ok(!finalMessages.some((message: Record<string, unknown>) => message.role === "tool"));
  } finally {
    await mock.close();
  }

  const events = await new RuntimeStore(dataDir).readEvents();
  assert.ok(events.some((event) => event.type === "conversation.compacted" && event.phase === "mid_turn"));
});

test("mid-turn compaction waits for a complete assistant tool-call batch", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const mock = await createMultiToolBatchCompactionChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";
  process.env.HATCH_AUTO_COMPACT_LIMIT_TOKENS = "1";

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  try {
    const result = await runLocalHarness({
      serverUrl,
      workspace,
      conversationId: "conv_multi_tool_batch_compact",
      prompt: "Run both server tools before continuing."
    });

    assert.match(result.finalText, /multi-tool batch final/);
    assert.equal(result.events.filter((event) => event.type === "session.compacted" && event.phase === "mid_turn").length, 1);
    assert.ok(result.events.some((event) => event.type === "tool_call.delta" && event.name === "web.search" && event.status === "completed"));
    assert.ok(result.events.some((event) => event.type === "tool_call.delta" && event.name === "api.request" && event.status === "completed"));
    assert.equal(mock.requests.length, 3);
  } finally {
    await mock.close();
  }

  const events = await new RuntimeStore(dataDir).readEvents();
  assert.equal(events.filter((event) => event.type === "conversation.compacted" && event.phase === "mid_turn").length, 1);
});

test("chat completions runtime fixes the skills catalog for the WebSocket session", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const skillsRoot = path.join(workspace, ".agents", "skills");
  await mkdir(path.join(skillsRoot, "first-skill"), { recursive: true });
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await writeFile(path.join(skillsRoot, "first-skill", "SKILL.md"), [
    "---",
    "name: first-skill",
    "description: First skill. Use when testing first-turn skill catalog injection.",
    "---",
    "",
    "# First"
  ].join("\n"), "utf8");

  const mock = await createFinalOnlyChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";
  process.env.HATCH_SKILL_ROOTS = skillsRoot;
  delete process.env.HATCH_TS_SKILLS_ROOT;

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  const session = new LocalHarnessSession({
    serverUrl,
    workspace,
    conversationId: "conv_per_turn_skills"
  });

  await session.connect();
  try {
    const first = await session.run("Inspect the available skills catalog.");
    await mkdir(path.join(skillsRoot, "second-skill"), { recursive: true });
    await writeFile(path.join(skillsRoot, "second-skill", "SKILL.md"), [
      "---",
      "name: second-skill",
      "description: Second skill. Use when testing second-turn skill catalog injection.",
      "---",
      "",
      "# Second"
    ].join("\n"), "utf8");
    const second = await session.run("Inspect the same session skills catalog.");

    assert.match(first.finalText, /final turn 1/);
    assert.match(second.finalText, /final turn 2/);
    assert.equal(mock.requests.length, 2);
    const firstSkillCatalog = runtimeContextContent(mock.requests[0] ?? {}, /AVAILABLE SKILLS/);
    const secondSkillCatalog = runtimeContextContent(mock.requests[1] ?? {}, /AVAILABLE SKILLS/);
    assert.deepEqual(stableModelPrefix(mock.requests[0] ?? {}), stableModelPrefix(mock.requests[1] ?? {}));
    assert.match(firstSkillCatalog, /<skills_instructions>/);
    assert.match(firstSkillCatalog, /<\/skills_instructions>/);
    assert.match(firstSkillCatalog, /first-skill/);
    assert.doesNotMatch(firstSkillCatalog, /second-skill/);
    assert.match(secondSkillCatalog, /first-skill/);
    assert.doesNotMatch(secondSkillCatalog, /second-skill/);
    assert.equal(firstSkillCatalog, secondSkillCatalog);
    assert.ok(Array.isArray(mock.requests[1]?.messages));
    assert.deepEqual(mock.requests[1]?.messages
      .filter((message: Record<string, unknown>) => message.role !== "system")
      .filter((message: Record<string, unknown>) => !String(message.content ?? "").startsWith(RUNTIME_CONTEXT_PREFIX))
      .map((message: Record<string, unknown>) => message.role), ["user", "assistant", "user"]);
  } finally {
    session.close();
    await mock.close();
  }
});

test("chat completions runtime injects codex AGENTS.md project instructions", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const configDir = await tempWorkspace();
  const nested = path.join(workspace, "packages", "app");
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(workspace, "hatch-root.marker"), "", "utf8");
  await writeFile(path.join(workspace, "AGENTS.md"), "root project instructions", "utf8");
  await writeFile(path.join(workspace, "packages", "CODEX.md"), "package fallback instructions", "utf8");
  await writeFile(path.join(nested, "AGENTS.md"), "ignored nested AGENTS instructions", "utf8");
  await writeFile(path.join(nested, "AGENTS.override.md"), "nested override instructions", "utf8");
  const configPath = path.join(configDir, "config.toml");
  await writeFile(configPath, [
    'project_root_markers = ["hatch-root.marker"]',
    'project_doc_fallback_filenames = ["CODEX.md"]'
  ].join("\n"), "utf8");
  process.env.HATCH_SKILLS_CONFIG = configPath;

  const mock = await createFinalOnlyChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";
  process.env.HATCH_SKILL_ROOTS = path.join(workspace, ".agents", "skills");
  delete process.env.HATCH_TS_SKILLS_ROOT;

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  const session = new LocalHarnessSession({
    serverUrl,
    workspace: nested,
    conversationId: "conv_project_docs"
  });

  await session.connect();
  try {
    const result = await session.run("Inspect the project instructions.");

    assert.match(result.finalText, /final turn 1/);
    assert.equal(mock.requests.length, 1);
    const projectDocs = projectInstructionsContent(mock.requests[0] ?? {});
    assert.ok(projectDocs.startsWith(`# AGENTS.md instructions for ${nested}`));
    assert.match(projectDocs, /<INSTRUCTIONS>/);
    assert.match(projectDocs, /root project instructions/);
    assert.match(projectDocs, /package fallback instructions/);
    assert.match(projectDocs, /nested override instructions/);
    assert.doesNotMatch(projectDocs, /ignored nested AGENTS instructions/);
    assert.ok(projectDocs.indexOf("root project instructions") < projectDocs.indexOf("package fallback instructions"));
    assert.ok(projectDocs.indexOf("package fallback instructions") < projectDocs.indexOf("nested override instructions"));
    assert.ok(Array.isArray(mock.requests[0]?.messages));
    assert.deepEqual(mock.requests[0]?.messages
      .filter((message: Record<string, unknown>) => message.role !== "system")
      .filter((message: Record<string, unknown>) => !String(message.content ?? "").startsWith("# AGENTS.md instructions"))
      .filter((message: Record<string, unknown>) => !String(message.content ?? "").startsWith(RUNTIME_CONTEXT_PREFIX))
      .map((message: Record<string, unknown>) => message.role), ["user"]);
  } finally {
    session.close();
    await mock.close();
  }
});

test("chat completions runtime injects stable local workspace context without current-turn paths", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const mock = await createFinalOnlyChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  try {
    const result = await runLocalHarness({
      serverUrl,
      workspace,
      prompt: "请先读取合同文件 legal-samples/acme-analytics-saas-agreement.md，再总结风险。交易金额约 25 万美元/年。"
    });

    assert.match(result.finalText, /final turn 1/);
    assert.equal(mock.requests.length, 1);
    const workspaceContext = runtimeContextContent(mock.requests[0] ?? {}, /LOCAL WORKSPACE/);
    const stablePrefix = stableModelPrefix(mock.requests[0] ?? {})
      .map((message) => message.content)
      .join("\n");
    const toolDescriptions = (mock.requests[0]?.tools ?? [])
      .map((tool: Record<string, any>) => String(tool.function?.description ?? ""))
      .join("\n");
    assert.match(workspaceContext, new RegExp(escapeRegExp(workspace)));
    assert.match(workspaceContext, /All relative local file paths resolve under this exact workspace root/);
    assert.doesNotMatch(workspaceContext, /legal-samples\/acme-analytics-saas-agreement\.md/);
    assert.doesNotMatch(stablePrefix, /legal-samples\/acme-analytics-saas-agreement\.md/);
    assert.doesNotMatch(stablePrefix, /file_read .*before.*file_search/i);
    assert.doesNotMatch(toolDescriptions, /file_read .*before.*file_search/i);
    assert.doesNotMatch(workspaceContext, /万美元\/年/);
  } finally {
    await mock.close();
  }
});

test("chat completions runtime enforces exact path file_read before file_search outside the prompt", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const contractPath = path.join(workspace, "legal-samples", "acme-analytics-saas-agreement.md");
  await mkdir(path.dirname(contractPath), { recursive: true });
  await writeFile(contractPath, "Contract body for runtime path policy.\n", "utf8");
  const mock = await createDirectReadGuardChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  try {
    const result = await runLocalHarness({
      serverUrl,
      workspace,
      prompt: "请先读取合同文件 legal-samples/acme-analytics-saas-agreement.md，再总结风险。"
    });

    assert.match(result.finalText, /Exact file read observed/);
    assert.equal(mock.requests.length, 3);
    assert.ok(mock.requests[1]?.messages?.some((message: Record<string, unknown>) => (
      message.role === "tool"
      && message.tool_call_id === "call_bad_search"
      && String(message.content ?? "").includes("direct_read_required")
      && String(message.content ?? "").includes("legal-samples/acme-analytics-saas-agreement.md")
    )));
    assert.ok(mock.requests[2]?.messages?.some((message: Record<string, unknown>) => (
      message.role === "tool"
      && message.tool_call_id === "call_exact_read"
      && String(message.content ?? "").includes("Contract body for runtime path policy")
    )));
    assert.ok(result.events.some((event) => event.type === "tool_call.delta"
      && event.name === "fs.search"
      && event.status === "completed"
      && event.result?.code === "direct_read_required"));
    assert.ok(result.events.some((event) => event.type === "tool_call.delta"
      && event.name === "fs.read"
      && event.status === "completed"));
  } finally {
    await mock.close();
  }
});

test("chat completions runtime filters client-local function tools from hello capability", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const mock = await createFinalOnlyChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  try {
    const result = await runLocalHarness({
      serverUrl,
      workspace,
      prompt: "Just answer.",
      localTools: ["fs.read"]
    });

    assert.match(result.finalText, /final turn 1/);
    const toolNames = (mock.requests[0]?.tools ?? [])
      .map((tool: Record<string, any>) => tool.function?.name)
      .filter(Boolean);
    assert.ok(toolNames.includes("web_search"));
    assert.ok(toolNames.includes("file_read"));
    assert.ok(toolNames.includes("file_list"));
    assert.ok(!toolNames.includes("file_search"));
    assert.ok(!toolNames.includes("file_write"));
    assert.ok(!toolNames.includes("git_diff"));
    assert.ok(!toolNames.includes("shell_exec"));
  } finally {
    await mock.close();
  }
});

test("shell_exec auto-permission calls include model justification and tool arguments", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const mock = await createShellJustificationChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  try {
    const result = await runLocalHarness({
      serverUrl,
      workspace,
      prompt: "Run the shell command if appropriate.",
      allowShell: true,
      approveTool: (request) => request.name !== "shell.exec"
    });

    assert.match(result.finalText, /shell output observed/i);
    assert.equal(mock.requests.length, 2);
    assert.deepEqual(result.events.filter((event) => event.type === "approval.request" || event.type === "approval.result"), []);
    const shellRequest = result.events.find((event) => event.type === "tool_call.request" && event.name === "shell.exec");
    assert.ok(shellRequest && shellRequest.type === "tool_call.request");
    assert.equal(shellRequest.arguments.command, "printf hatch");
    assert.equal(shellRequest.approval, "auto");
    assert.ok(result.events.some((event) => event.type === "tool_call.delta" && event.name === "shell.exec" && event.status === "completed"));
  } finally {
    await mock.close();
  }
});

test("chat completions runtime brokers local filesystem function tools to the client", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  await writeFile(path.join(workspace, "notes.txt"), "Hatch local broker test.\n", "utf8");

  const mock = await createMockLocalToolChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  try {
    const result = await runLocalHarness({
      serverUrl,
      workspace,
      prompt: "Find Hatch in local files."
    });

    assert.match(result.finalText, /Local filesystem tool result observed/);
    assert.deepEqual(result.events.filter((event) => event.type === "tool_call.request").map((event) => event.name), [
      "fs.search"
    ]);
    assert.ok(result.events.some((event) => event.type === "tool_call.delta" && event.name === "fs.search" && event.locality === "client" && event.status === "requested"));
    assert.ok(result.events.some((event) => event.type === "tool_call.delta" && event.name === "fs.search" && event.locality === "client" && event.status === "completed"));
    assert.equal(mock.requests.length, 2);
    assert.ok(mock.requests[0]?.tools?.some((tool: Record<string, any>) => tool.function?.name === "file_search"));
    assert.ok(mock.requests[1]?.messages?.some((message: Record<string, unknown>) => (
      message.role === "tool"
      && String(message.content ?? "").includes("notes.txt")
    )));
  } finally {
    await mock.close();
  }
});

test("chat completions runtime completes when finish_reason arrives before SSE connection close", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const openResponses = new Set<http.ServerResponse>();
  const mockServer = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    openResponses.add(res);
    res.once("close", () => openResponses.delete(res));
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    res.write(`data: ${JSON.stringify({
      choices: [{
        index: 0,
        delta: { role: "assistant", content: "finish reason observed" },
        finish_reason: "stop"
      }]
    })}\n\n`);
    // Deliberately leave the SSE connection open like a non-conforming
    // OpenAI-compatible provider; the adapter must already have completed.
  });
  await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const address = mockServer.address();
  if (!address || typeof address === "string") throw new Error("Expected mock server to listen on a TCP port");

  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";
  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  try {
    const result = await Promise.race([
      runLocalHarness({ serverUrl, workspace, prompt: "Return a short final response." }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("adapter waited for SSE close")), 1500))
    ]);
    assert.match(result.finalText, /finish reason observed/);
  } finally {
    for (const response of openResponses) response.destroy();
    await new Promise<void>((resolve, reject) => mockServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("chat completions runtime replays prior tool call chain on later turns", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const mock = await createToolHistoryReplayChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  const session = new LocalHarnessSession({
    serverUrl,
    workspace,
    conversationId: "conv_tool_history_replay"
  });

  await session.connect();
  try {
    const first = await session.run("Use web search once.");
    const second = await session.run("Continue from the previous tool result.");

    assert.match(first.finalText, /first turn complete/);
    assert.match(second.finalText, /second turn saw tool history/);
    assert.equal(mock.requests.length, 3);
  } finally {
    session.close();
    await mock.close();
  }

  const visible = await new RuntimeStore(dataDir).readConversation("conv_tool_history_replay");
  assert.ok(visible.some((message) => message.role === "assistant" && message.tool_calls?.[0]?.id === "call_history_web"));
  assert.ok(visible.some((message) => message.role === "tool" && message.tool_call_id === "call_history_web"));
});

test.skip("activated skill allowed-tools are preserved while local tools run with auto permission", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const skillDir = path.join(workspace, ".agents", "skills", "allowed-tools-skill");
  await mkdir(skillDir, { recursive: true });
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: allowed-tools-skill",
    "description: Allowed tools skill. Use when testing skill tool preapproval.",
    "allowed-tools: Write Bash(git:*)",
    "---",
    "",
    "# Allowed Tools Skill",
    "",
    "Write the requested file and inspect git when needed."
  ].join("\n"), "utf8");

  const mock = await createAllowedToolsChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";
  process.env.HATCH_SKILL_ROOTS = path.join(workspace, ".agents", "skills");
  delete process.env.HATCH_TS_SKILLS_ROOT;

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  try {
    const result = await runLocalHarness({
      serverUrl,
      workspace,
      prompt: "Use $allowed-tools-skill to write the file and check git.",
      allowShell: true
    });

    assert.match(result.finalText, /Allowed tools completed/);
    assert.deepEqual(result.events.filter((event) => event.type === "tool_call.request").map((event) => `${event.name}:${event.approval}`), [
      "fs.write:auto",
      "shell.exec:auto"
    ]);
    assert.deepEqual(result.events.filter((event) => event.type === "approval.request" || event.type === "approval.result"), []);
    assert.ok(result.events.some((event) => event.type === "tool_call.delta" && event.name === "fs.write" && event.approval === "auto" && event.status === "requested"));
    assert.ok(result.events.some((event) => event.type === "tool_call.delta" && event.name === "shell.exec" && event.approval === "auto" && event.status === "requested"));
  } finally {
    await mock.close();
  }

  assert.match(await readFile(path.join(workspace, "allowed.md"), "utf8"), /written without ask/);
  const events = await new RuntimeStore(dataDir).readEvents();
  const activation = events.find((event) => event.type === "skill.activated" && event.name === "allowed-tools-skill");
  assert.ok(activation && activation.type === "skill.activated");
  assert.equal(activation.allowed_tools, "Write Bash(git:*)");
});

test("chat completions runtime emits implicit skill invocation events for skill scripts", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const skillDir = path.join(workspace, ".agents", "skills", "script-invocation-skill");
  const scriptsDir = path.join(skillDir, "scripts");
  await mkdir(scriptsDir, { recursive: true });
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: script-invocation-skill",
    "description: Use when testing implicit skill invocation for scripts.",
    "---",
    "",
    "# Script Invocation Skill"
  ].join("\n"), "utf8");
  await writeFile(path.join(scriptsDir, "check.sh"), "printf 'script ok\\n'\n", "utf8");

  const command = "bash .agents/skills/script-invocation-skill/scripts/check.sh";
  const mock = await createImplicitSkillInvocationChatCompletionsServer(command);
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";
  process.env.HATCH_SKILL_ROOTS = path.join(workspace, ".agents", "skills");
  delete process.env.HATCH_TS_SKILLS_ROOT;

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  try {
    const result = await runLocalHarness({
      serverUrl,
      workspace,
      prompt: "Run the relevant skill script.",
      allowShell: true
    });

    assert.match(result.finalText, /Implicit invocation complete/);
    const skillEvent = result.events.find((event) => event.type === "skill.invoked");
    assert.ok(skillEvent && skillEvent.type === "skill.invoked");
    assert.equal(skillEvent.name, "script-invocation-skill");
    assert.equal(skillEvent.reason, "script_run");
    assert.equal(skillEvent.invocation_type, "implicit");
    assert.equal(skillEvent.trigger.command, command);
  } finally {
    await mock.close();
  }

  const events = await new RuntimeStore(dataDir).readEvents();
  const invoked = events.find((event) => event.type === "skill.invoked" && event.name === "script-invocation-skill");
  assert.ok(invoked && invoked.type === "skill.invoked");
  assert.equal(invoked.reason, "script_run");
  assert.equal(invoked.trigger.command, command);
});

test("chat completions runtime emits implicit skill invocation events for skill document reads", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const skillDir = path.join(workspace, ".agents", "skills", "doc-invocation-skill");
  await mkdir(skillDir, { recursive: true });
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: doc-invocation-skill",
    "description: Use when testing implicit skill invocation for SKILL.md reads.",
    "---",
    "",
    "# Doc Invocation Skill"
  ].join("\n"), "utf8");

  const skillPath = ".agents/skills/doc-invocation-skill/SKILL.md";
  const mock = await createImplicitSkillDocReadChatCompletionsServer(skillPath);
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";
  process.env.HATCH_SKILL_ROOTS = path.join(workspace, ".agents", "skills");
  delete process.env.HATCH_TS_SKILLS_ROOT;

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  try {
    const result = await runLocalHarness({
      serverUrl,
      workspace,
      prompt: "Read the relevant skill document."
    });

    assert.match(result.finalText, /Implicit doc invocation complete/);
    const skillEvent = result.events.find((event) => event.type === "skill.invoked");
    assert.ok(skillEvent && skillEvent.type === "skill.invoked");
    assert.equal(skillEvent.name, "doc-invocation-skill");
    assert.equal(skillEvent.reason, "skill_doc_read");
    assert.equal(skillEvent.trigger.path, skillPath);
  } finally {
    await mock.close();
  }

  const events = await new RuntimeStore(dataDir).readEvents();
  const invoked = events.find((event) => event.type === "skill.invoked" && event.name === "doc-invocation-skill");
  assert.ok(invoked && invoked.type === "skill.invoked");
  assert.equal(invoked.reason, "skill_doc_read");
  assert.equal(invoked.trigger.path, skillPath);
});

test("chat completions runtime emits failed tool_call.delta for unknown model tools", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const mock = await createMockUnknownToolChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  try {
    await assert.rejects(runLocalHarness({
      serverUrl,
      workspace,
      prompt: "Call an unsupported tool."
    }), /Unknown Chat Completions tool: unknown_tool/);

    const events = await new RuntimeStore(dataDir).readEvents();
    assert.ok(events.some((event) => (
      event.type === "runtime.event"
      && typeof event.event === "object"
      && event.event !== null
      && (event.event as Record<string, unknown>).type === "tool_call.delta"
      && (event.event as Record<string, unknown>).name === "unknown_tool"
      && (event.event as Record<string, unknown>).status === "failed"
      && ((event.event as Record<string, unknown>).error as Record<string, unknown> | undefined)?.code === "invalid_tool_call"
    )));
    assert.ok(!events.some((event) => (
      event.type === "runtime.event"
      && typeof event.event === "object"
      && event.event !== null
      && (event.event as Record<string, unknown>).type === "tool_call.request"
    )));
  } finally {
    await mock.close();
  }
});

test("chat completions runtime executes configured MCP tools on the server event stream", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const mcpRequests: Array<Record<string, any>> = [];
  const mcpServer = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const body = JSON.parse(await readRequestBody(req)) as Record<string, any>;
      mcpRequests.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{ type: "text", text: "mcp pong" }]
        }
      }));
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => mcpServer.listen(0, "127.0.0.1", resolve));
  const mcpAddress = mcpServer.address();
  assert.ok(mcpAddress && typeof mcpAddress !== "string");

  const mock = await createMockMcpChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";
  process.env.HATCH_MCP_SERVERS = JSON.stringify({
    testdocs: {
      url: `http://127.0.0.1:${mcpAddress.port}/mcp`
    }
  });

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  try {
    const result = await runLocalHarness({
      serverUrl,
      workspace,
      prompt: "Call the docs MCP tool."
    });

    assert.match(result.finalText, /MCP tool result observed/);
    assert.deepEqual(result.events.filter((event) => event.type === "tool_call.request"), []);
    assert.ok(result.events.some((event) => event.type === "tool_call.delta" && event.name === "mcp.call" && event.status === "requested"));
    assert.ok(result.events.some((event) => event.type === "tool_call.delta" && event.name === "mcp.call" && event.status === "completed"));
    assert.equal(mcpRequests.length, 1);
    assert.equal(mcpRequests[0]?.method, "tools/call");
    assert.equal(mcpRequests[0]?.params?.name, "search_docs");
    assert.deepEqual(mcpRequests[0]?.params?.arguments, { query: "skills" });
    assert.ok(mock.requests[0]?.tools?.some((tool: Record<string, any>) => tool.function?.name === "mcp_call"));
    const events = await new RuntimeStore(dataDir).readEvents();
    assert.deepEqual(events
      .flatMap((event) => event.type === "tool.call" && event.name === "mcp.call"
        ? [`${event.conversation_id}:${event.status}`]
        : []), [
      "local-dev-conversation:requested",
      "local-dev-conversation:completed"
    ]);
  } finally {
    await mock.close();
    await new Promise<void>((resolve, reject) => mcpServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("chat completions runtime returns recoverable tool failures to the model", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const mcpRequests: Array<Record<string, any>> = [];
  const mcpServer = http.createServer((req, res) => {
    void (async () => {
      const body = JSON.parse(await readRequestBody(req)) as Record<string, any>;
      mcpRequests.push(body);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("upstream MCP failed");
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => mcpServer.listen(0, "127.0.0.1", resolve));
  const mcpAddress = mcpServer.address();
  assert.ok(mcpAddress && typeof mcpAddress !== "string");

  const mock = await createRecoverableToolFailureChatCompletionsServer();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";
  process.env.HATCH_MCP_SERVERS = JSON.stringify({
    failingdocs: {
      url: `http://127.0.0.1:${mcpAddress.port}/mcp`
    }
  });

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  try {
    const result = await runLocalHarness({
      serverUrl,
      workspace,
      prompt: "Call the failing MCP tool and recover."
    });

    assert.match(result.finalText, /Recovered from tool failure/);
    assert.equal(mcpRequests.length, 1);
    assert.ok(result.events.some((event) => event.type === "tool_call.delta" && event.name === "mcp.call" && event.status === "failed"));
    const events = await new RuntimeStore(dataDir).readEvents();
    assert.ok(events.some((event) => event.type === "tool.call" && event.name === "mcp.call" && event.status === "failed"));
    assert.ok(events.some((event) => (
      event.type === "conversation.model_message"
      && event.message.role === "tool"
      && event.message.tool_call_id === "call_failing_mcp"
      && String(event.message.content ?? "").includes("upstream MCP failed")
    )));
  } finally {
    await mock.close();
    await new Promise<void>((resolve, reject) => mcpServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("skill resources can be read by catalog path and cannot escape the skills root", async () => {
  const catalog = await listSkills();
  const skill = catalog.find((item) => item.name === "repo-assistant");
  assert.ok(skill);

  const content = await readSkillResourceByPath(skill.path);
  assert.match(content, /name: repo-assistant/);
  await assert.rejects(() => readSkillResourceByPath(path.join(path.dirname(skill.path), "..", "..", "package.json")), /escapes skills root/);
});

test("protected skill runs in a headless session and brokers local context through the client", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const skillsRoot = await tempWorkspace();
  const skillDir = path.join(skillsRoot, "protected-contract");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: protected-contract",
    "description: Review a contract using the private negotiation workflow.",
    "---",
    "",
    "# PRIVATE CONTRACT WORKFLOW",
    "",
    "Read the exact contract reference before producing a customer-side risk review.",
    "The private phrase PROTECTED_WORKFLOW_MARKER must never be returned to the main agent or client."
  ].join("\n"), "utf8");
  await mkdir(path.join(workspace, "legal-samples"), { recursive: true });
  await writeFile(path.join(workspace, "legal-samples", "agreement.md"), "Customer data remains confidential.\n", "utf8");

  const requests: Array<Record<string, any>> = [];
  let privateInstructionsSeenByWorker = false;
  let mainToolNames: string[] = [];
  let workerToolNames: string[] = [];
  let mainProtectedReadRejected = false;
  const mockServer = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const request = JSON.parse(await readRequestBody(req)) as Record<string, any>;
      requests.push(request);
      const requestNumber = requests.length;
      const messages = Array.isArray(request.messages) ? request.messages : [];
      const serialized = JSON.stringify(messages);
      const toolNames = (Array.isArray(request.tools) ? request.tools : [])
        .map((tool: Record<string, any>) => tool.function?.name)
        .filter((name: unknown): name is string => typeof name === "string")
        .sort();
      if (requestNumber === 1) {
        mainToolNames = toolNames;
        assert.doesNotMatch(serialized, /PROTECTED_WORKFLOW_MARKER/);
        writeSse(res, [{
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [{
                index: 0,
                id: "call_protected_skill",
                type: "function",
                function: {
                  name: "skill_run",
                  arguments: JSON.stringify({
                    skill_id: "protected-contract",
                    task: "Review the agreement from the customer side.",
                    context_refs: ["legal-samples/agreement.md"]
                  })
                }
              }]
            },
            finish_reason: null
          }]
        }, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }]);
        return;
      }
      if (requestNumber === 2) {
        workerToolNames = toolNames;
        privateInstructionsSeenByWorker = /PROTECTED_WORKFLOW_MARKER/.test(serialized);
        assert.equal(privateInstructionsSeenByWorker, true);
        writeSse(res, [{
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [{
                index: 0,
                id: "worker_call_read",
                type: "function",
                function: {
                  name: "file_read",
                  arguments: JSON.stringify({ path: "legal-samples/agreement.md" })
                }
              }]
            },
            finish_reason: null
          }]
        }, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }]);
        return;
      }
      if (requestNumber === 3) {
        assert.ok(messages.some((message: Record<string, unknown>) => message.role === "tool" && String(message.content).includes("Customer data remains confidential")));
        writeFinal(res, "Worker reviewed the agreement and identified a customer-data risk.");
        return;
      }
      if (requestNumber === 4) {
        assert.doesNotMatch(serialized, /PROTECTED_WORKFLOW_MARKER/);
        assert.ok(messages.some((message: Record<string, unknown>) => message.role === "tool" && String(message.content).includes("Worker reviewed")), JSON.stringify(messages));
        writeSse(res, [{
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [{
                index: 0,
                id: "main_call_private_skill_read",
                type: "function",
                function: {
                  name: "file_read",
                  arguments: JSON.stringify({ path: path.join(skillDir, "SKILL.md") })
                }
              }]
            },
            finish_reason: null
          }]
        }, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }]);
        return;
      }
      assert.equal(requestNumber, 5);
      assert.doesNotMatch(serialized, /PROTECTED_WORKFLOW_MARKER/);
      mainProtectedReadRejected = messages.some((message: Record<string, unknown>) => (
        message.role === "tool"
        && String(message.content).includes("Path escapes workspace")
        && !String(message.content).includes("PROTECTED_WORKFLOW_MARKER")
      ));
      writeFinal(res, "Main agent received the protected skill result and summarized the risk.");
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const address = mockServer.address();
  if (!address || typeof address === "string") throw new Error("Expected mock server to listen on a TCP port");

  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.HATCH_SKILL_ROOTS = skillsRoot;
  delete process.env.HATCH_TS_SKILLS_ROOT;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";
  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  try {
    const result = await runLocalHarness({
      serverUrl,
      workspace,
      conversationId: "protected-skill-e2e",
      prompt: "Please review legal-samples/agreement.md from the customer side."
    });
    assert.match(result.finalText, /Main agent received the protected skill result/);
    assert.equal(requests.length, 5);
    assert.equal(privateInstructionsSeenByWorker, true);
    assert.equal(mainProtectedReadRejected, true);
    assert.ok(mainToolNames.includes("skill_run"));
    assert.deepEqual(workerToolNames, mainToolNames.filter((name) => name !== "skill_run"));
    const workerRead = result.events.find((event): event is Extract<OutboundMessage, { type: "tool_call.request" }> => event.type === "tool_call.request" && event.tool_call_id === "worker_call_read");
    assert.ok(workerRead && workerRead.scope === "skill_run");
    assert.ok(workerRead && workerRead.skill_run_id);
    const skillStatuses = result.events
      .filter((event) => event.type === "skill.run")
      .map((event) => event.status);
    assert.deepEqual(skillStatuses, ["requested", "running", "completed"]);

    const store = new RuntimeStore(dataDir);
    const events = await store.readEvents();
    assert.ok(events.some((event) => event.type === "skill.session" && event.status === "completed"));
    assert.ok(events.some((event) => event.type === "skill.session.message"));
    const workerReadRequest = result.events.find((event): event is Extract<OutboundMessage, { type: "tool_call.request" }> => event.type === "tool_call.request" && event.tool_call_id === "worker_call_read");
    assert.ok(workerReadRequest?.skill_run_id);
    const skillSession = await store.readSkillSession(workerReadRequest!.skill_run_id!);
    assert.equal(skillSession?.status, "completed");
    assert.ok(skillSession?.messages.some((message) => message.role === "assistant" && String(message.content ?? "").includes("Worker reviewed")));
    const visible = await store.readVisibleConversation("protected-skill-e2e");
    assert.doesNotMatch(JSON.stringify(visible), /PROTECTED_WORKFLOW_MARKER/);
    const visibleAssistant = visible.find((message) => message.role === "assistant");
    assert.ok(visibleAssistant?.skill_runs?.some((run) => run.status === "completed"));
  } finally {
    await mockServer.close();
  }
});

test("cancelling the parent run terminates and destroys the protected worker", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  const skillsRoot = await tempWorkspace();
  const skillDir = path.join(skillsRoot, "protected-cancel");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: protected-cancel",
    "description: Exercise protected worker cancellation.",
    "---",
    "",
    "Wait for the exact local context before completing the task."
  ].join("\n"), "utf8");

  const requests: Array<Record<string, any>> = [];
  const mockServer = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const request = JSON.parse(await readRequestBody(req)) as Record<string, any>;
      requests.push(request);
      if (requests.length === 1) {
        writeSse(res, [{
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [{
                index: 0,
                id: "cancel_skill_call",
                type: "function",
                function: {
                  name: "skill_run",
                  arguments: JSON.stringify({
                    skill_id: "protected-cancel",
                    task: "Read the local context and wait.",
                    context_refs: ["notes.txt"]
                  })
                }
              }]
            },
            finish_reason: null
          }]
        }, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }]);
        return;
      }
      assert.equal(requests.length, 2);
      writeSse(res, [{
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: "cancel_worker_read",
              type: "function",
              function: {
                name: "file_read",
                arguments: JSON.stringify({ path: "notes.txt" })
              }
            }]
          },
          finish_reason: null
        }]
      }, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }]);
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const address = mockServer.address();
  if (!address || typeof address === "string") throw new Error("Expected mock server to listen on a TCP port");

  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  process.env.HATCH_SKILL_ROOTS = skillsRoot;
  delete process.env.HATCH_TS_SKILLS_ROOT;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.HATCH_CREATOR_MODEL = "kimi-k2.6";
  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  const session = new LocalHarnessSession({
    serverUrl,
    workspace,
    conversationId: "protected-cancel-e2e",
    holdToolRequests: true
  });
  await session.connect();
  try {
    const runPromise = session.run("Read notes.txt with the protected workflow and wait.");
    await waitUntil(async () => requests.length >= 2);
    const store = new RuntimeStore(dataDir);
    await waitUntil(async () => {
      const events = await store.readEvents();
      return events.some((event) => (
        event.type === "tool.call"
        && event.scope === "skill_run"
        && event.status === "requested"
      ));
    });
    session.cancelActiveRun("user cancelled protected task");
    await assert.rejects(runPromise, /user cancelled protected task|Run canceled/);

    await waitUntil(async () => {
      const events = await store.readEvents();
      return events.some((event) => event.type === "skill.session" && event.status === "cancelled");
    });
    const events = await store.readEvents();
    assert.ok(events.some((event) => event.type === "skill.run" && event.status === "cancelled"));
    assert.ok(events.some((event) => event.type === "tool.call" && event.scope === "skill_run" && event.status === "cancelled"));
  } finally {
    session.close();
    await mockServer.close();
  }
});

test("local harness supports multi-turn chat over one connection", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  const conversationId = "conv_server_owned_memory";
  await writeFile(
    path.join(workspace, "notes.txt"),
    "Hatch chat sessions keep the client socket open between turns.\n",
    "utf8"
  );

  runtimeServer = createDeterministicRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  const session = new LocalHarnessSession({
    serverUrl,
    workspace,
    conversationId
  });

  await session.connect();
  try {
    const first = await session.run("Find Hatch.");
    const second = await session.run("Find Hatch again.");

    assert.match(first.finalText, /(?:Your work is ready|I finished reviewing)/);
    assert.match(second.finalText, /(?:Your work is ready|I finished reviewing)/);
    assert.deepEqual(first.events.filter((event) => event.type === "tool_call.request").map((event) => event.name), [
      "fs.search",
      "fs.read"
    ]);
    assert.deepEqual(second.events.filter((event) => event.type === "tool_call.request").map((event) => event.name), [
      "fs.search",
      "fs.read"
    ]);
    assert.ok(second.events.some((event) => (
      event.type === "assistant.delta"
      && event.delta.kind === "status"
      && event.delta.content === "Picking up your conversation."
    )));
  } finally {
    session.close();
  }

  const reconnected = new LocalHarnessSession({
    serverUrl,
    workspace,
    conversationId
  });
  await reconnected.connect();
  try {
    const third = await reconnected.run("Find Hatch after reconnect.");
    assert.ok(third.events.some((event) => (
      event.type === "assistant.delta"
      && event.delta.kind === "status"
      && event.delta.content === "Picking up your conversation."
    )));
  } finally {
    reconnected.close();
  }

  const storedMessages = await new RuntimeStore(dataDir).readConversation(conversationId);
  const storedEvents = await new RuntimeStore(dataDir).readEvents();
  assert.equal(storedMessages.length, 6);
  assert.deepEqual(storedMessages.map((message) => message.role), [
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
    "assistant"
  ]);
  assert.equal(storedEvents.some((event) => (
    event.type === "runtime.event"
    && event.conversation_id === conversationId
    && typeof event.event === "object"
    && event.event !== null
    && (event.event as Record<string, unknown>).type === "turn.completed"
  )), true);
  assert.equal(storedEvents
    .filter((event) => event.type === "tool.call" && event.conversation_id === conversationId)
    .length, 18);
  assert.equal(storedEvents
    .filter((event) => event.type === "tool.call" && event.conversation_id === conversationId && event.name === "web.search")
    .length, 6);
});

test("server rejects duplicate client hello on the same connection", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  const socket = new WebSocket(serverUrl);
  const messages: OutboundMessage[] = [];
  socket.on("message", (data) => {
    messages.push(JSON.parse(String(data)) as OutboundMessage);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  socket.send(JSON.stringify({
    type: "client.hello",
    protocol_version: PROTOCOL_VERSION,
    installation_id: "install_once",
    license_token: "license_once",
    workspace_root: workspace,
    local_tools: ["fs.read"]
  }));
  await waitForSocketMessage(messages, (message) => message.type === "session.ready");

  socket.send(JSON.stringify({
    type: "client.hello",
    protocol_version: PROTOCOL_VERSION,
    installation_id: "install_twice",
    license_token: "license_twice",
    workspace_root: path.join(workspace, "other"),
    local_tools: ["fs.write"]
  }));
  const error = await waitForSocketMessage(messages, (message) => message.type === "turn.failed");
  assert.ok(error.type === "turn.failed");
  assert.equal(error.error.code, "duplicate_hello");
  socket.close();

  const events = await new RuntimeStore(dataDir).readEvents();
  const sessions = events.filter((event) => event.type === "session.started");
  assert.equal(sessions.length, 1);
  assert.ok(sessions[0]?.type === "session.started");
  assert.equal(sessions[0].installation_id, "install_once");
  assert.deepEqual(sessions[0].local_tools, ["fs.read"]);
});

test("server requires client hello before tool results", async () => {
  const dataDir = await tempWorkspace();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;

  runtimeServer = createRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  const socket = new WebSocket(serverUrl);
  const messages: OutboundMessage[] = [];
  socket.on("message", (data) => {
    messages.push(JSON.parse(String(data)) as OutboundMessage);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  socket.send(JSON.stringify({
    type: "tool_call.result",
    run_id: "run_without_hello",
    tool_call_id: "tool_without_hello",
    status: "ok",
    result: { ok: true }
  }));
  const error = await waitForSocketMessage(messages, (message) => message.type === "turn.failed");
  assert.ok(error.type === "turn.failed");
  assert.equal(error.error.code, "hello_required");
  socket.close();

  const events = await new RuntimeStore(dataDir).readEvents();
  assert.ok(!events.some((event) => event.type === "tool.call"));
});

test("server rejects concurrent runs for the same conversation across WebSocket sessions", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  await writeFile(path.join(workspace, "notes.txt"), "Hatch concurrent run guard test.\n", "utf8");

  runtimeServer = createDeterministicRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  const firstSocket = new WebSocket(serverUrl);
  const firstMessages: OutboundMessage[] = [];
  firstSocket.on("message", (data) => {
    firstMessages.push(JSON.parse(String(data)) as OutboundMessage);
  });

  await new Promise<void>((resolve, reject) => {
    firstSocket.once("open", resolve);
    firstSocket.once("error", reject);
  });

  firstSocket.send(JSON.stringify({
    type: "client.hello",
    protocol_version: PROTOCOL_VERSION,
    installation_id: "install_busy",
    license_token: "license_busy",
    workspace_root: workspace,
    local_tools: ["fs.list", "fs.search", "fs.read", "fs.write", "fs.patch", "git.diff"]
  }));
  await waitForSocketMessage(firstMessages, (message) => message.type === "session.ready");

  firstSocket.send(JSON.stringify({
    type: "client.message",
    run_id: "run_busy_1",
    conversation_id: "conv_busy",
    message: { role: "user", content: "Find Hatch." }
  }));
  await waitForSocketMessage(firstMessages, (message) => message.type === "tool_call.request" && message.run_id === "run_busy_1");

  const secondSocket = new WebSocket(serverUrl);
  const secondMessages: OutboundMessage[] = [];
  secondSocket.on("message", (data) => {
    secondMessages.push(JSON.parse(String(data)) as OutboundMessage);
  });
  await new Promise<void>((resolve, reject) => {
    secondSocket.once("open", resolve);
    secondSocket.once("error", reject);
  });
  secondSocket.send(JSON.stringify({
    type: "client.hello",
    protocol_version: PROTOCOL_VERSION,
    installation_id: "install_busy_2",
    license_token: "license_busy",
    workspace_root: workspace,
    local_tools: ["fs.list", "fs.search", "fs.read", "fs.write", "fs.patch", "git.diff"]
  }));
  await waitForSocketMessage(secondMessages, (message) => message.type === "session.ready");

  secondSocket.send(JSON.stringify({
    type: "client.message",
    run_id: "run_busy_2",
    conversation_id: "conv_busy",
    message: { role: "user", content: "This should be rejected." }
  }));
  const busy = await waitForSocketMessage(secondMessages, (message) => message.type === "turn.failed" && message.run_id === "run_busy_2");
  assert.equal(busy.type, "turn.failed");
  assert.equal(busy.error.code, "conversation_busy");

  firstSocket.close();
  secondSocket.close();

  const storedMessages = await new RuntimeStore(dataDir).readConversation("conv_busy");
  assert.deepEqual(storedMessages.map((message) => message.content), ["Find Hatch."]);
  const events = await new RuntimeStore(dataDir).readEvents();
  assert.ok(events.some((event) => (
    event.type === "runtime.event"
    && typeof event.event === "object"
    && event.event !== null
    && (event.event as Record<string, unknown>).type === "turn.failed"
    && (event.event as Record<string, unknown>).run_id === "run_busy_2"
  )));
});

test("server releases a conversation lock when the client disconnects mid-run", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  await writeFile(path.join(workspace, "notes.txt"), "Hatch reconnect lock release test.\n", "utf8");

  runtimeServer = createDeterministicRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  const firstSocket = new WebSocket(serverUrl);
  const firstMessages: OutboundMessage[] = [];
  firstSocket.on("message", (data) => {
    firstMessages.push(JSON.parse(String(data)) as OutboundMessage);
  });

  await new Promise<void>((resolve, reject) => {
    firstSocket.once("open", resolve);
    firstSocket.once("error", reject);
  });

  firstSocket.send(JSON.stringify({
    type: "client.hello",
    protocol_version: PROTOCOL_VERSION,
    installation_id: "install_disconnect_lock_1",
    license_token: "license_disconnect_lock",
    workspace_root: workspace,
    local_tools: ["fs.list", "fs.search", "fs.read", "fs.write", "fs.patch", "git.diff"]
  }));
  await waitForSocketMessage(firstMessages, (message) => message.type === "session.ready");

  firstSocket.send(JSON.stringify({
    type: "client.message",
    run_id: "run_disconnect_lock_1",
    conversation_id: "conv_disconnect_lock",
    message: { role: "user", content: "Find Hatch." }
  }));
  const firstToolRequest = await waitForSocketMessage(firstMessages, (message) => (
    message.type === "tool_call.request" && message.run_id === "run_disconnect_lock_1"
  ));
  assert.equal(firstToolRequest.type, "tool_call.request");

  firstSocket.close();
  await waitUntil(async () => {
    const events = await new RuntimeStore(dataDir).readEvents();
    return events.some((event) => (
      event.type === "turn.state"
      && event.run_id === "run_disconnect_lock_1"
      && event.to === "cancelled"
    ));
  });

  const secondSocket = new WebSocket(serverUrl);
  const secondMessages: OutboundMessage[] = [];
  secondSocket.on("message", (data) => {
    secondMessages.push(JSON.parse(String(data)) as OutboundMessage);
  });
  await new Promise<void>((resolve, reject) => {
    secondSocket.once("open", resolve);
    secondSocket.once("error", reject);
  });
  secondSocket.send(JSON.stringify({
    type: "client.hello",
    protocol_version: PROTOCOL_VERSION,
    installation_id: "install_disconnect_lock_2",
    license_token: "license_disconnect_lock",
    workspace_root: workspace,
    local_tools: ["fs.list", "fs.search", "fs.read", "fs.write", "fs.patch", "git.diff"]
  }));
  await waitForSocketMessage(secondMessages, (message) => message.type === "session.ready");

  secondSocket.send(JSON.stringify({
    type: "client.message",
    run_id: "run_disconnect_lock_2",
    conversation_id: "conv_disconnect_lock",
    message: { role: "user", content: "Find Hatch after reconnect." }
  }));
  const accepted = await waitForSocketMessage(secondMessages, (message) => (
    (message.type === "tool_call.request" && message.run_id === "run_disconnect_lock_2")
    || (message.type === "turn.failed" && message.run_id === "run_disconnect_lock_2")
  ));
  assert.equal(accepted.type, "tool_call.request");
  secondSocket.close();

  const events = await new RuntimeStore(dataDir).readEvents();
  assert.ok(events.some((event) => (
    event.type === "tool.call"
    && event.run_id === "run_disconnect_lock_1"
    && event.tool_call_id === firstToolRequest.tool_call_id
    && event.status === "cancelled"
  )));
  assert.ok(!events.some((event) => (
    event.type === "runtime.event"
    && event.run_id === "run_disconnect_lock_2"
    && typeof event.event === "object"
    && event.event !== null
    && (event.event as Record<string, unknown>).type === "turn.failed"
    && ((event.event as Record<string, unknown>).error as Record<string, unknown> | undefined)?.code === "conversation_busy"
  )));
});

test("run cancel for an unknown run does not cancel the active run", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  await writeFile(path.join(workspace, "notes.txt"), "Hatch targeted cancellation test.\n", "utf8");

  runtimeServer = createDeterministicRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  const socket = new WebSocket(serverUrl);
  const messages: OutboundMessage[] = [];
  socket.on("message", (data) => {
    const message = JSON.parse(String(data)) as OutboundMessage;
    messages.push(message);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  socket.send(JSON.stringify({
    type: "client.hello",
    protocol_version: PROTOCOL_VERSION,
    installation_id: "install_cancel_targeted",
    license_token: "license_cancel_targeted",
    workspace_root: workspace,
    local_tools: ["fs.list", "fs.search", "fs.read", "fs.write", "fs.patch", "git.diff"]
  }));
  await waitForSocketMessage(messages, (message) => message.type === "session.ready");

  socket.send(JSON.stringify({
    type: "client.message",
    run_id: "run_cancel_active",
    conversation_id: "conv_cancel_targeted",
    message: { role: "user", content: "Find Hatch." }
  }));
  const toolRequest = await waitForSocketMessage(messages, (message) => message.type === "tool_call.request" && message.run_id === "run_cancel_active");
  assert.ok(toolRequest.type === "tool_call.request");

  socket.send(JSON.stringify({
    type: "turn.cancel",
    run_id: "run_cancel_missing",
    reason: "wrong run"
  }));
  const unknown = await waitForSocketMessage(messages, (message) => message.type === "turn.failed" && message.run_id === "run_cancel_missing");
  assert.equal(unknown.type, "turn.failed");
  assert.equal(unknown.error.code, "unknown_run");

  const eventsAfterUnknownCancel = await new RuntimeStore(dataDir).readEvents();
  assert.ok(!eventsAfterUnknownCancel.some((event) => event.type === "turn.state" && event.run_id === "run_cancel_active" && event.to === "cancelled"));
  assert.ok(!eventsAfterUnknownCancel.some((event) => event.type === "tool.call" && event.run_id === "run_cancel_active" && event.status === "cancelled"));

  socket.send(JSON.stringify({
    type: "turn.cancel",
    run_id: "run_cancel_active",
    reason: "targeted cancel"
  }));
  const cancelledTool = await waitForSocketMessage(messages, (message) => (
    message.type === "tool_call.delta"
    && message.run_id === "run_cancel_active"
    && message.tool_call_id === toolRequest.tool_call_id
    && message.status === "cancelled"
  ));
  assert.equal(cancelledTool.type, "tool_call.delta");
  assert.equal(cancelledTool.error?.code, "tool_cancelled");
  const cancelled = await waitForSocketMessage(messages, (message) => message.type === "turn.failed" && message.run_id === "run_cancel_active");
  assert.equal(cancelled.type, "turn.failed");
  assert.equal(cancelled.error.code, "run_cancelled");
  socket.close();

  const events = await new RuntimeStore(dataDir).readEvents();
  assert.ok(events.some((event) => event.type === "turn.state" && event.run_id === "run_cancel_active" && event.to === "cancelled"));
  assert.ok(events.some((event) => event.type === "tool.call" && event.run_id === "run_cancel_active" && event.status === "cancelled"));
  assert.ok(events.some((event) => (
    event.type === "runtime.event"
    && event.run_id === "run_cancel_active"
    && typeof event.event === "object"
    && event.event !== null
    && (event.event as Record<string, unknown>).type === "tool_call.delta"
    && (event.event as Record<string, unknown>).status === "cancelled"
    && (event.event as Record<string, unknown>).tool_call_id === toolRequest.tool_call_id
  )));
  assert.ok(!events.some((event) => (
    event.type === "runtime.event"
    && event.run_id === "run_cancel_active"
    && typeof event.event === "object"
    && event.event !== null
    && (event.event as Record<string, unknown>).type === "turn.failed"
    && ((event.event as Record<string, unknown>).error as Record<string, unknown> | undefined)?.code === "run_failed"
  )));
});

test("run cancellation transitions active run to cancelled and persists it", async () => {
  const workspace = await tempWorkspace();
  const dataDir = await tempWorkspace();
  process.env.HATCH_RUNTIME_DATA_DIR = dataDir;
  await writeFile(path.join(workspace, "notes.txt"), "Hatch cancellation test.\n", "utf8");

  runtimeServer = createDeterministicRuntimeServer();
  const serverUrl = await listen(runtimeServer);
  const session = new LocalHarnessSession({
    serverUrl,
    workspace,
    holdToolRequests: true
  });

  await session.connect();
  const runPromise = session.run("Find Hatch.");

  await waitUntil(async () => {
    const events = await new RuntimeStore(dataDir).readEvents();
    return events.some((event) => event.type === "turn.state" && event.to === "waiting_for_tool");
  });

  const eventsBeforeCancel = await new RuntimeStore(dataDir).readEvents();
  const requestedTool = eventsBeforeCancel.find((event) => event.type === "tool.call" && event.name === "fs.search" && event.status === "requested");
  assert.ok(requestedTool && requestedTool.type === "tool.call");

  session.cancelActiveRun("test cancellation");
  await assert.rejects(runPromise, /test cancellation|Run canceled|Client broker canceled/);
  session.close();

  const events = await new RuntimeStore(dataDir).readEvents();
  assert.ok(events.some((event) => event.type === "turn.state" && event.to === "cancelled"));
  assert.ok(events.some((event) => (
    event.type === "tool.call"
    && event.status === "cancelled"
    && event.tool_call_id === requestedTool.tool_call_id
    && event.arguments.query === "Hatch"
  )));
  assert.ok(events.some((event) => (
    event.type === "runtime.event"
    && event.run_id === requestedTool.run_id
    && typeof event.event === "object"
    && event.event !== null
    && (event.event as Record<string, unknown>).type === "tool_call.delta"
    && (event.event as Record<string, unknown>).status === "cancelled"
    && (event.event as Record<string, unknown>).tool_call_id === requestedTool.tool_call_id
  )));
  assert.ok(!events.some((event) => (
    event.type === "runtime.event"
    && event.run_id === requestedTool.run_id
    && typeof event.event === "object"
    && event.event !== null
    && (event.event as Record<string, unknown>).type === "turn.failed"
    && ((event.event as Record<string, unknown>).error as Record<string, unknown> | undefined)?.code === "run_failed"
  )));
});

async function buildRustLocalRunnerBin(): Promise<string> {
  const cargoToml = path.resolve("..", "local-runner", "Cargo.toml");
  const bin = path.resolve(
    "..",
    "local-runner",
    "target",
    "debug",
    process.platform === "win32" ? "hatch-local-runner.exe" : "hatch-local-runner"
  );
  await execFileAsync("cargo", ["build", "--manifest-path", cargoToml], {
    timeout: 120000,
    maxBuffer: 1024 * 1024
  });
  await access(bin);
  return bin;
}

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-"));
  tempDirs.push(dir);
  return dir;
}

async function listen(server: RuntimeServer): Promise<string> {
  await new Promise<void>((resolve) => {
    server.server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected runtime server to listen on a TCP port");
  }
  return `ws://127.0.0.1:${address.port}/runtime`;
}

async function createMockChatCompletionsServer(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);
      const hasToolMessage = Array.isArray(request.messages)
        && request.messages.some((message: Record<string, unknown>) => message.role === "tool");

      if (!hasToolMessage) {
        const skillCatalog = runtimeContextContent(request, /repo-assistant/);
        const skillPath = skillCatalog.match(/\(file: ([^)]+\/SKILL\.md)\)/)?.[1];
        assert.ok(skillPath, "mock runtime expected a SKILL.md path in the skills section");
        writeSse(res, [
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_skill",
                  type: "function",
                  function: {
                    name: "file_read",
                    arguments: JSON.stringify({ path: skillPath })
                  }
                }]
              },
              finish_reason: null
            }]
          },
          {
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "tool_calls"
            }]
          }
        ]);
        return;
      }

      writeSse(res, [
        {
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              content: "Skill loaded before final response."
            },
            finish_reason: "stop"
          }]
        }
      ]);
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createAliasedSkillPathChatCompletionsServer(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);
      const hasToolMessage = Array.isArray(request.messages)
        && request.messages.some((message: Record<string, unknown>) => message.role === "tool");

      if (!hasToolMessage) {
        const skillCatalog = runtimeContextContent(request, /shared-root-skill-00/);
        assert.match(skillCatalog, /### Skill roots/);
        const aliasedSkillPath = skillCatalog.match(/\(file: (r\d+\/shared-root-skill-00\/SKILL\.md)\)/)?.[1];
        assert.ok(aliasedSkillPath, "mock runtime expected an aliased SKILL.md path in the skills section");
        writeSse(res, [
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_aliased_skill",
                  type: "function",
                  function: {
                    name: "file_read",
                    arguments: JSON.stringify({ path: aliasedSkillPath })
                  }
                }]
              },
              finish_reason: null
            }]
          },
          {
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "tool_calls"
            }]
          }
        ]);
        return;
      }

      assert.ok(request.messages.some((message: Record<string, unknown>) => (
        message.role === "tool"
        && String(message.content ?? "").includes("# shared-root-skill-00")
        && String(message.content ?? "").includes("Aliased skill body.")
        && !String(message.content ?? "").includes("\"path\":\"r0/")
      )));
      writeFinal(res, "Aliased skill path loaded.");
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createModelDrivenResourceManifestChatCompletionsServer(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);
      const hasToolMessage = Array.isArray(request.messages)
        && request.messages.some((message: Record<string, unknown>) => message.role === "tool");

      if (!hasToolMessage) {
        const skillCatalog = runtimeContextContent(request, /implicit-resource-skill/);
        const skillPath = skillCatalog.match(/- implicit-resource-skill:[^\n]*\(file: ([^)]+\/SKILL\.md)/)?.[1];
        assert.ok(skillPath, "mock runtime expected implicit-resource-skill in the skills catalog");
        assert.doesNotMatch(skillCatalog, /# Implicit Resource Skill/);
        writeSse(res, [
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_implicit_resource_skill",
                  type: "function",
                  function: {
                    name: "file_read",
                    arguments: JSON.stringify({ path: skillPath })
                  }
                }]
              },
              finish_reason: null
            }]
          },
          {
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "tool_calls"
            }]
          }
        ]);
        return;
      }

      const toolMessage = request.messages.find((message: Record<string, unknown>) => message.role === "tool");
      const toolResult = JSON.parse(String(toolMessage?.content ?? "{}")) as Record<string, unknown>;
      assert.match(String(toolResult.content ?? ""), /# Implicit Resource Skill/);
      assert.ok(Array.isArray(toolResult.resource_paths));
      assert.equal(toolResult.resource_manifest_truncated, false);
      assert.deepEqual([...toolResult.resource_paths].sort(), [
        "references/guide.md",
        "scripts/check.sh"
      ]);
      assert.doesNotMatch(JSON.stringify(toolResult), /implicit reference payload/);
      writeSse(res, [
        {
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              content: "Model-driven resource manifest observed."
            },
            finish_reason: "stop"
          }]
        }
      ]);
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createModelDrivenAllowedToolsChatCompletionsServer(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);
      const toolMessages = Array.isArray(request.messages)
        ? request.messages.filter((message: Record<string, unknown>) => message.role === "tool")
        : [];

      if (requests.length === 1) {
        const skillCatalog = runtimeContextContent(request, /implicit-write-skill/);
        const skillPath = skillCatalog.match(/- implicit-write-skill:[^\n]*\(file: ([^)]+\/SKILL\.md)/)?.[1];
        assert.ok(skillPath, "mock runtime expected implicit-write-skill in the skills catalog");
        assert.doesNotMatch(skillCatalog, /# Implicit Write Skill/);
        return writeSse(res, [
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_implicit_write_skill",
                  type: "function",
                  function: {
                    name: "file_read",
                    arguments: JSON.stringify({ path: skillPath })
                  }
                }]
              },
              finish_reason: null
            }]
          },
          {
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "tool_calls"
            }]
          }
        ]);
      }

      if (requests.length === 2) {
        assert.ok(toolMessages.some((message: Record<string, unknown>) => String(message.content ?? "").includes("# Implicit Write Skill")));
        return writeSse(res, [
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_implicit_write_file",
                  type: "function",
                  function: {
                    name: "file_write",
                    arguments: JSON.stringify({
                      path: "model-driven-allowed.md",
                      content: "same-run preapproval\n"
                    })
                  }
                }]
              },
              finish_reason: null
            }]
          },
          {
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "tool_calls"
            }]
          }
        ]);
      }

      assert.ok(toolMessages.some((message: Record<string, unknown>) => String(message.content ?? "").includes("model-driven-allowed.md")));
      writeSse(res, [
        {
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              content: "Model-driven allowed tools completed."
            },
            finish_reason: "stop"
          }]
        }
      ]);
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createSkillRetentionChatCompletionsServer(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);
      const hasToolMessage = Array.isArray(request.messages)
        && request.messages.some((message: Record<string, unknown>) => message.role === "tool");

      if (requests.length === 1) {
        const skillCatalog = runtimeContextContent(request, /repo-assistant/);
        const skillPath = skillCatalog.match(/\(file: ([^)]+\/SKILL\.md)\)/)?.[1];
        assert.ok(skillPath, "mock runtime expected a SKILL.md path in the skills section");
        writeSse(res, [
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_skill_retention",
                  type: "function",
                  function: {
                    name: "file_read",
                    arguments: JSON.stringify({ path: skillPath })
                  }
                }]
              },
              finish_reason: null
            }]
          },
          {
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "tool_calls"
            }]
          }
        ]);
        return;
      }

      if (requests.length === 2) {
        assert.ok(hasToolMessage);
        assert.ok(request.messages.some((message: Record<string, unknown>) => (
          message.role === "tool"
          && String(message.content ?? "").includes("# Repo Assistant")
        )));
        writeSse(res, [
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                content: "First skill turn complete."
              },
              finish_reason: "stop"
            }]
          }
        ]);
        return;
      }

      assert.ok(!runtimeContexts(request).some((content) => (
        content.includes("<skill>")
        && content.includes("<name>repo-assistant</name>")
        && content.includes("# Repo Assistant")
      )));
      writeSse(res, [
        {
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              content: "No activated skill retained."
            },
            finish_reason: "stop"
          }]
        }
      ]);
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createActivatedSkillResourceChatCompletionsServer(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const resourcePath = "references/guide.md";
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);
      const hasToolMessage = Array.isArray(request.messages)
        && request.messages.some((message: Record<string, unknown>) => message.role === "tool");

      if (requests.length === 1) {
        const activatedContext = runtimeContextContent(request, /# Manual Resource Skill/);
        const skillPath = activatedContext.match(/<path>([^<]+\/SKILL\.md)<\/path>/)?.[1];
        assert.ok(skillPath, "mock runtime expected explicit skill activation in runtime context");
        assert.match(activatedContext, /<skill>\s*<name>manual-resource-skill<\/name>/);
        assert.match(activatedContext, /<skill_resources>/);
        assert.match(activatedContext, /<file>references\/guide\.md<\/file>/);
        assert.match(activatedContext, /<file>scripts\/check\.sh<\/file>/);
        assert.match(activatedContext, /<file>assets\/template\.txt<\/file>/);
        assert.doesNotMatch(activatedContext, /manual reference payload/);
        assert.ok(!hasToolMessage);
        writeSse(res, [
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                content: "Manual resource skill activated."
              },
              finish_reason: "stop"
            }]
          }
        ]);
        return;
      }

      if (requests.length === 2) {
        const activatedContext = runtimeContextContent(request, /# Manual Resource Skill/);
        assert.match(activatedContext, /<skill>\s*<name>manual-resource-skill<\/name>/);
        assert.match(activatedContext, /<file>references\/guide\.md<\/file>/);
        assert.doesNotMatch(activatedContext, /manual reference payload/);
        assert.doesNotMatch(runtimeContexts(request).join("\n"), /### Available skills\n- manual-resource-skill:/);
        assert.ok(!hasToolMessage);
        writeSse(res, [
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_manual_reference",
                  type: "function",
                  function: {
                    name: "file_read",
                    arguments: JSON.stringify({ path: resourcePath })
                  }
                }]
              },
              finish_reason: null
            }]
          },
          {
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "tool_calls"
            }]
          }
        ]);
        return;
      }

      assert.ok(hasToolMessage, JSON.stringify({
        requestIndex: requests.length,
        roles: Array.isArray(request.messages)
          ? request.messages.map((message: Record<string, unknown>) => message.role)
          : []
      }));
      assert.ok(request.messages.some((message: Record<string, unknown>) => (
        message.role === "tool"
        && String(message.content ?? "").includes("manual reference payload")
      )));
      writeSse(res, [
        {
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              content: "Manual reference read through activated skill root."
            },
            finish_reason: "stop"
          }]
        }
      ]);
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createFullExplicitSkillChatCompletionsServer(trailer: string): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);
      const hasToolMessage = Array.isArray(request.messages)
        && request.messages.some((message: Record<string, unknown>) => message.role === "tool");

      if (!hasToolMessage) {
        const activatedContext = runtimeContextContent(request, /# Large Explicit Skill/);
        const skillPath = activatedContext.match(/<path>([^<]+\/SKILL\.md)<\/path>/)?.[1];
        assert.ok(skillPath, "mock runtime expected explicit large skill activation in runtime context");
        const skillContent = activatedContext.match(new RegExp(`${escapeRegExp(skillPath)}</path>\\n([\\s\\S]*?)\\n<skill_directory>`))?.[1];
        assert.ok(skillContent, "mock runtime expected activated skill content before skill_directory");
        assert.match(skillContent, /VISIBLE_START/);
        assert.match(skillContent, new RegExp(escapeRegExp(trailer)));
        writeSse(res, [
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_large_skill_full_read",
                  type: "function",
                  function: {
                    name: "file_read",
                    arguments: JSON.stringify({ path: skillPath })
                  }
                }]
              },
              finish_reason: null
            }]
          },
          {
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "tool_calls"
            }]
          }
        ]);
        return;
      }

      assert.ok(request.messages.some((message: Record<string, unknown>) => (
        message.role === "tool"
        && String(message.content ?? "").includes(trailer)
      )));
      writeFinal(res, "Large explicit skill read completely.");
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createAmbiguousRelativeSkillResourceChatCompletionsServer(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);
      const activatedContext = runtimeContexts(request).join("\n");
      assert.match(activatedContext, /# first-resource-skill/);
      assert.match(activatedContext, /# second-resource-skill/);
      assert.match(activatedContext, /<file>references\/guide\.md<\/file>/);
      writeSse(res, [
        {
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [{
                index: 0,
                id: "call_ambiguous_reference",
                type: "function",
                function: {
                  name: "file_read",
                  arguments: JSON.stringify({ path: "references/guide.md" })
                }
              }]
            },
            finish_reason: null
          }]
        },
        {
          choices: [{
            index: 0,
            delta: {},
            finish_reason: "tool_calls"
          }]
        }
      ]);
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createActivatedSkillRefreshChatCompletionsServer(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);

      if (requests.length === 1) {
        const activatedContext = runtimeContextContent(request, /# Refresh Skill Version One/);
        assert.match(activatedContext, /<skill>\s*<name>refresh-skill<\/name>/);
        assert.doesNotMatch(activatedContext, /# Refresh Skill Version Two/);
        return writeFinal(res, "refresh one");
      }

      if (requests.length === 2) {
        const activatedContext = runtimeContextContent(request, /# Refresh Skill Version Two/);
        assert.match(activatedContext, /<skill>\s*<name>refresh-skill<\/name>/);
        assert.doesNotMatch(activatedContext, /# Refresh Skill Version One/);
        return writeFinal(res, "refresh two");
      }

      const context = runtimeContexts(request).join("\n");
      assert.doesNotMatch(context, /# Refresh Skill Version One/);
      assert.doesNotMatch(context, /# Refresh Skill Version Two/);
      assert.doesNotMatch(context, /- refresh-skill:/);
      writeFinal(res, "refresh disabled");
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createPreTurnCompactionChatCompletionsServer(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);

      if (!request.stream) {
        assert.match(String(request.messages?.[0]?.content ?? ""), /CONTEXT CHECKPOINT COMPACTION/);
        assert.match(String(request.messages?.[1]?.content ?? ""), /old assistant payload should be summarized away/);
        writeJsonCompletion(res, "Pre-turn compacted summary.");
        return;
      }

      const messages = request.messages ?? [];
      assert.ok(messages.some((message: Record<string, unknown>) => String(message.content ?? "").includes(`${SUMMARY_PREFIX}\nPre-turn compacted summary.`)));
      assert.ok(messages.some((message: Record<string, unknown>) => String(message.content ?? "").includes("current user after pre-turn compact")));
      assert.ok(!messages.some((message: Record<string, unknown>) => String(message.content ?? "").includes("old assistant payload should be summarized away")));
      writeFinal(res, "pre-turn final");
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createManualCompactionChatCompletionsServer(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);
      assert.equal(request.stream, false);
      assert.match(String(request.messages?.[0]?.content ?? ""), /CONTEXT CHECKPOINT COMPACTION/);
      assert.match(String(request.messages?.[1]?.content ?? ""), /manual compact prior assistant/);
      writeJsonCompletion(res, "Manual compacted summary.");
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createMidTurnCompactionChatCompletionsServer(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);

      if (requests.length === 1) {
        assert.equal(request.stream, true);
        writeSse(res, [
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_web_before_compact",
                  type: "function",
                  function: {
                    name: "web_search",
                    arguments: JSON.stringify({ query: "Hatch runtime architecture", limit: 2 })
                  }
                }]
              },
              finish_reason: null
            }]
          },
          {
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "tool_calls"
            }]
          }
        ]);
        return;
      }

      if (!request.stream) {
        assert.match(String(request.messages?.[0]?.content ?? ""), /CONTEXT CHECKPOINT COMPACTION/);
        assert.match(String(request.messages?.[1]?.content ?? ""), /Hatch runtime architecture/);
        writeJsonCompletion(res, "Mid-turn tool result summary.");
        return;
      }

      const messages = request.messages ?? [];
      assert.ok(messages.some((message: Record<string, unknown>) => String(message.content ?? "").includes(`${SUMMARY_PREFIX}\nMid-turn tool result summary.`)));
      assert.ok(!messages.some((message: Record<string, unknown>) => message.role === "tool"));
      writeFinal(res, "mid-turn final");
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createMultiToolBatchCompactionChatCompletionsServer(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);

      if (requests.length === 1) {
        assert.equal(request.stream, true);
        writeSse(res, [
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_batch_web",
                    type: "function",
                    function: {
                      name: "web_search",
                      arguments: JSON.stringify({ query: "multi tool batch query", limit: 1 })
                    }
                  },
                  {
                    index: 1,
                    id: "call_batch_api",
                    type: "function",
                    function: {
                      name: "api_request",
                      arguments: JSON.stringify({ endpoint: "batch_endpoint", payload: { phase: "batch" } })
                    }
                  }
                ]
              },
              finish_reason: null
            }]
          },
          {
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "tool_calls"
            }]
          }
        ]);
        return;
      }

      if (!request.stream) {
        assert.match(String(request.messages?.[0]?.content ?? ""), /CONTEXT CHECKPOINT COMPACTION/);
        const transcript = String(request.messages?.[1]?.content ?? "");
        assert.match(transcript, /multi tool batch query/);
        assert.match(transcript, /batch_endpoint/);
        writeJsonCompletion(res, "Multi-tool batch summary.");
        return;
      }

      const messages = request.messages ?? [];
      assert.ok(messages.some((message: Record<string, unknown>) => String(message.content ?? "").includes(`${SUMMARY_PREFIX}\nMulti-tool batch summary.`)));
      assert.ok(!messages.some((message: Record<string, unknown>) => message.role === "tool"));
      writeFinal(res, "multi-tool batch final");
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createFinalOnlyChatCompletionsServer(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);
      writeSse(res, [
        {
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              content: `final turn ${requests.length}`
            },
            finish_reason: "stop"
          }]
        }
      ]);
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createDirectReadGuardChatCompletionsServer(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);

      if (requests.length === 1) {
        const prefix = stableModelPrefix(request).map((message) => message.content).join("\n");
        assert.doesNotMatch(prefix, /legal-samples\/acme-analytics-saas-agreement\.md/);
        writeSse(res, [
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_bad_search",
                  type: "function",
                  function: {
                    name: "file_search",
                    arguments: JSON.stringify({
                      query: "acme analytics saas agreement",
                      path: ".",
                      max_results: 5
                    })
                  }
                }]
              },
              finish_reason: null
            }]
          },
          {
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "tool_calls"
            }]
          }
        ]);
        return;
      }

      if (requests.length === 2) {
        assert.ok(request.messages.some((message: Record<string, unknown>) => (
          message.role === "tool"
          && message.tool_call_id === "call_bad_search"
          && String(message.content ?? "").includes("direct_read_required")
        )));
        writeSse(res, [
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_exact_read",
                  type: "function",
                  function: {
                    name: "file_read",
                    arguments: JSON.stringify({
                      path: "legal-samples/acme-analytics-saas-agreement.md"
                    })
                  }
                }]
              },
              finish_reason: null
            }]
          },
          {
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "tool_calls"
            }]
          }
        ]);
        return;
      }

      assert.ok(request.messages.some((message: Record<string, unknown>) => (
        message.role === "tool"
        && message.tool_call_id === "call_exact_read"
        && String(message.content ?? "").includes("Contract body for runtime path policy")
      )));
      writeFinal(res, "Exact file read observed.");
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createShellJustificationChatCompletionsServer(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);

      if (requests.length === 1) {
        const shell = request.tools?.find((tool: Record<string, any>) => tool.function?.name === "shell_exec");
        assert.ok(shell);
        assert.ok(shell.function.parameters.properties.justification);
        writeSse(res, [
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_shell_approval",
                  type: "function",
                  function: {
                    name: "shell_exec",
                    arguments: JSON.stringify({
                      command: "printf hatch",
                      justification: "Need to inspect shell output."
                    })
                  }
                }]
              },
              finish_reason: null
            }]
          },
          {
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "tool_calls"
            }]
          }
        ]);
        return;
      }

      assert.ok(request.messages.some((message: Record<string, unknown>) => (
        message.role === "tool"
        && message.tool_call_id === "call_shell_approval"
        && String(message.content ?? "").includes("\"stdout\":\"hatch\"")
      )));
      writeFinal(res, "Shell output observed.");
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createMockLocalToolChatCompletionsServer(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);
      const hasToolMessage = Array.isArray(request.messages)
        && request.messages.some((message: Record<string, unknown>) => message.role === "tool");

      if (!hasToolMessage) {
        assert.ok(request.tools?.some((tool: Record<string, any>) => tool.function?.name === "file_search"));
        writeSse(res, [
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_local_search",
                  type: "function",
                  function: {
                    name: "file_search",
                    arguments: JSON.stringify({
                      query: "Hatch",
                      path: ".",
                      max_results: 5
                    })
                  }
                }]
              },
              finish_reason: null
            }]
          },
          {
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "tool_calls"
            }]
          }
        ]);
        return;
      }

      assert.ok(request.messages.some((message: Record<string, unknown>) => (
        message.role === "tool"
        && String(message.content ?? "").includes("notes.txt")
      )));
      writeSse(res, [
        {
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              content: "Local filesystem tool result observed."
            },
            finish_reason: "stop"
          }]
        }
      ]);
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createToolHistoryReplayChatCompletionsServer(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);

      if (requests.length === 1) {
        writeSse(res, [
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_history_web",
                  type: "function",
                  function: {
                    name: "web_search",
                    arguments: JSON.stringify({ query: "history persistence marker", limit: 1 })
                  }
                }]
              },
              finish_reason: null
            }]
          },
          {
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "tool_calls"
            }]
          }
        ]);
        return;
      }

      if (requests.length === 2) {
        assert.ok(request.messages.some((message: Record<string, unknown>) => (
          message.role === "tool"
          && message.tool_call_id === "call_history_web"
          && String(message.content ?? "").includes("history persistence marker")
        )));
        writeFinal(res, "first turn complete.");
        return;
      }

      assert.ok(request.messages.some((message: Record<string, any>) => (
        message.role === "assistant"
        && Array.isArray(message.tool_calls)
        && message.tool_calls.some((toolCall: Record<string, any>) => toolCall.id === "call_history_web")
      )));
      assert.ok(request.messages.some((message: Record<string, unknown>) => (
        message.role === "tool"
        && message.tool_call_id === "call_history_web"
        && String(message.content ?? "").includes("history persistence marker")
      )));
      assert.ok(request.messages.some((message: Record<string, unknown>) => (
        message.role === "assistant"
        && String(message.content ?? "").includes("first turn complete")
      )));
      writeFinal(res, "second turn saw tool history.");
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createAllowedToolsChatCompletionsServer(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);
      const hasToolMessage = Array.isArray(request.messages)
        && request.messages.some((message: Record<string, unknown>) => message.role === "tool");

      if (!hasToolMessage) {
        const activatedContext = runtimeContextContent(request, /# Allowed Tools Skill/);
        assert.match(activatedContext, /allowed-tools: Write Bash\(git:\*\)/);
        assert.ok(request.tools?.some((tool: Record<string, any>) => tool.function?.name === "file_write"));
        assert.ok(request.tools?.some((tool: Record<string, any>) => tool.function?.name === "shell_exec"));
        writeSse(res, [
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_allowed_write",
                  type: "function",
                  function: {
                    name: "file_write",
                    arguments: JSON.stringify({
                      path: "allowed.md",
                      content: "written without ask\n"
                    })
                  }
                }, {
                  index: 1,
                  id: "call_allowed_git",
                  type: "function",
                  function: {
                    name: "shell_exec",
                    arguments: JSON.stringify({
                      command: "git --version",
                      timeout_ms: 30000
                    })
                  }
                }]
              },
              finish_reason: null
            }]
          },
          {
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "tool_calls"
            }]
          }
        ]);
        return;
      }

      assert.ok(request.messages.some((message: Record<string, unknown>) => (
        message.role === "tool"
        && String(message.content ?? "").includes("allowed.md")
      )));
      assert.ok(request.messages.some((message: Record<string, unknown>) => (
        message.role === "tool"
        && String(message.content ?? "").includes("git version")
      )));
      writeSse(res, [
        {
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              content: "Allowed tools completed."
            },
            finish_reason: "stop"
          }]
        }
      ]);
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createImplicitSkillInvocationChatCompletionsServer(command: string): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);
      const hasToolMessage = Array.isArray(request.messages)
        && request.messages.some((message: Record<string, unknown>) => message.role === "tool");

      if (!hasToolMessage) {
        assert.ok(request.tools?.some((tool: Record<string, any>) => tool.function?.name === "shell_exec"));
        writeSse(res, [
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_skill_script",
                  type: "function",
                  function: {
                    name: "shell_exec",
                    arguments: JSON.stringify({
                      command,
                      timeout_ms: 30000
                    })
                  }
                }]
              },
              finish_reason: null
            }]
          },
          {
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "tool_calls"
            }]
          }
        ]);
        return;
      }

      assert.ok(request.messages.some((message: Record<string, unknown>) => (
        message.role === "tool"
        && String(message.content ?? "").includes("script ok")
      )));
      writeFinal(res, "Implicit invocation complete.");
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createImplicitSkillDocReadChatCompletionsServer(skillPath: string): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);
      const hasToolMessage = Array.isArray(request.messages)
        && request.messages.some((message: Record<string, unknown>) => message.role === "tool");

      if (!hasToolMessage) {
        assert.ok(request.tools?.some((tool: Record<string, any>) => tool.function?.name === "file_read"));
        writeSse(res, [
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_skill_doc",
                  type: "function",
                  function: {
                    name: "file_read",
                    arguments: JSON.stringify({ path: skillPath })
                  }
                }]
              },
              finish_reason: null
            }]
          },
          {
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "tool_calls"
            }]
          }
        ]);
        return;
      }

      assert.ok(request.messages.some((message: Record<string, unknown>) => (
        message.role === "tool"
        && String(message.content ?? "").includes("Doc Invocation Skill")
      )));
      writeFinal(res, "Implicit doc invocation complete.");
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createMockUnknownToolChatCompletionsServer(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);
      writeSse(res, [
        {
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [{
                index: 0,
                id: "call_unknown",
                type: "function",
                function: {
                  name: "unknown_tool",
                  arguments: "{}"
                }
              }]
            },
            finish_reason: null
          }]
        },
        {
          choices: [{
            index: 0,
            delta: {},
            finish_reason: "tool_calls"
          }]
        }
      ]);
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createMockMcpChatCompletionsServer(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);
      const hasToolMessage = Array.isArray(request.messages)
        && request.messages.some((message: Record<string, unknown>) => message.role === "tool");

      if (!hasToolMessage) {
        writeSse(res, [
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_mcp",
                  type: "function",
                  function: {
                    name: "mcp_call",
                    arguments: JSON.stringify({
                      server: "testdocs",
                      tool: "search_docs",
                      arguments: { query: "skills" }
                    })
                  }
                }]
              },
              finish_reason: null
            }]
          },
          {
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "tool_calls"
            }]
          }
        ]);
        return;
      }

      assert.ok(request.messages.some((message: Record<string, unknown>) => (
        message.role === "tool"
        && String(message.content ?? "").includes("mcp pong")
      )));
      writeSse(res, [
        {
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              content: "MCP tool result observed."
            },
            finish_reason: "stop"
          }]
        }
      ]);
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createRecoverableToolFailureChatCompletionsServer(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = JSON.parse(body) as Record<string, any>;
      requests.push(request);
      const hasToolMessage = Array.isArray(request.messages)
        && request.messages.some((message: Record<string, unknown>) => message.role === "tool");

      if (!hasToolMessage) {
        writeSse(res, [
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_failing_mcp",
                  type: "function",
                  function: {
                    name: "mcp_call",
                    arguments: JSON.stringify({
                      server: "failingdocs",
                      tool: "search_docs",
                      arguments: { query: "failure" }
                    })
                  }
                }]
              },
              finish_reason: null
            }]
          },
          {
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "tool_calls"
            }]
          }
        ]);
        return;
      }

      assert.ok(request.messages.some((message: Record<string, unknown>) => (
        message.role === "tool"
        && message.tool_call_id === "call_failing_mcp"
        && String(message.content ?? "").includes("\"status\":\"error\"")
        && String(message.content ?? "").includes("tool_failed")
        && String(message.content ?? "").includes("upstream MCP failed")
      )));
      writeFinal(res, "Recovered from tool failure.");
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeSse(res: http.ServerResponse, chunks: Array<Record<string, unknown>>): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeFinal(res: http.ServerResponse, content: string): void {
  writeSse(res, [
    {
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          content
        },
        finish_reason: "stop"
      }]
    }
  ]);
}

function writeJsonCompletion(res: http.ServerResponse, content: string): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content
      },
      finish_reason: "stop"
    }]
  }));
}

function runtimeContextContent(request: Record<string, any>, pattern: RegExp): string {
  const message = runtimeContexts(request).find((content) => pattern.test(content));
  assert.ok(message, `Expected runtime context matching ${pattern}`);
  return message;
}

function runtimeContexts(request: Record<string, any>): string[] {
  return (request.messages ?? [])
    .filter((item: Record<string, unknown>) => item.role === "user")
    .map((item: Record<string, unknown>) => String(item.content ?? ""))
    .filter((content: string) => content.startsWith(RUNTIME_CONTEXT_PREFIX));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stableModelPrefix(request: Record<string, any>): Array<{ role: string; content: string }> {
  const prefix: Array<{ role: string; content: string }> = [];
  for (const message of request.messages ?? []) {
    const role = String(message.role ?? "");
    const content = String(message.content ?? "");
    if (
      role === "system"
      || content.startsWith(RUNTIME_CONTEXT_PREFIX)
      || content.startsWith("# AGENTS.md instructions")
    ) {
      prefix.push({ role, content });
      continue;
    }
    break;
  }
  return prefix;
}

function projectInstructionsContent(request: Record<string, any>): string {
  const message = (request.messages ?? [])
    .filter((item: Record<string, unknown>) => item.role === "user")
    .map((item: Record<string, unknown>) => String(item.content ?? ""))
    .find((content: string) => content.startsWith("# AGENTS.md instructions"));
  assert.ok(message, "Expected AGENTS.md project instructions context");
  return message;
}

async function waitForSocketMessage(
  messages: OutboundMessage[],
  predicate: (message: OutboundMessage) => boolean,
  timeoutMs = 3000
): Promise<OutboundMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for socket message");
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}
