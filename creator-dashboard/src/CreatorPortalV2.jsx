import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Bot, Check, ChevronsUpDown, Copy, Download, ExternalLink, Languages, LayoutDashboard, LogOut, Menu, MoreHorizontal, Plus, ReceiptText, Search, Settings, X } from "lucide-react";
import { Button, CommandMenu, ConfirmDialog, DropdownMenu, IconButton } from "@hatch/ui";
import { ButtonBase, Divider as MuiDivider, ListItemIcon, ListItemText, Menu as MuiMenu, MenuItem as MuiMenuItem } from "@mui/material";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import { hatchMuiThemeOptions } from "@hatch/ui";
import { AccountAvatar } from "./AccountAvatar.jsx";
import { WebBrand } from "./WebBrand.jsx";
import { creatorProductPath, parseCreatorRoute } from "./creatorRoutes.js";
import { createCreatorTranslator } from "./creatorI18n.js";
import { isProductLive } from "./studioPath.js";
import { StudioPathCards } from "./studioPathCards.jsx";
import { useLocale } from "./locale.jsx";
import {
  EmptyState, InlineError, LoadingState, PageBoundary, PageHeader, RouteProblem, SectionHead, StatusPill, STUDIO_ROOT as ROOT,
  arrayOf, dateOnly, dateTime, friendlyError, humanStatus, idOf, money, mutationKey, productName, publicPathOf, unwrap, useAgentPath, useCopy, useRemote,
  StepProgress,
} from "./studioShellKit.jsx";
import "./creatorPortalV2.css";

const FactoryAgents = React.lazy(() => import("./FactoryAgents.jsx").then(({ FactoryAgents: Component }) => ({ default: Component })));
const CreatorProductFiles = React.lazy(() => import("./CreatorSourceLibrary.jsx").then(({ CreatorProductFiles: Component }) => ({ default: Component })));
const CreatorProductWorkspace = React.lazy(() => import("./CreatorProductWorkspace.jsx").then(({ CreatorProductWorkspace: Component }) => ({ default: Component })));
const StudioAgentWorkspace = React.lazy(() => import("./studioAgentWorkspace.jsx").then(({ StudioAgentWorkspace: Component }) => ({ default: Component })));
const opsPage = (name) => React.lazy(() => import("./studioOps.jsx").then((module) => ({ default: module[name] })));
const StudioOrdersPage = opsPage("StudioOrdersPage");
const StudioOrderDetailPage = opsPage("StudioOrderDetailPage");
const StudioEarningsPage = opsPage("StudioEarningsPage");

const creatorMuiTheme = createTheme(hatchMuiThemeOptions);

const NAV_ITEMS = [
  { section: "home", href: ROOT, label: "sxNavOverview", Icon: LayoutDashboard },
  { section: "products", href: `${ROOT}/products`, label: "sxNavAgents", Icon: Bot },
  { section: "orders", href: `${ROOT}/orders`, label: "sxNavOrders", Icon: ReceiptText }
];

