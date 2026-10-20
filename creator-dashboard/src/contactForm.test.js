import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContactPayload, submitApplication, submitContact } from "../contactForm.mjs";

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

test("expert application writes the profile link and contact to the apply table", async () => {
  const requests = [];
  const result = await submitApplication(
    { url: " https://xiaohongshu.com/user/abc ", contact: "wechat-id", language: "zh" },
    {
      env: { FEISHU_APP_ID: "app", FEISHU_APP_SECRET: "secret", FEISHU_BASE_TOKEN: "base" },
      fetchImpl: async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body) });
        const body = requests.length === 1 ? { code: 0, tenant_access_token: "token" } : { code: 0 };
        return { ok: true, json: async () => body };
      },
      logger: { error() {} }
    }
  );

  assert.deepEqual(result, { status: 201, body: { ok: true } });
  assert.match(requests[1].url, /\/tables\/tblIADFAGWTrVl2B\/records$/);
  assert.equal(requests[1].body.fields.主页链接, "https://xiaohongshu.com/user/abc");
  assert.equal(requests[1].body.fields.联系方式, "wechat-id");
  assert.equal(requests[1].body.fields.状态, "待处理");
});

test("expert application rejects a missing link", async () => {
  const result = await submitApplication(
    { url: "", contact: "wechat-id" },
    { env: { FEISHU_APP_ID: "a", FEISHU_APP_SECRET: "b", FEISHU_BASE_TOKEN: "c" }, fetchImpl: async () => { throw new Error("no"); }, logger: { error() {} } }
  );
  assert.deepEqual(result, { status: 400, body: { ok: false } });
});
