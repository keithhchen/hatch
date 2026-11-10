/**
 * How much of the active Run's text this client already holds. The server numbers every text delta by `offset`, its place
 * in the Run's text, so a delta that replays what is known (a reconnect, a snapshot's partial output) is skipped exactly,
 * and one that overlaps it is cut to its new part.
 */
export class RunText {
  constructor() { this.runId = null; this.length = 0; }

  reset(runId = null) { this.runId = runId; this.length = 0; }

  /** The part of a delta that is new, "" when all of it is known. A delta without an offset is taken whole. */
  take(runId, content, offset) {
    if (runId !== this.runId) this.reset(runId);
    if (typeof offset !== "number") { this.length += content.length; return content; }
    const fresh = offset >= this.length ? content : content.slice(this.length - offset);
    // A gap (offset ahead of what is held) is taken as it comes: the Run's end reads the saved text.
    this.length = Math.max(this.length, offset + content.length);
    return fresh;
  }

  /** The part of a snapshot's partial output beyond what is held, given the text already in saved messages. */
  tail(runId, partial, committed) {
    if (runId !== this.runId) this.reset(runId);
    const known = Math.max(this.length, committed);
    this.length = Math.max(this.length, partial.length);
    return partial.length > known ? partial.slice(known) : "";
  }
}