export function CreatorPortalV2({
  pathname = typeof window === "undefined" ? ROOT : window.location.pathname,
  navigate = defaultNavigate,
  request,
  profile,
  onLogout
}) {
  const route = useMemo(() => parseCreatorRoute(pathname), [pathname]);
  const { locale, setLocale } = useLocale();
  const [accountAnchorEl, setAccountAnchorEl] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const t = useMemo(() => createCreatorTranslator(locale), [locale]);
  const mainRef = useRef(null);
  const go = useCallback((nextPath) => { setDrawerOpen(false); navigate(nextPath); }, [navigate]);

  useEffect(() => {
    const heading = mainRef.current?.querySelector("h1");
    if (!heading) return;
    heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
  }, [pathname]);

  useEffect(() => {
    if (typeof document !== "undefined") document.title = `${localizedRouteTitle(route, t)} · Hatch Studio`;
  }, [route, t]);

  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen((open) => !open); }
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const accountMenuOpen = Boolean(accountAnchorEl);
  const closeAccountMenu = () => setAccountAnchorEl(null);
  const displayName = profile?.display_name || t("creator");
  const workbench = route.kind === "agent" && route.tab === "build";

  const sidebar = <aside className={`sx-sidebar${drawerOpen ? " is-open" : ""}`} aria-label={t("hatchNavigation")}>
    <a className="sx-back" href="/explore" onClick={(event) => { event.preventDefault(); go("/explore"); }}><ArrowLeft aria-hidden="true" /><span>{t("sxBackToHatch")}</span></a>
    <div className="sx-sidebar__top">
      <WebBrand className="cpv2-brand" label={t("studio")} href={ROOT} aria-label={t("hatchCreatorHome")} onClick={(event) => { event.preventDefault(); go(ROOT); }} />
      <IconButton className="sx-sidebar__close" label={t("sxCloseMenu")} variant="ghost" size="small" onClick={() => setDrawerOpen(false)}><X aria-hidden="true" /></IconButton>
    </div>
    <button type="button" className="sx-search" onClick={() => setPaletteOpen(true)}><Search aria-hidden="true" /><span>{t("sxSearch")}</span><kbd>⌘K</kbd></button>
    <nav className="sx-nav" aria-label={t("creatorNavigation")}>
      {NAV_ITEMS.map(({ section, href, label, Icon }) => <NavLink key={section} href={href} navigate={go} active={route.section === section}><Icon aria-hidden="true" /><span>{t(label)}</span></NavLink>)}
    </nav>
    <Button className="sx-new" variant="secondary" type="button" leading={<Plus aria-hidden="true" />} onClick={() => go(`${ROOT}/products/new`)}>{t("newAgent")}</Button>
    <ButtonBase
      className="cpv2-account-trigger sx-account"
      onClick={(event) => setAccountAnchorEl(event.currentTarget)}
      aria-controls={accountMenuOpen ? "creator-account-menu" : undefined}
      aria-expanded={accountMenuOpen ? "true" : undefined}
      aria-haspopup="menu"
      aria-label={t("account")}
    >
      <AccountAvatar className="cpv2-avatar" src={profile?.avatar_url} name={displayName} size="small" />
      <span className="cpv2-account-name">{displayName}</span>
      <ChevronsUpDown className="sx-account__chevron" aria-hidden="true" />
    </ButtonBase>
  </aside>;

  return (
    <ThemeProvider theme={creatorMuiTheme}>
      <div className="cpv2 sx-shell">
        <header className="sx-mobilebar">
          <IconButton className="sx-mobilebar__menu" label={t("openNavigation")} variant="secondary" size="small" onClick={() => setDrawerOpen(true)}><Menu aria-hidden="true" /></IconButton>
          <WebBrand className="cpv2-brand" label={t("studio")} href={ROOT} aria-label={t("hatchCreatorHome")} onClick={(event) => { event.preventDefault(); go(ROOT); }} />
          <IconButton label={t("sxSearch")} variant="ghost" size="small" onClick={() => setPaletteOpen(true)}><Search aria-hidden="true" /></IconButton>
        </header>
        {sidebar}
        {drawerOpen ? <button type="button" className="sx-scrim" aria-label={t("sxCloseMenu")} onClick={() => setDrawerOpen(false)} /> : null}
        <MuiMenu
          id="creator-account-menu"
          anchorEl={accountAnchorEl}
          open={accountMenuOpen}
          onClose={closeAccountMenu}
          anchorOrigin={{ vertical: "top", horizontal: "left" }}
          transformOrigin={{ vertical: "bottom", horizontal: "left" }}
          slotProps={{ paper: { className: "cpv2-account-menu", sx: { minWidth: 248, mb: 1 } }, list: { dense: true, "aria-label": t("account") } }}
        >
          <MuiMenuItem onClick={() => { closeAccountMenu(); go("/account"); }}><ListItemIcon><Settings size={18} /></ListItemIcon><ListItemText primary={t("sxNavSettings")} /></MuiMenuItem>
          <MuiMenuItem onClick={() => { closeAccountMenu(); go("/download"); }}><ListItemIcon><Download size={18} /></ListItemIcon><ListItemText primary={t("download")} /></MuiMenuItem>
          <MuiDivider />
          <div className="cpv2-account-menu-label"><Languages size={16} /><span>{t("language")}</span></div>
          {[['en', t("english")], ['zh', t("chinese")], ['ja', t("japanese")]].map(([value, label]) => <MuiMenuItem key={value} selected={locale === value} onClick={() => { setLocale(value); closeAccountMenu(); }}><ListItemIcon>{locale === value ? <Check size={18} /> : <span className="cpv2-menu-icon-placeholder" />}</ListItemIcon><ListItemText primary={label} /></MuiMenuItem>)}
          {onLogout ? <><MuiDivider /><MuiMenuItem onClick={() => { closeAccountMenu(); void onLogout(); }}><ListItemIcon><LogOut size={18} /></ListItemIcon><ListItemText primary={t("signOut")} /></MuiMenuItem></> : null}
        </MuiMenu>
        <main id="creator-main" className={`cpv2-main${workbench ? " cpv2-main--workbench" : ""}`} ref={mainRef}>
          <CreatorRoute route={route} request={request} navigate={go} locale={locale} t={t} profile={profile} />
        </main>
        <StudioCommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} request={request} navigate={go} t={t} />
      </div>
    </ThemeProvider>
  );
}

