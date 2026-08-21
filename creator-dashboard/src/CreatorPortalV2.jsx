import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Menu } from "lucide-react";
import { CreatorProductFiles } from "./CreatorSourceLibrary.jsx";
import {
  Breadcrumbs as HatchBreadcrumbs,
  Button,
  Checkbox,
  DropdownMenu,
  EmptyState as HatchEmptyState,
  FormField,
  HatchBrand,
  IconButton,
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
import { parseCreatorRoute } from "./creatorRoutes.js";
import { createCreatorTranslator, CREATOR_LOCALES, detectCreatorLocale } from "./creatorI18n.js";
import { CreatorProductWorkspace } from "./CreatorProductWorkspace.jsx";
import "./creatorPortalV2.css";

const ROOT = "/studio";
const PRODUCT_TABS = [
  ["overview", "overview"],
  ["test", "testImprove"],
  ["examples", "examples"],
  ["versions", "versions"],
  ["data-controls", "dataControls"]
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
  const [locale, setLocale] = useState(() => detectCreatorLocale());
  const t = useMemo(() => createCreatorTranslator(locale), [locale]);
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

  const mobileNavigationItems = [
    { value: "space-explore", label: t("explore"), onSelect: () => void go("/explore") },
    { value: "space-library", label: t("library"), onSelect: () => void go("/library") },
    { value: "space-studio", label: t("studio"), active: route.kind === "home", onSelect: () => void go(ROOT) },
    { value: "products", label: t("products"), active: route.section === "products" && route.kind !== "files", onSelect: () => void go(`${ROOT}/products`) },
    { value: "space-orders", label: t("orders"), active: route.section === "orders", onSelect: () => void go("/studio/orders") },
    { value: "space-account", label: t("account"), onSelect: () => void go("/account") }
  ];

  useEffect(() => {
    const heading = mainRef.current?.querySelector("h1");
    if (!heading) return;
    heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
  }, [pathname]);

  useEffect(() => {
    if (typeof document !== "undefined") document.title = `${localizedRouteTitle(route, t)} · Hatch`;
  }, [route, t]);

  useEffect(() => {
    if (typeof document !== "undefined") document.documentElement.lang = locale === "zh" ? "zh-CN" : locale === "ja" ? "ja-JP" : "en";
  }, [locale]);

  return (
    <div className="cpv2">
      <aside className="cpv2-sidebar">
        <HatchBrand as="button" className="cpv2-brand" type="button" onClick={() => go(ROOT)} aria-label={t("hatchCreatorHome")} />
        <div className="cpv2-mobile-nav">
          <DropdownMenu
            label={t("creatorNavigation")}
            trigger={<IconButton label={t("openNavigation")} variant="secondary" size="small"><Menu aria-hidden="true" /></IconButton>}
            items={mobileNavigationItems}
          />
        </div>
        <nav className="cpv2-global-nav" aria-label={t("hatchNavigation")}>
          <SpaceLink href="/explore" navigate={go}>{t("explore")}</SpaceLink>
          <SpaceLink href="/library" navigate={go}>{t("library")}</SpaceLink>
          <SpaceLink href="/studio" navigate={go} active={route.kind === "home"}>{t("studio")}</SpaceLink>
          <NavButton active={route.section === "products" && route.kind !== "files"} onClick={() => go(`${ROOT}/products`)}>{t("products")}</NavButton>
          <SpaceLink href="/studio/orders" navigate={go} active={route.section === "orders"}>{t("orders")}</SpaceLink>
          <SpaceLink href="/account" navigate={go}>{t("account")}</SpaceLink>
        </nav>
        <div className="cpv2-account">
          <span className="cpv2-avatar" aria-hidden="true">{profile?.initials || initials(profile?.display_name)}</span>
          <span><strong>{profile?.display_name || t("creator")}</strong><small>{profile?.handle || t("creatorAccount")}</small></span>
          <div className="cpv2-language-picker">
            <Select
              className="cpv2-language-select"
              aria-label={t("language")}
              value={locale}
              onValueChange={setLocale}
              options={CREATOR_LOCALES.map((value) => ({
                value,
                label: t(value === "zh" ? "chinese" : value === "ja" ? "japanese" : "english")
              }))}
              size="compact"
              surface="raised"
            />
          </div>
          {onLogout ? <Button type="button" variant="ghost" size="small" onClick={onLogout}>{t("signOut")}</Button> : null}
        </div>
      </aside>
      <main id="creator-main" className="cpv2-main" ref={mainRef}>
        <CreatorRoute route={route} token={token} request={request} navigate={go} profile={profile} locale={locale} t={t} registerNavigationGuard={registerNavigationGuard} />
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

function CreatorRoute({ route, token, request, navigate, profile, locale, t, registerNavigationGuard }) {
  if (typeof request !== "function") {
    return <RouteProblem title={t("creatorPortalUnavailable")} body={t("creatorPortalUnavailableBody")} />;
  }
  if (route.kind === "home") return <CreatorHome token={token} request={request} navigate={navigate} profile={profile} t={t} locale={locale} />;
  if (route.kind === "products") return <ProductsPage token={token} request={request} navigate={navigate} t={t} />;
  if (route.kind === "product-create") return <CreatorProductFiles token={token} navigate={navigate} locale={locale} />;
  if (route.kind === "factory") return <FactoryPage token={token} request={request} productId={route.productId} runId={route.runId} navigate={navigate} locale={locale} profile={profile} t={t} />;
  if (route.kind === "product" && ["files", "about-you", "corpus", "brief", "complete"].includes(route.tab)) return <CreatorProductWorkspace token={token} request={request} navigate={navigate} productId={route.productId} tab={route.tab} locale={locale} profile={profile} />;
  if (route.kind === "product") return <ProductPage token={token} request={request} navigate={navigate} productId={route.productId} tab={route.tab} t={t} />;
  if (route.kind === "candidate") return <CreatorProductWorkspace token={token} request={request} navigate={navigate} productId={route.productId} tab="corpus" locale={locale} />;
  if (route.kind === "preview") return <PreviewPage token={token} request={request} navigate={navigate} productId={route.productId} t={t} />;
  if (route.kind === "release") return <ReleasePage token={token} request={request} navigate={navigate} productId={route.productId} releaseId={route.releaseId} t={t} locale={locale} />;
  if (route.kind === "orders") return <OrdersPage token={token} request={request} navigate={navigate} t={t} locale={locale} />;
  if (route.kind === "order") return <OrderPage token={token} request={request} navigate={navigate} orderId={route.orderId} t={t} locale={locale} />;
  return <RouteProblem title={t("pageNotFound")} body={t("pageNotFoundBody")} action={t("backToProducts")} onAction={() => navigate(`${ROOT}/products`)} />;
}

function CreatorHome({ token, request, navigate, profile, t, locale }) {
  const resource = useRemote(request, "/v1/creator/overview", token);
  return (
    <PageBoundary resource={resource} title={t("workspaceLoadError")} retryLabel={t("retry")} t={t}>
      {(payload) => {
        const overview = unwrap(payload, "overview");
        const products = arrayOf(overview?.products);
        const orders = arrayOf(overview?.recent_orders ?? overview?.orders);
        const next = nextCreatorAction(products, t);
        const metrics = overview?.metrics ?? {};
        return <>
          <PageHeader eyebrow={t("creatorHome")} title={t("homeTitle", firstName(profile?.display_name) || t("creator"))} body={t("homeBody")} />
          <section className="cpv2-grid cpv2-home-grid" aria-label={t("creatorOverview")}>
            <article className="cpv2-card cpv2-next-card">
              <StatusChip status={next.tone}>{next.label}</StatusChip>
              <h2>{next.title}</h2>
              <p>{next.body}</p>
              <Button type="button" trailing={<span aria-hidden="true">→</span>} onClick={() => navigate(next.href)}>{next.action}</Button>
            </article>
            <article className="cpv2-card cpv2-balance-card">
              <span className="cpv2-kicker">{t("permanentAccess")}</span>
              <strong>{metrics.order_count ?? orders.length}</strong>
              <p>{t("peopleWithAccess")}</p>
              <dl><div><dt>{t("products")}</dt><dd>{products.length}</dd></div><div><dt>{t("orders")}</dt><dd>{metrics.order_count ?? orders.length}</dd></div></dl>
              <Button className="cpv2-inverse" variant="secondary" type="button" onClick={() => navigate(`${ROOT}/orders`)}>{t("viewAccessRecords")}</Button>
            </article>
          </section>
          <SectionHeading eyebrow={t("recentActivity")} title={t("ordersAndAccess")} action={t("viewAllOrders")} onAction={() => navigate(`${ROOT}/orders`)} />
          {orders.length ? <OrderList orders={orders} onOpen={(order) => navigate(`${ROOT}/orders/${encodeURIComponent(idOf(order, "order"))}`)} t={t} locale={locale} /> : <EmptyState title={t("noAccessRecords")} body={t("noAccessRecordsBody")} />}
        </>;
      }}
    </PageBoundary>
  );
}

function ProductsPage({ token, request, navigate, t }) {
  const resource = useRemote(request, "/v1/creator/products", token);
  return (
    <PageBoundary resource={resource} title={t("productsLoadError")} retryLabel={t("retry")} t={t}>
      {(payload) => {
        const products = arrayOf(unwrap(payload, "products"));
        return <>
          <PageHeader eyebrow={t("products")} title={t("productsPageTitle")} body={t("productsPageBody")} action={t("createProduct")} onAction={() => navigate(`${ROOT}/products/new`)} />
          {products.length ? <section className="cpv2-product-grid" aria-label={t("products")}>
            {products.map((product) => <ProductCard key={idOf(product, "product")} product={product} t={t} onOpen={() => navigate(`${ROOT}/products/${encodeURIComponent(idOf(product, "product"))}`)} />)}
          </section> : <EmptyState title={t("createFirstProduct")} body={t("createFirstProductBody")} action={t("createProduct")} onAction={() => navigate(`${ROOT}/products/new`)} />}
        </>;
      }}
    </PageBoundary>
  );
}

function ProductCard({ product, onOpen, t }) {
  const published = product.status === "published" || product.status === "live";
  return <article className="cpv2-card cpv2-product-card">
    <div className="cpv2-card-top"><StatusChip status={product.status}>{localizedProductStatus(product.status, t)}</StatusChip><span>{published ? t("permanentAccess") : t("notPublished")}</span></div>
    <h2>{product.name ?? product.product_name ?? t("untitledProduct")}</h2>
    <p>{product.promise ?? product.description ?? t("addProductPromise")}</p>
    <div className="cpv2-card-foot"><small>{shortDigest(product.corpus_digest ?? product.active_release?.corpus_digest)}</small><Button variant="secondary" type="button" onClick={onOpen}>{t("openProduct")}</Button></div>
  </article>;
}

function ProductPage({ token, request, navigate, productId, tab, t }) {
  const resource = useRemote(request, `/v1/creator/products/${encodeURIComponent(productId)}`, token);
  return (
    <PageBoundary resource={resource} title={t("productLoadError")} retryLabel={t("retry")} t={t}>
      {(payload) => {
        const product = unwrap(payload, "product") ?? payload;
        const candidate = candidateOf(product);
        const next = productNextAction(product, candidate, t);
        return <>
          <Breadcrumb onClick={() => navigate(`${ROOT}/products`)}>{t("products")}</Breadcrumb>
          <PageHeader eyebrow={productStatus(product.status, t)} title={product.name ?? product.product_name ?? t("untitledProduct")} body={product.promise ?? product.description ?? t("defineProductPromise")} action={next.action} onAction={() => navigate(next.href(productId, candidate))} />
          <ProductTabs productId={productId} active={tab} navigate={navigate} t={t} />
          {tab === "overview" ? <ProductOverview product={product} candidate={candidate} navigate={navigate} token={token} request={request} onChanged={resource.retry} t={t} /> : null}
          {tab === "test" ? <TestPanel product={product} candidate={candidate} navigate={navigate} t={t} /> : null}
          {tab === "examples" ? <ExamplesPanel product={product} t={t} /> : null}
          {tab === "versions" ? <VersionsPanel product={product} candidate={candidate} productId={productId} navigate={navigate} t={t} /> : null}
          {tab === "data-controls" ? <DataControlsPanel product={product} t={t} /> : null}
        </>;
      }}
    </PageBoundary>
  );
}

function ProductTabs({ productId, active, navigate, t }) {
  return <HatchTabs
    className="cpv2-tabs"
    value={active}
    ariaLabel={t("productSections")}
    onValueChange={(value) => navigate(`${ROOT}/products/${encodeURIComponent(productId)}/${value}`)}
    items={PRODUCT_TABS.map(([value, key]) => ({ value, label: t(key) }))}
  />;
}

function ProductOverview({ product, candidate, navigate, token, request, onChanged, t }) {
  const productId = idOf(product, "product");
  const alreadyPublished = product.status === "published" || product.status === "live";
  const [withdraw, setWithdraw] = useState({ reason: "", confirming: false, busy: false, error: "", done: false });
  const steps = [
    { label: t("productFiles"), done: Boolean(product.files_count || product.source_count || product.source_snapshot_id), action: t("openFiles"), href: `${ROOT}/products/${encodeURIComponent(productId)}/files` },
    { label: t("versionCandidate"), done: Boolean(candidate || alreadyPublished || product.corpus_digest), action: t("continueProduct"), href: `${ROOT}/products/${encodeURIComponent(productId)}/about-you` },
    { label: t("candidateApproval"), done: isApproved(candidate) || alreadyPublished, action: t("reviewCandidate"), href: candidate ? `${ROOT}/products/${encodeURIComponent(productId)}/candidates/${encodeURIComponent(idOf(candidate, "candidate"))}` : null },
    { label: t("storefrontPreview"), done: Boolean(product.previewed_at || product.preview_ready), action: t("preview"), href: `${ROOT}/products/${encodeURIComponent(productId)}/preview` },
    { label: t("published"), done: product.status === "published" || product.status === "live", action: t("viewStorefront"), href: product.public_url, external: true }
  ];
  async function withdrawProduct() {
    if (!withdraw.reason.trim() || withdraw.busy) return;
    setWithdraw((current) => ({ ...current, busy: true, error: "", done: false }));
    try {
      await request(`/v1/creator/products/${encodeURIComponent(productId)}/withdraw`, { method: "POST", token, headers: { "idempotency-key": mutationKey() }, body: JSON.stringify({ reason: withdraw.reason.trim() }) });
      setWithdraw((current) => ({ ...current, busy: false, error: "", done: true, confirming: false }));
      onChanged?.();
    } catch (error) { setWithdraw((current) => ({ ...current, busy: false, error: friendlyError(error, t), done: false })); }
  }
  return <><div className="cpv2-detail-grid">
    <article className="cpv2-card cpv2-workflow">
      <span className="cpv2-kicker">{t("publishingWorkflow")}</span><h2>{t("deliberateGate")}</h2>
      <ol>{steps.map((step, index) => <li key={step.label} className={step.done ? "is-done" : ""}><span>{step.done ? "✓" : index + 1}</span><strong>{step.label}</strong>{step.href ? step.external ? <Button asChild variant="link" size="small"><a href={safePublicUrl(step.href)} target="_blank" rel="noreferrer">{step.action}</a></Button> : <Button variant="link" size="small" type="button" onClick={() => navigate(step.href)}>{step.action}</Button> : <small>{t("completePreviousStep")}</small>}</li>)}</ol>
    </article>
    <article className="cpv2-card cpv2-facts"><span className="cpv2-kicker">{t("currentProduct")}</span><dl><Fact label={t("candidate")} value={candidate ? `v${candidate.version ?? "—"} · ${approvalLabel(candidate, t)}` : t("notReady")} /><Fact label={t("access")} value={t("freePermanentAccess")} /><Fact label={t("release")} value={product.active_release?.label ?? product.release?.label ?? product.release_label ?? t("notPublished")} /><Fact label={t("publicUrl")} value={product.public_url ?? t("notPublic")} /></dl></article>
  </div>{withdraw.error ? <InlineError>{withdraw.error}</InlineError> : null}{withdraw.done ? <SuccessNotice>{t("withdrawSuccess")}</SuccessNotice> : null}{alreadyPublished ? <article className="cpv2-card cpv2-panel cpv2-withdraw"><SectionHeading eyebrow={t("productLifecycle")} title={t("withdrawProduct")} /><p>{t("withdrawalStopsNewAccess")}</p><FormField label={t("auditReason")}><Textarea value={withdraw.reason} onChange={(event) => setWithdraw((current) => ({ ...current, reason: event.target.value, confirming: false }))} placeholder={t("withdrawReasonPlaceholder")} /></FormField>{withdraw.confirming ? <div className="cpv2-confirm"><p><strong>{t("withdrawPublicProduct")}</strong><br />{t("existingAccessKeepRecords")}</p><Button variant="secondary" type="button" onClick={() => setWithdraw((current) => ({ ...current, confirming: false }))}>{t("cancel")}</Button><Button variant="danger" type="button" loading={withdraw.busy} disabled={!withdraw.reason.trim()} onClick={withdrawProduct}>{t("confirmWithdrawal")}</Button></div> : <Button variant="danger" type="button" disabled={!withdraw.reason.trim()} onClick={() => setWithdraw((current) => ({ ...current, confirming: true }))}>{t("reviewWithdrawal")}</Button>}</article> : null}</>;
}

function TestPanel({ product, candidate, navigate, t }) {
  const gates = arrayOf(candidate?.gates ?? product.evaluation?.gates);
  return <article className="cpv2-card cpv2-panel"><SectionHeading eyebrow={t("evaluation")} title={t("behaviorEvidence")} />{gates.length ? <ul className="cpv2-gates">{gates.map((gate, index) => <li key={gate.id ?? index}><StatusChip status={gate.passed === false ? "failed" : "passed"}>{gate.passed === false ? t("failed") : t("passed")}</StatusChip><span><strong>{gate.name ?? gate.label ?? t("gateNumber", index + 1)}</strong><small>{gate.detail ?? gate.message ?? t("deterministicEvaluationGate")}</small></span></li>)}</ul> : <EmptyInline>{t("noEvaluationReport")}</EmptyInline>}{candidate ? <Button variant="secondary" type="button" onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(idOf(product, "product"))}/candidates/${encodeURIComponent(idOf(candidate, "candidate"))}`)}>{t("openCandidateReport")}</Button> : null}</article>;
}

function ExamplesPanel({ product, t }) {
  const examples = arrayOf(product.examples ?? product.presentation?.examples);
  return <article className="cpv2-card cpv2-panel"><SectionHeading eyebrow={t("buyerProof")} title={t("representativeExamples")} />{examples.length ? <div className="cpv2-examples">{examples.map((example, index) => <section key={example.id ?? index}><h3>{example.title ?? t("example", index + 1)}</h3><p>{example.summary ?? example.description ?? String(example)}</p></section>)}</div> : <EmptyInline>{t("clientSafeExamples")} {t("protectedInstructionsNeverAppear")}</EmptyInline>}</article>;
}

function VersionsPanel({ product, candidate, productId, navigate, t }) {
  const releases = arrayOf(product.releases).length ? arrayOf(product.releases) : (product.release ? [{ ...product.release, current: true }] : []);
  return <article className="cpv2-card cpv2-panel"><SectionHeading eyebrow={t("immutableHistory")} title={t("candidatesAndReleases")} />{candidate ? <NavigationItem className="cpv2-version" onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}/candidates/${encodeURIComponent(idOf(candidate, "candidate"))}`)} trailing={<StatusChip status={candidate.status}>{approvalLabel(candidate, t)}</StatusChip>}><span><strong>{t("candidateVersion", candidate.version ?? "—")}</strong><small>{shortDigest(candidate.digest)}</small></span></NavigationItem> : null}{releases.map((release) => <NavigationItem className="cpv2-version" type="button" key={idOf(release, "release")} onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}/releases/${encodeURIComponent(idOf(release, "release"))}`)} trailing={<StatusChip status={release.current ? "published" : "retired"}>{release.current ? t("current") : t("previous")}</StatusChip>}><span><strong>{release.label ?? `${t("release")} ${release.version ?? ""}`}</strong><small>{shortDigest(release.corpus_digest ?? release.digest)}</small></span></NavigationItem>)}{!candidate && !releases.length ? <EmptyInline>{t("noCandidateRelease")}</EmptyInline> : null}</article>;
}

function DataControlsPanel({ product, t }) {
  const boundaries = arrayOf(product.boundaries ?? product.product_boundaries);
  return <div className="cpv2-detail-grid"><article className="cpv2-card cpv2-panel"><SectionHeading eyebrow={t("productBoundaries")} title={t("willNotDo")} />{boundaries.length ? <ul className="cpv2-bullets">{boundaries.map((item, index) => <li key={index}>{typeof item === "string" ? item : item.label ?? item.description}</li>)}</ul> : <EmptyInline>{t("addExplicitBoundaries")}</EmptyInline>}</article><article className="cpv2-card cpv2-panel"><SectionHeading eyebrow={t("privacy")} title={t("buyerWorkPrivate")} /><p>{t("accessRecordsNeverInclude")}</p><dl><Fact label={t("corpusDigest")} value={shortDigest(product.corpus_digest ?? product.active_release?.corpus_digest)} /><Fact label={t("versionPolicy")} value={product.version_policy ?? t("pinnedPurchasedRelease")} /></dl></article></div>;
}

function FactoryPage({ token, request, productId, runId, navigate, locale, profile, t }) {
  // Old Factory URLs are only bookmarks now. Always render the canonical
  // Product-scoped Node workflow; there is no second run/review authority.
  if (productId === undefined) return <ProductsPage token={token} request={request} navigate={navigate} t={t} />;
  return <CreatorProductWorkspace token={token} request={request} productId={productId} tab="about-you" navigate={navigate} locale={locale} />;
}

function CandidatePage({ token, request, navigate, productId, candidateId, t, locale }) {
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
      setMutation({ state: "idle", error: friendlyError(error, t) });
    }
  }

  if (productResource.state === "loading") return <LoadingState t={t} />;
  if (productResource.state === "error") return <RouteProblem title={t("productLoadError")} body={friendlyError(productResource.error, t)} action={t("retry")} onAction={productResource.retry} />;
  return <PageBoundary resource={resource} title={t("candidateLoadError")} retryLabel={t("retry")} t={t}>{(payload) => {
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
      <Breadcrumb onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}/versions`)}>{t("versions")}</Breadcrumb>
      <PageHeader eyebrow={t("candidateReview")} title={t("candidateReviewTitle", candidate?.version ?? "—")} body={t("candidateReviewBody")} />
      {mutation.error ? <InlineError>{mutation.error}</InlineError> : null}
      <div className="cpv2-detail-grid cpv2-review-grid">
        <article className="cpv2-card cpv2-panel"><SectionHeading eyebrow={t("provenance")} title={t("whatWasEvaluated")} /><dl className="cpv2-fact-grid"><Fact label={t("candidateDigest")} value={candidate?.digest ?? t("notProvided")} /><Fact label={t("baseRelease")} value={candidate?.base_release?.label ?? candidate?.base_release_id ?? t("notProvided")} /><Fact label={t("datasetEvalSet")} value={candidate?.eval_set?.name ?? candidate?.eval_set_id ?? candidate?.dataset_id ?? t("notProvided")} /><Fact label={t("regressionDigest")} value={candidate?.regression_digest ?? candidate?.eval_set?.digest ?? t("notProvided")} /><Fact label={t("heldOutDigest")} value={candidate?.held_out_digest ?? t("notProvided")} /><Fact label={t("heldOutSamples")} value={candidate?.held_out_sample_count ?? candidate?.evaluation?.sample_count ?? t("notProvided")} /><Fact label={t("criticalGates")} value={candidate?.critical_case_count ?? candidate?.evaluation?.critical_case_count ?? gates.filter((gate) => gate?.critical || gate?.severity === "critical").length} /><Fact label={t("failedCriticalCases")} value={candidate?.failed_critical_cases ?? t("notProvided")} /><Fact label={t("built")} value={candidate?.built_at || candidate?.created_at ? dateTime(candidate?.built_at ?? candidate?.created_at, locale) : t("notProvided")} /><Fact label={t("factoryVersion")} value={candidate?.factory_version ?? t("notProvided")} /><Fact label={t("providerModel")} value={candidate?.provider_model ?? ([candidate?.provider, candidate?.model].filter(Boolean).join(" / ") || t("notProvided"))} /><Fact label={t("reportDigest")} value={candidate?.report_digest ?? candidate?.evaluation_digest ?? t("notProvided")} /></dl></article>
        <article className="cpv2-card cpv2-panel"><SectionHeading eyebrow={t("decision")} title={criticalFailed ? t("criticalGatesBlockApproval") : t("candidateCanBeApproved")} /><p>{criticalFailed ? t("resolveFailedCriticalCases") : losses.length ? t("acknowledgeKnownLosses") : t("allRequiredGatesPassed")}</p><StatusChip status={criticalFailed ? "failed" : "passed"}>{criticalFailed ? t("blocked") : t("readyForDecision")}</StatusChip></article>
      </div>
      <article className="cpv2-card cpv2-panel cpv2-review-report"><SectionHeading eyebrow={t("deterministicGates")} title={t("evaluationReport")} />{gates.length ? <ul className="cpv2-gates">{gates.map((gate, index) => <li key={gate.id ?? index}><StatusChip status={gate.passed === false ? "failed" : "passed"}>{gate.passed === false ? t("failed") : t("passed")}</StatusChip><span><strong>{gate.name ?? gate.label ?? t("gateNumber", index + 1)}</strong><small>{gate.detail ?? gate.message ?? (gate.critical ? t("criticalGate") : t("evaluationGate"))}</small></span></li>)}</ul> : <EmptyInline>{t("noIndividualGateRows")}</EmptyInline>}
        <h3>{t("blindedComparison")}</h3>{comparisons.length ? <ul className="cpv2-comparisons">{comparisons.map((item, index) => <li key={item?.id ?? index}><strong>{item?.label ?? item?.case ?? t("caseNumber", index + 1)}</strong><span>{t("currentValue", item?.current ?? item?.baseline ?? t("notProvided"))}</span><span>{t("candidateValue", item?.candidate ?? item?.proposed ?? t("notProvided"))}</span><small>{item?.verdict ?? item?.result ?? t("blindedResult")}</small></li>)}</ul> : <EmptyInline>{t("noBlindedComparison")}</EmptyInline>}
        <h3>{t("materialBehaviorChanges")}</h3>{changes.length ? <ul className="cpv2-bullets">{changes.map((item, index) => <li key={index}>{typeof item === "string" ? item : item.description ?? item.label}</li>)}</ul> : <EmptyInline>{t("noMaterialBehaviorChanges")}</EmptyInline>}
        <h3>{t("productBoundaries")}</h3>{boundaries.length ? <ul className="cpv2-bullets">{boundaries.map((item, index) => <li key={index}>{typeof item === "string" ? item : item.description ?? item.label}</li>)}</ul> : <EmptyInline>{t("noProductBoundaries")}</EmptyInline>}
        {losses.length ? <fieldset className="cpv2-losses"><legend>{t("knownNonCriticalLosses")}</legend>{losses.map((loss, index) => { const lossId = loss?.id ?? String(index); return <Checkbox key={lossId} checked={acknowledged.includes(lossId)} onCheckedChange={(checked) => setAcknowledged((current) => checked ? [...current, lossId] : current.filter((id) => id !== lossId))} label={loss?.title ?? loss?.label ?? t("loss", index + 1)} description={loss?.description ?? loss?.detail ?? String(loss)} />; })}</fieldset> : null}
      </article>
      <div className="cpv2-action-bar"><div><strong>{t("approvalImmutable")}</strong><small>{t("candidateChangeInvalidates")}</small></div>{confirmReject ? <><span>{t("archiveCandidate")}</span><Button variant="danger" type="button" loading={mutation.state === "reject"} disabled={busy} onClick={() => decide("reject", candidate, expectedVersion)}>{t("yesReject")}</Button><Button variant="secondary" type="button" onClick={() => setConfirmReject(false)}>{t("cancel")}</Button></> : <Button variant="secondary" type="button" disabled={busy || alreadyApproved} onClick={() => setConfirmReject(true)}>{t("rejectCandidate")}</Button>}<Button type="button" loading={mutation.state === "approve"} disabled={busy || criticalFailed || !allAcknowledged || alreadyApproved} onClick={() => decide("approve", candidate, expectedVersion)}>{alreadyApproved ? t("approved") : t("approveCandidate")}</Button></div>
    </>;
  }}</PageBoundary>;
}

