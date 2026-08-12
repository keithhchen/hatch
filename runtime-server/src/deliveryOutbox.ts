import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { DeliveryBinding, DeliveryUnitReservation } from "./delivery.js";

const safeIdentifier = z.string().min(1).max(1_024);
const sha256Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const DeliveryBindingSchema = z.object({
  entitlementId: safeIdentifier,
  orderId: safeIdentifier,
  userId: safeIdentifier,
  creatorId: safeIdentifier,
  agentId: safeIdentifier,
  productId: safeIdentifier,
  purchasedCorpusDigest: sha256Digest.optional(),
  corpusDigest: sha256Digest
}).strict() satisfies z.ZodType<DeliveryBinding>;

const DeliveryUnitReservationSchema = z.object({
  reservationId: safeIdentifier,
  taskId: safeIdentifier,
  deliveryId: safeIdentifier
}).strict() satisfies z.ZodType<DeliveryUnitReservation>;

export type DeliveryAccountingCommand = {
  version: 1;
  commandId: string;
  binding: DeliveryBinding;
  conversationId: string;
  runId: string;
  artifact: {
    type: "file" | "message";
    digest: string;
  };
  reservation: DeliveryUnitReservation;
};

/**
 * A deliberately closed accounting envelope. It contains enough information
 * to reconstruct idempotent Commerce events, but has no field in which Runtime
 * artifact content or a Buyer Workspace path can be persisted.
 */
export const DeliveryAccountingCommandSchema: z.ZodType<DeliveryAccountingCommand> = z.object({
  version: z.literal(1),
  commandId: safeIdentifier,
  binding: DeliveryBindingSchema,
  conversationId: safeIdentifier,
  runId: safeIdentifier,
  artifact: z.object({
    type: z.enum(["file", "message"]),
    digest: sha256Digest
  }).strict(),
  reservation: DeliveryUnitReservationSchema
}).strict();

export type DeliveryAccountingOutboxEntry = {
  command: DeliveryAccountingCommand;
  enqueuedAt: string;
  attemptCount: number;
  lastAttemptAt?: string;
};

export type DeliveryAccountingReconcileResult = {
  attempted: number;
  delivered: string[];
  failed: Array<{ commandId: string; error: unknown }>;
};

export type DeliveryAccountingOutboxOptions = {
  clock?: () => Date;
  lockTimeoutMs?: number;
  staleLockMs?: number;
};

export class DeliveryAccountingOutboxError extends Error {
  constructor(
    readonly code: "invalid_command" | "idempotency_conflict" | "corrupt_outbox" | "outbox_busy",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "DeliveryAccountingOutboxError";
  }
}

/**
 * Durable, file-backed pending delivery accounting.
 *
 * Mutations are serialized in-process and guarded by a short-lived file lock,
 * then committed with atomic replacement. Reconciliation is at-least-once:
 * the injected deliver callback must use the command's stable identifiers as
 * Commerce idempotency keys. A command is removed only after deliver resolves.
 */
export class DeliveryAccountingOutbox {
  private readonly filePath: string;
  private readonly clock: () => Date;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private writeChain: Promise<void> = Promise.resolve();
  private reconcileChain: Promise<void> = Promise.resolve();

