import React from "react";
import { Check, Clock3, Cloud, CloudOff, ExternalLink, PackageCheck, ReceiptText, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "../ui/Button.jsx";
import { ConfirmDialog } from "../ui/Overlays.jsx";
import { Checkbox } from "../ui/Forms.jsx";
import { InlineAlert, Progress, StatusTag } from "../ui/Feedback.jsx";
import { cn } from "../ui/utils.js";

function humanize(value) {
  return String(value ?? "not reported").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function money(minor, currency = "USD", locale) {
  const amount = Number(minor);
  if (!Number.isFinite(amount)) return "Not reported";
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount / 100);
}

function statusTone(status) {
  if (["published", "live", "delivered", "active", "approved", "paid", "passed", "saved"].includes(status)) return "success";
  if (["failed", "error", "revoked", "rejected", "unavailable"].includes(status)) return "error";
  if (["pending", "processing", "queued", "running", "saving", "in_progress"].includes(status)) return "progress";
  if (["warning", "needs_attention", "waiting_for_creator"].includes(status)) return "warning";
  return "neutral";
}

export function ReleaseCard({ release, onOpen, actionLabel = "Open release", className }) {
  const status = release.status ?? (release.current ? "published" : "draft");
  return (
    <article className={cn("hatch-release-card", className)}>
      <div className="hatch-release-card__art" aria-hidden="true"><span></span><i></i></div>
      <div className="hatch-release-card__top"><StatusTag tone={statusTone(status)}>{humanize(status)}</StatusTag>{release.version ? <span>v{release.version}</span> : null}</div>
      <h2>{release.name ?? release.label ?? "Untitled release"}</h2>
      {release.promise || release.description ? <p>{release.promise ?? release.description}</p> : null}
      <footer><small>{release.updated_at ? `Updated ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(release.updated_at))}` : release.corpus_digest ?? release.digest ?? "Release details"}</small>{onOpen ? <Button variant="secondary" size="small" trailing={<ExternalLink aria-hidden="true" />} onClick={() => onOpen(release)}>{actionLabel}</Button> : null}</footer>
    </article>
  );
}

export function CandidateReviewPanel({ candidate, gates = [], acknowledgements = [], onAcknowledgementChange, onApprove, onReject, busy = false, error, className }) {
  const failed = gates.filter((gate) => gate.passed === false);
  const approved = candidate.status === "approved";
  const allAcknowledged = acknowledgements.every((item) => item.checked);
  return (
    <section className={cn("hatch-candidate-review", className)}>
      <header><div><StatusTag tone={statusTone(candidate.status)}>{humanize(candidate.status)}</StatusTag><h2>{candidate.name ?? `Candidate v${candidate.version ?? "—"}`}</h2></div>{candidate.digest ? <small>{candidate.digest}</small> : null}</header>
      {error ? <InlineAlert tone="error" title="Review could not be completed">{error}</InlineAlert> : null}
      <div className="hatch-candidate-review__gates" aria-label="Evaluation gates">
        {gates.map((gate, index) => <article className={gate.passed === false ? "is-failed" : "is-passed"} key={gate.id ?? index}><span>{gate.passed === false ? "!" : <Check aria-hidden="true" />}</span><div><strong>{gate.name ?? gate.label ?? `Gate ${index + 1}`}</strong>{gate.detail || gate.message ? <p>{gate.detail ?? gate.message}</p> : null}</div></article>)}
      </div>
      {acknowledgements.length ? <div className="hatch-candidate-review__checks">{acknowledgements.map((item) => <Checkbox key={item.id} checked={item.checked} onCheckedChange={(checked) => onAcknowledgementChange?.(item.id, checked === true)} label={item.label} description={item.description} />)}</div> : null}
      <footer><p>{approved ? "Approval is fixed to this candidate digest." : failed.length ? `${failed.length} critical gate${failed.length === 1 ? "" : "s"} must pass before approval.` : "Approval is immutable for this candidate digest."}</p><div>{onReject ? <Button variant="secondary" disabled={busy || approved} onClick={() => onReject(candidate)}>Reject</Button> : null}<Button loading={busy} disabled={approved || failed.length > 0 || !allAcknowledged} onClick={() => onApprove?.(candidate)}>{approved ? "Approved" : "Approve candidate"}</Button></div></footer>
    </section>
  );
}

export function OrderEntitlementSummary({ order, entitlement, onOpenReceipt, onManageAccess, className }) {
  const currency = order.currency ?? "USD";
  return (
    <section className={cn("hatch-order-summary", className)}>
      <header><div><span className="hui-semantic-label">ORDER</span><h2>{order.product_name ?? order.product?.name ?? "Product order"}</h2></div><StatusTag tone={statusTone(entitlement?.status ?? order.delivery_status ?? order.status)}>{humanize(entitlement?.status ?? order.delivery_status ?? order.status)}</StatusTag></header>
      <dl><div><dt>Order</dt><dd>{order.order_number ?? order.order_reference ?? order.id ?? "Not provided"}</dd></div><div><dt>Total</dt><dd>{money(order.total_minor ?? order.gross_minor ?? 0, currency)}</dd></div><div><dt>Delivery</dt><dd>{humanize(order.delivery_status)}</dd></div><div><dt>Access</dt><dd>{humanize(entitlement?.status)}</dd></div>{entitlement?.release_id ? <div><dt>Release</dt><dd>{entitlement.release_id}</dd></div> : null}{order.created_at ? <div><dt>Placed</dt><dd>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(order.created_at))}</dd></div> : null}</dl>
      <footer>{onOpenReceipt ? <Button variant="secondary" leading={<ReceiptText aria-hidden="true" />} onClick={() => onOpenReceipt(order)}>Receipt</Button> : null}{onManageAccess ? <Button leading={<ShieldCheck aria-hidden="true" />} onClick={() => onManageAccess(entitlement)}>Manage access</Button> : null}</footer>
    </section>
  );
}

