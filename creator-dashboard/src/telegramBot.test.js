import assert from "node:assert/strict";
import test from "node:test";
import { botLink, botOf, qrMatrix, qrPath, qrSide, cleanToken, isTokenShape, telegramErrorKey, TelegramBotClient } from "./telegramBot.js";
import { createCreatorTranslator, CREATOR_LOCALES } from "./creatorI18n.js";
import { TELEGRAM_BOT_COPY } from "./telegramBotCopy.js";

const recorder = (replies) => { const calls = []; const request = async (path, options) => { calls.push([path, options]); const reply = replies.shift(); if (reply instanceof Error) throw reply; return reply; }; return { calls, request }; };
const TOKEN = `123456789:${"A".repeat(35)}`;

test("a token is trimmed and shape-checked before it is sent", () => {
  assert.equal(cleanToken(`  ${TOKEN}\n`), TOKEN);
  assert.equal(isTokenShape(` ${TOKEN} `), true);
  for (const bad of ["", "abc", "123:short", `${TOKEN} extra`, `x${TOKEN}`, "123456789:" + "A".repeat(35) + "!"]) assert.equal(isTokenShape(bad), false, bad);
});

test("the bot is the Product's telegram channel, only when configured with a handle", () => {
  assert.deepEqual(botOf([{ kind: "line" }, { kind: "telegram", bot: true, configured: true, handle: "example_bot" }]), { username: "example_bot" });
  assert.equal(botOf([{ kind: "telegram", bot: true, configured: false }]), null);
  assert.equal(botOf(undefined), null);
  assert.equal(botLink("@example_bot"), "https://t.me/example_bot");
});

test("get, connect and disconnect call the Registry routes for this Product", async () => {
  const channel = { kind: "telegram", bot: true, configured: true, handle: "example_bot" };
  const { calls, request } = recorder([{ channels: [] }, { channels: [channel] }, { channels: [{ kind: "telegram", bot: true, configured: false }] }]);
  const client = new TelegramBotClient(request, "p/1");
  assert.equal(await client.get(), null);
  assert.deepEqual(await client.connect(`  ${TOKEN} `), { username: "example_bot" });
  await client.disconnect();
  assert.deepEqual(calls, [
    ["/v1/creator/connections?product_id=p%2F1", undefined],
    ["/v1/creator/connections/telegram/credentials", { method: "POST", body: JSON.stringify({ product_id: "p/1", token: TOKEN }) }],
    ["/v1/creator/connections/telegram?product_id=p%2F1", { method: "DELETE", body: "{}" }],
  ]);
});

test("a rejected token is the Registry's failure, surfaced as it came", async () => {
  const failure = Object.assign(new Error("bad"), { status: 422, code: "telegram_probe_failed" });
  await assert.rejects(new TelegramBotClient(recorder([failure]).request, "p").connect(TOKEN), (error) => error.code === "telegram_probe_failed");
});

test("each failure maps to plain copy, and a dropped connection is a network message", () => {
  assert.equal(telegramErrorKey({ status: 422, code: "telegram_probe_failed" }), "sxtgInvalidToken");
  assert.equal(telegramErrorKey({ status: 400, code: "invalid_credentials" }), "sxtgInvalidToken");
  assert.equal(telegramErrorKey({ status: 503, code: "channel_unavailable" }), "sxtgUnavailable");
  assert.equal(telegramErrorKey({ status: 404, code: "product_not_found" }), "sxtgProductMissing");
  assert.equal(telegramErrorKey(new TypeError("fetch failed")), "sxtgNetwork");
  assert.equal(telegramErrorKey({ status: 500 }), null);
});

test("every locale has every Telegram setup string, and the invalid-token message is the agreed one", () => {
  const keys = Object.keys(TELEGRAM_BOT_COPY.en);
  for (const locale of CREATOR_LOCALES) assert.deepEqual(Object.keys(TELEGRAM_BOT_COPY[locale]), keys, locale);
  assert.match(TELEGRAM_BOT_COPY.zh.sxtgInvalidToken, /这个 token 无效，请回 BotFather 重新复制/);
});

test("the bot link becomes a QR code made here, with the quiet zone scanners need", () => {
  const matrix = qrMatrix("https://t.me/example_bot");
  assert.equal(matrix.length, matrix[0].length);
  assert.deepEqual(matrix[0].slice(0, 7), Array(7).fill(true));
  assert.equal(matrix[1][1], false);
  assert.equal(matrix[2][2], true);
  assert.equal(qrSide(matrix), matrix.length + 8);
  assert.match(qrPath(matrix), /^M4 4h1v1h-1z/);
});
