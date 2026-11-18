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