function PreviewPage({ token, request, navigate, productId, t }) {
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
    } catch (nextError) { setError(friendlyError(nextError, t)); }
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
      setError(t("copyFailed"));
    }
  }

  if (published) {
    const publicUrl = canonicalPublicUrl(published.canonical_url ?? published.public_url ?? published.product?.canonical_url ?? published.product?.public_url)
      ?? (isUuidV4(productId) ? `/products/${productId}` : undefined);
    return <section className="cpv2-published" aria-live="polite"><span aria-hidden="true">✓</span><h1>{t("yourProductLive")}</h1><p>{t("publishedPermanentBody")}</p><FormField label={t("shareLink")}><Input readOnly value={publicUrl ?? t("publicationCompleted")} onFocus={(event) => event.target.select()} /></FormField><div>{publicUrl ? <Button type="button" onClick={() => copy(publicUrl)}>{copied ? t("copied") : t("copyLink")}</Button> : null}{publicUrl ? <Button asChild variant="secondary"><a href={safePublicUrl(publicUrl)} target="_blank" rel="noreferrer">{t("viewStorefront")}</a></Button> : null}<Button variant="secondary" type="button" onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}`)}>{t("backToProduct")}</Button></div>{error ? <InlineError>{error}</InlineError> : null}</section>;
  }

  return <PageBoundary resource={resource} title={t("previewLoadError")} retryLabel={t("retry")} t={t}>{(payload) => {
    const preview = payload?.preview && typeof payload.preview === "object"
      ? payload.preview
      : payload;
    const product = preview.product ?? preview;
    const candidate = preview.candidate ?? candidateOf(product);
    const readiness = normalizeReadiness(preview, candidate, t);
    const ready = readiness.every((item) => item.ready);
    return <>
      <Breadcrumb onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}`)}>{t("product")}</Breadcrumb>
      <PageHeader eyebrow={t("storefrontPreview")} title={t("seeExactly")} body={t("previewBody")} />
      {error ? <InlineError>{error}</InlineError> : null}
      <div className="cpv2-preview-tools"><span className="cpv2-private-badge">{t("notPublic")}</span><div role="group" aria-label={t("previewViewport")}><Button type="button" variant="ghost" size="small" className={viewport === "desktop" ? "is-active" : ""} aria-pressed={viewport === "desktop"} onClick={() => setViewport("desktop")}>{t("desktop")}</Button><Button type="button" variant="ghost" size="small" className={viewport === "mobile" ? "is-active" : ""} aria-pressed={viewport === "mobile"} onClick={() => setViewport("mobile")}>{t("mobile")}</Button></div></div>
      <div className={`cpv2-storefront-frame is-${viewport}`}><StorefrontDetails product={product} creatorName={preview.creator?.display_name ?? preview.creator_name} mode="preview" headingLevel={2} desktopRequirement={preview.desktop_requirement ?? product.desktop_requirement} releaseLabel={candidate ? `${t("candidateVersion", candidate.version ?? "—")} · ${candidate.digest ?? t("notProvided")}` : t("notProvided")} action={<Button type="button" disabled>{t("getAccess")}</Button>} /></div>
      <article className="cpv2-card cpv2-readiness"><SectionHeading eyebrow={t("publishReadiness")} title={t("finalChecks")} /><ul>{readiness.map((item) => <li key={item.label} className={item.ready ? "is-ready" : ""}><span>{item.ready ? "✓" : "!"}</span><strong>{item.label}</strong><small>{item.detail}</small></li>)}</ul>{confirming ? <div className="cpv2-confirm cpv2-confirm-publish"><div><p><strong>{t("publishCandidateConfirm")}</strong><br />{t("publicPointerAfterMaterialization")}</p><dl className="cpv2-confirm-facts"><Fact label={t("product")} value={product.name ?? product.product_name ?? productId} /><Fact label={t("candidate")} value={`v${candidate?.version ?? "—"} · ${candidate?.digest ?? t("notProvided")}`} /><Fact label={t("access")} value={t("freePermanentAccess")} /><Fact label={t("publicUrl")} value={preview.public_url ?? (isUuidV4(productId) ? `/products/${productId}` : t("assignedAfterPublish"))} /></dl><small>{t("publishingCreates")}</small></div><Button variant="secondary" type="button" onClick={() => setConfirming(false)}>{t("cancel")}</Button><Button type="button" loading={publishing} disabled={!ready} onClick={() => publish({ ...preview, product, candidate })}>{t("confirmPublish")}</Button></div> : <Button type="button" disabled={!ready} onClick={() => setConfirming(true)}>{t("publish")}</Button>}</article>
    </>;
  }}</PageBoundary>;
}

