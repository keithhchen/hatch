import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CreatorFactoryRuns } from "./CreatorFactoryRuns.jsx";
import { CreatorSourceLibrary } from "./CreatorSourceLibrary.jsx";
import { CreatorReviewPage } from "./CreatorReviewPage.jsx";
import {
  Breadcrumbs as HatchBreadcrumbs,
  Button,
  Checkbox,
  EmptyState as HatchEmptyState,
  FormField,
  HatchBrand,
  InlineAlert as HatchInlineAlert,
  Input,
  NavigationItem,
  PageHeader as HatchPageHeader,
  SectionHeader as HatchSectionHeader,
  Select,
  Skeleton,
  StatusTag as HatchStatusTag,
  Tabs as HatchTabs,
  Textarea,
  UnavailableState
} from "@hatch/ui";
import { AutosaveStatus } from "@hatch/ui/product";
import { StorefrontDetails } from "./StorefrontDetails.jsx";
import { creatorOrderQuery } from "./storefrontModel.js";
import { creatorRouteTitle, parseCreatorRoute } from "./creatorRoutes.js";
import "./creatorPortalV2.css";

const ROOT = "/studio";
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
        <HatchBrand as="button" className="cpv2-brand" type="button" onClick={() => go(ROOT)} aria-label="Hatch creator home" />
        <nav className="cpv2-global-nav" aria-label="Hatch spaces">
          <SpaceLink href="/explore" navigate={go}>Explore</SpaceLink>
          <SpaceLink href="/library" navigate={go}>Library</SpaceLink>
          <SpaceLink href="/studio" navigate={go} active={route.section === "home"}>Studio</SpaceLink>
          <SpaceLink href="/studio/orders" navigate={go} active={route.section === "orders"}>Orders</SpaceLink>
          <SpaceLink href="/account" navigate={go}>Account</SpaceLink>
        </nav>
        <nav aria-label="Creator dashboard">
          <NavButton active={route.section === "home"} onClick={() => go(ROOT)}>Home</NavButton>
          <NavButton active={route.section === "products"} onClick={() => go(`${ROOT}/products`)}>Products</NavButton>
          <NavButton active={route.kind === "sources"} onClick={() => go(`${ROOT}/sources`)}>Source Library</NavButton>
          <NavButton active={route.section === "orders"} onClick={() => go(`${ROOT}/orders`)}>Orders</NavButton>
        </nav>
        <div className="cpv2-account">
          <span className="cpv2-avatar" aria-hidden="true">{profile?.initials || initials(profile?.display_name)}</span>
          <span><strong>{profile?.display_name || "Creator"}</strong><small>{profile?.handle || "Creator account"}</small></span>
          {onLogout ? <Button type="button" variant="ghost" size="small" onClick={onLogout}>Sign out</Button> : null}
        </div>
      </aside>
      <main id="creator-main" className="cpv2-main" ref={mainRef}>
        <CreatorRoute route={route} token={token} request={request} navigate={go} profile={profile} registerNavigationGuard={registerNavigationGuard} />
      </main>
    </div>
  );
}

function SpaceLink({ href, navigate, active = false, children }) {
  function handleClick(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void navigate(href);
  }
  return <a href={href} aria-current={active ? "page" : undefined} onClick={handleClick}>{children}</a>;
}

function NavButton({ active, children, onClick }) {
  return <NavigationItem active={active} aria-current={active ? "page" : undefined} onClick={onClick}>{children}</NavigationItem>;
}

function CreatorRoute({ route, token, request, navigate, profile, registerNavigationGuard }) {
  if (typeof request !== "function") {
    return <RouteProblem title="Creator portal is unavailable" body="A request function is required to load this workspace." />;
  }
  if (route.kind === "home") return <CreatorHome token={token} request={request} navigate={navigate} profile={profile} />;
  if (route.kind === "products") return <ProductsPage token={token} request={request} navigate={navigate} />;
  if (route.kind === "sources") return <CreatorSourceLibrary token={token} taskId={route.taskId} navigate={navigate} />;
  if (route.kind === "factory") return <FactoryPage token={token} request={request} productId={route.productId} runId={route.runId} navigate={navigate} registerNavigationGuard={registerNavigationGuard} />;
  if (route.kind === "product") return <ProductPage token={token} request={request} navigate={navigate} productId={route.productId} tab={route.tab} />;
  if (route.kind === "candidate") return <CreatorReviewPage token={token} request={request} runId={route.candidateId} onBack={() => navigate(`${ROOT}/products/${encodeURIComponent(route.productId)}/factory/${encodeURIComponent(route.candidateId)}`)} onRevision={(run) => navigate(`${ROOT}/products/${encodeURIComponent(route.productId)}/factory/${encodeURIComponent(run.id)}`)} onRelease={() => navigate(`${ROOT}/products/${encodeURIComponent(route.productId)}/preview`)} />;
  if (route.kind === "preview") return <PreviewPage token={token} request={request} navigate={navigate} productId={route.productId} />;
  if (route.kind === "release") return <ReleasePage token={token} request={request} navigate={navigate} productId={route.productId} releaseId={route.releaseId} />;
  if (route.kind === "orders") return <OrdersPage token={token} request={request} navigate={navigate} />;
  if (route.kind === "order") return <OrderPage token={token} request={request} navigate={navigate} orderId={route.orderId} />;
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
          <PageHeader eyebrow="Creator home" title={`${firstName(profile?.display_name)}, here’s the next useful step.`} body="Move one approved method from Factory to a shareable product, then follow who has access." />
          <section className="cpv2-grid cpv2-home-grid" aria-label="Creator overview">
            <article className="cpv2-card cpv2-next-card">
              <StatusChip status={next.tone}>{next.label}</StatusChip>
              <h2>{next.title}</h2>
              <p>{next.body}</p>
              <Button type="button" trailing={<span aria-hidden="true">→</span>} onClick={() => navigate(next.href)}>{next.action}</Button>
            </article>
            <article className="cpv2-card cpv2-balance-card">
              <span className="cpv2-kicker">Permanent access</span>
              <strong>{metrics.order_count ?? orders.length}</strong>
              <p>People who added one of your published products to their Hatch account.</p>
              <dl><div><dt>Products</dt><dd>{products.length}</dd></div><div><dt>Orders</dt><dd>{metrics.order_count ?? orders.length}</dd></div></dl>
              <Button className="cpv2-inverse" variant="secondary" type="button" onClick={() => navigate(`${ROOT}/orders`)}>View access records</Button>
            </article>
          </section>
          <SectionHeading eyebrow="Recent activity" title="Orders and access" action="View all orders" onAction={() => navigate(`${ROOT}/orders`)} />
          {orders.length ? <OrderList orders={orders} onOpen={(order) => navigate(`${ROOT}/orders/${encodeURIComponent(idOf(order, "order"))}`)} /> : <EmptyState title="No access records yet" body="Records appear here after someone adds a published product to their account." />}
        </>;
      }}
    </PageBoundary>
  );
}

