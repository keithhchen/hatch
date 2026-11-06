/** A user-facing chat error identified by an i18n key the host translates. */
export class ChatError extends Error {
  constructor(key, values = {}) {
    super(key);
    this.name = "ChatError";
    this.key = key;
    this.values = values;
  }
}
