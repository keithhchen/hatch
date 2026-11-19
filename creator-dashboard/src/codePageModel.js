// Pure rules of the access code page (/c/<code>): routes, the pay link, how far the steps have come. No DOM, no network.

const CODE_ROUTE = /^\/c(?:\/([A-Za-z0-9_-]{4,64}))?\/?$/;
export const PAY_URL = "https://anyteach.cn/hatch-pay/";

export const CodeRoute = Object.freeze({
  /** `/c` and `/c/` are the landing; `/c/<code>` is that code's page. */
  parse(pathname) {
    const match = CODE_ROUTE.exec(pathname);
    return match ? Object.freeze({ code: match[1] ?? null }) : null;
  },
  landingPath: () => "/c/",
  codePath: code => `/c/${encodeURIComponent(code)}`
});

/**
 * Where buying a code starts: the pay page for the Product and the buyer's email, which sends the buyer back to `back` with `?code=`
 * once paid. The landing is where they come back to, and it opens the code's own page.
 */
export function accessCodePayUrl({ productId, email, origin }) {
  const params = new URLSearchParams({ product: productId, email: email.trim(), back: `${origin}${CodeRoute.landingPath()}` });
  return `${PAY_URL}?${params}`;
}

/** What the visitor typed, as a code: letters and digits, upper case; undefined when it cannot be one. */
export function typedCode(value) {
  const code = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9_-]{4,64}$/.test(code) ? code : undefined;
}

/** Each step as the page shows it: done, the one in progress, or still to come. `step` is the last one the Run reached (-1: none). */
export const stepStates = (steps, step) => (steps ?? []).map((entry, index) => ({ ...entry, state: index < step ? "done" : index === step ? "now" : "next" }));

/** WeChat's in-app browser cannot pay by H5: the buyer is sent out of it to the phone's own browser. */
export const inWeChat = userAgent => /MicroMessenger/i.test(userAgent ?? "");

/** The answers of the intake: its fields' values by id. */
export const intakeAnswers = (fields, values) => Object.fromEntries(fields.map(field => [field.id, String(values[field.id] ?? "").trim()]));
export const missingField = (fields, values) => fields.find(field => field.required && !String(values[field.id] ?? "").trim());

/** The product page's form, in the Brief's own field ids: what the audit needs from the buyer before it can start. */
export const BUYER_FIELDS = Object.freeze([
  { id: "name", label: "姓名", type: "line", autoComplete: "name", required: true },
  { id: "phone", label: "电话", type: "tel", autoComplete: "tel", required: true },
  { id: "email", label: "邮箱", type: "email", autoComplete: "email", required: true },
  { id: "website", label: "网址", type: "url", autoComplete: "url", required: true },
  { id: "markets", label: "出海的国家和地区", type: "line", autoComplete: "off", required: false }
]);

/** The price as the buyer reads it: fen to ¥ with two decimals. */
export const formatPrice = fen => `¥${(fen / 100).toFixed(2)}`;

/** What the buyer sees first: a missing or malformed field, by its label. */
export function invalidField(values) {
  const missing = missingField(BUYER_FIELDS, values);
  if (missing) return `请填写：${missing.label}`;
  if (!/^[^\s@]+@[^\s@]+$/.test(String(values.email).trim())) return "邮箱格式不对";
  return undefined;
}

const PENDING_KEY = "hatch.code.intake";

/**
 * The answers given before paying, kept in the browser for the way back: H5 pay returns to the same browser, where the code's page
 * submits them by itself. `storage` is injected (localStorage in the page).
 */
export const PendingIntake = Object.freeze({
  save(storage, values) { try { storage.setItem(PENDING_KEY, JSON.stringify(intakeAnswers(BUYER_FIELDS, values))); } catch { /* private mode: the form is asked again */ } },
  /** Reads and forgets in one step, so the same answers are never submitted twice. */
  take(storage) {
    try {
      const saved = JSON.parse(storage.getItem(PENDING_KEY) ?? "null");
      storage.removeItem(PENDING_KEY);
      return saved && typeof saved === "object" ? saved : undefined;
    } catch { return undefined; }
  }
});
