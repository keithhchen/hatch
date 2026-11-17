import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Dialog, DialogContent } from "@hatch/ui";
import { Landmark, Users, Wallet } from "lucide-react";
import { statusLabel, studioOpsCopy } from "./studioOpsCopy.js";
import {
  formatDateTime,
  formatMinor,
  newIdempotencyKey,
  payoutSetupState,
  statusTone,
  userLabelKey,
  userRows,
  userTotals,
  usersQuery
} from "./studioOpsModel.js";
import "./studioOps.css";

/* ---------- shared pieces ---------- */

function PageHead({ title, body, actions, back }) {
  return <header className="sops-head">
    {back}
    <div className="sops-head__row">
      <div className="sops-head__text">
        <h1>{title}</h1>
        {body ? <p>{body}</p> : null}
      </div>
      {actions ? <div className="sops-head__actions">{actions}</div> : null}
    </div>
  </header>;
}

function Pill({ value, copy }) {
  if (!value) return null;
  return <span className={`sops-pill is-${statusTone(value)}`}>{statusLabel(copy, value)}</span>;
}

function ErrorCard({ error, copy, onRetry, title }) {
  return <div className="sops-card sops-state is-error" role="alert">
    <h2>{title ?? copy.loadFailed}</h2>
    <p>{error?.message}</p>
    {error?.request_id ? <p className="sops-faint">{copy.requestId(error.request_id)}</p> : null}
    {onRetry ? <Button variant="secondary" size="compact" onClick={onRetry}>{copy.retry}</Button> : null}
  </div>;
}

function Loading({ copy }) {
  return <div className="sops-loading" role="status" aria-live="polite">
    <span className="sops-skel" /><span className="sops-skel" /><span className="sops-skel is-short" />
    <span className="sops-sr">{copy.loading}</span>
  </div>;
}

function EmptyCard({ icon: Icon, title, body, action }) {
  return <div className="sops-card sops-state">
    <span className="sops-state__icon" aria-hidden="true"><Icon /></span>
    <h2>{title}</h2>
    <p>{body}</p>
    {action}
  </div>;
}

