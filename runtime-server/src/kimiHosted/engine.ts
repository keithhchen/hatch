import { TASK_START_MESSAGE_CONTENT } from "../protocol.js";
import { briefSnapshotPromptBlock } from "../brief.js";
import { RunFenced } from "../runHold.js";
import type { RuntimeStore, VisibleConversationPart } from "../store.js";
import { failRun } from "../chat/modelTurn.js";
import type { RunEngine } from "../chat/runEngine.js";
import { RunHandoff } from "../chat/runSupervisor.js";
import type { Turn } from "../chat/turnExecutor.js";
import { log } from "../observability/log.js";
import { restartRetryKey } from "../chat/restartRetry.js";
import { KimiHostedError, type KimiEvent, type KimiHostedApi } from "./api.js";
import type { KimiSessionRecord, KimiSessions } from "./sessions.js";

/** Publishes the report the agent saved as a page, and answers its link: the same pages publish_html makes. */
export interface ReportPublisher {
  publish(scope: { productId: string; userId: string }, name: string, html: Buffer, title: string): Promise<string>;
}

const WATCH_DEADLINE_MS = 90 * 60_000;
const RECONNECT_MS = 2_000;
const RESULT_CHARS = 2_000;
export const REPORT_LINK_LABEL = "报告链接";

type Ended = { stopReason: string | undefined };

const textOf = (content: unknown): string => Array.isArray(content) ? content.map((part: { text?: string }) => part?.text ?? "").join("") : "";

/**
 * Runs a Product Run on Kimi Hosted Agents: one session does the whole job, tools included. This side starts it with the Brief,
 * watches it end, publishes the HTML report it saved, and tells the conversation the link. The event mirror is display only.
 */
export class KimiHostedEngine<Scope extends { productId: string; userId: string }> implements RunEngine<Scope> {
  constructor(private readonly deps: {
    api: KimiHostedApi | undefined;
    sessions: KimiSessions;
    store: Pick<RuntimeStore, "append">;
    publisher: ReportPublisher | undefined;
    deadlineMs?: number;
    reconnectMs?: number;
  }) {}

  async run(turn: Turn<Scope>): Promise<void> {
    const held: { sessionId?: string } = {};
    try { await this.execute(turn, held); }
    catch (error) {
      // A failed Run's session is over: answering again starts a new one. A handoff (restart) leaves it for the next Run.
      if (held.sessionId && !(turn.signal.reason instanceof RunHandoff) && !(error instanceof RunFenced)) await this.deps.sessions.finish(held.sessionId).catch(() => undefined);
      await failRun(turn, error);
    }
  }

  private async execute(turn: Turn<Scope>, held: { sessionId?: string }): Promise<void> {
    const { api, sessions, publisher } = this.deps;
    // Never a silent fallback to another engine: a Product switched to Kimi without its setup fails, and says why.
    if (!api) throw new KimiHostedError("kimi_not_configured", "This Product runs on Kimi Hosted Agents, but KIMI_HOSTED_API_KEY, KIMI_HOSTED_AGENT_ID and KIMI_HOSTED_ENVIRONMENT_ID are not all set.");
    if (!publisher) throw new KimiHostedError("kimi_not_configured", "This Product runs on Kimi Hosted Agents, but this Runtime cannot publish HTML pages.");
    turn.signal.throwIfAborted();
    await turn.state.start();
    const record = await this.session(turn, api, sessions);
    held.sessionId = record.sessionId;
    const mirror = new Mirror(turn as Turn<{ productId: string; userId: string }>, this.deps.store);
    const sendSteered = async (): Promise<void> => { for (const message of await turn.claimSteered()) await api.sendUserMessage(record.sessionId, message.content ?? ""); };
    const stopHearing = turn.onSteer(() => { void sendSteered().catch(log.error.bind(log, "kimi_steer_failed")); });
    let ended: Ended;
    try { ended = await this.watch(turn, api, record, mirror); }
    catch (error) {
      if (turn.signal.aborted) return await this.letGo(turn, api, record, error);
      throw error;
    } finally { stopHearing(); }
    if (ended.stopReason !== "end_turn") throw new KimiHostedError("kimi_run_incomplete", `The Kimi session stopped with ${ended.stopReason ?? "no stop reason"} before it delivered the report.`);
    const url = await this.publishReport(turn, api, sessions, publisher, record.sessionId);
    // The Run completes before its session is finished: a crash between them leaves a session no later Run will adopt.
    await mirror.finish(`${REPORT_LINK_LABEL}：${url}`);
    await sessions.finish(record.sessionId);
    await api.archive(record.sessionId).catch(error => log.error("kimi_archive_failed", { session_id: record.sessionId, error }));
  }

