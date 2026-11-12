import assert from "node:assert/strict";
import test from "node:test";
import { TelegramChannel } from "./telegramChannel.js";
import { ChannelSendError } from "./types.js";

const TASK = "123e4567-e89b-12d3-a456-426614174000";
const TO = { threadId: "42", senderId: "42" };
const GROUP = { threadId: "-100", senderId: "7" };

type Call = { url: string; body: any };

function channel(respond: () => Response = () => Response.json({ ok: true, result: {} }), config: Partial<ConstructorParameters<typeof TelegramChannel>[0]> = {}) {
  const calls: Call[] = [];
  const fake = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
    return respond();
  }) as typeof fetch;
  return { calls, telegram: new TelegramChannel({ token: "tok", username: "HatchBot", webhookSecret: "s3cret", ...config }, "", fake) };
}
const parse = (update: unknown) => channel().telegram.parse(Buffer.from(JSON.stringify(update))).events;
const privateMessage = (extra: object) => ({ update_id: 1, message: { message_id: 10, chat: { id: 42, type: "private" }, from: { id: 42 }, ...extra } });
const groupMessage = (extra: object, type = "supergroup") => ({ update_id: 2, message: { message_id: 11, chat: { id: -100, type }, from: { id: 7 }, ...extra } });

test("capabilities", () => {
  assert.deepEqual(channel().telegram.capabilities(), { stream: false, edit: true, typing: true, buttons: true, maxLength: 4096, canInitiate: true, idempotentSend: false });
});

test("typing sends the chat action to the chat, and a failure is a ChannelSendError", async () => {
  const { calls, telegram } = channel();
  await telegram.typing(TO);
  assert.deepEqual(calls, [{ url: "https://api.telegram.org/bottok/sendChatAction", body: { chat_id: 42, action: "typing" } }]);
  await assert.rejects(channel(() => Response.json({ ok: false, description: "nope" }, { status: 403 })).telegram.typing(TO), ChannelSendError);
});

test("available needs token, username and secret; connectUrl carries the code", () => {
  assert.equal(channel().telegram.available(), true);
  for (const missing of ["token", "username", "webhookSecret"]) assert.equal(channel(undefined, { [missing]: undefined }).telegram.available(), false);
  assert.equal(channel().telegram.connectUrl("HATCH-1"), "https://t.me/HatchBot?start=HATCH-1");
});

test("verify checks the secret header", () => {
  const { telegram } = channel();
  const raw = Buffer.from("{}");
  assert.equal(telegram.verify(raw, { "x-telegram-bot-api-secret-token": "s3cret" }), true);
  assert.equal(telegram.verify(raw, { "x-telegram-bot-api-secret-token": "wrong!" }), false);
  assert.equal(telegram.verify(raw, { "x-telegram-bot-api-secret-token": "s" }), false);
  assert.equal(telegram.verify(raw, {}), false);
  assert.equal(channel(undefined, { webhookSecret: undefined }).telegram.verify(raw, { "x-telegram-bot-api-secret-token": "s3cret" }), false);
});

test("a user blocking the bot in a private chat is an unbound event; unblocking, or a group change, is nothing", () => {
  const change = (chat: { id: number; type: string }, status: string) => ({ update_id: 9, my_chat_member: { chat, from: { id: 42 }, new_chat_member: { status } } });
  assert.deepEqual(parse(change({ id: 42, type: "private" }, "kicked")), [{ eventId: "9", sequence: 9, address: TO, unbound: true }]);
  assert.deepEqual(parse(change({ id: 42, type: "private" }, "member")), []);
  assert.deepEqual(parse(change({ id: -100, type: "supergroup" }, "kicked")), []);
});