function NavLink({ href, navigate, active = false, children }) {
  function handleClick(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
  }
  return <a className={`sx-nav__item${active ? " is-active" : ""}`} href={href} aria-current={active ? "page" : undefined} onClick={handleClick}>{children}</a>;
}

/** ⌘K: jump to a section, an Agent (live list), or create one. */
function StudioCommandPalette({ open, onOpenChange, request, navigate, t }) {
  const products = useRemote(request, open ? "/v1/creator/products" : null);
  const agents = arrayOf(unwrap(products.data, "products"));
  const groups = [
    { label: t("sxPaletteActions"), items: [{ value: "new", label: t("newAgent"), icon: <Plus aria-hidden="true" />, onSelect: () => navigate(`${ROOT}/products/new`) }] },
    { label: t("sxPaletteGoTo"), items: NAV_ITEMS.map(({ section, href, label, Icon }) => ({ value: section, label: t(label), icon: <Icon aria-hidden="true" />, onSelect: () => navigate(href) })) },
    ...(agents.length ? [{ label: t("navAgents"), items: agents.map((product) => ({ value: idOf(product, "product"), label: productName(product, t), keywords: product.promise ?? "", icon: <Bot aria-hidden="true" />, onSelect: () => navigate(creatorProductPath(idOf(product, "product"))) })) }] : [])
  ];
  return <CommandMenu open={open} onOpenChange={onOpenChange} groups={groups} title={t("sxSearch")} placeholder={t("sxPalettePlaceholder")} empty={products.state === "loading" ? t("loadingCreatorPage") : t("sxPaletteEmpty")} />;
}

function CreatorRoute({ route, request, navigate, locale, t, profile }) {
  if (typeof request !== "function") {
    return <RouteProblem title={t("creatorPortalUnavailable")} body={t("creatorPortalUnavailableBody")} />;
  }
  const ops = { request, navigate, locale, profile };
  const lazy = (node) => <Suspense fallback={<LoadingState t={t} />}>{node}</Suspense>;
  if (route.kind === "redirect") return <Redirect to={route.to} navigate={navigate} />;
  if (route.kind === "home") return <CreatorHome request={request} navigate={navigate} t={t} locale={locale} />;
  if (route.kind === "products") return <ProductsPage request={request} navigate={navigate} t={t} locale={locale} />;
  if (route.kind === "product-create") return lazy(<CreatorProductFiles navigate={navigate} locale={locale} />);
  if (route.kind === "agent") return lazy(<StudioAgentWorkspace key={route.productId} route={route} request={request} navigate={navigate} locale={locale} t={t} profile={profile} renderBuild={(product) => <FactoryAgents productId={route.productId} section={route.factorySection} agent={route.factoryAgent} navigate={navigate} locale={locale} />} />);
  if (route.kind === "candidate") return lazy(<CreatorProductWorkspace request={request} navigate={navigate} productId={route.productId} tab="corpus" locale={locale} />);
  if (route.kind === "orders") return lazy(<StudioOrdersPage {...ops} />);
  if (route.kind === "order") return lazy(<StudioOrderDetailPage {...ops} orderId={route.orderId} />);
  if (route.kind === "earnings") return lazy(<StudioEarningsPage {...ops} />);
  return <RouteProblem title={t("pageNotFound")} body={t("pageNotFoundBody")} action={t("backToProducts")} onAction={() => navigate(`${ROOT}/products`)} />;
}

