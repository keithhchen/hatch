import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApiKeyCredential, BoxliteRestOptions, JsBoxlite, errorCode, type Boxlite } from "@boxlite-ai/boxlite";
import { OutputCapture } from "./output.js";
import { Transient, quote, retrying, unavailable } from "./retry.js";
import { BoxFileMissing, BoxNameTaken, BoxUnavailable, type AgentBox, type BoxProvider, type ExecResult } from "./ports.js";

/** Pinned: a new image is a code change, so BoxLite never pulls one under a live buyer. Built by keithhchen/hatch-agent-box. */
export const DEFAULT_BOX_IMAGE = "docker.io/keithchen/hatch-agent-box:d6a5ac301a14fd1051daf84bdf4e06926546bf9d";
export const DEFAULT_WORK_DIR = "/home/agent/work";
/** What one command may print, in all; the start and the end of it are kept. */
const OUTPUT_CHARS = 30_000;

type SdkBox = NonNullable<Awaited<ReturnType<Boxlite["get"]>>>;

/** BoxLite gave up waiting for a box to start, or is still starting it: the box comes up on its own (a new image's first pull is slow). */
const STARTING = /reach started|state change in progress/i;
/** The service failed or refused before doing anything (connection lost, rate limit, its own database down): its fault, not the command's, though BoxLite reports it as the command's error. A transient 401 "Invalid credentials" was seen on a key that worked seconds before. Seen in prod: "WS connect failed ... 503", "resource exhausted: Rate exceeded.", "internal error: Audit database connection unavailable". */
const TRANSPORT = /WS connect failed|network error|upstream connect error|resource exhausted|Rate exceeded|Audit database|database connection unavailable|Invalid credentials/i;
/** How long a call waits for a starting box. */
export const START_WAIT_MS = 180_000;
const START_POLL_MS = 3_000;

/** Waits before each retry of a call the service failed or refused. */
export const EXEC_BACKOFF_MS = [1_000, 3_000, 6_000];

class BoxliteBox implements AgentBox {
  constructor(private readonly box: SdkBox, private readonly backoffMs: number[] = EXEC_BACKOFF_MS) {}

  exec(command: string, options: { cwd: string; timeoutSeconds: number; signal?: AbortSignal }): Promise<ExecResult> {
    options.signal?.throwIfAborted();
    return retrying("exec", this.backoffMs, () => this.execOnce(command, options), options.signal, options.timeoutSeconds * 1000);
  }

  private async execOnce(command: string, options: { cwd: string; timeoutSeconds: number; signal?: AbortSignal }): Promise<ExecResult> {
    const stdout = new OutputCapture(OUTPUT_CHARS / 2), stderr = new OutputCapture(OUTPUT_CHARS / 2);
    /** Nothing was received from the command, so it cannot have started. */
    const silent = () => stdout.text() === "" && stderr.text() === "";
    try {
      // The service's own deadline is slow to act (a minute past it); this one decides, and kills.
      const execution = await this.box.exec("bash", ["-c", command], null, false, null, options.timeoutSeconds + 10, options.cwd);
      const drain = async (stream: { next(): Promise<string | null> }, into: OutputCapture) => { for (let chunk = await stream.next(); chunk !== null; chunk = await stream.next()) into.push(chunk); };
      const finished = Promise.all([drain(await execution.stdout(), stdout), drain(await execution.stderr(), stderr)]).then(() => execution.wait());
      finished.catch(() => undefined);
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      const stopped = new Promise<"timeout" | "abort">(resolve => {
        timer = setTimeout(() => resolve("timeout"), options.timeoutSeconds * 1000);
        onAbort = () => resolve("abort");
        options.signal?.addEventListener("abort", onAbort, { once: true });
      });
      try {
        const result = await Promise.race([finished, stopped]);
        if (typeof result === "string") {
          void execution.kill().catch(() => undefined);
          options.signal?.throwIfAborted();
          return { exitCode: 124, stdout: stdout.text(), stderr: `${stderr.text()}\n[Stopped: the command ran longer than ${options.timeoutSeconds} seconds.]`.trimStart() };
        }
        // A silent result never ran the command, even when BoxLite reports it as exit 0.
        if (TRANSPORT.test(result.errorMessage ?? "") && (result.exitCode !== 0 || silent())) {
          const failure = new Error(result.errorMessage);
          if (!silent()) return unavailable(failure);
          throw new Transient(failure.message, { cause: failure });
        }
        return { exitCode: result.exitCode, stdout: stdout.text(), stderr: result.errorMessage ? `${stderr.text()}\n${result.errorMessage}`.trimStart() : stderr.text() };
      } finally {
        clearTimeout(timer);
        if (onAbort) options.signal?.removeEventListener("abort", onAbort);
      }
    } catch (error) {
      if (options.signal?.aborted || error instanceof Transient || error instanceof BoxUnavailable) throw error;
      const message = error instanceof Error ? error.message : "";
      if (TRANSPORT.test(message) && silent()) throw new Transient(message, { cause: error });
      return unavailable(error);
    }
  }

