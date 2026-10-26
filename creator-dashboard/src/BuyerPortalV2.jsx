import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowRight, Inbox, SearchX } from "lucide-react";
import {
  Button,
  Checkbox as HatchCheckbox,
  InlineAlert as HatchInlineAlert,
  Input,
  SegmentedControl,
  Select,
  StatusTag
} from "@hatch/ui";
import { CheckoutSummary } from "@hatch/ui/product";
import { WebBrand } from "./WebBrand.jsx";
import { StorefrontDetails } from "./StorefrontDetails.jsx";
import { AccountAvatar } from "./AccountAvatar.jsx";
import { useLocale } from "./locale.jsx";
import { buyerT } from "./buyerI18n.js";
import { createAuthPagePresentation } from "./authPagePresentation.js";
import { humanizeIdentifier } from "./buyerPresentation.js";
import { creatorPublicModel } from "./storefrontModel.js";
import { exploreModel } from "./exploreModel.js";
import { createPublicProductDirectory, identityIsComplete, recordProductId, resolveProductIdentity } from "./buyerProductIdentity.js";
import { BuyerAccountControls, BuyerLanguageMenu } from "./BuyerAccountControls.jsx";
import { AccountAvatarSettings } from "./AccountAvatarSettings.jsx";
import "./buyerPortalV2.css";

const DEFAULT_DOWNLOAD_URL = "/download";
const EXPLORE_ROOT = "/explore";
const ORDERS_ROOT = "/explore/orders";
const CHECKOUT_ROOT = "/checkout";
const ACCOUNT_ROOT = "/account";
const STUDIO_ROOT = "/studio";
const PUBLIC_ROUTE_NAMES = new Set(["catalog", "creator", "product", "sign-in", "sign-up", "account-help", "not-found"]);
const PHOTO = (id) => `/assets/web/photos/${id}.jpg`;

/**
 * BuyerPortalV2 integration contract
 *
 * pathname/search/navigate:
 *   Controlled router location and navigation. `navigate(to, { replace? })` must
 *   update the browser URL and feed the new pathname/search back into this component.
 *
 * request(path, options):
 *   Same shape as `dashboardRequest`. It returns parsed JSON and throws an Error
 *   with optional `status`, `code`, and `details`. Browser cookie/CSRF policy belongs
 *   in the supplied request function. Mutation bodies below are JSON strings.
 *
 * session:
 *   {
 *     status: "loading" | "anonymous" | "authenticated",
 *     user?: { id?, display_name?, email?, initials? },
 *     signIn?(credentials): Promise<unknown>,
 *     signUp?(profile): Promise<unknown>,
 *     onAuthenticated?(authResponse): void | Promise<void>,
 *     signOut?(): void | Promise<void>,
 *     invalidate?(error): void
 *   }
 *
 * Response shapes are intentionally tolerant during migration:
 *   GET  /v1/public/products -> Product[] | { products: Product[] }
 *   GET  /v1/public/products/:product_id -> Product | { product: Product, agent?: Product }
 *   POST /v1/checkout-sessions -> Checkout | { checkout_session: Checkout }
 *   GET  /v1/checkout-sessions/:id -> same as above
 *   POST /v1/checkout-sessions/:id/confirm
 *        -> { order_id, status, entitlement_id?, redirect_url? }
 *   GET  /v1/orders -> { orders: Order[], next_cursor? }
 *   GET  /v1/orders/:id -> Order | { order: Order }
 *   GET  /v1/library -> { entitlements: Entitlement[], next_cursor? }
 *   GET  /v1/library/:id -> Entitlement | { entitlement: Entitlement }
 *
 * There is one kind of account. Anyone can acquire other people's Agents and
 * build their own in Studio; an owner chats with their own published Agents
 * without acquiring them.
 */
export const BUYER_PORTAL_V2_ENDPOINTS = Object.freeze({
  catalog: "/v1/public/products",
  checkoutSessions: "/v1/checkout-sessions",
  orders: "/v1/orders",
  entitlements: "/v1/library"
});

