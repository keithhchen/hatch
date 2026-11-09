import { Scenario } from "../lib/scenario.mjs";
import { ChatApi, Auth } from "../lib/clients.mjs";
import { TelegramWebhooks } from "../lib/webhooks.mjs";

/** Not a product claim: proves the verification stack itself can carry one message through each real door, with a real model. */
class Smoke extends Scenario {
  constructor() { super({ id: 0, title: "Tool self-check: one message through Chat HTTP and one through an IM webhook" }); }
  async run(stack, rec) {
    const owner = await stack.account("owner");
    const productId = await stack.product(owner);
    const chat = new ChatApi(stack.url, Auth.bearer(owner.apiKey));
    const conversation = await chat.create(productId);
    const started = Date.now();
    const sent = await chat.send(conversation, productId, { content: "Reply with exactly the word: pong", wait: 60 });
    rec.measure("chat_http_wait_ms", Date.now() - started);
    rec.check("HTTP Chat answered", sent.status === 200 && /pong/i.test(sent.json?.reply ?? ""), { status: sent.status, reply: sent.json?.reply });

    const connection = await stack.connection({ owner, audience: "org", productId });
    await stack.admit(connection, { senderId: "777" });
    const hooks = new TelegramWebhooks(stack.registryUrl);
    const post = await hooks.post(hooks.message({ chatId: 777, text: "Reply with exactly the word: ping" }));
    rec.check("webhook accepted", post.status === 200, post);
    await stack.platform.waitFor("outbound reply", () => stack.platform.sends().length >= 1, 90_000);
    const sends = stack.platform.sends();
    rec.measure("outbound_sends", sends.length);
    rec.check("one outbound reply mentions ping", sends.length === 1 && /ping/i.test(sends[0].body.text), sends.map((s) => s.body.text));
  }
}
export default new Smoke();