function Redirect({ to, navigate }) {
  useEffect(() => { navigate(to); }, [navigate, to]);
  return null;
}

/* ---------- Overview ---------- */

function CreatorHome({ request, navigate, t, locale }) {
  const resource = useRemote(request, "/v1/creator/overview");
  return (
    <PageBoundary resource={resource} title={t("workspaceLoadError")} t={t}>
      {(payload) => {
        const overview = unwrap(payload, "overview");
        const products = arrayOf(overview?.products);
        const orders = arrayOf(overview?.recent_orders);
        if (products.length === 0) return <CreatorZeroProductIntro navigate={navigate} t={t} />;
        const metrics = overview?.metrics ?? {};
        const live = products.filter(isProductLive);
        const next = products.find((product) => !isProductLive(product));
        const recent = [...products].sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""))).slice(0, 5);
        return <>
          <PageHeader title={t("sxOverviewTitle")} actions={<Button className={next ? undefined : "web-btn-yolk"} variant={next ? "secondary" : "primary"} type="button" leading={<Plus aria-hidden="true" />} onClick={() => navigate(`${ROOT}/products/new`)}>{t("newAgent")}</Button>} />
          {Number(metrics.orders) > 0 ? <dl className="sx-kpis">
            <Kpi label={t("sxKpiOrders")} value={Number(metrics.orders) || 0} />
          </dl> : null}
          {next ? <NextAgentCard product={next} request={request} navigate={navigate} t={t} /> : null}
          <div className="sx-overview-grid">
            <section className="sx-card" aria-labelledby="sx-home-agents">
              <SectionHead title={<span id="sx-home-agents">{t("sxNavAgents")} <small>{t("sxAgentsCount", products.length, live.length)}</small></span>} action={t("sxViewAll")} onAction={() => navigate(`${ROOT}/products`)} />
              <ul className="sx-mini-list">{recent.map((product) => <li key={idOf(product, "product")}>
                <button type="button" onClick={() => navigate(creatorProductPath(idOf(product, "product")))}>
                  <span className="sx-mini-list__main"><strong>{productName(product, t)}</strong><small>{t("sxUpdated", dateOnly(product.updated_at, locale))}</small></span>
                  <StatusPill live={isProductLive(product)} t={t} />
                </button>
              </li>)}</ul>
            </section>
            <section className="sx-card" aria-labelledby="sx-home-orders">
              <SectionHead title={<span id="sx-home-orders">{t("homeRecentOrders")}</span>} action={orders.length ? t("sxViewAll") : undefined} onAction={() => navigate(`${ROOT}/orders`)} />
              {orders.length ? <ul className="sx-mini-list">{orders.map((order) => <li key={idOf(order, "order")}>
                <button type="button" onClick={() => navigate(`${ROOT}/orders/${encodeURIComponent(order.order_number ?? idOf(order, "order"))}`)}>
                  <span className="sx-mini-list__main"><strong>{order.product_name ?? order.product?.name ?? t("productAccess")}</strong><small>{order.buyer_display_name ?? t("buyer")} · {dateTime(order.created_at ?? order.placed_at, locale)}</small></span>
                  <span className="sx-mini-list__end"><b>{money(order.gross_minor, order.currency)}</b><small>{humanStatus(order.status ?? order.order_status, t)}</small></span>
                </button>
              </li>)}</ul> : <p className="sx-quiet">{t("homeNoOrders")}</p>}
            </section>
          </div>
        </>;
      }}
    </PageBoundary>
  );
}

