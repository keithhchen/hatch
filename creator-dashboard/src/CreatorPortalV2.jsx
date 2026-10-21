import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Menu } from "lucide-react";
import {
  Button,
  DropdownMenu,
  FormField,
  IconButton,
  InlineAlert as HatchInlineAlert,
  Input,
  Select,
  Skeleton,
  Textarea,
  UnavailableState
} from "@hatch/ui";
import { ButtonBase, Divider as MuiDivider, ListItemIcon, ListItemText, Menu as MuiMenu, MenuItem as MuiMenuItem, Typography as MuiTypography } from "@mui/material";
import { Check, ExpandMore, Language as LanguageIcon, Logout } from "@mui/icons-material";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import { hatchMuiThemeOptions } from "@hatch/ui";
import { StorefrontDetails } from "./StorefrontDetails.jsx";
import { AccountAvatar } from "./AccountAvatar.jsx";
import { WebBrand } from "./WebBrand.jsx";
import { creatorOrderQuery } from "./storefrontModel.js";
import { creatorFactoryPath, creatorProductPath, parseCreatorRoute } from "./creatorRoutes.js";
import { createCreatorTranslator } from "./creatorI18n.js";
import { isProductLive, studioNextStep, studioPathStates } from "./studioPath.js";
import { StudioPathCards } from "./studioPathCards.jsx";
import { useLocale } from "./locale.jsx";
import "./creatorPortalV2.css";

const ROOT = "/studio";
const FactoryAgents = React.lazy(() => import("./FactoryAgents.jsx").then(({ FactoryAgents: Component }) => ({ default: Component })));
const CreatorProductFiles = React.lazy(() => import("./CreatorSourceLibrary.jsx").then(({ CreatorProductFiles: Component }) => ({ default: Component })));
const CreatorProductWorkspace = React.lazy(() => import("./CreatorProductWorkspace.jsx").then(({ CreatorProductWorkspace: Component }) => ({ default: Component })));

const creatorMuiTheme = createTheme(hatchMuiThemeOptions);

