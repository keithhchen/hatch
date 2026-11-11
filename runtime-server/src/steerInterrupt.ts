import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";

const aborted = (model: Model<Api>): AssistantMessage => ({
  role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "aborted", errorMessage: "A message joined the Run", timestamp: Date.now()
});

/**
 * A message that joins a Run cuts the model call that is streaming, if one is. A tool that is executing is never cut:
 * its effects stay atomic, and the message is read before the next model call. The cut call ends as an aborted result that carries what it had written;
 * `cut` tells the Run's event handling that this abort is not a failure.
 */
export class SteerInterrupt {
  private drop?: () => void;
  private dropped = false;

  /** A message joined the Run. */
  wake(): void { this.drop?.(); }

  get cut(): boolean { return this.dropped; }

  /** The Run took the cut into account. */
  settle(): void { this.dropped = false; }

  wrap(inner: StreamFn): StreamFn {
    return (model, context, options) => {
      const out = createAssistantMessageEventStream();
      const request = new AbortController();
      const signal = options?.signal ? AbortSignal.any([options.signal, request.signal]) : request.signal;
      let open = true;
      let written: AssistantMessage["content"] = [];
      const drop = (): void => {
        if (!open) return;
        open = false;
        this.dropped = true;
        request.abort();
        out.push({ type: "error", reason: "aborted", error: { ...aborted(model), content: written } });
        out.end();
      };
      this.drop = drop;
      void (async () => {
        try {
          for await (const event of await inner(model, context, { ...options, signal })) {
            if (!open) break;
            out.push(event);
            if ("partial" in event) written = structuredClone(event.partial.content);
            if (event.type === "done" || event.type === "error") { open = false; break; }
          }
        } catch (error) {
          if (open) out.push({ type: "error", reason: "error", error: { ...aborted(model), stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) } });
        } finally {
          open = false;
          if (this.drop === drop) this.drop = undefined;
          out.end();
        }
      })();
      return out;
    };
  }
}
