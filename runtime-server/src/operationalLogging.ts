export const OPERATIONAL_FAILURES = {
  commerce_delivery_reconciliation_failed: "delivery_accounting",
  commerce_delivery_receipt_deferred: "delivery_accounting",
  commerce_delivery_reservation_release_failed: "delivery_accounting",
  graceful_shutdown_failed: "process_shutdown",
  graceful_shutdown_timeout: "process_shutdown",
  runtime_startup_failed: "runtime_startup",
  registry_startup_failed: "registry_startup",
  creator_factory_worker_failed: "creator_factory_worker"
} as const;

export type OperationalFailureCode = keyof typeof OPERATIONAL_FAILURES;
export type OperationalFailureCategory = (typeof OPERATIONAL_FAILURES)[OperationalFailureCode];

const SAFE_ERROR_NAMES = new Set([
  "AbortError",
  "AggregateError",
  "ConversationRepositoryError",
  "DeliveryAccountingOutboxError",
  "EntitlementError",
  "Error",
  "EvalError",
  "KnowledgeIndexUnavailable",
  "NonError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError"
] as const);

export type OperationalErrorSummary = Readonly<{
  name: string;
  code: OperationalFailureCode;
  category: OperationalFailureCategory;
}>;

/**
 * Operational logs cross a trust boundary: provider failures and runtime
 * exceptions can contain prompts, response bodies, credentials, e-mail
 * addresses, or absolute local paths. Keep this record deliberately lossy.
 * The call site supplies a stable, allowlisted code; the exception contributes
 * only an allowlisted class name and never its message, stack, cause, or fields.
 */
export function summarizeOperationalError(
  code: OperationalFailureCode,
  error: unknown
): OperationalErrorSummary {
  return Object.freeze({
    name: safeErrorName(error),
    code,
    category: OPERATIONAL_FAILURES[code]
  });
}

export function writeOperationalError(
  code: OperationalFailureCode,
  error: unknown,
  write: (serializedRecord: string) => void = (serializedRecord) => {
    process.stderr.write(serializedRecord);
  }
): void {
  write(`${JSON.stringify(summarizeOperationalError(code, error))}\n`);
}

function safeErrorName(error: unknown): string {
  try {
    if (!(error instanceof Error)) return "NonError";
    const name = error.name;
    return SAFE_ERROR_NAMES.has(name as never) ? name : "Error";
  } catch {
    // A provider can throw a Proxy or an Error with a hostile name getter.
    // Logging must remain fail-closed and must not inspect another field.
    return "NonError";
  }
}