function ProductsPage({ token, request, navigate }) {
  const resource = useRemote(request, "/v1/creator/products", token);
  const runsResource = useRemote(request, "/v1/creator/factory-runs", token);
  const pendingRuns = useMemo(() => runsResource.state === "ready"
    ? arrayOf(unwrap(runsResource.data, "runs")).filter((run) => ["queued", "running", "waiting_for_creator", "awaiting_answers", "needs_attention"].includes(run.status) || run.stage === "review_required")
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
          <PageHeader eyebrow="Products" title="From a method to a product people can use." body="A Task owns its private Source Library. Factory then evaluates a candidate, and Release makes the approved result available." action="Create product" onAction={() => navigate(`${ROOT}/sources`)} />
          {pendingRuns.length ? <PendingFactoryRuns runs={pendingRuns} navigate={navigate} /> : null}
          {products.length ? <section className="cpv2-product-grid" aria-label="Products">
            {products.map((product) => <ProductCard key={idOf(product, "product")} product={product} onOpen={() => navigate(`${ROOT}/products/${encodeURIComponent(idOf(product, "product"))}`)} />)}
          </section> : pendingRuns.length ? null : <EmptyState title="Create your first product" body="Start with one narrow Task, upload local source files, and let Factory turn the method into a verified candidate." action="Open Source Library" onAction={() => navigate(`${ROOT}/sources`)} />}
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
      <p>{run.stage === "review_required" ? "Review the candidate and confirm the correction loop before a new revision is built." : ["waiting_for_creator", "awaiting_answers"].includes(run.status) ? "Answer the pending Factory questions to continue." : run.status === "needs_attention" ? "Review the failed checkpoint and retry when it is safe." : "Distillation is running. Candidate review will appear as soon as the verified Corpus is ready."}</p>
      <div className="cpv2-card-foot"><small>{run.updated_at ? `Updated ${dateTime(run.updated_at)}` : "Saved on server"}</small><Button variant="secondary" type="button" onClick={() => navigate(`${ROOT}/factory/${encodeURIComponent(run.id)}`)}>Open Factory</Button></div>
    </article>)}</div>
  </section>;
}

function ProductCard({ product, onOpen }) {
  return <article className="cpv2-card cpv2-product-card">
    <div className="cpv2-card-top"><StatusChip status={product.status}>{productStatus(product.status)}</StatusChip><span>{product.status === "published" ? "Permanent access" : "Not published"}</span></div>
    <h2>{product.name ?? product.product_name ?? "Untitled product"}</h2>
    <p>{product.promise ?? product.description ?? "Add a clear Buyer-facing promise."}</p>
    <div className="cpv2-card-foot"><small>{shortDigest(product.corpus_digest ?? product.active_release?.corpus_digest)}</small><Button variant="secondary" type="button" onClick={onOpen}>Open product</Button></div>
  </article>;
}