function Kpi({ label, value }) {
  return <div className="sx-kpi"><dt>{label}</dt><dd>{value}</dd></div>;
}

function NextAgentCard({ product, request, navigate, t }) {
  const productId = idOf(product, "product");
  const path = useAgentPath(request, product);
  return <article className="sx-continue">
    <div className="sx-continue__text">
      <span className="sx-eyebrow">{t("sxContinueLabel")}</span>
      <h2>{productName(product, t)}</h2>
      {path.next ? <p>{t("homeNext", t(path.next.step.title))} · {t(path.next.step.body)}</p> : <p>{product.promise ?? ""}</p>}
    </div>
    {path.states ? <ol className="cpv2-path-dots" aria-label={t("factoryStepsLabel")}>{path.states.map(({ step, state }) => <li key={step.id} className={`is-${state}${path.next?.step.id === step.id ? " is-next" : ""}`}><span aria-hidden="true" /><small>{t(step.title)}</small></li>)}</ol> : null}
    <Button className="web-btn-yolk" type="button" trailing={<span aria-hidden="true">→</span>} onClick={() => navigate(creatorProductPath(productId))}>{t("agentContinue")}</Button>
  </article>;
}

// The only photo in Studio: a people-free still life that fills the otherwise empty first-run home.
const STUDIO_EMPTY_PHOTO = "/assets/web/photos/v_desk.jpg";

