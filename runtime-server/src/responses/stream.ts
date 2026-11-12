import type http from "node:http";
import type { ConversationRecord, ConversationRepository, ConversationRunRecord } from "../conversationRepository.js";
import type { ChatEdge } from "../chat/turnSubmission.js";
import { log } from "../observability/log.js";
import { ResponseEvents, liveToolItem } from "./events.js";
import { isTerminal, responseObject, type Json } from "./mapping.js";
import type { RunViews } from "./runs.js";

/** A comment line the client ignores, sent so a quiet connection is not closed by a proxy. */
export const KEEP_ALIVE_MS = 15_000;
const POLL_MS = 1_000;

export type StreamOptions = {
  res: http.ServerResponse;
  edge: ChatEdge;
  repository: ConversationRepository;
  views: RunViews;
  conversation: ConversationRecord;
  run: ConversationRunRecord;
  includeToolCalls: boolean;
  /** Journal position to listen from: events before it are not this response's. */
  afterCursor: number;
  /** A client that already holds events up to this sequence number gets only what follows. */
  startingAfter?: number;
  keepAliveMs?: number;
  signal?: AbortSignal;
};

/**
 * Streams one Run as the OpenAI event sequence over SSE, from the start: a Run still going is followed live (the text said so
 * far arrives at once), one that has ended is told whole. The stream ends with the Run, or when the client goes away; going
 * away never stops the Run.
 */
export async function streamResponse(options: StreamOptions): Promise<void> {
  const { res, edge, repository, views, conversation, run, includeToolCalls, signal } = options;
  const startingAfter = options.startingAfter ?? -1;
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  res.flushHeaders();

  let detach = (): void => undefined;
  let finished = false;
  let chain: Promise<void> = Promise.resolve();
  const timers: NodeJS.Timeout[] = [];
  const stop = (): void => { for (const timer of timers) clearInterval(timer); detach(); };
  const end = (): void => { stop(); if (!res.writableEnded) res.end(); };

  const events = new ResponseEvents(run.id, (event) => {
    if (res.writableEnded || res.destroyed) return;
    if (res.writableLength > edge.consumerBufferedBytes) { res.destroy(); stop(); return; }
    if ((event.sequence_number as number) > startingAfter) res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
  });

  const settle = (approval?: { toolCallId: string; name: string; arguments: Record<string, unknown> }): void => {
    if (finished) return;
    finished = true;
    stop();
    chain = chain.then(async () => {
      const latest = await repository.getRun(conversation.id, run.id) ?? run;
      const view = await views.view(conversation, latest, includeToolCalls);
      if (approval && !isTerminal(latest.status) && !view.approvals.some((entry) => entry.toolCallId === approval.toolCallId)) view.approvals.push(approval);
      events.finish(responseObject(conversation, view));
    }).catch((error) => {
      log.error("responses_stream_failed", { run_id: run.id, error });
      events.error("internal_error", "The server had an error processing your request.");
    }).finally(end);
  };

  const first = await views.response(conversation, run, includeToolCalls);
  events.created({ ...first, status: first.status === "queued" ? "queued" : "in_progress", output: [], output_text: "", usage: null, error: null, incomplete_details: null });
  if (isTerminal(run.status)) { settle(); await chain; return; }

  let emitted = 0;
  const feed = edge.chat.feed.attach(conversation.id, { afterCursor: options.afterCursor, stream: true }, {
    push(event) {
      if (finished || event.run_id !== run.id) return;
      switch (event.type) {
        case "assistant.delta": {
          const delta = event.delta as { kind?: string; content?: string; offset?: number };
          if (delta.kind !== "text" || typeof delta.content !== "string") return;
          const start = typeof delta.offset === "number" ? delta.offset : emitted;
          const end = start + delta.content.length;
          if (end <= emitted) return;
          const piece = start < emitted ? delta.content.slice(emitted - start) : delta.content;
          emitted = end;
          chain = chain.then(() => events.text(piece));
          return;
        }
        case "tool_call.delta":
          if (includeToolCalls && event.locality === "server") {
            const item = liveToolItem(event);
            chain = chain.then(() => events.item(item, event.status !== "requested"));
          }
          return;
        case "tool_call.request":
          if (event.approval === "ask") settle({ toolCallId: String(event.tool_call_id), name: String(event.name), arguments: (event.arguments as Record<string, unknown>) ?? {} });
          return;
        case "turn.state":
          if (isTerminal(String(event.status))) settle();
          return;
        case "journal.event":
          if (event.journal_type === "run.state" && isTerminal(String((event.payload as { status?: string }).status))) settle();
          return;
        default:
      }
    }
  });
  detach = feed;
  // A Run another instance executes may end without this instance hearing of it: the durable record settles it.
  timers.push(setInterval(() => void repository.getRun(conversation.id, run.id).then(async (latest) => {
    if (!latest || finished) return;
    if (isTerminal(latest.status)) settle();
    else if (latest.status === "waiting_for_tool" && (await views.view(conversation, latest, includeToolCalls)).approvals.length) settle();
  }).catch(() => undefined), POLL_MS));
  timers.push(setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(": keep-alive\n\n"); }, options.keepAliveMs ?? KEEP_ALIVE_MS));
  for (const timer of timers) timer.unref();
  res.once("close", stop);
  signal?.addEventListener("abort", stop, { once: true });
  await new Promise<void>((resolve) => res.once("close", resolve));
}