export function BuyerPortalV2({
  pathname = EXPLORE_ROOT,
  search = "",
  navigate,
  request,
  session = { status: "anonymous" },
  downloadUrl = DEFAULT_DOWNLOAD_URL,
  openPayment = defaultOpenPayment
}) {
  const t = useBuyerCopy();
  const location = splitLocation(pathname, search);
  const route = useMemo(() => matchBuyerRoute(location.pathname), [location.pathname]);
  useRouteHeadingFocus(location.pathname, location.search);
  const returnTo = `${location.pathname}${location.search}`;

  if (!PUBLIC_ROUTE_NAMES.has(route.name) && session.status === "loading") {
    return <BuyerShell route={route} navigate={navigate} session={session}><PageSkeleton label={t("Loading account")} /></BuyerShell>;
  }

  if (!PUBLIC_ROUTE_NAMES.has(route.name) && session.status !== "authenticated") {
    const destination = `/sign-in?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
    return <RedirectPage to={destination} navigate={navigate} />;
  }

  let page;
  if (route.name === "catalog") {
    page = <ExplorePage request={request} navigate={navigate} session={session} />;
  } else if (route.name === "creator") {
    page = <CreatorPublicPage creatorId={route.params.creatorId} request={request} navigate={navigate} session={session} />;
  } else if (route.name === "product") {
    page = <ProductPage route={route} request={request} navigate={navigate} session={session} downloadUrl={downloadUrl} />;
  } else if (route.name === "sign-in" || route.name === "sign-up") {
    return <AuthPage mode={route.name} search={location.search} request={request} navigate={navigate} session={session} />;
  } else if (route.name === "checkout") {
    page = <CheckoutPage id={route.params.checkoutSessionId} request={request} navigate={navigate} session={session} openPayment={openPayment} />;
  } else if (route.name === "orders") {
    page = <OrdersPage search={location.search} request={request} navigate={navigate} session={session} />;
  } else if (route.name === "order") {
    page = <OrderPage id={route.params.orderId} request={request} navigate={navigate} session={session} />;
  } else if (route.name === "success") {
    page = <SuccessPage id={route.params.orderId} request={request} navigate={navigate} downloadUrl={downloadUrl} session={session} />;
  } else if (route.name === "settings") {
    page = <SettingsPage session={session} navigate={navigate} />;
  } else if (route.name === "account-help") {
    page = <AccountHelpPage session={session} navigate={navigate} />;
  } else if (route.name === "subscriptions") {
    page = <SubscriptionsPage navigate={navigate} />;
  } else {
    page = <NotFoundPage navigate={navigate} />;
  }

  return <BuyerShell route={route} navigate={navigate} session={session}>{page}</BuyerShell>;
}

export function matchBuyerRoute(inputPathname) {
  const pathname = normalizePathname(inputPathname);
  const segments = pathname.split("/").filter(Boolean).map(safeDecode);

  if (segments.length === 0 || (segments.length === 1 && segments[0] === "explore")) return { name: "catalog", params: {} };
  if (segments.length === 2 && segments[0] === "products") {
    return { name: "product", params: { productId: segments[1] } };
  }
  if (segments.length === 2 && segments[0] === "creators") return { name: "creator", params: { creatorId: segments[1] } };
  if (segments.length === 1 && segments[0] === "sign-in") return { name: "sign-in", params: {} };
  if (segments.length === 1 && segments[0] === "sign-up") return { name: "sign-up", params: {} };
  if (segments.length === 2 && segments[0] === "account" && segments[1] === "help") return { name: "account-help", params: {} };
  if (segments[0] === "explore" && segments[1] === "orders") {
    if (segments.length === 2) return { name: "orders", params: {} };
    if (segments.length === 3) return { name: "order", params: { orderId: segments[2], orderNumber: segments[2] } };
    if (segments.length === 4 && segments[3] === "success") return { name: "success", params: { orderId: segments[2], orderNumber: segments[2] } };
  }
  if (segments.length === 2 && segments[0] === "checkout") return { name: "checkout", params: { checkoutSessionId: segments[1] } };
  if (segments.length === 1 && segments[0] === "account") return { name: "settings", params: {} };
  return { name: "not-found", params: {} };
}

function BuyerShell({ route, navigate, session, children }) {
  const t = useBuyerCopy();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(null);
  const authenticated = session.status === "authenticated";
  const exploring = ["catalog", "creator", "product", "orders", "order", "success"].includes(route.name);

  async function signOut() {
    if (!session.signOut || signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
      await session.signOut();
      navigateTo(navigate, EXPLORE_ROOT, { replace: true });
    } catch (error) {
      setSignOutError(error);
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="buyer-v2">
      <header className="buyer-v2__header">
        <div className="buyer-v2__header-inner">
          <WebBrand as={RouterLink} className="buyer-v2__brand" to={EXPLORE_ROOT} navigate={navigate} aria-label={t("Hatch home")} />
          <nav className="buyer-v2__nav" aria-label={t("Buyer navigation")}>
            <RouterLink to={EXPLORE_ROOT} navigate={navigate} aria-current={exploring ? "page" : undefined}>{t("Explore")}</RouterLink>
            <RouterLink to={STUDIO_ROOT} navigate={navigate}>{t("Studio")}</RouterLink>
          </nav>
          <div className="buyer-v2__account">
            {authenticated ? (
              <BuyerAccountControls user={session.user} navigate={navigate} onSignOut={signOut} signingOut={signingOut} className="buyer-account-controls--header" />
            ) : (
              <>
                <BuyerLanguageMenu />
                <LinkButton size="small" to={`/sign-in?returnTo=${encodeURIComponent(EXPLORE_ROOT)}`} navigate={navigate}>{t("Sign in")}</LinkButton>
              </>
            )}
          </div>
        </div>
        {signOutError ? <div className="buyer-v2__header-error" role="alert">{friendlyError(signOutError, t)}</div> : null}
      </header>
      <main id="buyer-main" className="buyer-v2__main" tabIndex="-1">{children}</main>
    </div>
  );
}

/* ---------- Shared presentation ---------- */

function PageIntro({ title, lead, center = false, children }) {
  return (
    <header className={`buyer-v2__intro${center ? " is-center" : ""}`}>
      <h1>{title}</h1>
      {lead ? <p>{lead}</p> : null}
      {children}
    </header>
  );
}

function Photo({ id, alt = "", className = "" }) {
  return <img className={`buyer-v2__photo ${className}`.trim()} src={PHOTO(id)} alt={alt} />;
}

/**
 * The one shape every empty, error and notice state uses: a plain white card
 * with an optional icon, a title, one line, and at most two next steps.
 */
function Notice({ icon: Icon, title, body, children, tone = "neutral", headingLevel = 2 }) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <section className={`buyer-v2__notice web-card is-${tone}`}>
      {Icon ? <span className="buyer-v2__notice-icon" aria-hidden="true"><Icon /></span> : null}
      <Heading>{title}</Heading>
      {body ? <p>{body}</p> : null}
      {children ? <div className="buyer-v2__notice-actions">{children}</div> : null}
    </section>
  );
}

function StatePanel({ title, body, tone = "neutral", icon, children }) {
  return <Notice icon={icon ?? (tone === "error" || tone === "warning" ? AlertCircle : undefined)} title={title} body={body} tone={tone} headingLevel={1}>{children}</Notice>;
}

function EmptyState({ title, body, action, compact = false }) {
  if (compact) return <div className="buyer-v2__empty-compact"><strong>{title}</strong>{body ? <p>{body}</p> : null}{action}</div>;
  return <Notice icon={Inbox} title={title} body={body}>{action}</Notice>;
}

/* ---------- Explore ---------- */

const EXPLORE_TAB_KEY = "hatch.explore.tab";
const EXPLORE_TABS = ["discover", "mine"];

/** The last mobile tab this browser chose; Discover when unknown or unreadable. */
function useExploreTab() {
  const [tab, setTab] = useState(() => {
    try {
      const stored = window.localStorage.getItem(EXPLORE_TAB_KEY);
      return EXPLORE_TABS.includes(stored) ? stored : "discover";
    } catch {
      return "discover";
    }
  });
  function choose(value) {
    setTab(value);
    try { window.localStorage.setItem(EXPLORE_TAB_KEY, value); } catch { /* per-browser convenience only */ }
  }
  return [tab, choose];
}

function ExplorePage({ request, navigate, session }) {
  const t = useBuyerCopy();
  usePageTitle(t("Explore"));
  const [tab, setTab] = useExploreTab();
  const authenticated = session.status === "authenticated";
  const accountId = authenticated ? session.user?.id : null;
  const resource = useRemote(async (signal) => {
    const [catalog, owned, acquired] = await Promise.all([
      callRequest(request, BUYER_PORTAL_V2_ENDPOINTS.catalog, { signal }),
      authenticated ? callRequest(request, "/v1/creator/products", { signal }) : null,
      authenticated ? loadSubscribedProducts(request, signal) : { items: [] }
    ]);
    return exploreModel({
      accountId,
      ownedProducts: collectionFrom(owned, ["products"]),
      acquired: acquired.items,
      catalog: collectionFrom(catalog, ["agents", "items"])
    });
  }, `explore:${session.status}:${accountId ?? ""}`, session.status !== "loading");
  const model = resource.data;

  let discover;
  if (resource.status === "error") discover = <RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} session={session} returnTo={EXPLORE_ROOT} />;
  else if (!model) discover = <CardSkeleton count={3} label={t("Loading Agents")} />;
  else if (model.discover.length) discover = <section className="buyer-v2__catalog-grid" aria-label={t("Published Agents")}>{model.discover.map((product) => <CatalogCard key={productKey(product)} product={product} navigate={navigate} />)}</section>;
  else discover = <EmptyState title={t("No published Agents")} body={t("Agents appear here once experts publish them.")} action={<LinkButton variant="secondary" to={STUDIO_ROOT} navigate={navigate}>{t("Publish an Agent")}</LinkButton>} />;

  return (
    <div className="buyer-v2__container buyer-v2__page buyer-v2__explore-page">
      {authenticated ? (
        <SegmentedControl
          className="buyer-v2__explore-tabs"
          ariaLabel={t("Explore")}
          value={tab}
          onValueChange={setTab}
          items={[{ value: "discover", label: t("Discover") }, { value: "mine", label: t("My Agents") }]}
        />
      ) : null}
      <div className={`buyer-v2__explore is-${authenticated ? tab : "signed-out"}`}>
        <div className="buyer-v2__explore-main">
          <PageIntro title={t("Discover")} lead={t("Agents published by experts.")} />
          {discover}
        </div>
        {authenticated ? (
          <aside className="buyer-v2__explore-side" aria-labelledby="explore-mine">
            <MyAgentsPanel model={model} navigate={navigate} />
          </aside>
        ) : session.status === "anonymous" ? (
          <aside className="buyer-v2__explore-side">
            <section className="buyer-v2__side-card web-card">
              <h2>{t("Make Hatch yours")}</h2>
              <p>{t("Sign up to keep the Agents you use in one place, or build your own in Studio.")}</p>
              <LinkButton className="web-btn-yolk" to={`/sign-up?returnTo=${encodeURIComponent(EXPLORE_ROOT)}`} navigate={navigate}>{t("Sign up")}</LinkButton>
            </section>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function MyAgentsPanel({ model, navigate }) {
  const t = useBuyerCopy();
  return (
    <>
      <h2 id="explore-mine" className="buyer-v2__side-title">{t("My Agents")}</h2>
      {!model ? <ListSkeleton label={t("Loading Agents")} /> : model.myAgents.length ? (
        <ul className="buyer-v2__my-agents">
          {model.myAgents.map((row) => (
            <li key={row.key}>
              <RouterLink className="buyer-v2__my-agent" to={row.href} navigate={navigate}>
                <AccountAvatar className="buyer-v2__creator-avatar" size="medium" src={creatorAvatarUrl(row.creator)} name={row.name || t("Untitled Agent")} />
                <span><strong>{row.name || t("Untitled Agent")}</strong><small>{row.kind === "owned" ? t("Your Agent") : creatorName(row.creator, t)}</small></span>
                <ArrowRight aria-hidden="true" />
              </RouterLink>
            </li>
          ))}
        </ul>
      ) : (
        <section className="buyer-v2__side-card web-card">
          <p>{t("No Agents yet. Pick one to try, or build one in Studio.")}</p>
          <LinkButton variant="secondary" size="small" to={STUDIO_ROOT} navigate={navigate}>{t("Open Studio")}</LinkButton>
        </section>
      )}
      <nav className="buyer-v2__side-links" aria-label={t("My Agents")}>
        {model?.draftCount ? <RouterLink to={STUDIO_ROOT} navigate={navigate}>{t("{count} in progress in Studio →", { count: model.draftCount })}</RouterLink> : null}
        <RouterLink to={ORDERS_ROOT} navigate={navigate}>{t("Order history →")}</RouterLink>
      </nav>
    </>
  );
}

function CreatorPublicPage({ creatorId, request, navigate, session }) {
  const t = useBuyerCopy();
  const endpoint = `/v1/public/creators/${encodeURIComponent(creatorId)}`;
  const resource = useRemote(async (signal) => callRequest(request, endpoint, { signal }), endpoint);
  const publicModel = creatorPublicModel(resource.data);
  usePageTitle(publicModel.creator?.name ?? publicModel.creator?.display_name ?? t("Expert"));
  if (resource.status === "loading") return <div className="buyer-v2__container buyer-v2__page"><PageSkeleton label={t('Loading expert')} /></div>;
  if (resource.status === "error") return <div className="buyer-v2__container buyer-v2__page"><RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} session={session} returnTo={`/creators/${encodeURIComponent(creatorId)}`} /></div>;
  const creator = publicModel.creator;
  const products = publicModel.products;
  const name = creator?.name ?? creator?.display_name ?? creatorId;
  return (
    <div className="buyer-v2__container buyer-v2__page">
      <RouterLink className="buyer-v2__back-link" to={EXPLORE_ROOT} navigate={navigate}>{t('← Explore')}</RouterLink>
      <header className="buyer-v2__creator-heading">
        <AccountAvatar className="buyer-v2__creator-profile-avatar" size="large" src={creatorAvatarUrl(creator)} name={name} />
        <div>
          <span className="web-pill">{t("Expert")}</span>
          <h1>{name}</h1>
          <p>{creator?.bio ?? creator?.description ?? t("Agents published by this expert.")}</p>
        </div>
      </header>
      {products.length
        ? <section className="buyer-v2__catalog-grid" aria-label={name}>{products.map((product) => <CatalogCard key={productKey(product)} product={product} navigate={navigate} />)}</section>
        : <EmptyState title={t('No published Agents')} body={t('This expert has not published any Agents.')} action={<LinkButton variant="secondary" to={EXPLORE_ROOT} navigate={navigate}>{t('Browse Agents')}</LinkButton>} />}
    </div>
  );
}

function CatalogCard({ product, navigate }) {
  const t = useBuyerCopy();
  const path = productPath(product);
  const access = accessFor(product);
  const owned = accessStatus(access) === "active";
  return (
    <RouterLink className="buyer-v2__catalog-card web-card" to={path} navigate={navigate}>
      <div className="buyer-v2__card-topline">
        <CreatorIdentity className="buyer-v2__catalog-creator" value={product} />
        {product.creator_verified || product.creator?.verified ? <span className="buyer-v2__verified">{t('Verified')}</span> : null}
      </div>
      <h2>{productName(product, t)}</h2>
      <p>{productPromise(product, t)}</p>
      <div className="buyer-v2__card-footer">
        <span className={owned ? "buyer-v2__owned" : "buyer-v2__price-tag"}>{owned ? t("In My Agents") : product.availability === "published" ? t("Free") : t("Unavailable")}</span>
        <span className="buyer-v2__card-go">{t('Details')}<ArrowRight aria-hidden="true" /></span>
      </div>
    </RouterLink>
  );
}

/* ---------- Product ---------- */

function ProductPage({ route, request, navigate, session, downloadUrl }) {
  const t = useBuyerCopy();
  const { productId } = route.params;
  const path = `/products/${encodeURIComponent(productId)}`;
  const endpoint = `${BUYER_PORTAL_V2_ENDPOINTS.catalog}/${encodeURIComponent(productId)}`;
  const resource = useRemote(async (signal) => unwrap(await callRequest(request, endpoint, { signal }), ["agent", "product"]), endpoint);
  const product = resource.data;
  usePageTitle(product ? productName(product, t) : t("Agent details"));

  if (resource.status === "loading") return <div className="buyer-v2__container buyer-v2__page"><DetailSkeleton /></div>;
  if (resource.status === "error") return <div className="buyer-v2__container buyer-v2__page"><RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} session={session} returnTo={path} /></div>;

  const examples = arrayValue(product.examples || product.proof, []);
  const desktopRequirement = product.desktop_requirement || t("Available in the browser and in Hatch Desktop.");
  const productCreatorId = product?.creator_id ?? product?.creator?.id;
  const productCreatorName = creatorName(product, t);
  const productCreatorByline = productCreatorId
    ? <RouterLink className="storefront-shared__creator-link" to={`/creators/${encodeURIComponent(productCreatorId)}`} navigate={navigate}>{productCreatorName}</RouterLink>
    : productCreatorName;

  return (
    <div className="buyer-v2__container buyer-v2__page">
      <RouterLink className="buyer-v2__back-link" to={EXPLORE_ROOT} navigate={navigate}>{t('← Explore')}</RouterLink>
      <StorefrontDetails
        product={product}
        creatorName={productCreatorByline}
        creatorAvatarName={productCreatorName}
        creatorAvatarUrl={product.creator_avatar_url || product.creator?.avatar_url || product.creator?.image_url}
        desktopRequirement={desktopRequirement}
        releaseLabel={product.release_label || product.release?.label}
        action={<ProductAction embedded product={product} currentPath={path} request={request} navigate={navigate} session={session} downloadUrl={downloadUrl} />}
      />

      <section className="buyer-v2__how">
        <h2>{t('How it works')}</h2>
        <ol className="buyer-v2__steps">
          <li className="web-card"><span>1</span><strong>{t('Add to your account')}</strong><p>{t('Free. The Agent is saved to My Agents.')}</p></li>
          <li className="web-card"><span>2</span><strong>{t('Start a conversation')}</strong><p>{t('Chat right in your browser, no download needed. To work with local files, use Hatch Desktop.')}</p></li>
          <li className="web-card"><span>3</span><strong>{t('Return any time')}</strong><p>{t('Conversations are visible only to your account.')}</p></li>
        </ol>
      </section>

      {examples.length ? <InfoSection title={t('Example questions')} items={examples} /> : null}
    </div>
  );
}

function ProductAction({ product, currentPath, request, navigate, session, downloadUrl, embedded = false }) {
  const t = useBuyerCopy();
  const access = accessFor(product);
  const status = accessStatus(access);
  const [mutation, setMutation] = useState({ status: "idle", error: null });
  const checkoutIntentKey = useRef(requestId());
  const purchasable = Boolean(productId(product))
    && product.availability === "published"
    && product.available !== false
    && product.status !== "withdrawn";
  const isAnonymous = session.status !== "authenticated";
  const isOwner = isOwnProduct(session, product);

  async function startCheckout() {
    if (!purchasable || mutation.status === "pending") return;
    setMutation({ status: "pending", error: null });
    try {
      const response = await callRequest(request, BUYER_PORTAL_V2_ENDPOINTS.checkoutSessions, jsonMutation("POST", {
        product_id: productId(product)
      }, checkoutIntentKey.current));
      const checkout = unwrap(response, ["checkout_session", "checkout"]);
      const id = checkout.checkout_session_id || checkout.id;
      if (!id) throw clientContractError("Checkout response did not include checkout_session_id.");
      navigateTo(navigate, `${CHECKOUT_ROOT}/${encodeURIComponent(id)}`);
    } catch (error) {
      setMutation({ status: "error", error });
    }
  }

  let title = "";
  let body = "";
  let action = null;

  if (isOwner) {
    title = t("Your Agent");
    body = t("You can chat with it without adding it.");
    action = <><LinkButton className="web-btn-yolk" to={`/chat/product/${encodeURIComponent(productId(product))}`} navigate={navigate}>{t('Go to chat')}</LinkButton><LinkButton variant="secondary" to={`${STUDIO_ROOT}/products/${encodeURIComponent(productId(product))}`} navigate={navigate}>{t('Manage product')}</LinkButton></>;
  } else if (status === "active" || status === "reserved") {
    title = status === "reserved" ? t("Setting up access") : t("Added to My Agents");
    body = status === "reserved" ? t("No need to add it again.") : t("Chat in the browser or open it in Hatch Desktop.");
    action = <><LinkButton className="web-btn-yolk" to={`/chat/product/${encodeURIComponent(productId(product))}`} navigate={navigate}>{t('Start chat')}</LinkButton></>;
  } else if (status === "pending") {
    title = t("Setting up access…");
    body = t("Order confirmed. Access appears here when ready.");
    action = <Button type="button" loading>{t('Setting up access')}</Button>;
  } else if (!purchasable) {
    title = t("This product is unavailable");
    body = t("The expert has unpublished it. Past receipts remain in Orders.");
  } else if (isAnonymous) {
    const authPath = `/sign-in?returnTo=${encodeURIComponent(currentPath)}`;
    action = <LinkButton className="web-btn-yolk" to={authPath} navigate={navigate}>{t('Get access')}</LinkButton>;
  } else {
    action = <Button className="web-btn-yolk" type="button" loading={mutation.status === "pending"} onClick={startCheckout}>{t('Get access')}</Button>;
  }

  const contents = (
    <>
      {title ? <h2>{title}</h2> : null}
      {body ? <p>{body}</p> : null}
      {mutation.error ? <InlineError error={mutation.error} /> : null}
      {action}
      {!isOwner && status !== "active" && status !== "reserved" ? <p className="buyer-v2__web-first">{t("No download needed: chat right in your browser.")}</p> : null}
      <a className="buyer-v2__secondary-download" href={downloadUrl} target="_blank" rel="noreferrer" onClick={() => trackPortalEvent(request, "desktop_download_clicked", productTelemetry(product))}>{t('Download Hatch Desktop')}</a>
    </>
  );
  if (embedded) return <div className="buyer-v2__storefront-action">{contents}</div>;
  return (
    <aside className="buyer-v2__action-card web-card" aria-label={t("Get access")}>
      <div className="buyer-v2__price"><strong>{t('Free')}</strong></div>
      {contents}
    </aside>
  );
}

/* ---------- Account ---------- */

function SettingsPage({ session, navigate }) {
  const t = useBuyerCopy();
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  usePageTitle(t("Account settings"));
  async function signOut() {
    if (!session.signOut || status === "pending") return;
    setStatus("pending");
    setError(null);
    try {
      await session.signOut();
      navigateTo(navigate, EXPLORE_ROOT, { replace: true });
    } catch (caught) {
      setStatus("idle");
      setError(caught);
    }
  }
  const name = session.user?.display_name || t("Hatch account");
  return <div className="buyer-v2__container buyer-v2__page buyer-v2__narrow">
    <PageIntro title={t('Account')} lead={t('Use the same account on the web and in Hatch Desktop.')} />
    <section className="buyer-v2__settings-surface web-card" aria-label={t('Signed-in account')}>
      <div className="buyer-v2__settings-identity">
        <AccountAvatar className="buyer-v2__settings-avatar" size="large" src={session.user?.avatar_url} name={name} />
        <div>
          <h2>{name}</h2>
          {session.user?.email ? <p>{session.user.email}</p> : null}
        </div>
      </div>
      <AccountAvatarSettings user={session.user} onUserUpdated={session.updateUser ?? (() => {})} t={t} />
      {error ? <InlineError error={error} /> : null}
      <div className="buyer-v2__settings-actions">
        <LinkButton variant="ghost" to="/account/help" navigate={navigate}>{t("Account help")}</LinkButton>
        <Button type="button" variant="secondary" loading={status === "pending"} onClick={signOut}>{t('Sign out')}</Button>
      </div>
    </section>
    <section className="buyer-v2__settings-studio web-card">
      <div><h2>{t("Studio")}</h2><p>{t("Build and publish your own Agents in Studio.")}</p></div>
      <LinkButton variant="secondary" to={STUDIO_ROOT} navigate={navigate}>{t("Open Studio")}</LinkButton>
    </section>
  </div>;
}

function AccountHelpPage({ session, navigate }) {
  const t = useBuyerCopy();
  const authenticated = session.status === "authenticated";
  usePageTitle(t("Account help"));
  return <div className="buyer-v2__container buyer-v2__page">
    <PageIntro title={t('Account help')} lead={t("Agents and orders belong to the account used to add them. Use the same account on the web and in Desktop.")} />
    <div className="buyer-v2__help-cards">
      <article className="buyer-v2__info-card web-card">
        <h2>{authenticated ? t("Check your account") : t("Sign in")}</h2>
        {authenticated ? <small className="buyer-v2__help-account">{t("Signed in as {name}", { name: session.user?.email || session.user?.display_name || t("Hatch account") })}</small> : null}
        <p>{authenticated ? t("If My Agents is empty, the Agent may have been added with a different email. Sign out and sign in with that email.") : t("Sign in with the email used to add the Agent.")}</p>
        {authenticated
          ? <LinkButton variant="secondary" to={ACCOUNT_ROOT} navigate={navigate}>{t('Account settings')}</LinkButton>
          : <LinkButton className="web-btn-yolk" to="/sign-in?returnTo=%2Faccount%2Fhelp" navigate={navigate}>{t('Sign in')}</LinkButton>}
      </article>
      <article className="buyer-v2__info-card web-card">
        <h2>{t("Payments and refunds")}</h2>
        <p>{t("Include the order number when contacting support.")}</p>
        <LinkButton variant="secondary" to={authenticated ? ORDERS_ROOT : `/sign-in?returnTo=${encodeURIComponent(ORDERS_ROOT)}`} navigate={navigate}>{t("View orders")}</LinkButton>
      </article>
    </div>
  </div>;
}

function SubscriptionsPage({ navigate }) {
  const t = useBuyerCopy();
  usePageTitle(t("Subscriptions"));
  return <div className="buyer-v2__container buyer-v2__page"><StatePanel icon={Inbox} title={t("No subscriptions")} body={t("Published Agents are currently free to add.")}><LinkButton to={EXPLORE_ROOT} navigate={navigate}>{t('Browse Agents')}</LinkButton></StatePanel></div>;
}

/* ---------- Auth ---------- */

function AuthPage({ mode, search, request, navigate, session }) {
  const t = useBuyerCopy();
  const signingUp = mode === "sign-up";
  const params = new URLSearchParams(search);
  const returnTo = safeReturnTo(params.get("returnTo") || EXPLORE_ROOT);
  const intentRoute = matchBuyerRoute(returnTo.split("?")[0]);
  const productIntent = intentRoute.name === "product";
  const presentation = createAuthPagePresentation(t)({ signingUp, productIntent });
  const intentEndpoint = productIntent ? `${BUYER_PORTAL_V2_ENDPOINTS.catalog}/${encodeURIComponent(intentRoute.params.productId)}` : "";
  const intent = useRemote(async (signal) => unwrap(await callRequest(request, intentEndpoint, { signal }), ["agent", "product"]), intentEndpoint || "no-intent", productIntent);
  const [form, setForm] = useState({ display_name: "", email: "", password: "" });
  const [submission, setSubmission] = useState({ status: "idle", error: null });
  const authBrandClassName = "buyer-v2__brand";
  const photo = signingUp ? "v_morning" : "v_window";
  usePageTitle(presentation.title);

  useEffect(() => {
    if (session.status === "authenticated") navigateTo(navigate, returnTo, { replace: true });
  }, [navigate, returnTo, session.status]);

  async function submit(event) {
    event.preventDefault();
    if (submission.status === "pending") return;
    setSubmission({ status: "pending", error: null });
    try {
      let response;
      if (signingUp && session.signUp) response = await session.signUp(form);
      else if (!signingUp && session.signIn) response = await session.signIn({ email: form.email, password: form.password });
      else response = await callRequest(request, signingUp
        ? "/v1/auth/signup"
        : "/v1/auth/login", jsonMutation("POST", signingUp ? form : { email: form.email, password: form.password }));
      await session.onAuthenticated?.(response);
      navigateTo(navigate, returnTo, { replace: true });
    } catch (error) {
      setSubmission({ status: "error", error });
    }
  }

  return (
    <main className="buyer-v2 buyer-v2__auth-page">
      <header className="buyer-v2__auth-navbar">
        <WebBrand as={RouterLink} className={authBrandClassName} to={EXPLORE_ROOT} navigate={navigate} aria-label={t("Hatch home")} />
        <BuyerLanguageMenu className="buyer-v2__auth-language" />
      </header>
      <section className="buyer-v2__auth-context" aria-hidden="true">
        <Photo id={photo} />
      </section>
      <section className="buyer-v2__auth-form-panel">
        <div className="buyer-v2__auth-head">
          <h1>{presentation.title}</h1>
          {presentation.description ? <p>{presentation.description}</p> : null}
        </div>
        {productIntent && intent.status === "loading" ? <div className="buyer-v2__auth-intent-skeleton" aria-label={t("Loading Agent")} /> : null}
        {productIntent && intent.status === "ready" ? <div className="buyer-v2__auth-intent web-card"><small>{creatorName(intent.data, t)}</small><strong>{productName(intent.data, t)}</strong></div> : null}
        <form className="buyer-v2__auth-form web-card" onSubmit={submit}>
          {signingUp ? <Field label={t('Name')}><Input required autoComplete="name" value={form.display_name} onChange={(event) => setForm({ ...form, display_name: event.target.value })} /></Field> : null}
          <Field label={t('Email')}><Input required type="email" autoComplete="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field>
          <Field label={t('Password')} hint={signingUp ? t("At least 8 characters") : undefined}><Input required minLength={8} type="password" autoComplete={signingUp ? "new-password" : "current-password"} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field>
          {submission.error ? <InlineError error={submission.error} /> : null}
          <Button type="submit" className="buyer-v2__button--wide web-btn-yolk" loading={submission.status === "pending"}>{presentation.action}</Button>
        </form>
        <nav className="buyer-v2__auth-links" aria-label={presentation.switchAction}>
          <RouterLink className="buyer-v2__auth-switch" to={`${signingUp ? "/sign-in" : "/sign-up"}?returnTo=${encodeURIComponent(returnTo)}`} navigate={navigate}>{presentation.switchAction}</RouterLink>
          {!signingUp ? <RouterLink className="buyer-v2__auth-help" to="/account/help" navigate={navigate}>{t("Account help")}</RouterLink> : null}
        </nav>
      </section>
    </main>
  );
}

/* ---------- Checkout ---------- */

function CheckoutPage({ id, request, navigate, session }) {
  const t = useBuyerCopy();
  const endpoint = `${BUYER_PORTAL_V2_ENDPOINTS.checkoutSessions}/${encodeURIComponent(id)}`;
  const resource = useRemote(async (signal) => unwrap(await callRequest(request, endpoint, { signal }), ["checkout_session", "checkout"]), endpoint);
  const [accepted, setAccepted] = useState(false);
  const [mutation, setMutation] = useState({ status: "idle", error: null });
  const confirmationIntentKey = useRef(requestId());
  const checkout = resource.data;
  const fulfillmentPending = checkout?.status === "fulfillment_pending";
  usePageTitle(t("Confirm order"));
  useUnauthorized(resource.error, session);

  useEffect(() => {
    if (!fulfillmentPending || mutation.status === "pending") return undefined;
    const timer = window.setTimeout(resource.reload, 3000);
    return () => window.clearTimeout(timer);
  }, [fulfillmentPending, mutation.status, resource.reload]);

  async function confirm() {
    if ((!accepted && !fulfillmentPending) || mutation.status === "pending") return;
    setMutation({ status: "pending", error: null });
    try {
      const response = await callRequest(request, `${endpoint}/confirm`, jsonMutation("POST", {}, confirmationIntentKey.current));
      const result = unwrap(response, ["result", "order"]);
      const confirmationStatus = response.status || response.checkout_session?.status || result.checkout_status;
      if (confirmationStatus === "fulfillment_pending") {
        setMutation({ status: "idle", error: null });
        resource.reload();
        return;
      }
      const orderId = result.order_id || result.id || response.order_id;
      if (!orderId) throw clientContractError("Checkout confirmation did not include order_id.");
      navigateTo(navigate, result.redirect_url || response.redirect_url || `${ORDERS_ROOT}/${encodeURIComponent(orderId)}/success`, { replace: true });
    } catch (error) {
      setMutation({ status: "error", error });
      if (error.status === 409 || error.status === 502 || error.code === "fulfillment_pending") resource.reload();
    }
  }

  if (resource.status === "loading") return <div className="buyer-v2__container buyer-v2__page"><DetailSkeleton /></div>;
  if (resource.status === "error") return <div className="buyer-v2__container buyer-v2__page"><RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} session={session} returnTo={`${CHECKOUT_ROOT}/${id}`} /></div>;

  const product = checkout.product_snapshot || checkout.product || checkout;
  const expired = ["expired", "release_changed", "cancelled"].includes(checkout.status) || (checkout.status === "open" && checkout.expires_at && Date.parse(checkout.expires_at) <= Date.now());
  const release = checkout.release_label || checkout.release_snapshot?.label || product.release_label || t("Current approved release");

  if (fulfillmentPending) {
    const orderId = checkout.order_id || checkout.order?.order_id;
    return <div className="buyer-v2__container buyer-v2__page"><StatePanel title={t('Access confirmed')} body={t('Hatch is generating the receipt. Do not submit again.')}>
      <span className="buyer-v2__spinner" aria-hidden="true" />
      {mutation.error ? <InlineError error={mutation.error} /> : null}
      <Button type="button" loading={mutation.status === "pending"} onClick={confirm}>{t('Retry setup')}</Button>
      {orderId ? <LinkButton variant="secondary" to={`${ORDERS_ROOT}/${encodeURIComponent(orderId)}`} navigate={navigate}>{t('View order')}</LinkButton> : null}
    </StatePanel></div>;
  }

  if (checkout.status === "refunded") {
    return <div className="buyer-v2__container buyer-v2__page"><StatePanel tone="warning" title={t('Access ended')} body={t('The receipt is still available.')}>{checkout.order_id ? <LinkButton to={`${ORDERS_ROOT}/${encodeURIComponent(checkout.order_id)}`} navigate={navigate}>{t('View receipt')}</LinkButton> : null}<LinkButton variant="secondary" to={productPath(product)} navigate={navigate}>{t('Back to product')}</LinkButton></StatePanel></div>;
  }

  return (
    <div className="buyer-v2__container buyer-v2__page buyer-v2__checkout-page">
      <RouterLink className="buyer-v2__back-link" to={productPath(product)} navigate={navigate}>{t('← Back to product')}</RouterLink>
      <PageIntro title={t('Add Agent')} lead={t("This Agent is free and available immediately after you add it.")} />
      <div className="buyer-v2__checkout-grid">
        <section className="buyer-v2__receipt-card web-card">
          <CreatorIdentity value={checkout.creator || product} />
          <h2>{productName(product, t)}</h2>
          <p>{productPromise(product, t)}</p>
          <DefinitionList rows={[
            [t("Release"), release],
            [t("Payment"), t("Not required")]
          ]} />
        </section>
        <CheckoutSummary
          product={{ ...product, name: productName(product, t), currency: "USD" }}
          lineItems={[{ label: productName(product, t), detail: release, amount_minor: 0 }]}
          totals={{ subtotal_minor: 0, total_minor: 0, subtotal_label: t("Free"), total_label: t("Free"), currency: "USD" }}
          busy={mutation.status === "pending"}
          error={mutation.error ? friendlyError(mutation.error, t) : undefined}
          action={{ label: mutation.status === "pending" ? t("Adding…") : t("Add to account"), disabled: !accepted || expired, onClick: confirm }}
          legal={t('The version in effect at the time of the order applies.')}
        >
          <HatchCheckbox checked={accepted} onCheckedChange={(checked) => setAccepted(checked === true)} disabled={expired} label={t('Add this Agent to my account')} />
          {expired ? <HatchInlineAlert tone="warning">{t('This request has expired. Return to the product page and try again.')}</HatchInlineAlert> : null}
        </CheckoutSummary>
      </div>
    </div>
  );
}

function SuccessPage({ id, request, navigate, downloadUrl, session }) {
  const t = useBuyerCopy();
  const endpoint = `${BUYER_PORTAL_V2_ENDPOINTS.orders}/${encodeURIComponent(id)}`;
  const resource = useRemote(async (signal) => {
    const order = unwrap(await callRequest(request, endpoint, { signal }), ["order"]);
    let entitlement = order.entitlement || null;
    let entitlementError = null;
    const entitlementId = order.entitlement_id || entitlement?.entitlement_id || entitlement?.id;
    if (!entitlement && entitlementId) {
      try {
        entitlement = unwrap(await callRequest(request, `${BUYER_PORTAL_V2_ENDPOINTS.entitlements}/${encodeURIComponent(entitlementId)}`, { signal }), ["entitlement"]);
      } catch (error) {
        entitlementError = error;
      }
    }
    return { order, entitlement, entitlementError };
  }, endpoint);
  const data = resource.data;
  const identity = useProductIdentity(request, data?.order);
  const ready = data ? successReady(data.order, data.entitlement) : false;
  const failed = data ? paymentFailed(data.order) : false;
  useUnauthorized(resource.error, session);
  usePageTitle(ready ? t("Agent added") : t("Confirming order"));

  useEffect(() => {
    if (resource.status !== "ready" || ready || failed) return undefined;
    const timer = window.setTimeout(resource.reload, 2200);
    return () => window.clearTimeout(timer);
  }, [resource.status, ready, failed, resource.reload]);

  if (resource.status === "loading") return <div className="buyer-v2__container buyer-v2__page"><PageSkeleton label={t('Confirming order')} /></div>;
  if (resource.status === "error" && resource.error?.status >= 500) return <div className="buyer-v2__container buyer-v2__page"><StatePanel tone="warning" title={t('Order completed. Receipt unavailable')} body={t('Do not place another order. The receipt will load when the service is available.')}><Button type="button" onClick={resource.reload}>{t('Reload receipt')}</Button></StatePanel></div>;
  if (resource.status === "error") return <div className="buyer-v2__container buyer-v2__page"><RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} session={session} returnTo={`${ORDERS_ROOT}/${id}/success`} /></div>;

  const { order, entitlement, entitlementError } = data;
  const product = order.product_snapshot || order.product || order;
  const amount = orderAmount(order);

  if (failed) {
    return <div className="buyer-v2__container buyer-v2__page"><StatePanel tone="error" title={t('Payment not completed')} body={t('No access was granted. See the order for payment status.')}><LinkButton to={`${ORDERS_ROOT}/${encodeURIComponent(id)}`} navigate={navigate}>{t('View order')}</LinkButton></StatePanel></div>;
  }

  if (!ready) {
    return <div className="buyer-v2__container buyer-v2__page"><StatePanel title={t('Confirming order…')} body={t('Do not place another order. This page updates automatically.')}><span className="buyer-v2__spinner" aria-hidden="true" /><LinkButton variant="secondary" to={`${ORDERS_ROOT}/${encodeURIComponent(id)}`} navigate={navigate}>{t('View order status')}</LinkButton></StatePanel></div>;
  }

  return (
    <div className="buyer-v2__container buyer-v2__page buyer-v2__success-page">
      <Notice headingLevel={1} title={t("{name} added", { name: productTitle(identity, t) })} body={`${t("Order #{reference}", { reference: orderReference(order) })} · ${amount === 0 ? t("Free") : money(amount, order.currency, t)}`}>
        {entitlementError ? <HatchInlineAlert tone="warning" action={<Button size="small" variant="ghost" type="button" onClick={resource.reload}>{t('Retry')}</Button>}>{t('Order completed. Some access details are unavailable.')}</HatchInlineAlert> : null}
        <LinkButton className="web-btn-yolk" to={`/chat/product/${encodeURIComponent(productId(product))}`} navigate={navigate}>{t('Start chat')}</LinkButton>
        <Button asChild variant="secondary"><a href={desktopUrl(entitlement, product)} onClick={() => trackPortalEvent(request, "desktop_open_clicked", productTelemetry(product))}>{t('Open Hatch Desktop')}</a></Button>
      </Notice>
      <section className="buyer-v2__next-steps">
        <h2>{t('Next steps')}</h2>
        <ol className="buyer-v2__steps">
          <li className="web-card"><span>1</span><strong>{t("Chat in the browser")}</strong><p>{t("No download needed.")} <RouterLink to={`/chat/product/${encodeURIComponent(productId(product))}`} navigate={navigate}>{t('Start chat')}</RouterLink></p></li>
          <li className="web-card"><span>2</span><strong>{t("Or use Hatch Desktop for local files")}</strong><p>{t("Download it, sign in with this account, then review local file permissions.")} <a href={downloadUrl} target="_blank" rel="noreferrer" onClick={() => trackPortalEvent(request, "desktop_download_clicked", productTelemetry(product))}>{t('Download Hatch Desktop')}</a></p></li>
        </ol>
        <div className="buyer-v2__detail-links">
          <RouterLink to={`${ORDERS_ROOT}/${encodeURIComponent(orderReference(order))}`} navigate={navigate}>{t('View receipt →')}</RouterLink>
        </div>
      </section>
    </div>
  );
}

/* ---------- My Agents ---------- */

async function loadSubscribedProducts(request, signal) {
  const items = [];
  const visitedCursors = new Set();
  let cursor = null;
  do {
    const query = new URLSearchParams({ status: "active", limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const response = await callRequest(request, `${BUYER_PORTAL_V2_ENDPOINTS.entitlements}?${query}`, { signal });
    const page = pageFrom(response, ["entitlements", "creator_agents", "items"]);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && visitedCursors.has(cursor)) throw new Error("The subscribed product list repeated its pagination cursor.");
    if (cursor) visitedCursors.add(cursor);
  } while (cursor);
  return { items: dedupeItems(items).sort(compareEntitlementsNewestFirst), nextCursor: null };
}

function compareEntitlementsNewestFirst(left, right) {
  const timestamp = entitlement => {
    const value = Date.parse(entitlement.granted_at ?? entitlement.valid_from ?? entitlement.created_at ?? "");
    return Number.isFinite(value) ? value : 0;
  };
  return timestamp(right) - timestamp(left)
    || String(right.entitlement_id ?? "").localeCompare(String(left.entitlement_id ?? ""));
}

/* ---------- Orders ---------- */

function OrdersPage({ search, request, navigate, session }) {
  const t = useBuyerCopy();
  const params = new URLSearchParams(search);
  const filter = params.get("status") || "all";
  const resource = useCursorCollection(async (cursor, signal) => {
    const query = new URLSearchParams();
    if (filter !== "all") query.set("status", filter);
    if (cursor) query.set("cursor", cursor);
    const response = await callRequest(request, `${BUYER_PORTAL_V2_ENDPOINTS.orders}?${query}`, { signal });
    return pageFrom(response, ["orders", "items"]);
  }, `orders:${filter}`);
  usePageTitle(t("Orders"));
  useUnauthorized(resource.error, session);

  return (
    <div className="buyer-v2__container buyer-v2__page">
      <RouterLink className="buyer-v2__back-link" to={EXPLORE_ROOT} navigate={navigate}>{t("← My Agents")}</RouterLink>
      <PageIntro title={t('Orders')} lead={t('Receipt, payment and access status for each order.')} />
      {resource.status === "error" ? null : <label className="buyer-v2__select-label">{t('Order status')}<Select label={t('Order status')} value={filter} onValueChange={(value) => navigateTo(navigate, value === "all" ? ORDERS_ROOT : `${ORDERS_ROOT}?status=${encodeURIComponent(value)}`)} options={[{ value: "all", label: t("All orders") }, { value: "fulfilled", label: t("Fulfilled") }, { value: "pending", label: t("Pending") }, { value: "refunded", label: t("Refunded") }]} /></label>}
      {resource.status === "loading" ? <ListSkeleton label={t('Loading orders')} /> : null}
      {resource.status === "error" ? <RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} session={session} returnTo={ORDERS_ROOT} /> : null}
      {resource.status === "ready" && resource.items.length ? <section className="buyer-v2__order-list" aria-label={t('Orders')}>{resource.items.map((order) => <OrderRow key={orderIdFor(order)} order={order} navigate={navigate} request={request} />)}</section> : null}
      {resource.status === "ready" && !resource.items.length ? <EmptyState title={filter === "all" ? t('No orders') : t('No orders match this filter')} body={t('Orders appear here after you add an Agent.')} action={<LinkButton className="web-btn-yolk" to={EXPLORE_ROOT} navigate={navigate}>{t('Browse Agents')}</LinkButton>} /> : null}
      {resource.nextCursor ? <LoadMore resource={resource} /> : null}
    </div>
  );
}

function OrderRow({ order, navigate, request }) {
  const t = useBuyerCopy();
  const identity = useProductIdentity(request, order);
  return (
    <RouterLink className="buyer-v2__order-row web-card" to={`${ORDERS_ROOT}/${encodeURIComponent(orderReference(order))}`} navigate={navigate}>
      <div><span>{dateTime(order.created_at || order.occurred_at, t, true)}</span><h2>{productTitle(identity, t)}</h2><small>{t("Order #{reference}", { reference: orderReference(order) })}</small></div>
      <div className="buyer-v2__order-row-status"><strong>{orderAmount(order) === 0 ? t("Free") : money(orderAmount(order), order.currency, t)}</strong><StatusChip status={orderStatus(order)} label={t(orderStatusLabel(order))} /></div>
      <ArrowRight className="buyer-v2__order-go" aria-hidden="true" />
    </RouterLink>
  );
}

function OrderPage({ id, request, navigate, session }) {
  const t = useBuyerCopy();
  const endpoint = `${BUYER_PORTAL_V2_ENDPOINTS.orders}/${encodeURIComponent(id)}`;
  const resource = useRemote(async (signal) => unwrap(await callRequest(request, endpoint, { signal }), ["order"]), endpoint);
  const [refundState, setRefundState] = useState({ status: "idle", error: null });
  const refundIntentKey = useRef(requestId());
  const identity = useProductIdentity(request, resource.data);
  usePageTitle(resource.data ? productTitle(identity, t) : t("Order details"));
  useUnauthorized(resource.error, session);

  async function requestRefund() {
    if (refundState.status === "pending") return;
    setRefundState({ status: "pending", error: null });
    try {
      const mutationPath = canCancelAccess ? `${endpoint}/cancel` : `${endpoint}/refund-requests`;
      await callRequest(request, mutationPath, jsonMutation("POST", { reason: "buyer_requested" }, refundIntentKey.current));
      setRefundState({ status: "succeeded", error: null });
      resource.reload();
    } catch (error) {
      setRefundState({ status: "error", error });
    }
  }

  if (resource.status === "loading") return <div className="buyer-v2__container buyer-v2__page"><DetailSkeleton /></div>;
  if (resource.status === "error") return <div className="buyer-v2__container buyer-v2__page"><RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} session={session} returnTo={`${ORDERS_ROOT}/${id}`} /></div>;
  const order = resource.data;
  const product = order.product_snapshot || order.product || order;
  const canRefund = Boolean(order.actions?.can_request_refund || order.can_request_refund);
  const canCancelAccess = order.access_mode !== "unmetered"
    && Boolean(order.actions?.can_cancel_access || order.can_cancel_access);
  const canReverseOrder = canRefund || canCancelAccess;
  const reversalLabel = t(canCancelAccess ? "Cancel order" : "Request refund");
  const reversalSuccess = t(canCancelAccess ? "Order cancelled" : "Refund request received");
  const totalMinor = orderAmount(order);
  const discountMinor = numberOr(order.discount_minor, 0);
  const taxLabel = order.tax_minor == null ? t("Not calculated") : money(numberOr(order.tax_minor, 0), order.currency, t);

  const isPaid = totalMinor > 0;
  const canChat = accessStatus(order.entitlement || { status: order.entitlement_status }) === "active";
  const receiptRows = [
    [t("Expert"), identity.creatorName],
    [t("Order number"), orderReference(order)],
    [t("Total"), isPaid ? money(totalMinor, order.currency, t) : t("Free")],
    ...(isPaid && discountMinor > 0 ? [[t("Discount"), `−${money(discountMinor, order.currency, t)}`]] : []),
    ...(isPaid && order.tax_minor != null && numberOr(order.tax_minor, 0) > 0 ? [[t("Tax"), taxLabel]] : []),
    ...(isPaid ? [[t("Payment"), t(paymentStatusLabel(order.payment_status || order.payment?.status, totalMinor))]] : [])
  ];

  return (
    <div className="buyer-v2__container buyer-v2__page">
      <RouterLink className="buyer-v2__back-link" to={ORDERS_ROOT} navigate={navigate}>{t('← Back to Orders')}</RouterLink>
      <header className="buyer-v2__detail-heading"><div><h1>{productTitle(identity, t)}</h1><p>{t("Created {date}", { date: dateTime(order.created_at || order.occurred_at, t) })}</p></div><StatusChip status={orderStatus(order)} label={t(orderStatusLabel(order))} /></header>
      <section className="buyer-v2__detail-card buyer-v2__order-receipt web-card">
        <DefinitionList rows={receiptRows} />
        {(canChat || canReverseOrder) ? (
          <div className="buyer-v2__order-receipt-actions">
            {canChat ? <LinkButton className="web-btn-yolk" to={`/chat/product/${encodeURIComponent(productId(product))}`} navigate={navigate}>{t('Start chat')}</LinkButton> : null}
            {canReverseOrder ? <Button variant="ghost" type="button" loading={refundState.status === "pending"} onClick={requestRefund}>{reversalLabel}</Button> : null}
          </div>
        ) : null}
        {refundState.error ? <InlineError error={refundState.error} /> : null}
        {refundState.status === "succeeded" ? <div className="buyer-v2__inline-notice" role="status">{reversalSuccess}</div> : null}
      </section>
    </div>
  );
}

function NotFoundPage({ navigate }) {
  const t = useBuyerCopy();
  usePageTitle(t("Page not found"));
  return <div className="buyer-v2__container buyer-v2__page"><StatePanel icon={SearchX} title={t("Page not found")} body={t('The link may be incorrect, or the page was removed.')}><LinkButton to={EXPLORE_ROOT} navigate={navigate}>{t('Browse Agents')}</LinkButton></StatePanel></div>;
}

function RedirectPage({ to, navigate }) {
  const t = useBuyerCopy();
  useEffect(() => navigateTo(navigate, to, { replace: true }), [navigate, to]);
  return <main className="buyer-v2 buyer-v2__redirect" aria-live="polite"><p>{t('Redirecting to sign in…')}</p><RouterLink to={to} navigate={navigate}>{t('Go to sign in')}</RouterLink></main>;
}

function InfoSection({ title, items }) {
  const t = useBuyerCopy();
  return <section className="buyer-v2__how"><h2>{title}</h2><ul className="buyer-v2__examples">{items.map((item, index) => <li className="web-card" key={`${index}:${textValue(item, t)}`}>{textValue(item, t)}</li>)}</ul></section>;
}

function Field({ label, hint, children }) {
  return <label className="buyer-v2__field"><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>;
}

function DefinitionList({ rows }) {
  return <dl className="buyer-v2__definition-list">{rows.filter(([, value]) => value !== undefined && value !== null && value !== "").map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}</dl>;
}

function CreatorIdentity({ value, name: knownName, className = "" }) {
  const t = useBuyerCopy();
  const name = knownName || creatorName(value, t);
  return <span className={`buyer-v2__creator-identity ${className}`.trim()}><AccountAvatar className="buyer-v2__creator-avatar" size="medium" src={creatorAvatarUrl(value)} name={name} /><span>{name}</span></span>;
}

function RouteError({ error, onRetry, navigate, session, returnTo }) {
  const t = useBuyerCopy();
  const status = error?.status;
  if (status === 401) return <StatePanel title={t('Session expired')} body={t('Sign in again to continue. You will return to this page.')}><LinkButton className="web-btn-yolk" to={`/sign-in?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`} navigate={navigate}>{t('Sign in')}</LinkButton></StatePanel>;
  if (status === 403) return <StatePanel icon={AlertCircle} title={t("No access to this page")} body={t("This page may belong to another account. Check the email you are signed in with.")}><LinkButton to="/account/help" navigate={navigate}>{t('Account help')}</LinkButton><LinkButton variant="secondary" to={EXPLORE_ROOT} navigate={navigate}>{t('Browse Agents')}</LinkButton></StatePanel>;
  if (status === 404) return <StatePanel icon={SearchX} title={t('Not found')} body={session?.status === "authenticated" ? t("It may have been removed. Past receipts remain in Orders.") : t("It may have been removed, or the link is incomplete.")}>{session?.status === "authenticated" ? <LinkButton variant="secondary" to={ORDERS_ROOT} navigate={navigate}>{t('View orders')}</LinkButton> : null}<LinkButton to={EXPLORE_ROOT} navigate={navigate}>{t('Browse Agents')}</LinkButton></StatePanel>;
  if (status === 409) return <StatePanel tone="warning" title={t('Details changed')} body={friendlyError(error, t)}><Button type="button" onClick={onRetry}>{t('Refresh')}</Button></StatePanel>;
  return <StatePanel tone="error" title={t("Could not load")} body={friendlyError(error, t)}><Button type="button" onClick={onRetry}>{t('Try again')}</Button></StatePanel>;
}

function InlineError({ error }) {
  const t = useBuyerCopy();
  return <div className="buyer-v2__inline-error" role="alert">{friendlyError(error, t)}</div>;
}

function StatusChip({ status, label }) {
  return <StatusTag tone={statusTone(status)}>{label}</StatusTag>;
}

function CardSkeleton({ count, label }) {
  return <div className="buyer-v2__catalog-grid" aria-busy="true" aria-label={label}>{Array.from({ length: count }, (_, index) => <div className="buyer-v2__skeleton-card web-card" key={index}><i /><i /><i /><i /></div>)}</div>;
}

function ListSkeleton({ label }) {
  return <div className="buyer-v2__list-skeleton" aria-busy="true" aria-label={label}>{Array.from({ length: 3 }, (_, index) => <i key={index} />)}</div>;
}

function DetailSkeleton() {
  const t = useBuyerCopy();
  return <div className="buyer-v2__detail-skeleton" aria-busy="true" aria-label={t('Loading details')}><i /><i /><i /><i /></div>;
}

function PageSkeleton({ label }) {
  return <div className="buyer-v2__page-skeleton" aria-busy="true" aria-label={label}><span className="buyer-v2__spinner" aria-hidden="true" /><p>{label}…</p></div>;
}

function LoadMore({ resource }) {
  const t = useBuyerCopy();
  return <div className="buyer-v2__load-more">{resource.moreError ? <InlineError error={resource.moreError} /> : null}<Button variant="secondary" type="button" loading={resource.loadingMore} onClick={resource.loadMore}>{t('Load more')}</Button></div>;
}

function LinkButton({ to, navigate, variant = "primary", children, ...props }) {
  return <Button asChild variant={variant} {...props}><RouterLink to={to} navigate={navigate}>{children}</RouterLink></Button>;
}

function statusTone(status) {
  const value = String(status || "").toLowerCase();
  if (["active", "approved", "complete", "completed", "fulfilled", "published", "ready", "success"].includes(value)) return "success";
  if (["failed", "error", "rejected", "revoked"].includes(value)) return "error";
  if (["pending", "processing", "progress", "refund_pending"].includes(value)) return "progress";
  if (["warning", "withdrawn", "refunded"].includes(value)) return "warning";
  return "neutral";
}

function RouterLink({ to, navigate, onClick, children, ...props }) {
  const href = canonicalWebPath(to);
  function handleClick(event) {
    onClick?.(event);
    if (event.defaultPrevented || !navigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target) return;
    event.preventDefault();
    navigate(href);
  }
  return <a {...props} href={href} onClick={handleClick}>{children}</a>;
}

function useBuyerCopy() {
  const { locale } = useLocale();
  const t = (key, values) => buyerT(locale, key, values);
  t.locale = locale;
  return t;
}

function isOwnProduct(session, product) {
  return session?.status === "authenticated"
    && Boolean(session.user?.id)
    && String(session.user.id) === String(product?.creator_id ?? product?.creator?.id ?? "");
}

function useRemote(loader, key, enabled = true) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ key: "", status: "loading", data: null, error: null });
  useEffect(() => {
    if (!enabled) {
      setState({ key, status: "idle", data: null, error: null });
      return undefined;
    }
    const controller = new AbortController();
    setState((current) => ({ key, status: current.key === key && current.data ? "refreshing" : "loading", data: current.key === key ? current.data : null, error: null }));
    Promise.resolve(loader(controller.signal)).then((data) => {
      if (!controller.signal.aborted) setState({ key, status: "ready", data, error: null });
    }).catch((error) => {
      if (!controller.signal.aborted && error?.name !== "AbortError") setState((current) => ({ key, status: "error", data: current.key === key ? current.data : null, error }));
    });
    return () => controller.abort();
    // loader intentionally follows the controlled key; callers should encode inputs in key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt, enabled]);
  const current = state.key === key ? state : { key, status: enabled ? "loading" : "idle", data: null, error: null };
  return { ...current, reload: () => setAttempt((value) => value + 1) };
}

function useCursorCollection(loader, key) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ key: "", status: "loading", items: [], nextCursor: null, error: null, loadingMore: false, moreError: null });
  useEffect(() => {
    const controller = new AbortController();
    setState({ key, status: "loading", items: [], nextCursor: null, error: null, loadingMore: false, moreError: null });
    Promise.resolve(loader(null, controller.signal)).then((page) => {
      if (!controller.signal.aborted) setState({ key, status: "ready", items: page.items, nextCursor: page.nextCursor, error: null, loadingMore: false, moreError: null });
    }).catch((error) => {
      if (!controller.signal.aborted && error?.name !== "AbortError") setState({ key, status: "error", items: [], nextCursor: null, error, loadingMore: false, moreError: null });
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  const current = state.key === key ? state : { key, status: "loading", items: [], nextCursor: null, error: null, loadingMore: false, moreError: null };
  async function loadMore() {
    if (!current.nextCursor || current.loadingMore) return;
    setState((value) => ({ ...value, loadingMore: true, moreError: null }));
    try {
      const page = await loader(current.nextCursor);
      setState((value) => ({ ...value, status: "ready", items: dedupeItems([...value.items, ...page.items]), nextCursor: page.nextCursor, loadingMore: false, moreError: null }));
    } catch (error) {
      setState((value) => ({ ...value, loadingMore: false, moreError: error }));
    }
  }
  return { ...current, reload: () => setAttempt((value) => value + 1), loadMore };
}

const publicProductDirectories = new WeakMap();
function publicProductIndex(request) {
  if (!publicProductDirectories.has(request)) {
    publicProductDirectories.set(request, createPublicProductDirectory(() => callRequest(request, BUYER_PORTAL_V2_ENDPOINTS.catalog)));
  }
  return publicProductDirectories.get(request)();
}

// Entitlement/order records without a product snapshot are named from the public
// product record; see buyerProductIdentity.js.
function useProductIdentity(request, record) {
  const own = resolveProductIdentity(record);
  const id = recordProductId(record);
  const needed = Boolean(record && id && typeof request === "function" && !identityIsComplete(own));
  const lookup = useRemote(() => publicProductIndex(request), `public-product:${id}`, needed);
  if (!needed) return { ...own, pending: false };
  return { ...resolveProductIdentity(record, lookup.data?.get(id) || null), pending: lookup.status === "loading" };
}

function productTitle(identity, t) {
  return identity.name || (identity.pending ? t("Loading Agent") : t("Untitled Agent"));
}

function usePageTitle(subject) {
  useEffect(() => {
    if (typeof document !== "undefined") document.title = `${subject} · Hatch`;
  }, [subject]);
}

function useRouteHeadingFocus(pathname, search) {
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return undefined;
    let observer;
    const focusHeading = () => {
      const heading = document.querySelector(".buyer-v2__main h1, main.buyer-v2 h1");
      if (!heading) return false;
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
      observer?.disconnect();
      return true;
    };
    const frame = window.requestAnimationFrame(() => {
      if (focusHeading()) return;
      // Async routes render their heading only after the authoritative resource
      // is loaded. Observe this one navigation until that heading exists so a
      // route change never leaves keyboard/screen-reader focus on an unmounted
      // CTA or on the document body.
      observer = new MutationObserver(focusHeading);
      observer.observe(document.body, { childList: true, subtree: true });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [pathname, search]);
}

function useUnauthorized(error, session) {
  useEffect(() => {
    if (error?.status === 401) session.invalidate?.(error);
  }, [error, session]);
}

async function callRequest(request, path, options = {}) {
  if (typeof request !== "function") throw clientContractError("BuyerPortalV2 requires a request(path, options) prop.");
  return request(path, options);
}

function trackPortalEvent(request, eventName, attributes = {}) {
  if (typeof request !== "function") return;
  const key = requestId();
  const options = jsonMutation("POST", { event_name: eventName, attributes }, key);
  options.keepalive = true;
  void callRequest(request, "/v1/analytics/events", options).catch(() => undefined);
}

function productTelemetry(product) {
  return {
    creator_id: product?.creator_id ?? product?.creator?.id,
    product_id: productId(product),
    release_id: product?.release_id ?? product?.release?.release_id,
    platform: typeof navigator === "undefined" ? "web" : /Mac/i.test(navigator.platform) ? "macos" : "web"
  };
}

function jsonMutation(method, payload, idempotencyKey = requestId()) {
  return {
    method,
    body: JSON.stringify(payload),
    headers: { "Idempotency-Key": idempotencyKey }
  };
}

function splitLocation(pathname, search) {
  const index = String(pathname || "").indexOf("?");
  if (index < 0) return { pathname: normalizePathname(pathname), search: normalizeSearch(search) };
  return { pathname: normalizePathname(pathname.slice(0, index)), search: normalizeSearch(search || pathname.slice(index)) };
}

function normalizePathname(value) {
  const pathname = String(value || EXPLORE_ROOT).split("#")[0].split("?")[0];
  if (!pathname.startsWith("/")) return EXPLORE_ROOT;
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

function normalizeSearch(value) {
  if (!value) return "";
  return String(value).startsWith("?") ? String(value) : `?${value}`;
}

function safeReturnTo(value) {
  const candidate = String(value || "");
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\") || /[\u0000-\u001f]/.test(candidate)) return EXPLORE_ROOT;
  const destination = new URL(candidate, "https://hatch.invalid");
  if (destination.origin !== "https://hatch.invalid") return EXPLORE_ROOT;
  return `${destination.pathname}${destination.search}${destination.hash}`;
}

function navigateTo(navigate, to, options) {
  const destination = canonicalWebPath(to);
  if (typeof navigate === "function") return navigate(destination, options);
  if (typeof window !== "undefined") {
    if (options?.replace) window.location.replace(destination);
    else window.location.assign(destination);
  }
  return undefined;
}

function canonicalWebPath(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return value;
  return value;
}

function defaultOpenPayment(url) {
  if (typeof window === "undefined") return;
  const parsed = new URL(url, window.location.origin);
  if (parsed.protocol !== "https:" && parsed.origin !== window.location.origin) throw new Error("Unsupported payment URL.");
  window.location.assign(parsed.href);
}

function unwrap(payload, keys) {
  if (payload == null) return {};
  for (const key of keys) if (payload[key] != null) return payload[key];
  return payload;
}

function collectionFrom(payload, keys) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) if (Array.isArray(payload?.[key])) return payload[key];
  return [];
}

function pageFrom(payload, keys) {
  return { items: collectionFrom(payload, keys), nextCursor: payload?.next_cursor || payload?.page?.next_cursor || null };
}

function dedupeItems(items) {
  const seen = new Set();
  return items.filter((item, index) => {
    const key = item.id || item.order_id || item.entitlement_id || `${productKey(item)}:${index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function accessFor(value) {
  return value?.entitlement || value?.access || (value?.entitlement_status ? { status: value.entitlement_status } : null);
}

const identity = (key) => key;
function productId(value) { return value?.product_id || value?.product?.id || value?.product?.product_id || value?.id; }
function productName(value, t = identity) { return value?.product_name || value?.name || value?.product?.name || t("Expert Agent"); }
function productPromise(value, t = identity) { return value?.promise || value?.product_description || value?.description || value?.product?.promise || value?.product?.description || t("An Agent built from an expert's method."); }
function creatorName(value, t = identity) { return value?.creator_name || value?.creator_display_name || value?.display_name || value?.name || value?.creator?.display_name || value?.creator?.name || value?.creator?.handle || t("Hatch Expert"); }
function creatorAvatarUrl(value) { return value?.creator_avatar_url || value?.avatar_url || value?.image_url || value?.creator?.avatar_url || value?.creator?.image_url; }
function creatorId(value) { return value?.creator_id || value?.creator?.id || ""; }
function orderIdFor(value) { return value?.order_id || value?.id; }

function productPath(value) {
  const product = productId(value);
  return product ? `/products/${encodeURIComponent(product)}` : EXPLORE_ROOT;
}

function productKey(value) { return productId(value) || "product"; }

function intlLocale(t) {
  return ({ zh: "zh-CN", ja: "ja-JP" })[t?.locale] || "en-US";
}

function money(minor, currency = "USD", t) {
  const amount = Number(minor);
  if (!Number.isFinite(amount)) return "—";
  try { return new Intl.NumberFormat(intlLocale(t), { style: "currency", currency: currency || "USD" }).format(amount / 100); }
  catch { return `${currency || "USD"} ${(amount / 100).toFixed(2)}`; }
}

function accessStatus(value) {
  const status = value?.status || value?.entitlement_status || "none";
  if (["granted", "available"].includes(status)) return "active";
  if (["fulfillment_pending", "provisioning"].includes(status)) return "pending";
  return status;
}

function orderAmount(order) { return numberOr(order?.total_minor, numberOr(order?.amount_minor, numberOr(order?.gross_minor, 0))); }

function orderReference(order) {
  const raw = String(order?.order_number || order?.reference || orderIdFor(order) || "pending");
  return raw.startsWith("#") ? raw.slice(1) : raw;
}

function orderStatus(order) {
  const status = order?.status || order?.order_status || "pending";
  if (["fulfilled", "delivered", "completed"].includes(status)) return "fulfilled";
  return status;
}

function orderStatusLabel(order) {
  const status = orderStatus(order);
  return ({ fulfilled: "Fulfilled", pending: "Pending", payment_pending: "Payment pending", refund_pending: "Refund pending", refunded: "Refunded", cancelled: "Cancelled", failed: "Failed" })[status] || sentenceCase(status);
}

function paymentStatusLabel(status, amount) {
  if (Number(amount) === 0 || status === "not_required") return "Not required";
  return ({ succeeded: "Succeeded", paid: "Succeeded", pending: "Pending", processing: "Processing", failed: "Failed", requires_action: "Action required", refunded: "Refunded" })[status] || sentenceCase(status || "pending");
}

function successReady(order, entitlement) {
  const status = accessStatus(entitlement || { status: order?.entitlement_status });
  return ["active", "reserved"].includes(status) && !paymentFailed(order);
}

function paymentFailed(order) {
  return ["failed", "declined", "cancelled"].includes(order?.payment_status || order?.payment?.status) || orderStatus(order) === "failed";
}

function desktopUrl(entitlement, product) {
  const params = new URLSearchParams();
  const entitlementId = entitlement?.entitlement_id || entitlement?.id;
  if (entitlementId) params.set("entitlement_id", entitlementId);
  const id = productId(product);
  if (id) params.set("product_id", id);
  const creator = creatorId(product) || entitlement?.creator_id;
  if (creator) params.set("creator_id", creator);
  return `hatch://products/open${params.toString() ? `?${params}` : ""}`;
}

function arrayValue(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) return [value];
  return fallback;
}

function textValue(value, t = identity) { return typeof value === "string" ? value : value?.label || value?.summary || value?.description || t("Product detail"); }

function dateTime(value, t, dateOnly = false) {
  if (!value) return t ? t("Not recorded") : "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(intlLocale(t), dateOnly ? { dateStyle: "medium" } : { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function friendlyError(error, t = identity) {
  if (!error) return t("Something went wrong. Try again.");
  if (error.code === "release_changed") return t("This product was updated. Refresh to confirm the current version.");
  if (error.status === 429) return t("Too many requests. Try again shortly.");
  if (error.status >= 500) return t("Hatch is temporarily unavailable. Try again shortly.");
  // Known server messages are translated; unknown ones are shown as sent.
  return error.message ? t(error.message) : t("Something went wrong. Try again.");
}

function clientContractError(message) {
  const error = new Error(message);
  error.code = "client_contract";
  return error;
}

function requestId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function numberOr(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function sentenceCase(value) {
  return humanizeIdentifier(value);
}
