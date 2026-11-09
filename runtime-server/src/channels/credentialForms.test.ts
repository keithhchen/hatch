import assert from "node:assert/strict";
import { test } from "node:test";
import { CREDENTIAL_FORMS, readCredentials } from "./credentialForms.js";
import { CHANNEL_KINDS } from "./types.js";

const KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

test("every platform where the Expert brings their own app has a form; shared platforms have none", () => {
  assert.deepEqual(Object.keys(CREDENTIAL_FORMS).sort(), ["feishu", "lark", "wechatkf", "wecom"]);
  for (const kind of Object.keys(CREDENTIAL_FORMS)) assert.ok(CHANNEL_KINDS.includes(kind as never));
});

test("a form reads its fields trimmed, requires the required ones and ignores the rest", () => {
  const form = CREDENTIAL_FORMS.wechatkf!;
  const body = { corp_id: " ww1 ", secret: "s", token: "t", encoding_aes_key: KEY, extra: "x" };
  assert.deepEqual(readCredentials(form, body), { corpId: "ww1", secret: "s", token: "t", encodingAesKey: KEY });
  assert.equal(readCredentials(form, { ...body, secret: "  " }), undefined);
  assert.equal(readCredentials(form, { ...body, token: 5 }), undefined);
});

test("Lark and Feishu share a form that differs only in domain, with encrypt key optional", () => {
  const body = { app_id: "a", app_secret: "b", verification_token: "c" };
  assert.deepEqual(readCredentials(CREDENTIAL_FORMS.lark!, body), { domain: "lark", appId: "a", appSecret: "b", verificationToken: "c" });
  assert.deepEqual(readCredentials(CREDENTIAL_FORMS.feishu!, { ...body, encrypt_key: "k" }), { domain: "feishu", appId: "a", appSecret: "b", verificationToken: "c", encryptKey: "k" });
});

test("a form builds the adapter of its own kind, and a malformed key is not available", () => {
  const wecom = CREDENTIAL_FORMS.wecom!;
  const adapter = wecom.build({ token: "t", encodingAesKey: KEY }, "acct");
  assert.deepEqual([adapter.kind, adapter.scope, adapter.available()], ["wecom", "acct", true]);
  assert.equal(wecom.build({ token: "t", encodingAesKey: "short" }, "acct").available(), false);
  assert.equal(CREDENTIAL_FORMS.feishu!.build({ domain: "feishu", appId: "a", appSecret: "b", verificationToken: "c" }, "acct").kind, "feishu");
});

test("only forms with something to prove probe: a bot's app and a customer service secret", () => {
  assert.deepEqual(Object.entries(CREDENTIAL_FORMS).filter(([, form]) => form.probe).map(([kind]) => kind).sort(), ["feishu", "lark", "wechatkf"]);
});
