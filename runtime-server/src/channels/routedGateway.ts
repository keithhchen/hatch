import type { ChatGateway, RunProgress } from "../chat/gateway.js";
import { ChatError } from "../chat/principal.js";

/**
 * Chat as the channel layer reaches it. A Product's conversations are in the Runtime, over the service API; the Assistant's
 * are hosted here. Sending and uploading are only for Products, so they go to the Runtime; a Run is looked up where it is
 * held, wherever that is, and one reply is sent per Run either way.
 */
export class RoutedChatGateway implements ChatGateway {
  private local?: Pick<ChatGateway, "progress">;
  constructor(private readonly remote?: ChatGateway) {}

  bindLocal(local: Pick<ChatGateway, "progress">): void { this.local = local; }

  private runtime(): ChatGateway {
    if (!this.remote) throw new ChatError("service_unavailable", "The Chat service API is not configured.", 503);
    return this.remote;
  }

  send(...args: Parameters<ChatGateway["send"]>) { return this.runtime().send(...args); }
  restart(...args: Parameters<ChatGateway["restart"]>) { return this.runtime().restart(...args); }
  upload(...args: Parameters<ChatGateway["upload"]>) { return this.runtime().upload(...args); }

  async progress(runId: string): Promise<RunProgress | undefined> {
    return await this.local?.progress(runId) ?? await this.remote?.progress(runId);
  }
}
