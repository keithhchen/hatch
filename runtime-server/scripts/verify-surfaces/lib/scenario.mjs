/**
 * The small interface every scenario implements. A scenario starts from a running Stack, drives only real entry points, and
 * returns a Result: PASS, FAIL or BLOCKED, with checks (what was asserted) and measurements (the numbers behind them).
 * A FAIL is a finding, not a tool error: the product is never changed to make a scenario pass.
 */
export class Scenario {
  /** @param {{ id: number|string, title: string, stackOptions?: object }} meta */
  constructor(meta) { Object.assign(this, meta); }
  /** @param {import("./stack.mjs").Stack} stack @param {Recorder} rec */
  async run(stack, rec) { throw new Error("not implemented"); }
}

export class Blocked extends Error {}

/** Collects checks, measurements and evidence for one scenario run. */
export class Recorder {
  constructor() { this.checks = []; this.measurements = {}; this.evidence = {}; this.notes = []; this.defects = []; }
  /** Records an assertion. The first argument is what must hold. */
  check(name, ok, detail) { this.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) }); return Boolean(ok); }
  measure(name, value) { this.measurements[name] = value; return value; }
  note(text) { this.notes.push(text); }
  evidenceOf(name, value) { this.evidence[name] = value; }
  /** A reproducible defect: what happened versus what the spec says. */
  defect({ title, severity = "medium", expected, actual, repro }) { this.defects.push({ title, severity, expected, actual, repro }); }
  block(reason) { throw new Blocked(reason); }
  get passed() { return this.checks.length > 0 && this.checks.every((c) => c.ok); }
}

export class ScenarioRunner {
  constructor({ createStack, log = (line) => process.stderr.write(`${line}\n`) }) { this.createStack = createStack; this.log = log; }

  /** Runs one scenario on a fresh Stack of its own, so a crash scenario can never disturb another. */
  async runOne(scenario) {
    const rec = new Recorder();
    const started = Date.now();
    let stack;
    let status;
    let error;
    this.log(`[${scenario.id}] ${scenario.title} ...`);
    try {
      stack = await this.createStack(scenario);
      await scenario.run(stack, rec);
      status = rec.passed ? "PASS" : "FAIL";
    } catch (thrown) {
      if (thrown instanceof Blocked) { status = "BLOCKED"; error = thrown.message; }
      else { status = "FAIL"; error = `scenario error: ${thrown?.stack ?? thrown}`; rec.check("scenario completed without a tool error", false, String(thrown?.message ?? thrown)); }
    } finally {
      await stack?.down().catch((cleanupError) => this.log(`[${scenario.id}] cleanup: ${cleanupError.message}`));
    }
    const result = { id: scenario.id, title: scenario.title, status, durationMs: Date.now() - started, ...(error ? { reason: error } : {}), checks: rec.checks, measurements: rec.measurements, evidence: rec.evidence, notes: rec.notes, defects: rec.defects };
    this.log(`[${scenario.id}] ${status} (${Math.round(result.durationMs / 1000)} s)${error ? `: ${error.split("\n")[0]}` : ""}`);
    return result;
  }
}
