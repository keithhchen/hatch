import assert from "node:assert/strict";
import { test } from "node:test";
import { CREDENTIAL_FORMS, isTenantForm, readCredentials, type OwnAppForm } from "./credentialForms.js";
import { CHANNEL_KINDS } from "./types.js";

const KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

test("a form exists where the Expert brings their own app, or their own tenant of a shared one", () => {
  const kinds = Object.keys(CREDENTIAL_FORMS) as Array<keyof typeof CREDENTIAL_FORMS>;
  assert.deepEqual(kinds.filter(kind => !isTenantForm(CREDENTIAL_FORMS[kind]!)).sort(), ["feishu", "lark", "wechatkf", "wecom"]);
  assert.deepEqual(kinds.filter(kind => isTenantForm(CREDENTIAL_FORMS[kind]!)).sort(), ["messenger", "whatsapp"]);
  for (const kind of kinds) assert.ok(CHANNEL_KINDS.includes(kind as never));
});

test("a tenant form names the credential that is the tenant's id, and needs it with the token", () => {
  for (const kind of ["whatsapp", "messenger"] as const) {
    const form = CREDENTIAL_FORMS[kind]!;
    assert.ok(isTenantForm(form));
    const body = { waba_id: "W1", page_id: "P1", access_token: " tok " };
    const credentials = readCredentials(form, body)!;
    assert.equal(credentials.token, "tok");
    assert.ok(credentials[(form as { tenant: string }).tenant]);
    assert.equal(readCredentials(form, { ...body, access_token: "" }), undefined);
  }
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
  const wecom = CREDENTIAL_FORMS.wecom as OwnAppForm;
  const adapter = wecom.build({ token: "t", encodingAesKey: KEY }, "acct");
  assert.deepEqual([adapter.kind, adapter.scope, adapter.available()], ["wecom", "acct", true]);
  assert.equal(wecom.build({ token: "t", encodingAesKey: "short" }, "acct").available(), false);
  assert.equal((CREDENTIAL_FORMS.feishu as OwnAppForm).build({ domain: "feishu", appId: "a", appSecret: "b", verificationToken: "c" }, "acct").kind, "feishu");
});

test("only forms with something to prove probe: a bot app, a customer service secret and a tenant token", () => {
  assert.deepEqual(Object.entries(CREDENTIAL_FORMS).filter(([, form]) => form.probe).map(([kind]) => kind).sort(), ["feishu", "lark", "messenger", "wechatkf", "whatsapp"]);
});
