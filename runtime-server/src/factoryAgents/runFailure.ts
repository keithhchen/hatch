import type { PublicFailure } from "../errors/failures.js";

/** Why a Run ended in failure, as every surface shows it. */
export type RunFailure = PublicFailure;

/** A failed session says why: sessions that failed before codes existed read as a plain failed Run. */
export const failureOf = (session: { error?: string; errorCode?: string; errorRef?: string }): RunFailure => ({
  code: session.errorCode ?? "run_failed",
  message: session.error ?? "The Run failed. Send the message again.",
  ...(session.errorRef ? { reference: session.errorRef } : {})
});