function CreatorZeroProductIntro({ navigate, t }) {
  return <section className="cpv2-welcome" aria-labelledby="creator-zero-product-title">
    <div className="cpv2-welcome__top">
      <div className="cpv2-welcome__intro">
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

/* ---------- Agents ---------- */

function ProductsPage({ request, navigate, t, locale }) {
  const resource = useRemote(request, "/v1/creator/products");
  const [filter, setFilter] = useState("all");
  return (
    <PageBoundary resource={resource} title={t("productsLoadError")} t={t}>
      {(payload) => {
        const products = arrayOf(unwrap(payload, "products"));
        const counts = { all: products.length, live: products.filter(isProductLive).length };
        counts.draft = counts.all - counts.live;
        const shown = products.filter((product) => filter === "all" || (filter === "live") === isProductLive(product));
        return <>
          <PageHeader title={t("sxNavAgents")} body={t("sxAgentsBody")} actions={<Button className="web-btn-yolk" type="button" leading={<Plus aria-hidden="true" />} onClick={() => navigate(`${ROOT}/products/new`)}>{t("newAgent")}</Button>} />
          {products.length ? <>
            <div className="sx-filter" role="group" aria-label={t("sxFilter")}>
              {["all", "draft", "live"].map((value) => <button key={value} type="button" aria-pressed={filter === value} className={filter === value ? "is-active" : ""} onClick={() => setFilter(value)}>{t(value === "all" ? "all" : value === "live" ? "agentLive" : "agentDraft")}<b>{counts[value]}</b></button>)}
            </div>
            <div className="sx-table" role="table" aria-label={t("sxNavAgents")}>
              {shown.map((product) => <AgentRow key={idOf(product, "product")} product={product} t={t} locale={locale} request={request} navigate={navigate} onChanged={resource.retry} />)}
            </div>
          </> : <EmptyState title={t("agentsEmptyTitle")} body={t("agentsEmptyBody")} action={t("homeStartFirst")} onAction={() => navigate(`${ROOT}/products/new`)} />}
        </>;
      }}
    </PageBoundary>
  );
}

function AgentRow({ product, request, navigate, onChanged, t, locale }) {
  const productId = idOf(product, "product");
  const published = isProductLive(product);
  const publicHref = published ? `/products/${encodeURIComponent(idOf(product, "product"))}` : "";
  const path = useAgentPath(request, product);
  const { copied, copy } = useCopy();
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const open = () => navigate(creatorProductPath(productId));

  async function runConfirmed() {
    setBusy(true); setError("");
    try {
      if (confirm === "withdraw") await request(`/v1/creator/products/${encodeURIComponent(productId)}/withdraw`, { method: "POST", headers: { "idempotency-key": mutationKey() }, body: JSON.stringify({ reason: "Expert unpublished this Product." }) });
      else await request(`/v1/creator/products/${encodeURIComponent(productId)}`, { method: "DELETE" });
      setConfirm(null);
      onChanged?.();
    } catch (nextError) { setError(friendlyError(nextError, t)); setConfirm(null); }
    finally { setBusy(false); }
  }

  const nextLabel = published ? t("sxNextLive") : path.next ? t(path.next.step.title) : path.state === "error" ? t("sxNextUnknown") : "…";
  const menu = [
    { value: "open", label: t("agentOpen"), onSelect: open },
    ...(publicHref ? [{ value: "view", label: t("viewProduct"), icon: <ExternalLink aria-hidden="true" />, onSelect: () => window.open(publicHref, "_blank", "noopener,noreferrer") }] : []),
    { value: "publish", label: t("sxTabPublish"), onSelect: () => navigate(creatorProductPath(productId, "publish")) },
    ...(publicHref ? [{ value: "copy", label: t("copyLink"), icon: <Copy aria-hidden="true" />, onSelect: () => void copy(publicPathOf(product) || publicHref).catch(() => setError(t("copyFailed"))) }] : []),
    { type: "separator" },
    published
      ? { value: "withdraw", label: t("agentUnpublish"), destructive: true, onSelect: () => setConfirm("withdraw") }
      : { value: "delete", label: t("agentDelete"), destructive: true, onSelect: () => setConfirm("delete") }
  ];
  return <div className="sx-table__row" role="row">
    <span role="cell" className="sx-table__agent">
      <button type="button" className="sx-table__name" onClick={open}>{productName(product, t)}</button>
      <small>{product.promise ?? product.description ?? t("addProductPromise")}</small>
      {error ? <InlineError>{error}</InlineError> : null}
    </span>
    <span role="cell" className="sx-table__next">{published ? <span className="sx-live">{copied ? t("copied") : t("agentLive")}</span> : path.states ? <StepProgress states={path.states} label={nextLabel} /> : <small>{nextLabel}</small>}</span>
    <span role="cell" className="sx-table__date">{dateOnly(product.updated_at ?? product.created_at, locale)}</span>
    <span role="cell" className="sx-table__actions">
      <DropdownMenu label={t("sxColActions")} trigger={<IconButton label={t("sxColActions")} variant="ghost" size="small"><MoreHorizontal aria-hidden="true" /></IconButton>} items={menu} />
    </span>
    <ConfirmDialog
      open={Boolean(confirm)}
      onOpenChange={(value) => { if (!value) setConfirm(null); }}
      title={confirm === "withdraw" ? t("sxWithdrawTitle", productName(product, t)) : t("sxDeleteTitle", productName(product, t))}
      description={confirm === "withdraw" ? t("agentUnpublishConfirm") : t("agentDeleteConfirm")}
      confirmLabel={confirm === "withdraw" ? t("agentUnpublish") : t("agentDelete")}
      cancelLabel={t("cancel")}
      destructive
      busy={busy}
      onConfirm={runConfirmed}
    />
  </div>;
}

function defaultNavigate(path) {
  if (typeof window === "undefined") return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function localizedRouteTitle(route, t) {
  const keys = { home: "sxNavOverview", products: "sxNavAgents", agent: "sxNavAgents", "product-create": "newAgent", orders: "sxNavOrders", order: "orderDetail", earnings: "sxNavEarnings" };
  return keys[route.kind] ? t(keys[route.kind]) : t("studio");
}