function ProductPage({ token, request, navigate, productId, tab }) {
  const resource = useRemote(request, `/v1/creator/products/${encodeURIComponent(productId)}`, token);
  return (
    <PageBoundary resource={resource} title="We couldn't load this product">
      {(payload) => {
        const product = unwrap(payload, "product") ?? payload;
        const candidate = candidateOf(product);
        const next = productNextAction(product, candidate);
        return <>
          <Breadcrumb onClick={() => navigate(`${ROOT}/products`)}>Products</Breadcrumb>
          <PageHeader eyebrow={productStatus(product.status)} title={product.name ?? product.product_name ?? "Untitled product"} body={product.promise ?? product.description ?? "Define the product promise and boundaries before publishing."} action={next.action} onAction={() => navigate(next.href(productId, candidate))} />
          <ProductTabs productId={productId} active={tab} navigate={navigate} />
          {tab === "overview" ? <ProductOverview product={product} candidate={candidate} navigate={navigate} token={token} request={request} onChanged={resource.retry} /> : null}
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
  return <HatchTabs
    className="cpv2-tabs"
    value={active}
    ariaLabel="Product sections"
    onValueChange={(value) => navigate(`${ROOT}/products/${encodeURIComponent(productId)}/${value}`)}
    items={PRODUCT_TABS.map(([value, label]) => ({ value, label }))}
  />;
}

function ProductOverview({ product, candidate, navigate, token, request, onChanged }) {
  const productId = idOf(product, "product");
  const alreadyPublished = product.status === "published" || product.status === "live";
  const [withdraw, setWithdraw] = useState({ reason: "", confirming: false, busy: false, error: "", done: false });
  const steps = [
    { label: "Factory candidate", done: Boolean(candidate || alreadyPublished || product.corpus_digest), action: "Open Factory", href: `${ROOT}/products/${encodeURIComponent(productId)}/factory` },
    { label: "Candidate approval", done: isApproved(candidate) || alreadyPublished, action: "Review candidate", href: candidate ? `${ROOT}/products/${encodeURIComponent(productId)}/candidates/${encodeURIComponent(idOf(candidate, "candidate"))}` : null },
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
      <ol>{steps.map((step, index) => <li key={step.label} className={step.done ? "is-done" : ""}><span>{step.done ? "✓" : index + 1}</span><strong>{step.label}</strong>{step.href ? step.external ? <Button asChild variant="link" size="small"><a href={safePublicUrl(step.href)} target="_blank" rel="noreferrer">{step.action}</a></Button> : <Button variant="link" size="small" type="button" onClick={() => navigate(step.href)}>{step.action}</Button> : <small>Complete the previous step</small>}</li>)}</ol>
    </article>
    <article className="cpv2-card cpv2-facts"><span className="cpv2-kicker">Current Product</span><dl><Fact label="Candidate" value={candidate ? `v${candidate.version ?? "—"} · ${approvalLabel(candidate)}` : "Not ready"} /><Fact label="Access" value="Free · Permanent access" /><Fact label="Release" value={product.active_release?.label ?? product.release?.label ?? product.release_label ?? "Not published"} /><Fact label="Public URL" value={product.public_url ?? "Not public"} /></dl></article>
  </div>{withdraw.error ? <InlineError>{withdraw.error}</InlineError> : null}{withdraw.done ? <SuccessNotice>The Product was withdrawn. Existing receipts and access remain available.</SuccessNotice> : null}{alreadyPublished ? <article className="cpv2-card cpv2-panel cpv2-withdraw"><SectionHeading eyebrow="Product lifecycle" title="Withdraw this Product" /><p>Withdrawal stops new access. It does not erase immutable releases, receipts, or existing access.</p><FormField label="Audit reason"><Textarea value={withdraw.reason} onChange={(event) => setWithdraw((current) => ({ ...current, reason: event.target.value, confirming: false }))} placeholder="Why should new access stop?" /></FormField>{withdraw.confirming ? <div className="cpv2-confirm"><p><strong>Withdraw the public Product?</strong><br />People with existing access keep their records.</p><Button variant="secondary" type="button" onClick={() => setWithdraw((current) => ({ ...current, confirming: false }))}>Cancel</Button><Button variant="danger" type="button" loading={withdraw.busy} disabled={!withdraw.reason.trim()} onClick={withdrawProduct}>Confirm withdrawal</Button></div> : <Button variant="danger" type="button" disabled={!withdraw.reason.trim()} onClick={() => setWithdraw((current) => ({ ...current, confirming: true }))}>Review withdrawal</Button>}</article> : null}</>;
}

function TestPanel({ product, candidate, navigate }) {
  const gates = arrayOf(candidate?.gates ?? product.evaluation?.gates);
  return <article className="cpv2-card cpv2-panel"><SectionHeading eyebrow="Evaluation" title="Behavior evidence" />{gates.length ? <ul className="cpv2-gates">{gates.map((gate, index) => <li key={gate.id ?? index}><StatusChip status={gate.passed === false ? "failed" : "passed"}>{gate.passed === false ? "Failed" : "Passed"}</StatusChip><span><strong>{gate.name ?? gate.label ?? `Gate ${index + 1}`}</strong><small>{gate.detail ?? gate.message ?? "Deterministic evaluation gate"}</small></span></li>)}</ul> : <EmptyInline>No evaluation report is available yet.</EmptyInline>}{candidate ? <Button variant="secondary" type="button" onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(idOf(product, "product"))}/candidates/${encodeURIComponent(idOf(candidate, "candidate"))}`)}>Open candidate report</Button> : null}</article>;
}

function ExamplesPanel({ product }) {
  const examples = arrayOf(product.examples ?? product.presentation?.examples);
  return <article className="cpv2-card cpv2-panel"><SectionHeading eyebrow="Buyer proof" title="Representative examples" />{examples.length ? <div className="cpv2-examples">{examples.map((example, index) => <section key={example.id ?? index}><h3>{example.title ?? `Example ${index + 1}`}</h3><p>{example.summary ?? example.description ?? String(example)}</p></section>)}</div> : <EmptyInline>Add client-safe examples before publishing. Protected instructions never appear here.</EmptyInline>}</article>;
}

function VersionsPanel({ product, candidate, productId, navigate }) {
  const releases = arrayOf(product.releases).length ? arrayOf(product.releases) : (product.release ? [{ ...product.release, current: true }] : []);
  return <article className="cpv2-card cpv2-panel"><SectionHeading eyebrow="Immutable history" title="Candidates and releases" />{candidate ? <NavigationItem className="cpv2-version" onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}/candidates/${encodeURIComponent(idOf(candidate, "candidate"))}`)} trailing={<StatusChip status={candidate.status}>{approvalLabel(candidate)}</StatusChip>}><span><strong>Candidate v{candidate.version ?? "—"}</strong><small>{shortDigest(candidate.digest)}</small></span></NavigationItem> : null}{releases.map((release) => <NavigationItem className="cpv2-version" type="button" key={idOf(release, "release")} onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}/releases/${encodeURIComponent(idOf(release, "release"))}`)} trailing={<StatusChip status={release.current ? "published" : "retired"}>{release.current ? "Current" : "Previous"}</StatusChip>}><span><strong>{release.label ?? `Release ${release.version ?? ""}`}</strong><small>{shortDigest(release.corpus_digest ?? release.digest)}</small></span></NavigationItem>)}{!candidate && !releases.length ? <EmptyInline>No candidate or release exists yet.</EmptyInline> : null}</article>;
}

function DataControlsPanel({ product }) {
  const boundaries = arrayOf(product.boundaries ?? product.product_boundaries);
  return <div className="cpv2-detail-grid"><article className="cpv2-card cpv2-panel"><SectionHeading eyebrow="Product boundaries" title="What this product will not do" />{boundaries.length ? <ul className="cpv2-bullets">{boundaries.map((item, index) => <li key={index}>{typeof item === "string" ? item : item.label ?? item.description}</li>)}</ul> : <EmptyInline>Add explicit boundaries before publishing.</EmptyInline>}</article><article className="cpv2-card cpv2-panel"><SectionHeading eyebrow="Privacy" title="Buyer work stays private" /><p>Access records never include Workspace paths, conversations, tool arguments, file content, or artifacts.</p><dl><Fact label="Corpus digest" value={shortDigest(product.corpus_digest ?? product.active_release?.corpus_digest)} /><Fact label="Version policy" value={product.version_policy ?? "Pinned to purchased release"} /></dl></article></div>;
}

function FactoryPage({ token, request, productId, runId, navigate, registerNavigationGuard }) {
  const runBase = productId
    ? `${ROOT}/products/${encodeURIComponent(productId)}/factory/runs`
    : `${ROOT}/factory`;
  if (productId === undefined) return <>
    <div className="cpv2-factory-bar"><Button variant="link" size="small" type="button" onClick={() => navigate(`${ROOT}/products`)}>← Back to products</Button><span role="status">Open a saved run to continue questions, retry a checkpoint, or inspect progress.</span></div>
    <CreatorFactoryRuns
      token={token}
      initialRunId={runId}
      onNavigateRun={(id) => navigate(id ? `${runBase}/${encodeURIComponent(id)}` : `${ROOT}/factory`)}
      onOpenSources={() => navigate(`${ROOT}/sources`)}
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
    <div className="cpv2-factory-bar"><Button variant="link" size="small" type="button" onClick={() => navigate(productId ? `${ROOT}/products/${encodeURIComponent(productId)}` : `${ROOT}/products`)}>← {productId ? "Back to product" : "Back to products"}</Button><span role="status">Factory run checkpoints are saved on the server when submitted.</span></div>
    <FactoryReviewLink token={token} request={request} productId={productId} navigate={navigate} />
    <CreatorFactoryRuns token={token} initialRunId={runId} onOpenSources={() => navigate(`${ROOT}/sources`)} onNavigateRun={(id) => navigate(id ? `${runBase}/${encodeURIComponent(id)}` : `${ROOT}/products/${encodeURIComponent(productId)}/factory`)} onReviewCandidate={(run) => navigate(`${ROOT}/products/${encodeURIComponent(productId)}/candidates/${encodeURIComponent(run.id)}`)} />
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
  if (!reviewReady) return <aside className="cpv2-factory-ready is-waiting" role="status"><div><strong>Factory is tracking this product.</strong><small>The review action appears as soon as a verified candidate is ready.</small></div><Button variant="secondary" type="button" onClick={resource.retry}>Refresh status</Button></aside>;
  return <aside className="cpv2-factory-ready" role="status"><div><strong>Candidate v{candidate.version ?? "—"} is ready for review.</strong><small>{shortDigest(candidate.digest)}</small></div><Button type="button" onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}/candidates/${encodeURIComponent(idOf(candidate, "candidate"))}`)}>Review candidate</Button><Button variant="secondary" type="button" onClick={resource.retry}>Refresh status</Button></aside>;
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
      navigate(runId ? `${ROOT}/factory/${encodeURIComponent(runId)}` : `${ROOT}/factory`);
    } catch (nextError) { setError(friendlyError(nextError)); }
    finally { setStarting(false); }
  }

  return <>
    <Breadcrumb onClick={() => navigate(`${ROOT}/products`)}>Products</Breadcrumb>
    <PageHeader eyebrow="Creator Factory" title="Define one task worth delivering." body="This server draft autosaves after a short pause. Starting distillation remains an explicit action." />
    {error ? <InlineError>{error}</InlineError> : null}
    <form className="cpv2-card cpv2-factory-draft" onSubmit={start} onBlur={() => { if (dirty) persist(draft).catch(() => undefined); }}>
      <AutosaveStatus
        className="cpv2-save-state"
        state={saveState === "Saving…" ? "saving" : saveState === "Couldn't save" ? "error" : saveState.startsWith("Saved") ? "saved" : dirty ? "dirty" : "ready"}
        detail={saveState.startsWith("Saved") ? saveState.slice(6) : undefined}
        onRetry={() => persist(draft).catch(() => undefined)}
      />
      <FormField label="Task name" required><Input required value={draft.task_name} onChange={(event) => changeDraft({ task_name: event.target.value })} placeholder="e.g. Signal Resume Review" /></FormField>
      <FormField label="Task promise" required><Textarea required value={draft.task_brief} onChange={(event) => changeDraft({ task_brief: event.target.value })} placeholder="What does the Buyer provide, and what finished result do they receive?" /></FormField>
      <div className="cpv2-source-heading"><div><span className="cpv2-kicker">Authorized sources</span><h2>Source material</h2></div><Button variant="link" size="small" type="button" onClick={() => changeDraft((current) => ({ ...current, sources: [...current.sources, { id: `S${current.sources.length + 1}`, title: "", authority: "private_material", content: "" }] }))}>+ Add source</Button></div>
      {draft.sources.map((source, index) => <fieldset className="cpv2-source" key={source.id ?? index}><legend>{source.id ?? `S${index + 1}`}</legend>{draft.sources.length > 1 ? <Button className="cpv2-source-remove" variant="link" size="small" type="button" onClick={() => changeDraft((current) => ({ ...current, sources: current.sources.filter((_, sourceIndex) => sourceIndex !== index).map((item, sourceIndex) => ({ ...item, id: `S${sourceIndex + 1}` })) }))}>Remove</Button> : null}<FormField label="Source title" required><Input required value={source.title ?? ""} onChange={(event) => updateSource(index, "title", event.target.value)} /></FormField><FormField label="Authority"><Select label="Authority" value={source.authority ?? "private_material"} onValueChange={(value) => updateSource(index, "authority", value)} options={[{ value: "creator_current", label: "Current correction or demonstration" }, { value: "creator_example", label: "Canonical example" }, { value: "private_material", label: "Private course or document" }, { value: "public_context", label: "Public context" }]} /></FormField><FormField label="Source content" required><Textarea required value={source.content ?? ""} onChange={(event) => updateSource(index, "content", event.target.value)} /></FormField></fieldset>)}
      <div className="cpv2-draft-actions"><p>Private source text is stored only in the authenticated server draft; this page does not put it in localStorage.</p><Button type="submit" loading={starting}>Start distillation</Button></div>
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
      navigate(action === "approve" ? `${ROOT}/products/${encodeURIComponent(productId)}/preview` : `${ROOT}/products/${encodeURIComponent(productId)}/versions`);
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
    // The candidate endpoint returns the version that was read together with
    // this immutable candidate/report snapshot. Prefer it over the separate
    // Product request: those two reads can complete in either order while a
    // deployment reconciler is updating the same workflow record.
    const expectedVersion = candidate?.resource_version ?? product?.resource_version ?? product?.version ?? 0;
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
        {losses.length ? <fieldset className="cpv2-losses"><legend>Known non-critical losses</legend>{losses.map((loss, index) => { const lossId = loss?.id ?? String(index); return <Checkbox key={lossId} checked={acknowledged.includes(lossId)} onCheckedChange={(checked) => setAcknowledged((current) => checked ? [...current, lossId] : current.filter((id) => id !== lossId))} label={loss?.title ?? loss?.label ?? `Loss ${index + 1}`} description={loss?.description ?? loss?.detail ?? String(loss)} />; })}</fieldset> : null}
      </article>
      <div className="cpv2-action-bar"><div><strong>Approval is immutable for this digest.</strong><small>Any candidate or report change invalidates it.</small></div>{confirmReject ? <><span>Archive this candidate?</span><Button variant="danger" type="button" loading={mutation.state === "reject"} disabled={busy} onClick={() => decide("reject", candidate, expectedVersion)}>Yes, reject</Button><Button variant="secondary" type="button" onClick={() => setConfirmReject(false)}>Cancel</Button></> : <Button variant="secondary" type="button" disabled={busy || alreadyApproved} onClick={() => setConfirmReject(true)}>Reject candidate</Button>}<Button type="button" loading={mutation.state === "approve"} disabled={busy || criticalFailed || !allAcknowledged || alreadyApproved} onClick={() => decide("approve", candidate, expectedVersion)}>{alreadyApproved ? "Approved" : "Approve candidate"}</Button></div>
    </>;
  }}</PageBoundary>;
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
      const result = await request(`/v1/creator/products/${encodeURIComponent(productId)}/release`, { method: "POST", token, headers: { "idempotency-key": mutationKey() }, body: JSON.stringify({ candidate_id: idOf(preview.candidate, "candidate"), report_digest: preview.candidate?.report_digest ?? preview.candidate?.evaluation_digest, expected_version: preview.resource_version ?? preview.product?.resource_version ?? preview.product?.version }) });
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
    const publicUrl = canonicalPublicUrl(published.canonical_url ?? published.public_url ?? published.product?.canonical_url ?? published.product?.public_url)
      ?? (isUuidV4(productId) ? `/products/${productId}` : undefined);
    return <section className="cpv2-published" aria-live="polite"><span aria-hidden="true">✓</span><h1>Your Product is live</h1><p>People can now purchase this immutable release at no charge and keep permanent access.</p><FormField label="Share link"><Input readOnly value={publicUrl ?? "Publication completed"} onFocus={(event) => event.target.select()} /></FormField><div>{publicUrl ? <Button type="button" onClick={() => copy(publicUrl)}>{copied ? "Copied" : "Copy link"}</Button> : null}{publicUrl ? <Button asChild variant="secondary"><a href={safePublicUrl(publicUrl)} target="_blank" rel="noreferrer">View storefront</a></Button> : null}<Button variant="secondary" type="button" onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}`)}>Back to Product</Button></div>{error ? <InlineError>{error}</InlineError> : null}</section>;
  }

  return <PageBoundary resource={resource} title="We couldn't build the storefront preview">{(payload) => {
    const preview = payload?.preview && typeof payload.preview === "object"
      ? payload.preview
      : payload;
    const product = preview.product ?? preview;
    const candidate = preview.candidate ?? candidateOf(product);
    const readiness = normalizeReadiness(preview, candidate);
    const ready = readiness.every((item) => item.ready);
    return <>
      <Breadcrumb onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}`)}>Product</Breadcrumb>
      <PageHeader eyebrow="Storefront preview" title="See exactly what people will see." body="This preview is pinned to the approved candidate. Access is free and permanent after you publish." />
      {error ? <InlineError>{error}</InlineError> : null}
      <div className="cpv2-preview-tools"><span className="cpv2-private-badge">Not public</span><div role="group" aria-label="Preview viewport"><Button type="button" variant="ghost" size="small" className={viewport === "desktop" ? "is-active" : ""} aria-pressed={viewport === "desktop"} onClick={() => setViewport("desktop")}>Desktop</Button><Button type="button" variant="ghost" size="small" className={viewport === "mobile" ? "is-active" : ""} aria-pressed={viewport === "mobile"} onClick={() => setViewport("mobile")}>Mobile</Button></div></div>
      <div className={`cpv2-storefront-frame is-${viewport}`}><StorefrontDetails product={product} creatorName={preview.creator?.display_name ?? preview.creator_name} mode="preview" headingLevel={2} desktopRequirement={preview.desktop_requirement ?? product.desktop_requirement} releaseLabel={candidate ? `Candidate v${candidate.version ?? "—"} · ${candidate.digest ?? "digest not provided"}` : "Candidate not provided"} action={<Button type="button" disabled>Get access</Button>} /></div>
      <article className="cpv2-card cpv2-readiness"><SectionHeading eyebrow="Publish readiness" title="Final checks" /><ul>{readiness.map((item) => <li key={item.label} className={item.ready ? "is-ready" : ""}><span>{item.ready ? "✓" : "!"}</span><strong>{item.label}</strong><small>{item.detail}</small></li>)}</ul>{confirming ? <div className="cpv2-confirm cpv2-confirm-publish"><div><p><strong>Publish this immutable candidate?</strong><br />The public current pointer changes only after materialization succeeds.</p><dl className="cpv2-confirm-facts"><Fact label="Product" value={product.name ?? product.product_name ?? productId} /><Fact label="Candidate" value={`v${candidate?.version ?? "—"} · ${candidate?.digest ?? "Not provided"}`} /><Fact label="Access" value="Free · Permanent access" /><Fact label="Public URL" value={preview.public_url ?? (isUuidV4(productId) ? `/products/${productId}` : "Assigned after publish")} /></dl><small>Publishing creates an immutable release. Future changes require another release or an audited rollback.</small></div><Button variant="secondary" type="button" onClick={() => setConfirming(false)}>Cancel</Button><Button type="button" loading={publishing} disabled={!ready} onClick={() => publish({ ...preview, product, candidate })}>Confirm publish</Button></div> : <Button type="button" disabled={!ready} onClick={() => setConfirming(true)}>Publish</Button>}</article>
    </>;
  }}</PageBoundary>;
}

