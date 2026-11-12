import { log } from "./log.js";

/** A catch handler for work whose failure must not stop the caller but must not vanish either: it logs the failure with its context. */
export const reported = (label: string, fields: Record<string, unknown> = {}) => (error: unknown): void => {
  log.error(label, { ...fields, error });
};
