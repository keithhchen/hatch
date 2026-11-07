import type { HostedAgentProvider, HostedResult, HostedTask, KimiHostedApi } from "./ports.js";
import type { Provisioner } from "./provisioner.js";

type Event = { cursor: string; type: string; data: Record<string, unknown> };
type Cleanup = () => Promise<unknown>;

/** Runs `body` with a cleanup stack; every registered cleanup runs (best effort, newest first) whatever happens. */
const withCleanup = async <T>(body: (defer: (cleanup: Cleanup) => void) => Promise<T>): Promise<T> => {
  const stack: Cleanup[] = [];
  try { return await body(cleanup => { stack.push(cleanup); }); }
  finally { for (const cleanup of stack.reverse()) await cleanup().catch(() => undefined); }
};

const text = (data: Record<string, unknown>) =>
  ((data.content as Array<{ type?: string; text?: string }> | undefined) ?? []).filter(c => c.type === "text").map(c => c.text ?? "").join("");

/** What one run observed: the last agent message, and how it ended. */
type Turn = { message: string; ended?: "idle" | "error"; error?: string };

/** Folds the event stream into a Turn. A new event kind is one entry here. */
const reducers: Record<string, (turn: Turn, data: Record<string, unknown>) => Turn> = {
  "agent.message": (turn, data) => ({ ...turn, message: text(data) || turn.message }),
  "session.status": (turn, data) => data.status === "idle" ? { ...turn, ended: "idle" }
    : data.status === "terminated" ? { ...turn, ended: "error", error: "The hosted session was terminated" } : turn,
  "session.error": (turn, data) => ({ ...turn, ended: "error", error: String((data.error as { message?: string } | undefined)?.message ?? data.message ?? "Hosted session error") }),
};

/**
 * One-shot task on Kimi Hosted Agents: a fresh sandbox with Hatch's declared image and agent,
 * the task's files mounted, its secrets in a throwaway vault, and nothing left behind afterwards.
 */
export class KimiHostedAgent implements HostedAgentProvider {
  constructor(
    private readonly api: KimiHostedApi,
    private readonly provisioner: Provisioner,
    private readonly options: { reconnects?: number } = {},
  ) {}

  async run(task: HostedTask, signal?: AbortSignal): Promise<HostedResult> {
    const { agentId, environmentId } = await this.provisioner.ensure(signal);
    return withCleanup(async defer => {
      const vaultIds: string[] = [];
      if (task.secrets.length) {
        const vault = await this.api.createVault(`hatch:${task.title}`.slice(0, 100));
        defer(() => this.api.deleteVault(vault.id));
        for (const secret of task.secrets) await this.api.addSecret(vault.id, secret);
        vaultIds.push(vault.id);
      }
      const fileIds = await Promise.all(task.files.map(async file => {
        const { id } = await this.api.uploadFile(file);
        defer(() => this.api.deleteFile(id));
        return id;
      }));
      const session = await this.api.createSession({ agentId, environmentId, title: task.title, fileIds, vaultIds });
      defer(() => this.api.archiveSession(session.id));
      await this.api.sendMessage(session.id, task.prompt);
      const turn = await this.follow(session.id, signal);
      const artifacts = await Promise.all((await this.api.listArtifacts(session.id))
        .map(async artifact => ({ name: artifact.name, bytes: await this.api.downloadArtifact(artifact.id) })));
      return {
        sessionId: session.id,
        status: turn.ended === "idle" ? "done" : "failed",
        text: turn.message,
        artifacts,
        ...(turn.ended === "idle" ? {} : { error: turn.error ?? "The hosted session ended without finishing" }),
      };
    });
  }

  /** Reads events until the run settles, resuming from the last cursor when the stream drops. */
  private async follow(sessionId: string, signal?: AbortSignal): Promise<Turn> {
    let turn: Turn = { message: "" };
    let cursor: string | undefined;
    let started = false;
    for (let attempt = 0; attempt <= (this.options.reconnects ?? 20); attempt++) {
      try {
        for await (const event of this.api.events(sessionId, { cursor, signal }) as AsyncIterable<Event>) {
          cursor = event.cursor;
          // The stream replays history: an idle status before this run started belongs to the session's creation.
          if (event.type === "session.status" && event.data.status === "running") started = true;
          if (event.type === "session.status" && event.data.status === "idle" && !started) continue;
          turn = reducers[event.type]?.(turn, event.data) ?? turn;
          if (turn.ended) return turn;
        }
      } catch (error) {
        signal?.throwIfAborted();
        turn = { ...turn, error: error instanceof Error ? error.message : String(error) };
      }
    }
    return { ...turn, ended: "error", error: turn.error ?? "The hosted session stream kept dropping" };
  }
}