  async readFile(file: string): Promise<Buffer> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-box-"));
    try {
      await retrying("copyOut", this.backoffMs, () => this.copy(() => this.box.copyOut(file, path.join(directory, "file"), {})));
      return await readFile(path.join(directory, "file"));
    } catch (error) {
      if (error instanceof BoxUnavailable) throw error;
      if (errorCode(error) === "not_found") throw new BoxFileMissing(`${file} does not exist.`);
      return unavailable(error);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async writeFile(file: string, content: Buffer): Promise<void> {
    const made = await this.exec(`mkdir -p -- ${quote(path.posix.dirname(file))}`, { cwd: "/", timeoutSeconds: 30 });
    if (made.exitCode !== 0) throw new BoxFileMissing(`Cannot create the directory for ${file}: ${made.stderr.trim()}`);
    const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-box-"));
    try {
      await writeFile(path.join(directory, "file"), content);
      await retrying("copyIn", this.backoffMs, () => this.copy(() => this.box.copyIn(path.join(directory, "file"), file, { overwrite: true })));
    } catch (error) {
      if (error instanceof BoxUnavailable) throw error;
      return unavailable(error);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  /** One copy: a connection failure is Transient, anything else passes through. */
  private async copy(run: () => Promise<unknown>): Promise<void> {
    try { await run(); } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (TRANSPORT.test(message)) throw new Transient(message, { cause: error });
      throw error;
    }
  }

  async stop(): Promise<void> {
    try { await this.box.stop(); } catch (error) { unavailable(error); }
  }
}

/** BoxLite Cloud through its Node SDK's REST runtime: `create` is a box of its own, resumed on the next call after it idles out. */
export class BoxliteProvider implements BoxProvider {
  constructor(private readonly runtime: Pick<Boxlite, "get" | "create" | "getInfo">, private readonly options: { image: string; workDir: string; startPollMs?: number; retryBackoffMs?: number[] }) {}

  /** Configured by BOXLITE_API_KEY (and BOXLITE_REST_URL, default the hosted API); undefined without a key. */
  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env, rest: (key: string) => Pick<Boxlite, "get" | "create" | "getInfo"> = key => JsBoxlite.rest(new BoxliteRestOptions({ url: environment.BOXLITE_REST_URL?.trim() || "https://api.boxlite.ai", credential: new ApiKeyCredential(key) }))): BoxliteProvider | undefined {
    const key = environment.BOXLITE_API_KEY?.trim();
    if (!key) return undefined;
    const runtime = rest(key);
    return new BoxliteProvider(runtime, { image: environment.HATCH_AGENT_BOX_IMAGE?.trim() || DEFAULT_BOX_IMAGE, workDir: environment.HATCH_AGENT_BOX_WORKDIR?.trim() || DEFAULT_WORK_DIR });
  }

  get workDir(): string { return this.options.workDir; }

  async find(name: string): Promise<AgentBox | undefined> {
    try {
      const box = await this.runtime.get(name);
      return box ? new BoxliteBox(box, this.options.retryBackoffMs) : undefined;
    } catch (error) { return unavailable(error); }
  }

  async create(name: string): Promise<AgentBox> {
    let box: SdkBox;
    try {
      // The box is the buyer's for good: it idles out (and resumes on use) but is never deleted.
      box = await this.runtime.create({ image: this.options.image, cpus: 2, memoryMib: 2048, autoRemove: false, autoDelete: 0, network: { outbound: { mode: "enabled", allowNet: [] } } }, name);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/already exists/i.test(message)) throw new BoxNameTaken(name, { cause: error });
      if (!STARTING.test(message)) return unavailable(error);
      box = await this.started(name, error);
    }
    const created = new BoxliteBox(box, this.options.retryBackoffMs);
    const made = await created.exec(`mkdir -p -- ${quote(this.options.workDir)}`, { cwd: "/", timeoutSeconds: 60 });
    if (made.exitCode !== 0) return unavailable(new Error(`Cannot create ${this.options.workDir}: ${made.stderr}`));
    return created;
  }

  /** The box once BoxLite reports it running, waiting up to START_WAIT_MS. */
  private async started(name: string, cause: unknown): Promise<SdkBox> {
    const poll = this.options.startPollMs ?? START_POLL_MS;
    for (let waited = 0; waited < START_WAIT_MS; waited += poll) {
      await new Promise(resolve => setTimeout(resolve, poll));
      const info = await this.runtime.getInfo(name).catch(() => null);
      if (info?.state.running) {
        const box = await this.runtime.get(name).catch(() => null);
        if (box) return box;
      }
    }
    return unavailable(cause);
  }
}