function ReleasePage({ token, request, navigate, productId, releaseId }) {
  const resource = useRemote(request, `/v1/creator/products/${encodeURIComponent(productId)}`, token);
  const [state, setState] = useState({ busy: false, error: "", done: false, reason: "", confirming: false });
  return <PageBoundary resource={resource} title="We couldn't load this release">{(payload) => {
    const product = unwrap(payload, "product") ?? payload;
    const release = arrayOf(product.releases).find((item) => idOf(item, "release") === releaseId) ?? (idOf(product.release, "release") === releaseId ? { ...product.release, current: true } : null) ?? product.active_release;
    if (!release) return <RouteProblem title="Release not found" body="This release is not present in the product history." action="Back to versions" onAction={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}/versions`)} />;
    async function rollback() {
      if (!state.reason.trim()) return;
      setState((current) => ({ ...current, busy: true, error: "", done: false }));
      try {
        await request(`/v1/creator/products/${encodeURIComponent(productId)}/releases/${encodeURIComponent(releaseId)}/rollback`, {
          method: "POST",
          token,
          headers: { "idempotency-key": mutationKey() },
          body: JSON.stringify({ expected_version: product.resource_version, reason: state.reason.trim() })
        });
        setState((current) => ({ ...current, busy: false, error: "", done: true, confirming: false }));
        resource.retry();
      } catch (error) { setState((current) => ({ ...current, busy: false, error: friendlyError(error), done: false })); }
    }
    return <><Breadcrumb onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}/versions`)}>Versions</Breadcrumb><PageHeader eyebrow="Immutable release" title={release.label ?? `Release ${release.version ?? ""}`} body="Existing access remains pinned to the release it received." />{state.error ? <InlineError>{state.error}</InlineError> : null}{state.done ? <SuccessNotice>Current release updated. Existing access was not changed.</SuccessNotice> : null}<article className="cpv2-card cpv2-panel"><dl className="cpv2-fact-grid"><Fact label="Release ID" value={idOf(release, "release")} /><Fact label="Corpus digest" value={release.corpus_digest ?? release.digest} /><Fact label="Published" value={dateTime(release.published_at ?? release.created_at)} /><Fact label="Access" value="Free · Permanent access" /><Fact label="Status" value={release.current ? "Current" : "Previous"} /><Fact label="Materialization" value={release.materialization_status ?? "Not reported"} /></dl></article>{release.current ? <p className="cpv2-muted">This is already the public current release.</p> : <section className="cpv2-rollback"><article className="cpv2-card cpv2-panel"><SectionHeading eyebrow="Rollback" title="Make this exact release current" /><p>The release is fixed by this page. Existing access stays pinned to its original release.</p><FormField label="Release"><Input readOnly value={`${release.label ?? releaseId} · ${release.corpus_digest ?? release.digest ?? "digest not provided"}`} /></FormField><FormField label="Audit reason" required><Textarea required value={state.reason} onChange={(event) => setState((current) => ({ ...current, reason: event.target.value, confirming: false }))} placeholder="Why should this release become current?" /></FormField></article><div className="cpv2-rollback-preview"><span className="cpv2-private-badge">Rollback preview · Not public</span><StorefrontDetails product={product} creatorName={product.creator_name} mode="preview" headingLevel={2} desktopRequirement={product.desktop_requirement} releaseLabel={`${release.label ?? releaseId} · ${release.corpus_digest ?? release.digest ?? "digest not provided"}`} action={<Button type="button" disabled>Get access</Button>} /></div>{state.confirming ? <div className="cpv2-card cpv2-confirm cpv2-confirm-publish" role="alert"><div><strong>Make this exact release current?</strong><p>{state.reason}</p><small>This writes an authenticated rollback audit. Existing access keeps its original release.</small></div><Button variant="secondary" type="button" onClick={() => setState((current) => ({ ...current, confirming: false }))}>Cancel</Button><Button type="button" loading={state.busy} disabled={!state.reason.trim()} onClick={rollback}>Confirm rollback</Button></div> : <Button type="button" disabled={!state.reason.trim()} onClick={() => setState((current) => ({ ...current, confirming: true }))}>Review rollback</Button>}</section>}</>;
  }}</PageBoundary>;
}

