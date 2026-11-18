import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApiKeyCredential, BoxliteRestOptions, JsBoxlite, errorCode, type Boxlite } from "@boxlite-ai/boxlite";
import { log } from "../observability/log.js";
import { OutputCapture } from "./output.js";
import { BoxFileMissing, BoxNameTaken, BoxUnavailable, type AgentBox, type BoxProvider, type ExecResult } from "./ports.js";

/** Pinned: a new image is a code change, so BoxLite never pulls one under a live buyer. Built by keithhchen/hatch-agent-box. */
export const DEFAULT_BOX_IMAGE = "docker.io/keithchen/hatch-agent-box:703c048708152a2f7a40feeeef6e8443b8a9d4e8";
export const DEFAULT_WORK_DIR = "/home/agent/work";
/** What one command may print, in all; the start and the end of it are kept. */
const OUTPUT_CHARS = 30_000;

/** Keys the box's programs use without holding them: they send the placeholder `<BOXLITE_SECRET:name>` in `headers`, and BoxLite swaps in the key ({value}) only on requests to these hosts. */
const BOX_SECRETS: { env: string; name: string; hosts: string[]; headers: Record<string, string> }[] = [
  { env: "PAGESPEED_API_KEY", name: "pagespeed", hosts: ["www.googleapis.com"], headers: { "X-Goog-Api-Key": "{value}" } },
  { env: "GOOGLE_MAPS_API_KEY", name: "google_maps", hosts: ["places.googleapis.com", "addressvalidation.googleapis.com"], headers: { "X-Goog-Api-Key": "{value}" } },
  { env: "CF_API_TOKEN", name: "cloudflare", hosts: ["api.cloudflare.com"], headers: { Authorization: "Bearer {value}" } }
];

type BoxSecret = { name: string; value: string; hosts: string[]; headers: Record<string, string> };
type SdkBox = NonNullable<Awaited<ReturnType<Boxlite["get"]>>>;

const unavailable = (error: unknown): never => {
  log.error("agent_box_failed", { error });
  throw new BoxUnavailable(error);
};

/** BoxLite gave up waiting for a box to start, or is still starting it: the box comes up on its own (a new image's first pull is slow). */
const STARTING = /reach started|state change in progress/i;
/** The connection to the box failed: the service's fault, not the command's, though BoxLite reports it as the command's error. */
const TRANSPORT = /WS connect failed|network error|upstream connect error/i;
/** How long a call waits for a starting box. */
export const START_WAIT_MS = 180_000;
const START_POLL_MS = 3_000;

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
        if (result.exitCode !== 0 && TRANSPORT.test(result.errorMessage ?? "")) return unavailable(new Error(result.errorMessage));
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
  constructor(private readonly runtime: Pick<Boxlite, "get" | "create" | "getInfo">, private readonly options: { image: string; workDir: string; secrets?: BoxSecret[]; startPollMs?: number }) {}

  /** Configured by BOXLITE_API_KEY (and BOXLITE_REST_URL, default the hosted API); undefined without a key. */
  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env, rest: (key: string) => Pick<Boxlite, "get" | "create" | "getInfo"> = key => JsBoxlite.rest(new BoxliteRestOptions({ url: environment.BOXLITE_REST_URL?.trim() || "https://api.boxlite.ai", credential: new ApiKeyCredential(key) }))): BoxliteProvider | undefined {
    const key = environment.BOXLITE_API_KEY?.trim();
    if (!key) return undefined;
    const runtime = rest(key);
    const secrets = BOX_SECRETS.flatMap(({ env, name, hosts, headers }) => { const value = environment[env]?.trim(); return value ? [{ name, value, hosts, headers }] : []; });
    return new BoxliteProvider(runtime, { secrets, image: environment.HATCH_AGENT_BOX_IMAGE?.trim() || DEFAULT_BOX_IMAGE, workDir: environment.HATCH_AGENT_BOX_WORKDIR?.trim() || DEFAULT_WORK_DIR });
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
      box = await this.runtime.create({ image: this.options.image, cpus: 2, memoryMib: 2048, autoRemove: false, autoDelete: 0, network: { outbound: { mode: "enabled", allowNet: [] } }, secrets: this.options.secrets ?? [] }, name);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/already exists/i.test(message)) throw new BoxNameTaken(name, { cause: error });
      if (!STARTING.test(message)) return unavailable(error);
      box = await this.started(name, error);
    }
    const created = new BoxliteBox(box);
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
