// Pure rules of the access code page (/c/<code>): routes, the pay link, how far the steps have come. No DOM, no network.

import { localized } from "./artifactForm.js";

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
 * once paid, in the reader's `locale` (the pay pages read the same parameter). The landing is where they come back to, and it opens the code's own page.
 */
export function accessCodePayUrl({ productId, email, origin, site, name, locale }) {
  const params = new URLSearchParams({ product: productId, email: email.trim(), back: `${origin}${CodeRoute.landingPath()}`, site: String(site ?? "").trim(), name: String(name ?? "").trim(), locale });
  return `${PAY_URL}?${params}`;
}

/** The diagnosed website as a domain: no scheme, no www, no path. Whatever the buyer typed that is not a URL is shown trimmed. */
export function siteDomain(value) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname.replace(/^www\./, "") || undefined; }
  catch { return text; }
}

/**
 * Reads the code's status until its report is ready. `accept` takes any status (a poll's, or the intake's answer) and keeps the loop
 * going while the state is "generating", however the page got there. Each wait is `every` with ±15% jitter; a failed read is reported and
 * tried again after a doubled wait (capped at `maxBackoff`), back to `every` on the next success. Time, randomness and reading are injected.
 */
export function createStatusPoller({ read, onStatus, onError, every = 8000, maxBackoff = 60000, random = Math.random, schedule = setTimeout, cancel = clearTimeout }) {
  let timer;
  let alive = true;
  let failures = 0;
  const wait = () => Math.min(maxBackoff, every * 2 ** failures) * (0.85 + random() * 0.3);
  const arm = () => { if (alive && timer === undefined) timer = schedule(tick, wait()); };
  const accept = status => { if (!alive) return; failures = 0; onStatus(status); if (status?.state === "generating") arm(); };
  async function tick() {
    timer = undefined;
    try { const status = await read(); accept(status); }
    catch (error) { if (alive) { failures++; onError(error); arm(); } }
  }
  return { start: tick, accept, stop() { alive = false; cancel(timer); timer = undefined; } };
}

/** The Product's own map without a publish step: the page ends at writing the report, whatever the map still lists. */
export const visibleSteps = steps => (steps ?? []).filter(step => step.id !== "publish");

