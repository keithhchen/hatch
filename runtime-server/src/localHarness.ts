import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface as createLineReader, type Interface as LineReader } from "node:readline";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import {
  parseInboundMessage,
  PROTOCOL_VERSION,
  type ClientToolName,
  type OutboundMessage,
  type ToolRequest,
  type ToolResult
} from "./protocol.js";

const execFileAsync = promisify(execFile);
const MAX_WORKSPACE_DIFF_BYTES = 64 * 1024;

export type HarnessOptions = {
  serverUrl: string;
  workspace: string;
  conversationId?: string;
  allowShell?: boolean;
  localTools?: ClientToolName[];
  rustRunnerBin?: string;
  holdToolRequests?: boolean;
  approveTool?: (request: ToolRequest) => boolean | Promise<boolean>;
};

export type OneShotHarnessOptions = HarnessOptions & {
  prompt: string;
};

export type HarnessResult = {
  finalText: string;
  events: OutboundMessage[];
};

type PendingRun = {
  runId: string;
  resolve: (result: HarnessResult) => void;
  reject: (error: Error) => void;
  events: OutboundMessage[];
  timeout: NodeJS.Timeout;
  streamedText: string;
  finalText?: string;
  completed: boolean;
};

type PendingSidecarRequest = {
  resolve: (result: ToolResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

class RustSidecarToolExecutor {
  private child?: ChildProcessWithoutNullStreams;
  private stdoutLines?: LineReader;
  private readonly pending = new Map<string, PendingSidecarRequest>();
  private stderrTail = "";

  constructor(
    private readonly bin: string,
    private readonly workspace: string
  ) {}

  execute(request: ToolRequest): Promise<ToolResult> {
    this.ensureStarted();
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      throw new Error("Rust local runner sidecar is not available");
    }

    const key = sidecarRequestKey(request.run_id, request.tool_call_id);
    if (this.pending.has(key)) {
      throw new Error(`Duplicate local tool request id: ${request.tool_call_id}`);
    }

    return new Promise<ToolResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`Timed out waiting for Rust local runner result: ${request.name}`));
      }, 180000);

      this.pending.set(key, { resolve, reject, timeout });
      child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(key);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(key);
        pending.reject(error);
      });
    });
  }

  close(): void {
    this.rejectAll(new Error("Rust local runner sidecar closed"));
    this.stdoutLines?.close();
    this.stdoutLines = undefined;
    this.child?.kill();
    this.child = undefined;
  }

  private ensureStarted(): void {
    if (this.child && !this.child.killed) {
      return;
    }

    this.stderrTail = "";
    const child = spawn(this.bin, ["--sandbox", this.workspace, "serve"], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000);
    });

    this.stdoutLines = createLineReader({ input: child.stdout });
    this.stdoutLines.on("line", (line) => {
      this.handleLine(line);
    });

    child.once("error", (error) => {
      this.rejectAll(error);
    });

    child.once("exit", (code, signal) => {
      const suffix = this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : "";
      this.rejectAll(new Error(`Rust local runner exited with code ${code ?? "null"} signal ${signal ?? "null"}${suffix}`));
      this.stdoutLines?.close();
      this.stdoutLines = undefined;
      this.child = undefined;
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let message: ToolResult;
    try {
      const raw = JSON.parse(line) as unknown;
      if (isSidecarError(raw)) {
        this.rejectAll(new Error(sidecarErrorText(raw)));
        return;
      }
      const parsed = parseInboundMessage(raw);
      if (parsed.type !== "tool_call.result") {
        throw new Error(`expected tool_call.result, got ${parsed.type}`);
      }
      message = parsed;
    } catch (error) {
      this.rejectAll(new Error(`Invalid Rust local runner JSONL output: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    const key = sidecarRequestKey(message.run_id, message.tool_call_id);
    const pending = this.pending.get(key);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(key);
    pending.resolve(message);
  }

  private rejectAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class LocalHarnessSession {
  private readonly workspace: string;
  private readonly rustRunnerBin?: string;
  private rustSidecar?: RustSidecarToolExecutor;
  private socket?: WebSocket;
  private pendingRun?: PendingRun;
  private heldToolRequests: ToolRequest[] = [];
  private ready = false;

  constructor(private readonly options: HarnessOptions) {
    this.workspace = path.resolve(options.workspace);
    this.rustRunnerBin = nonEmptyString(options.rustRunnerBin ?? process.env.HATCH_LOCAL_RUNNER_BIN);
  }

  async connect(): Promise<void> {
    await mkdir(this.workspace, { recursive: true });
    const socket = new WebSocket(this.options.serverUrl);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    socket.on("message", (data) => {
      void this.handleMessage(data).catch((error) => {
        this.rejectPending(error instanceof Error ? error : new Error(String(error)));
      });
    });

    socket.once("close", () => {
      this.ready = false;
      this.rejectPending(new Error("Runtime socket closed"));
    });

    const readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.off("message", checkReady);
        reject(new Error("Timed out waiting for session.ready"));
      }, 30000);
      const checkReady = (data: WebSocket.RawData) => {
        const message = JSON.parse(String(data)) as OutboundMessage;
        if (message.type === "session.ready") {
          clearTimeout(timeout);
          socket.off("message", checkReady);
          this.ready = true;
          resolve();
        } else if (message.type === "turn.failed") {
          clearTimeout(timeout);
          socket.off("message", checkReady);
          reject(new Error(message.error.message));
        }
      };
      socket.on("message", checkReady);
    });

    socket.send(JSON.stringify({
      type: "client.hello",
      protocol_version: PROTOCOL_VERSION,
      installation_id: "local-dev-install",
      license_token: "local-dev-license",
      client_version: "0.1.0",
      workspace_root: this.workspace,
      local_tools: this.declaredLocalTools()
    }));

    await readyPromise;
  }

  async run(prompt: string): Promise<HarnessResult> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.ready) {
      throw new Error("Harness session is not connected");
    }
    if (this.pendingRun) {
      throw new Error("A run is already active");
    }

    const runId = `run_${Date.now()}`;

    const result = await new Promise<HarnessResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRun = undefined;
        reject(new Error("Timed out waiting for runtime final output"));
      }, 180000);

      this.pendingRun = { runId, resolve, reject, events: [], timeout, streamedText: "", completed: false };
      this.socket?.send(JSON.stringify({
        type: "client.message",
        run_id: runId,
        conversation_id: this.options.conversationId ?? "local-dev-conversation",
        message: { role: "user", content: prompt }
      }));
    });

    return result;
  }

  close(): void {
    this.rustSidecar?.close();
    this.rustSidecar = undefined;
    this.socket?.close();
  }

  cancelActiveRun(reason = "Client requested cancellation"): void {
    if (!this.socket || !this.pendingRun) return;
    this.socket.send(JSON.stringify({
      type: "turn.cancel",
      run_id: this.pendingRun.runId,
      reason
    }));
  }

  private async handleMessage(data: WebSocket.RawData): Promise<void> {
    const message = JSON.parse(String(data)) as OutboundMessage;

    if (message.type === "session.ready") {
      return;
    }

    if (message.type === "tool_call.request") {
      this.pendingRun?.events.push(message);
      if (this.options.holdToolRequests) {
        this.heldToolRequests.push(message);
        return;
      }
      if (message.approval === "ask" && this.options.approveTool && !await this.options.approveTool(message)) {
        this.socket?.send(JSON.stringify({
          type: "tool_call.result",
          run_id: message.run_id,
          tool_call_id: message.tool_call_id,
          status: "error",
          error: {
            code: "approval_denied",
            message: `Tool call rejected by user: ${message.name}`
          }
        }));
        return;
      }
      const result = await this.executeToolRequest(message);
      this.socket?.send(JSON.stringify(result));
      return;
    }

    if (this.pendingRun) {
      this.pendingRun.events.push(message);
    }

    if (message.type === "assistant.delta" && message.delta.kind === "text" && this.pendingRun) {
      this.pendingRun.streamedText += message.delta.content;
    }

    if (message.type === "turn.completed") {
      const pending = this.pendingRun;
      if (!pending) return;
      pending.finalText = message.output.map((item) => item.content).join("\n");
      this.resolveCompletedRun();
      return;
    }

    if (message.type === "turn.state" && message.status === "completed") {
      if (!this.pendingRun) return;
      this.pendingRun.completed = true;
      this.resolveCompletedRun();
      return;
    }

    if (message.type === "turn.failed") {
      this.rejectPending(new Error(message.error.message));
    }
  }

  private rejectPending(error: Error): void {
    if (!this.pendingRun) return;
    const pending = this.pendingRun;
    this.pendingRun = undefined;
    clearTimeout(pending.timeout);
    pending.reject(error);
  }

  private resolveCompletedRun(): void {
    const pending = this.pendingRun;
    if (!pending || !pending.completed || pending.finalText === undefined) return;
    this.pendingRun = undefined;
    clearTimeout(pending.timeout);
    pending.resolve({
      finalText: pending.finalText,
      events: pending.events
    });
  }

  async flushHeldToolRequests(): Promise<void> {
    if (!this.socket) return;
    const requests = this.heldToolRequests.splice(0);
    for (const request of requests) {
      const result = await this.executeToolRequest(request);
      this.socket.send(JSON.stringify(result));
    }
  }

  private async executeToolRequest(request: ToolRequest): Promise<ToolResult> {
    const enabled = new Set(this.declaredLocalTools());
    if (!enabled.has(request.name as ClientToolName)) {
      return toolCallError(request, "tool_disabled", `Local tool is not enabled for this harness: ${request.name}`);
    }
    if (request.name === "shell.exec" && !this.options.allowShell) {
      return toolCallError(request, "tool_disabled", "shell.exec is disabled for this harness run");
    }

    if (this.rustRunnerBin) {
      this.rustSidecar ??= new RustSidecarToolExecutor(this.rustRunnerBin, this.workspace);
      try {
        return await this.rustSidecar.execute(request);
      } catch (error) {
        return toolCallError(request, "tool_failed", error instanceof Error ? error.message : String(error));
      }
    }

    return executeLocalTool(request, this.workspace, Boolean(this.options.allowShell));
  }

  private declaredLocalTools(): ClientToolName[] {
    return this.options.localTools ?? enabledTools(Boolean(this.options.allowShell));
  }
}

export async function runLocalHarness(options: OneShotHarnessOptions): Promise<HarnessResult> {
  const session = new LocalHarnessSession(options);
  await session.connect();
  try {
    return await session.run(options.prompt);
  } finally {
    session.close();
  }
}

export async function runInteractiveChat(options: HarnessOptions): Promise<void> {
  const rl = readline.createInterface({ input, output });
  const session = new LocalHarnessSession({
    ...options,
    approveTool: async (request) => {
      const answer = (await rl.question(`approve ${request.name}? [y/N] `)).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    }
  });
  await session.connect();

  console.log("Connected to Hatch runtime");
  console.log(`Workspace: ${path.resolve(options.workspace)}`);
  console.log("Type /exit to quit.");

  try {
    while (true) {
      const prompt = (await rl.question("\nyou> ")).trim();
      if (!prompt) continue;
      if (prompt === "/exit" || prompt === "/quit") break;

      const result = await session.run(prompt);
      console.log(`\nassistant> ${result.finalText}`);
      const toolNames = result.events
        .filter((event): event is Extract<OutboundMessage, { type: "tool_call.delta" }> => event.type === "tool_call.delta" && event.status === "requested")
        .map((event) => event.name);
      if (toolNames.length) {
        console.log(`tools> ${toolNames.join(", ")}`);
      }
    }
  } finally {
    rl.close();
    session.close();
  }
}

function enabledTools(allowShell: boolean): ClientToolName[] {
  const tools: ClientToolName[] = [
    "fs.list",
    "fs.search",
    "fs.read",
    "fs.write",
    "fs.patch",
    "git.diff"
  ];
  if (allowShell) {
    tools.push("shell.exec");
  }
  return tools;
}

export async function executeLocalTool(
  request: ToolRequest,
  workspace: string,
  allowShell: boolean
): Promise<ToolResult> {
  try {
    let result: Record<string, unknown>;
    if (request.name === "fs.list") {
      result = await fsList(workspace, stringArg(request, "path", "."));
    } else if (request.name === "fs.search") {
      result = await fsSearch(
        workspace,
        stringArg(request, "query"),
        stringArg(request, "path", "."),
        numberArg(request, "max_results", 20)
      );
    } else if (request.name === "fs.read") {
      result = { content: await readFile(resolveWorkspacePath(workspace, stringArg(request, "path")), "utf8") };
    } else if (request.name === "fs.write") {
      const target = resolveWorkspacePath(workspace, stringArg(request, "path"));
      const relativePath = path.relative(workspace, target);
      const before = await readUtf8IfExists(target);
      await mkdir(path.dirname(target), { recursive: true });
      const content = stringArg(request, "content");
      await writeFile(target, content, "utf8");
      result = withWorkspaceDiff({ ok: true, path: relativePath }, before, content);
    } else if (request.name === "fs.patch") {
      result = await fsPatch(workspace, stringArg(request, "path"), stringArg(request, "patch"));
    } else if (request.name === "shell.exec") {
      if (!allowShell) {
        throw new Error("shell.exec is disabled for this harness run");
      }
      result = await shellExec(workspace, stringArg(request, "command"), numberArg(request, "timeout_ms", 30000));
    } else if (request.name === "git.diff") {
      result = await gitDiff(workspace, stringArg(request, "path", "."));
    } else {
      throw new Error(`Unsupported client tool: ${request.name}`);
    }

    return {
      type: "tool_call.result",
      run_id: request.run_id,
      tool_call_id: request.tool_call_id,
      status: "ok",
      result
    };
  } catch (error) {
    return toolCallError(request, "tool_failed", error instanceof Error ? error.message : String(error));
  }
}

async function fsList(workspace: string, relativePath: string): Promise<Record<string, unknown>> {
  const dir = resolveWorkspacePath(workspace, relativePath);
  const entries = await readdir(dir, { withFileTypes: true });
  return {
    entries: await Promise.all(entries.map(async (entry) => {
      const absolute = path.join(dir, entry.name);
      const info = await stat(absolute);
      return {
        path: path.relative(workspace, absolute),
        kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        len: info.size
      };
    }))
  };
}

async function fsSearch(
  workspace: string,
  query: string,
  relativePath: string,
  maxResults: number
): Promise<Record<string, unknown>> {
  const root = resolveWorkspacePath(workspace, relativePath);
  const files = await collectFiles(root);
  const matches: Array<Record<string, unknown>> = [];

  for (const file of files) {
    if (matches.length >= maxResults) break;
    const content = await readFile(file, "utf8").catch(() => "");
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]?.includes(query)) {
        matches.push({
          path: path.relative(workspace, file),
          line_number: index + 1,
          text: lines[index]
        });
        if (matches.length >= maxResults) break;
      }
    }
  }

  return { matches };
}

async function fsPatch(workspace: string, relativePath: string, patch: string): Promise<Record<string, unknown>> {
  const target = resolveWorkspacePath(workspace, relativePath);
  const content = await readFile(target, "utf8");
  let next = content;

  if (patch.startsWith("HATCH-PATCH v1\nappend\n---\n")) {
    next = `${content}${patch.slice("HATCH-PATCH v1\nappend\n---\n".length)}`;
  } else {
    const match = patch.match(/^HATCH-PATCH v1\nreplace\n--- old\n([\s\S]*?)\n--- new\n([\s\S]*)$/);
    if (!match) {
      throw new Error("Unsupported patch format");
    }
    const [, oldText, newText] = match;
    const count = content.split(oldText).length - 1;
    if (count !== 1) {
      throw new Error(`Patch expected exactly one occurrence, found ${count}`);
    }
    next = content.replace(oldText, newText);
  }

  await writeFile(target, next, "utf8");
  return withWorkspaceDiff({ ok: true, path: path.relative(workspace, target) }, content, next);
}

async function readUtf8IfExists(target: string): Promise<string | undefined> {
  return readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    return undefined;
  });
}

function withWorkspaceDiff(
  result: Record<string, unknown> & { path: string },
  before: string | undefined,
  after: string
): Record<string, unknown> {
  const rendered = renderWorkspaceDiff(result.path, before, after);
  if (!rendered) return result;
  return {
    ...result,
    diff: rendered.diff,
    ...(rendered.truncated ? { diff_truncated: true } : {})
  };
}

function renderWorkspaceDiff(
  relativePath: string,
  before: string | undefined,
  after: string
): { diff: string; truncated: boolean } | undefined {
  if (before === after) return undefined;
  const beforeLabel = before === undefined ? "/dev/null" : `a/${relativePath}`;
  const lines = [
    `--- ${beforeLabel}`,
    `+++ b/${relativePath}`,
    "@@",
    ...prefixDiffLines("-", before ?? ""),
    ...prefixDiffLines("+", after)
  ];
  let diff = `${lines.join("\n")}\n`;
  let truncated = false;
  if (Buffer.byteLength(diff, "utf8") > MAX_WORKSPACE_DIFF_BYTES) {
    diff = truncateUtf8(diff, MAX_WORKSPACE_DIFF_BYTES);
    truncated = true;
  }
  return { diff, truncated };
}

function prefixDiffLines(prefix: "-" | "+", content: string): string[] {
  if (content.length === 0) return [];
  return content.split(/\r?\n/).map((line) => `${prefix}${line}`);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const suffix = "\n[diff truncated]\n";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let end = value.length;
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > budget) {
    end -= 1;
  }
  return `${value.slice(0, end)}${suffix}`;
}

async function shellExec(workspace: string, command: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const { stdout, stderr } = await execFileAsync("sh", ["-lc", command], {
    cwd: workspace,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024
  });
  return { stdout, stderr, exit_code: 0 };
}

async function gitDiff(workspace: string, relativePath: string): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync("git", ["diff", "--", relativePath], {
    cwd: workspace,
    timeout: 30000,
    maxBuffer: 1024 * 1024
  });
  return { diff: stdout };
}

async function collectFiles(root: string): Promise<string[]> {
  const info = await stat(root);
  if (info.isFile()) {
    return [root];
  }

  const output: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      output.push(...await collectFiles(absolute));
    } else if (entry.isFile()) {
      output.push(absolute);
    }
  }
  return output.sort();
}

function resolveWorkspacePath(workspace: string, relativePath: string): string {
  const resolved = path.resolve(workspace, relativePath);
  if (resolved !== workspace && !resolved.startsWith(`${workspace}${path.sep}`)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
  return resolved;
}

function stringArg(request: ToolRequest, key: string, fallback?: string): string {
  const value = request.arguments[key];
  if (typeof value === "string") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing string argument: ${key}`);
}

function numberArg(request: ToolRequest, key: string, fallback: number): number {
  const value = request.arguments[key];
  return typeof value === "number" ? value : fallback;
}

function toolCallError(request: ToolRequest, code: string, message: string): ToolResult {
  return {
    type: "tool_call.result",
    run_id: request.run_id,
    tool_call_id: request.tool_call_id,
    status: "error",
    error: { code, message }
  };
}

function sidecarRequestKey(runId: string, toolCallId: string): string {
  return `${runId}\u0000${toolCallId}`;
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isSidecarError(value: unknown): value is { type: "sidecar.error"; error?: { code?: unknown; message?: unknown } } {
  return Boolean(value)
    && typeof value === "object"
    && (value as Record<string, unknown>).type === "sidecar.error";
}

function sidecarErrorText(value: { error?: { code?: unknown; message?: unknown } }): string {
  const code = typeof value.error?.code === "string" ? value.error.code : "sidecar_error";
  const message = typeof value.error?.message === "string" ? value.error.message : "Rust local runner sidecar returned an error";
  return `${code}: ${message}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 1) {
    const key = process.argv[index] ?? "";
    if (!key.startsWith("--")) {
      continue;
    }
    const next = process.argv[index + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      index += 1;
    } else {
      args.set(key, "true");
    }
  }

  const serverUrl = args.get("--server") ?? "ws://127.0.0.1:8400/runtime";
  const workspace = args.get("--workspace") ?? process.cwd();
  const conversationId = args.get("--conversation") ?? "local-dev-conversation";
  const prompt = args.get("--prompt");
  const rustRunnerBin = args.get("--rust-runner") ?? process.env.HATCH_LOCAL_RUNNER_BIN;
  const baseOptions = {
    serverUrl,
    workspace,
    conversationId,
    allowShell: args.has("--allow-shell"),
    rustRunnerBin
  };

  const task = prompt
    ? runLocalHarness({ ...baseOptions, prompt }).then((result) => {
      console.log(result.finalText);
      if (args.has("--trace")) {
        const toolNames = result.events
          .filter((event) => event.type === "tool_call.request")
          .map((event) => event.name);
        console.log(`\nTrace tools: ${toolNames.length ? toolNames.join(", ") : "none"}`);
      }
    })
    : runInteractiveChat(baseOptions);

  task.catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