function ReasonDialog({ open, onOpenChange, title, body, label, hint, placeholder, submitLabel, onSubmit, copy, destructive }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [key, setKey] = useState("");
  useEffect(() => {
    if (open) { setReason(""); setError(null); setKey(newIdempotencyKey()); }
  }, [open]);
  async function submit(event) {
    event.preventDefault();
    if (!reason.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason.trim(), key);
      onOpenChange(false);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  return <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
    <DialogContent title={title} description={body} className="sops-dialog">
      <form onSubmit={submit} className="sops-form">
        <label className="sops-field">
          <span>{label}</span>
          <textarea required rows={3} value={reason} placeholder={placeholder} onChange={(event) => setReason(event.target.value)} />
          {hint ? <small>{hint}</small> : null}
        </label>
        {error ? <p className="sops-inline-error" role="alert">{error.message}{error.request_id ? ` · ${copy.requestId(error.request_id)}` : ""}</p> : null}
        <div className="sops-form__actions">
          <Button type="button" variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>{copy.cancel}</Button>
          <Button type="submit" variant={destructive ? "danger" : "primary"} loading={busy} disabled={!reason.trim() || busy}>{submitLabel}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}

/* ---------- Users ---------- */

export function StudioUsersPage({ request, navigate, locale }) {
  const copy = studioOpsCopy(locale);
  const [productId, setProductId] = useState("");
  const [products, setProducts] = useState([]);
  const [users, setUsers] = useState([]);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    request("/v1/creator/products").then((payload) => { if (live) setProducts(payload.products ?? []); }).catch(() => undefined);
    return () => { live = false; };
  }, [request]);

  const productNames = useMemo(() => Object.fromEntries(products.map((product) => [product.product_id, product.name])), [products]);

  const reload = useCallback(() => {
    let live = true;
    setStatus("loading");
    setError(null);
    request(`/v1/creator/users${usersQuery(productId)}`).then((payload) => {
      if (!live) return;
      setUsers(userRows(payload.users));
      setStatus("ready");
    }).catch((cause) => {
      if (!live) return;
      setError(cause);
      setStatus("error");
    });
    return () => { live = false; };
  }, [request, productId]);

  useEffect(() => reload(), [reload]);

  const noUsersYet = !users.length && !productId;
  return <div className="sops-page">
    <PageHead
      title={copy.usersTitle}
      actions={noUsersYet ? null : <label className="sops-filter">
        <span>{copy.filterAgent}</span>
        <select value={productId} onChange={(event) => setProductId(event.target.value)}>
          <option value="">{copy.filterAll}</option>
          {products.map((product) => <option key={product.product_id} value={product.product_id}>{product.name}</option>)}
        </select>
      </label>}
    />

    {status === "loading" ? <Loading copy={copy} /> : null}
    {status === "error" ? <ErrorCard error={error} copy={copy} onRetry={reload} /> : null}
    {status === "ready" && !users.length ? (productId
      ? <EmptyCard icon={Users} title={copy.usersNoMatchTitle} body={copy.usersNoMatchBody}
          action={<Button variant="secondary" size="compact" onClick={() => setProductId("")}>{copy.clearFilters}</Button>} />
      : <EmptyCard icon={Users} title={copy.usersEmptyTitle} body={copy.usersEmptyBody}
          action={<Button variant="secondary" size="compact" onClick={() => navigate("/studio/products")}>{copy.usersEmptyAction}</Button>} />) : null}

    {status === "ready" && users.length ? <>
      <div className="sops-card sops-table-wrap">
        <table className="sops-table">
          <thead><tr>
            <th>{copy.colUser}</th><th>{copy.colAgent}</th>
            <th className="is-num">{copy.colConversations}</th><th className="is-num">{copy.colMessages}</th>
            <th>{copy.colLastActive}</th>
          </tr></thead>
          <tbody>
            {users.map((user, index) => <tr key={index}>
              <td className="sops-strong">{user.display_name || copy[userLabelKey(user.kind)]}</td>
              <td>{productNames[user.product_id] ?? user.product_id}</td>
              <td className="is-num">{user.conversations}</td>
              <td className="is-num">{user.messages}</td>
              <td className="sops-faint">{formatDateTime(user.last_at, locale)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <footer className="sops-list-foot">
        <span className="sops-faint">{copy.usersSummary(userTotals(users))}</span>
      </footer>
    </> : null}
  </div>;
}

/* ---------- Earnings ---------- */

export function StudioEarningsPage({ request, locale }) {
  const copy = studioOpsCopy(locale);
  const [overview, setOverview] = useState({ status: "loading" });
  const [payouts, setPayouts] = useState({ status: "loading" });
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState(null);
  const [detail, setDetail] = useState(null);
  const [retryTarget, setRetryTarget] = useState(null);
  const [notice, setNotice] = useState("");

  const loadOverview = useCallback(() => {
    setOverview({ status: "loading" });
    request("/v1/creator/overview").then((data) => setOverview({ status: "ready", data })).catch((error) => setOverview({ status: "error", error }));
  }, [request]);
  const loadPayouts = useCallback(() => {
    setPayouts({ status: "loading" });
    request("/v1/creator/payouts?currency=USD").then((data) => setPayouts({ status: "ready", data })).catch((error) => setPayouts({ status: "error", error }));
  }, [request]);
  useEffect(() => { loadOverview(); loadPayouts(); }, [loadOverview, loadPayouts]);

  async function connect() {
    setConnecting(true);
    setConnectError(null);
    try {
      const session = await request("/v1/creator/payout-account-sessions", {
        method: "POST",
        headers: { "idempotency-key": newIdempotencyKey() },
        body: JSON.stringify({ currency: payouts.data?.currency ?? "USD" })
      });
      if (!session?.session_url) throw new Error(copy.payoutNoSession);
      window.location.assign(session.session_url);
    } catch (cause) {
      setConnectError(cause);
      setConnecting(false);
    }
  }

  async function openDetail(payout) {
    setDetail({ status: "loading", payout });
    try {
      const data = await request(`/v1/creator/payouts/${encodeURIComponent(payout.payout_id)}`);
      setDetail({ status: "ready", payout: data.payout });
    } catch (error) {
      setDetail({ status: "error", payout, error });
    }
  }

  async function retry(reason, key) {
    await request(`/v1/creator/payouts/${encodeURIComponent(retryTarget.payout_id)}/retry`, {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({ reason })
    });
    setDetail(null);
    setNotice(copy.payoutRetryDone);
    loadPayouts();
  }

  const metrics = overview.data?.metrics;
  const metricsCurrency = overview.data?.recent_orders?.[0]?.currency ?? payouts.data?.currency ?? "USD";
  const kpis = metrics ? [
    { key: "gross", label: copy.kpiGross, value: formatMinor(metrics.gross_minor, metricsCurrency, locale) },
    { key: "creator", label: copy.kpiCreator, value: formatMinor(metrics.creator_share_minor, metricsCurrency, locale), accent: true },
    { key: "hatch", label: copy.kpiHatch, value: formatMinor(metrics.hatch_share_minor, metricsCurrency, locale) },
    { key: "orders", label: copy.kpiOrders, value: new Intl.NumberFormat(locale).format(metrics.orders ?? 0) },
    { key: "deliveries", label: copy.kpiDeliveries, value: new Intl.NumberFormat(locale).format(metrics.successful_deliveries ?? 0) }
  ] : [];

  const payoutData = payouts.data;
  const setup = payoutSetupState(payoutData);
  const currency = payoutData?.currency ?? "USD";
  const balances = payoutData && payoutData.available_minor !== null && payoutData.available_minor !== undefined ? [
    [copy.balanceAvailable, payoutData.available_minor, true],
    [copy.balanceReserved, payoutData.reserved_minor],
    [copy.balanceInTransit, payoutData.in_transit_minor],
    [copy.balancePaid, payoutData.paid_minor]
  ] : null;
  const payoutRows = payoutData?.payouts ?? [];

  return <div className="sops-page">
    <PageHead title={copy.earningsTitle} body={copy.earningsBody} />
    {notice ? <p className="sops-notice" role="status">{notice}</p> : null}

    {overview.status === "loading" ? <Loading copy={copy} /> : null}
    {overview.status === "error" ? <ErrorCard error={overview.error} copy={copy} onRetry={loadOverview} /> : null}
    {metrics && !Number(metrics.orders) ? <EmptyCard icon={Wallet} title={copy.earningsEmptyTitle} body={copy.earningsEmptyBody} /> : null}
    {metrics && Number(metrics.orders) ? <>
      <section className="sops-kpis" aria-label={copy.earningsTitle}>
        {kpis.map((kpi) => <div key={kpi.key} className={`sops-card sops-kpi ${kpi.accent ? "is-accent" : ""}`}>
          <span>{kpi.label}</span><strong>{kpi.value}</strong>
        </div>)}
      </section>
      <p className="sops-faint sops-note">{copy.kpiNote}</p>
    </> : null}

    {payouts.status === "ready" && setup === "unavailable" ? null : <section className="sops-card sops-section sops-payout">
      <h2>{copy.payoutTitle}</h2>
      {payouts.status === "loading" ? <Loading copy={copy} /> : null}
      {payouts.status === "error" ? <ErrorCard error={payouts.error} copy={copy} onRetry={loadPayouts} /> : null}
      {payouts.status === "ready" ? <div className={`sops-payout__state is-${setup}`}>
        <span className="sops-state__icon" aria-hidden="true">{setup === "complete" ? <Landmark /> : <Wallet />}</span>
        <div className="sops-payout__text">
          {setup === "unavailable" ? <><h3>{copy.payoutUnavailableTitle}</h3><p>{copy.payoutUnavailableBody}</p></> : null}
          {setup === "required" ? <><h3>{copy.payoutRequiredTitle}</h3><p>{copy.payoutRequiredBody}</p></> : null}
          {setup === "complete" ? <><h3>{copy.payoutCompleteTitle}</h3><p>{copy.payoutCompleteBody(payoutData.account?.provider)}</p></> : null}
          {payoutData.account_status && setup !== "unavailable" ? <p className="sops-faint">{copy.payoutAccountStatus}: {statusLabel(copy, payoutData.account_status)}</p> : null}
          {connectError ? <p className="sops-inline-error" role="alert">{connectError.message}{connectError.request_id ? ` · ${copy.requestId(connectError.request_id)}` : ""}</p> : null}
        </div>
        {setup !== "unavailable" ? <Button variant={setup === "required" ? "primary" : "secondary"} size="compact" loading={connecting} onClick={() => void connect()}>
          {connecting ? copy.payoutConnecting : setup === "required" ? copy.payoutConnect : copy.payoutUpdateAccount}
        </Button> : null}
      </div> : null}
    </section>}

    {balances ? <section className="sops-card sops-section">
      <h2>{copy.balancesTitle}</h2>
      <div className="sops-balances">
        {balances.map(([label, value, accent]) => <div key={label} className={accent ? "is-accent" : ""}><span>{label}</span><strong>{formatMinor(value ?? 0, currency, locale)}</strong></div>)}
      </div>
    </section> : null}

    {payouts.status === "ready" && (setup !== "unavailable" || payoutRows.length) ? <section className="sops-card sops-section">
      <h2>{copy.payoutsTitle}</h2>
      {payoutRows.length ? <ul className="sops-rows">
        {payoutRows.map((payout) => <li key={payout.payout_id}>
          <div>
            <span className="sops-strong">{formatMinor(payout.amount_minor, payout.currency, locale)}</span>
            <span className="sops-faint"> · {formatDateTime(payout.created_at, locale)}</span>
          </div>
          <div className="sops-rows__meta">
            <Pill value={payout.status} copy={copy} />
            <button type="button" className="sops-link" onClick={() => void openDetail(payout)}>{copy.payoutDetail}</button>
            {payout.status === "failed" ? <button type="button" className="sops-link" onClick={() => setRetryTarget(payout)}>{copy.payoutRetry}</button> : null}
          </div>
        </li>)}
      </ul> : <p className="sops-faint">{copy.payoutsEmpty}</p>}
    </section> : null}

    <Dialog open={Boolean(detail)} onOpenChange={(open) => !open && setDetail(null)}>
      {detail ? <DialogContent title={copy.payoutDetailTitle} className="sops-dialog">
        {detail.status === "loading" ? <Loading copy={copy} /> : null}
        {detail.status === "error" ? <p className="sops-inline-error" role="alert">{detail.error.message}</p> : null}
        {detail.status === "ready" ? <dl className="sops-dl">
          <div><dt>{copy.colPayoutAmount}</dt><dd>{formatMinor(detail.payout.amount_minor, detail.payout.currency, locale)}</dd></div>
          <div><dt>{copy.colPayoutStatus}</dt><dd><Pill value={detail.payout.status} copy={copy} /></dd></div>
          <div><dt>{copy.colPayoutAttempt}</dt><dd>{detail.payout.attempt}</dd></div>
          <div><dt>{copy.colPayoutDate}</dt><dd>{formatDateTime(detail.payout.created_at, locale)}</dd></div>
          {detail.payout.submitted_at ? <div><dt>{copy.payoutSubmittedAt}</dt><dd>{formatDateTime(detail.payout.submitted_at, locale)}</dd></div> : null}
          <div><dt>{copy.payoutUpdatedAt}</dt><dd>{formatDateTime(detail.payout.updated_at, locale)}</dd></div>
          {detail.payout.failure ? <div><dt>{copy.payoutFailure}</dt><dd>{detail.payout.failure.message ?? detail.payout.failure.code}</dd></div> : null}
          <div><dt>{copy.payoutId}</dt><dd className="sops-break">{detail.payout.payout_id}</dd></div>
        </dl> : null}
        {detail.status === "ready" && detail.payout.status === "failed"
          ? <div className="sops-form__actions"><Button size="compact" onClick={() => setRetryTarget(detail.payout)}>{copy.payoutRetry}</Button></div>
          : null}
      </DialogContent> : null}
    </Dialog>

    <ReasonDialog
      open={Boolean(retryTarget)}
      onOpenChange={(open) => !open && setRetryTarget(null)}
      title={copy.payoutRetryTitle}
      body={copy.payoutRetryBody}
      label={copy.payoutRetryLabel}
      placeholder={copy.payoutRetryPlaceholder}
      submitLabel={copy.payoutRetrySubmit}
      onSubmit={retry}
      copy={copy}
    />
  </div>;
}

