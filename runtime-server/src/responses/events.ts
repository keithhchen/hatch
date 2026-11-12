import { assistantItemId, messageItem, toolCallItem, type Json } from "./mapping.js";

/**
 * The OpenAI Responses event sequence for one response, kept in order: `response.created`, `response.in_progress`, the message
 * item (added, content part added, text deltas, text done, part done, item done), other output items, then exactly one of
 * `response.completed` | `response.failed` | `response.incomplete`. Every event carries `sequence_number`.
 * It knows nothing of where its facts come from: a live Run and a replay of a finished one drive it the same way.
 */
export class ResponseEvents {
  private sequence = 0;
  private nextIndex = 0;
  private message: { index: number; text: string } | undefined;
  private readonly others = new Map<string, { index: number; done: boolean }>();
  private closed = false;

  constructor(private readonly runId: string, private readonly emit: (event: Json) => void) {}

  private send(event: Json): void { this.emit({ ...event, sequence_number: this.sequence++ }); }

  created(response: Json): void {
    this.send({ type: "response.created", response });
    this.send({ type: "response.in_progress", response });
  }

  /** The words of the reply, as they arrive. */
  text(delta: string): void {
    if (this.closed || !delta) return;
    const message = this.openMessage();
    message.text += delta;
    this.send({ type: "response.output_text.delta", item_id: assistantItemId(this.runId), output_index: message.index, content_index: 0, delta });
  }

  /** Server tool activity (`hatch_tool_call`): added when it starts, done when it ends. The reply's item comes first, always. */
  item(item: Json, done: boolean): void {
    if (this.closed) return;
    const id = String(item.id);
    this.openMessage();
    let known = this.others.get(id);
    if (!known) {
      known = { index: this.nextIndex++, done: false };
      this.others.set(id, known);
      this.send({ type: "response.output_item.added", output_index: known.index, item });
    }
    if (done && !known.done) {
      known.done = true;
      this.send({ type: "response.output_item.done", output_index: known.index, item });
    }
  }

  /** The end: closes what is open, adds what the response holds that was not streamed, and tells how it ended. */
  finish(response: Json): void {
    if (this.closed) return;
    const output = (response.output as Json[]) ?? [];
    const reply = output.find((item) => item.type === "message");
    const text = String(response.output_text ?? "");
    if (reply || this.message || output.some((item) => item.type !== "message")) {
      const message = this.openMessage();
      if (text.startsWith(message.text) && text.length > message.text.length) this.text(text.slice(message.text.length));
      this.send({ type: "response.output_text.done", item_id: assistantItemId(this.runId), output_index: message.index, content_index: 0, text });
      this.send({ type: "response.content_part.done", item_id: assistantItemId(this.runId), output_index: message.index, content_index: 0, part: { type: "output_text", text, annotations: [] } });
      this.send({ type: "response.output_item.done", output_index: message.index, item: (reply as Json | undefined) ?? messageItem(this.runId, text) });
    }
    for (const item of output.filter((entry) => entry.type !== "message")) this.item(item, true);
    this.closed = true;
    const status = String(response.status);
    this.send({ type: status === "completed" ? "response.completed" : status === "failed" ? "response.failed" : "response.incomplete", response });
  }

  /** A failure of the stream itself, not of the Run. */
  error(code: string, message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.send({ type: "error", code, message, param: null });
  }

  private openMessage(): { index: number; text: string } {
    if (this.message) return this.message;
    this.message = { index: this.nextIndex++, text: "" };
    this.send({ type: "response.output_item.added", output_index: this.message.index, item: { ...messageItem(this.runId, "", "in_progress"), content: [] } });
    this.send({ type: "response.content_part.added", item_id: assistantItemId(this.runId), output_index: this.message.index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    return this.message;
  }
}

/** A live `tool_call.delta` as the `hatch_tool_call` item it reports. */
export const liveToolItem = (event: Json): Json => toolCallItem({
  tool_call_id: String(event.tool_call_id), name: String(event.name),
  status: event.status as "requested" | "completed" | "failed" | "cancelled",
  arguments: (event.arguments as Record<string, unknown> | undefined) ?? {},
  ...(event.result !== undefined ? { result: event.result } : {}),
  ...(event.error !== undefined ? { error: event.error } : {})
});
