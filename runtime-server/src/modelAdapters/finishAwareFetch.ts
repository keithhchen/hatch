import type { FetchFunction } from "@earendil-works/pi-ai";

function sseEventHasFinishReason(event: string): boolean {
  for (const line of event.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const payload = JSON.parse(data) as { choices?: Array<{ finish_reason?: unknown }> };
      if (payload.choices?.some((choice) => typeof choice.finish_reason === "string" && choice.finish_reason.length > 0)) {
        return true;
      }
    } catch {
      // Leave malformed provider data for pi-ai to report. It must still see
      // the original event rather than a wrapper-generated parse error.
    }
  }
  return false;
}

/**
 * Pi AI's OpenAI adapter consumes an SSE iterable. A few compatible endpoints
 * send finish_reason and keep the TCP stream open; complete the provider body
 * at that protocol boundary while retaining the original request signal.
 */
export function finishAwareFetch(baseFetch: FetchFunction, timeoutMs?: number): FetchFunction {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
    ) {
      return response;
    }

    const upstream = response.body;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancelled = false;
    let streamClosed = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const failStream = (error: Error): void => {
          if (streamClosed) return;
          streamClosed = true;
          cancelled = true;
          void reader?.cancel(error);
          controller.error(error);
        };

        const armIdleTimeout = (): void => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (timeoutMs !== undefined && timeoutMs > 0) {
            // Pi's coding-agent uses an HTTP idle timeout for response bodies.
            // This is deliberately not a turn/output budget: every provider
            // chunk gives the model another full idle interval to respond.
            timeoutHandle = setTimeout(() => {
              failStream(new Error(`Provider stream idle timeout after ${timeoutMs}ms`));
            }, timeoutMs);
          }
        };

        armIdleTimeout();

        void (async () => {
          const decoder = new TextDecoder();
          const encoder = new TextEncoder();
          let buffer = "";

          const emitCompleteEvents = (): boolean => {
            while (true) {
              const match = buffer.match(/\r?\n\r?\n/);
              if (!match || match.index === undefined) return false;
              const end = match.index + match[0].length;
              const event = buffer.slice(0, end);
              buffer = buffer.slice(end);
              controller.enqueue(encoder.encode(event));
              if (sseEventHasFinishReason(event)) {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                streamClosed = true;
                cancelled = true;
                void reader?.cancel();
                controller.close();
                return true;
              }
            }
          };

          try {
            reader = upstream.getReader();
            while (!cancelled) {
              const next = await reader.read();
              if (next.done) {
                buffer += decoder.decode();
                if (buffer.length > 0) {
                  controller.enqueue(encoder.encode(buffer));
                  buffer = "";
                }
                if (!cancelled) {
                  streamClosed = true;
                  controller.close();
                }
                return;
              }
              buffer += decoder.decode(next.value, { stream: true });
              armIdleTimeout();
              if (emitCompleteEvents()) return;
            }
          } catch (error) {
            if (!streamClosed && !cancelled) {
              streamClosed = true;
              controller.error(error);
            }
          } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            reader?.releaseLock();
          }
        })();
      },
      cancel(reason) {
        streamClosed = true;
        cancelled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        return reader?.cancel(reason);
      }
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  };
}

