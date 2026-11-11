import { randomBytes } from "node:crypto";
import { UpstreamError, type UpstreamCause } from "./upstream.js";

/** The only shape of a failure that crosses to a client. `reference` is what staff look up. */
export type PublicFailure = { code: string; message: string; reference?: string };

/** What staff see for a reference. The cause is internal: no API returns it. */
export type FailureRecord = {
  reference: string;
  at: string;
  /** Where it happened: ids such as run, conversation, session or stage. */
  scope: Record<string, string | undefined>;
  code: string;
  cause?: { kind: UpstreamCause; provider: string; status?: number };
  /** Hatch's own failures keep their message; an upstream one is stored redacted. */
  detail: string;
};

/** Where failure records are kept durably. */
export interface FailureLedger { record(record: FailureRecord): Promise<void> }

export const UPSTREAM_CODE = "upstream_error";
const upstreamMessage = (reference: string): string => `An upstream service Hatch uses failed. This is not a problem with your account. Reference: ${reference}.`;
const newReference = (): string => `err_${randomBytes(6).toString("hex")}`;

/**
 * The one place a thrown error becomes something a client may see. An upstream failure becomes `upstream_error`
 * and a fixed message with a reference; Hatch's own errors keep their message under `run_failed`.
 * Each is logged as one structured line and stored in the ledger under its reference.
 */
export class FailureBoundary {
  private ledger?: FailureLedger;

  attach(ledger: FailureLedger): void { this.ledger = ledger; }

  translate(error: unknown, scope: FailureRecord["scope"] = {}): PublicFailure {
    const upstream = error instanceof UpstreamError ? error : undefined;
    const reference = newReference();
    const own = (error instanceof Error ? error.message : String(error)).replace(/\b(?:sk-|tvly-|fc-)[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 1000);
    const record: FailureRecord = {
      reference, at: new Date().toISOString(), scope,
      code: upstream ? UPSTREAM_CODE : "run_failed",
      ...(upstream ? { cause: { kind: upstream.kind, provider: upstream.provider, ...(upstream.status ? { status: upstream.status } : {}) } } : {}),
      detail: upstream ? upstream.detail : own
    };
    console.error(JSON.stringify({ event: "failure", ...record }));
    void this.ledger?.record(record).catch(failure => console.error(JSON.stringify({ event: "failure_ledger_unavailable", reference, error: String(failure) })));
    return upstream ? { code: UPSTREAM_CODE, message: upstreamMessage(reference), reference } : { code: "run_failed", message: own, reference };
  }

  /** Runs `work`; a throw is translated once and handed to `onFailure`, so callers do not catch. */
  async guard<T>(scope: FailureRecord["scope"], work: () => Promise<T>, onFailure: (failure: PublicFailure, error: unknown) => Promise<void> | void): Promise<T | undefined> {
    try { return await work(); } catch (error) { await onFailure(this.translate(error, scope), error); return undefined; }
  }
}

/** The process's boundary: every surface translates through it, and the server attaches the ledger once. */
export const failures = new FailureBoundary();

/**
 * A failed Run's stored reason, read back as the failure its clients see. The reason is the message this boundary built,
 * and the message of an upstream failure carries its reference, so the shape is the same wherever a Run is looked up later.
 */
export function failureOfReason(reason: string | undefined): PublicFailure {
  const reference = /Reference: (err_[0-9a-f]+)\./.exec(reason ?? "")?.[1];
  const message = reason || "The Run failed. Send the message again.";
  return reference ? { code: UPSTREAM_CODE, message, reference } : { code: "run_failed", message };
}