  /** This Run's session: the conversation's unfinished one when a restart interrupted its Run, otherwise a new one with the Brief sent. */
  private async session(turn: Turn<Scope>, api: KimiHostedApi, sessions: KimiSessions): Promise<KimiSessionRecord> {
    let record = await sessions.open(turn.conversation.id);
    // Only the restart retry of the Run that held the session takes it over; any other message starts its own.
    if (record && (record.runId === turn.run.id || turn.run.clientMessageId === restartRetryKey(record.runId))) await sessions.adopt(record.sessionId, turn.run.id);
    else {
      const { id } = await api.createSession({ title: `hatch ${turn.conversation.publicId} ${turn.run.id}` });
      // Recorded before anything is sent: a restart from here on finds this session and never makes another.
      await sessions.create({ sessionId: id, conversationId: turn.conversation.id, runId: turn.run.id });
      record = (await sessions.open(turn.conversation.id))!;
    }
    if (!record.messageSent) {
      await api.sendUserMessage(record.sessionId, firstMessage(turn));
      await sessions.markMessageSent(record.sessionId);
      record = { ...record, messageSent: true };
    }
    return record;
  }

  /** Reads the session's events until it ends, over as many connections as it takes. */
  private async watch(turn: Turn<Scope>, api: KimiHostedApi, record: KimiSessionRecord, mirror: Mirror): Promise<Ended> {
    const { sessions, deadlineMs = WATCH_DEADLINE_MS, reconnectMs = RECONNECT_MS } = this.deps;
    const deadline = Date.now() + deadlineMs;
    let cursor = record.cursor;
    // A session this Runtime saw events of before is known to have started: its state alone may say it ended while we were away.
    let started = Boolean(cursor);
    let failures = 0;
    while (Date.now() < deadline) {
      turn.signal.throwIfAborted();
      if (started) {
        const now = await api.getSession(record.sessionId);
        if (now.status === "terminated") throw new KimiHostedError("kimi_session_terminated", "The Kimi session was terminated before it delivered the report.");
        // The platform's session object carries no stop reason (only the idle event does): idle after running is the end of the turn.
        if (now.status === "idle" && now.stopReason !== "requires_action") return { stopReason: now.stopReason ?? "end_turn" };
      }
      try {
        for await (const { cursor: next, event } of api.stream(record.sessionId, cursor, turn.signal)) {
          failures = 0;
          await mirror.accept(event);
          if (next) { cursor = next; await sessions.saveCursor(record.sessionId, next); }
          if (event.type === "session.status" && event.data?.status === "running") started = true;
          if (event.type === "session.status" && event.data?.status === "terminated") throw new KimiHostedError("kimi_session_terminated", "The Kimi session was terminated before it delivered the report.");
          if (event.type === "session.status" && event.data?.status === "idle" && started) {
            const stopReason = event.data.stop_reason?.type as string | undefined;
            if (stopReason === "requires_action") throw new KimiHostedError("kimi_unexpected_tool_call", "The Kimi agent asked for a custom tool; this agent has none.");
            return { stopReason };
          }
        }
      } catch (error) {
        if (error instanceof KimiHostedError && error.code !== "kimi_unreachable" && !error.code.startsWith("kimi_http_5")) throw error;
        if (error instanceof RunFenced || turn.signal.aborted) throw error;
        if (++failures > 20) throw error;
        log.error("kimi_stream_dropped", { session_id: record.sessionId, error });
      }
      await new Promise(resolve => setTimeout(resolve, reconnectMs));
    }
    await api.interrupt(record.sessionId).catch(() => undefined);
    throw new KimiHostedError("kimi_deadline", `The Kimi session did not finish within ${Math.round(deadlineMs / 60_000)} minutes.`);
  }

  /** The Run stopped being ours: a restart hands the session to the next Run untouched; a stop interrupts it. */
  private async letGo(turn: Turn<Scope>, api: KimiHostedApi, record: KimiSessionRecord, error: unknown): Promise<void> {
    if (turn.signal.reason instanceof RunHandoff || error instanceof RunFenced) return;
    await api.interrupt(record.sessionId).catch(failure => log.error("kimi_interrupt_failed", { session_id: record.sessionId, error: failure }));
    await this.deps.sessions.finish(record.sessionId);
  }

