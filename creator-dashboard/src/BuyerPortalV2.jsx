import React, { useEffect, useMemo, useRef, useState } from "react";
import { Menu } from "lucide-react";
import {
  Avatar,
  Button,
  DropdownMenu,
  Checkbox as HatchCheckbox,
  EmptyState as HatchEmptyState,
  HatchBrand,
  IconButton,
  InlineAlert as HatchInlineAlert,
  Input,
  PageHeader,
  Select,
  StatusTag,
  Surface
} from "@hatch/ui";
import { CheckoutSummary } from "@hatch/ui/product";
import { StorefrontDetails } from "./StorefrontDetails.jsx";
import { meaningfulReversalStatus } from "./buyerPresentation.js";
import { creatorPublicModel } from "./storefrontModel.js";
import { formatUsd, formatWebDate, getWebLocale, localizeWebIdentifier, webErrorMessage, webT } from "./webI18n.js";
import { WebLanguagePicker, useWebLocale } from "./WebLocaleProvider.jsx";
import "./buyerPortalV2.css";

const DEFAULT_DOWNLOAD_URL = "/download";
const EXPLORE_ROOT = "/explore";
const LIBRARY_ROOT = "/library";
const ORDERS_ROOT = "/orders";
const CHECKOUT_ROOT = "/checkout";
const ACCOUNT_ROOT = "/account";
const PUBLIC_ROUTE_NAMES = new Set(["catalog", "creator", "product", "sign-in", "sign-up", "account-help", "not-found"]);

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
 *     user?: { display_name?, email?, initials? },
 *     signIn?(credentials): Promise<unknown>,
 *     signUp?(profile): Promise<unknown>,
 *     creatorSignUp?(profile): Promise<unknown>,
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
 * Product/checkout/order payloads may expose either nested snapshots or the
 * equivalent flat migration fields. Helpers in this module normalize both.
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
  useWebLocale();
  const location = splitLocation(pathname, search);
  const route = useMemo(() => matchBuyerRoute(location.pathname), [location.pathname]);
  useRouteHeadingFocus(location.pathname, location.search);
  const go = (to, options) => navigateTo(navigate, to, options);
  const returnTo = `${location.pathname}${location.search}`;

  if (!PUBLIC_ROUTE_NAMES.has(route.name) && session.status === "loading") {
    return <BuyerShell route={route} navigate={navigate} session={session} downloadUrl={downloadUrl}><PageSkeleton label={webT("buyer.openingAccount")} /></BuyerShell>;
  }

  if (!PUBLIC_ROUTE_NAMES.has(route.name) && session.status !== "authenticated") {
    const destination = `/sign-in?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
    return <RedirectPage to={destination} navigate={navigate} />;
  }

  let page;
  if (route.name === "catalog") {
    page = <CatalogPage request={request} navigate={navigate} session={session} />;
  } else if (route.name === "creator") {
    page = <CreatorPublicPage creatorId={route.params.creatorId} request={request} navigate={navigate} session={session} />;
  } else if (route.name === "product") {
    page = <ProductPage route={route} request={request} navigate={navigate} session={session} downloadUrl={downloadUrl} />;
  } else if (route.name === "sign-in" || route.name === "sign-up") {
    return <AuthPage mode={route.name} search={location.search} request={request} navigate={navigate} session={session} />;
  } else if (route.name === "library") {
    page = <LibraryPage search={location.search} request={request} navigate={navigate} />;
  } else if (route.name === "entitlement") {
    page = <EntitlementPage id={route.params.entitlementId} request={request} navigate={navigate} session={session} downloadUrl={downloadUrl} />;
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

  return <BuyerShell route={route} navigate={navigate} session={session} downloadUrl={downloadUrl}>{page}</BuyerShell>;
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
  if (segments.length === 1 && segments[0] === "library") return { name: "library", params: {} };
  if (segments.length === 2 && segments[0] === "library") return { name: "entitlement", params: { entitlementId: segments[1] } };
  if (segments.length === 1 && segments[0] === "orders") return { name: "orders", params: {} };
  if (segments.length === 3 && segments[0] === "orders" && segments[2] === "success") return { name: "success", params: { orderId: segments[1], orderNumber: segments[1] } };
  if (segments.length === 2 && segments[0] === "orders") return { name: "order", params: { orderId: segments[1], orderNumber: segments[1] } };
  if (segments.length === 2 && segments[0] === "checkout") return { name: "checkout", params: { checkoutSessionId: segments[1] } };
  if (segments.length === 1 && segments[0] === "account") return { name: "settings", params: {} };
  return { name: "not-found", params: {} };
}

function BuyerShell({ route, navigate, session, downloadUrl, children }) {
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const authenticated = session.status === "authenticated";
  const active = route.name === "catalog" || route.name === "creator" || route.name === "product"
    ? "explore"
    : route.name === "library" || route.name === "entitlement"
      ? "library"
      : route.name === "orders" || route.name === "order" || route.name === "success"
        ? "orders"
        : route.name === "settings"
          ? "settings"
        : "";

  async function signOut() {
    if (!session.signOut || signingOut) return;
    setSigningOut(true);
    setSignOutError("");
    try {
      await session.signOut();
      navigateTo(navigate, EXPLORE_ROOT, { replace: true });
    } catch (error) {
      setSignOutError(friendlyError(error));
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="buyer-v2">
      <header className="buyer-v2__header">
        <div className="buyer-v2__header-inner">
          <HatchBrand as={RouterLink} className="buyer-v2__brand" to={EXPLORE_ROOT} navigate={navigate} aria-label={webT("common.hatchHome")} />
          <nav className="buyer-v2__nav" aria-label={webT("common.buyerNavigation")}>
            <RouterLink to={EXPLORE_ROOT} navigate={navigate} aria-current={active === "explore" ? "page" : undefined}>{webT("common.explore")}</RouterLink>
            {authenticated ? <RouterLink to={LIBRARY_ROOT} navigate={navigate} aria-current={active === "library" ? "page" : undefined}>{webT("common.library")}</RouterLink> : null}
            {authenticated ? <RouterLink to={ORDERS_ROOT} navigate={navigate} aria-current={active === "orders" ? "page" : undefined}>{webT("common.orders")}</RouterLink> : null}
          </nav>
          <div className="buyer-v2__mobile-nav">
            <DropdownMenu
              label={webT("common.buyerNavigation")}
              trigger={<IconButton label={webT("common.openNavigation")} variant="secondary" size="small"><Menu aria-hidden="true" /></IconButton>}
              items={[
                { value: "explore", label: webT("common.explore"), active: active === "explore", onSelect: () => navigateTo(navigate, EXPLORE_ROOT) },
                ...(authenticated ? [{ value: "library", label: webT("common.library"), active: active === "library", onSelect: () => navigateTo(navigate, LIBRARY_ROOT) }] : []),
                ...(authenticated ? [{ value: "orders", label: webT("common.orders"), active: active === "orders", onSelect: () => navigateTo(navigate, ORDERS_ROOT) }] : [])
              ]}
            />
          </div>
          <div className="buyer-v2__account">
            <WebLanguagePicker className="buyer-v2__language-picker" />
            <a className="buyer-v2__download-quiet" href={downloadUrl} target="_blank" rel="noreferrer">{webT("common.download")}</a>
            {authenticated ? (
              <>
                <RouterLink className="buyer-v2__avatar" to={ACCOUNT_ROOT} navigate={navigate} aria-label={webT("common.accountSettings")} aria-current={active === "settings" ? "page" : undefined}>{initialsFor(session.user)}</RouterLink>
                <Button type="button" variant="ghost" size="small" disabled={signingOut} onClick={signOut}>{signingOut ? webT("buyer.signingOut") : webT("buyer.signOut")}</Button>
              </>
            ) : (
              <LinkButton variant="secondary" size="small" to={`/sign-in?returnTo=${encodeURIComponent(EXPLORE_ROOT)}`} navigate={navigate}>{webT("common.signIn")}</LinkButton>
            )}
          </div>
        </div>
        {signOutError ? <div className="buyer-v2__header-error" role="alert">{signOutError}</div> : null}
      </header>
      <main id="buyer-main" className="buyer-v2__main" tabIndex="-1">{children}</main>
    </div>
  );
}

function CatalogPage({ request, navigate, session }) {
  usePageTitle(webT("common.product"));
  const resource = useRemote(async (signal) => {
    const response = await callRequest(request, BUYER_PORTAL_V2_ENDPOINTS.catalog, { signal });
    return collectionFrom(response, ["agents", "items"]);
  }, "catalog");

  return (
    <div className="buyer-v2__container buyer-v2__page">
      <PageHeader className="buyer-v2__page-heading buyer-v2__catalog-heading" title={webT("buyer.productsTitle")} body={webT("buyer.productsBody")} />
      {resource.status === "loading" ? <CardSkeleton count={3} label={webT("buyer.loadingProducts")} /> : null}
      {resource.status === "error" ? <RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo={EXPLORE_ROOT} /> : null}
      {resource.status === "ready" && resource.data.length ? (
        <section className="buyer-v2__catalog-grid" aria-label={webT("buyer.availableProducts")}>
          {resource.data.map((product) => <CatalogCard key={productKey(product)} product={product} navigate={navigate} authenticated={session.status === "authenticated"} />)}
        </section>
      ) : null}
      {resource.status === "ready" && resource.data.length === 0 ? (
        <EmptyState title={webT("buyer.noProducts")} body={webT("buyer.noProductsBody")} />
      ) : null}
    </div>
  );
}

function CreatorPublicPage({ creatorId, request, navigate, session }) {
  const endpoint = `/v1/public/creators/${encodeURIComponent(creatorId)}`;
  const resource = useRemote(async (signal) => callRequest(request, endpoint, { signal }), endpoint);
  const publicModel = creatorPublicModel(resource.data);
  usePageTitle(publicModel.creator?.name ? `${publicModel.creator.name} · Hatch` : `${webT("common.creator")} · Hatch`);
  if (resource.status === "loading") return <div className="buyer-v2__container buyer-v2__page"><PageSkeleton label={webT("buyer.loadingProducts")} /></div>;
  if (resource.status === "error") return <div className="buyer-v2__container buyer-v2__page"><RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo={`/creators/${encodeURIComponent(creatorId)}`} /></div>;
  const creator = publicModel.creator;
  const products = publicModel.products;
  return (
    <div className="buyer-v2__container buyer-v2__page">
      <RouterLink className="buyer-v2__back-link" to={EXPLORE_ROOT} navigate={navigate}>{webT("buyer.backExplore")}</RouterLink>
      <header className="buyer-v2__page-heading buyer-v2__creator-heading">
        <Avatar className="buyer-v2__creator-profile-avatar" size="large" src={creatorAvatarUrl(creator)} name={creator?.name ?? creator?.display_name ?? creatorId} />
        <div>
          <h1>{creator?.name ?? creator?.display_name ?? creatorId}</h1>
          <p>{creator?.bio ?? creator?.description ?? webT("buyer.publishedMethods")}</p>
        </div>
      </header>
      {products.length ? <section className="buyer-v2__catalog-grid" aria-label={`${creator?.name ?? creatorId} ${webT("buyer.creatorProducts")}`}>{products.map((product) => <CatalogCard key={productKey(product)} product={product} navigate={navigate} authenticated={session.status === "authenticated"} />)}</section> : <EmptyState title={webT("buyer.noPublicProducts")} body={webT("buyer.noPublicProductsBody")} action={<LinkButton to={EXPLORE_ROOT} navigate={navigate}>{webT("buyer.exploreAllProducts")}</LinkButton>} />}
    </div>
  );
}

function CatalogCard({ product, navigate }) {
  const path = productPath(product);
  const access = accessFor(product);
  return (
    <article className="buyer-v2__catalog-card">
      <div className="buyer-v2__card-topline">
        <span className="buyer-v2__eyebrow">{creatorName(product)}</span>
        {product.creator_verified || product.creator?.verified ? <span className="buyer-v2__verified">{webT("buyer.verified")}</span> : null}
      </div>
      <h2>{productName(product)}</h2>
      <p>{productPromise(product)}</p>
      <div className="buyer-v2__card-footer">
        <div><strong>{accessStatus(access) === "active" ? webT("buyer.inLibrary") : product.availability === "published" ? webT("common.free") : webT("buyer.unavailable")}</strong><span>{product.availability === "published" ? webT("buyer.permanentAccess") : webT("buyer.unavailable")}</span></div>
        <LinkButton variant="secondary" to={path} navigate={navigate}>{webT("buyer.viewDetails")}</LinkButton>
      </div>
    </article>
  );
}

function ProductPage({ route, request, navigate, session, downloadUrl }) {
  const { productId } = route.params;
  const path = `/products/${encodeURIComponent(productId)}`;
  const endpoint = `${BUYER_PORTAL_V2_ENDPOINTS.catalog}/${encodeURIComponent(productId)}`;
  const resource = useRemote(async (signal) => unwrap(await callRequest(request, endpoint, { signal }), ["agent", "product"]), endpoint);
  const product = resource.data;
  usePageTitle(product ? productName(product) : webT("buyer.agentDetails"));

  if (resource.status === "loading") return <div className="buyer-v2__container buyer-v2__page"><DetailSkeleton /></div>;
  if (resource.status === "error") return <div className="buyer-v2__container buyer-v2__page"><RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo={path} /></div>;

  const examples = arrayValue(product.examples || product.proof, []);
  const desktopRequirement = product.desktop_requirement || webT("buyer.productDesktopRequirementFallback");
  const productCreatorId = product?.creator_id ?? product?.creator?.id;
  const productCreatorName = creatorName(product);
  const productCreatorByline = productCreatorId
    ? <RouterLink className="storefront-shared__creator-link" to={`/creators/${encodeURIComponent(productCreatorId)}`} navigate={navigate}>{productCreatorName}</RouterLink>
    : productCreatorName;

  return (
    <div className="buyer-v2__container buyer-v2__page">
      <RouterLink className="buyer-v2__back-link" to={EXPLORE_ROOT} navigate={navigate}>{webT("buyer.backExplore")}</RouterLink>
      <StorefrontDetails
        product={product}
        creatorName={productCreatorByline}
        creatorInitial={productCreatorName.trim().charAt(0)}
        creatorAvatarUrl={product.creator_avatar_url || product.creator?.avatar_url || product.creator?.image_url}
        desktopRequirement={desktopRequirement}
        releaseLabel={product.release_label || product.release?.label}
        action={<ProductAction embedded product={product} currentPath={path} request={request} navigate={navigate} session={session} downloadUrl={downloadUrl} />}
      />

      <section className="buyer-v2__wide-section buyer-v2__process-section">
        <span className="buyer-v2__eyebrow">{webT("buyer.howItWorks")}</span>
        <h2>{webT("buyer.accessFromWork")}</h2>
        <ol className="buyer-v2__steps">
          <li><span>1</span><div><strong>{webT("buyer.stepAddAgent")}</strong><p>{webT("buyer.confirmPermanentAccess")}</p></div></li>
          <li><span>2</span><div><strong>{webT("buyer.stepOpenDesktop")}</strong><p>{webT("buyer.signInDesktopWorkspace")}</p></div></li>
          <li><span>3</span><div><strong>{webT("buyer.stepWorkAgent")}</strong><p>{webT("buyer.workAsOften")}</p></div></li>
        </ol>
      </section>

      {examples.length ? <InfoSection className="buyer-v2__wide-section" eyebrow={webT("buyer.representativeExamples")} title={webT("buyer.evidenceTitle")} items={examples} /> : null}
    </div>
  );
}

function ProductAction({ product, currentPath, request, navigate, session, downloadUrl, embedded = false }) {
  const access = accessFor(product);
  const status = accessStatus(access);
  const [mutation, setMutation] = useState({ status: "idle", error: null });
  const checkoutIntentKey = useRef(requestId());
  const purchasable = Boolean(productId(product))
    && product.availability === "published"
    && product.available !== false
    && product.status !== "withdrawn";
  const isAnonymous = session.status !== "authenticated";
  const isOwnerCreator = session.user?.role === "creator"
    && String(session.user?.id ?? "") === String(product.creator_id ?? product.creator?.id ?? "");

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

  if (isOwnerCreator) {
    title = webT("buyer.yourPublishedStorefront");
    body = webT("buyer.buyersSeePromise");
    action = <LinkButton variant="secondary" to={`/studio/products/${encodeURIComponent(productId(product))}`} navigate={navigate}>{webT("buyer.manageProduct")}</LinkButton>;
  } else if (status === "active" || status === "reserved") {
    title = status === "reserved" ? webT("buyer.accessSetupInProgress") : webT("buyer.agentReady");
    body = status === "reserved" ? webT("buyer.returnDesktop") : webT("buyer.openDesktopWorkspace");
    action = <><LinkButton to={libraryPathFor(product, access)} navigate={navigate}>{webT("buyer.viewInLibrary")}</LinkButton><Button asChild variant="secondary"><a href={desktopUrl(access, product)} onClick={() => trackPortalEvent(request, "desktop_open_clicked", productTelemetry(product))}>{webT("buyer.openDesktop")}</a></Button></>;
  } else if (status === "pending") {
    title = webT("buyer.settingUpAccess");
    body = webT("buyer.orderConfirmedBody");
    action = <Button type="button" loading>{webT("buyer.settingUpAccessButton")}</Button>;
  } else if (!purchasable) {
    title = webT("buyer.productUnavailableTitle");
    body = webT("buyer.creatorWithdrawn");
  } else if (isAnonymous) {
    const authPath = `/sign-in?returnTo=${encodeURIComponent(currentPath)}`;
    action = <LinkButton to={authPath} navigate={navigate}>{webT("buyer.getAccess")}</LinkButton>;
  } else {
    action = <Button type="button" loading={mutation.status === "pending"} onClick={startCheckout}>{webT("buyer.getAccess")}</Button>;
  }

  const contents = (
    <>
      {title ? <h2>{title}</h2> : null}
      {body ? <p>{body}</p> : null}
      {mutation.error ? <InlineError error={mutation.error} /> : null}
      {action}
      <a className="buyer-v2__secondary-download" href={downloadUrl} target="_blank" rel="noreferrer" onClick={() => trackPortalEvent(request, "desktop_download_clicked", productTelemetry(product))}>{webT("buyer.downloadDesktopLink")}</a>
    </>
  );
  if (embedded) return <div className="buyer-v2__storefront-action">{contents}</div>;
  return (
    <aside className="buyer-v2__action-card" aria-label={webT("buyer.productAccess")}>
      <span className="buyer-v2__eyebrow">{webT("common.access")}</span>
      <div className="buyer-v2__price"><strong>{webT("common.free")}</strong></div>
      {contents}
    </aside>
  );
}

function SettingsPage({ session, navigate }) {
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  usePageTitle(webT("buyer.accountSettings"));
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
  return <div className="buyer-v2__container buyer-v2__page">
    <header className="buyer-v2__page-heading"><span className="buyer-v2__eyebrow">{webT("buyer.accountEyebrow")}</span><h1>{webT("buyer.accountTitle")}</h1><p>{webT("buyer.accountBody")}</p></header>
    <section className="buyer-v2__settings-surface" aria-label={webT("buyer.signedInAccountLabel")}>
      <div className="buyer-v2__settings-identity">
        <Avatar className="buyer-v2__settings-avatar" size="large" name={session.user?.display_name || webT("buyer.hatchAccountFallback")} fallback={session.user?.initials} />
        <div><h2>{session.user?.display_name || webT("buyer.hatchAccountFallback")}</h2><p>{webT("buyer.signedInToHatch")}</p></div>
      </div>
      {error ? <InlineError error={error} /> : null}
      <div className="buyer-v2__settings-actions"><Button type="button" variant="secondary" loading={status === "pending"} onClick={signOut}>{webT("buyer.signOut")}</Button><RouterLink to="/account/help" navigate={navigate}>{webT("buyer.accountHelpLink")}</RouterLink></div>
    </section>
  </div>;
}

function AccountHelpPage({ session, navigate }) {
  usePageTitle(webT("buyer.accountHelp"));
  return <div className="buyer-v2__container buyer-v2__page">
    <header className="buyer-v2__page-heading"><span className="buyer-v2__eyebrow">{webT("buyer.accountHelp")}</span><h1>{webT("buyer.accountHelpTitle")}</h1><p>{webT("buyer.accountHelpBody")}</p></header>
    <section className="buyer-v2__decision-grid">
      <article className="buyer-v2__info-card"><span className="buyer-v2__eyebrow">{webT("buyer.session")}</span><h2>{session.status === "authenticated" ? webT("buyer.signedIn") : webT("buyer.signInContinue")}</h2><p>{webT("buyer.sessionBody")}</p>{session.status === "authenticated" ? <LinkButton variant="secondary" to={ACCOUNT_ROOT} navigate={navigate}>{webT("buyer.viewSettings")}</LinkButton> : <LinkButton to="/sign-in?returnTo=%2Faccount%2Fhelp" navigate={navigate}>{webT("common.signIn")}</LinkButton>}</article>
      <article className="buyer-v2__info-card"><span className="buyer-v2__eyebrow">{webT("buyer.purchaseSupport")}</span><h2>{webT("buyer.supportReference")}</h2><p>{webT("buyer.supportBody")}</p><LinkButton variant="secondary" to={session.status === "authenticated" ? ORDERS_ROOT : EXPLORE_ROOT} navigate={navigate}>{session.status === "authenticated" ? webT("buyer.viewOrders") : webT("buyer.exploreProducts")}</LinkButton></article>
    </section>
  </div>;
}

function SubscriptionsPage({ navigate }) {
  usePageTitle(webT("buyer.subscriptions"));
  return <div className="buyer-v2__container buyer-v2__page"><StatePanel eyebrow={webT("buyer.subscriptions")} title={webT("buyer.noSubscriptions")} body={webT("buyer.noSubscriptionsBody")}><LinkButton to={EXPLORE_ROOT} navigate={navigate}>{webT("buyer.exploreProducts")}</LinkButton></StatePanel></div>;
}

function AuthPage({ mode, search, request, navigate, session }) {
  const signingUp = mode === "sign-up";
  const params = new URLSearchParams(search);
  const returnTo = safeReturnTo(params.get("returnTo") || LIBRARY_ROOT);
  const creatorIntent = returnTo === "/studio" || returnTo.startsWith("/studio/");
  const intentRoute = matchBuyerRoute(returnTo.split("?")[0]);
  const productIntent = intentRoute.name === "product";
  const intentEndpoint = productIntent ? `${BUYER_PORTAL_V2_ENDPOINTS.catalog}/${encodeURIComponent(intentRoute.params.productId)}` : "";
  const intent = useRemote(async (signal) => unwrap(await callRequest(request, intentEndpoint, { signal }), ["agent", "product"]), intentEndpoint || "no-intent", productIntent);
  const [form, setForm] = useState({ display_name: "", email: "", password: "", terms: false });
  const [submission, setSubmission] = useState({ status: "idle", error: null });
  usePageTitle(signingUp
    ? (creatorIntent ? webT("buyer.creatorSignupEyebrow") : webT("buyer.accountSignupEyebrow"))
    : webT("buyer.signInToHatch"));

  useEffect(() => {
    const canSwitchIntoCreatorSignup = signingUp && creatorIntent && session.user?.role !== "creator";
    if (session.status === "authenticated" && !canSwitchIntoCreatorSignup) navigateTo(navigate, returnTo, { replace: true });
  }, [creatorIntent, navigate, returnTo, session.status, session.user?.role, signingUp]);

  async function submit(event) {
    event.preventDefault();
    if (submission.status === "pending") return;
    setSubmission({ status: "pending", error: null });
    try {
      let response;
      if (signingUp && creatorIntent && session.creatorSignUp) response = await session.creatorSignUp(form);
      else if (signingUp && session.signUp) response = await session.signUp(form);
      else if (!signingUp && session.signIn) response = await session.signIn({ email: form.email, password: form.password });
      else response = await callRequest(request, signingUp
        ? (creatorIntent ? "/v1/auth/creator-signup" : "/v1/auth/signup")
        : "/v1/auth/login", jsonMutation("POST", signingUp ? form : { email: form.email, password: form.password }));
      await session.onAuthenticated?.(response);
      navigateTo(navigate, returnTo, { replace: true });
    } catch (error) {
      setSubmission({ status: "error", error });
    }
  }

  return (
    <main className="buyer-v2 buyer-v2__auth-page">
      <section className="buyer-v2__auth-context">
        <HatchBrand as={RouterLink} className="buyer-v2__brand buyer-v2__brand--inverse" to={EXPLORE_ROOT} navigate={navigate} aria-label={webT("common.hatchHome")} />
        <div>
          <span className="buyer-v2__eyebrow">{webT("buyer.continueTask")}</span>
          {productIntent && intent.status === "loading" ? <div className="buyer-v2__auth-intent-skeleton" aria-label={webT("buyer.loadingProduct")} /> : null}
          {productIntent && intent.status === "ready" ? <><h1>{productName(intent.data)}</h1><p>{productPromise(intent.data)}</p><strong>{webT("buyer.permanentAccess")}</strong><small>{creatorName(intent.data)}</small></> : null}
          {!productIntent ? <><h1>{webT("buyer.methodMadeUseful")}</h1><p>{webT("buyer.methodMadeUsefulBody")}</p></> : null}
        </div>
      </section>
      <section className="buyer-v2__auth-form-panel">
        <form className="buyer-v2__auth-form" onSubmit={submit}>
          <span className="buyer-v2__eyebrow">{creatorIntent ? webT("buyer.creatorAccount") : webT("buyer.hatchAccount")}</span>
          <h2>{signingUp ? (creatorIntent ? webT("buyer.creatorSignupEyebrow") : webT("buyer.createYourAccount")) : webT("buyer.signInToHatch")}</h2>
          <p>{signingUp
            ? creatorIntent
              ? webT("buyer.creatorSignupBody")
              : webT("buyer.accountSignupBody")
            : creatorIntent
              ? webT("buyer.creatorSigninBody")
              : webT("buyer.signinBody")}</p>
          {signingUp ? <Field label={webT("buyer.name")}><Input required autoComplete="name" value={form.display_name} onChange={(event) => setForm({ ...form, display_name: event.target.value })} /></Field> : null}
          <Field label={webT("buyer.email")}><Input required type="email" autoComplete="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field>
          <Field label={webT("buyer.password")}><Input required minLength={8} type="password" autoComplete={signingUp ? "new-password" : "current-password"} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field>
          {signingUp ? <HatchCheckbox className="buyer-v2__checkbox" required checked={form.terms} onCheckedChange={(checked) => setForm({ ...form, terms: checked === true })} label={webT("buyer.terms")} /> : null}
          {submission.error ? <InlineError error={submission.error} /> : null}
          <div className="buyer-v2__auth-actions">
            <Button className="buyer-v2__button--wide" loading={submission.status === "pending"}>{signingUp ? (creatorIntent ? webT("buyer.createCreator") : webT("buyer.createAccount")) : webT("common.signIn")}</Button>
            <p className="buyer-v2__auth-switch">{signingUp ? webT("buyer.alreadyAccount") : (creatorIntent ? webT("buyer.newToCreator") : webT("buyer.newToHatch"))} <RouterLink to={`${signingUp ? "/sign-in" : "/sign-up"}?returnTo=${encodeURIComponent(returnTo)}`} navigate={navigate}>{signingUp ? webT("common.signIn") : (creatorIntent ? webT("buyer.createCreator") : webT("buyer.createAccount"))}</RouterLink></p>
          </div>
        </form>
      </section>
    </main>
  );
}

function CheckoutPage({ id, request, navigate, session }) {
  const endpoint = `${BUYER_PORTAL_V2_ENDPOINTS.checkoutSessions}/${encodeURIComponent(id)}`;
  const resource = useRemote(async (signal) => unwrap(await callRequest(request, endpoint, { signal }), ["checkout_session", "checkout"]), endpoint);
  const [accepted, setAccepted] = useState(false);
  const [mutation, setMutation] = useState({ status: "idle", error: null });
  const confirmationIntentKey = useRef(requestId());
  const checkout = resource.data;
  const fulfillmentPending = checkout?.status === "fulfillment_pending";
  usePageTitle(checkout ? `${webT("buyer.confirmOrder")} · ${productName(checkout.product || checkout.product_snapshot || checkout)}` : webT("buyer.confirmOrder"));
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
      navigateTo(navigate, result.redirect_url || response.redirect_url || `/orders/${encodeURIComponent(orderId)}/success`, { replace: true });
    } catch (error) {
      setMutation({ status: "error", error });
      if (error.status === 409 || error.status === 502 || error.code === "fulfillment_pending") resource.reload();
    }
  }

  if (resource.status === "loading") return <div className="buyer-v2__container buyer-v2__page"><DetailSkeleton /></div>;
  if (resource.status === "error") return <div className="buyer-v2__container buyer-v2__page"><RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo={`${CHECKOUT_ROOT}/${id}`} /></div>;

  const product = checkout.product_snapshot || checkout.product || checkout;
  const expired = ["expired", "release_changed", "cancelled"].includes(checkout.status) || (checkout.status === "open" && checkout.expires_at && Date.parse(checkout.expires_at) <= Date.now());

  if (fulfillmentPending) {
    const orderId = checkout.order_id || checkout.order?.order_id;
    return <div className="buyer-v2__container buyer-v2__page"><StatePanel eyebrow={webT("buyer.accessSetup")} title={webT("buyer.accessConfirmed")} body={webT("buyer.accessConfirmedBody")}>
      <span className="buyer-v2__spinner" aria-hidden="true" />
      {mutation.error ? <InlineError error={mutation.error} /> : null}
      <Button type="button" loading={mutation.status === "pending"} onClick={confirm}>{webT("buyer.retrySetup")}</Button>
      {orderId ? <LinkButton variant="secondary" to={`${ORDERS_ROOT}/${encodeURIComponent(orderId)}`} navigate={navigate}>{webT("buyer.viewConfirmedOrder")}</LinkButton> : null}
    </StatePanel></div>;
  }

  if (checkout.status === "refunded") {
    return <div className="buyer-v2__container buyer-v2__page"><StatePanel tone="warning" eyebrow={webT("buyer.accessRemoved")} title={webT("buyer.accessInactive")} body={webT("buyer.receiptAvailable")}>{checkout.order_id ? <LinkButton to={`${ORDERS_ROOT}/${encodeURIComponent(checkout.order_id)}`} navigate={navigate}>{webT("buyer.viewReceipt")}</LinkButton> : null}<LinkButton variant="secondary" to={productPath(product)} navigate={navigate}>{webT("buyer.returnProduct")}</LinkButton></StatePanel></div>;
  }

  return (
    <div className="buyer-v2__container buyer-v2__page buyer-v2__checkout-page">
      <RouterLink className="buyer-v2__back-link" to={productPath(product)} navigate={navigate}>← {webT("buyer.returnProduct")}</RouterLink>
      <header className="buyer-v2__page-heading"><span className="buyer-v2__eyebrow">{webT("buyer.permanentAccess")}</span><h1>{webT("buyer.confirmProduct")}</h1><p>{webT("buyer.accessPinnedRelease")}</p></header>
      <div className="buyer-v2__checkout-grid">
        <section className="buyer-v2__receipt-card">
          <div className="buyer-v2__receipt-product"><span>{creatorName(checkout.creator || product)}</span><h2>{productName(product)}</h2><p>{productPromise(product)}</p></div>
          <DefinitionList rows={[
            [webT("buyer.releaseLabel"), checkout.release_label || checkout.release_snapshot?.label || product.release_label || webT("buyer.currentApprovedRelease")],
            [webT("buyer.accessLabel"), webT("buyer.permanentAccess")],
            [webT("buyer.paymentLabel"), webT("buyer.paymentNotRequired")]
          ]} />
        </section>
        <CheckoutSummary
          product={{ ...product, name: productName(product), currency: "USD" }}
          lineItems={[{ label: webT("buyer.permanentAccess"), detail: checkout.release_label || checkout.release_snapshot?.label || product.release_label || webT("buyer.currentApprovedRelease"), amount_minor: 0 }]}
          totals={{ subtotal_minor: 0, total_minor: 0, subtotal_label: webT("common.free"), total_label: webT("common.free"), currency: "USD" }}
          busy={mutation.status === "pending"}
          error={mutation.error ? friendlyError(mutation.error) : undefined}
          action={{ label: mutation.status === "pending" ? webT("buyer.addingToAccount") : webT("buyer.addToAccount"), disabled: !accepted || expired, onClick: confirm }}
          legal={webT("buyer.checkoutLegal")}
        >
          <HatchCheckbox checked={accepted} onCheckedChange={(checked) => setAccepted(checked === true)} disabled={expired} label={webT("buyer.addProductToAccount")} />
          {expired ? <HatchInlineAlert tone="warning">{webT("buyer.accessRequestStale")}</HatchInlineAlert> : null}
        </CheckoutSummary>
      </div>
    </div>
  );
}

function SuccessPage({ id, request, navigate, downloadUrl, session }) {
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
  const ready = data ? successReady(data.order, data.entitlement) : false;
  const failed = data ? paymentFailed(data.order) : false;
  useUnauthorized(resource.error, session);
  usePageTitle(ready ? webT("buyer.yourAgentReady") : webT("buyer.confirmingYourOrder"));

  useEffect(() => {
    if (resource.status !== "ready" || ready || failed) return undefined;
    const timer = window.setTimeout(resource.reload, 2200);
    return () => window.clearTimeout(timer);
  }, [resource.status, ready, failed, resource.reload]);

  if (resource.status === "loading") return <div className="buyer-v2__container buyer-v2__page"><PageSkeleton label={webT("buyer.confirmingYourOrder")} /></div>;
  if (resource.status === "error" && resource.error?.status >= 500) return <div className="buyer-v2__container buyer-v2__page"><StatePanel tone="warning" eyebrow={webT("buyer.receiptSyncing")} title={webT("buyer.purchaseCompleted")} body={webT("buyer.purchaseCompletedBody")}><Button type="button" onClick={resource.reload}>{webT("buyer.tryReceiptAgain")}</Button></StatePanel></div>;
  if (resource.status === "error") return <div className="buyer-v2__container buyer-v2__page"><RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo={`${ORDERS_ROOT}/${id}/success`} /></div>;

  const { order, entitlement, entitlementError } = data;
  const product = order.product_snapshot || order.product || order;
  const amount = orderAmount(order);
  const entitlementId = order.entitlement_id || entitlement?.entitlement_id || entitlement?.id;

  if (failed) {
    return <div className="buyer-v2__container buyer-v2__page"><StatePanel tone="error" eyebrow={webT("buyer.paymentNotCompleted")} title={webT("buyer.yourAccountNotCharged")} body={webT("buyer.noAccessGrantedBody")}><LinkButton to={`${ORDERS_ROOT}/${encodeURIComponent(id)}`} navigate={navigate}>{webT("buyer.viewOrder")}</LinkButton></StatePanel></div>;
  }

  if (!ready) {
    return <div className="buyer-v2__container buyer-v2__page"><StatePanel eyebrow={webT("buyer.confirmingPayment")} title={webT("buyer.confirmingOrder")} body={webT("buyer.doNotSubmitAgain")}><span className="buyer-v2__spinner" aria-hidden="true" /><LinkButton variant="secondary" to={`${ORDERS_ROOT}/${encodeURIComponent(id)}`} navigate={navigate}>{webT("buyer.viewOrderStatus")}</LinkButton></StatePanel></div>;
  }

  return (
    <div className="buyer-v2__container buyer-v2__page buyer-v2__success-page">
      <section className="buyer-v2__success-hero">
        <span className="buyer-v2__success-mark" aria-hidden="true">✓</span>
        <span className="buyer-v2__eyebrow">{webT("common.accessGranted")}</span>
        <h1>{productName(product)} is ready.</h1>
        <p>{webT("common.order")} #{orderReference(order)} · {amount === 0 ? webT("common.free") : money(amount, order.currency)} · {webT("common.accessGranted")}</p>
        {entitlementError ? <HatchInlineAlert tone="warning" action={<Button size="small" variant="ghost" type="button" onClick={resource.reload}>{webT("common.retry")}</Button>}>{webT("buyer.purchaseDetailsUnavailable")}</HatchInlineAlert> : null}
        <div className="buyer-v2__success-actions">
          <Button asChild><a href={desktopUrl(entitlement, product)} onClick={() => trackPortalEvent(request, "desktop_open_clicked", productTelemetry(product))}>{webT("buyer.openDesktop")}</a></Button>
          <Button asChild variant="secondary"><a href={downloadUrl} target="_blank" rel="noreferrer" onClick={() => trackPortalEvent(request, "desktop_download_clicked", productTelemetry(product))}>{webT("buyer.downloadDesktop")}</a></Button>
        </div>
      </section>
      <section className="buyer-v2__next-steps">
        <span className="buyer-v2__eyebrow">{webT("buyer.whatHappensNext")}</span>
        <ol><li><span>1</span>{webT("buyer.signInDesktop")}</li><li><span>2</span>{webT("buyer.chooseAgentWorkspace")}</li><li><span>3</span>{webT("buyer.reviewPermissions")}</li></ol>
        <div className="buyer-v2__detail-links">
          <RouterLink to={`/orders/${encodeURIComponent(orderReference(order))}`} navigate={navigate}>{webT("buyer.viewOrderReceipt")}</RouterLink>
          {entitlementId ? <RouterLink to={libraryPathFor(product, entitlement)} navigate={navigate}>{webT("buyer.viewAccessDetailsArrow")}</RouterLink> : null}
        </div>
      </section>
    </div>
  );
}

function LibraryPage({ search, request, navigate }) {
  const resource = useCursorCollection(async (cursor, signal) => {
    const query = new URLSearchParams();
    query.set("status", "active");
    if (cursor) query.set("cursor", cursor);
    const response = await callRequest(request, `${BUYER_PORTAL_V2_ENDPOINTS.entitlements}?${query}`, { signal });
    return pageFrom(response, ["entitlements", "creator_agents", "items"]);
  }, "entitlements");
  usePageTitle(webT("buyer.yourLibrary"));

  return (
    <div className="buyer-v2__container buyer-v2__page">
      <header className="buyer-v2__page-heading"><span className="buyer-v2__eyebrow">{webT("buyer.yourLibraryEyebrow")}</span><h1>{webT("buyer.agentsLinked")}</h1><p>{webT("buyer.libraryBody")}</p></header>
      {resource.status === "loading" ? <CardSkeleton count={2} label={webT("buyer.loadingLibrary")} /> : null}
      {resource.status === "error" ? <RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo={LIBRARY_ROOT} /> : null}
      {resource.status === "ready" && resource.items.length ? <section className="buyer-v2__list-grid" aria-label={webT("buyer.yourEntitlements")}>{resource.items.map((item) => <EntitlementCard key={entitlementIdFor(item)} entitlement={item} navigate={navigate} />)}</section> : null}
      {resource.status === "ready" && !resource.items.length ? <EmptyState title={webT("buyer.libraryEmpty")} body={webT("buyer.libraryEmptyBody")} action={<LinkButton to={EXPLORE_ROOT} navigate={navigate}>{webT("buyer.exploreProducts")}</LinkButton>} /> : null}
      {resource.nextCursor ? <LoadMore resource={resource} /> : null}
    </div>
  );
}

function EntitlementCard({ entitlement, navigate }) {
  const id = entitlementIdFor(entitlement);
  const status = accessStatus(entitlement);
  const product = entitlement.product || entitlement.product_snapshot || entitlement;
  return (
    <article className="buyer-v2__access-card">
      <div className="buyer-v2__card-topline"><StatusChip status={status} label={entitlementStatusLabel(status)} /><span>{creatorName(entitlement.creator || product)}</span></div>
      <h2>{productName(product)}</h2>
      <p>{entitlementSummary(entitlement)}</p>
      <div className="buyer-v2__card-footer"><span>{unitsLabel(entitlement)}</span><LinkButton variant="secondary" to={`${LIBRARY_ROOT}/${encodeURIComponent(id)}`} navigate={navigate}>{webT("buyer.viewAccess")}</LinkButton></div>
    </article>
  );
}

function EntitlementPage({ id, request, navigate, session, downloadUrl }) {
  const endpoint = `${BUYER_PORTAL_V2_ENDPOINTS.entitlements}/${encodeURIComponent(id)}`;
  const resource = useRemote(async (signal) => unwrap(await callRequest(request, endpoint, { signal }), ["entitlement"]), endpoint);
  usePageTitle(resource.data ? `${productName(resource.data.product || resource.data)} · ${webT("buyer.accessDetails")}` : webT("buyer.accessDetails"));
  useUnauthorized(resource.error, session);
  if (resource.status === "loading") return <div className="buyer-v2__container buyer-v2__page"><DetailSkeleton /></div>;
  if (resource.status === "error") return <div className="buyer-v2__container buyer-v2__page"><RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo={`${LIBRARY_ROOT}/${id}`} /></div>;

  const entitlement = resource.data;
  const product = entitlement.product || entitlement.product_snapshot || entitlement;
  const status = accessStatus(entitlement);
  const deliveries = arrayValue(entitlement.deliveries || entitlement.delivery_history, []);
  const orderId = entitlement.order_id || entitlement.order?.order_id || entitlement.order?.id;
  const canOpen = ["active", "reserved"].includes(status);
  const creator = entitlement.creator || product;
  const reversalStatus = meaningfulReversalStatus(entitlement.refund_status, entitlement.cancellation_status);
  return (
    <div className="buyer-v2__container buyer-v2__page">
      <RouterLink className="buyer-v2__back-link" to={LIBRARY_ROOT} navigate={navigate}>{webT("buyer.backLibrary")}</RouterLink>
      <header className="buyer-v2__detail-heading"><div><span className="buyer-v2__eyebrow">{webT("buyer.accessDetails")}</span><h1>{productName(product)}</h1><CreatorIdentity value={creator} /></div><StatusChip status={status} label={entitlementStatusLabel(status)} /></header>
      <div className="buyer-v2__detail-grid">
        <section className="buyer-v2__detail-card"><h2>{webT("buyer.yourEntitlement")}</h2><DefinitionList rows={[
          [webT("buyer.status"), entitlementStatusLabel(status)],
          [webT("buyer.accessLabel"), unitsLabel(entitlement)],
          [webT("buyer.releaseLabel"), entitlement.release_label || entitlement.release?.label || entitlement.release_id || webT("buyer.pinnedPurchaseRelease")],
          [webT("buyer.purchasedVersion"), entitlement.purchased_corpus_digest || entitlement.corpus_digest || "—"],
          [webT("buyer.effectiveVersion"), entitlement.effective_corpus_digest || entitlement.purchased_corpus_digest || entitlement.corpus_digest || "—"],
          [webT("buyer.versionPolicy"), versionPolicyLabel(entitlement.version_policy)],
          [webT("buyer.validFrom"), dateTime(entitlement.valid_from || entitlement.granted_at || entitlement.created_at)],
          [webT("buyer.expires"), entitlement.expires_at ? dateTime(entitlement.expires_at) : webT("common.noScheduledExpiry")],
          [webT("buyer.refundCancellation"), reversalStatus ? sentenceCase(reversalStatus) : (status === "revoked" ? webT("buyer.accessRevoked") : null)],
          [webT("buyer.supportReferenceLabel"), entitlement.entitlement_id || entitlement.id]
        ]} />{orderId ? <RouterLink className="buyer-v2__text-link" to={`${ORDERS_ROOT}/${encodeURIComponent(orderId)}`} navigate={navigate}>{webT("buyer.originatingOrder")}</RouterLink> : null}</section>
        <aside className="buyer-v2__activation-card"><span className="buyer-v2__eyebrow">{webT("buyer.desktopActivation")}</span><h2>{canOpen ? webT("buyer.continueWorkspace") : entitlementRecoveryTitle(status)}</h2><p>{entitlementRecoveryCopy(status)}</p>{canOpen ? <Button asChild><a href={desktopUrl(entitlement, product)} onClick={() => trackPortalEvent(request, "desktop_open_clicked", productTelemetry(product))}>{webT("buyer.openDesktop")}</a></Button> : null}<a className="buyer-v2__secondary-download" href={downloadUrl} target="_blank" rel="noreferrer" onClick={() => trackPortalEvent(request, "desktop_download_clicked", productTelemetry(product))}>{webT("buyer.downloadDesktop")}</a></aside>
      </div>
      <section className="buyer-v2__timeline-section"><div><span className="buyer-v2__eyebrow">{webT("buyer.accessHistory")}</span><h2>{webT("buyer.activityPrivate")}</h2><p>{webT("buyer.activityBody")}</p></div>{deliveries.length ? <Timeline entries={deliveries.map(deliveryTimelineEntry)} /> : <EmptyState compact title={webT("buyer.permanentAccess")} body={webT("buyer.permanentAccessReady")} />}</section>
    </div>
  );
}

function OrdersPage({ search, request, navigate, session }) {
  const params = new URLSearchParams(search);
  const filter = params.get("status") || "all";
  const resource = useCursorCollection(async (cursor, signal) => {
    const query = new URLSearchParams();
    if (filter !== "all") query.set("status", filter);
    if (cursor) query.set("cursor", cursor);
    const response = await callRequest(request, `${BUYER_PORTAL_V2_ENDPOINTS.orders}?${query}`, { signal });
    return pageFrom(response, ["orders", "items"]);
  }, `orders:${filter}`);
  usePageTitle(webT("buyer.yourOrders"));
  useUnauthorized(resource.error, session);

  return (
    <div className="buyer-v2__container buyer-v2__page">
      <header className="buyer-v2__page-heading"><span className="buyer-v2__eyebrow">{webT("buyer.orderHistory")}</span><h1>{webT("buyer.completeReceipts")}</h1><p>{webT("buyer.receiptsBody")}</p></header>
      <label className="buyer-v2__select-label">{webT("buyer.orderStatus")}<Select label={webT("buyer.orderStatus")} value={filter} onValueChange={(value) => navigateTo(navigate, value === "all" ? ORDERS_ROOT : `${ORDERS_ROOT}?status=${encodeURIComponent(value)}`)} options={[{ value: "all", label: webT("buyer.allOrders") }, { value: "fulfilled", label: webT("buyer.fulfilled") }, { value: "pending", label: webT("buyer.pending") }, { value: "refunded", label: webT("buyer.refunded") }]} /></label>
      {resource.status === "loading" ? <ListSkeleton label={webT("buyer.loadingOrders")} /> : null}
      {resource.status === "error" ? <RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo={ORDERS_ROOT} /> : null}
      {resource.status === "ready" && resource.items.length ? <section className="buyer-v2__order-list" aria-label={webT("buyer.ordersLabel")}>{resource.items.map((order) => <OrderRow key={orderIdFor(order)} order={order} navigate={navigate} />)}</section> : null}
      {resource.status === "ready" && !resource.items.length ? <EmptyState title={webT("buyer.noOrdersView")} body={webT("buyer.noOrdersViewBody")} action={<LinkButton to={EXPLORE_ROOT} navigate={navigate}>{webT("buyer.exploreProducts")}</LinkButton>} /> : null}
      {resource.nextCursor ? <LoadMore resource={resource} /> : null}
    </div>
  );
}

function OrderRow({ order, navigate }) {
  const id = orderIdFor(order);
  const product = order.product_snapshot || order.product || order;
  return (
    <article className="buyer-v2__order-row">
      <div><span>{dateTime(order.created_at || order.occurred_at, true)}</span><h2>{productName(product)}</h2><small>#{orderReference(order)}</small></div>
      <div className="buyer-v2__order-row-status"><strong>{orderAmount(order) === 0 ? webT("common.free") : money(orderAmount(order), order.currency)}</strong><StatusChip status={orderStatus(order)} label={orderStatusLabel(order)} /></div>
      <LinkButton variant="secondary" to={`/orders/${encodeURIComponent(orderReference(order))}`} navigate={navigate}>{webT("buyer.viewOrderLink")}</LinkButton>
    </article>
  );
}

function OrderPage({ id, request, navigate, session }) {
  const endpoint = `${BUYER_PORTAL_V2_ENDPOINTS.orders}/${encodeURIComponent(id)}`;
  const resource = useRemote(async (signal) => unwrap(await callRequest(request, endpoint, { signal }), ["order"]), endpoint);
  const [refundState, setRefundState] = useState({ status: "idle", error: null });
  const refundIntentKey = useRef(requestId());
  usePageTitle(resource.data ? `${productName(resource.data.product_snapshot || resource.data.product || resource.data)} · ${webT("buyer.orderDetails")}` : webT("buyer.orderDetails"));
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
  if (resource.status === "error") return <div className="buyer-v2__container buyer-v2__page"><RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo={`${ORDERS_ROOT}/${id}`} /></div>;
  const order = resource.data;
  const product = order.product_snapshot || order.product || order;
  const entitlementId = order.entitlement_id || order.entitlement?.entitlement_id || order.entitlement?.id;
  const entries = orderTimeline(order);
  const canRefund = Boolean(order.actions?.can_request_refund || order.can_request_refund);
  const canCancelAccess = order.access_mode !== "unmetered"
    && Boolean(order.actions?.can_cancel_access || order.can_cancel_access);
  const canReverseOrder = canRefund || canCancelAccess;
  const reversalLabel = canCancelAccess ? webT("buyer.cancelPurchase") : webT("buyer.requestRefund");
  const reversalSuccess = canCancelAccess ? webT("buyer.purchaseCancelled") : webT("buyer.refundRequested");
  const totalMinor = orderAmount(order);
  const subtotalMinor = numberOr(order.subtotal_minor, totalMinor);
  const discountMinor = numberOr(order.discount_minor, 0);
  const taxLabel = order.tax_minor == null ? webT("buyer.notCalculated") : money(numberOr(order.tax_minor, 0), order.currency);

  return (
    <div className="buyer-v2__container buyer-v2__page">
      <RouterLink className="buyer-v2__back-link" to={ORDERS_ROOT} navigate={navigate}>{webT("buyer.backOrders")}</RouterLink>
      <header className="buyer-v2__detail-heading"><div><span className="buyer-v2__eyebrow">{webT("common.order")} #{orderReference(order)}</span><h1>{productName(product)}</h1><p>{webT("buyer.created")} {dateTime(order.created_at || order.occurred_at)}</p></div><StatusChip status={orderStatus(order)} label={orderStatusLabel(order)} /></header>
      <div className="buyer-v2__detail-grid">
        <section className="buyer-v2__detail-card"><h2>{webT("buyer.receiptLabel")}</h2><DefinitionList rows={[
          [webT("buyer.creatorLabel"), creatorName(order.creator || product)],
          [webT("buyer.subtotal"), subtotalMinor === 0 ? webT("common.free") : money(subtotalMinor, order.currency)],
          [webT("buyer.discount"), discountMinor === 0 ? money(0, order.currency) : `−${money(discountMinor, order.currency)}`],
          [webT("buyer.tax"), taxLabel],
          [webT("buyer.total"), totalMinor === 0 ? webT("common.free") : money(totalMinor, order.currency)],
          [webT("buyer.paymentLabel"), paymentStatusLabel(order.payment_status || order.payment?.status, totalMinor)],
          [webT("buyer.accessLabel"), entitlementStatusLabel(accessStatus(order.entitlement || { status: order.entitlement_status }))],
          [webT("buyer.releaseLabel"), order.release_snapshot?.label || order.release_snapshot?.release_id || order.release_label || order.release_id || webT("buyer.purchaseTimeRelease")]
        ]} />{entitlementId ? <RouterLink className="buyer-v2__text-link" to={`${LIBRARY_ROOT}/${encodeURIComponent(entitlementId)}`} navigate={navigate}>{webT("buyer.viewAccessDetailsArrow")}</RouterLink> : null}</section>
        <aside className="buyer-v2__order-actions"><span className="buyer-v2__eyebrow">{webT("buyer.orderActions")}</span><h2>{orderActionTitle(order)}</h2><p>{orderActionCopy(order)}</p>{successReady(order, order.entitlement) ? <LinkButton to={`/orders/${encodeURIComponent(orderReference(order))}/success`} navigate={navigate}>{webT("buyer.openActivationSteps")}</LinkButton> : null}{canReverseOrder ? <Button variant="secondary" type="button" loading={refundState.status === "pending"} onClick={requestRefund}>{reversalLabel}</Button> : null}{refundState.error ? <InlineError error={refundState.error} /> : null}{refundState.status === "succeeded" ? <div className="buyer-v2__inline-notice" role="status">{reversalSuccess}</div> : null}</aside>
      </div>
      <section className="buyer-v2__timeline-section"><div><span className="buyer-v2__eyebrow">{webT("buyer.accessHistory")}</span><h2>{webT("buyer.whatHappened")}</h2></div><Timeline entries={entries} /></section>
    </div>
  );
}

function NotFoundPage({ navigate }) {
  usePageTitle(webT("buyer.pageNotFound"));
  return <div className="buyer-v2__container buyer-v2__page"><StatePanel eyebrow="404" title={webT("buyer.pageNotAvailable")} body={webT("buyer.pageNotAvailableBody")}><LinkButton to={EXPLORE_ROOT} navigate={navigate}>{webT("buyer.exploreProducts")}</LinkButton></StatePanel></div>;
}

function RedirectPage({ to, navigate }) {
  useEffect(() => navigateTo(navigate, to, { replace: true }), [navigate, to]);
  return <main className="buyer-v2 buyer-v2__redirect" aria-live="polite"><p>{webT("buyer.takingToSignIn")}</p><RouterLink to={to} navigate={navigate}>{webT("buyer.continueToSignIn")}</RouterLink></main>;
}

function InfoSection({ eyebrow, title, items, className = "buyer-v2__info-card" }) {
  return <article className={className}><span className="buyer-v2__eyebrow">{eyebrow}</span><h2>{title}</h2><ul>{items.map((item, index) => <li key={`${index}:${textValue(item)}`}>{textValue(item)}</li>)}</ul></article>;
}

function Field({ label, children }) {
  return <label className="buyer-v2__field"><span>{label}</span>{children}</label>;
}

function DefinitionList({ rows }) {
  return <dl className="buyer-v2__definition-list">{rows.filter(([, value]) => value !== undefined && value !== null && value !== "").map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}</dl>;
}

function CreatorIdentity({ value }) {
  const name = creatorName(value);
  return <span className="buyer-v2__creator-identity"><Avatar className="buyer-v2__creator-avatar" size="medium" src={creatorAvatarUrl(value)} name={name} /><span>{name}</span></span>;
}

function PriceRow({ label, value, total = false }) {
  return <div className={`buyer-v2__price-row${total ? " buyer-v2__price-row--total" : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}

function Timeline({ entries }) {
  return <ol className="buyer-v2__timeline">{entries.map((entry, index) => <li key={entry.id || `${entry.label}:${index}`} className={entry.tone ? `is-${entry.tone}` : ""}><span aria-hidden="true" /><div><strong>{entry.label}</strong>{entry.detail ? <p>{entry.detail}</p> : null}{entry.time ? <time>{dateTime(entry.time)}</time> : null}</div></li>)}</ol>;
}

function StatePanel({ eyebrow, title, body, tone = "neutral", children }) {
  const statusTone = tone === "error" ? "error" : tone === "warning" ? "warning" : "neutral";
  return <Surface level="solid" className={`buyer-v2__state-panel buyer-v2__state-panel--${tone}`}>{eyebrow ? <StatusTag tone={statusTone}>{eyebrow}</StatusTag> : null}<h1>{title}</h1><p>{body}</p><div className="buyer-v2__state-actions">{children}</div></Surface>;
}

function EmptyState({ title, body, action, compact = false }) {
  return <HatchEmptyState className={`buyer-v2__empty${compact ? " buyer-v2__empty--compact" : ""}`} title={title} body={body} action={action} />;
}

function RouteError({ error, onRetry, navigate, returnTo }) {
  const status = error?.status;
  if (status === 401) return <StatePanel tone="error" eyebrow={webT("buyer.session")} title={webT("buyer.signInContinue")} body={webT("buyer.signInSafeBody")}><LinkButton to={`/sign-in?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`} navigate={navigate}>{webT("common.signIn")}</LinkButton></StatePanel>;
  if (status === 403) return <StatePanel tone="error" eyebrow={webT("errors.accessDenied")} title={webT("errors.accessDenied")} body={webT("buyer.returnAvailableBody")}><LinkButton to={EXPLORE_ROOT} navigate={navigate}>{webT("buyer.exploreProducts")}</LinkButton></StatePanel>;
  if (status === 404) return <StatePanel tone="error" eyebrow={webT("errors.notFound")} title={webT("errors.notFound")} body={webT("buyer.previousReceiptBody")}><LinkButton to={ORDERS_ROOT} navigate={navigate}>{webT("buyer.viewOrders")}</LinkButton></StatePanel>;
  if (status === 409) return <StatePanel tone="error" eyebrow={webT("errors.detailsChanged")} title={webT("errors.detailsChanged")} body={friendlyError(error)}><Button type="button" onClick={onRetry}>{webT("buyer.refreshDetails")}</Button></StatePanel>;
  return <StatePanel tone="error" title={webT("buyer.taskStillHere")} body={friendlyError(error)}><Button type="button" onClick={onRetry}>{webT("common.tryAgain")}</Button></StatePanel>;
}

function InlineError({ error }) {
  return <div className="buyer-v2__inline-error" role="alert">{friendlyError(error)}</div>;
}

function StatusChip({ status, label }) {
  return <StatusTag tone={statusTone(status)}>{label}</StatusTag>;
}

function CardSkeleton({ count, label }) {
  return <div className="buyer-v2__catalog-grid" aria-busy="true" aria-label={label}>{Array.from({ length: count }, (_, index) => <div className="buyer-v2__skeleton-card" key={index}><i /><i /><i /><i /></div>)}</div>;
}

function ListSkeleton({ label }) {
  return <div className="buyer-v2__list-skeleton" aria-busy="true" aria-label={label}>{Array.from({ length: 3 }, (_, index) => <i key={index} />)}</div>;
}

function DetailSkeleton() {
  return <div className="buyer-v2__detail-skeleton" aria-busy="true" aria-label={webT("common.loadingDetails")}><i /><i /><i /><i /></div>;
}

function PageSkeleton({ label }) {
  return <div className="buyer-v2__page-skeleton" aria-busy="true" aria-label={label}><span className="buyer-v2__spinner" aria-hidden="true" /><p>{label}…</p></div>;
}

function LoadMore({ resource }) {
  return <div className="buyer-v2__load-more">{resource.moreError ? <InlineError error={resource.moreError} /> : null}<Button variant="secondary" type="button" loading={resource.loadingMore} onClick={resource.loadMore}>{webT("buyer.loadMore")}</Button></div>;
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
  const candidate = canonicalWebPath(String(value || ""));
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\") || /[\u0000-\u001f]/.test(candidate)) return EXPLORE_ROOT;
  const pathname = candidate.split("?")[0].split("#")[0];
  const allowed = pathname === "/"
    || pathname === EXPLORE_ROOT
    || pathname.startsWith("/creators/")
    || pathname.startsWith("/products/")
    || pathname.startsWith("/library")
    || pathname.startsWith("/orders")
    || pathname.startsWith("/checkout/")
    || pathname === "/studio"
    || pathname.startsWith("/studio/")
    || pathname === ACCOUNT_ROOT
    || pathname.startsWith("/account/");
  return allowed ? candidate : EXPLORE_ROOT;
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

function productId(value) { return value?.product_id || value?.product?.id || value?.product?.product_id || value?.id; }
function productName(value) { return value?.product_name || value?.name || value?.product?.name || webT("buyer.creatorAgentFallback"); }
function productPromise(value) { return value?.promise || value?.product_description || value?.description || value?.product?.promise || value?.product?.description || webT("buyer.productPromiseFallback"); }
function creatorName(value) { return value?.creator_name || value?.creator_display_name || value?.display_name || value?.name || value?.creator?.display_name || value?.creator?.name || value?.creator?.handle || webT("buyer.hatchCreatorFallback"); }
function creatorAvatarUrl(value) { return value?.creator_avatar_url || value?.avatar_url || value?.image_url || value?.creator?.avatar_url || value?.creator?.image_url; }
function creatorId(value) { return value?.creator_id || value?.creator?.id || ""; }
function entitlementIdFor(value) { return value?.entitlement_id || value?.id || ""; }
function orderIdFor(value) { return value?.order_id || value?.id; }

function productPath(value) {
  const product = productId(value);
  return product ? `/products/${encodeURIComponent(product)}` : EXPLORE_ROOT;
}

function libraryPathFor(product, entitlement) {
  const id = entitlement?.entitlement_id || entitlement?.id;
  return id ? `/library/${encodeURIComponent(id)}` : LIBRARY_ROOT;
}

function productKey(value) { return productId(value) || "product"; }

function money(minor, _currency = "USD") { return formatUsd(minor); }

function accessStatus(value) {
  const status = value?.status || value?.entitlement_status || "none";
  if (["granted", "available"].includes(status)) return "active";
  if (["fulfillment_pending", "provisioning"].includes(status)) return "pending";
  return status;
}

function entitlementStatusLabel(status) {
  const key = ({ active: "available", reserved: "inProgress", pending: "settingUpStatus", consumed: "used", expired: "expired", suspended: "paused", revoked: "accessEnded", none: "noAccess" })[status];
  return key ? webT(`buyer.${key}`) : sentenceCase(status);
}

function entitlementSummary(value) {
  const status = accessStatus(value);
  if (value?.access_mode === "unmetered") return value.summary || webT("buyer.permanentAccessSummary");
  if (status === "reserved") return webT("buyer.accessSetupInProgress");
  if (status === "consumed") return webT("buyer.accessUsed");
  if (status === "expired") return `${webT("buyer.accessExpired")} ${webT("buyer.returnPublicProduct")}`;
  if (["suspended", "revoked"].includes(status)) return value.status_reason_label || webT("buyer.accessUnavailable");
  return value.summary || webT("buyer.openDesktopWorkspace");
}

function unitsLabel(value) {
  if (value?.access_mode === "unmetered" || value?.unlimited === true) return webT("buyer.permanentAccess");
  if (value.remaining_units == null && value.units_remaining == null) return webT("buyer.accessDetails");
  const units = Number(value.remaining_units ?? value.units_remaining);
  return webT("buyer.accessUsesAvailable", units);
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
  const key = ({ fulfilled: "accessGranted", pending: "pending", payment_pending: "paymentPending", refund_pending: "refunded", refunded: "refunded", cancelled: "cancelled", failed: "failed" })[status];
  return key ? webT(`buyer.${key}`) : sentenceCase(status);
}

function paymentStatusLabel(status, amount) {
  if (Number(amount) === 0 || status === "not_required") return webT("buyer.paymentNotRequired");
  const key = ({ succeeded: "succeeded", paid: "succeeded", pending: "pending", processing: "settingUpStatus", failed: "failed", requires_action: "actionRequired", refunded: "refunded" })[status];
  return key ? webT(`buyer.${key}`) : sentenceCase(status || "pending");
}

function successReady(order, entitlement) {
  const status = accessStatus(entitlement || { status: order?.entitlement_status });
  return ["active", "reserved"].includes(status) && !paymentFailed(order);
}

function paymentFailed(order) {
  return ["failed", "declined", "cancelled"].includes(order?.payment_status || order?.payment?.status) || orderStatus(order) === "failed";
}

function orderActionTitle(order) {
  if (orderStatus(order) === "cancelled") return webT("buyer.purchaseCancelled");
  if (orderStatus(order) === "refunded") return webT("buyer.refundRequested");
  if (paymentFailed(order)) return webT("buyer.paymentNotCompleted");
  if (successReady(order, order.entitlement)) return webT("buyer.agentReady");
  return webT("buyer.settingUpAccess");
}

function orderActionCopy(order) {
  if (orderStatus(order) === "cancelled") return webT("buyer.receiptAvailable");
  if (orderStatus(order) === "refunded") return webT("buyer.receiptAvailable");
  if (paymentFailed(order)) return webT("buyer.noAccessGrantedBody");
  if (successReady(order, order.entitlement)) return webT("buyer.openActivationSteps");
  return webT("buyer.refreshDetails");
}

function orderTimeline(order) {
  if (Array.isArray(order.timeline) && order.timeline.length) return order.timeline.map((entry) => ({ id: entry.id || entry.event_id, label: entry.label || sentenceCase(entry.type || entry.event_type), detail: entry.detail || entry.summary, time: entry.occurred_at || entry.created_at, tone: entry.status === "failed" ? "error" : "" }));
  const entries = [{ label: `${webT("common.order")} ${webT("buyer.created").toLowerCase()}`, time: order.created_at || order.occurred_at }];
  const paymentStatus = order.payment_status || order.payment?.status;
  if (orderAmount(order) === 0 || paymentStatus === "not_required") entries.push({ label: `${webT("buyer.paymentLabel")} ${webT("buyer.paymentNotRequired").toLowerCase()}`, time: order.payment?.updated_at || order.created_at });
  else if (["succeeded", "paid"].includes(paymentStatus)) entries.push({ label: `${webT("buyer.paymentLabel")} ${webT("buyer.paymentSucceeded").toLowerCase()}`, time: order.payment?.succeeded_at || order.paid_at });
  else if (paymentStatus) entries.push({ label: `${webT("buyer.paymentLabel")} ${sentenceCase(paymentStatus)}`, time: order.payment?.updated_at, tone: paymentFailed(order) ? "error" : "" });
  if (order.entitlement_id || order.entitlement) entries.push({ label: webT("common.accessGranted"), time: order.entitlement?.granted_at || order.fulfilled_at });
  for (const delivery of arrayValue(order.deliveries, [])) entries.push(deliveryTimelineEntry(delivery));
  const refundStatus = meaningfulReversalStatus(order.refund?.status, order.refund_status, orderStatus(order) === "refunded" ? "refunded" : null);
  if (refundStatus) entries.push({ label: `${webT("buyer.refunded")} ${sentenceCase(refundStatus)}`, time: order.refund?.updated_at || order.refunded_at });
  return entries;
}

function deliveryTimelineEntry(delivery) {
  const status = delivery.status || delivery.delivery_status || "completed";
  return { id: delivery.delivery_id || delivery.id, label: webT("buyer.activity", sentenceCase(status)), detail: delivery.artifact_type ? webT("buyer.artifactType", sentenceCase(delivery.artifact_type)) : delivery.summary, time: delivery.completed_at || delivery.started_at || delivery.created_at, tone: status === "failed" ? "error" : "" };
}

function versionPolicyLabel(value) {
  if (!value || value === "pinned") return webT("buyer.pinnedPurchaseRelease");
  if (value === "compatible_tracking") return webT("buyer.versionPolicy");
  return sentenceCase(value);
}

function entitlementRecoveryTitle(status) {
  if (status === "consumed") return webT("buyer.accessUsed");
  if (status === "expired") return webT("buyer.accessExpired");
  if (status === "pending") return webT("buyer.accessStillPreparing");
  return webT("buyer.desktopActivationUnavailable");
}

function entitlementRecoveryCopy(status) {
  if (["consumed", "expired"].includes(status)) return webT("buyer.returnPublicProduct");
  if (status === "pending") return webT("buyer.keepReceipt");
  return webT("buyer.reviewOriginatingOrder");
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

function textValue(value) { return typeof value === "string" ? value : value?.label || value?.summary || value?.description || webT("buyer.productDetail"); }

function dateTime(value, dateOnly = false) { return formatWebDate(value, getWebLocale(), dateOnly); }

function initialsFor(user) {
  if (user?.initials) return user.initials;
  const value = user?.display_name || user?.name || user?.email || "Account";
  return value.split(/\s+|@/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "A";
}

function friendlyError(error) { return webErrorMessage(error, getWebLocale()); }

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
  return localizeWebIdentifier(value, getWebLocale());
}

function cssToken(value) { return String(value || "unknown").toLowerCase().replace(/[^a-z0-9-]/g, "-"); }