const CHECK_COUNT = 10;
const DIMENSION_COUNT = 9;
const keys = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}${index}`);

/**
 * The lines of the wait: the checks of an audit, then the scoring dimensions, opening up as the steps advance. The checks and dimensions are what is being looked at ("正在核对"), never a claim that one is done.
 * `t` is the page's translator (key, values) in the reader's language.
 */
export function feedPool({ steps, step, t }) {
  const shown = Math.max(0, step ?? -1) < 0 ? 0 : Math.ceil(DIMENSION_COUNT * Math.min(1, (step + 1) / Math.max(1, steps?.length ?? 1)));
  return [...keys("check", CHECK_COUNT).map(key => t("checking", { item: t(key) })), ...keys("dim", DIMENSION_COUNT).slice(0, shown).map(key => t("scoring", { item: t(key) }))];
}

/** `size` consecutive lines of the pool starting at `tick`, wrapping around. */
export function feedWindow(pool, tick, size = 3) {
  if (!pool.length) return [];
  return Array.from({ length: Math.min(size, pool.length) }, (_, index) => pool[(tick + index) % pool.length]);
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

/** WeChat H5 pay only works in a phone browser. A desktop is a UA with no phone or tablet marker and no touch (an iPad posing as a Mac has touch). */
export const isDesktop = ({ userAgent, maxTouchPoints = 0 } = {}) => Boolean(userAgent) && !/Android|iPhone|iPad|iPod|Mobile|Tablet|Silk|Kindle/i.test(userAgent) && maxTouchPoints < 2;

/** The answers of the intake: its fields' values by id. */
export const intakeAnswers = (fields, values) => Object.fromEntries(fields.map(field => [field.id, String(values[field.id] ?? "").trim()]));
export const missingField = (fields, values) => fields.find(field => field.required && !String(values[field.id] ?? "").trim());

/** The product page's form, in the Brief's own field ids: what the audit needs from the buyer before it can start. */
export const BUYER_FIELDS = Object.freeze([
  { id: "name", type: "line", autoComplete: "name", required: true },
  { id: "phone", type: "tel", autoComplete: "tel", required: true },
  { id: "email", type: "email", autoComplete: "email", required: true },
  { id: "website", type: "url", autoComplete: "url", required: true },
  { id: "markets", type: "line", autoComplete: "off", required: false }
]);

/** A Brief field's label for the reader: the Expert's own text, one per language when they gave it so (`localized`, as the web chat does). */
export const fieldLabel = (field, locale) => localized(field.label, locale);

/** The price as the buyer reads it: fen to ¥ with two decimals. */
export const formatPrice = fen => `¥${(fen / 100).toFixed(2)}`;

/** What the buyer sees first: a missing or malformed field, by its label. */
export function invalidField(values, t) {
  const missing = missingField(BUYER_FIELDS, values);
  if (missing) return t("missingField", { field: t(`field_${missing.id}`) });
  if (!/^[^\s@]+@[^\s@]+$/.test(String(values.email).trim())) return t("emailInvalid");
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

/** The landing's three screens, in order; the address hash names the one shown, so the browser's Back moves between them. */
export const LANDING_STEPS = Object.freeze(["hook", "form", "pay"]);
export const stepFromHash = hash => LANDING_STEPS.find(step => `#${step}` === hash) ?? "hook";
export const stepHash = step => (step === "hook" ? "" : `#${step}`);

/** The screen to show for a wanted one: the pay step only exists once the answers are valid (a reload on #pay has none, so it is the form). */
export const reachableStep = (wanted, values) => (wanted === "pay" && invalidField(values, key => key) ? "form" : wanted);

/** What "next" does: the hook goes to the form; the form goes to pay once valid, else says what is wrong. */
export function advance(step, values, t) {
  if (step === "hook") return { step: "form" };
  const error = invalidField(values, t);
  return error ? { step: "form", error } : { step: "pay" };
}

/** A landing text, which is one string or one per language: the reader's, else Chinese, else any given. */
export const pickText = (text, locale) => typeof text === "string" || text === undefined ? text : (text[locale] ?? text.zh ?? Object.values(text).find(Boolean));

/** The hook's words: the Product's own landing.json, or the Product's name and description when it has none. Nothing is made up. */
export const hookCopy = (landing, locale, t) => ({
  agentName: pickText(landing?.agent_name, locale) ?? landing?.name,
  hook: pickText(landing?.hook, locale) ?? landing?.description ?? landing?.name,
  cta: pickText(landing?.cta, locale) ?? t("startDiagnosis")
});

/** How long a report takes, in minutes: the countdown starts here. */
export const GENERATION_MINUTES = 10;

/** The wait line: whole minutes left (10, 9 … 1) counted from `startedAt`; "即将完成" past the estimate; the static estimate when the start is unknown. */
export function waitLine({ startedAt, now, email, t }) {
  const dest = email ? t("sentTo", { email }) : t("sentToYou");
  const started = Date.parse(startedAt ?? "");
  if (Number.isNaN(started)) return t("waitMinutes", { minutes: GENERATION_MINUTES, dest });
  const elapsed = (now - started) / 60000;
  if (elapsed >= GENERATION_MINUTES) return t("waitSoon", { dest });
  return t("waitMinutes", { minutes: Math.max(1, Math.ceil(GENERATION_MINUTES - elapsed)), dest });
}

/** The ready state's headline: the buyer by name when known. */
export const readyLine = (name, t) => String(name ?? "").trim() ? t("ready", { name: String(name).trim() }) : t("readyPlain");
