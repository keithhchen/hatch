import { StringDecoder } from "node:string_decoder";
import { Writable } from "node:stream";
import { APIError, Drive, Sandbox } from "@vercel/sandbox";
import { DEFAULT_WORK_DIR, EXEC_BACKOFF_MS } from "./boxlite.js";
import { OutputCapture } from "./output.js";
import { BoxFileMissing, BoxNameTaken, BoxToolError, BoxUnavailable, type AgentBox, type BoxProvider, type ExecResult } from "./ports.js";
import { Transient, quote, retrying, unavailable } from "./retry.js";

/** Pinned like the BoxLite image: a new image is a code change. Built by keithhchen/hatch-agent-box and pushed to Vercel Container Registry; a bare name resolves against the project. */
export const DEFAULT_VERCEL_IMAGE = "hatch-agent-box:0876cdae25a7f559e8a9cd6f14c0793bd581cc4c";
export const DEFAULT_VERCEL_REGION = "sin1";
/** What one command may print, in all; the start and the end of it are kept. */
const OUTPUT_CHARS = 30_000;
/** A session ends (and the box is saved, to resume on the next call) this long after it started. */
const SESSION_MS = 20 * 60_000;
/** How long past its own deadline a command may take to report before the platform is given up on. */
const REPORT_GRACE_MS = 20_000;
/** The image is being prepared after a push. */
const IMAGE_BACKOFF_MS = [5_000, 10_000, 20_000, 30_000];

type SdkCommand = { kill(signal?: "SIGTERM" | "SIGKILL"): Promise<unknown> };
type SdkBox = {
  /** One call that runs the command and answers when it ends; `onStart` is awaited once it is running. (The detached form takes three calls, about 3 s more.) */
  runCommand(params: { cmd: string; args: string[]; cwd: string; stdout: Writable; stderr: Writable; onStart: (command: SdkCommand) => void }): Promise<{ exitCode: number }>;
  readFileToBuffer(file: { path: string }): Promise<Buffer | null>;
  writeFiles(files: { path: string; content: Buffer }[]): Promise<void>;
  stop(): Promise<unknown>;
};
/** The part of the Vercel Sandbox SDK the adapter uses: boxes by name, with the project's credentials already applied. */
export interface SandboxRuntime {
  get(name: string): Promise<SdkBox>;
  create(options: { name: string; image: string; region: string; workDrive: boolean }): Promise<SdkBox>;
}

const code = (error: unknown): string | undefined => error instanceof APIError ? (error.json as { error?: { code?: string } } | undefined)?.error?.code : undefined;
const message = (error: unknown): string => error instanceof Error ? error.message : "";
/** The platform failed or is busy, not the call: a 5xx, a rate limit, a lost connection. (Every other 4xx is the call's own fault.) */
const platformFailure = (error: unknown): boolean => error instanceof APIError ? error.response.status >= 500 || error.response.status === 429 || error.response.status === 408 : true;

/** A call that failed before it did anything: Transient when the platform is at fault, BoxUnavailable otherwise. */
const refused = (error: unknown, signal?: AbortSignal): never => {
  if (signal?.aborted) throw error;
  if (platformFailure(error)) throw new Transient(message(error), { cause: error });
  return unavailable(error);
};

class VercelBox implements AgentBox {
  constructor(private readonly box: SdkBox, private readonly backoffMs: number[] = EXEC_BACKOFF_MS) {}

  exec(command: string, options: { cwd: string; timeoutSeconds: number; signal?: AbortSignal }): Promise<ExecResult> {
    options.signal?.throwIfAborted();
    return retrying("exec", this.backoffMs, () => this.execOnce(command, options), options.signal, options.timeoutSeconds * 1000);
  }

