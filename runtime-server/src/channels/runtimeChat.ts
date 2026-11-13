import type { ChatGateway, RunProgress, SentMessage, UploadedRef } from "../chat/gateway.js";
import { ChatError } from "../chat/principal.js";

/**
 * The Chat gateway as the Registry reaches it: the Runtime is another process, so each call is a service-authenticated
 * request. It only carries the contract across: a refusal comes back as the ChatError Chat raised, and a failure to
 * reach the Runtime is an ordinary error, which sends the event back to the inbox to be tried again.
 */
export class HttpChatGateway implements ChatGateway {
  constructor(private readonly options: { baseUrl: string; serviceToken: string; timeoutMs?: number; fetch?: typeof fetch }) {}

  send(...[principal, conversation, client, messageId, parts]: Parameters<ChatGateway["send"]>): Promise<SentMessage> {
    return this.call("POST", "/messages", { body: JSON.stringify({ principal, conversation, client, message_id: messageId, parts }), type: "application/json" });
  }

  restart(...[principal, thread, key]: Parameters<ChatGateway["restart"]>): Promise<{ conversationId: string }> {
    return this.call("POST", "/conversations/restart", { body: JSON.stringify({ principal, thread, key }), type: "application/json" });
  }

  upload(...[principal, conversation, input]: Parameters<ChatGateway["upload"]>): Promise<UploadedRef> {
    // The bytes are the body; who they are for rides in a header, so they need no envelope.
    return this.call("POST", "/uploads", { body: new Blob([input.bytes as BlobPart]), type: "application/octet-stream", headers: { "x-hatch-upload": Buffer.from(JSON.stringify({ principal, conversation, name: input.name })).toString("base64url") } });
  }

  async progress(runId: string): Promise<RunProgress | undefined> {
    try { return await this.call("GET", `/runs/${encodeURIComponent(runId)}`); } catch (error) {
      if (error instanceof ChatError && error.code === "run_not_found") return undefined;
      throw error;
    }
  }

  private async call<T>(method: string, route: string, request: { body?: BodyInit; type?: string; headers?: Record<string, string> } = {}): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(`${this.options.baseUrl.replace(/\/$/, "")}/v1/service/chat${route}`, {
      method,
      headers: { authorization: `Bearer ${this.options.serviceToken}`, ...(request.type ? { "content-type": request.type } : {}), ...request.headers },
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000)
    });
    const body = await response.json().catch(() => undefined) as { error?: { code?: string; message?: string } } | undefined;
    if (response.ok) return body as T;
    if (body?.error?.code) throw new ChatError(body.error.code, body.error.message ?? body.error.code, response.status);
    throw new Error(`Chat service answered HTTP ${response.status}`);
  }
}
