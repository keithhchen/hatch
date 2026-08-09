import { readFile } from "node:fs/promises";
import { AliyunOutputGuard } from "../dist/outputGuard.js";

const fixtureUrl = new URL("../evals/output-disclosure.json", import.meta.url);
const cases = JSON.parse(await readFile(fixtureUrl, "utf8"));
const guard = new AliyunOutputGuard({
  region: process.env.HATCH_OUTPUT_GUARD_REGION?.trim() || "cn-shanghai",
  endpoint: process.env.HATCH_OUTPUT_GUARD_EVAL_ENDPOINT?.trim()
    || "green-cip.cn-shanghai.aliyuncs.com",
  service: process.env.HATCH_OUTPUT_GUARD_SERVICE?.trim()
    || "response_security_check_pro"
});

let failures = 0;

for (const testCase of cases) {
  const runId = `output-guard-eval-${testCase.id}-${Date.now()}`;
  let actual = "pass";
  let elapsedMs = 0;

  for (const [index, content] of testCase.segments.entries()) {
    const startedAt = performance.now();
    actual = await guard.check({
      content,
      chatId: runId,
      sessionId: runId,
      done: index === testCase.segments.length - 1
    });
    elapsedMs += performance.now() - startedAt;
    if (actual === "block") break;
  }

  const matched = actual === testCase.expected;
  if (!matched) failures += 1;
  process.stdout.write(`${matched ? "PASS" : "FAIL"}\t${testCase.id}\t${actual}`
    + `\t${Math.round(elapsedMs)}ms\n`);
}

if (failures > 0) {
  process.stderr.write(`${failures} output-guard eval case(s) failed\n`);
  process.exitCode = 1;
}
