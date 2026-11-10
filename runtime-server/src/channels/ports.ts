import type { AgentTarget, ChannelAddress, Principal } from "../surfaces/contract.js";
import type { ChannelConnection } from "./connections.js";
import type { ChannelAdapter, ChannelKind, InboundEvent, OutboundMessage } from "./types.js";

/** One authorized event on its way to the Agent that answers it. */
export type Inbound = {
  /** The inbox id: stable across retries, so a target can make its own work idempotent. */
  id: string;
  connection: ChannelConnection;
  principal: Principal;
  address: ChannelAddress;
  event: InboundEvent;
  adapter: ChannelAdapter;
  /** A short message to the sender that is not part of any conversation. */
  notify(text: string): Promise<void>;
};

/** `replied` means the sender already has their answer; a Run's reply comes later, by its id. */
export type Handled = { replied: boolean; runId?: string };

/** How a Run's final reply is dressed for the person waiting, as the Agent that answered wants it. */
export type ReplyPolicy = { /** A Run that said nothing sends nothing. */ quietWhenEmpty?: boolean; buttons?: NonNullable<OutboundMessage["buttons"]> };

/** Port: the Agent behind a Connection. One per kind of AgentTarget. Throwing returns the event to the queue. */
export interface TargetHandler {
  handle(inbound: Inbound): Promise<Handled>;
  /** What to say once someone has linked to this Connection. */
  linked(connection: ChannelConnection): Promise<string>;
  /** How the final reply of one of this Agent's Runs is sent. Without it, every Run's reply is sent as it is. */
  replyPolicy?(connection: ChannelConnection, runId: string): Promise<ReplyPolicy>;
}
export type TargetKind = AgentTarget["kind"];

/** Port: the Chat API. One contract for both sides: Chat implements it in its process, the Registry reaches it over HTTP. */
export type { ChatGateway } from "../chat/gateway.js";

/**
 * Port: what the Assistant needs from the channel layer. It never sees a platform. Answering a message the Expert sent is
 * not here: that is a Run's reply, which the channel layer sends when the Run ends.
 */
export interface AssistantChannels {
  /** A message the Assistant starts, to the Expert's linked chat; on `prefer` if linked there. False when no chat can take it. */
  push(accountId: string, message: Pick<OutboundMessage, "text" | "buttons">, prefer?: ChannelKind): Promise<boolean>;
  /** Whether a message started now could reach the Expert, so a model call for it is not wasted. */
  canReach(accountId: string): Promise<boolean>;
}