test("private text, photo and document parse with thread and sender the same", () => {
  assert.deepEqual(parse(privateMessage({ text: "hi" })), [{ eventId: "1", sequence: 1, address: TO, messageRef: "10", text: "hi" }]);
  assert.deepEqual(parse(privateMessage({ photo: [{ file_id: "small" }, { file_id: "big", file_size: 99 }], caption: " look " })), [{ eventId: "1", sequence: 1, address: TO, messageRef: "10", text: "look", file: { ref: "big", name: "photo.jpg", size: 99 } }]);
  assert.deepEqual(parse(privateMessage({ document: { file_id: "d", file_name: "a.pdf", file_size: 5 } })), [{ eventId: "1", sequence: 1, address: TO, messageRef: "10", file: { ref: "d", name: "a.pdf", size: 5 } }]);
});

test("every event carries Telegram's update_id as its sequence, so the inbox can keep Telegram's order", () => {
  assert.equal(parse({ ...privateMessage({ text: "a" }), update_id: 90_000_000_007 })[0]?.sequence, 90_000_000_007);
  assert.equal(parse({ update_id: 5, callback_query: { id: "q", from: { id: 7 }, data: "x", message: { message_id: 1, chat: { id: 42, type: "private" } } } })[0]?.sequence, 5);
});

test("the photos of one album parse as events of one album, so the inbox can hand them over together", () => {
  const [first] = parse(privateMessage({ photo: [{ file_id: "a" }], caption: "三张", media_group_id: "g1" }));
  const [second] = parse(privateMessage({ photo: [{ file_id: "b" }], media_group_id: "g1" }));
  assert.equal(first?.album, "g1");
  assert.equal(second?.album, "g1");
  assert.equal(parse(privateMessage({ photo: [{ file_id: "c" }] }))[0]?.album, undefined);
});

test("a video, a round video note and an animation parse into files too", () => {
  const event = (file: { ref: string; name: string; size?: number }) => [{ eventId: "1", sequence: 1, address: TO, messageRef: "10", text: "你看看", file }];
  assert.deepEqual(parse(privateMessage({ video: { file_id: "v", file_size: 5 }, caption: "你看看" })), event({ ref: "v", name: "video.mp4", size: 5 }));
  assert.deepEqual(parse(privateMessage({ video: { file_id: "v", file_name: "clip.mov" }, caption: "你看看" })), event({ ref: "v", name: "clip.mov" }));
  assert.deepEqual(parse(privateMessage({ video_note: { file_id: "n", file_size: 6 }, caption: "你看看" })), event({ ref: "n", name: "video_note.mp4", size: 6 }));
  assert.deepEqual(parse(privateMessage({ animation: { file_id: "g" }, caption: "你看看" })), event({ ref: "g", name: "animation.mp4" }));
  assert.equal(parse(privateMessage({ video: { file_id: "big", file_size: 25 * 1024 * 1024 } }))[0]!.file!.size! > channel().telegram.maxFileBytes, true);
});

test("a voice message or audio file parses into a file for the asset pipeline, with its size for the 20 MB refusal", () => {
  assert.deepEqual(parse(privateMessage({ voice: { file_id: "v", file_size: 7, duration: 3, mime_type: "audio/ogg" } })), [{ eventId: "1", sequence: 1, address: TO, messageRef: "10", file: { ref: "v", name: "voice.ogg", size: 7 } }]);
  assert.deepEqual(parse(privateMessage({ audio: { file_id: "a", file_name: "memo.m4a", file_size: 9 } })), [{ eventId: "1", sequence: 1, address: TO, messageRef: "10", file: { ref: "a", name: "memo.m4a", size: 9 } }]);
  assert.equal(parse(privateMessage({ audio: { file_id: "a" } }))[0]?.file?.name, "audio");
  assert.equal(parse(privateMessage({ voice: { file_id: "big", file_size: 25 * 1024 * 1024 } }))[0]!.file!.size! > channel().telegram.maxFileBytes, true);
});

test("/start CODE yields the code as text", () => {
  assert.equal(parse(privateMessage({ text: "/start HATCH-ABCD" }))[0]?.text, "HATCH-ABCD");
});

