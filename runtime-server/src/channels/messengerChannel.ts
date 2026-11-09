import type { ChannelCapabilities } from "../surfaces/contract.js";
import { GRAPH, MetaChannel } from "./metaChannel.js";
import { MetaMessagingChannel } from "./metaMessaging.js";
import type { PlatformAddress } from "./types.js";

/** Facebook Messenger. One endpoint for every Page that installed the app; the tenant is the Page id, the contact the PSID. */
export class MessengerChannel extends MetaMessagingChannel {
  readonly kind = "messenger" as const;
  protected readonly object = "page";
  protected readonly textLimit = 2000;
  protected envelope = { messaging_type: "RESPONSE" };
  protected endpoint(page: string): string { return `${GRAPH}/${page}/messages`; }
  capabilities(): ChannelCapabilities { return { ...super.capabilities(), typing: true }; }

  async typing(to: PlatformAddress): Promise<void> {
    const [page, psid] = MetaChannel.split(to.threadId);
    await this.post(this.endpoint(page), { recipient: { id: psid }, sender_action: "typing_on" }, await this.token(page));
  }

  /** Proves the Page's token and subscribes the app to the Page's messages. Returns the Page's name. */
  async probe(page: string, token: string): Promise<{ name: string }> {
    const { name } = await this.call("GET", `${GRAPH}/${encodeURIComponent(page)}?fields=name`, token);
    await this.call("POST", `${GRAPH}/${encodeURIComponent(page)}/subscribed_apps?subscribed_fields=messages,messaging_postbacks`, token);
    return { name };
  }
}
