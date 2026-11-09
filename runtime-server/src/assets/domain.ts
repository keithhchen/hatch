import { randomUUID } from "node:crypto";

/**
 * Who may see an asset. A contact exists only inside the Connection that met it,
 * and every scope is bound to one conversation.
 */
export type AssetScope =
  | { kind: "account"; accountId: string; conversationId: string }
  | { kind: "contact"; connectionId: string; contactId: string; conversationId: string };

const part = (value: string) => {
  if (!value) throw new Error("Asset scope parts must not be empty");
  return encodeURIComponent(value);
};

/** Injective: no two scopes share a key, and it is also the object-key prefix. */
export const scopeKey = (scope: AssetScope): string => scope.kind === "account"
  ? `account/${part(scope.accountId)}/c/${part(scope.conversationId)}`
  : `contact/${part(scope.connectionId)}/${part(scope.contactId)}/c/${part(scope.conversationId)}`;

export type AssetKind = "image" | "file" | "audio";
export type AssetState = "processing" | "ready" | "failed";
export type DerivativeRole = "resized" | "text" | "transcript";
export type Derivative = { role: DerivativeRole; key: string; bytes: number; mime: string; truncated?: boolean };
export type AssetFailure = { code: string; message: string };

/** Stable codes, so a client can tell "try again later" from "this file is bad". */
export class AssetError extends Error {
  constructor(
    readonly code: "too_large" | "unsupported_type" | "unsafe_archive" | "malformed" | "moderation_blocked" | "unavailable" | "not_found" | "not_ready" | "conflict",
    message: string
  ) {
    super(message);
  }
}

export type AssetRecord = {
  id: string; scope: AssetScope; sha256: string; kind: AssetKind; mime: string; name: string; bytes: number;
  state: AssetState; failure?: AssetFailure; derivatives: Derivative[]; transcript?: string; messageId?: string; createdAt: string;
};

/**
 * One uploaded thing. The state machine lives here, not in callers:
 * processing -> ready | failed, and only a ready asset may join a message, once.
 */
export class Asset {
  private constructor(readonly record: Readonly<AssetRecord>) {}

  static received(input: Pick<AssetRecord, "scope" | "sha256" | "kind" | "mime" | "name" | "bytes">): Asset {
    return new Asset({ ...input, id: randomUUID(), state: "processing", derivatives: [], createdAt: new Date().toISOString() });
  }
  static restore(record: AssetRecord): Asset { return new Asset(record); }

  get id() { return this.record.id; }
  get state() { return this.record.state; }
  get messageId() { return this.record.messageId; }
  derivative(role: DerivativeRole) { return this.record.derivatives.find(d => d.role === role); }

  ready(derivatives: Derivative[], transcript?: string): Asset {
    this.require("processing", "become ready");
    return new Asset({ ...this.record, state: "ready", derivatives, ...(transcript === undefined ? {} : { transcript }) });
  }
  failed(failure: AssetFailure): Asset {
    this.require("processing", "fail");
    return new Asset({ ...this.record, state: "failed", failure });
  }
  attachedTo(messageId: string): Asset {
    if (this.state !== "ready") throw new AssetError("not_ready", `Asset ${this.id} is ${this.state}`);
    if (this.messageId && this.messageId !== messageId) throw new AssetError("conflict", `Asset ${this.id} already belongs to another message`);
    return new Asset({ ...this.record, messageId });
  }
  private require(state: AssetState, action: string) {
    if (this.state !== state) throw new Error(`An asset that is ${this.state} cannot ${action}`);
  }
}

/** Storage port. The existing ArtifactObjectStore (OSS or local) satisfies it. */
export interface AssetBlobs {
  put(key: string, content: Buffer, options?: { contentType?: string }): Promise<unknown>;
  get(key: string): Promise<Buffer>;
}

/**
 * Persistence port. Idempotency and atomicity belong to the implementation's
 * database constraints, so every method must be safe under concurrent callers:
 * - insertIfAbsent: at most one non-failed asset per (scope, sha256).
 * - transition: compare-and-set on state; undefined when the asset moved first.
 * - attach: only a ready asset in this scope, bound once to one message.
 */
export interface AssetRepository {
  insertIfAbsent(asset: Asset): Promise<{ asset: Asset; created: boolean }>;
  transition(from: AssetState, next: Asset): Promise<Asset | undefined>;
  get(scope: AssetScope, id: string): Promise<Asset | undefined>;
  attach(scope: AssetScope, id: string, messageId: string): Promise<Asset>;
  listAttached(scope: AssetScope): Promise<Asset[]>;
}

export type Moderated = { type: "image"; bytes: Buffer; mime: string } | { type: "text"; text: string };
export interface ContentModerator { check(content: Moderated): Promise<{ allowed: true } | { allowed: false; reason: string }>; }

export type Transcript = { status: "ok"; text: string } | { status: "unavailable"; reason: string };
/** Takes 16 kHz mono signed 16-bit little-endian PCM. */
export interface Transcriber { transcribe(pcm16k: Buffer): Promise<Transcript>; }
export interface AudioNormalizer { toPcm16k(audio: Buffer, maxSeconds: number): Promise<Buffer>; }

/** Messages in workstreams A and B may reference only what this returns. */
export interface ReadyAssetResolver { resolveReadyAsset(scope: AssetScope, assetId: string): Promise<Asset>; }