  /** The HTML the agent saved last, published once: the artifact's page is recorded under session and artifact, and replays find it. */
  private async publishReport(turn: Turn<Scope>, api: KimiHostedApi, sessions: KimiSessions, publisher: ReportPublisher, sessionId: string): Promise<string> {
    const html = (await api.listArtifacts(sessionId)).filter(artifact => /\.html?$/i.test(artifact.name));
    const latest = html.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "")).at(-1);
    // With deliverable_html (DeliverableFollowups) the rule is: this engine completes a Run only with a published page, and a Run
    // without one FAILS here. The follow-up runs only after a completed Run, so it never acts on a Kimi Run (a completed one has
    // its page, a failed one is not followed up); the buyer's own "answer again" starts a new session.
    if (!latest) throw new KimiHostedError("kimi_no_report", "The Kimi agent finished without saving an HTML report.");
    const known = (await sessions.open(turn.conversation.id))?.pages[latest.id];
    if (known) return known;
    const bytes = await api.artifactContent(latest.id);
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(bytes.toString("utf8"))?.[1]?.trim() || latest.name;
    const url = await publisher.publish({ productId: turn.scope.productId, userId: turn.scope.userId }, latest.name, bytes, title);
    return sessions.recordPage(sessionId, latest.id, url);
  }
}

/** The first message, built as the pi path builds its context: the Brief, then the Run's input. */
export function firstMessage(turn: Pick<Turn<unknown>, "conversation" | "input" | "persistedUser">): string {
  const content = turn.input.task_start ? TASK_START_MESSAGE_CONTENT : turn.persistedUser.content ?? "";
  const brief = turn.conversation.briefSnapshot;
  return brief ? `${briefSnapshotPromptBlock(brief)}\n\n${content}` : content;
}

/**
 * Session events into our conversation log as the normal event types. Thin and read-only: what it cannot write is logged and skipped,
 * since the Run does not depend on it; only a fence (this Run is no longer ours) stops it.
 */
class Mirror {
  private text = "";
  private readonly parts: VisibleConversationPart[] = [];
  private readonly names = new Map<string, string>();
  private readonly started = performance.now();

  constructor(private readonly turn: Turn<{ productId: string; userId: string }>, private readonly store: Pick<RuntimeStore, "append">) {
    turn.state.keepsReplyFrom(() => this.text || this.parts.length ? { message: { role: "assistant", content: this.text }, finishReason: "stop", visibleParts: structuredClone(this.parts) } : undefined);
  }

  async accept(event: KimiEvent): Promise<void> {
    try { await this.map(event); } catch (error) { if (error instanceof RunFenced) throw error; log.error("kimi_mirror_failed", { type: event.type, error }); }
  }

  private async map(event: KimiEvent): Promise<void> {
    if (event.type === "agent.message") await this.say(textOf(event.data?.content));
    else if (event.type === "agent.tool_use" && event.data?.tool_use) {
      const { id, name, input } = event.data.tool_use as { id: string; name: string; input?: Record<string, unknown> };
      this.names.set(id, name);
      this.parts.push({ type: "tool_call", tool_call_id: id });
      await this.tool(id, name, "requested", { arguments: input ?? {}, ...typeof input?.description === "string" ? { activity_message: input.description } : {} });
    } else if (event.type === "agent.tool_result" && event.data?.tool_result) {
      const result = event.data.tool_result as { tool_use_id: string; structured_content?: unknown; content?: unknown; is_error?: boolean };
      const output = textOf(result.structured_content ?? result.content).slice(0, RESULT_CHARS);
      const failed = result.is_error === true;
      await this.tool(result.tool_use_id, this.names.get(result.tool_use_id) ?? "tool", failed ? "failed" : "completed", failed ? { error: { code: "tool_error", message: output } } : { result: { output } });
    }
  }

  private async tool(id: string, name: string, status: "requested" | "completed" | "failed", more: { arguments?: Record<string, unknown>; activity_message?: string; result?: Record<string, unknown>; error?: { code: string; message: string } }): Promise<void> {
    const { turn } = this;
    const fields = { tool_call_id: id, name, locality: "server" as const, approval: "none" as const, status, ...more };
    turn.publish({ type: "tool_call.delta", run_id: turn.run.id, ...fields, arguments: more.arguments });
    await this.store.append({ type: "tool.call", conversation_id: turn.conversation.id, run_id: turn.run.id, ...fields, arguments: more.arguments ?? {} });
  }

  private async say(content: string): Promise<void> {
    if (!content.trim()) return;
    const piece = this.text ? `\n\n${content}` : content;
    const start = this.text.length;
    this.text += piece;
    this.parts.push({ type: "text", start, end: this.text.length });
    this.turn.publish({ type: "assistant.delta", run_id: this.turn.run.id, delta: { kind: "text", content: piece } });
  }

  /** The reply ends with the link, then the Run completes. */
  async finish(last: string): Promise<void> {
    const { turn } = this;
    await this.say(last);
    turn.publish({ type: "turn.completed", run_id: turn.run.id, finish_reason: "stop", timing: { total_ms: performance.now() - this.started, setup_ms: 0, guard: [] } });
    await turn.state.complete({ message: { role: "assistant", content: this.text }, finishReason: "stop", visibleParts: this.parts });
  }
}