function OrdersPage({ token, request, navigate }) {
  const [filters, setFilters] = useState({ order: "", product: "", from: "", to: "", limit: "25" });
  const query = useMemo(() => creatorOrderQuery(filters), [filters]);
  const resource = useRemote(request, `/v1/creator/orders${query ? `?${query}` : ""}`, token);
  return <PageBoundary resource={resource} title="We couldn't load orders">{(payload) => {
    return <>
      <PageHeader eyebrow="Access records" title="See who can use each product." body="Follow access without exposing anyone’s private Workspace content." />
      <form className="cpv2-filters" onSubmit={(event) => event.preventDefault()}>
        <FormField label="Order status"><Select label="Order status" value={filters.order || "all"} onValueChange={(value) => setFilters((current) => ({ ...current, order: value === "all" ? "" : value }))} options={[{ value: "all", label: "All" }, { value: "fulfilled", label: "Fulfilled" }, { value: "refund_pending", label: "Refund pending" }, { value: "refunded", label: "Refunded" }, { value: "failed", label: "Failed" }]} /></FormField>
        <FormField label="Product ID"><Input value={filters.product} onChange={(event) => setFilters((current) => ({ ...current, product: event.target.value }))} placeholder="All products" /></FormField>
        <FormField label="From date"><Input type="date" value={filters.from} max={filters.to || undefined} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} /></FormField>
        <FormField label="To date"><Input type="date" value={filters.to} min={filters.from || undefined} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} /></FormField>
        <FormField label="Rows per page"><Select label="Rows per page" value={filters.limit} onValueChange={(value) => setFilters((current) => ({ ...current, limit: value }))} options={[{ value: "12", label: "12" }, { value: "25", label: "25" }, { value: "50", label: "50" }, { value: "100", label: "100" }]} /></FormField>
        <Button variant="secondary" type="button" onClick={() => setFilters({ order: "", product: "", from: "", to: "", limit: "25" })}>Clear filters</Button>
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
  return <><div className="cpv2-pagination-status" role="status">Loaded {page.orders.length} order{page.orders.length === 1 ? "" : "s"}{page.cursor ? "; more are available" : "; end of results"}.</div><OrderList orders={page.orders} onOpen={(order) => navigate(`${ROOT}/orders/${encodeURIComponent(order.order_number ?? order.order_reference ?? idOf(order, "order"))}`)} detailed />{error ? <InlineError>{error}</InlineError> : null}{page.cursor ? <Button className="cpv2-load-more" variant="secondary" type="button" loading={loadingMore} onClick={loadMore}>Load next page</Button> : null}</>;
}

