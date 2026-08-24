const REQUIRED_ENV = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_BASE_TOKEN",
  "FEISHU_TABLE_ID"
];

const CONTACT_SOURCE_PAGE = "hatch.tokenquadrant.cn";

function clean(value, maximum) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

export function normalizeContactPayload(payload = {}) {
  return {
    name: clean(payload.name, 100),
    email: clean(payload.email, 320),
    organization: clean(payload.organization, 160),
    partnerType: clean(payload.partnerType, 120),
    message: clean(payload.message, 4000),
    language: payload.language === "zh" ? "中文" : payload.language === "ja" ? "日本語" : "English",
    website: clean(payload.website, 200)
  };
}

export function contactConfiguration(env = process.env) {
  return {
    appId: String(env.FEISHU_APP_ID ?? "").trim(),
    appSecret: String(env.FEISHU_APP_SECRET ?? "").trim(),
    baseToken: String(env.FEISHU_BASE_TOKEN ?? "").trim(),
    tableId: String(env.FEISHU_TABLE_ID ?? "").trim(),
    sourcePage: String(env.HATCH_CONTACT_SOURCE_PAGE ?? CONTACT_SOURCE_PAGE).trim()
  };
}

export async function submitContact(payload, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger ?? console;
  const config = contactConfiguration(env);

  if (!config.appId || !config.appSecret || !config.baseToken || !config.tableId) {
    logger.error?.("Contact form is missing Feishu configuration.");
    return { status: 503, body: { ok: false } };
  }

  const contact = normalizeContactPayload(payload);

  // A hidden field catches basic form-fill bots without making the form harder for people.
  if (contact.website) return { status: 200, body: { ok: true } };

  if (!contact.name || !contact.partnerType || !/^\S+@\S+\.\S+$/.test(contact.email)) {
    return { status: 400, body: { ok: false } };
  }

  try {
    const tokenResponse = await fetchImpl(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
        cache: "no-store"
      }
    );
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || tokenData.code !== 0 || !tokenData.tenant_access_token) {
      throw new Error("Could not obtain a Feishu tenant token.");
    }

    const recordResponse = await fetchImpl(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(config.baseToken)}/tables/${encodeURIComponent(config.tableId)}/records`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenData.tenant_access_token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          fields: {
            联系人: contact.name,
            邮箱: contact.email,
            "机构或公司": contact.organization,
            合作方向: contact.partnerType,
            留言: contact.message,
            提交时间: Date.now(),
            来源页面: config.sourcePage,
            页面语言: contact.language
          }
        }),
        cache: "no-store"
      }
    );
    const recordData = await recordResponse.json();
    if (!recordResponse.ok || recordData.code !== 0) {
      throw new Error("Could not create a Feishu Bitable record.");
    }
  } catch (error) {
    logger.error?.("Contact form submission failed.", error?.message ?? error);
    return { status: 502, body: { ok: false } };
  }

  return { status: 201, body: { ok: true } };
}
