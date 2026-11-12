import { ConversationError } from "./conversation.js";

/** What Studio's Assistant page shows beside the conversation, and the one account fact it reports. */
export interface AssistantPanel {
  /** Things waiting on the Expert, or in progress for them. */
  tasks(accountId: string): Promise<unknown[]>;
  /** The chat platforms the Expert can talk to the Assistant on, as the page lists them. */
  channels(accountId: string): Promise<unknown[]>;
  /** Records the Expert's timezone so the Assistant keeps their hours. */
  setTimezone(accountId: string, timezone: string): Promise<void>;
}

/** The panel over the Assistant's task list, its channels and the account's timezone. */
export class StudioPanel implements AssistantPanel {
  constructor(private deps: {
    tasks: { open(accountId: string): Promise<unknown[]> };
    channels(accountId: string): Promise<unknown[]>;
    timezones: { valid(timezone: string): boolean; set(accountId: string, timezone: string): Promise<void> };
  }) {}

  tasks(accountId: string) { return this.deps.tasks.open(accountId); }
  channels(accountId: string) { return this.deps.channels(accountId); }

  async setTimezone(accountId: string, timezone: string): Promise<void> {
    if (!this.deps.timezones.valid(timezone)) throw new ConversationError(400, "invalid_timezone", "timezone must be an IANA name such as Asia/Shanghai.");
    await this.deps.timezones.set(accountId, timezone);
  }
}