function OrderList({ orders, onOpen, detailed = false }) {
  return <div className="cpv2-order-list" role="list">{orders.map((order) => { const reference = order.order_number ?? order.order_reference ?? idOf(order, "order"); return <article className="cpv2-order" role="listitem" key={idOf(order, "order")}><div><span className="cpv2-kicker">{reference}</span><h2>{order.product_name ?? order.product?.name ?? "Product access"}</h2><p>{order.buyer_display_name ?? "Buyer"} · {dateTime(order.created_at ?? order.placed_at)}</p></div><dl><Fact label="Access" value={humanStatus(order.entitlement_status ?? order.status ?? order.order_status)} />{detailed ? <Fact label="Access status" value={humanStatus(order.access_status ?? order.entitlement_status ?? order.status ?? "active")} /> : null}</dl><Button variant="secondary" type="button" onClick={() => onOpen(order)} aria-label={`View access record ${reference}`}>View record</Button></article>; })}</div>;
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
    return <>
      <Breadcrumb onClick={() => navigate(`${ROOT}/orders`)}>Orders</Breadcrumb>
      <PageHeader eyebrow={order.order_reference ?? orderId} title={order.product_name ?? order.product?.name ?? "Order detail"} body={`${order.buyer_display_name ?? "Buyer"} · ${dateTime(order.created_at ?? order.placed_at)}`} />
      {refund.error ? <InlineError>{refund.error}</InlineError> : null}
      {refund.done ? <SuccessNotice>The refund request was recorded. Refreshing the authoritative order state.</SuccessNotice> : null}
      <div className="cpv2-detail-grid">
        <article className="cpv2-card cpv2-panel">
          <SectionHeading eyebrow="Access record" title="What the Buyer received" />
          <dl className="cpv2-fact-grid">
            <Fact label="Access" value={humanStatus(order.entitlement_status ?? order.access?.status)} />
            <Fact label="Release" value={order.release_id ?? order.release_label ?? order.corpus_digest ?? "Not provided"} />
            <Fact label="Revocation" value={humanStatus(order.refund_status ?? order.refund?.status ?? (order.refund ? "completed" : "none"))} />
          </dl>
        </article>
        <article className="cpv2-card cpv2-panel">
          <SectionHeading eyebrow="Access metadata" title="Private by design" />
          <dl>
            <Fact label="Status" value={humanStatus(order.access_status ?? order.entitlement_status ?? order.status ?? "active")} />
            <Fact label="Access mode" value={order.access_mode === "unmetered" ? "Permanent" : "Metered"} />
            <Fact label="Release" value={order.release_id ?? order.release_label ?? order.corpus_digest ?? "Not provided"} />
          </dl>
          <p className="cpv2-muted">Workspace paths, conversations, file content, tool arguments, and artifacts are never shown here.</p>
        </article>
      </div>
      <article className="cpv2-card cpv2-panel cpv2-timeline">
        <SectionHeading eyebrow="Timeline" title="Access history" />
        <ol>{safeEvents.map((event, index) => <li key={event.id ?? event.event_id ?? index}><span aria-hidden="true" /><div><strong>{event.label ?? humanStatus(event.type ?? event.event_type)}</strong><small>{dateTime(event.at ?? event.created_at ?? event.occurred_at)}</small>{event.detail ? <p>{event.detail}</p> : null}</div></li>)}</ol>
      </article>
      <article className="cpv2-card cpv2-panel cpv2-refund-action">
        <SectionHeading eyebrow="Order action" title="Revoke access" />
        {canRefund ? <><p>A reason is required for the audit record.</p><FormField label="Reason"><Textarea value={refund.reason} onChange={(event) => setRefund((current) => ({ ...current, reason: event.target.value, confirming: false }))} placeholder="Reason for revoking this access" /></FormField>{refund.confirming ? <div className="cpv2-confirm"><p><strong>Revoke this access?</strong><br />The entitlement will no longer be usable in Hatch Desktop.</p><Button variant="secondary" type="button" onClick={() => setRefund((current) => ({ ...current, confirming: false }))}>Cancel</Button><Button variant="danger" type="button" loading={refund.busy} disabled={!refund.reason.trim()} onClick={requestRefund}>Confirm revoke</Button></div> : <Button variant="danger" type="button" disabled={!refund.reason.trim()} onClick={() => setRefund((current) => ({ ...current, confirming: true }))}>Review revoke</Button>}</> : <p className="cpv2-muted">No revoke action is available for this order state.</p>}
      </article>
    </>;
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
  return <HatchPageHeader className="cpv2-page-header" label={eyebrow} title={title} body={body} titleRef={headingRef} actions={action ? <Button type="button" onClick={onAction}>{action}</Button> : null} />;
}

