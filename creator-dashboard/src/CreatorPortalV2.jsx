import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CreatorFactoryRuns } from "./CreatorFactoryRuns.jsx";
import { StorefrontDetails } from "./StorefrontDetails.jsx";
import { creatorOrderQuery, payoutActionLabel, payoutCanRetry } from "./storefrontModel.js";
import { creatorRouteTitle, parseCreatorRoute } from "./creatorRoutes.js";
import "./creatorPortalV2.css";

const ROOT = "/portal/creator";
const PRODUCT_TABS = [
  ["overview", "Overview"],
  ["test", "Test & improve"],
  ["examples", "Examples"],
  ["versions", "Versions"],
  ["data-controls", "Data controls"]
];

export function CreatorPortalV2({
  pathname = typeof window === "undefined" ? ROOT : window.location.pathname,
  navigate = defaultNavigate,
  token,
  request,
  profile,
  onLogout
}) {
  const route = useMemo(() => parseCreatorRoute(pathname), [pathname]);
  const mainRef = useRef(null);
  const navigationGuardRef = useRef(null);
  const registerNavigationGuard = useCallback((guard) => {
    navigationGuardRef.current = guard;
    return () => {
      if (navigationGuardRef.current === guard) navigationGuardRef.current = null;
    };
  }, []);
  const go = useCallback(async (nextPath) => {
    const guard = navigationGuardRef.current;
    if (guard && await guard() === false) return;
    navigate(nextPath);
  }, [navigate]);

  useEffect(() => {
    const heading = mainRef.current?.querySelector("h1");
    if (!heading) return;
    heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
  }, [pathname]);

  useEffect(() => {
    if (typeof document !== "undefined") document.title = `${creatorRouteTitle(route)} · Hatch`;
  }, [route]);

  return (
    <div className="cpv2">
      <a className="cpv2-skip" href="#creator-main">Skip to content</a>
      <aside className="cpv2-sidebar">
        <button className="cpv2-brand" type="button" onClick={() => go(ROOT)} aria-label="Hatch creator home">
          <span aria-hidden="true">◒</span> Hatch.
        </button>
        <nav aria-label="Creator dashboard">
          <NavButton active={route.section === "home"} onClick={() => go(ROOT)}>Home</NavButton>
          <NavButton active={route.section === "products"} onClick={() => go(`${ROOT}/products`)}>Products</NavButton>
          <NavButton active={route.section === "orders"} onClick={() => go(`${ROOT}/orders`)}>Orders</NavButton>
          <NavButton active={route.section === "payouts"} onClick={() => go(`${ROOT}/payouts`)}>Payouts</NavButton>
        </nav>
        <div className="cpv2-account">
          <span className="cpv2-avatar" aria-hidden="true">{profile?.initials || initials(profile?.display_name)}</span>
          <span><strong>{profile?.display_name || "Creator"}</strong><small>{profile?.handle || "Creator account"}</small></span>
          {onLogout ? <button type="button" onClick={onLogout}>Sign out</button> : null}
        </div>
      </aside>
      <main id="creator-main" className="cpv2-main" ref={mainRef}>
        <CreatorRoute route={route} token={token} request={request} navigate={go} profile={profile} registerNavigationGuard={registerNavigationGuard} />
      </main>
    </div>
  );
}

function NavButton({ active, children, onClick }) {
  return <button type="button" className={active ? "is-active" : ""} aria-current={active ? "page" : undefined} onClick={onClick}>{children}</button>;
}

function CreatorRoute({ route, token, request, navigate, profile, registerNavigationGuard }) {
  if (typeof request !== "function") {
    return <RouteProblem title="Creator portal is unavailable" body="A request function is required to load this workspace." />;
  }
  if (route.kind === "home") return <CreatorHome token={token} request={request} navigate={navigate} profile={profile} />;
  if (route.kind === "products") return <ProductsPage token={token} request={request} navigate={navigate} />;
  if (route.kind === "factory") return <FactoryPage token={token} request={request} productId={route.productId} runId={route.runId} navigate={navigate} registerNavigationGuard={registerNavigationGuard} />;
  if (route.kind === "product") return <ProductPage token={token} request={request} navigate={navigate} productId={route.productId} tab={route.tab} />;
  if (route.kind === "candidate") return <CandidatePage token={token} request={request} navigate={navigate} productId={route.productId} candidateId={route.candidateId} />;
  if (route.kind === "offer") return <OfferPage token={token} request={request} navigate={navigate} productId={route.productId} />;
  if (route.kind === "preview") return <PreviewPage token={token} request={request} navigate={navigate} productId={route.productId} />;
  if (route.kind === "release") return <ReleasePage token={token} request={request} navigate={navigate} productId={route.productId} releaseId={route.releaseId} />;
  if (route.kind === "orders") return <OrdersPage token={token} request={request} navigate={navigate} />;
  if (route.kind === "order") return <OrderPage token={token} request={request} navigate={navigate} orderId={route.orderId} />;
  if (route.kind === "payouts") return <PayoutsPage token={token} request={request} navigate={navigate} settings={false} />;
  if (route.kind === "payout-settings") return <PayoutsPage token={token} request={request} navigate={navigate} settings />;
  if (route.kind === "payout") return <PayoutDetailPage token={token} request={request} navigate={navigate} payoutId={route.payoutId} />;
  return <RouteProblem title="Page not found" body="This Creator page does not exist or has moved." action="Back to products" onAction={() => navigate(`${ROOT}/products`)} />;
}

function CreatorHome({ token, request, navigate, profile }) {
  const resource = useRemote(request, "/v1/creator/overview", token);
  return (
    <PageBoundary resource={resource} title="We couldn't open your workspace">
      {(payload) => {
        const overview = unwrap(payload, "overview");
        const products = arrayOf(overview?.products);
        const orders = arrayOf(overview?.recent_orders ?? overview?.orders);
        const next = nextCreatorAction(products);
        const metrics = overview?.metrics ?? {};
        return <>
          <PageHeader eyebrow="Creator home" title={`${firstName(profile?.display_name)}, here’s the next useful step.`} body="Move one approved method from Factory to a shareable product, then follow every order through delivery and payout." />
          <section className="cpv2-grid cpv2-home-grid" aria-label="Creator overview">
            <article className="cpv2-card cpv2-next-card">
              <StatusChip status={next.tone}>{next.label}</StatusChip>
              <h2>{next.title}</h2>
              <p>{next.body}</p>
              <button className="cpv2-primary" type="button" onClick={() => navigate(next.href)}>{next.action} <span aria-hidden="true">→</span></button>
            </article>
            <article className="cpv2-card cpv2-balance-card">
              <span className="cpv2-kicker">Delivery revenue</span>
              <strong>{money(metrics.creator_share_minor ?? metrics.recognized_minor ?? 0, metrics.currency)}</strong>
              <p>Recognized after completed deliveries. Payout availability is tracked separately.</p>
              <dl><div><dt>Products</dt><dd>{products.length}</dd></div><div><dt>Orders</dt><dd>{metrics.order_count ?? orders.length}</dd></div></dl>
              <button className="cpv2-secondary cpv2-inverse" type="button" onClick={() => navigate(`${ROOT}/payouts`)}>View payouts</button>
            </article>
          </section>
          <SectionHeading eyebrow="Recent activity" title="Orders and delivery" action="View all orders" onAction={() => navigate(`${ROOT}/orders`)} />
          {orders.length ? <OrderList orders={orders} onOpen={(order) => navigate(`${ROOT}/orders/${encodeURIComponent(idOf(order, "order"))}`)} /> : <EmptyState title="No orders yet" body="Orders appear here after a Buyer claims or purchases a live product." />}
        </>;
      }}
    </PageBoundary>
  );
}

function ProductsPage({ token, request, navigate }) {
  const resource = useRemote(request, "/v1/creator/products", token);
  const runsResource = useRemote(request, "/v1/creator/factory-runs", token);
  const pendingRuns = useMemo(() => runsResource.state === "ready"
    ? arrayOf(unwrap(runsResource.data, "runs")).filter((run) => ["queued", "running", "waiting_for_creator", "awaiting_answers", "needs_attention"].includes(run.status))
    : [], [runsResource.state, runsResource.data]);
  useEffect(() => {
    if (!pendingRuns.some((run) => ["queued", "running"].includes(run.status))) return undefined;
    const timer = setInterval(() => {
      runsResource.retry();
      resource.retry();
    }, 5000);
    return () => clearInterval(timer);
  }, [pendingRuns, runsResource.retry, resource.retry]);
  return (
    <PageBoundary resource={resource} title="We couldn't load your products">
      {(payload) => {
        const products = arrayOf(unwrap(payload, "products"));
        return <>
          <PageHeader eyebrow="Products" title="From a method to a product people can use." body="Factory creates a candidate. You approve its behavior, define the offer, preview the storefront, and publish explicitly." action="Create product" onAction={() => navigate(`${ROOT}/products/new/factory`)} />
          {pendingRuns.length ? <PendingFactoryRuns runs={pendingRuns} navigate={navigate} /> : null}
          {products.length ? <section className="cpv2-product-grid" aria-label="Products">
            {products.map((product) => <ProductCard key={idOf(product, "product")} product={product} onOpen={() => navigate(`${ROOT}/products/${encodeURIComponent(idOf(product, "product"))}`)} />)}
          </section> : pendingRuns.length ? null : <EmptyState title="Create your first product" body="Start with one narrow task, authorized sources, and a deliverable you would stand behind." action="Open Factory" onAction={() => navigate(`${ROOT}/products/new/factory`)} />}
        </>;
      }}
    </PageBoundary>
  );
}

function PendingFactoryRuns({ runs, navigate }) {
  return <section className="cpv2-card cpv2-panel" aria-label="Factory runs in progress">
    <SectionHeading eyebrow="Factory in progress" title="Your draft is safely on the server." />
    <div className="cpv2-product-grid">{runs.map((run) => <article className="cpv2-card cpv2-product-card" key={run.id}>
      <div className="cpv2-card-top"><StatusChip status={run.status}>{productStatus(run.status)}</StatusChip><span>Candidate pending</span></div>
      <h2>{run.task_name ?? "Untitled Factory run"}</h2>
      <p>{["waiting_for_creator", "awaiting_answers"].includes(run.status) ? "Answer the pending Factory questions to continue." : run.status === "needs_attention" ? "Review the failed checkpoint and retry when it is safe." : "Distillation is running. Candidate review will appear as soon as the verified Corpus is ready."}</p>
      <div className="cpv2-card-foot"><small>{run.updated_at ? `Updated ${dateTime(run.updated_at)}` : "Saved on server"}</small><button className="cpv2-secondary" type="button" onClick={() => navigate(`${ROOT}/factory/runs/${encodeURIComponent(run.id)}`)}>Open Factory</button></div>
    </article>)}</div>
  </section>;
}

function ProductCard({ product, onOpen }) {
  const offer = offerOf(product);
  return <article className="cpv2-card cpv2-product-card">
    <div className="cpv2-card-top"><StatusChip status={product.status}>{productStatus(product.status)}</StatusChip><span>{offer ? offerLabel(offer) : "No offer"}</span></div>
    <h2>{product.name ?? product.product_name ?? "Untitled product"}</h2>
    <p>{product.promise ?? product.description ?? "Add a clear Buyer-facing promise."}</p>
    <div className="cpv2-card-foot"><small>{shortDigest(product.corpus_digest ?? product.active_release?.corpus_digest)}</small><button className="cpv2-secondary" type="button" onClick={onOpen}>Open product</button></div>
  </article>;
}

