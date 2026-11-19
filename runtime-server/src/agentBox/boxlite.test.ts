import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxliteProvider } from "./boxlite.js";
import { BoxUnavailable } from "./ports.js";

/** An SDK box whose every command ends with `result`. */
const sdkBox = (result: { exitCode: number; errorMessage?: string }) => ({
  async exec() {
    const empty = { next: async () => null };
    return { stdout: async () => empty, stderr: async () => empty, wait: async () => result, kill: async () => undefined };
  }
}) as never;

test("a create that times out while the box starts waits for the box instead of failing", async () => {
  let polls = 0;
  const box = sdkBox({ exitCode: 0 });
  const provider = new BoxliteProvider({
    create: async () => { throw new Error("internal error: server timed out: Timed out waiting for box abc to reach started"); },
    getInfo: async () => ({ state: { status: polls < 2 ? "starting" : "running", running: ++polls > 2 } }) as never,
    get: async () => box
  }, { image: "img", workDir: "/home/agent/work", startPollMs: 1 });
  const created = await provider.create("hatch-x");
  assert.equal((await created.exec("true", { cwd: "/", timeoutSeconds: 5 })).exitCode, 0);
  assert.equal(polls, 3);
});

test("a dropped connection to the box is the service unavailable, not the command's error", async () => {
  const provider = new BoxliteProvider({
    create: async () => sdkBox({ exitCode: 1, errorMessage: "WS connect failed: network error: upstream returned HTTP 503" }),
    getInfo: async () => null, get: async () => null
  }, { image: "img", workDir: "/home/agent/work" });
  await assert.rejects(provider.create("hatch-y"), BoxUnavailable);
});

test("boxes get outbound network to every host", async () => {
  const created: unknown[] = [];
  const runtime = { create: async (options: unknown) => { created.push(options); return sdkBox({ exitCode: 0 }); }, getInfo: async () => null, get: async () => null } as never;
  const provider = BoxliteProvider.fromEnvironment({ BOXLITE_API_KEY: "k" }, () => runtime)!;
  await provider.create("hatch-z");
  assert.deepEqual((created[0] as { network: unknown }).network, { outbound: { mode: "enabled", allowNet: [] } });
});

/** An SDK box whose commands follow `outcomes` in turn (the last repeats); counts the runs. */
const scripted = (outcomes: { exitCode: number; errorMessage?: string; output?: string }[]) => {
  const box = {
    runs: 0,
    async exec() {
      const outcome = outcomes[Math.min(box.runs++, outcomes.length - 1)]!;
      const chunks = outcome.output ? [outcome.output] : [];
      const stdout = { next: async () => chunks.shift() ?? null }, empty = { next: async () => null };
      return { stdout: async () => stdout, stderr: async () => empty, wait: async () => outcome, kill: async () => undefined };
    }
  };
  return box;
};
const unavailable503 = { exitCode: 1, errorMessage: "WS connect failed: network error: upstream returned HTTP 503" };
const boxOf = async (sdk: unknown) => new BoxliteProvider({ create: async () => sdk as never, getInfo: async () => null, get: async () => null }, { image: "img", workDir: "/w", retryBackoffMs: [1, 1, 1] }).create("hatch-r");

test("an exec refused with a 503 is retried and returns the success", async () => {
  const sdk = scripted([{ exitCode: 0 }, unavailable503, unavailable503, { exitCode: 0, output: "ok" }]);
  const box = await boxOf(sdk);
  const result = await box.exec("echo ok", { cwd: "/", timeoutSeconds: 5 });
  assert.equal(result.stdout, "ok");
  assert.equal(sdk.runs, 4);
});

test("four refusals in a row are BoxUnavailable", async () => {
  const sdk = scripted([{ exitCode: 0 }, unavailable503]);
  const box = await boxOf(sdk);
  await assert.rejects(box.exec("true", { cwd: "/", timeoutSeconds: 5 }), BoxUnavailable);
  assert.equal(sdk.runs, 5);
});

const exit0Unavailable = { exitCode: 0, errorMessage: unavailable503.errorMessage };

test("an exit-0 result with a 503 error and no output never ran: retried, then the success", async () => {
  const sdk = scripted([{ exitCode: 0 }, exit0Unavailable, { exitCode: 0, output: "ok" }]);
  const result = await (await boxOf(sdk)).exec("echo ok", { cwd: "/", timeoutSeconds: 5 });
  assert.equal(result.stdout, "ok");
  assert.equal(sdk.runs, 3);
});

test("four exit-0 transport failures in a row are BoxUnavailable", async () => {
  const sdk = scripted([{ exitCode: 0 }, exit0Unavailable]);
  await assert.rejects((await boxOf(sdk)).exec("true", { cwd: "/", timeoutSeconds: 5 }), BoxUnavailable);
  assert.equal(sdk.runs, 5);
});

test("an exit-0 result with real output and an error message is not run again", async () => {
  const sdk = scripted([{ exitCode: 0 }, { ...exit0Unavailable, output: "done" }]);
  const result = await (await boxOf(sdk)).exec("true", { cwd: "/", timeoutSeconds: 5 });
  assert.equal(result.stdout, "done");
  assert.equal(sdk.runs, 2);
});