  constructor(filePath: string, options: DeliveryAccountingOutboxOptions = {}) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      throw new DeliveryAccountingOutboxError("corrupt_outbox", "Delivery accounting outbox path is required");
    }
    this.filePath = path.resolve(filePath);
    this.clock = options.clock ?? (() => new Date());
    this.lockTimeoutMs = positiveInteger(options.lockTimeoutMs ?? 5_000, "lockTimeoutMs");
    this.staleLockMs = positiveInteger(options.staleLockMs ?? 30_000, "staleLockMs");
  }

  /**
   * Validates the durable envelope and proves its parent directory can be
   * locked for a future atomic write without inventing a synthetic command.
   */
  async initialize(): Promise<void> {
    await this.mutate(() => ({ changed: false, value: undefined }));
  }

  async enqueue(command: DeliveryAccountingCommand): Promise<DeliveryAccountingOutboxEntry> {
    const parsed = DeliveryAccountingCommandSchema.safeParse(command);
    if (!parsed.success) {
      throw new DeliveryAccountingOutboxError(
        "invalid_command",
        `Invalid delivery accounting command: ${z.prettifyError(parsed.error)}`
      );
    }
    const normalized = parsed.data;
    return this.mutate((state) => {
      const existing = state.entries.find((entry) => entry.command.commandId === normalized.commandId);
      if (existing) {
        if (!sameCommand(existing.command, normalized)) {
          throw new DeliveryAccountingOutboxError(
            "idempotency_conflict",
            `Delivery accounting command ${normalized.commandId} already exists with a different payload`
          );
        }
        return { changed: false, value: cloneEntry(existing) };
      }
      const entry: DeliveryAccountingOutboxEntry = {
        command: structuredClone(normalized),
        enqueuedAt: timestamp(this.clock),
        attemptCount: 0
      };
      state.entries.push(entry);
      return { changed: true, value: cloneEntry(entry) };
    });
  }

  async list(): Promise<DeliveryAccountingOutboxEntry[]> {
    await this.writeChain.catch(() => {});
    const state = await readState(this.filePath);
    return state.entries.map(cloneEntry);
  }

  /** Removes a successfully delivered command. Replays are harmless. */
  async markDelivered(commandId: string): Promise<boolean> {
    requireIdentifier(commandId, "commandId");
    return this.mutate((state) => {
      const index = state.entries.findIndex((entry) => entry.command.commandId === commandId);
      if (index < 0) return { changed: false, value: false };
      state.entries.splice(index, 1);
      return { changed: true, value: true };
    });
  }

  /**
   * Attempts a stable snapshot in FIFO order. Failures remain pending while a
   * failing command does not prevent independent later commands from delivery.
   * Calls on the same instance are serialized to avoid duplicate local work.
   */
  reconcile(
    deliver: (command: DeliveryAccountingCommand) => Promise<void>,
    options: { limit?: number } = {}
  ): Promise<DeliveryAccountingReconcileResult> {
    if (typeof deliver !== "function") throw new TypeError("deliver must be a function");
    const limit = options.limit === undefined ? Number.POSITIVE_INFINITY : positiveInteger(options.limit, "limit");
    return this.enqueueReconciliation(async () => {
      const entries = (await this.list()).slice(0, limit);
      const result: DeliveryAccountingReconcileResult = { attempted: 0, delivered: [], failed: [] };
      for (const entry of entries) {
        const pending = await this.recordAttempt(entry.command.commandId);
        if (!pending) continue;
        result.attempted += 1;
        try {
          await deliver(structuredClone(pending));
          await this.markDelivered(pending.commandId);
          result.delivered.push(pending.commandId);
        } catch (error) {
          result.failed.push({ commandId: pending.commandId, error });
        }
      }
      return result;
    });
  }

  private async recordAttempt(commandId: string): Promise<DeliveryAccountingCommand | undefined> {
    return this.mutate((state) => {
      const entry = state.entries.find((candidate) => candidate.command.commandId === commandId);
      if (!entry) return { changed: false, value: undefined };
      entry.attemptCount += 1;
      entry.lastAttemptAt = timestamp(this.clock);
      return { changed: true, value: structuredClone(entry.command) };
    });
  }

  private mutate<T>(operation: (state: OutboxState) => MutationResult<T>): Promise<T> {
    const next = this.writeChain.catch(() => {}).then(async () => {
      const release = await acquireFileLock(this.filePath, this.lockTimeoutMs, this.staleLockMs);
      try {
        const state = await readState(this.filePath);
        const result = operation(state);
        if (result.changed) await persistState(this.filePath, state);
        return result.value;
      } finally {
        await release();
      }
    });
    this.writeChain = next.then(() => undefined, () => undefined);
    return next;
  }

  private enqueueReconciliation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.reconcileChain.catch(() => {}).then(operation);
    this.reconcileChain = next.then(() => undefined, () => undefined);
    return next;
  }
}

type OutboxState = {
  format: 1;
  entries: DeliveryAccountingOutboxEntry[];
};

type MutationResult<T> = { changed: boolean; value: T };

const OutboxEntrySchema: z.ZodType<DeliveryAccountingOutboxEntry> = z.object({
  command: DeliveryAccountingCommandSchema,
  enqueuedAt: z.iso.datetime(),
  attemptCount: z.number().int().nonnegative(),
  lastAttemptAt: z.iso.datetime().optional()
}).strict();

const OutboxStateSchema: z.ZodType<OutboxState> = z.object({
  format: z.literal(1),
  entries: z.array(OutboxEntrySchema)
}).strict();

async function readState(filePath: string): Promise<OutboxState> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { format: 1, entries: [] };
    throw error;
  }
  if (!content.trim()) return { format: 1, entries: [] };
  try {
    const parsed = OutboxStateSchema.parse(JSON.parse(content));
    const commandIds = new Set<string>();
    for (const entry of parsed.entries) {
      if (commandIds.has(entry.command.commandId)) {
        throw new Error(`duplicate commandId ${entry.command.commandId}`);
      }
      commandIds.add(entry.command.commandId);
    }
    return parsed;
  } catch (error) {
    throw new DeliveryAccountingOutboxError(
      "corrupt_outbox",
      "Delivery accounting outbox contains invalid data",
      { cause: error }
    );
  }
}

async function persistState(filePath: string, state: OutboxState): Promise<void> {
  const directory = path.dirname(filePath);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function acquireFileLock(
  filePath: string,
  timeoutMs: number,
  staleLockMs: number
): Promise<() => Promise<void>> {
  const lockPath = `${filePath}.lock`;
  const token = randomUUID();
  const startedAt = Date.now();
  await mkdir(path.dirname(filePath), { recursive: true });
  while (true) {
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const age = await stat(lockPath)
        .then((value) => Date.now() - value.mtimeMs)
        .catch(() => 0);
      if (age > staleLockMs) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new DeliveryAccountingOutboxError(
          "outbox_busy",
          "Timed out waiting for the delivery accounting outbox lock"
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, acquiredAt: new Date().toISOString() }), "utf8");
      return async () => {
        await handle.close().catch(() => {});
        const ownsLock = await readFile(lockPath, "utf8")
          .then((content) => JSON.parse(content)?.token === token)
          .catch(() => false);
        if (ownsLock) await unlink(lockPath).catch((error) => {
          if (!isNodeError(error, "ENOENT")) throw error;
        });
      };
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
      throw error;
    }
  }
}

function sameCommand(left: DeliveryAccountingCommand, right: DeliveryAccountingCommand): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneEntry(entry: DeliveryAccountingOutboxEntry): DeliveryAccountingOutboxEntry {
  return structuredClone(entry);
}

function timestamp(clock: () => Date): string {
  return clock().toISOString();
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function requireIdentifier(value: string, name: string): void {
  if (!safeIdentifier.safeParse(value).success) throw new TypeError(`${name} must be a non-empty string`);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
