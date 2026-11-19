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

/** The answers of the intake: its fields' values by id. */
export const intakeAnswers = (fields, values) => Object.fromEntries(fields.map(field => [field.id, String(values[field.id] ?? "").trim()]));
export const missingField = (fields, values) => fields.find(field => field.required && !String(values[field.id] ?? "").trim());
