import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApiKeyCredential, BoxliteRestOptions, JsBoxlite, errorCode, type Boxlite } from "@boxlite-ai/boxlite";
import { log } from "../observability/log.js";
import { OutputCapture } from "./output.js";
import { BoxFileMissing, BoxNameTaken, BoxUnavailable, type AgentBox, type BoxProvider, type ExecResult } from "./ports.js";

export const DEFAULT_BOX_IMAGE = "docker.io/keithchen/hatch-agent-box:latest";
export const DEFAULT_WORK_DIR = "/home/agent/work";
/** What one command may print, in all; the start and the end of it are kept. */
const OUTPUT_CHARS = 30_000;

type SdkBox = NonNullable<Awaited<ReturnType<Boxlite["get"]>>>;

const unavailable = (error: unknown): never => {
  log.error("agent_box_failed", { error });
  throw new BoxUnavailable(error);
};

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

class BoxliteBox implements AgentBox {
  constructor(private readonly box: SdkBox) {}

  async exec(command: string, options: { cwd: string; timeoutSeconds: number; signal?: AbortSignal }): Promise<ExecResult> {
    options.signal?.throwIfAborted();
    const stdout = new OutputCapture(OUTPUT_CHARS / 2), stderr = new OutputCapture(OUTPUT_CHARS / 2);
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
        return { exitCode: result.exitCode, stdout: stdout.text(), stderr: result.errorMessage ? `${stderr.text()}\n${result.errorMessage}`.trimStart() : stderr.text() };
      } finally {
        clearTimeout(timer);
        if (onAbort) options.signal?.removeEventListener("abort", onAbort);
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return unavailable(error);
    }
  }

  async readFile(file: string): Promise<Buffer> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-box-"));
    try {
      await this.box.copyOut(file, path.join(directory, "file"), {});
      return await readFile(path.join(directory, "file"));
    } catch (error) {
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
      await this.box.copyIn(path.join(directory, "file"), file, { overwrite: true });
    } catch (error) {
      return unavailable(error);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async stop(): Promise<void> {
    try { await this.box.stop(); } catch (error) { unavailable(error); }
  }
}

/** BoxLite Cloud through its Node SDK's REST runtime: `create` is a box of its own, resumed on the next call after it idles out. */
export class BoxliteProvider implements BoxProvider {
  constructor(private readonly runtime: Pick<Boxlite, "get" | "create">, private readonly options: { image: string; workDir: string }) {}

  /** Configured by BOXLITE_API_KEY (and BOXLITE_REST_URL, default the hosted API); undefined without a key. */
  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): BoxliteProvider | undefined {
    const key = environment.BOXLITE_API_KEY?.trim();
    if (!key) return undefined;
    const runtime = JsBoxlite.rest(new BoxliteRestOptions({ url: environment.BOXLITE_REST_URL?.trim() || "https://api.boxlite.ai", credential: new ApiKeyCredential(key) }));
    return new BoxliteProvider(runtime, { image: environment.HATCH_AGENT_BOX_IMAGE?.trim() || DEFAULT_BOX_IMAGE, workDir: environment.HATCH_AGENT_BOX_WORKDIR?.trim() || DEFAULT_WORK_DIR });
  }

  get workDir(): string { return this.options.workDir; }

  async find(name: string): Promise<AgentBox | undefined> {
    try {
      const box = await this.runtime.get(name);
      return box ? new BoxliteBox(box) : undefined;
    } catch (error) { return unavailable(error); }
  }

  async create(name: string): Promise<AgentBox> {
    let box: SdkBox;
    try {
      // The box is the buyer's for good: it idles out (and resumes on use) but is never deleted.
      box = await this.runtime.create({ image: this.options.image, cpus: 2, memoryMib: 2048, autoRemove: false, autoDelete: 0 }, name);
    } catch (error) {
      if (/already exists/i.test(error instanceof Error ? error.message : "")) throw new BoxNameTaken(name, { cause: error });
      return unavailable(error);
    }
    const created = new BoxliteBox(box);
    const made = await created.exec(`mkdir -p -- ${quote(this.options.workDir)}`, { cwd: "/", timeoutSeconds: 60 });
    if (made.exitCode !== 0) return unavailable(new Error(`Cannot create ${this.options.workDir}: ${made.stderr}`));
    return created;
  }
}
