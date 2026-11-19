import assert from "node:assert/strict";
import type { Writable } from "node:stream";
import { test } from "node:test";
import { APIError } from "@vercel/sandbox";
import { agentBoxProviderFromEnvironment } from "./open.js";
import { BoxFileMissing, BoxNameTaken, BoxToolError, BoxUnavailable } from "./ports.js";
import { VercelSandboxProvider, type SandboxRuntime } from "./vercelSandbox.js";

const apiError = (status: number, message: string, errorCode = "bad_request") => new APIError(new Response(null, { status }), { message, json: { error: { code: errorCode, message } } });

type Outcome = { exitCode?: number; out?: string; err?: string; logsFail?: Error; hang?: boolean };
/** A fake SDK sandbox: commands follow `outcomes` in turn (the last repeats; an Error is the platform refusing to start the command); records every call. */
const fakeBox = (outcomes: (Outcome | Error)[] = [{}]) => {
  const box = {
    started: [] as { cmd: string; args: string[]; cwd: string }[], killed: [] as (string | undefined)[], files: new Map<string, Buffer>(), runs: 0,
    async runCommand(params: { cmd: string; args: string[]; cwd: string; stdout: Writable; stderr: Writable; onStart: (command: unknown) => void }) {
      const outcome = outcomes[Math.min(box.runs++, outcomes.length - 1)]!;
      if (outcome instanceof Error) throw outcome;
      box.started.push({ cmd: params.cmd, args: params.args, cwd: params.cwd });
      params.onStart({ kill: async (signal?: string) => { box.killed.push(signal); } });
      if (outcome.hang) await new Promise(() => undefined);
      if (outcome.out) params.stdout.write(outcome.out);
      if (outcome.err) params.stderr.write(outcome.err);
      if (outcome.logsFail) throw outcome.logsFail;
      return { exitCode: outcome.exitCode ?? 0 };
    },
    async readFileToBuffer({ path }: { path: string }) { return box.files.get(path) ?? null; },
    async writeFiles(files: { path: string; content: Buffer }[]) { for (const file of files) box.files.set(file.path, file.content); },
    async stop() { return undefined; }
  };
  return box;
};
const providerOf = (runtime: Partial<SandboxRuntime>) => new VercelSandboxProvider({ get: async () => { throw apiError(404, "none", "not_found"); }, create: async () => fakeBox(), ...runtime } as SandboxRuntime, { image: "img", region: "sin1", workDir: "/home/agent/work", retryBackoffMs: [1, 1, 1], imageBackoffMs: [1, 1] });
const boxOf = (sdk: ReturnType<typeof fakeBox>) => providerOf({ create: async () => sdk as never }).create("hatch-x");
const run = { cwd: "/home/agent/work", timeoutSeconds: 30 };

test("find is undefined for a name with no sandbox, and the sandbox otherwise", async () => {
  assert.equal(await providerOf({}).find("hatch-a"), undefined);
  assert.ok(await providerOf({ get: async () => fakeBox() as never }).find("hatch-a"));
});

test("find retries a platform failure and reports a refusal as the service unavailable", async () => {
  let calls = 0;
  const flaky = providerOf({ get: async () => { if (calls++ < 2) throw apiError(503, "upstream"); return fakeBox() as never; } });
  assert.ok(await flaky.find("hatch-a"));
  assert.equal(calls, 3);
  await assert.rejects(providerOf({ get: async () => { throw apiError(401, "bad token", "forbidden"); } }).find("hatch-a"), BoxUnavailable);
});

test("create is BoxNameTaken when the name exists, waits for an image still being prepared, and makes the working directory", async () => {
  await assert.rejects(providerOf({ create: async () => { throw apiError(400, "A sandbox with the name 'x' already exists for this project."); } }).create("x"), BoxNameTaken);
  let calls = 0;
  const sdk = fakeBox();
  const created = await providerOf({ create: async () => { if (calls++ < 2) throw apiError(409, "not ready", "image_not_ready"); return sdk as never; } }).create("hatch-x");
  assert.ok(created);
  assert.equal(calls, 3);
  assert.deepEqual(sdk.started[0]!.args.slice(-1), ["mkdir -p -- '/home/agent/work'"]);
  assert.equal(sdk.started[0]!.cwd, "/");
});

test("exec keeps stdout and stderr apart and returns the exit code, under a deadline that kills the process group", async () => {
  const sdk = fakeBox([{}, { exitCode: 7, out: "out\n", err: "err\n" }]);
  const result = await (await boxOf(sdk)).exec("echo out; exit 7", run);
  assert.deepEqual(result, { exitCode: 7, stdout: "out\n", stderr: "err\n" });
  assert.deepEqual(sdk.started[1], { cmd: "timeout", args: ["-k", "5", "30", "bash", "-c", "echo out; exit 7"], cwd: "/home/agent/work" });
});

