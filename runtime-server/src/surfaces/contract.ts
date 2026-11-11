/**
 * The contract every surface shares: Studio API, Chat API, CLI/MCP and the
 * channel adapters. See docs/spec-surfaces-v1.md for why each rule exists.
 */

export const CLIENT_GROUPS = ["web", "desktop", "cli", "mcp", "im", "dm"] as const;
export type ClientGroup = typeof CLIENT_GROUPS[number];

const DEVICES = ["ios", "android", "macos", "windows", "linux"] as const;
export type Device = typeof DEVICES[number];

/** What the model is told about the client. Only server-normalized values. */
export type ClientAttributes = { client: ClientGroup; device?: Device; locale?: string; language?: string };

const canonicalLocale = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !value) return undefined;
  try { return Intl.getCanonicalLocales(value)[0]; } catch { return undefined; }
};

/** Client-supplied strings never reach the model: an unrecognized value is dropped. */
export function normalizeClientAttributes(raw: { client: string; device?: unknown; locale?: unknown; language?: unknown }): ClientAttributes {
  if (!(CLIENT_GROUPS as readonly string[]).includes(raw.client)) throw new Error(`Unknown client: ${raw.client}`);
  const device = (DEVICES as readonly unknown[]).includes(raw.device) ? raw.device as Device : undefined;
  const locale = canonicalLocale(raw.locale);
  const language = canonicalLocale(raw.language);
  return { client: raw.client as ClientGroup, ...(device ? { device } : {}), ...(locale ? { locale } : {}), ...(language ? { language } : {}) };
}

/** Appended after all history on each model call and never persisted, so the cached prefix survives. */
export function renderSystemReminder(attributes: ClientAttributes): string {
  const lines = (["client", "device", "locale", "language"] as const).flatMap(key => attributes[key] ? [`${key}: ${attributes[key]}`] : []);
  return `<system-reminder>\n${lines.join("\n")}\n</system-reminder>`;
}

/** Declared once per API as the full set; which clients may run it is part of the declaration. */
export type SurfaceTool = { name: string; description: string; supportedClients: readonly ClientGroup[] | "*" };

export const describeTool = (tool: SurfaceTool): string =>
  tool.supportedClients === "*" ? tool.description : `${tool.description}\n\nAvailable on: ${tool.supportedClients.join(", ")}`;

/** A changed byte in the tool list invalidates every cached token after it. */
export const orderTools = <T extends { name: string }>(tools: readonly T[]): T[] => [...tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export type ToolAuthorization = { allowed: true } | { allowed: false; error: { code: "tool_unsupported_on_client"; message: string } };

/** The authority. `client` is the client of the latest message in the conversation. */
export function authorizeToolCall(tool: SurfaceTool, client: ClientGroup): ToolAuthorization {
  if (tool.supportedClients === "*" || tool.supportedClients.includes(client)) return { allowed: true };
  return { allowed: false, error: { code: "tool_unsupported_on_client", message: `${tool.name} is not available on ${client}. Available on: ${tool.supportedClients.join(", ")}.` } };
}

/** Who is acting. A contact exists only inside the Connection that met it. */
export type Principal = { kind: "account"; accountId: string } | { kind: "contact"; connectionId: string; contactId: string };

export type Audience = "self" | "org" | "public";
export type ConnectionState = "active" | "degraded" | "revoked";
export type AgentTarget = { kind: "assistant" } | { kind: "product"; productId: string };

/** One authorization of one platform: who owns it, which Agent answers, and for whom. */
export type Connection = {
  id: string;
  ownerAccountId: string;
  channel: string;
  client: Extract<ClientGroup, "im" | "dm">;
  target: AgentTarget;
  audience: Audience;
  /** An operator reviewed the Agent as a task-specific business agent. Never assumed: platforms that bar general-purpose AI check it. */
  taskSpecific: boolean;
  state: ConnectionState;
};

/** A thread and its speaker are different things: permission follows the sender. */
export type ChannelAddress = { connectionId: string; threadId: string; senderId: string };

export type ChannelCapabilities = {
  stream: boolean;
  edit: boolean;
  typing: boolean;
  buttons: boolean;
  /** Longest single message the platform accepts, in characters. */
  maxLength: number;
  /** Also longest, in UTF-8 bytes, where the platform counts bytes. */
  maxBytes?: number;
  /** Messages the platform lets us send to a thread after each message it sends us; absent when unlimited. What does not fit stays in Hatch as `undelivered`. */
  replyAllowance?: number;
  /** Milliseconds after the last inbound message during which a reply is allowed; absent when unlimited. */
  replyWindowMs?: number;
  canInitiate: boolean;
  /** The platform accepts a key that makes a repeated send a no-op. */
  idempotentSend: boolean;
};

/** Bytes never travel in a message: every attachment refers to a ready asset. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; assetId: string }
  | { type: "file"; assetId: string }
  | { type: "audio"; assetId: string };

export type DeliveryState = "pending" | "sending" | "sent" | "failed" | "unknown" | "cancelled" | "undelivered";

/** "ambiguous" means the platform may have accepted it, such as a timeout after sending. */
export type DeliveryFailure = "definite" | "ambiguous" | "permanent";

/** Sending too little is recoverable; sending the same reply twice is not. */
export function deliveryAfterFailure(input: { failure: DeliveryFailure; idempotent: boolean }): DeliveryState {
  if (input.failure === "permanent") return "failed";
  if (input.failure === "ambiguous" && !input.idempotent) return "unknown";
  return "pending";
}

/** One position in a conversation's event log. Snapshot and events share it, in every transport. */
export type EventCursor = string;