function ProductPage({ token, request, navigate, productId, tab }) {
  const resource = useRemote(request, `/v1/creator/products/${encodeURIComponent(productId)}`, token);
  return (
    <PageBoundary resource={resource} title="We couldn't load this product">
      {(payload) => {
        const product = unwrap(payload, "product") ?? payload;
        const candidate = candidateOf(product);
        const offer = offerOf(product);
        const next = productNextAction(product, candidate, offer);
        return <>
          <Breadcrumb onClick={() => navigate(`${ROOT}/products`)}>Products</Breadcrumb>
          <PageHeader eyebrow={productStatus(product.status)} title={product.name ?? product.product_name ?? "Untitled product"} body={product.promise ?? product.description ?? "Define the product promise and boundaries before publishing."} action={next.action} onAction={() => navigate(next.href(productId, candidate))} />
          <ProductTabs productId={productId} active={tab} navigate={navigate} />
          {tab === "overview" ? <ProductOverview product={product} candidate={candidate} offer={offer} navigate={navigate} token={token} request={request} onChanged={resource.retry} /> : null}
          {tab === "test" ? <TestPanel product={product} candidate={candidate} navigate={navigate} /> : null}
          {tab === "examples" ? <ExamplesPanel product={product} /> : null}
          {tab === "versions" ? <VersionsPanel product={product} candidate={candidate} productId={productId} navigate={navigate} /> : null}
          {tab === "data-controls" ? <DataControlsPanel product={product} /> : null}
        </>;
      }}
    </PageBoundary>
  );
}

function ProductTabs({ productId, active, navigate }) {
  return <nav className="cpv2-tabs" aria-label="Product sections">
    {PRODUCT_TABS.map(([slug, label]) => <button key={slug} type="button" className={active === slug ? "is-active" : ""} aria-current={active === slug ? "page" : undefined} onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}/${slug}`)}>{label}</button>)}
  </nav>;
}

function ProductOverview({ product, candidate, offer, navigate, token, request, onChanged }) {
  const productId = idOf(product, "product");
  const alreadyPublished = product.status === "published" || product.status === "live";
  const [withdraw, setWithdraw] = useState({ reason: "", confirming: false, busy: false, error: "", done: false });
  const steps = [
    { label: "Factory candidate", done: Boolean(candidate || alreadyPublished || product.corpus_digest), action: "Open Factory", href: `${ROOT}/products/${encodeURIComponent(productId)}/factory` },
    { label: "Candidate approval", done: isApproved(candidate) || alreadyPublished, action: "Review candidate", href: candidate ? `${ROOT}/products/${encodeURIComponent(productId)}/candidates/${encodeURIComponent(idOf(candidate, "candidate"))}` : null },
    { label: "Offer and pricing", done: Boolean(offer), action: "Set offer", href: `${ROOT}/products/${encodeURIComponent(productId)}/offer` },
    { label: "Storefront preview", done: Boolean(product.previewed_at || product.preview_ready), action: "Preview", href: `${ROOT}/products/${encodeURIComponent(productId)}/preview` },
    { label: "Published", done: product.status === "published" || product.status === "live", action: "View storefront", href: product.public_url, external: true }
  ];
  async function withdrawProduct() {
    if (!withdraw.reason.trim() || withdraw.busy) return;
    setWithdraw((current) => ({ ...current, busy: true, error: "", done: false }));
    try {
      await request(`/v1/creator/products/${encodeURIComponent(productId)}/withdraw`, { method: "POST", token, headers: { "idempotency-key": mutationKey() }, body: JSON.stringify({ reason: withdraw.reason.trim() }) });
      setWithdraw((current) => ({ ...current, busy: false, error: "", done: true, confirming: false }));
      onChanged?.();
    } catch (error) { setWithdraw((current) => ({ ...current, busy: false, error: friendlyError(error), done: false })); }
  }
  return <><div className="cpv2-detail-grid">
    <article className="cpv2-card cpv2-workflow">
      <span className="cpv2-kicker">Publishing workflow</span><h2>One deliberate gate at a time.</h2>
      <ol>{steps.map((step, index) => <li key={step.label} className={step.done ? "is-done" : ""}><span>{step.done ? "✓" : index + 1}</span><strong>{step.label}</strong>{step.href ? step.external ? <a href={safePublicUrl(step.href)} target="_blank" rel="noreferrer">{step.action}</a> : <button type="button" onClick={() => navigate(step.href)}>{step.action}</button> : <small>Complete the previous step</small>}</li>)}</ol>
    </article>
    <article className="cpv2-card cpv2-facts"><span className="cpv2-kicker">Current contract</span><dl><Fact label="Candidate" value={candidate ? `v${candidate.version ?? "—"} · ${approvalLabel(candidate)}` : "Not ready"} /><Fact label="Offer" value={offer ? offerLabel(offer) : "Not configured"} /><Fact label="Release" value={product.active_release?.label ?? product.release?.label ?? product.release_label ?? "Not published"} /><Fact label="Public URL" value={product.public_url ?? "Not public"} /></dl></article>
  </div>{withdraw.error ? <InlineError>{withdraw.error}</InlineError> : null}{withdraw.done ? <SuccessNotice>The storefront was withdrawn. Existing receipts and entitlements remain available to their Buyers.</SuccessNotice> : null}{alreadyPublished ? <article className="cpv2-card cpv2-panel cpv2-withdraw"><SectionHeading eyebrow="Storefront lifecycle" title="Withdraw this product" /><p>Withdrawal stops new checkout. It does not erase immutable releases, orders, receipts, or existing access.</p><label>Audit reason<textarea value={withdraw.reason} onChange={(event) => setWithdraw((current) => ({ ...current, reason: event.target.value, confirming: false }))} placeholder="Why should new checkout stop?" /></label>{withdraw.confirming ? <div className="cpv2-confirm"><p><strong>Withdraw the public storefront?</strong><br />Buyers with historical orders keep their records.</p><button className="cpv2-secondary" type="button" onClick={() => setWithdraw((current) => ({ ...current, confirming: false }))}>Cancel</button><button className="cpv2-danger" type="button" disabled={withdraw.busy || !withdraw.reason.trim()} onClick={withdrawProduct}>{withdraw.busy ? "Withdrawing…" : "Confirm withdrawal"}</button></div> : <button className="cpv2-danger" type="button" disabled={!withdraw.reason.trim()} onClick={() => setWithdraw((current) => ({ ...current, confirming: true }))}>Review withdrawal</button>}</article> : null}</>;
}

function TestPanel({ product, candidate, navigate }) {
  const gates = arrayOf(candidate?.gates ?? product.evaluation?.gates);
  return <article className="cpv2-card cpv2-panel"><SectionHeading eyebrow="Evaluation" title="Behavior evidence" />{gates.length ? <ul className="cpv2-gates">{gates.map((gate, index) => <li key={gate.id ?? index}><StatusChip status={gate.passed === false ? "failed" : "passed"}>{gate.passed === false ? "Failed" : "Passed"}</StatusChip><span><strong>{gate.name ?? gate.label ?? `Gate ${index + 1}`}</strong><small>{gate.detail ?? gate.message ?? "Deterministic evaluation gate"}</small></span></li>)}</ul> : <EmptyInline>No evaluation report is available yet.</EmptyInline>}{candidate ? <button className="cpv2-secondary" type="button" onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(idOf(product, "product"))}/candidates/${encodeURIComponent(idOf(candidate, "candidate"))}`)}>Open candidate report</button> : null}</article>;
}

function ExamplesPanel({ product }) {
  const examples = arrayOf(product.examples ?? product.presentation?.examples);
  return <article className="cpv2-card cpv2-panel"><SectionHeading eyebrow="Buyer proof" title="Representative examples" />{examples.length ? <div className="cpv2-examples">{examples.map((example, index) => <section key={example.id ?? index}><h3>{example.title ?? `Example ${index + 1}`}</h3><p>{example.summary ?? example.description ?? String(example)}</p></section>)}</div> : <EmptyInline>Add client-safe examples before publishing. Protected instructions never appear here.</EmptyInline>}</article>;
}

function VersionsPanel({ product, candidate, productId, navigate }) {
  const releases = arrayOf(product.releases).length ? arrayOf(product.releases) : (product.release ? [{ ...product.release, current: true }] : []);
  return <article className="cpv2-card cpv2-panel"><SectionHeading eyebrow="Immutable history" title="Candidates and releases" />{candidate ? <button className="cpv2-version" type="button" onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}/candidates/${encodeURIComponent(idOf(candidate, "candidate"))}`)}><span><strong>Candidate v{candidate.version ?? "—"}</strong><small>{shortDigest(candidate.digest)}</small></span><StatusChip status={candidate.status}>{approvalLabel(candidate)}</StatusChip></button> : null}{releases.map((release) => <button className="cpv2-version" type="button" key={idOf(release, "release")} onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}/releases/${encodeURIComponent(idOf(release, "release"))}`)}><span><strong>{release.label ?? `Release ${release.version ?? ""}`}</strong><small>{shortDigest(release.corpus_digest ?? release.digest)}</small></span><StatusChip status={release.current ? "published" : "retired"}>{release.current ? "Current" : "Previous"}</StatusChip></button>)}{!candidate && !releases.length ? <EmptyInline>No candidate or release exists yet.</EmptyInline> : null}</article>;
}

function DataControlsPanel({ product }) {
  const boundaries = arrayOf(product.boundaries ?? product.product_boundaries);
  return <div className="cpv2-detail-grid"><article className="cpv2-card cpv2-panel"><SectionHeading eyebrow="Product boundaries" title="What this product will not do" />{boundaries.length ? <ul className="cpv2-bullets">{boundaries.map((item, index) => <li key={index}>{typeof item === "string" ? item : item.label ?? item.description}</li>)}</ul> : <EmptyInline>Add explicit boundaries before publishing.</EmptyInline>}</article><article className="cpv2-card cpv2-panel"><SectionHeading eyebrow="Privacy" title="Buyer work stays private" /><p>Creator commerce views receive order and delivery metadata only—not Workspace paths, conversations, tool arguments, file content, or artifacts.</p><dl><Fact label="Corpus digest" value={shortDigest(product.corpus_digest ?? product.active_release?.corpus_digest)} /><Fact label="Version policy" value={product.version_policy ?? "Pinned to purchased release"} /></dl></article></div>;
}

function FactoryPage({ token, request, productId, runId, navigate, registerNavigationGuard }) {
  const runBase = productId
    ? `${ROOT}/products/${encodeURIComponent(productId)}/factory/runs`
    : `${ROOT}/factory/runs`;
  if (productId === undefined) return <>
    <div className="cpv2-factory-bar"><button type="button" onClick={() => navigate(`${ROOT}/products`)}>← Back to products</button><span role="status">Open a saved run to continue questions, retry a checkpoint, or inspect progress.</span></div>
    <CreatorFactoryRuns
      token={token}
      initialRunId={runId}
      onNavigateRun={(id) => navigate(id ? `${runBase}/${encodeURIComponent(id)}` : `${ROOT}/factory`)}
      onReviewCandidate={(run) => {
        const candidateProductId = run?.product?.product_id ?? run?.product?.id ?? run?.product_id;
        if (candidateProductId) {
          navigate(`${ROOT}/products/${encodeURIComponent(candidateProductId)}/candidates/${encodeURIComponent(run.id)}`);
        }
      }}
    />
  </>;
  if (!productId) return <FactoryDraftPage token={token} request={request} navigate={navigate} registerNavigationGuard={registerNavigationGuard} />;
  return <>
    <div className="cpv2-factory-bar"><button type="button" onClick={() => navigate(productId ? `${ROOT}/products/${encodeURIComponent(productId)}` : `${ROOT}/products`)}>← {productId ? "Back to product" : "Back to products"}</button><span role="status">Factory run checkpoints are saved on the server when submitted.</span></div>
    <FactoryReviewLink token={token} request={request} productId={productId} navigate={navigate} />
    <CreatorFactoryRuns token={token} initialRunId={runId} onNavigateRun={(id) => navigate(id ? `${runBase}/${encodeURIComponent(id)}` : `${ROOT}/products/${encodeURIComponent(productId)}/factory`)} onReviewCandidate={(run) => navigate(`${ROOT}/products/${encodeURIComponent(productId)}/candidates/${encodeURIComponent(run.id)}`)} />
  </>;
}