  private async execOnce(command: string, { cwd, timeoutSeconds, signal }: { cwd: string; timeoutSeconds: number; signal?: AbortSignal }): Promise<ExecResult> {
    const stdout = new OutputCapture(OUTPUT_CHARS / 2), stderr = new OutputCapture(OUTPUT_CHARS / 2);
    const sink = (into: OutputCapture) => { const decoder = new StringDecoder("utf8"); return new Writable({ write(chunk: Buffer, _encoding, done) { into.push(decoder.write(chunk)); done(); } }); };
    let running: SdkCommand | undefined;
    const began = Date.now();
    // `timeout` is the deadline and kills the command's whole process group; the platform's own timeout leaves orphans and answers a minute late.
    const finished = this.box.runCommand({ cmd: "timeout", args: ["-k", "5", String(timeoutSeconds), "bash", "-c", command], cwd, stdout: sink(stdout), stderr: sink(stderr), onStart: started => { running = started; } }).then(done => done.exitCode);
    finished.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<"silent" | "abort">(resolve => {
      timer = setTimeout(() => resolve("silent"), timeoutSeconds * 1000 + REPORT_GRACE_MS);
      onAbort = () => resolve("abort");
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    const timedOut = () => ({ exitCode: 124, stdout: stdout.text(), stderr: `${stderr.text()}\n[Stopped: the command ran longer than ${timeoutSeconds} seconds.]`.trimStart() });
    try {
      const result = await Promise.race([finished, stopped]);
      if (typeof result === "string") {
        void running?.kill("SIGTERM").catch(() => undefined);
        signal?.throwIfAborted();
        return timedOut();
      }
      // 124 is `timeout`'s own; 137 is what it reports when the command ignored the first signal.
      return result === 124 || (result === 137 && Date.now() - began >= timeoutSeconds * 1000) ? timedOut() : { exitCode: result, stdout: stdout.text(), stderr: stderr.text() };
    } catch (error) {
      if (signal?.aborted) throw error;
      // Before the command started the platform refused it: nothing ran, so it may be asked again. After that it is never run again.
      if (running) return unavailable(error);
      if (code(error) === "command_failed" && /no such file or directory/i.test(message(error))) throw new BoxToolError(`The working directory ${cwd} does not exist.`);
      return refused(error);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  async readFile(file: string): Promise<Buffer> {
    try {
      const content = await retrying("readFile", this.backoffMs, () => this.box.readFileToBuffer({ path: file }).catch(error => refused(error)));
      if (content === null) throw new BoxFileMissing(`${file} does not exist.`);
      return content;
    } catch (error) {
      if (error instanceof BoxFileMissing || error instanceof BoxUnavailable) throw error;
      return unavailable(error);
    }
  }

  /** The platform makes the parent directories. */
  async writeFile(file: string, content: Buffer): Promise<void> {
    try {
      await retrying("writeFile", this.backoffMs, () => this.box.writeFiles([{ path: file, content }]).catch(error => refused(error)));
    } catch (error) {
      if (error instanceof BoxUnavailable) throw error;
      return unavailable(error);
    }
  }

  async stop(): Promise<void> {
    try { await this.box.stop(); } catch (error) { unavailable(error); }
  }
}

/** Vercel Sandbox: one named, persistent sandbox per buyer. It stops by itself when its session ends and is saved for good (no expiry, only the last snapshot kept); the next call resumes it, files intact. */
export class VercelSandboxProvider implements BoxProvider {
  constructor(private readonly runtime: SandboxRuntime, private readonly options: { image: string; region: string; workDir: string; workDrive?: boolean; retryBackoffMs?: number[]; imageBackoffMs?: number[] }) {}

  /** Configured by VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID; undefined without all three. HATCH_VERCEL_SANDBOX_WORK_DRIVE=1 keeps the working directory on a Drive of its own, so a new image can replace the box without losing it. */
  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env, runtime?: SandboxRuntime): VercelSandboxProvider | undefined {
    const token = environment.VERCEL_TOKEN?.trim(), teamId = environment.VERCEL_TEAM_ID?.trim(), projectId = environment.VERCEL_PROJECT_ID?.trim();
    if (!token || !teamId || !projectId) return undefined;
    return new VercelSandboxProvider(runtime ?? sdkRuntime({ token, teamId, projectId }, environment.HATCH_AGENT_BOX_WORKDIR?.trim() || DEFAULT_WORK_DIR), {
      image: environment.HATCH_VERCEL_SANDBOX_IMAGE?.trim() || DEFAULT_VERCEL_IMAGE,
      region: environment.HATCH_VERCEL_SANDBOX_REGION?.trim() || DEFAULT_VERCEL_REGION,
      workDir: environment.HATCH_AGENT_BOX_WORKDIR?.trim() || DEFAULT_WORK_DIR,
      workDrive: environment.HATCH_VERCEL_SANDBOX_WORK_DRIVE === "1"
    });
  }

  get workDir(): string { return this.options.workDir; }

  async find(name: string): Promise<AgentBox | undefined> {
    try {
      const box = await retrying("find", this.options.retryBackoffMs ?? EXEC_BACKOFF_MS, async (): Promise<SdkBox | undefined> => {
        try { return await this.runtime.get(name); } catch (error) {
          if (error instanceof APIError && error.response.status === 404) return undefined;
          return refused(error);
        }
      });
      return box ? new VercelBox(box, this.options.retryBackoffMs) : undefined;
    } catch (error) {
      if (error instanceof BoxUnavailable) throw error;
      return unavailable(error);
    }
  }

  async create(name: string): Promise<AgentBox> {
    let box: SdkBox;
    try {
      box = await retrying("create", this.options.imageBackoffMs ?? IMAGE_BACKOFF_MS, () => this.runtime.create({ name, image: this.options.image, region: this.options.region, workDrive: this.options.workDrive === true }).catch(error => {
        if (error instanceof APIError && /already exists/i.test(error.message)) throw new BoxNameTaken(name, { cause: error });
        if (code(error) === "image_not_ready") throw new Transient(message(error), { cause: error });
        return refused(error);
      }));
    } catch (error) {
      if (error instanceof BoxNameTaken || error instanceof BoxUnavailable) throw error;
      return unavailable(error);
    }
    const created = new VercelBox(box, this.options.retryBackoffMs);
    const made = await created.exec(`mkdir -p -- ${quote(this.options.workDir)}`, { cwd: "/", timeoutSeconds: 60 });
    if (made.exitCode !== 0) return unavailable(new Error(`Cannot create ${this.options.workDir}: ${made.stderr}`));
    return created;
  }
}

/** The real SDK. A new sandbox boots from the image as the image's own user, in a region of our choosing. */
const sdkRuntime = (credentials: { token: string; teamId: string; projectId: string }, workDir: string): SandboxRuntime => ({
  get: name => Sandbox.get({ ...credentials, name }) as unknown as Promise<SdkBox>,
  create: async ({ name, image, region, workDrive }) => Sandbox.create({
    ...credentials, name, image, region,
    resources: { vcpus: 2 },
    timeout: SESSION_MS,
    // Saved on every stop and never expiring, but only the last save is kept: a buyer's box costs one snapshot, not one per session.
    persistent: true, snapshotExpiration: 0, keepLastSnapshots: { count: 1, deleteEvicted: true },
    ...(workDrive ? { mounts: { [workDir]: await Drive.getOrCreate({ ...credentials, name, region }) } } : {})
  }) as unknown as Promise<SdkBox>
});