test("a private message with no sender falls back to the chat id", () => {
  const update = privateMessage({ text: "hi" });
  delete (update.message as { from?: unknown }).from;
  assert.deepEqual(parse(update)[0]?.address, TO);
});

test("in a group, a @mention reaches the bot with the mention stripped, case-insensitively", () => {
  const events = parse(groupMessage({ text: "@hatchbot make a poster", entities: [{ type: "mention", offset: 0, length: 9 }] }));
  assert.deepEqual(events, [{ eventId: "2", sequence: 2, address: GROUP, group: true, messageRef: "11", text: "make a poster" }]);
  assert.equal(parse(groupMessage({ text: "hey @HATCHBOT do it" }, "group"))[0]?.text, "hey  do it");
  assert.equal(parse(groupMessage({ caption: "@HatchBot see", photo: [{ file_id: "p" }] }))[0]?.text, "see");
});

test("in a group, a reply to the bot's own message reaches the bot", () => {
  const events = parse(groupMessage({ text: "yes", reply_to_message: { from: { username: "HatchBot", is_bot: true } } }));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.text, "yes");
  assert.equal(events[0]?.group, true);
});

test("an unaddressed group message, a mention of someone else and a reply to a person produce no event", () => {
  assert.deepEqual(parse(groupMessage({ text: "lunch?" })), []);
  assert.deepEqual(parse(groupMessage({ text: "@someone hi", entities: [{ type: "mention", offset: 0, length: 8 }] })), []);
  assert.deepEqual(parse(groupMessage({ text: "ok", reply_to_message: { from: { username: "ann" } } })), []);
  assert.deepEqual(parse(groupMessage({ text: "@hatchbotx hi" })), []);
});

test("a group event has a different thread and sender", () => {
  const address = parse(groupMessage({ text: "@HatchBot hi" }))[0]!.address;
  assert.notEqual(address.threadId, address.senderId);
});

test("channels and other chat types are ignored", () => {
  assert.deepEqual(parse({ update_id: 3, message: { message_id: 1, chat: { id: -5, type: "channel" }, text: "@HatchBot hi" } }), []);
  assert.deepEqual(parse({ update_id: 4 }), []);
});

test("a callback query takes the sender from `from` and the thread from the message's chat", () => {
  const update = { update_id: 5, callback_query: { id: "q1", from: { id: 7 }, data: `t:${TASK}:approve`, message: { message_id: 20, chat: { id: -100, type: "supergroup" } } } };
  assert.deepEqual(parse(update), [{ eventId: "5", sequence: 5, address: GROUP, group: true, button: { taskId: TASK, action: "approve", ref: "q1|-100|20" } }]);
  const unknown = parse({ ...update, callback_query: { ...update.callback_query, data: "menu" } });
  assert.deepEqual(unknown[0]?.button, { taskId: "", action: "decline", ref: "q1|-100|20" });
});

test("recorded payload: a redelivered update parses to the same event id, and an edited message yields nothing", () => {
  const update = privateMessage({ text: "hi" });
  assert.equal(parse(update)[0]?.eventId, parse(update)[0]?.eventId);
  assert.deepEqual(parse({ update_id: 6, edited_message: { message_id: 10, chat: { id: 42, type: "private" }, text: "hi!" } }), []);
  // A sticker has no text and no file: an event the Expert hears about.
  assert.deepEqual(parse(privateMessage({ sticker: { file_id: "s" } })), [{ eventId: "1", sequence: 1, address: TO, messageRef: "10" }]);
});

test("send posts to the thread with reply parameters and inline buttons", async () => {
  const { telegram, calls } = channel();
  await telegram.send(GROUP, { text: "ok?", replyTo: "11", buttons: [{ label: "确认", taskId: TASK, action: "approve" }, { label: "取消", taskId: TASK, action: "decline" }] }, "k:0");
  assert.equal(calls[0]!.url, "https://api.telegram.org/bottok/sendMessage");
  assert.deepEqual(calls[0]!.body, {
    chat_id: -100, text: "ok?", link_preview_options: { is_disabled: true },
    reply_parameters: { message_id: 11, allow_sending_without_reply: true },
    reply_markup: { inline_keyboard: [[{ text: "确认", callback_data: `t:${TASK}:approve` }, { text: "取消", callback_data: `t:${TASK}:decline` }]] },
  });
});