function FactoryReviewLink({ token, request, productId, navigate }) {
  const resource = useRemote(request, `/v1/creator/products/${encodeURIComponent(productId)}`, token);
  const product = resource.data ? (unwrap(resource.data, "product") ?? resource.data) : null;
  const candidate = candidateOf(product);
  const reviewReady = Boolean(candidate && !isApproved(candidate) && ["ready", "ready_for_review", "review_ready"].includes(candidate.status));
  useEffect(() => {
    if (resource.state !== "ready" || reviewReady) return undefined;
    const timer = setInterval(resource.retry, 5000);
    return () => clearInterval(timer);
  }, [resource.state, reviewReady]);
  if (resource.state === "loading" || resource.state === "error") return null;
  if (!reviewReady) return <aside className="cpv2-factory-ready is-waiting" role="status"><div><strong>Factory is tracking this product.</strong><small>The review action appears as soon as a verified candidate is ready.</small></div><button className="cpv2-secondary" type="button" onClick={resource.retry}>Refresh status</button></aside>;
  return <aside className="cpv2-factory-ready" role="status"><div><strong>Candidate v{candidate.version ?? "—"} is ready for review.</strong><small>{shortDigest(candidate.digest)}</small></div><button className="cpv2-primary" type="button" onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}/candidates/${encodeURIComponent(idOf(candidate, "candidate"))}`)}>Review candidate</button><button className="cpv2-secondary" type="button" onClick={resource.retry}>Refresh status</button></aside>;
}

function FactoryDraftPage({ token, request, navigate, registerNavigationGuard }) {
  const resource = useRemote(request, "/v1/creator/factory-drafts/default", token);
  return <PageBoundary resource={resource} title="We couldn't load your Factory draft">{(payload) => <FactoryDraftForm initial={unwrap(payload, "draft") ?? payload} token={token} request={request} navigate={navigate} registerNavigationGuard={registerNavigationGuard} />}</PageBoundary>;
}

function FactoryDraftForm({ initial, token, request, navigate, registerNavigationGuard }) {
  const [draft, setDraft] = useState(() => ({ task_name: initial?.task_name ?? "", task_brief: initial?.task_brief ?? "", sources: arrayOf(initial?.sources).length ? initial.sources : [{ id: "S1", title: "", authority: "private_material", content: "" }] }));
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState(initial?.saved_at ? `Saved ${dateTime(initial.saved_at)}` : "Start typing to autosave");
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const versionRef = useRef(initial?.version ?? 0);
  const changeRef = useRef(0);
  const savedChangeRef = useRef(0);
  const writeChainRef = useRef(Promise.resolve());
  const draftRef = useRef(draft);
  const dirtyRef = useRef(false);

  const changeDraft = useCallback((update) => {
    setDraft((current) => {
      const next = typeof update === "function" ? update(current) : { ...current, ...update };
      draftRef.current = next;
      return next;
    });
    changeRef.current += 1;
    dirtyRef.current = true;
    setDirty(true);
    setSaveState("Unsaved changes");
  }, []);

  const persist = useCallback((snapshot) => {
    const change = changeRef.current;
    if (savedChangeRef.current >= change) return writeChainRef.current;
    setSaveState("Saving…");
    setError("");
    const operation = writeChainRef.current.catch(() => undefined).then(async () => {
      if (savedChangeRef.current >= change) return undefined;
      const result = await request("/v1/creator/factory-drafts/default", { method: "PUT", token, headers: { "idempotency-key": mutationKey() }, body: JSON.stringify({ ...snapshot, expected_version: versionRef.current }) });
      const saved = unwrap(result, "draft") ?? result;
      versionRef.current = saved.version ?? versionRef.current + 1;
      savedChangeRef.current = change;
      if (changeRef.current === change) { dirtyRef.current = false; setDirty(false); setSaveState(`Saved ${dateTime(saved.saved_at ?? new Date())}`); }
      return saved;
    }).catch((nextError) => { setSaveState("Couldn't save"); setError(friendlyError(nextError)); throw nextError; });
    writeChainRef.current = operation;
    return operation;
  }, [request, token]);

  useEffect(() => {
    if (!dirty) return undefined;
    const timer = setTimeout(() => { persist(draft).catch(() => undefined); }, 900);
    return () => clearTimeout(timer);
  }, [dirty, draft, persist]);

  useEffect(() => {
    if (typeof registerNavigationGuard !== "function") return undefined;
    return registerNavigationGuard(async () => {
      if (!dirtyRef.current) return true;
      try {
        await persist(draftRef.current);
        return !dirtyRef.current;
      } catch {
        setError("We couldn't save these changes, so Hatch kept you on this page. Retry the save before leaving.");
        return false;
      }
    });
  }, [persist, registerNavigationGuard]);

  useEffect(() => {
    const protectUnsaved = (event) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectUnsaved);
    return () => window.removeEventListener("beforeunload", protectUnsaved);
  }, []);

  function updateSource(index, field, value) {
    changeDraft((current) => ({ ...current, sources: current.sources.map((source, sourceIndex) => sourceIndex === index ? { ...source, [field]: value } : source) }));
  }

  async function start(event) {
    event.preventDefault();
    setStarting(true); setError("");
    try {
      await persist(draft);
      const run = await request("/v1/creator/factory-drafts/default/start", {
        method: "POST",
        token,
        headers: { "idempotency-key": mutationKey() },
        body: JSON.stringify({ expected_version: versionRef.current })
      });
      const created = unwrap(run, "run") ?? run;
      const runId = idOf(created, "run");
      navigate(runId ? `${ROOT}/factory/runs/${encodeURIComponent(runId)}` : `${ROOT}/factory`);
    } catch (nextError) { setError(friendlyError(nextError)); }
    finally { setStarting(false); }
  }

  return <>
    <Breadcrumb onClick={() => navigate(`${ROOT}/products`)}>Products</Breadcrumb>
    <PageHeader eyebrow="Creator Factory" title="Define one task worth delivering." body="This server draft autosaves after a short pause. Starting distillation remains an explicit action." />
    {error ? <InlineError>{error}</InlineError> : null}
    <form className="cpv2-card cpv2-factory-draft" onSubmit={start} onBlur={() => { if (dirty) persist(draft).catch(() => undefined); }}>
      <div className="cpv2-save-state" aria-live="polite"><span className={dirty ? "is-dirty" : ""} />{saveState}</div>
      <label>Task name<input required value={draft.task_name} onChange={(event) => changeDraft({ task_name: event.target.value })} placeholder="e.g. Signal Resume Review" /></label>
      <label>Task promise<textarea required value={draft.task_brief} onChange={(event) => changeDraft({ task_brief: event.target.value })} placeholder="What does the Buyer provide, and what finished result do they receive?" /></label>
      <div className="cpv2-source-heading"><div><span className="cpv2-kicker">Authorized sources</span><h2>Source material</h2></div><button type="button" onClick={() => changeDraft((current) => ({ ...current, sources: [...current.sources, { id: `S${current.sources.length + 1}`, title: "", authority: "private_material", content: "" }] }))}>+ Add source</button></div>
      {draft.sources.map((source, index) => <fieldset className="cpv2-source" key={source.id ?? index}><legend>{source.id ?? `S${index + 1}`}</legend>{draft.sources.length > 1 ? <button type="button" onClick={() => changeDraft((current) => ({ ...current, sources: current.sources.filter((_, sourceIndex) => sourceIndex !== index).map((item, sourceIndex) => ({ ...item, id: `S${sourceIndex + 1}` })) }))}>Remove</button> : null}<label>Source title<input required value={source.title ?? ""} onChange={(event) => updateSource(index, "title", event.target.value)} /></label><label>Authority<select value={source.authority ?? "private_material"} onChange={(event) => updateSource(index, "authority", event.target.value)}><option value="creator_current">Current correction or demonstration</option><option value="creator_example">Canonical example</option><option value="private_material">Private course or document</option><option value="public_context">Public context</option></select></label><label>Source content<textarea required value={source.content ?? ""} onChange={(event) => updateSource(index, "content", event.target.value)} /></label></fieldset>)}
      <div className="cpv2-draft-actions"><p>Private source text is stored only in the authenticated server draft; this page does not put it in localStorage.</p><button className="cpv2-primary" type="submit" disabled={starting} aria-busy={starting}>{starting ? "Starting…" : "Start distillation"}</button></div>
    </form>
  </>;
}

function CandidatePage({ token, request, navigate, productId, candidateId }) {
  const resource = useRemote(request, `/v1/creator/products/${encodeURIComponent(productId)}/candidates/${encodeURIComponent(candidateId)}`, token);
  const productResource = useRemote(request, `/v1/creator/products/${encodeURIComponent(productId)}`, token);
  const [acknowledged, setAcknowledged] = useState([]);
  const [mutation, setMutation] = useState({ state: "idle", error: "" });
  const [confirmReject, setConfirmReject] = useState(false);

  async function decide(action, candidate, expectedVersion) {
    setMutation({ state: action, error: "" });
    try {
      await request(`/v1/creator/products/${encodeURIComponent(productId)}/candidates/${encodeURIComponent(candidateId)}/${action}`, {
        method: "POST", token, headers: { "idempotency-key": mutationKey() },
        body: JSON.stringify({
          expected_version: expectedVersion,
          ...(action === "approve" ? {
            report_digest: candidate?.report_digest,
            acknowledgements: acknowledged
          } : {})
        })
      });
      navigate(action === "approve" ? `${ROOT}/products/${encodeURIComponent(productId)}/offer` : `${ROOT}/products/${encodeURIComponent(productId)}/versions`);
    } catch (error) {
      setMutation({ state: "idle", error: friendlyError(error) });
    }
  }

  if (productResource.state === "loading") return <LoadingState />;
  if (productResource.state === "error") return <RouteProblem title="We couldn't load this product" body={friendlyError(productResource.error)} action="Retry" onAction={productResource.retry} />;
  return <PageBoundary resource={resource} title="We couldn't load this candidate">{(payload) => {
    const raw = unwrap(payload, "candidate") ?? payload;
    const candidate = raw?.candidate ? { ...raw, ...raw.candidate, run_status: raw.status } : raw;
    const product = unwrap(productResource.data, "product") ?? productResource.data;
    const gates = arrayOf(candidate?.gates ?? candidate?.critical_gates ?? candidate?.evaluation?.gates);
    const losses = arrayOf(candidate?.non_critical_losses ?? candidate?.known_losses);
    const changes = arrayOf(candidate?.material_changes);
    const boundaries = arrayOf(candidate?.product_boundaries ?? candidate?.boundaries);
    const comparisons = arrayOf(candidate?.blinded_comparison ?? candidate?.comparisons ?? candidate?.behavior_comparison);
    const criticalFailed = candidate?.corpus_verified === false || candidate?.critical_gates_passed === false || gates.some((gate) => (gate?.critical || gate?.severity === "critical" || candidate?.critical_gates === gates) && gate?.passed === false);
    const allAcknowledged = losses.every((loss, index) => acknowledged.includes(loss?.id ?? String(index)));
    const alreadyApproved = product?.approval?.status === "approved"
      && product.approval.candidate_id === candidateId
      && product.approval.candidate_digest === candidate?.digest
      && product.approval.report_digest === candidate?.report_digest;
    const expectedVersion = product?.resource_version ?? product?.version ?? 0;
    const busy = mutation.state !== "idle";
    return <>
      <Breadcrumb onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}/versions`)}>Versions</Breadcrumb>
      <PageHeader eyebrow="Candidate review" title={`Candidate v${candidate?.version ?? "—"}`} body="Approval binds this exact Corpus digest and evaluation report. It does not publish the product." />
      {mutation.error ? <InlineError>{mutation.error}</InlineError> : null}
      <div className="cpv2-detail-grid cpv2-review-grid">
        <article className="cpv2-card cpv2-panel"><SectionHeading eyebrow="Provenance" title="What was evaluated" /><dl className="cpv2-fact-grid"><Fact label="Candidate digest" value={candidate?.digest ?? "Not provided"} /><Fact label="Base release" value={candidate?.base_release?.label ?? candidate?.base_release_id ?? "Not provided"} /><Fact label="Dataset / eval set" value={candidate?.eval_set?.name ?? candidate?.eval_set_id ?? candidate?.dataset_id ?? "Not provided"} /><Fact label="Regression digest" value={candidate?.regression_digest ?? candidate?.eval_set?.digest ?? "Not provided"} /><Fact label="Held-out digest" value={candidate?.held_out_digest ?? "Not provided"} /><Fact label="Held-out samples" value={candidate?.held_out_sample_count ?? candidate?.evaluation?.sample_count ?? "Not provided"} /><Fact label="Critical gates" value={candidate?.critical_case_count ?? candidate?.evaluation?.critical_case_count ?? gates.filter((gate) => gate?.critical || gate?.severity === "critical").length} /><Fact label="Failed critical cases" value={candidate?.failed_critical_cases ?? "Not provided"} /><Fact label="Built" value={candidate?.built_at || candidate?.created_at ? dateTime(candidate?.built_at ?? candidate?.created_at) : "Not provided"} /><Fact label="Factory version" value={candidate?.factory_version ?? "Not provided"} /><Fact label="Provider / model" value={candidate?.provider_model ?? ([candidate?.provider, candidate?.model].filter(Boolean).join(" / ") || "Not provided")} /><Fact label="Report digest" value={candidate?.report_digest ?? candidate?.evaluation_digest ?? "Not provided"} /></dl></article>
        <article className="cpv2-card cpv2-panel"><SectionHeading eyebrow="Decision" title={criticalFailed ? "Critical gates block approval" : "Candidate can be approved"} /><p>{criticalFailed ? "Resolve every failed critical case in a new Factory candidate." : losses.length ? "Acknowledge each known non-critical loss before approval." : "All required gates passed. Approval remains separate from publishing."}</p><StatusChip status={criticalFailed ? "failed" : "passed"}>{criticalFailed ? "Blocked" : "Ready for decision"}</StatusChip></article>
      </div>
      <article className="cpv2-card cpv2-panel cpv2-review-report"><SectionHeading eyebrow="Deterministic gates" title="Evaluation report" />{gates.length ? <ul className="cpv2-gates">{gates.map((gate, index) => <li key={gate.id ?? index}><StatusChip status={gate.passed === false ? "failed" : "passed"}>{gate.passed === false ? "Failed" : "Passed"}</StatusChip><span><strong>{gate.name ?? gate.label ?? `Gate ${index + 1}`}</strong><small>{gate.detail ?? gate.message ?? (gate.critical ? "Critical gate" : "Evaluation gate")}</small></span></li>)}</ul> : <EmptyInline>The report has no individual gate rows.</EmptyInline>}
        <h3>Blinded current / candidate comparison</h3>{comparisons.length ? <ul className="cpv2-comparisons">{comparisons.map((item, index) => <li key={item?.id ?? index}><strong>{item?.label ?? item?.case ?? `Case ${index + 1}`}</strong><span>Current: {item?.current ?? item?.baseline ?? "Not provided"}</span><span>Candidate: {item?.candidate ?? item?.proposed ?? "Not provided"}</span><small>{item?.verdict ?? item?.result ?? "Blinded result"}</small></li>)}</ul> : <EmptyInline>No blinded comparison was included in this report.</EmptyInline>}
        <h3>Material behavior changes</h3>{changes.length ? <ul className="cpv2-bullets">{changes.map((item, index) => <li key={index}>{typeof item === "string" ? item : item.description ?? item.label}</li>)}</ul> : <EmptyInline>No material behavior changes were reported.</EmptyInline>}
        <h3>Product boundaries</h3>{boundaries.length ? <ul className="cpv2-bullets">{boundaries.map((item, index) => <li key={index}>{typeof item === "string" ? item : item.description ?? item.label}</li>)}</ul> : <EmptyInline>No product boundaries were included in this report.</EmptyInline>}
        {losses.length ? <fieldset className="cpv2-losses"><legend>Known non-critical losses</legend>{losses.map((loss, index) => { const lossId = loss?.id ?? String(index); return <label key={lossId}><input type="checkbox" checked={acknowledged.includes(lossId)} onChange={(event) => setAcknowledged((current) => event.target.checked ? [...current, lossId] : current.filter((id) => id !== lossId))} /><span><strong>{loss?.title ?? loss?.label ?? `Loss ${index + 1}`}</strong><small>{loss?.description ?? loss?.detail ?? String(loss)}</small></span></label>; })}</fieldset> : null}
      </article>
      <div className="cpv2-action-bar"><div><strong>Approval is immutable for this digest.</strong><small>Any candidate or report change invalidates it.</small></div>{confirmReject ? <><span>Archive this candidate?</span><button className="cpv2-danger" type="button" disabled={busy} onClick={() => decide("reject", candidate, expectedVersion)}>{mutation.state === "reject" ? "Rejecting…" : "Yes, reject"}</button><button className="cpv2-secondary" type="button" onClick={() => setConfirmReject(false)}>Cancel</button></> : <button className="cpv2-secondary" type="button" disabled={busy || alreadyApproved} onClick={() => setConfirmReject(true)}>Reject candidate</button>}<button className="cpv2-primary" type="button" disabled={busy || criticalFailed || !allAcknowledged || alreadyApproved} aria-busy={mutation.state === "approve"} onClick={() => decide("approve", candidate, expectedVersion)}>{alreadyApproved ? "Approved" : mutation.state === "approve" ? "Approving…" : "Approve candidate"}</button></div>
    </>;
  }}</PageBoundary>;
}

