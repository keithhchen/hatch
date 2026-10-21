// Shared Studio building blocks: remote resources, page frame, status and
// formatting helpers. Every value shown comes from a real dashboard endpoint.
import React, { useCallback, useEffect, useState } from "react";
import { Button, InlineAlert, Skeleton, UnavailableState } from "@hatch/ui";
import { formatMoney } from "./data.js";
import { isProductLive, studioNextStep, studioPathStates } from "./studioPath.js";

export const STUDIO_ROOT = "/studio";

/** GET a dashboard path; keeps the last data while refreshing. path=null skips. */
export function useRemote(request, path) {
  const [attempt, setAttempt] = useState(0);
  const [resource, setResource] = useState({ state: path ? "loading" : "idle", data: null, error: null });
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    if (!path) return undefined;
    let active = true;
    setResource((current) => current.data ? { ...current, state: "refreshing", error: null } : { state: "loading", data: null, error: null });
    Promise.resolve(request(path)).then((data) => { if (active) setResource({ state: "ready", data, error: null }); }).catch((error) => { if (active) setResource({ state: "error", data: null, error }); });
    return () => { active = false; };
  }, [request, path, attempt]);
  return { ...resource, retry };
}

/** The guided-path state of one Agent, read from its Factory config. */
export function useAgentPath(request, product) {
  const productId = idOf(product, "product");
  const factory = useRemote(request, productId ? `/v1/creator/products/${encodeURIComponent(productId)}/factory-agents/config` : null);
  if (factory.state !== "ready" && factory.state !== "refreshing") return { state: factory.state, states: null, next: null };
  const states = studioPathStates(arrayOf(factory.data?.agents), product);
  return { state: "ready", states, next: studioNextStep(states) };
}

export function PageBoundary({ resource, title, t, children }) {
  if (resource.state === "loading" || resource.state === "idle") return <LoadingState t={t} />;
  if (resource.state === "error") return <RouteProblem title={title} body={friendlyError(resource.error, t)} action={t("retry")} onAction={resource.retry} />;
  return <>{children(resource.data)}</>;
}

export function PageHeader({ title, body, actions, children }) {
  return <header className="sx-page-head">
    <div className="sx-page-head__text"><h1>{title}</h1>{body ? <p>{body}</p> : null}{children}</div>
    {actions ? <div className="sx-page-head__actions">{actions}</div> : null}
  </header>;
}

export function SectionHead({ title, action, onAction }) {
  return <div className="sx-section-head"><h2>{title}</h2>{action ? <button className="sx-link" type="button" onClick={onAction}>{action}</button> : null}</div>;
}

export function StatusPill({ live, t }) {
  return <span className={`sx-pill${live ? " is-live" : ""}`}>{t(live ? "agentLive" : "agentDraft")}</span>;
}

export function InlineError({ children }) { return <InlineAlert className="cpv2-alert" tone="error">{children}</InlineAlert>; }
export function SuccessNotice({ children }) { return <InlineAlert className="cpv2-success" tone="success">{children}</InlineAlert>; }

export function EmptyState({ title, body, action, onAction }) {
  return <section className="sx-empty"><h2>{title}</h2><p>{body}</p>{action ? <Button className="web-btn-yolk" type="button" onClick={onAction}>{action}</Button> : null}</section>;
}

export function RouteProblem({ title, body, action, onAction }) {
  return <UnavailableState className="cpv2-problem" title={title} body={body} action={action ? { label: action, onClick: onAction } : undefined} />;
}

export function LoadingState({ t }) {
  return <section className="cpv2-loading" aria-busy="true" aria-label={t?.("loadingCreatorPage") ?? ""}><Skeleton lines={4} /></section>;
}

/** Copy an absolute public URL and report the real clipboard result. */
export function useCopy() {
  const [copied, setCopied] = useState("");
  const copy = useCallback(async (value) => {
    await navigator.clipboard.writeText(absoluteUrl(value));
    setCopied(value);
    setTimeout(() => setCopied((current) => current === value ? "" : current), 2000);
  }, []);
  return { copied, copy };
}

export function publicPathOf(product) {
  if (!isProductLive(product)) return "";
  return canonicalPublicUrl(product?.canonical_url ?? product?.public_url) ?? (isUuidV4(idOf(product, "product")) ? `/products/${idOf(product, "product")}` : "");
}

export function absoluteUrl(value) {
  if (typeof window === "undefined") return String(value ?? "");
  return new URL(value, window.location.origin).href;
}

export function money(minor, currency) { return formatMoney(Number(minor) || 0, currency || "USD"); }
export function dateTime(value, locale = "en") { if (!value) return "—"; const date = new Date(value); if (Number.isNaN(date.valueOf())) return String(value); return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: "medium", timeStyle: "short" }).format(date); }
export function dateOnly(value, locale = "en") { if (!value) return "—"; const date = new Date(value); if (Number.isNaN(date.valueOf())) return String(value); return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: "medium" }).format(date); }
function intlLocale(locale) { return locale === "zh" ? "zh-CN" : locale === "ja" ? "ja-JP" : "en"; }
export function idOf(value, kind) { return String(value?.[`${kind}_id`] ?? value?.id ?? ""); }
export function arrayOf(value) { return Array.isArray(value) ? value : []; }
export function unwrap(payload, key) { return payload && Object.prototype.hasOwnProperty.call(payload, key) ? payload[key] : payload; }
export function mutationKey() { return globalThis.crypto?.randomUUID?.() ?? `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
export function productName(product, t) { return product?.name ?? product?.product_name ?? t("untitledProduct"); }
export function isUuidV4(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? "")); }
export function safePublicUrl(value) { const text = String(value ?? ""); return /^https?:\/\//i.test(text) || /^\/products\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text) ? text : undefined; }
export function canonicalPublicUrl(value) { const text = String(value ?? ""); if (!text) return undefined; if (/^https:\/\//i.test(text)) return text; return safePublicUrl(text); }

const STATUS_MESSAGE_KEYS = {
  active: "statusActive", approved: "statusApproved", available: "statusAvailable", blocked: "statusBlocked", completed: "statusCompleted", failed: "statusFailed", fulfilled: "statusFulfilled", in_transit: "statusInTransit", pending: "statusPending", processing: "statusProcessing", published: "statusPublished", ready: "statusReady", refunded: "statusRefunded", refund_pending: "statusRefundPending", reserved: "statusReserved", reversed: "statusReversed", preparing: "statusPreparing", retired: "statusRetired", none: "statusNone"
};
export function humanStatus(value, t) { if (!value) return t("notProvided"); const raw = String(value); const key = STATUS_MESSAGE_KEYS[raw.toLowerCase()]; return key ? t(key) : raw.replaceAll("_", " "); }

export function friendlyError(error, t) {
  if (!error) return t("unexpectedError");
  if (error.status === 401) return t("sessionExpired");
  if (error.status === 403) return t("creatorForbidden");
  if (error.status === 404) return t("requestedResourceMissing");
  if (error.code === "product_not_editable") return t("sxErrNotEditable");
  if (error.code === "publish_not_ready") return t("sxErrNotReady");
  if (error.status === 409) return t("pageChanged");
  if (error.status === 429) return t("tooManyRequests");
  return error.message || t("serviceUnavailable");
}
