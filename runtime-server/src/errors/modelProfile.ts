import { log } from "../observability/log.js";

/** A role's model profile is unknown, not allowed for the role, or lacks its API key. The run fails with this code; nothing falls back to another model. */
export const MODEL_PROFILE_INVALID = "model_profile_invalid";

export class ModelProfileError extends Error {
  readonly code = MODEL_PROFILE_INVALID;
  constructor(message: string, fields: Record<string, unknown> = {}) {
    super(message);
    this.name = "ModelProfileError";
    log.error(MODEL_PROFILE_INVALID, { message, ...fields });
  }
}