test("send never truncates: a message at maxLength goes whole", async () => {
  const { telegram, calls } = channel();
  const text = "a".repeat(telegram.capabilities().maxLength);
  await telegram.send(TO, { text }, "k:0");
  assert.equal(calls[0]!.body.text, text);
  assert.equal(calls[0]!.body.chat_id, 42);
});

test("send failures are classified for the outbox", async () => {
  const classify = async (respond: () => Response) => {
    const error = await channel(respond).telegram.send(TO, { text: "x" }, "k:0").then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof ChannelSendError);
    return error;
  };
  const body = (description: string) => ({ ok: false, description });
  assert.equal((await classify(() => Response.json(body("Too Many Requests"), { status: 429 }))).failure, "definite");
  const blocked = await classify(() => Response.json(body("Forbidden: bot was blocked by the user"), { status: 403 }));
  assert.deepEqual([blocked.failure, blocked.options.access], ["permanent", true]);
  assert.match(blocked.message, /blocked by the user/);
  const bad = await classify(() => Response.json(body("Bad Request"), { status: 400 }));
  assert.deepEqual([bad.failure, bad.options.access], ["permanent", false]);
  assert.equal((await classify(() => new Response("oops", { status: 500 }))).failure, "ambiguous");
  assert.equal((await classify(() => { throw new Error("timeout"); })).failure, "ambiguous");
});

test("download resolves the file path and fetches the bytes", async () => {
  const urls: string[] = [];
  const fake = (async (url: string) => {
    urls.push(url);
    return url.endsWith("/getFile") ? Response.json({ ok: true, result: { file_path: "photos/a.jpg" } }) : new Response(Buffer.from("bytes"));
  }) as unknown as typeof fetch;
  const telegram = new TelegramChannel({ token: "tok", username: "HatchBot", webhookSecret: "s" }, "", fake);
  assert.deepEqual(await telegram.download({ ref: "f1", name: "a.jpg" }), Buffer.from("bytes"));
  assert.deepEqual(urls, ["https://api.telegram.org/bottok/getFile", "https://api.telegram.org/file/bottok/photos/a.jpg"]);
});

test("a link goes out as a URL button; the bot, its scope and webhook are managed through the Bot API", async () => {
  const { telegram, calls } = channel(() => Response.json({ ok: true, result: { username: "shop_bot" } }));
  await telegram.send(TO, { text: "Sign in", link: { label: "Log in", url: "https://site.test/v1/auth/telegram/start?claim=c" } }, "k");
  assert.deepEqual(calls[0]!.body.reply_markup, { inline_keyboard: [[{ text: "Log in", url: "https://site.test/v1/auth/telegram/start?claim=c" }]] });
  assert.equal(await telegram.probe(), "shop_bot");
  await telegram.setWebhook("https://site.test/hook", "sec");
  assert.deepEqual(calls.at(-1)!.body, { url: "https://site.test/hook", secret_token: "sec", allowed_updates: ["message", "callback_query", "my_chat_member"], max_connections: 1 }, "one connection: Telegram delivers in update_id order");
  await telegram.deleteWebhook();
  assert.deepEqual(calls.map(call => call.url.split("/").pop()), ["sendMessage", "getMe", "setWebhook", "deleteWebhook"]);
  const bot = new TelegramChannel({ token: "t", username: "shop_bot", webhookSecret: "s" }, "scope-1");
  assert.deepEqual([bot.scope, bot.handle], ["scope-1", "shop_bot"]);
  await assert.rejects(channel(() => Response.json({ ok: true, result: {} })).telegram.probe(), /did not say which bot/);
});
