import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContactPayload, submitContact } from "../contactForm.mjs";

test("contact payload is bounded and preserves the selected language", () => {
  const payload = normalizeContactPayload({
    name: ` ${"N".repeat(140)} `,
    email: "person@example.com",
    partnerType: "Creator",
    message: "  hello  ",
    language: "ja",
    website: ""
  });

  assert.equal(payload.name.length, 100);
  assert.equal(payload.message, "hello");
  assert.equal(payload.language, "日本語");
});

test("contact submission fails closed when Feishu is not configured", async () => {
  let calls = 0;
  const result = await submitContact({
    name: "Creator",
    email: "creator@example.com",
    partnerType: "Creator"
  }, {
    env: {},
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not call Feishu");
    },
    logger: { error() {} }
  });

  assert.deepEqual(result, { status: 503, body: { ok: false } });
  assert.equal(calls, 0);
});

test("contact submission writes the normalized record to Feishu", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    return requests.length === 1
      ? new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }), { status: 200 })
      : new Response(JSON.stringify({ code: 0, data: { record: { record_id: "rec_1" } } }), { status: 200 });
  };

  const result = await submitContact({
    name: "Creator",
    email: "creator@example.com",
    partnerType: "Creator",
    message: "Build a product",
    language: "en"
  }, {
    env: {
      FEISHU_APP_ID: "app-id",
      FEISHU_APP_SECRET: "app-secret",
      FEISHU_BASE_TOKEN: "base-token",
      FEISHU_TABLE_ID: "table-id"
    },
    fetchImpl,
    logger: { error() {} }
  });

  assert.deepEqual(result, { status: 201, body: { ok: true } });
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /\/apps\/base-token\/tables\/table-id\/records$/);
  assert.equal(JSON.parse(requests[1].options.body).fields.来源页面, "hatch.tokenquadrant.cn");
});
