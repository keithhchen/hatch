import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const { WebSocket } = createRequire(path.resolve(process.cwd(), "package.json"))("ws");

const baseUrl = process.env.HATCH_PRODUCTION_URL ?? "https://hatch.tokenquadrant.cn";
const workspace = path.resolve(process.env.HATCH_UAT_WORKSPACE ?? "fixtures/consumer/jordan-signal-resume/workspace");
const artifactPath = process.env.HATCH_UAT_ARTIFACT ?? "production-delivery-final-uat.md";
const prompt = process.env.HATCH_UAT_PROMPT ?? `Read resume.md and target-role.md. Save the complete three evidence-grounded recommendations to ${JSON.stringify(artifactPath)}.`;
const email = `hatch-production-uat-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}@example.com`;
const password = `Uat-${crypto.randomBytes(18).toString("base64url")}-A1`;

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw: raw.slice(0, 200) }; }
  return { response, body };
}

function workspaceTarget(relativePath = ".") {
  const root = path.resolve(workspace);
  const absolute = path.resolve(root, String(relativePath));
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error("Workspace path escaped");
  return { absolute, relative: path.relative(root, absolute) || "." };
}

async function executeLocalTool(request) {
  const args = request.arguments ?? {};
  const target = workspaceTarget(args.path);
  if (request.name === "fs.read") return { content: await fs.readFile(target.absolute, "utf8") };
  if (request.name === "fs.write") {
    await fs.mkdir(path.dirname(target.absolute), { recursive: true });
    await fs.writeFile(target.absolute, String(args.content ?? ""), "utf8");
    return { ok: true, path: target.relative };
  }
  if (request.name === "fs.list") {
    const entries = await fs.readdir(target.absolute, { withFileTypes: true });
    return { entries: entries.map((entry) => ({
      path: path.relative(workspace, path.join(target.absolute, entry.name)),
      kind: entry.isDirectory() ? "directory" : "file"
    })) };
  }
  if (request.name === "fs.search") return { matches: [] };
  throw new Error(`Unsupported UAT tool: ${request.name}`);
}

function fail(stage, status, body) {
  throw new Error(`${stage} failed (${status}): ${body?.error?.code ?? body?.detail ?? "unknown"}`);
}

const signup = await requestJson(`${baseUrl}/v1/auth/signup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password, role: "user", display_name: "Hatch Production UAT Buyer" })
});
if (!signup.response.ok || !signup.body.token) fail("signup", signup.response.status, signup.body);
const token = signup.body.token;

const catalog = await requestJson(`${baseUrl}/v1/catalog/agents`);
if (!catalog.response.ok) fail("catalog", catalog.response.status, catalog.body);
const agent = catalog.body.find((entry) => entry.creator_id === "maya-chen" && entry.product_id === "signal-resume-review");
if (!agent) throw new Error("Published Signal Resume Review Agent was not found");

const checkout = await requestJson(`${baseUrl}/v1/user/checkout`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ creator_id: agent.creator_id, product_id: agent.product_id })
});
if (!checkout.response.ok || !checkout.body.entitlement) fail("checkout", checkout.response.status, checkout.body);
const entitlement = checkout.body.entitlement;
console.log(JSON.stringify({
  stage: "commerce",
  account_id: signup.body.account?.id,
  order_id: checkout.body.order?.order_id,
  entitlement_id: entitlement.entitlement_id,
  agent_id: entitlement.agent_id
}));

const events = [];
const statuses = [];
const toolRequests = [];
const streamedTextLengths = [];
let started = false;
let settled = false;
let resolveRun;
let rejectRun;
const run = new Promise((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
const socket = new WebSocket(baseUrl.replace(/^http/, "ws") + "/v1/runtime");
const deadline = setTimeout(() => finish(new Error("Production UAT timed out"), true), 230_000);

function finish(value, failed = false) {
  if (settled) return;
  settled = true;
  clearTimeout(deadline);
  try { socket.close(); } catch {}
  if (failed) rejectRun(value); else resolveRun(value);
}

socket.on("open", () => socket.send(JSON.stringify({
  type: "client.hello",
  protocol_version: "0.3",
  installation_id: "desktop-production-uat",
  auth_token: token,
  entitlement_id: entitlement.entitlement_id,
  agent_id: entitlement.agent_id,
  creator_id: entitlement.creator_id,
  client_version: "0.1.0",
  workspace_root: workspace,
  local_tools: ["fs.list", "fs.search", "fs.read", "fs.write", "fs.patch", "shell.exec", "git.diff"]
})));

socket.on("message", async (raw) => {
  const message = JSON.parse(raw.toString());
  events.push(message.type);
  if (message.type === "assistant.delta") {
    if (message.delta.kind === "status") statuses.push(message.delta.content);
    if (message.delta.kind === "text") streamedTextLengths.push(String(message.delta.content ?? "").length);
  }
  if (message.type === "session.ready" && !started) {
    started = true;
    socket.send(JSON.stringify({
      type: "client.message",
      run_id: "run_production_uat_delivery",
      conversation_id: "conversation_production_uat_delivery",
      message: {
        role: "user",
        content: prompt
      }
    }));
    return;
  }
  if (message.type === "tool_call.request") {
    toolRequests.push({ name: message.name, path: message.arguments?.path });
    try {
      const result = await executeLocalTool(message);
      socket.send(JSON.stringify({ type: "tool_call.result", run_id: message.run_id, tool_call_id: message.tool_call_id, status: "ok", result }));
    } catch (error) {
      socket.send(JSON.stringify({ type: "tool_call.result", run_id: message.run_id, tool_call_id: message.tool_call_id, status: "error", error: { code: "uat_tool_failed", message: String(error) } }));
    }
    return;
  }
  if (message.type === "turn.completed") {
    finish({
      status: "completed",
      event_count: events.length,
      statuses,
      tool_requests: toolRequests,
      streamed_text_length: streamedTextLengths.reduce((sum, value) => sum + value, 0),
      output_length: (message.output ?? []).reduce((sum, item) => sum + String(item.content ?? "").length, 0)
    });
  }
  if (message.type === "turn.failed") finish(new Error(`turn.failed: ${message.error?.message ?? "unknown"}`), true);
});

socket.on("error", (error) => finish(error, true));
socket.on("close", () => { if (!settled) finish(new Error("Production socket closed before completion"), true); });

try {
  const result = await run;
  const target = workspaceTarget(artifactPath);
  const content = await fs.readFile(target.absolute, "utf8").catch(() => null);
  console.log(JSON.stringify({
    stage: "delivery",
    ...result,
    artifact: content === null
      ? { exists: false, path: target.relative }
      : { exists: true, path: target.relative, bytes: Buffer.byteLength(content), sha256: crypto.createHash("sha256").update(content).digest("hex") }
  }));
} catch (error) {
  console.log(JSON.stringify({ stage: "delivery", status: "failed", message: String(error), event_count: events.length, statuses, tool_requests: toolRequests, streamed_text_length: streamedTextLengths.reduce((sum, value) => sum + value, 0) }));
  process.exitCode = 1;
}