function SectionHeading({ eyebrow, title, action, onAction }) {
  return <HatchSectionHeader className="cpv2-section-heading" label={eyebrow} title={title} actions={action ? <Button variant="link" type="button" onClick={onAction}>{action} →</Button> : null} />;
}

function Breadcrumb({ children, onClick }) { return <HatchBreadcrumbs className="cpv2-breadcrumb" items={[{ label: children, href: "#", icon: false, onClick: (event) => { event.preventDefault(); onClick(); } }]} />; }
function StatusChip({ status, children }) { const tone = statusTone(status); return <HatchStatusTag tone={tone === "danger" ? "error" : tone}>{children}</HatchStatusTag>; }
function Fact({ label, value }) { const missing = value === undefined || value === null || value === ""; return <div><dt>{label}</dt><dd title={typeof value === "string" ? value : undefined}>{missing ? "—" : value}</dd></div>; }
function InlineError({ children }) { return <HatchInlineAlert className="cpv2-alert" tone="error">{children}</HatchInlineAlert>; }
function SuccessNotice({ children }) { return <HatchInlineAlert className="cpv2-success" tone="success">{children}</HatchInlineAlert>; }
function EmptyInline({ children }) { return <p className="cpv2-empty-inline">{children}</p>; }

function EmptyState({ title, body, action, onAction }) {
  return <HatchEmptyState className="cpv2-empty" title={title} body={body} action={action ? { label: action, onClick: onAction } : undefined} />;
}

function RouteProblem({ title, body, action, onAction }) {
  return <UnavailableState className="cpv2-problem" title={title} body={body} action={action ? { label: action, onClick: onAction } : undefined} />;
}

function LoadingState() {
  return <section className="cpv2-loading" aria-busy="true" aria-label="Loading creator page"><Skeleton lines={4} /></section>;
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
  if (!products.length) return { label: "Start here", tone: "draft", title: "Create one focused product", body: "Define the task and authorized sources in Factory.", action: "Open Factory", href: `${ROOT}/factory` };
  for (const product of products) {
    const candidate = candidateOf(product);
    const next = productNextAction(product, candidate);
    if (product.status !== "published" && product.status !== "live") return { label: productStatus(product.status), tone: product.status, title: product.name ?? product.product_name, body: product.promise ?? product.description ?? "Continue the publishing workflow.", action: next.action, href: next.href(idOf(product, "product"), candidate) };
  }
  const product = products[0];
  return { label: "Live", tone: "published", title: product.name ?? product.product_name, body: "Your storefront is live. Share it or inspect the latest orders.", action: "View product", href: `${ROOT}/products/${encodeURIComponent(idOf(product, "product"))}` };
}

function productNextAction(product, candidate) {
  if ((product.status === "published" || product.status === "live") && !candidate) return { action: "Preview storefront", href: (id) => `${ROOT}/products/${encodeURIComponent(id)}/preview` };
  if (!candidate) return { action: "Continue in Factory", href: (id) => `${ROOT}/products/${encodeURIComponent(id)}/factory` };
  if (!isApproved(candidate)) return { action: "Review candidate", href: (id, value) => `${ROOT}/products/${encodeURIComponent(id)}/candidates/${encodeURIComponent(idOf(value, "candidate"))}` };
  if (product.status !== "published" && product.status !== "live") return { action: "Preview storefront", href: (id) => `${ROOT}/products/${encodeURIComponent(id)}/preview` };
  return { action: "Preview storefront", href: (id) => `${ROOT}/products/${encodeURIComponent(id)}/preview` };
}

