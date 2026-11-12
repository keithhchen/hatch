import { createHmac } from "node:crypto";
import type { Dispatcher, Send } from "./dispatch.js";
import type { openChannelStores } from "./postgres/stores.js";

/** Test support only: a fetch that records each request and answers it, so no test touches a network. */
export type Call = { url: string; init: RequestInit; body: any };

export function recorder(respond: (url: string, init: RequestInit) => Response | Promise<Response> = () => new Response("{}")) {
  const calls: Call[] = [];
  const fake = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
    return respond(String(url), init);
  }) as typeof fetch;
  return { calls, fake };
}

export const sign = (body: string | Buffer, secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
/** Test support only: answers an inbound message the way a Run's reply does, so delivery rules are exercised without a Run. */
export async function replyToInbound(stack: Pick<Awaited<ReturnType<typeof openChannelStores>>, "inbox" | "connections"> & { dispatcher: Dispatcher }, inboundId: string, message: Send["message"]): Promise<void> {
  const item = (await stack.inbox.get(inboundId))!;
  const connectionId = item.connectionId ?? (await stack.connections.resolveConnection({ channel: item.channel, scope: item.scope, senderId: item.event.address.senderId }))!.connection.id;
  await stack.dispatcher.send({ connectionId, channel: item.channel, scope: item.scope, address: item.event.address, kind: "reply", message: { ...message, ...(item.event.messageRef ? { replyTo: item.event.messageRef } : {}) } });
  await stack.inbox.markReplied([item.id]);
}
export const graphError =(status: number, error: Record<string, unknown>, headers: Record<string, string> = {}) => new Response(JSON.stringify({ error }), { status, headers });
