import { GRAPH } from "./metaChannel.js";
import { MetaMessagingChannel } from "./metaMessaging.js";

/** Facebook Messenger. One endpoint for every Page that installed the app; the tenant is the Page id, the contact the PSID. */
export class MessengerChannel extends MetaMessagingChannel {
  readonly kind = "messenger" as const;
  protected readonly object = "page";
  protected readonly textLimit = 2000;
  protected envelope = { messaging_type: "RESPONSE" };
  protected endpoint(page: string): string { return `${GRAPH}/${page}/messages`; }
}