function candidateOf(product) { const candidate = product?.candidate ?? product?.current_candidate ?? product?.latest_candidate ?? (product?.candidate_id ? { candidate_id: product.candidate_id, status: product.candidate_status, version: product.candidate_version, digest: product.candidate_digest } : null); return candidate ? { ...candidate, approval_status: product?.approval?.status ?? candidate.approval_status, approved: product?.approval?.status === "approved" || candidate.approved } : null; }
function isApproved(candidate) { return ["approved", "publish_ready"].includes(candidate?.approval_status) || candidate?.approved === true || candidate?.status === "approved"; }
function approvalLabel(candidate) { if (isApproved(candidate)) return "Approved"; if (["ready", "ready_for_review", "review_ready"].includes(candidate?.status ?? candidate?.run_status)) return "Ready for review"; return humanStatus(candidate?.status ?? candidate?.run_status ?? "preparing"); }

function normalizeReadiness(preview, candidate) {
  const provided = arrayOf(preview?.readiness ?? preview?.checks);
  if (provided.length) return provided.map((item) => typeof item === "string" ? { label: item, detail: "Ready", ready: true } : { label: item.label ?? item.name, detail: item.detail ?? item.message ?? (item.ready === false ? "Needs attention" : "Ready"), ready: item.ready ?? item.passed ?? item.status === "ready" });
  if (preview?.readiness && !Array.isArray(preview.readiness)) return [
    { label: "Candidate approval is current", detail: preview.readiness.candidate_approved ? "Bound to this candidate digest" : "Approve the candidate first", ready: Boolean(preview.readiness.candidate_approved) },
    { label: "Permanent access is configured", detail: "No charge", ready: true },
    { label: "Registry materialization", detail: preview.readiness.ready ? "Ready to materialize on publish" : "Complete the required checks", ready: Boolean(preview.readiness.ready) }
  ];
  return [
    { label: "Candidate approval is current", detail: isApproved(candidate) ? "Bound to this candidate digest" : "Approve the candidate first", ready: isApproved(candidate) },
    { label: "Permanent access is configured", detail: "No charge", ready: true },
    { label: "Public copy and boundaries", detail: preview?.product?.promise || preview?.promise ? "Buyer-facing copy present" : "Add a product promise", ready: Boolean(preview?.product?.promise || preview?.promise || preview?.product?.description) },
    { label: "Registry materialization", detail: preview?.materialization_status === "failed" ? "Materialization failed" : "Ready to materialize on publish", ready: preview?.materialization_status !== "failed" }
  ];
}

function inferredTimeline(order) {
  const events = [{ label: "Order created", at: order.created_at ?? order.placed_at }];
  if (order.created_at || order.placed_at) events.push({ label: "Purchase recorded", at: order.created_at ?? order.placed_at });
  if (order.entitlement_status) events.push({ label: `Access ${humanStatus(order.entitlement_status)}`, at: order.entitlement_at });
  if (order.access_mode !== "unmetered" && order.delivery_status && !["not_started", "not_applicable"].includes(order.delivery_status)) events.push({ label: `Access ${humanStatus(order.delivery_status)}`, at: order.delivery_completed_at ?? order.delivery_started_at });
  if (order.refund_status && order.refund_status !== "none") events.push({ label: `Refund ${humanStatus(order.refund_status)}`, at: order.refunded_at });
  return events;
}

function productStatus(status) { return ({ published: "Published", live: "Published", candidate_required: "Factory required", candidate_ready: "Ready for review", candidate_rejected: "Candidate rejected", ready_to_preview: "Ready to preview", ready_to_publish: "Ready to publish", ready_for_review: "Ready for review", review_ready: "Ready for review", preparing: "Factory running", needs_attention: "Needs attention", draft: "Draft" })[status] ?? humanStatus(status ?? "draft"); }
function statusTone(status) { if (["published", "live", "passed", "approved", "paid", "completed", "fulfilled", "available"].includes(status)) return "success"; if (["failed", "needs_attention", "candidate_rejected", "refunded", "reversed", "blocked"].includes(status)) return "danger"; if (["candidate_ready", "ready_to_preview", "ready_for_review", "review_ready", "pending", "processing", "reserved", "in_transit"].includes(status)) return "warning"; return "neutral"; }
function humanStatus(value) { if (!value) return "—"; return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function dateTime(value) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.valueOf()) ? String(value) : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date); }
function shortDigest(value) { if (!value) return "—"; const text = String(value); return text.length > 22 ? `${text.slice(0, 12)}…${text.slice(-7)}` : text; }
function idOf(value, kind) { return String(value?.[`${kind}_id`] ?? value?.id ?? ""); }
function arrayOf(value) { if (Array.isArray(value)) return value; return []; }
function unwrap(payload, key) { return payload && Object.prototype.hasOwnProperty.call(payload, key) ? payload[key] : payload; }
function initials(name) { return String(name || "C").split(/\s+/).slice(0, 2).map((word) => word[0]?.toUpperCase()).join("") || "C"; }
function firstName(name) { return String(name || "Creator").trim().split(/\s+/)[0]; }
function mutationKey() { return globalThis.crypto?.randomUUID?.() ?? `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function safePublicUrl(value) { const text = String(value ?? ""); return /^https?:\/\//i.test(text) || /^\/products\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text) ? text : undefined; }

function canonicalPublicUrl(value) {
  const text = String(value ?? "");
  if (!text) return undefined;
  if (/^https:\/\//i.test(text)) return text;
  return safePublicUrl(text);
}
function isUuidV4(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? "")); }
function listCopy(value, fallback) { const items = arrayOf(value); return items.length ? items.map((item) => typeof item === "string" ? item : item.label ?? item.description).filter(Boolean).join(" · ") : fallback; }
function friendlyError(error) { if (!error) return "An unexpected error occurred."; if (error.status === 401) return "Your session expired. Sign in again to continue."; if (error.status === 403) return "This Creator account cannot access that resource."; if (error.status === 404) return "The requested resource no longer exists."; if (error.status === 409) return "This page changed in another tab. Refresh the latest version before trying again."; if (error.status === 429) return "Too many requests. Your work is preserved; try again shortly."; return error.message || "The service is temporarily unavailable. Try again."; }
