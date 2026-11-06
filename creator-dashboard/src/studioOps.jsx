import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Dialog, DialogContent } from "@hatch/ui";
import { ArrowLeft, ChevronRight, Download, Landmark,  ReceiptText, SlidersHorizontal, Wallet } from "lucide-react";
import { eventLabel, statusLabel, studioOpsCopy } from "./studioOpsCopy.js";
import {
  ORDER_FILTER_OPTIONS,
  activeFilterCount,
  formatDate,
  formatDateTime,
  formatMinor,
  newIdempotencyKey,
  orderProductName,
  orderShares,
  ordersQuery,
  payoutSetupState,
  statusTone
} from "./studioOpsModel.js";
import "./studioOps.css";

const PAGE_SIZE = 25;

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

/* ---------- Orders ---------- */

const EMPTY_FILTERS = { product: "", order: "", payment: "", delivery: "", refund: "", from: "", to: "" };

export function StudioOrdersPage({ request, navigate, locale }) {
  const copy = studioOpsCopy(locale);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const filterCount = activeFilterCount(filters);

  useEffect(() => {
    let live = true;
    request("/v1/creator/products").then((payload) => { if (live) setProducts(payload.products ?? []); }).catch(() => undefined);
    return () => { live = false; };
  }, [request]);

  const productNames = useMemo(() => Object.fromEntries(products.map((product) => [product.product_id, product.name])), [products]);

  const load = useCallback(async (nextCursor) => {
    const path = `/v1/creator/orders${ordersQuery(filters, { limit: PAGE_SIZE, cursor: nextCursor })}`;
    return request(path);
  }, [request, filters]);

  const reload = useCallback(() => {
    let live = true;
    setStatus("loading");
    setError(null);
    load(null).then((payload) => {
      if (!live) return;
      setOrders(payload.orders ?? []);
      setCursor(payload.next_cursor ?? null);
      setStatus("ready");
    }).catch((cause) => {
      if (!live) return;
      setError(cause);
      setStatus("error");
    });
    return () => { live = false; };
  }, [load]);

  useEffect(() => reload(), [reload]);

  async function loadMore() {
    if (!cursor || moreBusy) return;
    setMoreBusy(true);
    try {
      const payload = await load(cursor);
      setOrders((current) => [...current, ...(payload.orders ?? [])]);
      setCursor(payload.next_cursor ?? null);
    } catch (cause) {
      setError(cause);
    } finally {
      setMoreBusy(false);
    }
  }

  const setFilter = (key) => (event) => setFilters((current) => ({ ...current, [key]: event.target.value }));
  const exportHref = `/v1/creator/orders/export${ordersQuery(filters)}`;
  const openOrder = (order) => navigate(`/studio/orders/${encodeURIComponent(order.order_number ?? order.order_id)}`);

  const select = (key, label, options, render) => <label className="sops-filter">
    <span>{label}</span>
    <select value={filters[key]} onChange={setFilter(key)}>
      <option value="">{copy.filterAll}</option>
      {options.map((value) => <option key={value} value={value}>{render ? render(value) : statusLabel(copy, value)}</option>)}
    </select>
  </label>;

  // Filters and export only make sense once there is at least one order.
  const noOrdersYet = !orders.length && !filterCount;
  return <div className="sops-page">
    <PageHead
      title={copy.ordersTitle}
      body={copy.ordersBody}
      actions={noOrdersYet ? null : <>
        <Button className="sops-only-mobile" variant="secondary" size="compact" leading={<SlidersHorizontal aria-hidden="true" />} aria-expanded={showFilters} onClick={() => setShowFilters((value) => !value)}>
          {copy.filters}{filterCount ? ` · ${filterCount}` : ""}
        </Button>
        {orders.length
          ? <Button asChild variant="secondary" size="compact" leading={<Download aria-hidden="true" />}><a href={exportHref} download>{copy.exportCsv}</a></Button>
          : <Button variant="secondary" size="compact" leading={<Download aria-hidden="true" />} disabled>{copy.exportCsv}</Button>}
      </>}
    />

    {noOrdersYet ? null : <section className={`sops-filters ${showFilters ? "is-open" : ""}`} aria-label={copy.filters}>
      {select("product", copy.filterAgent, products.map((product) => product.product_id), (id) => productNames[id] ?? id)}
      {select("order", copy.filterOrder, ORDER_FILTER_OPTIONS.order)}
      {select("payment", copy.filterPayment, ORDER_FILTER_OPTIONS.payment)}
      {select("delivery", copy.filterDelivery, ORDER_FILTER_OPTIONS.delivery)}
      {select("refund", copy.filterRefund, ORDER_FILTER_OPTIONS.refund)}
      <label className="sops-filter"><span>{copy.filterFrom}</span><input type="date" value={filters.from} max={filters.to || undefined} onChange={setFilter("from")} /></label>
      <label className="sops-filter"><span>{copy.filterTo}</span><input type="date" value={filters.to} min={filters.from || undefined} onChange={setFilter("to")} /></label>
      {filterCount ? <button type="button" className="sops-link sops-filters__clear" onClick={() => setFilters(EMPTY_FILTERS)}>{copy.clearFilters}</button> : null}
    </section>}

    {status === "loading" ? <Loading copy={copy} /> : null}
    {status === "error" ? <ErrorCard error={error} copy={copy} onRetry={reload} /> : null}
    {status === "ready" && !orders.length ? (filterCount
      ? <EmptyCard icon={SlidersHorizontal} title={copy.ordersNoMatchTitle} body={copy.ordersNoMatchBody}
          action={<Button variant="secondary" size="compact" onClick={() => setFilters(EMPTY_FILTERS)}>{copy.clearFilters}</Button>} />
      : <EmptyCard icon={ReceiptText} title={copy.ordersEmptyTitle} body={copy.ordersEmptyBody}
          action={<Button variant="secondary" size="compact" onClick={() => navigate("/studio/products")}>{copy.ordersEmptyAction}</Button>} />) : null}

    {status === "ready" && orders.length ? <>
      <div className="sops-card sops-table-wrap">
        <table className="sops-table">
          <thead><tr>
            <th>{copy.colOrder}</th><th>{copy.colAgent}</th><th>{copy.colBuyer}</th>
            <th className="is-num">{copy.colAmount}</th><th className="is-num">{copy.colShare}</th>
            <th>{copy.colStatus}</th><th>{copy.colDate}</th><th aria-hidden="true" />
          </tr></thead>
          <tbody>
            {orders.map((order) => {
              const shares = orderShares(order);
              return <tr key={order.order_id} tabIndex={0} onClick={() => openOrder(order)} onKeyDown={(event) => event.key === "Enter" && openOrder(order)}>
                <td className="sops-strong">{order.order_number}</td>
                <td>{orderProductName(order, productNames)}</td>
                <td>{order.buyer_display_name ?? ""}</td>
                <td className="is-num">{formatMinor(order.gross_minor, order.currency, locale)}</td>
                <td className="is-num">{shares.recognized ? formatMinor(shares.creator, order.currency, locale) : <span className="sops-faint">{copy.sharePending}</span>}</td>
                <td><Pill value={order.status} copy={copy} /></td>
                <td className="sops-faint">{formatDateTime(order.placed_at ?? order.created_at, locale)}</td>
                <td className="sops-chevron"><ChevronRight aria-hidden="true" /></td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
      <ul className="sops-cards">
        {orders.map((order) => {
          const shares = orderShares(order);
          return <li key={order.order_id}>
            <button type="button" className="sops-card sops-order-card" onClick={() => openOrder(order)}>
              <span className="sops-order-card__top"><span className="sops-strong">{orderProductName(order, productNames)}</span><Pill value={order.status} copy={copy} /></span>
              <span className="sops-order-card__amount">{formatMinor(order.gross_minor, order.currency, locale)}</span>
              <span className="sops-faint">{copy.colShare} {shares.recognized ? formatMinor(shares.creator, order.currency, locale) : copy.sharePending}</span>
              <span className="sops-faint">{order.order_number} · {order.buyer_display_name ?? ""} · {formatDate(order.placed_at ?? order.created_at, locale)}</span>
            </button>
          </li>;
        })}
      </ul>
      <footer className="sops-list-foot">
        <span className="sops-faint">{copy.shownCount(orders.length)}</span>
        {cursor ? <Button variant="secondary" size="compact" loading={moreBusy} onClick={() => void loadMore()}>{moreBusy ? copy.loadingMore : copy.loadMore}</Button> : null}
      </footer>
      {error && status === "ready" ? <p className="sops-inline-error" role="alert">{error.message}</p> : null}
    </> : null}
  </div>;
}

/* ---------- Order detail ---------- */

export function StudioOrderDetailPage({ request, navigate, locale, orderId }) {
  const copy = studioOpsCopy(locale);
  const [order, setOrder] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);
  const [refundOpen, setRefundOpen] = useState(false);
  const [notice, setNotice] = useState("");

  const reload = useCallback(() => {
    let live = true;
    setStatus("loading");
    request(`/v1/creator/orders/${encodeURIComponent(orderId ?? "")}`).then((payload) => {
      if (!live) return;
      setOrder(payload.order);
      setStatus("ready");
    }).catch((cause) => {
      if (!live) return;
      setError(cause);
      setStatus("error");
    });
    return () => { live = false; };
  }, [request, orderId]);
  useEffect(() => reload(), [reload]);

  async function submitRefund(reason, key) {
    const payload = await request(`/v1/creator/orders/${encodeURIComponent(order.order_id)}/refund-requests`, {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({ reason })
    });
    if (payload?.order) setOrder(payload.order);
    setNotice(copy.refundDone);
  }

  const back = <button type="button" className="sops-back" onClick={() => navigate("/studio/orders")}><ArrowLeft aria-hidden="true" />{copy.backToOrders}</button>;

  if (status === "loading") return <div className="sops-page"><PageHead back={back} title={copy.ordersTitle} /><Loading copy={copy} /></div>;
  if (status === "error") {
    const missing = error?.status === 404;
    return <div className="sops-page"><PageHead back={back} title={orderId} />
      <ErrorCard error={missing ? { message: copy.orderNotFoundBody, request_id: error.request_id } : error} title={missing ? copy.orderNotFound : undefined} copy={copy} onRetry={missing ? undefined : reload} />
    </div>;
  }

  const shares = orderShares(order);
  const currency = order.currency;
  const placed = order.placed_at ?? order.created_at;
  const deliveries = Array.isArray(order.deliveries) ? order.deliveries : [];
  const timeline = Array.isArray(order.timeline) ? order.timeline : [];
  const refund = order.refund;
  const details = [
    [copy.detailAgent, orderProductName(order)],
    [copy.detailBuyer, order.buyer_display_name],
    [copy.detailPayment, <Pill key="p" value={order.payment_status} copy={copy} />],
    [copy.detailAccess, <Pill key="a" value={order.entitlement_status} copy={copy} />],
    order.delivery_status ? [copy.detailDelivery, <Pill key="d" value={order.delivery_status} copy={copy} />] : null,
    [copy.detailRefund, <Pill key="r" value={order.refund_status} copy={copy} />],
    order.access_mode ? [copy.detailMode, copy.mode[order.access_mode] ?? order.access_mode] : null,
    [copy.detailPlacedAt, formatDateTime(placed, locale)],
    [copy.detailOrderId, <span key="id" className="sops-break">{order.order_id}</span>]
  ].filter((row) => row && row[1]);

  return <div className="sops-page">
    <PageHead
      back={back}
      title={order.order_number}
      body={<span className="sops-head__meta"><Pill value={order.status} copy={copy} />{copy.orderPlaced(formatDateTime(placed, locale))}</span>}
      actions={order.actions?.can_request_refund
        ? <Button variant="secondary" size="compact" onClick={() => setRefundOpen(true)}>{copy.requestRefund}</Button>
        : null}
    />
    {notice ? <p className="sops-notice" role="status">{notice}</p> : null}

    <section className="sops-amounts">
      <div className="sops-card sops-amount"><span>{copy.amountGross}</span><strong>{formatMinor(order.total_minor ?? order.gross_minor, currency, locale)}</strong></div>
      <div className="sops-card sops-amount is-accent"><span>{copy.amountCreator}</span><strong>{shares.recognized ? formatMinor(shares.creator, currency, locale) : copy.sharePending}</strong></div>
      <div className="sops-card sops-amount"><span>{copy.amountHatch}</span><strong>{shares.recognized ? formatMinor(shares.hatch, currency, locale) : copy.sharePending}</strong></div>
    </section>
    {!shares.recognized && order.gross_minor > 0 ? <p className="sops-faint sops-note">{copy.amountPendingNote}</p> : null}

    <div className="sops-split">
      <div className="sops-stack">
        <section className="sops-card sops-section">
          <h2>{copy.detailsTitle}</h2>
          <dl className="sops-dl">{details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        </section>
        {refund ? <section className="sops-card sops-section">
          <h2>{copy.refundTitle}</h2>
          <dl className="sops-dl">
            {refund.gross_minor !== undefined ? <div><dt>{copy.colAmount}</dt><dd>{formatMinor(refund.gross_minor, currency, locale)}</dd></div> : null}
            {refund.reason ? <div><dt>{copy.refundReason}</dt><dd>{refund.reason}</dd></div> : null}
            {refund.occurred_at ? <div><dt>{copy.refundAt}</dt><dd>{formatDateTime(refund.occurred_at, locale)}</dd></div> : null}
          </dl>
        </section> : null}
        {order.access_mode !== "unmetered" ? <section className="sops-card sops-section">
          <h2>{copy.deliveriesTitle}</h2>
          {deliveries.length ? <ul className="sops-rows">
            {deliveries.map((delivery, index) => <li key={delivery.delivery_id ?? index}>
              <div><span className="sops-strong">{copy.deliveryItem(deliveries.length - index)}</span>{delivery.artifact_type ? <span className="sops-faint"> · {delivery.artifact_type}</span> : null}</div>
              <div className="sops-rows__meta">
                {delivery.revenue_status ? <Pill value={delivery.revenue_status} copy={copy} /> : null}
                <span className="sops-faint">{formatDateTime(delivery.completed_at, locale)}</span>
              </div>
            </li>)}
          </ul> : <p className="sops-faint">{copy.deliveriesEmpty}</p>}
        </section> : null}
      </div>
      <section className="sops-card sops-section">
        <h2>{copy.timelineTitle}</h2>
        {timeline.length ? <ol className="sops-timeline">
          {timeline.map((entry, index) => <li key={entry.event_id ?? index}>
            <span className="sops-strong">{eventLabel(copy, entry.type)}</span>
            <span className="sops-faint">{formatDateTime(entry.occurred_at, locale)}</span>
          </li>)}
        </ol> : <p className="sops-faint">{copy.timelineEmpty}</p>}
      </section>
    </div>

    <ReasonDialog
      open={refundOpen}
      onOpenChange={setRefundOpen}
      title={copy.refundDialogTitle}
      body={copy.refundDialogBody}
      label={copy.refundReasonLabel}
      hint={copy.refundReasonHint}
      placeholder={copy.refundReasonPlaceholder}
      submitLabel={copy.refundSubmit}
      onSubmit={submitRefund}
      copy={copy}
      destructive
    />
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

