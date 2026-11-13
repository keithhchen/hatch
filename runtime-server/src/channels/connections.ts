import { randomBytes } from "node:crypto";
import type { AgentTarget, Audience, Connection, ConnectionState, Principal } from "../surfaces/contract.js";
import type { ChannelKind, SenderProfile } from "./types.js";

/** A Connection as the channel layer holds it. `scope` is the platform tenant it was authorized on: empty for our shared account. */
export type ChannelConnection = Connection & { scope: string };
/** A sender known to a Connection: the Expert who linked, or a contact who wrote in. `threadId` is where they were reached last. */
export type Identity = { id: string; connectionId: string; senderId: string; threadId: string };
export type OwnedConnection = ChannelConnection & { linked: boolean; hasCredentials: boolean; lastEventAt?: string; /** Who is bound, as the platform names them. */ senderId?: string };
export type Resolved = { connection: ChannelConnection; identity?: Identity };
/** A Connection a sender was just bound to. */
export type Linked = ChannelConnection;

/** No lookalikes: Experts may retype this. */
export function newLinkCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return `HATCH-${[...randomBytes(8)].map(byte => alphabet[byte % alphabet.length]).join("")}`;
}
export const LINK_CODE_PATTERN = /HATCH-[A-Z0-9]{8}/;

export const targetKey = (target: Connection["target"]): string => target.kind === "assistant" ? "assistant" : `product:${target.productId}`;
/** Studio's own entry is the Assistant, which works across the account's Products. A Product's Chat is bound per Product. */
export const STUDIO_TARGET: AgentTarget = { kind: "assistant" };

/** The Assistant manages Studio, so only its owner may reach it: a Connection that is not `self` can only point at a Product. */
export function assertReachable(connection: Pick<Connection, "audience" | "target">): void {
  if (connection.target.kind === "assistant" && connection.audience !== "self") throw new Error("Only a self Connection can reach the Assistant");
}

/** `self` acts as its owner. Everyone else is a contact, isolated by Connection and contact. */
export function principalFor(connection: ChannelConnection, identity: Identity): Principal {
  return connection.audience === "self"
    ? { kind: "account", accountId: connection.ownerAccountId }
    : { kind: "contact", connectionId: connection.id, contactId: identity.id };
}

/**
 * Platforms whose sender id is the same user id in every bot, so Hatch can tell that two Connections met one person. Not
 * LINE, Lark, Messenger, Instagram or Slack (an id per provider, app, page or workspace), and not WhatsApp, whose thread carries the
 * business account and phone number around the sender's number.
 */
export const GLOBAL_USER_ID_CHANNELS: ReadonlySet<ChannelKind> = new Set<ChannelKind>(["telegram", "discord"]);