test("a command that outran its deadline exits 124, as the port promises", async () => {
  const sdk = fakeBox([{}, { exitCode: 124, out: "partial" }]);
  const result = await (await boxOf(sdk)).exec("sleep 99", { ...run, timeoutSeconds: 5 });
  assert.equal(result.exitCode, 124);
  assert.equal(result.stdout, "partial");
  assert.match(result.stderr, /longer than 5 seconds/);
});

test("a command that ends in a kill before its deadline keeps its own exit code", async () => {
  const result = await (await boxOf(fakeBox([{}, { exitCode: 137 }]))).exec("run-out-of-memory", run);
  assert.equal(result.exitCode, 137);
});

test("a command the platform refused to start is retried and returns the success", async () => {
  const sdk = fakeBox([{}, apiError(503, "upstream"), new TypeError("fetch failed"), { out: "ok" }]);
  const result = await (await boxOf(sdk)).exec("true", run);
  assert.equal(result.stdout, "ok");
  assert.equal(sdk.started.length, 2);
});

test("retries are bounded: a platform that stays down is the service unavailable", async () => {
  const sdk = fakeBox([{}, apiError(503, "upstream")]);
  await assert.rejects((await boxOf(sdk)).exec("true", run), BoxUnavailable);
  assert.equal(sdk.runs, 5);
});

test("a command that has started is never run again when the platform fails after that", async () => {
  const sdk = fakeBox([{}, { out: "half", logsFail: new Error("stream lost") }]);
  await assert.rejects((await boxOf(sdk)).exec("deploy", run), BoxUnavailable);
  assert.equal(sdk.started.length, 2);
});

test("a call of the model's own that the platform rejects is not retried", async () => {
  const sdk = fakeBox([{}, apiError(400, "[internal] failed to start command: chdir /gone: no such file or directory", "command_failed")]);
  await assert.rejects((await boxOf(sdk)).exec("pwd", { ...run, cwd: "/gone" }), BoxToolError);
  assert.equal(sdk.runs, 2);
});

test("aborting stops the command with a signal its process group hears, and rejects with the reason", async () => {
  const sdk = fakeBox([{}, { hang: true }]);
  const box = await boxOf(sdk);
  const controller = new AbortController();
  const pending = box.exec("sleep 99", { ...run, signal: controller.signal });
  setTimeout(() => controller.abort(new Error("stop")), 5);
  await assert.rejects(pending, /stop/);
  assert.deepEqual(sdk.killed, ["SIGTERM"]);
});

test("files: a missing file is BoxFileMissing, and a write reaches the box", async () => {
  const sdk = fakeBox();
  const box = await boxOf(sdk);
  await assert.rejects(box.readFile("/home/agent/work/none"), BoxFileMissing);
  await box.writeFile("/home/agent/work/a/b.png", Buffer.from([1, 2, 3]));
  assert.deepEqual(await box.readFile("/home/agent/work/a/b.png"), Buffer.from([1, 2, 3]));
});

test("file calls retry a platform failure", async () => {
  const sdk = fakeBox();
  const box = await boxOf(sdk);
  let failures = 2;
  const real = sdk.writeFiles.bind(sdk);
  sdk.writeFiles = async files => { if (failures-- > 0) throw apiError(502, "gateway"); return real(files); };
  await box.writeFile("/w/x", Buffer.from("x"));
  assert.equal(failures, -1);
});

test("the provider is chosen by HATCH_AGENT_BOX_PROVIDER, BoxLite by default", () => {
  const vercel = { VERCEL_TOKEN: "t", VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "prj" };
  assert.equal(agentBoxProviderFromEnvironment({ ...vercel }), undefined);
  assert.ok(agentBoxProviderFromEnvironment({ ...vercel, HATCH_AGENT_BOX_PROVIDER: "vercel" }) instanceof VercelSandboxProvider);
  assert.equal(agentBoxProviderFromEnvironment({ HATCH_AGENT_BOX_PROVIDER: "vercel", VERCEL_TOKEN: "t" }), undefined);
  assert.ok(agentBoxProviderFromEnvironment({ BOXLITE_API_KEY: "k" }));
  assert.throws(() => agentBoxProviderFromEnvironment({ HATCH_AGENT_BOX_PROVIDER: "nope" }), /boxlite" or "vercel/);
});