function ReleasePage({ token, request, navigate, productId, releaseId, t, locale }) {
  const resource = useRemote(request, `/v1/creator/products/${encodeURIComponent(productId)}`, token);
  const [state, setState] = useState({ busy: false, error: "", done: false, reason: "", confirming: false });
  return <PageBoundary resource={resource} title={t("releaseLoadError")} retryLabel={t("retry")} t={t}>{(payload) => {
    const product = unwrap(payload, "product") ?? payload;
    const release = arrayOf(product.releases).find((item) => idOf(item, "release") === releaseId) ?? (idOf(product.release, "release") === releaseId ? { ...product.release, current: true } : null) ?? product.active_release;
    if (!release) return <RouteProblem title={t("releaseNotFound")} body={t("releaseHistoryMissing")} action={t("backToVersions")} onAction={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}/versions`)} />;
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
      } catch (error) { setState((current) => ({ ...current, busy: false, error: friendlyError(error, t), done: false })); }
    }
    return <><Breadcrumb onClick={() => navigate(`${ROOT}/products/${encodeURIComponent(productId)}/versions`)}>{t("versions")}</Breadcrumb><PageHeader eyebrow={t("immutableRelease")} title={release.label ?? `${t("release")} ${release.version ?? ""}`} body={t("existingAccessPinned")} />{state.error ? <InlineError>{state.error}</InlineError> : null}{state.done ? <SuccessNotice>{t("currentReleaseUpdated")}</SuccessNotice> : null}<article className="cpv2-card cpv2-panel"><dl className="cpv2-fact-grid"><Fact label={t("releaseId")} value={idOf(release, "release")} /><Fact label={t("corpusDigest")} value={release.corpus_digest ?? release.digest} /><Fact label={t("publishedAt")} value={dateTime(release.published_at ?? release.created_at, locale)} /><Fact label={t("access")} value={t("freePermanentAccess")} /><Fact label={t("status")} value={release.current ? t("current") : t("previous")} /><Fact label={t("materialization")} value={release.materialization_status ?? t("notProvided")} /></dl></article>{release.current ? <p className="cpv2-muted">{t("alreadyCurrentRelease")}</p> : <section className="cpv2-rollback"><article className="cpv2-card cpv2-panel"><SectionHeading eyebrow={t("rollback")} title={t("makeExactReleaseCurrent")} /><p>{t("releaseFixedByPage")}</p><FormField label={t("release")}><Input readOnly value={`${release.label ?? releaseId} · ${release.corpus_digest ?? release.digest ?? t("notProvided")}`} /></FormField><FormField label={t("auditReason")} required><Textarea required value={state.reason} onChange={(event) => setState((current) => ({ ...current, reason: event.target.value, confirming: false }))} placeholder={t("whyReleaseCurrent")} /></FormField></article><div className="cpv2-rollback-preview"><span className="cpv2-private-badge">{t("rollbackPreview")}</span><StorefrontDetails product={product} creatorName={product.creator_name} mode="preview" headingLevel={2} desktopRequirement={product.desktop_requirement} releaseLabel={`${release.label ?? releaseId} · ${release.corpus_digest ?? release.digest ?? t("notProvided")}`} action={<Button type="button" disabled>{t("getAccess")}</Button>} /></div>{state.confirming ? <div className="cpv2-card cpv2-confirm cpv2-confirm-publish" role="alert"><div><strong>{t("exactReleaseConfirm")}</strong><p>{state.reason}</p><small>{t("rollbackAudit")}</small></div><Button variant="secondary" type="button" onClick={() => setState((current) => ({ ...current, confirming: false }))}>{t("cancel")}</Button><Button type="button" loading={state.busy} disabled={!state.reason.trim()} onClick={rollback}>{t("confirmRollback")}</Button></div> : <Button type="button" disabled={!state.reason.trim()} onClick={() => setState((current) => ({ ...current, confirming: true }))}>{t("reviewRollback")}</Button>}</section>}</>;
  }}</PageBoundary>;
}

function OrdersPage({ token, request, navigate, t, locale }) {
  const [filters, setFilters] = useState({ order: "", product: "", from: "", to: "", limit: "25" });
  const query = useMemo(() => creatorOrderQuery(filters), [filters]);
  const resource = useRemote(request, `/v1/creator/orders${query ? `?${query}` : ""}`, token);
  return <PageBoundary resource={resource} title={t("ordersLoadError")} retryLabel={t("retry")} t={t}>{(payload) => {
    return <>
      <PageHeader eyebrow={t("accessRecords")} title={t("accessRecordsTitle")} body={t("accessRecordsBody")} />
      <form className="cpv2-filters" onSubmit={(event) => event.preventDefault()}>
        <FormField label={t("orderStatus")}><Select label={t("orderStatus")} value={filters.order || "all"} onValueChange={(value) => setFilters((current) => ({ ...current, order: value === "all" ? "" : value }))} options={[{ value: "all", label: t("all") }, { value: "fulfilled", label: t("fulfilled") }, { value: "refund_pending", label: t("refundPending") }, { value: "refunded", label: t("refunded") }, { value: "failed", label: t("failedOrder") }]} /></FormField>
        <FormField label={t("productId")}><Input value={filters.product} onChange={(event) => setFilters((current) => ({ ...current, product: event.target.value }))} placeholder={t("allProducts")} /></FormField>
        <FormField label={t("fromDate")}><Input type="date" value={filters.from} max={filters.to || undefined} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} /></FormField>
        <FormField label={t("toDate")}><Input type="date" value={filters.to} min={filters.from || undefined} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} /></FormField>
        <FormField label={t("rowsPerPage")}><Select label={t("rowsPerPage")} value={filters.limit} onValueChange={(value) => setFilters((current) => ({ ...current, limit: value }))} options={[{ value: "12", label: "12" }, { value: "25", label: "25" }, { value: "50", label: "50" }, { value: "100", label: "100" }]} /></FormField>
        <Button variant="secondary" type="button" onClick={() => setFilters({ order: "", product: "", from: "", to: "", limit: "25" })}>{t("clearFilters")}</Button>
      </form>
      <PaginatedOrders initialPayload={payload} query={query} token={token} request={request} navigate={navigate} t={t} locale={locale} />
    </>;
  }}</PageBoundary>;
}

function PaginatedOrders({ initialPayload, query, token, request, navigate, t, locale }) {
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
    } catch (nextError) { setError(friendlyError(nextError, t)); }
    finally { setLoadingMore(false); }
  }

  if (!page.orders.length) return <EmptyState title={t("noMatchingOrders")} body={t("noOrdersBody")} />;
  return <><div className="cpv2-pagination-status" role="status">{t("loadedOrders", page.orders.length, page.orders.length !== 1, page.cursor ? t("moreAvailable") : t("endResults"))}.</div><OrderList orders={page.orders} onOpen={(order) => navigate(`${ROOT}/orders/${encodeURIComponent(order.order_number ?? order.order_reference ?? idOf(order, "order"))}`)} detailed t={t} locale={locale} />{error ? <InlineError>{error}</InlineError> : null}{page.cursor ? <Button className="cpv2-load-more" variant="secondary" type="button" loading={loadingMore} onClick={loadMore}>{t("loadNextPage")}</Button> : null}</>;
}

function OrderList({ orders, onOpen, detailed = false, t, locale }) {
  return <div className="cpv2-order-list" role="list">{orders.map((order) => { const reference = order.order_number ?? order.order_reference ?? idOf(order, "order"); return <article className="cpv2-order" role="listitem" key={idOf(order, "order")}><div><span className="cpv2-kicker">{reference}</span><h2>{order.product_name ?? order.product?.name ?? t("productAccess")}</h2><p>{order.buyer_display_name ?? t("buyer")} · {dateTime(order.created_at ?? order.placed_at, locale)}</p></div><dl><Fact label={t("access")} value={humanStatus(order.entitlement_status ?? order.status ?? order.order_status, t)} />{detailed ? <Fact label={t("accessStatus")} value={humanStatus(order.access_status ?? order.entitlement_status ?? order.status ?? "active", t)} /> : null}</dl><Button variant="secondary" type="button" onClick={() => onOpen(order)} aria-label={t("viewAccessRecord", reference)}>{t("viewRecord")}</Button></article>; })}</div>;
}

function OrderPage({ token, request, navigate, orderId, t, locale }) {
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
      setRefund((current) => ({ ...current, busy: false, error: friendlyError(error, t), done: false }));
    }
  }

  return <PageBoundary resource={resource} title={t("orderLoadError")} retryLabel={t("retry")} t={t}>{(payload) => {
    const order = unwrap(payload, "order") ?? payload;
    const events = arrayOf(order.timeline ?? order.events);
    const safeEvents = events.length ? events : inferredTimeline(order, t);
    const canRefund = Boolean(order.actions?.can_creator_refund || order.actions?.can_request_refund || order.actions?.can_cancel_access);
    return <>
      <Breadcrumb onClick={() => navigate(`${ROOT}/orders`)}>{t("orders")}</Breadcrumb>
      <PageHeader eyebrow={order.order_reference ?? orderId} title={order.product_name ?? order.product?.name ?? t("orderDetail")} body={`${order.buyer_display_name ?? t("buyer")} · ${dateTime(order.created_at ?? order.placed_at, locale)}`} />
      {refund.error ? <InlineError>{refund.error}</InlineError> : null}
      {refund.done ? <SuccessNotice>{t("refundRecorded")}</SuccessNotice> : null}
      <div className="cpv2-detail-grid">
        <article className="cpv2-card cpv2-panel">
          <SectionHeading eyebrow={t("accessRecord")} title={t("whatBuyerReceived")} />
          <dl className="cpv2-fact-grid">
            <Fact label={t("access")} value={humanStatus(order.entitlement_status ?? order.access?.status, t)} />
            <Fact label={t("release")} value={order.release_id ?? order.release_label ?? order.corpus_digest ?? t("notProvided")} />
            <Fact label={t("revocation")} value={humanStatus(order.refund_status ?? order.refund?.status ?? (order.refund ? "completed" : "none"), t)} />
          </dl>
        </article>
        <article className="cpv2-card cpv2-panel">
          <SectionHeading eyebrow={t("accessMetadata")} title={t("privateByDesign")} />
          <dl>
            <Fact label={t("status")} value={humanStatus(order.access_status ?? order.entitlement_status ?? order.status ?? "active", t)} />
            <Fact label={t("accessMode")} value={order.access_mode === "unmetered" ? t("permanent") : t("metered")} />
            <Fact label={t("release")} value={order.release_id ?? order.release_label ?? order.corpus_digest ?? t("notProvided")} />
          </dl>
          <p className="cpv2-muted">{t("workspacePathsPrivate")}</p>
        </article>
      </div>
      <article className="cpv2-card cpv2-panel cpv2-timeline">
        <SectionHeading eyebrow={t("timeline")} title={t("accessHistory")} />
        <ol>{safeEvents.map((event, index) => <li key={event.id ?? event.event_id ?? index}><span aria-hidden="true" /><div><strong>{event.label ?? humanStatus(event.type ?? event.event_type, t)}</strong><small>{dateTime(event.at ?? event.created_at ?? event.occurred_at, locale)}</small>{event.detail ? <p>{event.detail}</p> : null}</div></li>)}</ol>
      </article>
      <article className="cpv2-card cpv2-panel cpv2-refund-action">
        <SectionHeading eyebrow={t("orderAction")} title={t("revokeAccess")} />
        {canRefund ? <><p>{t("reasonRequired")}</p><FormField label={t("reason")}><Textarea value={refund.reason} onChange={(event) => setRefund((current) => ({ ...current, reason: event.target.value, confirming: false }))} placeholder={t("revokeReasonPlaceholder")} /></FormField>{refund.confirming ? <div className="cpv2-confirm"><p><strong>{t("revokeConfirm")}</strong><br />{t("entitlementNotUsable")}</p><Button variant="secondary" type="button" onClick={() => setRefund((current) => ({ ...current, confirming: false }))}>{t("cancel")}</Button><Button variant="danger" type="button" loading={refund.busy} disabled={!refund.reason.trim()} onClick={requestRefund}>{t("confirmRevoke")}</Button></div> : <Button variant="danger" type="button" disabled={!refund.reason.trim()} onClick={() => setRefund((current) => ({ ...current, confirming: true }))}>{t("reviewRevoke")}</Button>}</> : <p className="cpv2-muted">{t("noRevokeAvailable")}</p>}
      </article>
    </>;
  }}</PageBoundary>;
}

function PageBoundary({ resource, title, retryLabel, children, t }) {
  if (resource.state === "loading") return <LoadingState t={t} />;
  if (resource.state === "error") return <RouteProblem title={title} body={friendlyError(resource.error, t)} action={retryLabel ?? t?.("retry")} onAction={resource.retry} />;
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

function LoadingState({ t }) {
  return <section className="cpv2-loading" aria-busy="true" aria-label={t?.("loadingCreatorPage") ?? ""}><Skeleton lines={4} /></section>;
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

function localizedRouteTitle(route, t) {
  if (route.kind === "home") return t("creatorHome");
  if (route.kind === "products") return t("products");
  if (route.kind === "product-create") return t("createProduct");
  if (route.kind === "factory") return route.runId ? t("factoryRun") : t("creatorFactory");
  if (route.kind === "candidate") return t("candidateReview");
  if (route.kind === "preview") return t("storefrontPreview");
  if (route.kind === "release") return t("release");
  if (route.kind === "orders") return t("orders");
  if (route.kind === "order") return t("orderDetail");
  if (route.kind === "product") return t("product");
  return t("creatorDashboard");
}

function nextCreatorAction(products, t) {
  if (!products.length) return { label: t("startHere"), tone: "draft", title: t("createFocusedProduct"), body: t("createFocusedProductBody"), action: t("createProduct"), href: `${ROOT}/products/new` };
  for (const product of products) {
    if (product.status !== "published" && product.status !== "live") return { label: localizedProductStatus(product.status, t), tone: product.status, title: product.name ?? product.product_name ?? t("untitledProduct"), body: product.promise ?? product.description ?? t("continueProductWorkflow"), action: t("continueProduct"), href: `${ROOT}/products/${encodeURIComponent(idOf(product, "product"))}` };
  }
  const product = products[0];
  return { label: t("live"), tone: "published", title: product.name ?? product.product_name ?? t("untitledProduct"), body: t("storefrontLiveBody"), action: t("viewProduct"), href: `${ROOT}/products/${encodeURIComponent(idOf(product, "product"))}` };
}

function localizedProductStatus(status, t) {
  const key = `productStatus_${String(status ?? "draft").toLowerCase()}`;
  const translated = t(key);
  return translated === key ? t("productStatus_draft") : translated;
}

function productNextAction(product, candidate, t) {
  if ((product.status === "published" || product.status === "live") && !candidate) return { action: t("previewStorefront"), href: (id) => `${ROOT}/products/${encodeURIComponent(id)}/preview` };
  if (!candidate) return { action: t("continueInFactory"), href: (id) => `${ROOT}/products/${encodeURIComponent(id)}/about-you` };
  if (!isApproved(candidate)) return { action: t("reviewCandidate"), href: (id, value) => `${ROOT}/products/${encodeURIComponent(id)}/candidates/${encodeURIComponent(idOf(value, "candidate"))}` };
  return { action: t("previewStorefront"), href: (id) => `${ROOT}/products/${encodeURIComponent(id)}/preview` };
}

function candidateOf(product) { const candidate = product?.candidate ?? product?.current_candidate ?? product?.latest_candidate ?? (product?.candidate_id ? { candidate_id: product.candidate_id, status: product.candidate_status, version: product.candidate_version, digest: product.candidate_digest } : null); return candidate ? { ...candidate, approval_status: product?.approval?.status ?? candidate.approval_status, approved: product?.approval?.status === "approved" || candidate.approved } : null; }
function isApproved(candidate) { return ["approved", "publish_ready"].includes(candidate?.approval_status) || candidate?.approved === true || candidate?.status === "approved"; }
function approvalLabel(candidate, t) { if (isApproved(candidate)) return t ? t("approved") : "Approved"; if (["ready", "ready_for_review", "review_ready"].includes(candidate?.status ?? candidate?.run_status)) return t ? t("productStatus_ready_for_review") : "Ready for review"; return humanStatus(candidate?.status ?? candidate?.run_status ?? "preparing", t); }

function normalizeReadiness(preview, candidate, t) {
  const provided = arrayOf(preview?.readiness ?? preview?.checks);
  if (provided.length) return provided.map((item) => typeof item === "string" ? { label: item, detail: t("statusReady"), ready: true } : { label: item.label ?? item.name, detail: item.detail ?? item.message ?? (item.ready === false ? t("versionNeedsAttention") : t("statusReady")), ready: item.ready ?? item.passed ?? item.status === "ready" });
  if (preview?.readiness && !Array.isArray(preview.readiness)) return [
    { label: t("candidateApprovalCurrent"), detail: preview.readiness.candidate_approved ? t("boundCandidateDigest") : t("approveCandidateFirst"), ready: Boolean(preview.readiness.candidate_approved) },
    { label: t("permanentAccessConfigured"), detail: t("noCharge"), ready: true },
    { label: t("registryMaterialization"), detail: preview.readiness.ready ? t("readyToMaterialize") : t("completeRequiredChecks"), ready: Boolean(preview.readiness.ready) }
  ];
  return [
    { label: t("candidateApprovalCurrent"), detail: isApproved(candidate) ? t("boundCandidateDigest") : t("approveCandidateFirst"), ready: isApproved(candidate) },
    { label: t("permanentAccessConfigured"), detail: t("noCharge"), ready: true },
    { label: t("publicCopyBoundaries"), detail: preview?.product?.promise || preview?.promise ? t("buyerFacingCopyPresent") : t("addProductPromise"), ready: Boolean(preview?.product?.promise || preview?.promise || preview?.product?.description) },
    { label: t("registryMaterialization"), detail: preview?.materialization_status === "failed" ? t("materializationFailed") : t("readyToMaterialize"), ready: preview?.materialization_status !== "failed" }
  ];
}

function inferredTimeline(order, t) {
  const events = [{ label: t("orderCreated"), at: order.created_at ?? order.placed_at }];
  if (order.created_at || order.placed_at) events.push({ label: t("purchaseRecorded"), at: order.created_at ?? order.placed_at });
  if (order.entitlement_status) events.push({ label: t("accessEvent", humanStatus(order.entitlement_status, t)), at: order.entitlement_at });
  if (order.access_mode !== "unmetered" && order.delivery_status && !["not_started", "not_applicable"].includes(order.delivery_status)) events.push({ label: t("accessEvent", humanStatus(order.delivery_status, t)), at: order.delivery_completed_at ?? order.delivery_started_at });
  if (order.refund_status && order.refund_status !== "none") events.push({ label: t("refundEvent", humanStatus(order.refund_status, t)), at: order.refunded_at });
  return events;
}

function productStatus(status, t) { return localizedProductStatus(status, t); }
function statusTone(status) { if (["published", "live", "passed", "approved", "paid", "completed", "fulfilled", "available"].includes(status)) return "success"; if (["failed", "needs_attention", "candidate_rejected", "refunded", "reversed", "blocked"].includes(status)) return "danger"; if (["candidate_ready", "ready_to_preview", "ready_for_review", "review_ready", "pending", "processing", "reserved", "in_transit"].includes(status)) return "warning"; return "neutral"; }
const STATUS_MESSAGE_KEYS = {
  active: "statusActive", approved: "statusApproved", available: "statusAvailable", blocked: "statusBlocked", completed: "statusCompleted", failed: "statusFailed", fulfilled: "statusFulfilled", in_transit: "statusInTransit", pending: "statusPending", processing: "statusProcessing", published: "statusPublished", ready: "statusReady", refunded: "statusRefunded", refund_pending: "statusRefundPending", reserved: "statusReserved", reversed: "statusReversed", preparing: "statusPreparing", retired: "statusRetired", none: "statusNone"
};
function humanStatus(value, t) { if (!value) return t ? t("notProvided") : "—"; const raw = String(value); const key = STATUS_MESSAGE_KEYS[raw.toLowerCase()]; return t && key ? t(key) : raw.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function dateTime(value, locale = "en") { if (!value) return "—"; const date = new Date(value); if (Number.isNaN(date.valueOf())) return String(value); const intlLocale = locale === "zh" ? "zh-CN" : locale === "ja" ? "ja-JP" : "en"; return new Intl.DateTimeFormat(intlLocale, { dateStyle: "medium", timeStyle: "short" }).format(date); }
function shortDigest(value) { if (!value) return "—"; const text = String(value); return text.length > 22 ? `${text.slice(0, 12)}…${text.slice(-7)}` : text; }
function idOf(value, kind) { return String(value?.[`${kind}_id`] ?? value?.id ?? ""); }
function arrayOf(value) { if (Array.isArray(value)) return value; return []; }
function unwrap(payload, key) { return payload && Object.prototype.hasOwnProperty.call(payload, key) ? payload[key] : payload; }
function initials(name) { return String(name || "C").split(/\s+/).slice(0, 2).map((word) => word[0]?.toUpperCase()).join("") || "C"; }
function firstName(name) { return String(name || "").trim().split(/\s+/)[0] || ""; }
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
function friendlyError(error, t) { if (!error) return t ? t("unexpectedError") : ""; if (error.status === 401) return t ? t("sessionExpired") : ""; if (error.status === 403) return t ? t("creatorForbidden") : ""; if (error.status === 404) return t ? t("requestedResourceMissing") : ""; if (error.status === 409) return t ? t("pageChanged") : ""; if (error.status === 429) return t ? t("tooManyRequests") : ""; return error.message || (t ? t("serviceUnavailable") : ""); }