test("a command that printed output before the transport failure is not run again", async () => {
  const sdk = scripted([{ exitCode: 0 }, { ...unavailable503, output: "half" }]);
  const box = await boxOf(sdk);
  await assert.rejects(box.exec("true", { cwd: "/", timeoutSeconds: 5 }), BoxUnavailable);
  assert.equal(sdk.runs, 2);
});

test("an abort during the backoff stops the retries", async () => {
  const sdk = scripted([{ exitCode: 0 }, unavailable503]);
  const box = await new BoxliteProvider({ create: async () => sdk as never, getInfo: async () => null, get: async () => null }, { image: "img", workDir: "/w", retryBackoffMs: [50, 50, 50] }).create("hatch-a");
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("stop")), 10);
  await assert.rejects(box.exec("true", { cwd: "/", timeoutSeconds: 5, signal: controller.signal }), /stop/);
  assert.equal(sdk.runs, 2);
});

test("an exec the service refused with a rate limit or its own database error is retried", async () => {
  for (const message of ["resource exhausted: Rate exceeded.", "internal error: Audit database connection unavailable", "unauthenticated: Invalid credentials"]) {
    const sdk = scripted([{ exitCode: 0 }, { exitCode: 1, errorMessage: message }, { exitCode: 0, output: "ok" }]);
    const result = await (await boxOf(sdk)).exec("echo ok", { cwd: "/", timeoutSeconds: 5 });
    assert.equal(result.stdout, "ok", message);
    assert.equal(sdk.runs, 3);
  }
});

/** An SDK box whose copyOut/copyIn fail with `message` `failures` times, then succeed (copyOut writes "data"). */
const copying = (message: string, failures: number) => {
  const box = {
    ...scripted([{ exitCode: 0 }]), copies: 0,
    async copyOut(_from: string, to: string) { if (box.copies++ < failures) throw new Error(message); await (await import("node:fs/promises")).writeFile(to, "data"); },
    async copyIn() { if (box.copies++ < failures) throw new Error(message); }
  };
  return box;
};

test("copies retry with the same backoff as commands: a rate limit twice, then the file", async () => {
  const sdk = copying("resource exhausted: Rate exceeded.", 2);
  const box = await boxOf(sdk);
  assert.equal((await box.readFile("/w/a")).toString(), "data");
  assert.equal(sdk.copies, 3);
  sdk.copies = 0;
  await box.writeFile("/w/a", Buffer.from("x"));
  assert.equal(sdk.copies, 3);
});

test("a copy that keeps failing is BoxUnavailable after the backoff", async () => {
  const sdk = copying("internal error: Audit database connection unavailable", 99);
  await assert.rejects((await boxOf(sdk)).readFile("/w/a"), BoxUnavailable);
  assert.equal(sdk.copies, 4);
});

test("a copy that failed for another reason is not retried", async () => {
  const sdk = copying("disk full", 99);
  await assert.rejects((await boxOf(sdk)).readFile("/w/a"), BoxUnavailable);
  assert.equal(sdk.copies, 1);
});

test("a rate limit waits the longer schedule, a 503 the shorter one", async () => {
  const waits: number[] = [];
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => { waits.push(ms ?? 0); return realTimeout(fn, 0); }) as never;
  try {
    for (const [message, expected] of [["resource exhausted: Rate exceeded.", [3_000, 6_000, 12_000, 24_000]], [unavailable503.errorMessage, [1_000, 3_000, 6_000]]] as const) {
      waits.length = 0;
      const sdk = scripted([{ exitCode: 0 }, { exitCode: 1, errorMessage: message }]);
      const box = await new BoxliteProvider({ create: async () => sdk as never, getInfo: async () => null, get: async () => null }, { image: "img", workDir: "/w" }).create("hatch-w");
      await assert.rejects(box.exec("true", { cwd: "/", timeoutSeconds: 100 }), BoxUnavailable);
      assert.deepEqual(waits.filter(ms => ms >= 1_000 && ms < 50_000), expected);
    }
  } finally { globalThis.setTimeout = realTimeout; }
});

test("a rate-limited exec stops waiting at the tool's own timeout", async () => {
  const sdk = scripted([{ exitCode: 0 }, { exitCode: 1, errorMessage: "resource exhausted: Rate exceeded." }]);
  const box = await new BoxliteProvider({ create: async () => sdk as never, getInfo: async () => null, get: async () => null }, { image: "img", workDir: "/w" }).create("hatch-t");
  const started = Date.now();
  await assert.rejects(box.exec("true", { cwd: "/", timeoutSeconds: 2 }), BoxUnavailable);
  assert.ok(Date.now() - started < 1_000, "gave up at once: the first wait (3 s) already passes the 2 s timeout");
});

test("a write is one request when its directory exists; only a failed copy makes the directory first", async () => {
  const boxWith = async (sdk: ReturnType<typeof copying>) => {
    const commands: string[] = [];
    const exec = sdk.exec.bind(sdk);
    sdk.exec = (async (...args: unknown[]) => { commands.push(String((args[1] as string[])[1])); return exec(); }) as never;
    const box = await boxOf(sdk);
    commands.length = 0;
    await box.writeFile("/w/a/b.txt", Buffer.from("x"));
    return commands;
  };
  const present = copying("x", 0);
  assert.deepEqual(await boxWith(present), []);
  assert.equal(present.copies, 1);
  const missing = copying("no such file or directory", 1);
  assert.deepEqual(await boxWith(missing), ["mkdir -p -- '/w/a'"]);
  assert.equal(missing.copies, 2);
});