const autosaveConfig = {
  idle: { icon: Cloud, label: "Saved", tone: "neutral" },
  ready: { icon: Cloud, label: "Autosave ready", tone: "neutral" },
  dirty: { icon: Clock3, label: "Unsaved changes", tone: "warning" },
  saving: { icon: RefreshCw, label: "Saving…", tone: "progress" },
  saved: { icon: Cloud, label: "Saved", tone: "success" },
  offline: { icon: CloudOff, label: "Offline", tone: "warning" },
  error: { icon: CloudOff, label: "Save failed", tone: "error" }
};

export function AutosaveStatus({ state = "idle", savedAt, detail, onRetry, className }) {
  const config = autosaveConfig[state] || autosaveConfig.idle;
  const Icon = config.icon;
  const timestamp = savedAt ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(savedAt)) : null;
  return <div className={cn("hatch-autosave", `is-${config.tone}`, className)} role="status" aria-live="polite"><Icon className={state === "saving" ? "hui-spin" : undefined} aria-hidden="true" /><span><strong>{config.label}</strong>{detail || timestamp ? <small>{detail ?? `at ${timestamp}`}</small> : null}</span>{state === "error" && onRetry ? <Button size="small" variant="ghost" onClick={onRetry}>Retry</Button> : null}</div>;
}

export function CheckoutSummary({ product, lineItems = [], totals, action, legal, busy = false, error, children, className }) {
  const currency = totals?.currency ?? product.currency ?? "USD";
  const subtotal = totals?.subtotal_minor ?? lineItems.reduce((sum, item) => sum + Number(item.amount_minor || 0), 0);
  const total = totals?.total_minor ?? subtotal;
  return (
    <aside className={cn("hatch-checkout-summary", className)}>
      <header><PackageCheck aria-hidden="true" /><div><span className="hui-semantic-label">CHECKOUT</span><h2>{product.name ?? "Your order"}</h2></div></header>
      <ul>{lineItems.map((item, index) => <li key={item.id ?? index}><span><strong>{item.label ?? item.name}</strong>{item.detail ? <small>{item.detail}</small> : null}</span><b>{money(item.amount_minor, item.currency ?? currency)}</b></li>)}</ul>
      <dl>{totals?.discount_minor ? <div><dt>Discount</dt><dd>−{money(totals.discount_minor, currency)}</dd></div> : null}<div><dt>Subtotal</dt><dd>{totals?.subtotal_label ?? money(subtotal, currency)}</dd></div>{totals?.tax_minor !== undefined ? <div><dt>Tax</dt><dd>{money(totals.tax_minor, currency)}</dd></div> : null}<div className="is-total"><dt>Total</dt><dd>{totals?.total_label ?? money(total, currency)}</dd></div></dl>
      {children}
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      <Button loading={busy} onClick={action?.onClick} disabled={!action || action.disabled}>{action?.label ?? "Complete order"}</Button>
      {legal ? <p className="hatch-checkout-summary__legal">{legal}</p> : null}
    </aside>
  );
}

export function PublishConfirmation({ open, onOpenChange, product, release, checks = [], busy = false, onConfirm, destructive = false }) {
  const ready = checks.every((check) => check.ready);
  return (
    <ConfirmDialog open={open} onOpenChange={onOpenChange} title={destructive ? "Confirm this irreversible change" : "Publish this release?"} description={destructive ? "The action is recorded and cannot be silently undone." : "Publishing creates an immutable release and moves the public current pointer only after materialization succeeds."} confirmLabel={destructive ? "Confirm change" : "Confirm publish"} destructive={destructive} busy={busy} confirmDisabled={!ready} onConfirm={onConfirm}>
      <div className="hatch-publish-confirmation">
        <dl><div><dt>Product</dt><dd>{product?.name ?? product?.id ?? "Not provided"}</dd></div><div><dt>Release</dt><dd>{release?.label ?? release?.digest ?? release?.id ?? "Not provided"}</dd></div></dl>
        {checks.length ? <div><Progress value={(checks.filter((check) => check.ready).length / checks.length) * 100} label="Readiness" /><ul>{checks.map((check) => <li className={check.ready ? "is-ready" : undefined} key={check.label}>{check.ready ? <Check aria-hidden="true" /> : <Clock3 aria-hidden="true" />}<span>{check.label}</span></li>)}</ul></div> : null}
        {!ready ? <InlineAlert tone="warning">Finish every required check before publishing.</InlineAlert> : null}
      </div>
    </ConfirmDialog>
  );
}