function OfferPage({ token, request, navigate, productId }) {
  const resource = useRemote(request, `/v1/creator/products/${encodeURIComponent(productId)}`, token);
  return <PageBoundary resource={resource} title="We couldn't load the offer">{(payload) => <OfferEditor product={unwrap(payload, "product") ?? payload} token={token} request={request} navigate={navigate} productId={productId} />}</PageBoundary>;
}

function OfferEditor({ product, token, request, navigate, productId }) {
  const existing = offerOf(product) ?? {};
  const paidEnabled = product.paid_offers_enabled === true || product.commerce_capabilities?.paid_per_delivery === true;
  const [kind, setKind] = useState(Number(existing.amount_minor ?? 0) > 0 ? "paid" : "free");
  const [amount, setAmount] = useState(Number(existing.amount_minor ?? 0) > 0 ? String(Number(existing.amount_minor) / 100) : "39");
  const [currency, setCurrency] = useState(existing.currency ?? "USD");
  const [unit, setUnit] = useState(existing.unit ?? "delivery");
  const [units, setUnits] = useState(String(existing.included_units ?? 1));
  const [refundPolicy, setRefundPolicy] = useState(existing.refund_policy_version ?? "standard-v1");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const amountMinor = kind === "free" ? 0 : Math.round(Number(amount) * 100);
  const valid = Number.isInteger(amountMinor) && amountMinor >= 0 && Number.isInteger(Number(units)) && Number(units) > 0 && Boolean(currency && unit && refundPolicy);

  async function save(event) {
    event.preventDefault();
    if (!valid) return;
    setSaving(true); setError("");
    try {
      const result = await request(`/v1/creator/products/${encodeURIComponent(productId)}/offer-draft`, { method: "PUT", token, headers: { "idempotency-key": mutationKey() }, body: JSON.stringify({ purchase_model: "per_delivery", amount_minor: amountMinor, currency, unit, included_units: Number(units), refund_policy_version: refundPolicy, expected_version: product.resource_version ?? product.version ?? 0 }) });
      const saved = unwrap(result, "offer") ?? result;
      navigate(`${ROOT}/products/${encodeURIComponent(productId)}/preview${saved?.revision ? `?offer=${encodeURIComponent(saved.revision)}` : ""}`);
    } catch (nextError) { setError(friendlyError(nextError)); }
    finally { setSaving(false); }
  }

  return <>
    <Breadcrumb onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}`)}>Product</Breadcrumb>
    <PageHeader eyebrow="Offer and pricing" title="Define one clear delivery unit." body="The offer is versioned separately from the immutable Corpus. Historical orders keep the exact price and policy they confirmed." />
    {error ? <InlineError>{error}</InlineError> : null}
    <form className="cpv2-offer-grid" onSubmit={save}>
      <article className="cpv2-card cpv2-panel"><fieldset className="cpv2-segment"><legend>Price model</legend><label className={kind === "free" ? "is-selected" : ""}><input type="radio" name="price-kind" value="free" checked={kind === "free"} onChange={() => setKind("free")} /><span><strong>Free per delivery</strong><small>Creates a real zero-value order and explicit delivery units.</small></span></label><label className={kind === "paid" ? "is-selected" : ""}><input type="radio" name="price-kind" value="paid" checked={kind === "paid"} disabled={!paidEnabled} onChange={() => setKind("paid")} /><span><strong>Paid per delivery</strong><small>{paidEnabled ? "Buyer pays once for the included delivery units." : "Available after an authoritative payment provider is configured."}</small></span></label></fieldset>
        <div className="cpv2-form-grid"><label>Amount<input disabled={kind === "free"} type="number" min="0.01" step="0.01" inputMode="decimal" value={kind === "free" ? "0" : amount} onChange={(event) => setAmount(event.target.value)} /></label><label>Currency<select value={currency} onChange={(event) => setCurrency(event.target.value)}><option value="USD">USD</option><option value="CNY">CNY</option><option value="EUR">EUR</option></select></label><label>Delivery unit<input value={unit} onChange={(event) => setUnit(event.target.value)} /></label><label>Included units<input type="number" min="1" step="1" value={units} onChange={(event) => setUnits(event.target.value)} /></label><label className="cpv2-wide">Refund policy<select value={refundPolicy} onChange={(event) => setRefundPolicy(event.target.value)}><option value="standard-v1">Standard · before delivery</option><option value="review-v1">Manual review</option><option value="final-v1">Final after completed delivery</option></select></label></div>
        <div className="cpv2-policy-note"><strong>Platform policy</strong><p>Hatch split and reservation policy are versioned by the platform and cannot be edited here.</p></div>
        <button className="cpv2-primary" type="submit" disabled={!valid || saving} aria-busy={saving}>{saving ? "Saving…" : "Save and preview"}</button>
      </article>
      <aside className="cpv2-card cpv2-offer-preview"><span className="cpv2-kicker">Buyer-facing preview</span><h2>{product.name ?? product.product_name ?? "Product"}</h2><strong>{kind === "free" ? "Free" : money(amountMinor, currency)}</strong><p>per {unit || "delivery"} · {units || "1"} included</p><hr /><dl><Fact label="Payment" value={kind === "free" ? "No payment required" : paidEnabled ? "Provider checkout" : "Payment unavailable"} /><Fact label="Access" value={`${units || "1"} ${unit || "delivery"} unit${Number(units) === 1 ? "" : "s"}`} /><Fact label="Renewal" value="None" /></dl><small>Subscription stays unavailable until its complete lifecycle ships.</small></aside>
    </form>
  </>;
}

function PreviewPage({ token, request, navigate, productId }) {
  const resource = useRemote(request, `/v1/creator/products/${encodeURIComponent(productId)}/storefront-preview`, token);
  const [viewport, setViewport] = useState("desktop");
  const [confirming, setConfirming] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function publish(preview) {
    setPublishing(true); setError("");
    try {
      const result = await request(`/v1/creator/products/${encodeURIComponent(productId)}/publish`, { method: "POST", token, headers: { "idempotency-key": mutationKey() }, body: JSON.stringify({ candidate_id: idOf(preview.candidate, "candidate"), offer_revision: preview.offer?.revision, expected_version: preview.resource_version ?? preview.product?.resource_version ?? preview.product?.version }) });
      setPublished(result);
    } catch (nextError) { setError(friendlyError(nextError)); }
    finally { setPublishing(false); }
  }

  async function copy(url) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      void request("/v1/analytics/events", {
        method: "POST",
        token,
        headers: { "idempotency-key": mutationKey() },
        body: JSON.stringify({
          event_name: "share_link_copied",
          attributes: {
            product_id: productId,
            release_id: published?.release?.release_id ?? published?.product?.release?.release_id
          }
        })
      }).catch(() => undefined);
    } catch {
      setError("Copy failed. Select the link and copy it manually.");
    }
  }

  if (published) {
    const publicUrl = published.public_url ?? published.product?.public_url;
    return <section className="cpv2-published" aria-live="polite"><span aria-hidden="true">✓</span><h1>Your product is live</h1><p>Buyer checkout now resolves this immutable release and offer pair.</p><label>Share link<input readOnly value={publicUrl ?? "Publication completed"} onFocus={(event) => event.target.select()} /></label><div>{publicUrl ? <button className="cpv2-primary" type="button" onClick={() => copy(publicUrl)}>{copied ? "Copied" : "Copy link"}</button> : null}{publicUrl ? <a className="cpv2-secondary" href={safePublicUrl(publicUrl)} target="_blank" rel="noreferrer">View storefront</a> : null}<button className="cpv2-secondary" type="button" onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}`)}>Back to product</button></div>{error ? <InlineError>{error}</InlineError> : null}</section>;
  }

  return <PageBoundary resource={resource} title="We couldn't build the storefront preview">{(payload) => {
    const preview = payload?.preview && typeof payload.preview === "object"
      ? payload.preview
      : payload;
    const product = preview.product ?? preview;
    const offer = preview.offer ?? offerOf(product);
    const candidate = preview.candidate ?? candidateOf(product);
    const readiness = normalizeReadiness(preview, candidate, offer);
    const ready = readiness.every((item) => item.ready);
    return <>
      <Breadcrumb onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}/offer`)}>Offer</Breadcrumb>
      <PageHeader eyebrow="Storefront preview" title="See exactly what Buyers will see." body="This preview is pinned to the approved candidate and proposed offer. Checkout is disabled until you publish." />
      {error ? <InlineError>{error}</InlineError> : null}
      <div className="cpv2-preview-tools"><span className="cpv2-private-badge">Not public</span><div role="group" aria-label="Preview viewport"><button type="button" className={viewport === "desktop" ? "is-active" : ""} aria-pressed={viewport === "desktop"} onClick={() => setViewport("desktop")}>Desktop</button><button type="button" className={viewport === "mobile" ? "is-active" : ""} aria-pressed={viewport === "mobile"} onClick={() => setViewport("mobile")}>Mobile</button></div></div>
      <div className={`cpv2-storefront-frame is-${viewport}`}><StorefrontDetails product={product} creatorName={preview.creator?.display_name ?? preview.creator_name} offer={offer} offerText={offer ? offerLabel(offer) : "Offer not configured"} mode="preview" headingLevel={2} desktopRequirement={preview.desktop_requirement ?? product.desktop_requirement} refundPolicy={preview.refund_policy?.summary ?? preview.refund_policy_summary ?? offer?.refund_policy_summary ?? offer?.refund_policy_version} releaseLabel={candidate ? `Candidate v${candidate.version ?? "—"} · ${candidate.digest ?? "digest not provided"}` : "Candidate not provided"} action={<button type="button" disabled>Preview checkout</button>} /></div>
      <article className="cpv2-card cpv2-readiness"><SectionHeading eyebrow="Publish readiness" title="Final checks" /><ul>{readiness.map((item) => <li key={item.label} className={item.ready ? "is-ready" : ""}><span>{item.ready ? "✓" : "!"}</span><strong>{item.label}</strong><small>{item.detail}</small></li>)}</ul>{confirming ? <div className="cpv2-confirm cpv2-confirm-publish"><div><p><strong>Publish this immutable candidate and offer?</strong><br />The public current pointer changes only after materialization succeeds.</p><dl className="cpv2-confirm-facts"><Fact label="Product" value={product.name ?? product.product_name ?? productId} /><Fact label="Candidate" value={`v${candidate?.version ?? "—"} · ${candidate?.digest ?? "Not provided"}`} /><Fact label="Offer" value={offer ? `${offerLabel(offer)} · revision ${offer.revision ?? "—"}` : "Not configured"} /><Fact label="Public URL" value={preview.public_url ?? `/agents/${preview.creator?.id ?? "creator"}/${productId}`} /></dl><small>Publishing creates an immutable release. Future changes require another release or an audited rollback.</small></div><button className="cpv2-secondary" type="button" onClick={() => setConfirming(false)}>Cancel</button><button className="cpv2-primary" type="button" disabled={!ready || publishing} aria-busy={publishing} onClick={() => publish({ ...preview, product, candidate, offer })}>{publishing ? "Publishing…" : "Confirm publish"}</button></div> : <button className="cpv2-primary" type="button" disabled={!ready} onClick={() => setConfirming(true)}>Publish</button>}</article>
    </>;
  }}</PageBoundary>;
}

function ReleasePage({ token, request, navigate, productId, releaseId }) {
  const resource = useRemote(request, `/v1/creator/products/${encodeURIComponent(productId)}`, token);
  const [state, setState] = useState({ busy: false, error: "", done: false, reason: "", offerRevision: "", confirming: false });
  return <PageBoundary resource={resource} title="We couldn't load this release">{(payload) => {
    const product = unwrap(payload, "product") ?? payload;
    const release = arrayOf(product.releases).find((item) => idOf(item, "release") === releaseId) ?? (idOf(product.release, "release") === releaseId ? { ...product.release, current: true } : null) ?? product.active_release;
    if (!release) return <RouteProblem title="Release not found" body="This release is not present in the product history." action="Back to versions" onAction={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}/versions`)} />;
    const currentOffer = product.offer_active ?? product.active_offer ?? product.offer ?? product.offer_draft;
    const historicalOffer = release.offer_snapshot;
    const currentRevision = currentOffer?.revision;
    const historicalRevision = historicalOffer?.revision ?? release.offer_revision;
    const selectedRevision = Number(state.offerRevision || currentRevision || historicalRevision || 0);
    const selectedOffer = Number(historicalRevision) === selectedRevision && historicalOffer ? historicalOffer : currentOffer;
    const offerOptions = [
      currentRevision ? { revision: Number(currentRevision), label: `Keep current offer · revision ${currentRevision}`, offer: currentOffer } : null,
      historicalRevision && Number(historicalRevision) !== Number(currentRevision) ? { revision: Number(historicalRevision), label: `Use this release's historical offer · revision ${historicalRevision}`, offer: historicalOffer } : null
    ].filter(Boolean);
    async function rollback() {
      if (!state.reason.trim() || !selectedRevision) return;
      setState((current) => ({ ...current, busy: true, error: "", done: false }));
      try {
        await request(`/v1/creator/products/${encodeURIComponent(productId)}/releases/${encodeURIComponent(releaseId)}/rollback`, {
          method: "POST",
          token,
          headers: { "idempotency-key": mutationKey() },
          body: JSON.stringify({ expected_version: product.resource_version, offer_revision: selectedRevision, reason: state.reason.trim() })
        });
        setState((current) => ({ ...current, busy: false, error: "", done: true, confirming: false }));
        resource.retry();
      } catch (error) { setState((current) => ({ ...current, busy: false, error: friendlyError(error), done: false })); }
    }
    return <><Breadcrumb onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}/versions`)}>Versions</Breadcrumb><PageHeader eyebrow="Immutable release" title={release.label ?? `Release ${release.version ?? ""}`} body="Historical orders and entitlements retain the release policy captured at purchase." />{state.error ? <InlineError>{state.error}</InlineError> : null}{state.done ? <SuccessNotice>Current release pointer updated with the offer you selected. Historical orders were not changed.</SuccessNotice> : null}<article className="cpv2-card cpv2-panel"><dl className="cpv2-fact-grid"><Fact label="Release ID" value={idOf(release, "release")} /><Fact label="Corpus digest" value={release.corpus_digest ?? release.digest} /><Fact label="Published" value={dateTime(release.published_at ?? release.created_at)} /><Fact label="Historical offer" value={historicalRevision ?? "Not recorded"} /><Fact label="Status" value={release.current ? "Current" : "Previous"} /><Fact label="Materialization" value={release.materialization_status ?? "Not reported"} /></dl></article>{release.current ? <p className="cpv2-muted">This is already the public current release.</p> : <section className="cpv2-rollback"><article className="cpv2-card cpv2-panel"><SectionHeading eyebrow="Rollback contract" title="Choose the release and offer explicitly" /><p>The release is fixed by this page. Hatch never restores its old price automatically.</p><label>Release<input readOnly value={`${release.label ?? releaseId} · ${release.corpus_digest ?? release.digest ?? "digest not provided"}`} /></label><label>Offer revision<select value={String(selectedRevision || "")} onChange={(event) => setState((current) => ({ ...current, offerRevision: event.target.value, confirming: false }))}>{!offerOptions.length ? <option value="">No known offer revision</option> : null}{offerOptions.map((option) => <option key={option.revision} value={option.revision}>{option.label}</option>)}</select></label><label>Audit reason<textarea required value={state.reason} onChange={(event) => setState((current) => ({ ...current, reason: event.target.value, confirming: false }))} placeholder="Why should this release become current?" /></label></article><div className="cpv2-rollback-preview"><span className="cpv2-private-badge">Rollback preview · Not public</span><StorefrontDetails product={product} creatorName={product.creator_name} offer={selectedOffer} offerText={selectedOffer ? offerLabel(selectedOffer) : "Offer not available"} mode="preview" headingLevel={2} refundPolicy={selectedOffer?.refund_policy_summary ?? selectedOffer?.refund_policy_version} desktopRequirement={product.desktop_requirement} releaseLabel={`${release.label ?? releaseId} · ${release.corpus_digest ?? release.digest ?? "digest not provided"}`} action={<button type="button" disabled>Preview checkout</button>} /></div>{state.confirming ? <div className="cpv2-card cpv2-confirm cpv2-confirm-publish" role="alert"><div><strong>Make this exact release and offer current?</strong><p>{state.reason}</p><small>This writes an authenticated rollback audit. Existing orders keep their purchase-time snapshots.</small></div><button className="cpv2-secondary" type="button" onClick={() => setState((current) => ({ ...current, confirming: false }))}>Cancel</button><button className="cpv2-primary" type="button" disabled={state.busy || !state.reason.trim() || !selectedRevision} onClick={rollback}>{state.busy ? "Switching…" : "Confirm rollback"}</button></div> : <button className="cpv2-primary" type="button" disabled={!state.reason.trim() || !selectedRevision} onClick={() => setState((current) => ({ ...current, confirming: true }))}>Review rollback</button>}</section>}</>;
  }}</PageBoundary>;
}

function OrdersPage({ token, request, navigate }) {
  const [filters, setFilters] = useState({ order: "", payment: "", delivery: "", product: "", from: "", to: "", refund: "", limit: "25" });
  const query = useMemo(() => creatorOrderQuery(filters), [filters]);
  const resource = useRemote(request, `/v1/creator/orders${query ? `?${query}` : ""}`, token);
  return <PageBoundary resource={resource} title="We couldn't load orders">{(payload) => {
    return <>
      <PageHeader eyebrow="Orders" title="Sales, delivery, and revenue—together." body="Buyer private work never appears here. Follow only the commerce and delivery metadata needed to operate your product." />
      <form className="cpv2-filters" onSubmit={(event) => event.preventDefault()}>
        <label>Order status<select value={filters.order} onChange={(event) => setFilters((current) => ({ ...current, order: event.target.value }))}><option value="">All</option><option value="fulfilled">Fulfilled</option><option value="refund_pending">Refund pending</option><option value="refunded">Refunded</option><option value="failed">Failed</option></select></label>
        <label>Payment status<select value={filters.payment} onChange={(event) => setFilters((current) => ({ ...current, payment: event.target.value }))}><option value="">All</option><option value="not_required">Not required</option><option value="paid">Paid</option><option value="processing">Processing</option><option value="failed">Failed</option><option value="refunded">Refunded</option></select></label>
        <label>Delivery status<select value={filters.delivery} onChange={(event) => setFilters((current) => ({ ...current, delivery: event.target.value }))}><option value="">All</option><option value="not_started">Not started</option><option value="reserved">Reserved</option><option value="completed">Completed</option><option value="failed">Failed</option></select></label>
        <label>Refund status<select value={filters.refund} onChange={(event) => setFilters((current) => ({ ...current, refund: event.target.value }))}><option value="">All</option><option value="none">None</option><option value="pending">Pending</option><option value="refunded">Refunded</option><option value="failed">Failed</option></select></label>
        <label>Product ID<input value={filters.product} onChange={(event) => setFilters((current) => ({ ...current, product: event.target.value }))} placeholder="All products" /></label>
        <label>From date<input type="date" value={filters.from} max={filters.to || undefined} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} /></label>
        <label>To date<input type="date" value={filters.to} min={filters.from || undefined} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} /></label>
        <label>Rows per page<select value={filters.limit} onChange={(event) => setFilters((current) => ({ ...current, limit: event.target.value }))}><option value="12">12</option><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label>
        <button className="cpv2-secondary" type="button" onClick={() => setFilters({ order: "", payment: "", delivery: "", product: "", from: "", to: "", refund: "", limit: "25" })}>Clear filters</button>
      </form>
      <PaginatedOrders initialPayload={payload} query={query} token={token} request={request} navigate={navigate} />
    </>;
  }}</PageBoundary>;
}

function PaginatedOrders({ initialPayload, query, token, request, navigate }) {
  const initialOrders = arrayOf(unwrap(initialPayload, "orders"));
  const [page, setPage] = useState({ orders: initialOrders, cursor: initialPayload?.next_cursor ?? null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setPage({ orders: initialOrders, cursor: initialPayload?.next_cursor ?? null });
    setError("");
  }, [initialPayload, query]);

  async function loadMore() {
    if (!page.cursor || loadingMore) return;
    setLoadingMore(true); setError("");
    try {
      const params = new URLSearchParams(query);
      params.set("cursor", page.cursor);
      const result = await request(`/v1/creator/orders?${params}`, { token });
      const nextOrders = arrayOf(unwrap(result, "orders"));
      setPage((current) => ({ orders: [...current.orders, ...nextOrders.filter((order) => !current.orders.some((existing) => idOf(existing, "order") === idOf(order, "order")))], cursor: result?.next_cursor ?? null }));
    } catch (nextError) { setError(friendlyError(nextError)); }
    finally { setLoadingMore(false); }
  }

  if (!page.orders.length) return <EmptyState title="No matching orders" body="Try a different filter, or share a published storefront to reach your first Buyer." />;
  return <><div className="cpv2-pagination-status" role="status">Loaded {page.orders.length} order{page.orders.length === 1 ? "" : "s"}{page.cursor ? "; more are available" : "; end of results"}.</div><OrderList orders={page.orders} onOpen={(order) => navigate(`${ROOT}/orders/${encodeURIComponent(idOf(order, "order"))}`)} detailed />{error ? <InlineError>{error}</InlineError> : null}{page.cursor ? <button className="cpv2-load-more cpv2-secondary" type="button" disabled={loadingMore} aria-busy={loadingMore} onClick={loadMore}>{loadingMore ? "Loading…" : "Load next page"}</button> : null}</>;
}

function OrderList({ orders, onOpen, detailed = false }) {
  return <div className="cpv2-order-list" role="list">{orders.map((order) => <article className="cpv2-order" role="listitem" key={idOf(order, "order")}><div><span className="cpv2-kicker">{order.order_reference ?? idOf(order, "order")}</span><h2>{order.product_name ?? order.product?.name ?? "Product order"}</h2><p>{order.buyer_display_name ?? "Buyer"} · {dateTime(order.created_at ?? order.placed_at)}</p></div><dl><Fact label="Order" value={humanStatus(order.status ?? order.order_status)} /><Fact label="Payment" value={humanStatus(order.payment_status ?? (Number(order.gross_minor) === 0 ? "not_required" : "processing"))} />{detailed ? <><Fact label="Delivery" value={humanStatus(order.delivery_status ?? "not_started")} /><Fact label="Revenue" value={humanStatus(order.revenue_status ?? "pending")} /></> : null}<Fact label="Total" value={money(order.total_minor ?? order.gross_minor ?? order.amount_minor ?? 0, order.currency)} /></dl><button className="cpv2-secondary" type="button" onClick={() => onOpen(order)} aria-label={`View order ${order.order_reference ?? idOf(order, "order")}`}>View order</button></article>)}</div>;
}

function OrderPage({ token, request, navigate, orderId }) {
  const resource = useRemote(request, `/v1/creator/orders/${encodeURIComponent(orderId)}`, token);
  const [refund, setRefund] = useState({ reason: "", confirming: false, busy: false, error: "", done: false });

  async function requestRefund() {
    if (!refund.reason.trim() || refund.busy) return;
    setRefund((current) => ({ ...current, busy: true, error: "", done: false }));
    try {
      await request(`/v1/creator/orders/${encodeURIComponent(orderId)}/refund-requests`, {
        method: "POST",
        token,
        headers: { "idempotency-key": mutationKey() },
        body: JSON.stringify({ reason: refund.reason.trim() })
      });
      setRefund((current) => ({ ...current, busy: false, confirming: false, error: "", done: true }));
      resource.retry();
    } catch (error) {
      setRefund((current) => ({ ...current, busy: false, error: friendlyError(error), done: false }));
    }
  }

  return <PageBoundary resource={resource} title="We couldn't load this order">{(payload) => {
    const order = unwrap(payload, "order") ?? payload;
    const events = arrayOf(order.timeline ?? order.events);
    const safeEvents = events.length ? events : inferredTimeline(order);
    const canRefund = Boolean(order.actions?.can_creator_refund || order.actions?.can_request_refund || order.actions?.can_cancel_access);
    return <><Breadcrumb onClick={() => navigate(`${ROOT}/orders`)}>Orders</Breadcrumb><PageHeader eyebrow={order.order_reference ?? orderId} title={order.product_name ?? order.product?.name ?? "Order detail"} body={`${order.buyer_display_name ?? "Buyer"} · ${dateTime(order.created_at ?? order.placed_at)}`} />{refund.error ? <InlineError>{refund.error}</InlineError> : null}{refund.done ? <SuccessNotice>The refund request was recorded. Refreshing the authoritative order state.</SuccessNotice> : null}<div className="cpv2-detail-grid"><article className="cpv2-card cpv2-panel"><SectionHeading eyebrow="Commerce snapshot" title="What the Buyer confirmed" /><dl className="cpv2-fact-grid"><Fact label="Total" value={money(order.total_minor ?? order.gross_minor ?? 0, order.currency)} /><Fact label="Payment" value={humanStatus(order.payment_status ?? order.payment?.status)} /><Fact label="Entitlement" value={humanStatus(order.entitlement_status ?? order.access?.status)} /><Fact label="Offer revision" value={order.offer_revision ?? order.offer_snapshot?.revision ?? "Not provided"} /><Fact label="Release" value={order.release_id ?? order.release_label ?? order.corpus_digest ?? "Not provided"} /><Fact label="Refund" value={humanStatus(order.refund_status ?? order.refund?.status ?? (order.refund ? "completed" : "none"))} /></dl></article><article className="cpv2-card cpv2-panel"><SectionHeading eyebrow="Delivery metadata" title="Private by design" /><dl><Fact label="Status" value={humanStatus(order.delivery_status ?? order.deliveries?.at(-1)?.status ?? (order.deliveries?.length ? "completed" : "not_started"))} /><Fact label="Artifact type" value={order.artifact_type ?? order.deliveries?.at(-1)?.artifact_type ?? "Not delivered"} /><Fact label="Completed" value={dateTime(order.delivery_completed_at ?? order.deliveries?.at(-1)?.occurred_at)} /><Fact label="Revenue" value={humanStatus(order.revenue_status ?? (order.deliveries?.length ? "recognized" : "pending"))} /></dl><p className="cpv2-muted">Workspace paths, conversations, file content, tool arguments, and artifacts are never shown here.</p></article></div><article className="cpv2-card cpv2-panel cpv2-timeline"><SectionHeading eyebrow="Timeline" title="Order to delivery" /><ol>{safeEvents.map((event, index) => <li key={event.id ?? event.event_id ?? index}><span aria-hidden="true" /><div><strong>{event.label ?? humanStatus(event.type ?? event.event_type)}</strong><small>{dateTime(event.at ?? event.created_at ?? event.occurred_at)}</small>{event.detail ? <p>{event.detail}</p> : null}</div></li>)}</ol></article><article className="cpv2-card cpv2-panel cpv2-refund-action"><SectionHeading eyebrow="Order action" title="Refund or revoke access" />{canRefund ? <><p>Commerce decides whether this order is still refundable. A reason is required for the audit record.</p><label>Reason<textarea value={refund.reason} onChange={(event) => setRefund((current) => ({ ...current, reason: event.target.value, confirming: false }))} placeholder="Reason for this Creator-initiated refund" /></label>{refund.confirming ? <div className="cpv2-confirm"><p><strong>Submit this refund request?</strong><br />Entitlement and payout adjustments follow the authoritative provider result.</p><button className="cpv2-secondary" type="button" onClick={() => setRefund((current) => ({ ...current, confirming: false }))}>Cancel</button><button className="cpv2-danger" type="button" disabled={refund.busy || !refund.reason.trim()} onClick={requestRefund}>{refund.busy ? "Submitting…" : "Confirm refund"}</button></div> : <button className="cpv2-danger" type="button" disabled={!refund.reason.trim()} onClick={() => setRefund((current) => ({ ...current, confirming: true }))}>Review refund</button>}</> : <p className="cpv2-muted">No Creator refund action is available for this order state.</p>}</article></>;
  }}</PageBoundary>;
}

function PayoutsPage({ token, request, navigate, settings = false }) {
  const resource = useRemote(request, "/v1/creator/payouts", token);
  const [setup, setSetup] = useState({ busy: false, error: "" });

  async function openPayoutSetup() {
    if (setup.busy) return;
    setSetup({ busy: true, error: "" });
    try {
      const result = await request("/v1/creator/payout-account-sessions", {
        method: "POST",
        token,
        headers: { "idempotency-key": mutationKey() },
        body: JSON.stringify({ return_to: settings ? `${ROOT}/settings/payouts` : `${ROOT}/payouts` })
      });
      const actionUrl = safePublicUrl(result?.account_action_url ?? result?.url ?? result?.session?.url);
      if (!actionUrl) throw new Error("The payout provider did not return an onboarding URL.");
      window.location.assign(actionUrl);
    } catch (error) { setSetup({ busy: false, error: friendlyError(error) }); }
  }

  return <PageBoundary resource={resource} title="We couldn't load payouts">{(payload) => {
    const payouts = arrayOf(payload?.payouts);
    const accountStatus = payload?.account_status ?? "not_connected";
    const balancesAvailable = payload?.balance_status === "available" && Number.isSafeInteger(Number(payload?.available_minor));
    const setupAvailable = payload?.setup_available === true || (payload?.setup_available !== false && payload?.setup_status !== "unavailable");
    const setupAction = payoutActionLabel(accountStatus);
    const providerUnavailable = payload?.setup_status === "unavailable";
    const accountActive = accountStatus === "active";
    if (!balancesAvailable) return <>
      {settings ? <Breadcrumb onClick={() => navigate(`${ROOT}/payouts`)}>Payouts</Breadcrumb> : null}
      <PageHeader eyebrow={settings ? "Payout settings" : "Payouts"} title={accountActive ? "Payout balances are temporarily unavailable." : "Connect payouts before showing a balance."} body="Revenue and payout availability are separate. Hatch only displays balances returned by an authoritative payout provider." action={settings ? undefined : "Payout settings"} onAction={() => navigate(`${ROOT}/settings/payouts`)} />
      {setup.error ? <InlineError>{setup.error}</InlineError> : null}
      <section className="cpv2-payout-grid">
        <article className="cpv2-card cpv2-payout-primary">
          <span className="cpv2-kicker">Account status</span>
          <StatusChip status={accountStatus}>{humanStatus(accountStatus)}</StatusChip>
          <h2>{providerUnavailable ? "Payout setup is not available yet." : accountActive ? "Balance data was not reported." : "Finish payout setup."}</h2>
          <p>{providerUnavailable ? "No payout provider is configured in this environment, so Hatch is not claiming a zero or available balance." : accountActive ? "Your account is active, but the provider did not return authoritative balances. Existing transfer history remains visible below." : "Complete provider onboarding before balances and transfers can appear."}</p>
          <button className="cpv2-primary" type="button" disabled={!setupAvailable || setup.busy} aria-busy={setup.busy} onClick={openPayoutSetup}>{setup.busy ? "Opening provider…" : setupAvailable ? setupAction : "Setup unavailable"}</button>
        </article>
      </section>
      <SectionHeading eyebrow="Payout history" title="Transfers" />
      {payouts.length ? <PayoutList payouts={payouts} currency={payload?.currency ?? "USD"} onOpen={(payout) => navigate(`${ROOT}/payouts/${encodeURIComponent(idOf(payout, "payout"))}`)} /> : <EmptyState title={accountActive ? "No transfers reported" : "No payout account or transfers"} body={accountActive ? "The provider has not reported a payout batch yet." : "Balances and transfer history will appear only after an authoritative payout provider is connected."} />}
    </>;
    const currency = payload?.currency ?? "USD";
    return <>
      {settings ? <Breadcrumb onClick={() => navigate(`${ROOT}/payouts`)}>Payouts</Breadcrumb> : null}
      <PageHeader eyebrow={settings ? "Payout settings" : "Payouts"} title="Recognized revenue, ready when it’s truly available." body="Pending delivery revenue, available balance, transfers in transit, and paid payouts remain distinct." action={settings ? undefined : "Payout settings"} onAction={() => navigate(`${ROOT}/settings/payouts`)} />
      {setup.error ? <InlineError>{setup.error}</InlineError> : null}
      <section className="cpv2-payout-grid"><article className="cpv2-card cpv2-payout-primary"><span className="cpv2-kicker">Available</span><strong>{optionalMoney(payload?.available_minor, currency)}</strong><p>Recognized revenue after refunds, adjustments, reserves, and payouts.</p><small>{payload?.payout_schedule === "immediate" ? "Automatic payout begins when the configured minimum is reached." : "Automatic payout schedule is not configured."}</small><button className="cpv2-primary" type="button" disabled={!setupAvailable || setup.busy} aria-busy={setup.busy} onClick={openPayoutSetup}>{setup.busy ? "Opening provider…" : setupAvailable ? "Manage payouts" : "Provider management unavailable"}</button></article><div className="cpv2-payout-stats"><article className="cpv2-card"><span>Pending</span><strong>{optionalMoney(payload?.pending_minor, currency)}</strong><small>Paid, not yet recognized</small></article><article className="cpv2-card"><span>In transit</span><strong>{optionalMoney(payload?.in_transit_minor, currency)}</strong><small>Accepted by provider</small></article><article className="cpv2-card"><span>Paid</span><strong>{optionalMoney(payload?.paid_minor, currency)}</strong><small>Confirmed received</small></article><article className="cpv2-card"><span>Adjustments</span><strong>{optionalMoney(payload?.adjustments_minor, currency)}</strong><small>Refunds and reversals</small></article></div></section>
      <SectionHeading eyebrow="Payout history" title="Transfers" />
      {payouts.length ? <PayoutList payouts={payouts} currency={currency} onOpen={(payout) => navigate(`${ROOT}/payouts/${encodeURIComponent(idOf(payout, "payout"))}`)} /> : <EmptyState title="No payouts yet" body="Completed, recognized delivery revenue becomes available according to the payout schedule." />}
    </>;
  }}</PageBoundary>;
}

function PayoutList({ payouts, currency, onOpen }) {
  return <div className="cpv2-order-list">{payouts.map((payout) => <article className="cpv2-order" key={idOf(payout, "payout")}><div><span className="cpv2-kicker">Batch {payout.batch_id ?? payout.payout_batch_id ?? idOf(payout, "payout")}</span><h2>{optionalMoney(payout.amount_minor, payout.currency ?? currency)}</h2><p>{dateTime(payout.created_at)}{Number.isSafeInteger(Number(payout.order_count ?? payout.entry_count)) ? ` · ${Number(payout.order_count ?? payout.entry_count)} entries` : ""}</p></div><StatusChip status={payout.status}>{humanStatus(payout.status)}</StatusChip>{onOpen ? <button className="cpv2-secondary" type="button" onClick={() => onOpen(payout)}>View payout</button> : null}</article>)}</div>;
}

function PayoutDetailPage({ token, request, navigate, payoutId }) {
  const resource = useRemote(request, `/v1/creator/payouts/${encodeURIComponent(payoutId)}`, token);
  const [retry, setRetry] = useState({ reason: "", confirming: false, busy: false, error: "", done: false });
  async function retryPayout() {
    if (!retry.reason.trim() || retry.busy) return;
    setRetry((current) => ({ ...current, busy: true, error: "", done: false }));
    try {
      await request(`/v1/creator/payouts/${encodeURIComponent(payoutId)}/retry`, { method: "POST", token, headers: { "idempotency-key": mutationKey() }, body: JSON.stringify({ reason: retry.reason.trim() }) });
      setRetry((current) => ({ ...current, busy: false, confirming: false, error: "", done: true }));
      resource.retry();
    } catch (error) { setRetry((current) => ({ ...current, busy: false, error: friendlyError(error), done: false })); }
  }
  return <PageBoundary resource={resource} title="We couldn't load this payout">{(payload) => {
    const payout = unwrap(payload, "payout") ?? payload;
    const entryCount = payout.order_count ?? payout.entry_count ?? (Array.isArray(payout.entries) ? payout.entries.length : "Not provided");
    const payoutWindow = payout.period_start || payout.period_end
      ? `${dateTime(payout.period_start)} → ${dateTime(payout.period_end)}`
      : "Not provided";
    return <><Breadcrumb onClick={() => navigate(`${ROOT}/payouts`)}>Payouts</Breadcrumb><PageHeader eyebrow="Payout transfer" title={idOf(payout, "payout") || payoutId} body="Provider and Commerce states remain separate and auditable." />{retry.error ? <InlineError>{retry.error}</InlineError> : null}{retry.done ? <SuccessNotice>The retry was accepted. Provider updates will appear here without creating a duplicate payout.</SuccessNotice> : null}<article className="cpv2-card cpv2-panel"><dl className="cpv2-fact-grid"><Fact label="Batch ID" value={payout.batch_id ?? payout.payout_batch_id ?? "Not provided"} /><Fact label="Entries" value={entryCount} /><Fact label="Amount" value={optionalMoney(payout.amount_minor, payout.currency)} /><Fact label="Currency" value={payout.currency ?? "Not provided"} /><Fact label="Status" value={humanStatus(payout.status)} /><Fact label="Provider reference" value={payout.provider_reference ?? payout.provider_payout_id ?? "Not submitted"} /><Fact label="Batch window" value={payoutWindow} /><Fact label="Reservation" value={humanStatus(payout.reservation_status ?? (payout.reserved_at ? "reserved" : undefined))} /><Fact label="Reserved" value={dateTime(payout.reserved_at)} /><Fact label="Submitted" value={dateTime(payout.submitted_at)} /><Fact label="Retry attempts" value={payout.retry_count ?? payout.attempt_count ?? "Not provided"} /><Fact label="Updated" value={dateTime(payout.updated_at ?? payout.created_at)} /></dl>{payout.failure_code || payout.last_error_category ? <p className="cpv2-muted">Failure category: {humanStatus(payout.failure_code ?? payout.last_error_category)}</p> : null}{payout.failure_message ? <InlineError>{payout.failure_message}</InlineError> : null}</article>{payoutCanRetry(payout.status) ? <article className="cpv2-card cpv2-panel cpv2-refund-action"><SectionHeading eyebrow="Failed payout" title="Release and retry safely" /><p>The failed reservation must be released or reused by Commerce before the provider receives another request.</p><label>Retry reason<textarea value={retry.reason} onChange={(event) => setRetry((current) => ({ ...current, reason: event.target.value, confirming: false }))} placeholder="Why is this payout safe to retry?" /></label>{retry.confirming ? <div className="cpv2-confirm"><p><strong>Retry this payout?</strong><br />The same payout identity is reused to prevent duplicate transfers.</p><button className="cpv2-secondary" type="button" onClick={() => setRetry((current) => ({ ...current, confirming: false }))}>Cancel</button><button className="cpv2-primary" type="button" disabled={retry.busy || !retry.reason.trim()} onClick={retryPayout}>{retry.busy ? "Retrying…" : "Confirm retry"}</button></div> : <button className="cpv2-primary" type="button" disabled={!retry.reason.trim()} onClick={() => setRetry((current) => ({ ...current, confirming: true }))}>Review retry</button>}</article> : null}</>;
  }}</PageBoundary>;
}

function PageBoundary({ resource, title, children }) {
  if (resource.state === "loading") return <LoadingState />;
  if (resource.state === "error") return <RouteProblem title={title} body={friendlyError(resource.error)} action="Retry" onAction={resource.retry} />;
  return <>{children(resource.data)}</>;
}

function PageHeader({ eyebrow, title, body, action, onAction }) {
  const headingRef = useRef(null);
  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, []);
  return <header className="cpv2-page-header"><div><span className="cpv2-kicker">{eyebrow}</span><h1 ref={headingRef} tabIndex={-1}>{title}</h1>{body ? <p>{body}</p> : null}</div>{action ? <button className="cpv2-primary" type="button" onClick={onAction}>{action}</button> : null}</header>;
}

function SectionHeading({ eyebrow, title, action, onAction }) {
  return <div className="cpv2-section-heading"><div><span className="cpv2-kicker">{eyebrow}</span><h2>{title}</h2></div>{action ? <button type="button" onClick={onAction}>{action} →</button> : null}</div>;
}

function Breadcrumb({ children, onClick }) { return <button className="cpv2-breadcrumb" type="button" onClick={onClick}>← {children}</button>; }
function StatusChip({ status, children }) { return <span className={`cpv2-status is-${statusTone(status)}`}>{children}</span>; }
function Fact({ label, value }) { const missing = value === undefined || value === null || value === ""; return <div><dt>{label}</dt><dd title={typeof value === "string" ? value : undefined}>{missing ? "—" : value}</dd></div>; }
function InlineError({ children }) { return <div className="cpv2-alert" role="alert">{children}</div>; }
function SuccessNotice({ children }) { return <div className="cpv2-success" role="status">{children}</div>; }
function EmptyInline({ children }) { return <p className="cpv2-empty-inline">{children}</p>; }

function EmptyState({ title, body, action, onAction }) {
  return <section className="cpv2-card cpv2-empty"><span aria-hidden="true">○</span><h2>{title}</h2><p>{body}</p>{action ? <button className="cpv2-primary" type="button" onClick={onAction}>{action}</button> : null}</section>;
}

function RouteProblem({ title, body, action, onAction }) {
  return <section className="cpv2-problem" role="alert"><span className="cpv2-kicker">Creator dashboard</span><h1>{title}</h1><p>{body}</p>{action ? <button className="cpv2-primary" type="button" onClick={onAction}>{action}</button> : null}</section>;
}

function LoadingState() {
  return <section className="cpv2-loading" aria-busy="true" aria-label="Loading creator page"><span /><span /><span /><span /></section>;
}

function useRemote(request, path, token) {
  const [attempt, setAttempt] = useState(0);
  const [resource, setResource] = useState({ state: "loading", data: null, error: null });
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    setResource((current) => current.data ? { ...current, state: "refreshing", error: null } : { state: "loading", data: null, error: null });
    Promise.resolve(request(path, { token })).then((data) => { if (active) setResource({ state: "ready", data, error: null }); }).catch((error) => { if (active) setResource({ state: "error", data: null, error }); });
    return () => { active = false; };
  }, [request, path, token, attempt]);
  return { ...resource, retry };
}

function defaultNavigate(path) {
  if (typeof window === "undefined") return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function nextCreatorAction(products) {
  if (!products.length) return { label: "Start here", tone: "draft", title: "Create one focused product", body: "Define the task and authorized sources in Factory.", action: "Open Factory", href: `${ROOT}/products/new/factory` };
  for (const product of products) {
    const candidate = candidateOf(product);
    const next = productNextAction(product, candidate, offerOf(product));
    if (product.status !== "published" && product.status !== "live") return { label: productStatus(product.status), tone: product.status, title: product.name ?? product.product_name, body: product.promise ?? product.description ?? "Continue the publishing workflow.", action: next.action, href: next.href(idOf(product, "product"), candidate) };
  }
  const product = products[0];
  return { label: "Live", tone: "published", title: product.name ?? product.product_name, body: "Your storefront is live. Share it or inspect the latest orders.", action: "View product", href: `${ROOT}/products/${encodeURIComponent(idOf(product, "product"))}` };
}

function productNextAction(product, candidate, offer) {
  if ((product.status === "published" || product.status === "live") && !candidate) return { action: "Preview storefront", href: (id) => `${ROOT}/products/${encodeURIComponent(id)}/preview` };
  if (!candidate) return { action: "Continue in Factory", href: (id) => `${ROOT}/products/${encodeURIComponent(id)}/factory` };
  if (!isApproved(candidate)) return { action: "Review candidate", href: (id, value) => `${ROOT}/products/${encodeURIComponent(id)}/candidates/${encodeURIComponent(idOf(value, "candidate"))}` };
  if (!offer) return { action: "Set offer", href: (id) => `${ROOT}/products/${encodeURIComponent(id)}/offer` };
  if (product.status !== "published" && product.status !== "live") return { action: "Preview storefront", href: (id) => `${ROOT}/products/${encodeURIComponent(id)}/preview` };
  return { action: "Preview storefront", href: (id) => `${ROOT}/products/${encodeURIComponent(id)}/preview` };
}

function candidateOf(product) { const candidate = product?.candidate ?? product?.current_candidate ?? product?.latest_candidate ?? (product?.candidate_id ? { candidate_id: product.candidate_id, status: product.candidate_status, version: product.candidate_version, digest: product.candidate_digest } : null); return candidate ? { ...candidate, approval_status: product?.approval?.status ?? candidate.approval_status, approved: product?.approval?.status === "approved" || candidate.approved } : null; }
function offerOf(product) { return product?.offer_draft ?? product?.active_offer ?? product?.offer_active ?? product?.offer ?? (product?.pricing_model || Number.isInteger(product?.price_minor) ? { purchase_model: product.pricing_model ?? "per_delivery", amount_minor: product.price_minor ?? 0, currency: product.currency ?? "USD", included_units: 1, unit: "delivery" } : null); }
function isApproved(candidate) { return ["approved", "publish_ready"].includes(candidate?.approval_status) || candidate?.approved === true || candidate?.status === "approved"; }
function approvalLabel(candidate) { if (isApproved(candidate)) return "Approved"; if (["ready", "ready_for_review", "review_ready"].includes(candidate?.status ?? candidate?.run_status)) return "Ready for review"; return humanStatus(candidate?.status ?? candidate?.run_status ?? "preparing"); }

function normalizeReadiness(preview, candidate, offer) {
  const provided = arrayOf(preview?.readiness ?? preview?.checks);
  if (provided.length) return provided.map((item) => typeof item === "string" ? { label: item, detail: "Ready", ready: true } : { label: item.label ?? item.name, detail: item.detail ?? item.message ?? (item.ready === false ? "Needs attention" : "Ready"), ready: item.ready ?? item.passed ?? item.status === "ready" });
  if (preview?.readiness && !Array.isArray(preview.readiness)) return [
    { label: "Candidate approval is current", detail: preview.readiness.candidate_approved ? "Bound to this candidate digest" : "Approve the candidate first", ready: Boolean(preview.readiness.candidate_approved) },
    { label: "Offer is valid", detail: preview.readiness.offer_valid ? offerLabel(offer) : "Configure price and delivery units", ready: Boolean(preview.readiness.offer_valid) },
    { label: "Registry materialization", detail: preview.readiness.ready ? "Ready to materialize on publish" : "Complete the required checks", ready: Boolean(preview.readiness.ready) }
  ];
  return [
    { label: "Candidate approval is current", detail: isApproved(candidate) ? "Bound to this candidate digest" : "Approve the candidate first", ready: isApproved(candidate) },
    { label: "Offer is valid", detail: offer ? offerLabel(offer) : "Configure price and delivery units", ready: Boolean(offer && Number(offer.included_units ?? 1) > 0) },
    { label: "Public copy and boundaries", detail: preview?.product?.promise || preview?.promise ? "Buyer-facing copy present" : "Add a product promise", ready: Boolean(preview?.product?.promise || preview?.promise || preview?.product?.description) },
    { label: "Registry materialization", detail: preview?.materialization_status === "failed" ? "Materialization failed" : "Ready to materialize on publish", ready: preview?.materialization_status !== "failed" }
  ];
}

function inferredTimeline(order) {
  const events = [{ label: "Order created", at: order.created_at ?? order.placed_at }];
  if (order.payment_status) events.push({ label: Number(order.gross_minor ?? order.total_minor ?? 0) === 0 ? "Payment not required" : `Payment ${humanStatus(order.payment_status)}`, at: order.payment_at });
  if (order.entitlement_status) events.push({ label: `Access ${humanStatus(order.entitlement_status)}`, at: order.entitlement_at });
  if (order.delivery_status && order.delivery_status !== "not_started") events.push({ label: `Delivery ${humanStatus(order.delivery_status)}`, at: order.delivery_completed_at ?? order.delivery_started_at });
  if (order.refund_status && order.refund_status !== "none") events.push({ label: `Refund ${humanStatus(order.refund_status)}`, at: order.refunded_at });
  return events;
}

function productStatus(status) { return ({ published: "Published", live: "Published", candidate_required: "Factory required", candidate_ready: "Ready for review", candidate_rejected: "Candidate rejected", offer_required: "Offer required", ready_to_preview: "Ready to preview", ready_to_publish: "Ready to publish", ready_for_review: "Ready for review", review_ready: "Ready for review", preparing: "Factory running", needs_attention: "Needs attention", draft: "Draft" })[status] ?? humanStatus(status ?? "draft"); }
function statusTone(status) { if (["published", "live", "passed", "approved", "paid", "completed", "fulfilled", "available"].includes(status)) return "success"; if (["failed", "needs_attention", "candidate_rejected", "refunded", "reversed", "blocked"].includes(status)) return "danger"; if (["candidate_ready", "offer_required", "ready_to_preview", "ready_for_review", "review_ready", "pending", "processing", "reserved", "in_transit"].includes(status)) return "warning"; return "neutral"; }
function offerLabel(offer) { const amount = Number(offer?.amount_minor ?? 0); const units = Number(offer?.included_units ?? 1); const unit = offer?.unit ?? "delivery"; return `${amount === 0 ? "Free" : money(amount, offer?.currency)} · ${units} ${unit}${units === 1 ? "" : "s"}`; }
function money(minor = 0, currency = "USD") { try { return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(Number(minor || 0) / 100); } catch { return `${currency || "USD"} ${(Number(minor || 0) / 100).toFixed(2)}`; } }
function optionalMoney(minor, currency = "USD") { return Number.isSafeInteger(Number(minor)) && minor !== null && minor !== "" ? money(Number(minor), currency) : "Unavailable"; }
function humanStatus(value) { if (!value) return "—"; return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function dateTime(value) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.valueOf()) ? String(value) : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date); }
function shortDigest(value) { if (!value) return "—"; const text = String(value); return text.length > 22 ? `${text.slice(0, 12)}…${text.slice(-7)}` : text; }
function idOf(value, kind) { return String(value?.[`${kind}_id`] ?? value?.id ?? ""); }
function arrayOf(value) { if (Array.isArray(value)) return value; return []; }
function unwrap(payload, key) { return payload && Object.prototype.hasOwnProperty.call(payload, key) ? payload[key] : payload; }
function initials(name) { return String(name || "C").split(/\s+/).slice(0, 2).map((word) => word[0]?.toUpperCase()).join("") || "C"; }
function firstName(name) { return String(name || "Creator").trim().split(/\s+/)[0]; }
function mutationKey() { return globalThis.crypto?.randomUUID?.() ?? `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function safePublicUrl(value) { const text = String(value ?? ""); return /^https?:\/\//i.test(text) || /^\/agents(?:\/|$)/.test(text) ? text : undefined; }
function listCopy(value, fallback) { const items = arrayOf(value); return items.length ? items.map((item) => typeof item === "string" ? item : item.label ?? item.description).filter(Boolean).join(" · ") : fallback; }
function friendlyError(error) { if (!error) return "An unexpected error occurred."; if (error.status === 401) return "Your session expired. Sign in again to continue."; if (error.status === 403) return "This Creator account cannot access that resource."; if (error.status === 404) return "The requested resource no longer exists."; if (error.status === 409) return "This page changed in another tab. Refresh the latest version before trying again."; if (error.status === 429) return "Too many requests. Your work is preserved; try again shortly."; return error.message || "The service is temporarily unavailable. Try again."; }