/** Port: who each platform sender is, and which Agent answers them. */
export interface ConnectionRepository {
  /** A one-time code the owner sends from the platform, to bind their chat to the Assistant (Studio) or to one of their Products (Chat). The self Connection is created on the first call. */
  issueCode(ownerAccountId: string, channel: ChannelKind, target?: AgentTarget, now?: Date): Promise<string>;
  /** Bind the sender to the Connection that issued the code. The sender moves away from any earlier Connection. */
  redeem(channel: ChannelKind, scope: string, code: string, who: { senderId: string; threadId: string }, now?: Date): Promise<Linked | undefined>;
  /** What a still-valid code would make of whoever sends it, and whose Assistant that is. */
  peekCode(channel: ChannelKind, scope: string, code: string, now?: Date): Promise<{ ownerAccountId: string } | undefined>;
  /**
   * Which Connection a sender on a platform tenant belongs to. One endpoint can serve many tenants, so this runs per event.
   * A sender we know resolves through their identity. An unknown sender resolves to the tenant's own Connection, if it has one.
   */
  resolveConnection(payload: { channel: ChannelKind; scope: string; senderId: string }): Promise<Resolved | undefined>;
  /** A contact writes in to a `public` Connection: remember them. */
  meet(connection: ChannelConnection, who: { senderId: string; threadId: string; profile?: SenderProfile }): Promise<Identity>;
  /** A contact wrote again: keep what Hatch knows of the person current. Hatch-internal; no Connection's owner sees it. */
  recognize(connection: ChannelConnection, who: { senderId: string; profile?: SenderProfile }): Promise<void>;
  /** The person behind this platform user signed in as `accountId`. False when they are already linked to another account. */
  linkAccount(channel: ChannelKind, platformUserId: string, accountId: string): Promise<boolean>;
  /** The Assistant Connections the account owns that someone is linked to, most recently active first: where the Assistant reaches them. */
  linked(ownerAccountId: string): Promise<Resolved[]>;
  /** Every Connection the account owns, linked or not, with what Studio shows of it. */
  owned(ownerAccountId: string): Promise<OwnedConnection[]>;
  /** How many people are bound to a Connection as contacts: those who have written to it. */
  contactCount(connectionId: string): Promise<number>;
  get(id: string): Promise<ChannelConnection | undefined>;
  touch(id: string): Promise<void>;
  /** `degraded` only from `active`; back to `active` only from `degraded`. */
  setState(id: string, state: ConnectionState): Promise<void>;
  /**
   * Unbinding ends the binding: the account's self Connection to `target` is deleted with its identities and credentials, and nothing
   * still queued for it is sent. Idempotent. To bind again is to bind anew.
   */
  unbind(ownerAccountId: string, channel: ChannelKind, target?: AgentTarget): Promise<void>;
  /** The platform says this Connection can no longer reach its person (they blocked or removed the bot): a self Connection is unbound; any other keeps serving. False when it was not self or is already gone. */
  unbindPersonal(id: string): Promise<boolean>;
  /** A sender took themselves away from our account on the platform. Their self Connection is unbound; for a contact only their identity goes, and the Connection keeps serving everyone else. */
  unbindSender(channel: ChannelKind, scope: string, senderId: string): Promise<void>;
  /**
   * `scope` names the platform tenant the credentials belong to, where that is known only from them (a Slack workspace, a Page, a bot).
   * They go on the Assistant's Connection, or on a Product's public one. A new scope drops everyone bound under the old one.
   */
  saveCredentials(ownerAccountId: string, channel: ChannelKind, sealed: string, scope?: string, target?: AgentTarget): Promise<void>;
  credentials(ownerAccountId: string, channel: ChannelKind): Promise<string | undefined>;
  /** Who holds a Product's bot: the Connection under this scope, live or dormant. */
  botHolder(channel: ChannelKind, scope: string): Promise<{ ownerAccountId: string; target: AgentTarget } | undefined>;
  /**
   * A Product's own bot is one Connection for as long as the bot exists: `scope` names the bot itself. Binding makes it the Product's live bot,
   * creating the Connection or waking the dormant one with its contacts and conversations, and puts any other bot of the Product to sleep.
   * `legacy` is the Product's live bot from before bots had a scope of their own: it moves to the scope `as` first. A bot another Product or account holds is refused (409 `<channel>_bot_in_use`).
   */
  bindBot(ownerAccountId: string, channel: ChannelKind, target: AgentTarget, scope: string, sealed: string, legacy?: { scope: string; as: string }): Promise<void>;
  /** The Product lets its live bot go: credentials are cleared and the Connection is kept, dormant, with everyone who wrote to it. `as` is the scope a legacy bot takes first. */
  sleepBot(ownerAccountId: string, channel: ChannelKind, target: AgentTarget, as?: string): Promise<void>;
  /** The sealed credentials of a platform tenant on a shared app, whoever owns its Connection. Absent once access is gone. */
  credentialsOf(channel: ChannelKind, scope: string): Promise<string | undefined>;
  /** Who a still-valid link code was issued to, for a platform's install redirect that carries it as `state`. */
  ownerOfCode(channel: ChannelKind, code: string, now?: Date): Promise<string | undefined>;
  /** The platform took a tenant's access away: its Connections are unbound, with everyone bound to them and their credentials. */
  unbindTenant(channel: ChannelKind, scope: string): Promise<void>;
  /** Tenants that bring their own app: Connections holding credentials. */
  listening(): Promise<Array<{ ownerAccountId: string; channel: ChannelKind; scope: string }>>;
}