export function CreatorPortalV2({
  pathname = typeof window === "undefined" ? ROOT : window.location.pathname,
  navigate = defaultNavigate,
  token,
  request,
  profile,
  onLogout
}) {
  const route = useMemo(() => parseCreatorRoute(pathname), [pathname]);
  const { locale, setLocale } = useLocale();
  const [accountAnchorEl, setAccountAnchorEl] = useState(null);
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

  const inAgents = route.section === "products";
  const mobileNavigationItems = [
    { value: "space-studio", label: t("home"), active: route.kind === "home", onSelect: () => void go(ROOT) },
    { value: "products", label: t("navAgents"), active: inAgents, onSelect: () => void go(`${ROOT}/products`) },
    { value: "download", label: t("download"), onSelect: () => void go("/download") },
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

  const accountMenuOpen = Boolean(accountAnchorEl);
  const closeAccountMenu = () => setAccountAnchorEl(null);
  const displayName = profile?.display_name || t("creator");

  return (
    <ThemeProvider theme={creatorMuiTheme}>
      <div className="cpv2">
        <header className="cpv2-topbar">
          <WebBrand className="cpv2-brand" label={t("studio")} href={ROOT} aria-label={t("hatchCreatorHome")} onClick={(event) => { event.preventDefault(); void go(ROOT); }} />
          <nav className="cpv2-global-nav" aria-label={t("hatchNavigation")}>
            <SpaceLink href={ROOT} navigate={go} active={route.kind === "home"}>{t("home")}</SpaceLink>
            <SpaceLink href={`${ROOT}/products`} navigate={go} active={inAgents}>{t("navAgents")}</SpaceLink>
          </nav>
          <div className="cpv2-topbar-end">
            <ButtonBase
              className="cpv2-account-trigger"
              onClick={(event) => setAccountAnchorEl(event.currentTarget)}
              aria-controls={accountMenuOpen ? "creator-account-menu" : undefined}
              aria-expanded={accountMenuOpen ? "true" : undefined}
              aria-haspopup="menu"
              aria-label={t("account")}
            >
              <AccountAvatar className="cpv2-avatar" src={profile?.avatar_url} name={displayName} size="small" />
              <span className="cpv2-account-name">{displayName}</span>
              <ExpandMore className="cpv2-account-chevron" fontSize="small" aria-hidden="true" />
            </ButtonBase>
            <div className="cpv2-mobile-nav">
              <DropdownMenu
                label={t("creatorNavigation")}
                trigger={<IconButton label={t("openNavigation")} variant="secondary" size="small"><Menu aria-hidden="true" /></IconButton>}
                items={mobileNavigationItems}
              />
            </div>
          </div>
          <MuiMenu
            id="creator-account-menu"
            anchorEl={accountAnchorEl}
            open={accountMenuOpen}
            onClose={closeAccountMenu}
            anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            transformOrigin={{ vertical: "top", horizontal: "right" }}
            PaperProps={{ className: "cpv2-account-menu", sx: { minWidth: 248, mt: 1 } }}
            MenuListProps={{ dense: true, "aria-label": t("account") }}
          >
            <div className="cpv2-account-menu-header">
              <AccountAvatar className="cpv2-avatar" src={profile?.avatar_url} name={displayName} size="small" />
              <MuiTypography variant="subtitle2" fontWeight={700}>{displayName}</MuiTypography>
            </div>
            <MuiDivider />
            <MuiMenuItem onClick={() => { closeAccountMenu(); void go("/account"); }}><ListItemText primary={t("account")} /></MuiMenuItem>
            <MuiMenuItem onClick={() => { closeAccountMenu(); void go("/download"); }}><ListItemText primary={t("download")} /></MuiMenuItem>
            <MuiDivider />
            <div className="cpv2-account-menu-label"><LanguageIcon fontSize="small" /><span>{t("language")}</span></div>
            {[['en', t("english")], ['zh', t("chinese")], ['ja', t("japanese")]].map(([value, label]) => <MuiMenuItem key={value} selected={locale === value} onClick={() => { setLocale(value); closeAccountMenu(); }}><ListItemIcon>{locale === value ? <Check fontSize="small" /> : <span className="cpv2-menu-icon-placeholder" />}</ListItemIcon><ListItemText primary={label} /></MuiMenuItem>)}
            {onLogout ? <><MuiDivider /><MuiMenuItem onClick={() => { closeAccountMenu(); void onLogout(); }}><ListItemIcon><Logout fontSize="small" /></ListItemIcon><ListItemText primary={t("signOut")} /></MuiMenuItem></> : null}
          </MuiMenu>
        </header>
        <main id="creator-main" className={`cpv2-main${route.kind === "factory-agents" ? " cpv2-main--workbench" : ""}`} ref={mainRef}>
          <CreatorRoute route={route} token={token} request={request} navigate={go} locale={locale} t={t} profile={profile} registerNavigationGuard={registerNavigationGuard} />
        </main>
      </div>
    </ThemeProvider>
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

function CreatorRoute({ route, token, request, navigate, locale, t, profile }) {
  if (typeof request !== "function") {
    return <RouteProblem title={t("creatorPortalUnavailable")} body={t("creatorPortalUnavailableBody")} />;
  }
  if (route.kind === "factory-index") return <FactoryIndexRedirect navigate={navigate} />;
  if (route.kind === "factory-agents") return <Suspense fallback={<LoadingState t={t} />}><FactoryAgents key={route.productId} productId={route.productId} section={route.factorySection} agent={route.factoryAgent} navigate={navigate} locale={locale} /></Suspense>;
  if (route.kind === "home") return <CreatorHome token={token} request={request} navigate={navigate} t={t} locale={locale} />;
  if (route.kind === "products") return <ProductsPage token={token} request={request} navigate={navigate} t={t} />;
  if (route.kind === "product-create") return <Suspense fallback={<LoadingState t={t} />}><CreatorProductFiles token={token} navigate={navigate} locale={locale} /></Suspense>;
  if (route.kind === "product") return <FactoryProductRedirect productId={route.productId} navigate={navigate} />;
  if (route.kind === "candidate") return <Suspense fallback={<LoadingState t={t} />}><CreatorProductWorkspace token={token} request={request} navigate={navigate} productId={route.productId} tab="corpus" locale={locale} /></Suspense>;
  if (route.kind === "preview") return <PreviewPage token={token} request={request} navigate={navigate} productId={route.productId} profile={profile} t={t} />;
  if (route.kind === "release") return <ReleasePage token={token} request={request} navigate={navigate} productId={route.productId} releaseId={route.releaseId} profile={profile} t={t} locale={locale} />;
  if (route.kind === "orders") return <OrdersPage token={token} request={request} navigate={navigate} t={t} locale={locale} />;
  if (route.kind === "order") return <OrderPage token={token} request={request} navigate={navigate} orderId={route.orderId} t={t} locale={locale} />;
  return <RouteProblem title={t("pageNotFound")} body={t("pageNotFoundBody")} action={t("backToProducts")} onAction={() => navigate(`${ROOT}/products`)} />;
}

/* ---------- Home ---------- */

function CreatorHome({ token, request, navigate, t, locale }) {
  const resource = useRemote(request, "/v1/creator/overview", token);
  return (
    <PageBoundary resource={resource} title={t("workspaceLoadError")} retryLabel={t("retry")} t={t}>
      {(payload) => {
        const overview = unwrap(payload, "overview");
        const products = arrayOf(overview?.products);
        const orders = arrayOf(overview?.recent_orders ?? overview?.orders);
        if (products.length === 0) return <CreatorZeroProductIntro navigate={navigate} t={t} />;
        const metrics = overview?.metrics ?? {};
        const live = products.filter(isProductLive);
        const next = products.find((product) => !isProductLive(product)) ?? products[0];
        const purchaseCount = Number(metrics.orders ?? metrics.order_count ?? orders.length) || 0;
        return <>
          <Hero pill={t("homePill")} title={t("homeTitle")} />
          <NextAgentCard product={next} request={request} token={token} navigate={navigate} t={t} />
          <dl className="cpv2-stats">
            <div><dt>{t("homeStatOrders")}</dt><dd>{purchaseCount}</dd></div>
            <div><dt>{t("homeStatLive")}</dt><dd>{live.length}</dd></div>
            <div><dt>{t("homeStatDraft")}</dt><dd>{products.length - live.length}</dd></div>
          </dl>
          <SectionHeading title={t("homeYourAgents")} action={t("newAgent")} onAction={() => navigate(`${ROOT}/products/new`)} />
          <section className="cpv2-product-grid" aria-label={t("homeYourAgents")}>
            {products.map((product) => <ProductCard key={idOf(product, "product")} product={product} t={t} request={request} token={token} onChanged={resource.retry} onOpen={() => navigate(creatorProductPath(idOf(product, "product")))} />)}
          </section>
          <SectionHeading title={t("homeRecentOrders")} action={orders.length ? t("homeSeeOrders") : undefined} onAction={() => navigate(`${ROOT}/orders`)} />
          {orders.length ? <OrderList orders={orders} onOpen={(order) => navigate(`${ROOT}/orders/${encodeURIComponent(idOf(order, "order"))}`)} t={t} locale={locale} /> : <p className="cpv2-quiet">{t("homeNoOrders")}</p>}
        </>;
      }}
    </PageBoundary>
  );
}

function NextAgentCard({ product, request, token, navigate, t }) {
  const productId = idOf(product, "product");
  const factory = useRemote(request, `/v1/creator/products/${encodeURIComponent(productId)}/factory-agents/config`, token);
  const live = isProductLive(product);
  const states = factory.state === "ready" ? studioPathStates(arrayOf(factory.data?.agents), product) : null;
  const next = states ? studioNextStep(states) : null;
  return <article className="cpv2-next web-card">
    <div className="cpv2-next__body">
      <span className={`cpv2-state${live ? " is-live" : ""}`}>{t(live ? "agentLive" : "agentDraft")}</span>
      <h2>{product.name ?? product.product_name ?? t("untitledProduct")}</h2>
      <p>{live ? t("homeLiveBody") : product.promise ?? product.description ?? ""}</p>
      {states ? <ol className="cpv2-path-dots" aria-label={t("factoryStepsLabel")}>{states.map(({ step, state }) => <li key={step.id} className={`is-${state}${next?.step.id === step.id ? " is-next" : ""}`}><span aria-hidden="true" /><small>{t(step.title)}</small></li>)}</ol> : null}
      {next && !live ? <p className="cpv2-next__step">{t("homeNext", t(next.step.title))}</p> : null}
      <Button className="web-btn-yolk" type="button" trailing={<span aria-hidden="true">→</span>} onClick={() => navigate(creatorProductPath(productId))}>{live ? t("agentOpen") : t("agentContinue")}</Button>
    </div>
  </article>;
}

// The only photo in Studio: a people-free still life that fills the otherwise empty first-run home.
const STUDIO_EMPTY_PHOTO = "/assets/web/photos/v_desk.jpg";

function CreatorZeroProductIntro({ navigate, t }) {
  return <section className="cpv2-welcome" aria-labelledby="creator-zero-product-title">
    <div className="cpv2-welcome__top">
      <div className="cpv2-welcome__intro">
        <span className="web-pill">{t("homeEmptyPill")}</span>
        <h1 id="creator-zero-product-title">{t("homeEmptyTitle")}</h1>
        <p>{t("homeEmptyBody")}</p>
        <Button className="web-btn-yolk" type="button" trailing={<span aria-hidden="true">→</span>} onClick={() => navigate(`${ROOT}/products/new`)}>{t("homeStartFirst")}</Button>
      </div>
      <img className="cpv2-welcome__photo" src={STUDIO_EMPTY_PHOTO} alt="" />
    </div>
    <h2 className="cpv2-welcome__path-title">{t("homePathTitle")}</h2>
    <StudioPathCards t={t} />
  </section>;
}

/* ---------- Agents (Products) ---------- */

function ProductsPage({ token, request, navigate, t }) {
  const resource = useRemote(request, "/v1/creator/products", token);
  return (
    <PageBoundary resource={resource} title={t("productsLoadError")} retryLabel={t("retry")} t={t}>
      {(payload) => {
        const products = arrayOf(unwrap(payload, "products"));
        return <>
          <Hero pill={t("agentsPill")} title={t("agentsTitle")} action={t("newAgent")} onAction={() => navigate(`${ROOT}/products/new`)} />
          {products.length ? <section className="cpv2-product-grid" aria-label={t("navAgents")}>
            {products.map((product) => <ProductCard key={idOf(product, "product")} product={product} t={t} request={request} token={token} onChanged={resource.retry} onOpen={() => navigate(creatorProductPath(idOf(product, "product")))} />)}
          </section> : <EmptyState title={t("agentsEmptyTitle")} body={t("agentsEmptyBody")} action={t("homeStartFirst")} onAction={() => navigate(`${ROOT}/products/new`)} />}
        </>;
      }}
    </PageBoundary>
  );
}

function ProductCard({ product, onOpen, request, token, onChanged, t }) {
  const published = isProductLive(product);
  const publicHref = published ? `/products/${encodeURIComponent(idOf(product, "product"))}` : "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function withdraw() {
    if (!published || busy || !window.confirm(t("agentUnpublishConfirm"))) return;
    setBusy(true); setError("");
    try {
      await request(`/v1/creator/products/${encodeURIComponent(idOf(product, "product"))}/withdraw`, { method: "POST", token, headers: { "idempotency-key": mutationKey() }, body: JSON.stringify({ reason: "Expert unpublished this Product." }) });
      onChanged?.();
    } catch (nextError) { setError(friendlyError(nextError, t)); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (published || busy || !window.confirm(t("agentDeleteConfirm"))) return;
    setBusy(true); setError("");
    try {
      await request(`/v1/creator/products/${encodeURIComponent(idOf(product, "product"))}`, { method: "DELETE", token });
      onChanged?.();
    } catch (nextError) { setError(friendlyError(nextError, t)); }
    finally { setBusy(false); }
  }
  return <article className="cpv2-product-card web-card">
    <span className={`cpv2-state${published ? " is-live" : ""}`}>{published ? t("agentLive") : t("agentDraft")}</span>
    <h2>{product.name ?? product.product_name ?? t("untitledProduct")}</h2>
    <p>{product.promise ?? product.description ?? t("addProductPromise")}</p>
    {error ? <InlineError>{error}</InlineError> : null}
    <div className="cpv2-card-foot">
      <Button type="button" onClick={onOpen}>{published ? t("agentOpen") : t("agentContinue")}</Button>
      {publicHref ? <a className="cpv2-text-link" href={publicHref} target="_blank" rel="noreferrer">{t("viewProduct")}</a> : null}
      {published
        ? <button className="cpv2-text-link cpv2-text-link--quiet" type="button" disabled={busy} onClick={() => void withdraw()}>{t("agentUnpublish")}</button>
        : <button className="cpv2-text-link cpv2-text-link--quiet" type="button" disabled={busy} onClick={() => void remove()}>{t("agentDelete")}</button>}
    </div>
  </article>;
}

function FactoryIndexRedirect({ navigate }) {
  useEffect(() => { navigate(`${ROOT}/products`); }, [navigate]);
  return null;
}

function FactoryProductRedirect({ productId, navigate }) {
  useEffect(() => { navigate(creatorFactoryPath(productId)); }, [navigate, productId]);
  return null;
}

/* ---------- Client page preview ---------- */

function PreviewPage({ token, request, navigate, productId, profile, t }) {
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
      await navigator.clipboard.writeText(new URL(url, window.location.origin).href);
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

  const back = <BackLink onClick={() => navigate(creatorFactoryPath(productId))}>{t("previewBack")}</BackLink>;

  if (published) {
    const publicUrl = canonicalPublicUrl(published.canonical_url ?? published.public_url ?? published.product?.canonical_url ?? published.product?.public_url)
      ?? (isUuidV4(productId) ? `/products/${productId}` : undefined);
    return <section className="cpv2-published" aria-live="polite">{back}<Hero pill={t("agentLive")} title={t("yourProductLive")} body={t("publishedBody")} /><div className="cpv2-share web-card"><FormField label={t("shareLink")}><Input readOnly value={publicUrl ?? t("publicationCompleted")} onFocus={(event) => event.target.select()} /></FormField><div className="cpv2-actions">{publicUrl ? <Button className="web-btn-yolk" type="button" onClick={() => copy(publicUrl)}>{copied ? t("copied") : t("copyLink")}</Button> : null}{publicUrl ? <Button asChild variant="secondary"><a href={safePublicUrl(publicUrl)} target="_blank" rel="noreferrer">{t("viewStorefront")}</a></Button> : null}</div>{error ? <InlineError>{error}</InlineError> : null}</div></section>;
  }

  return <PageBoundary resource={resource} title={t("previewLoadError")} retryLabel={t("retry")} t={t}>{(payload) => {
    const preview = payload?.preview && typeof payload.preview === "object" ? payload.preview : payload;
    const product = preview.product ?? preview;
    const candidate = preview.candidate ?? candidateOf(product);
    const live = isProductLive(product);
    const publicUrl = live ? canonicalPublicUrl(preview.public_url ?? product.public_url) : undefined;
    const readiness = normalizeReadiness(preview, candidate, t);
    const ready = readiness.every((item) => item.ready);
    return <>
      {back}
      <Hero pill={t("previewPill")} title={t("previewTitle")} body={live ? t("factoryShipLive") : t("previewBody")} />
      {error ? <InlineError>{error}</InlineError> : null}
      {publicUrl ? <div className="cpv2-share web-card"><FormField label={t("shareLink")}><Input readOnly value={new URL(publicUrl, window.location.origin).href} onFocus={(event) => event.target.select()} /></FormField><div className="cpv2-actions"><Button className="web-btn-yolk" type="button" onClick={() => copy(publicUrl)}>{copied ? t("copied") : t("copyLink")}</Button><Button asChild variant="secondary"><a href={safePublicUrl(publicUrl)} target="_blank" rel="noreferrer">{t("viewStorefront")}</a></Button></div></div> : null}
      <div className="cpv2-segmented" role="group" aria-label={t("previewViewport")}>
        <button type="button" className={viewport === "desktop" ? "is-active" : ""} aria-pressed={viewport === "desktop"} onClick={() => setViewport("desktop")}>{t("desktop")}</button>
        <button type="button" className={viewport === "mobile" ? "is-active" : ""} aria-pressed={viewport === "mobile"} onClick={() => setViewport("mobile")}>{t("mobile")}</button>
      </div>
      <div className={`cpv2-storefront-frame web-card is-${viewport}`}><StorefrontDetails product={product} creatorName={preview.creator?.display_name ?? preview.creator_name ?? profile?.display_name} creatorAvatarUrl={preview.creator?.avatar_url ?? profile?.avatar_url} mode="preview" headingLevel={2} desktopRequirement={preview.desktop_requirement ?? product.desktop_requirement} releaseLabel={candidate ? `${t("candidateVersion", candidate.version ?? "—")}` : undefined} action={<Button type="button" disabled>{t("getAccess")}</Button>} /></div>
      {!live && candidate ? <article className="cpv2-readiness web-card"><SectionHeading title={t("finalChecks")} /><ul>{readiness.map((item) => <li key={item.label} className={item.ready ? "is-ready" : ""}><span aria-hidden="true">{item.ready ? "✓" : "·"}</span><strong>{item.label}</strong><small>{item.detail}</small></li>)}</ul>{confirming ? <div className="cpv2-confirm"><p><strong>{t("publishCandidateConfirm")}</strong><br />{t("publicPointerAfterMaterialization")}</p><div className="cpv2-actions"><Button variant="secondary" type="button" onClick={() => setConfirming(false)}>{t("cancel")}</Button><Button className="web-btn-yolk" type="button" loading={publishing} disabled={!ready} onClick={() => publish({ ...preview, product, candidate })}>{t("confirmPublish")}</Button></div></div> : <Button className="web-btn-yolk" type="button" disabled={!ready} onClick={() => setConfirming(true)}>{t("publish")}</Button>}</article> : null}
    </>;
  }}</PageBoundary>;
}

function ReleasePage({ token, request, navigate, productId, releaseId, profile, t, locale }) {
  const resource = useRemote(request, `/v1/creator/products/${encodeURIComponent(productId)}`, token);
  const [state, setState] = useState({ busy: false, error: "", done: false, reason: "", confirming: false });
  return <PageBoundary resource={resource} title={t("releaseLoadError")} retryLabel={t("retry")} t={t}>{(payload) => {
    const product = unwrap(payload, "product") ?? payload;
    const release = arrayOf(product.releases).find((item) => idOf(item, "release") === releaseId) ?? (idOf(product.release, "release") === releaseId ? { ...product.release, current: true } : null) ?? product.active_release;
    const back = <BackLink onClick={() => navigate(creatorFactoryPath(productId))}>{product.name ?? t("product")}</BackLink>;
    if (!release) return <>{back}<RouteProblem title={t("releaseNotFound")} body={t("releaseHistoryMissing")} /></>;
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
    return <>{back}<Hero pill={t("release")} title={release.label ?? `${t("release")} ${release.version ?? ""}`} body={t("existingAccessPinned")} />{state.error ? <InlineError>{state.error}</InlineError> : null}{state.done ? <SuccessNotice>{t("currentReleaseUpdated")}</SuccessNotice> : null}<article className="cpv2-panel web-card"><dl className="cpv2-fact-grid"><Fact label={t("publishedAt")} value={dateTime(release.published_at ?? release.created_at, locale)} /><Fact label={t("status")} value={release.current ? t("current") : t("previous")} /><Fact label={t("materialization")} value={release.materialization_status ? humanStatus(release.materialization_status, t) : t("notProvided")} /></dl></article>{release.current ? <p className="cpv2-quiet">{t("alreadyCurrentRelease")}</p> : <section className="cpv2-panel web-card"><SectionHeading title={t("makeExactReleaseCurrent")} /><p className="cpv2-quiet">{t("releaseFixedByPage")}</p><FormField label={t("auditReason")} required><Textarea required value={state.reason} onChange={(event) => setState((current) => ({ ...current, reason: event.target.value, confirming: false }))} placeholder={t("whyReleaseCurrent")} /></FormField><div className="cpv2-storefront-frame is-desktop"><StorefrontDetails product={product} creatorName={product.creator_name ?? profile?.display_name} creatorAvatarUrl={profile?.avatar_url} mode="preview" headingLevel={2} desktopRequirement={product.desktop_requirement} releaseLabel={release.label ?? releaseId} action={<Button type="button" disabled>{t("getAccess")}</Button>} /></div>{state.confirming ? <div className="cpv2-confirm" role="alert"><p><strong>{t("exactReleaseConfirm")}</strong><br />{t("rollbackAudit")}</p><div className="cpv2-actions"><Button variant="secondary" type="button" onClick={() => setState((current) => ({ ...current, confirming: false }))}>{t("cancel")}</Button><Button className="web-btn-yolk" type="button" loading={state.busy} disabled={!state.reason.trim()} onClick={rollback}>{t("confirmRollback")}</Button></div></div> : <Button type="button" disabled={!state.reason.trim()} onClick={() => setState((current) => ({ ...current, confirming: true }))}>{t("reviewRollback")}</Button>}</section>}</>;
  }}</PageBoundary>;
}

/* ---------- Orders ---------- */

const EMPTY_ORDER_FILTERS = { order: "", product: "", from: "", to: "", limit: "25" };

function OrdersPage({ token, request, navigate, t, locale }) {
  const [filters, setFilters] = useState(EMPTY_ORDER_FILTERS);
  const query = useMemo(() => creatorOrderQuery(filters), [filters]);
  const resource = useRemote(request, `/v1/creator/orders${query ? `?${query}` : ""}`, token);
  const products = useRemote(request, "/v1/creator/products", token);
  const productOptions = arrayOf(unwrap(products.data, "products")).map((product) => ({ value: idOf(product, "product"), label: product.name ?? product.product_name ?? t("untitledProduct") }));
  const setFilter = (key) => (value) => setFilters((current) => ({ ...current, [key]: value === "all" ? "" : value }));
  return <>
    <Hero pill={t("ordersPill")} title={t("ordersTitle")} body={t("ordersBody")} />
    <form className="cpv2-filters web-card" onSubmit={(event) => event.preventDefault()}>
      <FormField label={t("ordersFilterAgent")}><Select label={t("ordersFilterAgent")} value={filters.product || "all"} onValueChange={setFilter("product")} options={[{ value: "all", label: t("ordersAllAgents") }, ...productOptions]} /></FormField>
      <FormField label={t("orderStatus")}><Select label={t("orderStatus")} value={filters.order || "all"} onValueChange={setFilter("order")} options={[{ value: "all", label: t("all") }, { value: "fulfilled", label: t("fulfilled") }, { value: "refund_pending", label: t("refundPending") }, { value: "refunded", label: t("refunded") }, { value: "failed", label: t("failedOrder") }]} /></FormField>
      <FormField label={t("fromDate")}><Input type="date" value={filters.from} max={filters.to || undefined} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} /></FormField>
      <FormField label={t("toDate")}><Input type="date" value={filters.to} min={filters.from || undefined} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} /></FormField>
      <button className="cpv2-text-link" type="button" onClick={() => setFilters(EMPTY_ORDER_FILTERS)}>{t("clearFilters")}</button>
    </form>
    <PageBoundary resource={resource} title={t("ordersLoadError")} retryLabel={t("retry")} t={t}>{(payload) => <PaginatedOrders initialPayload={payload} query={query} token={token} request={request} navigate={navigate} t={t} locale={locale} />}</PageBoundary>
  </>;
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

  if (!page.orders.length) return <EmptyState title={t("ordersEmptyTitle")} body={t("ordersEmptyBody")} />;
  return <><OrderList orders={page.orders} onOpen={(order) => navigate(`${ROOT}/orders/${encodeURIComponent(order.order_number ?? order.order_reference ?? idOf(order, "order"))}`)} t={t} locale={locale} />{error ? <InlineError>{error}</InlineError> : null}{page.cursor ? <Button className="cpv2-load-more" variant="secondary" type="button" loading={loadingMore} onClick={loadMore}>{t("loadNextPage")}</Button> : null}</>;
}

function OrderList({ orders, onOpen, t, locale }) {
  return <ul className="cpv2-order-list">{orders.map((order) => {
    const reference = order.order_number ?? order.order_reference ?? idOf(order, "order");
    return <li key={idOf(order, "order")}>
      <button type="button" className="cpv2-order web-card" onClick={() => onOpen(order)} aria-label={t("viewAccessRecord", reference)}>
        <span className="cpv2-order__who"><strong>{order.product_name ?? order.product?.name ?? t("productAccess")}</strong><small>{order.buyer_display_name ?? t("buyer")} · {dateTime(order.created_at ?? order.placed_at, locale)}</small></span>
        <span className="cpv2-state">{humanStatus(order.entitlement_status ?? order.status ?? order.order_status, t)}</span>
        <span className="cpv2-order__arrow" aria-hidden="true">→</span>
      </button>
    </li>;
  })}</ul>;
}

function OrderPage({ token, request, navigate, orderId, t, locale }) {
  const resource = useRemote(request, `/v1/creator/orders/${encodeURIComponent(orderId)}`, token);
  return <>
    <BackLink onClick={() => navigate(`${ROOT}/orders`)}>{t("navOrders")}</BackLink>
    <PageBoundary resource={resource} title={t("orderLoadError")} retryLabel={t("retry")} t={t}>{(payload) => {
      const order = unwrap(payload, "order") ?? payload;
      return <>
        <Hero pill={t("orderDetail")} title={order.product_name ?? order.product?.name ?? t("orderDetail")} body={`${order.buyer_display_name ?? t("buyer")} · ${dateTime(order.created_at ?? order.placed_at, locale)}`} />
        <article className="cpv2-panel web-card">
          <dl className="cpv2-fact-grid">
            <Fact label={t("buyer")} value={order.buyer_display_name ?? t("notProvided")} />
            <Fact label={t("placedAt")} value={dateTime(order.created_at ?? order.placed_at, locale)} />
            <Fact label={t("access")} value={humanStatus(order.entitlement_status ?? order.status ?? order.order_status, t)} />
          </dl>
        </article>
      </>;
    }}</PageBoundary>
  </>;
}

/* ---------- Shared pieces ---------- */

function PageBoundary({ resource, title, retryLabel, children, t }) {
  if (resource.state === "loading") return <LoadingState t={t} />;
  if (resource.state === "error") return <RouteProblem title={title} body={friendlyError(resource.error, t)} action={retryLabel ?? t?.("retry")} onAction={resource.retry} />;
  return <>{children(resource.data)}</>;
}

function Hero({ pill, title, body, action, onAction }) {
  return <header className="cpv2-hero">
    <div>
      {pill ? <span className="web-pill">{pill}</span> : null}
      <h1>{title}</h1>
      {body ? <p>{body}</p> : null}
    </div>
    {action ? <Button className="web-btn-yolk" type="button" onClick={onAction}>{action}</Button> : null}
  </header>;
}

function SectionHeading({ title, action, onAction }) {
  return <div className="cpv2-section-heading"><h2>{title}</h2>{action ? <button className="cpv2-text-link" type="button" onClick={onAction}>{action} →</button> : null}</div>;
}

function BackLink({ children, onClick }) { return <button className="cpv2-back" type="button" onClick={onClick}><span aria-hidden="true">←</span> {children}</button>; }
function Fact({ label, value }) { const missing = value === undefined || value === null || value === ""; return <div><dt>{label}</dt><dd title={typeof value === "string" ? value : undefined}>{missing ? "—" : value}</dd></div>; }
function InlineError({ children }) { return <HatchInlineAlert className="cpv2-alert" tone="error">{children}</HatchInlineAlert>; }
function SuccessNotice({ children }) { return <HatchInlineAlert className="cpv2-success" tone="success">{children}</HatchInlineAlert>; }

function EmptyState({ title, body, action, onAction }) {
  return <section className="cpv2-empty web-card"><h2>{title}</h2><p>{body}</p>{action ? <Button className="web-btn-yolk" type="button" onClick={onAction}>{action}</Button> : null}</section>;
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
  if (route.kind === "products" || route.kind === "factory-agents" || route.kind === "factory-index") return t("navAgents");
  if (route.kind === "product-create") return t("newAgent");
  if (route.kind === "preview") return t("previewPill");
  if (route.kind === "release") return t("release");
  if (route.kind === "orders") return t("navOrders");
  if (route.kind === "order") return t("orderDetail");
  return t("studio");
}

function candidateOf(product) { const candidate = product?.candidate ?? product?.current_candidate ?? product?.latest_candidate ?? (product?.candidate_id ? { candidate_id: product.candidate_id, status: product.candidate_status, version: product.candidate_version, digest: product.candidate_digest } : null); return candidate ? { ...candidate, approval_status: product?.approval?.status ?? candidate.approval_status, approved: product?.approval?.status === "approved" || candidate.approved } : null; }
function isApproved(candidate) { return ["approved", "publish_ready"].includes(candidate?.approval_status) || candidate?.approved === true || candidate?.status === "approved"; }

function normalizeReadiness(preview, candidate, t) {
  const provided = arrayOf(preview?.readiness ?? preview?.checks);
  if (provided.length) return provided.map((item) => typeof item === "string" ? { label: item, detail: t("statusReady"), ready: true } : { label: item.label ?? item.name, detail: item.detail ?? item.message ?? (item.ready === false ? t("versionNeedsAttention") : t("statusReady")), ready: item.ready ?? item.passed ?? item.status === "ready" });
  if (preview?.readiness && !Array.isArray(preview.readiness)) return [
    { label: t("candidateApprovalCurrent"), detail: preview.readiness.candidate_approved ? t("boundCandidateDigest") : t("approveCandidateFirst"), ready: Boolean(preview.readiness.candidate_approved) },
    { label: t("registryMaterialization"), detail: preview.readiness.ready ? t("readyToMaterialize") : t("completeRequiredChecks"), ready: Boolean(preview.readiness.ready) }
  ];
  return [
    { label: t("candidateApprovalCurrent"), detail: isApproved(candidate) ? t("boundCandidateDigest") : t("approveCandidateFirst"), ready: isApproved(candidate) },
    { label: t("registryMaterialization"), detail: preview?.materialization_status === "failed" ? t("materializationFailed") : t("readyToMaterialize"), ready: preview?.materialization_status !== "failed" }
  ];
}

const STATUS_MESSAGE_KEYS = {
  active: "statusActive", approved: "statusApproved", available: "statusAvailable", blocked: "statusBlocked", completed: "statusCompleted", failed: "statusFailed", fulfilled: "statusFulfilled", in_transit: "statusInTransit", pending: "statusPending", processing: "statusProcessing", published: "statusPublished", ready: "statusReady", refunded: "statusRefunded", refund_pending: "statusRefundPending", reserved: "statusReserved", reversed: "statusReversed", preparing: "statusPreparing", retired: "statusRetired", none: "statusNone"
};
function humanStatus(value, t) { if (!value) return t ? t("notProvided") : "—"; const raw = String(value); const key = STATUS_MESSAGE_KEYS[raw.toLowerCase()]; return t && key ? t(key) : raw.replaceAll("_", " "); }
function dateTime(value, locale = "en") { if (!value) return "—"; const date = new Date(value); if (Number.isNaN(date.valueOf())) return String(value); const intlLocale = locale === "zh" ? "zh-CN" : locale === "ja" ? "ja-JP" : "en"; return new Intl.DateTimeFormat(intlLocale, { dateStyle: "medium", timeStyle: "short" }).format(date); }
function idOf(value, kind) { return String(value?.[`${kind}_id`] ?? value?.id ?? ""); }
function arrayOf(value) { if (Array.isArray(value)) return value; return []; }
function unwrap(payload, key) { return payload && Object.prototype.hasOwnProperty.call(payload, key) ? payload[key] : payload; }
function mutationKey() { return globalThis.crypto?.randomUUID?.() ?? `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function safePublicUrl(value) { const text = String(value ?? ""); return /^https?:\/\//i.test(text) || /^\/products\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text) ? text : undefined; }

function canonicalPublicUrl(value) {
  const text = String(value ?? "");
  if (!text) return undefined;
  if (/^https:\/\//i.test(text)) return text;
  return safePublicUrl(text);
}
function isUuidV4(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? "")); }
function friendlyError(error, t) { if (!error) return t ? t("unexpectedError") : ""; if (error.status === 401) return t ? t("sessionExpired") : ""; if (error.status === 403) return t ? t("creatorForbidden") : ""; if (error.status === 404) return t ? t("requestedResourceMissing") : ""; if (error.status === 409) return t ? t("pageChanged") : ""; if (error.status === 429) return t ? t("tooManyRequests") : ""; return error.message || (t ? t("serviceUnavailable") : ""); }
