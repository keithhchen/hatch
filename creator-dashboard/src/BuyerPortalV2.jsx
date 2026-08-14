import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox as HatchCheckbox,
  EmptyState as HatchEmptyState,
  HatchBrand,
  InlineAlert as HatchInlineAlert,
  Input,
  PageHeader,
  Select,
  StatusTag,
  Surface
} from "@hatch/ui";
import { CheckoutSummary } from "@hatch/ui/product";
import { StorefrontDetails } from "./StorefrontDetails.jsx";
import { creatorPublicModel } from "./storefrontModel.js";
import "./buyerPortalV2.css";

const DEFAULT_DOWNLOAD_URL = "https://github.com/keithhchen/hatch/releases/latest";
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
  const location = splitLocation(pathname, search);
  const route = useMemo(() => matchBuyerRoute(location.pathname), [location.pathname]);
  useRouteHeadingFocus(location.pathname, location.search);
  const go = (to, options) => navigateTo(navigate, to, options);
  const returnTo = `${location.pathname}${location.search}`;

  if (!PUBLIC_ROUTE_NAMES.has(route.name) && session.status === "loading") {
    return <BuyerShell route={route} navigate={navigate} session={session} downloadUrl={downloadUrl}><PageSkeleton label="Opening your account" /></BuyerShell>;
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
      <a className="buyer-v2__skip" href="#buyer-main">Skip to content</a>
      <header className="buyer-v2__header">
        <div className="buyer-v2__header-inner">
          <HatchBrand as={RouterLink} className="buyer-v2__brand" to={EXPLORE_ROOT} navigate={navigate} aria-label="Hatch home" />
          <nav className="buyer-v2__nav" aria-label="Buyer navigation">
            <RouterLink to={EXPLORE_ROOT} navigate={navigate} aria-current={active === "explore" ? "page" : undefined}>Explore</RouterLink>
            {authenticated ? <RouterLink to={LIBRARY_ROOT} navigate={navigate} aria-current={active === "library" ? "page" : undefined}>Library</RouterLink> : null}
            {authenticated ? <RouterLink to={ORDERS_ROOT} navigate={navigate} aria-current={active === "orders" ? "page" : undefined}>Orders</RouterLink> : null}
          </nav>
          <div className="buyer-v2__account">
            <a className="buyer-v2__download-quiet" href={downloadUrl} target="_blank" rel="noreferrer">Download</a>
            {authenticated ? (
              <>
                <RouterLink className="buyer-v2__avatar" to={ACCOUNT_ROOT} navigate={navigate} aria-label="Account settings" aria-current={active === "settings" ? "page" : undefined}>{initialsFor(session.user)}</RouterLink>
                <Button type="button" variant="ghost" size="small" disabled={signingOut} onClick={signOut}>{signingOut ? "Signing out…" : "Sign out"}</Button>
              </>
            ) : (
              <LinkButton variant="secondary" size="small" to={`/sign-in?returnTo=${encodeURIComponent(EXPLORE_ROOT)}`} navigate={navigate}>Sign in</LinkButton>
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
  usePageTitle("Products");
  const resource = useRemote(async (signal) => {
    const response = await callRequest(request, BUYER_PORTAL_V2_ENDPOINTS.catalog, { signal });
    return collectionFrom(response, ["agents", "items"]);
  }, "catalog");

  return (
    <div className="buyer-v2__container buyer-v2__page">
      <PageHeader className="buyer-v2__page-heading buyer-v2__catalog-heading" title="Methods you can put to work." body="Understand the promise and boundaries first. Add a Product to your account only when it fits the job." />
      {resource.status === "loading" ? <CardSkeleton count={3} label="Loading products" /> : null}
      {resource.status === "error" ? <RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo={EXPLORE_ROOT} /> : null}
      {resource.status === "ready" && resource.data.length ? (
        <section className="buyer-v2__catalog-grid" aria-label="Available products">
          {resource.data.map((product) => <CatalogCard key={productKey(product)} product={product} navigate={navigate} authenticated={session.status === "authenticated"} />)}
        </section>
      ) : null}
      {resource.status === "ready" && resource.data.length === 0 ? (
        <EmptyState title="No products are public yet" body="Published products will appear here. Try again later." />
      ) : null}
    </div>
  );
}

function CreatorPublicPage({ creatorId, request, navigate, session }) {
  const endpoint = `/v1/public/creators/${encodeURIComponent(creatorId)}`;
  const resource = useRemote(async (signal) => callRequest(request, endpoint, { signal }), endpoint);
  const publicModel = creatorPublicModel(resource.data);
  usePageTitle(publicModel.creator?.name ? `${publicModel.creator.name} · Hatch` : "Creator · Hatch");
  if (resource.status === "loading") return <div className="buyer-v2__container buyer-v2__page"><PageSkeleton label="Loading creator" /></div>;
  if (resource.status === "error") return <div className="buyer-v2__container buyer-v2__page"><RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo={`/creators/${encodeURIComponent(creatorId)}`} /></div>;
  const creator = publicModel.creator;
  const products = publicModel.products;
  return (
    <div className="buyer-v2__container buyer-v2__page">
      <RouterLink className="buyer-v2__back-link" to={EXPLORE_ROOT} navigate={navigate}>← Explore</RouterLink>
      <header className="buyer-v2__page-heading">
        <span className="buyer-v2__eyebrow">Creator</span>
        <h1>{creator?.name ?? creator?.display_name ?? creatorId}</h1>
        <p>{creator?.bio ?? creator?.description ?? "Published methods for work in your own Workspace."}</p>
      </header>
      {products.length ? <section className="buyer-v2__catalog-grid" aria-label={`${creator?.name ?? creatorId} products`}>{products.map((product) => <CatalogCard key={productKey(product)} product={product} navigate={navigate} authenticated={session.status === "authenticated"} />)}</section> : <EmptyState title="No public products yet" body="This Creator has not published a product that can be browsed." action={<LinkButton to={EXPLORE_ROOT} navigate={navigate}>Explore all products</LinkButton>} />}
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
        {product.creator_verified || product.creator?.verified ? <span className="buyer-v2__verified">Verified</span> : null}
      </div>
      <h2>{productName(product)}</h2>
      <p>{productPromise(product)}</p>
      <div className="buyer-v2__card-footer">
        <div><strong>{accessStatus(access) === "active" ? "In your library" : product.availability === "published" ? "Free" : "Unavailable"}</strong><span>{product.availability === "published" ? "Permanent access" : "Not available"}</span></div>
        <LinkButton variant="secondary" to={path} navigate={navigate}>View details</LinkButton>
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
  usePageTitle(product ? productName(product) : "Agent details");

  if (resource.status === "loading") return <div className="buyer-v2__container buyer-v2__page"><DetailSkeleton /></div>;
  if (resource.status === "error") return <div className="buyer-v2__container buyer-v2__page"><RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo={path} /></div>;

  const examples = arrayValue(product.examples || product.proof, []);
  const desktopRequirement = product.desktop_requirement || "macOS app and a Hatch account. You select the Workspace before the Agent can work with local files.";
  const productCreatorId = product?.creator_id ?? product?.creator?.id;
  const productCreatorName = creatorName(product);
  const productCreatorByline = productCreatorId
    ? <RouterLink className="storefront-shared__creator-link" to={`/creators/${encodeURIComponent(productCreatorId)}`} navigate={navigate}>{productCreatorName}</RouterLink>
    : productCreatorName;

  return (
    <div className="buyer-v2__container buyer-v2__page">
      <RouterLink className="buyer-v2__back-link" to={EXPLORE_ROOT} navigate={navigate}>← Explore</RouterLink>
      <StorefrontDetails
        product={product}
        creatorName={productCreatorByline}
        desktopRequirement={desktopRequirement}
        releaseLabel={product.release_label || product.release?.label}
        action={<ProductAction embedded product={product} currentPath={path} request={request} navigate={navigate} session={session} downloadUrl={downloadUrl} />}
      />

      <section className="buyer-v2__wide-section">
        <span className="buyer-v2__eyebrow">How it works</span>
        <h2>From access to useful work.</h2>
        <ol className="buyer-v2__steps">
          <li><span>1</span><div><strong>Add the Agent</strong><p>Confirm permanent access for this Product.</p></div></li>
          <li><span>2</span><div><strong>Open Hatch Desktop</strong><p>Sign in with the same account and choose a local Workspace.</p></div></li>
          <li><span>3</span><div><strong>Work with the Agent</strong><p>Use the method as often as you need in your own Workspace.</p></div></li>
        </ol>
      </section>

      {examples.length ? <InfoSection className="buyer-v2__wide-section" eyebrow="Representative examples" title="Evidence, without exposing protected instructions." items={examples} /> : null}
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

  let title = "Add this Agent to your account.";
  let body = "No payment is required. Your access and receipt are still recorded.";
  let action = null;

  if (isOwnerCreator) {
    title = "This is your published storefront.";
    body = "Buyers see the same Product promise and boundaries shown here.";
    action = <LinkButton variant="secondary" to={`/studio/products/${encodeURIComponent(productId(product))}`} navigate={navigate}>Manage product</LinkButton>;
  } else if (status === "active" || status === "reserved") {
    title = status === "reserved" ? "Access setup is in progress." : "This Agent is ready.";
    body = status === "reserved" ? "Return to Hatch Desktop to continue safely." : "Open Hatch Desktop with this account, then choose a Workspace.";
    action = <><LinkButton to={libraryPathFor(product, access)} navigate={navigate}>View in Library</LinkButton><Button asChild variant="secondary"><a href={desktopUrl(access, product)} onClick={() => trackPortalEvent(request, "desktop_open_clicked", productTelemetry(product))}>Open Hatch Desktop</a></Button></>;
  } else if (status === "pending") {
    title = "Setting up your access…";
    body = "Your order is confirmed. Access will appear as soon as fulfillment finishes.";
    action = <Button type="button" loading>Setting up access</Button>;
  } else if (!purchasable) {
    title = "This Product is unavailable.";
    body = "The Creator has withdrawn this Product. Existing receipts remain available.";
  } else if (isAnonymous) {
    const authPath = `/sign-in?returnTo=${encodeURIComponent(currentPath)}`;
    action = <LinkButton to={authPath} navigate={navigate}>Get access</LinkButton>;
  } else {
    action = <Button type="button" loading={mutation.status === "pending"} onClick={startCheckout}>Get access</Button>;
  }

  const contents = (
    <>
      <h2>{title}</h2>
      <p>{body}</p>
      {mutation.error ? <InlineError error={mutation.error} /> : null}
      {action}
      <a className="buyer-v2__secondary-download" href={downloadUrl} target="_blank" rel="noreferrer" onClick={() => trackPortalEvent(request, "desktop_download_clicked", productTelemetry(product))}>Download Desktop</a>
    </>
  );
  if (embedded) return <div className="buyer-v2__storefront-action">{contents}</div>;
  return (
    <aside className="buyer-v2__action-card" aria-label="Product access">
      <span className="buyer-v2__eyebrow">Access</span>
      <div className="buyer-v2__price"><strong>Free</strong><span>Permanent access</span></div>
      {contents}
    </aside>
  );
}

function SettingsPage({ session, navigate }) {
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  usePageTitle("Account settings");
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
    <header className="buyer-v2__page-heading"><span className="buyer-v2__eyebrow">Account</span><h1>Settings and session.</h1><p>Use the same Hatch account on Web and Desktop. Signing out here does not delete your orders or receipts.</p></header>
    <section className="buyer-v2__detail-card">
      <dl className="buyer-v2__detail-list">
        <div><dt>Name</dt><dd>{session.user?.display_name || "Hatch account"}</dd></div>
        <div><dt>Role</dt><dd>{session.user?.role || "user"}</dd></div>
        <div><dt>Session</dt><dd>Signed in</dd></div>
      </dl>
      {error ? <InlineError error={error} /> : null}
      <div className="buyer-v2__detail-links"><Button type="button" variant="secondary" loading={status === "pending"} onClick={signOut}>Sign out</Button><RouterLink to="/account/help" navigate={navigate}>Account help</RouterLink></div>
    </section>
  </div>;
}

function AccountHelpPage({ session, navigate }) {
  usePageTitle("Account help");
  return <div className="buyer-v2__container buyer-v2__page">
    <header className="buyer-v2__page-heading"><span className="buyer-v2__eyebrow">Account help</span><h1>Get back to the right account.</h1><p>Orders and Agent access belong to the account that confirmed checkout. Use that same account in Hatch Desktop.</p></header>
    <section className="buyer-v2__decision-grid">
      <article className="buyer-v2__info-card"><span className="buyer-v2__eyebrow">Session</span><h2>{session.status === "authenticated" ? "You are signed in." : "Sign in to continue."}</h2><p>If a receipt or Product access is missing, confirm that Web and Desktop use the same account.</p>{session.status === "authenticated" ? <LinkButton variant="secondary" to={ACCOUNT_ROOT} navigate={navigate}>View settings</LinkButton> : <LinkButton to="/sign-in?returnTo=%2Faccount%2Fhelp" navigate={navigate}>Sign in</LinkButton>}</article>
      <article className="buyer-v2__info-card"><span className="buyer-v2__eyebrow">Purchase support</span><h2>Keep the support reference.</h2><p>Open the order or entitlement detail and include its support reference when reporting a payment, refund, or access problem.</p><LinkButton variant="secondary" to={session.status === "authenticated" ? ORDERS_ROOT : EXPLORE_ROOT} navigate={navigate}>{session.status === "authenticated" ? "View orders" : "Explore products"}</LinkButton></article>
    </section>
  </div>;
}

function SubscriptionsPage({ navigate }) {
  usePageTitle("Subscriptions");
  return <div className="buyer-v2__container buyer-v2__page"><StatePanel eyebrow="Subscriptions" title="No subscription products are enabled." body="Every published Product currently grants permanent access at no charge. Paid access and subscriptions are not available."><LinkButton to={EXPLORE_ROOT} navigate={navigate}>Explore products</LinkButton></StatePanel></div>;
}

function AuthPage({ mode, search, request, navigate, session }) {
  const signingUp = mode === "sign-up";
  const params = new URLSearchParams(search);
  const returnTo = safeReturnTo(params.get("returnTo") || LIBRARY_ROOT);
  const intentRoute = matchBuyerRoute(returnTo.split("?")[0]);
  const productIntent = intentRoute.name === "product";
  const intentEndpoint = productIntent ? `${BUYER_PORTAL_V2_ENDPOINTS.catalog}/${encodeURIComponent(intentRoute.params.productId)}` : "";
  const intent = useRemote(async (signal) => unwrap(await callRequest(request, intentEndpoint, { signal }), ["agent", "product"]), intentEndpoint || "no-intent", productIntent);
  const [form, setForm] = useState({ display_name: "", email: "", password: "", terms: false });
  const [submission, setSubmission] = useState({ status: "idle", error: null });
  usePageTitle(signingUp ? "Create your Hatch account" : "Sign in to Hatch");

  useEffect(() => {
    if (session.status === "authenticated") navigateTo(navigate, returnTo, { replace: true });
  }, [session.status, navigate, returnTo]);

  async function submit(event) {
    event.preventDefault();
    if (submission.status === "pending") return;
    setSubmission({ status: "pending", error: null });
    try {
      let response;
      if (signingUp && session.signUp) response = await session.signUp(form);
      else if (!signingUp && session.signIn) response = await session.signIn({ email: form.email, password: form.password });
      else response = await callRequest(request, signingUp ? "/v1/auth/signup" : "/v1/auth/login", jsonMutation("POST", signingUp ? form : { email: form.email, password: form.password }));
      await session.onAuthenticated?.(response);
      navigateTo(navigate, returnTo, { replace: true });
    } catch (error) {
      setSubmission({ status: "error", error });
    }
  }

  return (
    <main className="buyer-v2 buyer-v2__auth-page">
      <section className="buyer-v2__auth-context">
        <HatchBrand as={RouterLink} className="buyer-v2__brand buyer-v2__brand--inverse" to={EXPLORE_ROOT} navigate={navigate} aria-label="Hatch home" />
        <div>
          <span className="buyer-v2__eyebrow">Continue your task</span>
          {productIntent && intent.status === "loading" ? <div className="buyer-v2__auth-intent-skeleton" aria-label="Loading Product" /> : null}
          {productIntent && intent.status === "ready" ? <><h1>{productName(intent.data)}</h1><p>{productPromise(intent.data)}</p><strong>Permanent access</strong><small>by {creatorName(intent.data)}</small></> : null}
          {!productIntent ? <><h1>Your Agents, orders and access in one place.</h1><p>Use the same Hatch account on Web and Desktop.</p></> : null}
        </div>
      </section>
      <section className="buyer-v2__auth-form-panel">
        <form className="buyer-v2__auth-form" onSubmit={submit}>
          <span className="buyer-v2__eyebrow">Hatch account</span>
          <h2>{signingUp ? "Create your account" : "Sign in to Hatch"}</h2>
          <p>{signingUp ? "Create an account, then return to the Product you selected." : "Sign in, then continue exactly where you left off."}</p>
          {signingUp ? <Field label="Name"><Input required autoComplete="name" value={form.display_name} onChange={(event) => setForm({ ...form, display_name: event.target.value })} /></Field> : null}
          <Field label="Email"><Input required type="email" autoComplete="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field>
          <Field label="Password"><Input required minLength={8} type="password" autoComplete={signingUp ? "new-password" : "current-password"} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field>
          {signingUp ? <HatchCheckbox required checked={form.terms} onCheckedChange={(checked) => setForm({ ...form, terms: checked === true })} label="I agree to the Hatch Terms and Privacy Policy." /> : null}
          {submission.error ? <InlineError error={submission.error} /> : null}
          <Button className="buyer-v2__button--wide" loading={submission.status === "pending"}>{signingUp ? "Create account" : "Sign in"}</Button>
          <p className="buyer-v2__auth-switch">{signingUp ? "Already have an account?" : "New to Hatch?"} <RouterLink to={`${signingUp ? "/sign-in" : "/sign-up"}?returnTo=${encodeURIComponent(returnTo)}`} navigate={navigate}>{signingUp ? "Sign in" : "Create account"}</RouterLink></p>
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
  usePageTitle(checkout ? `Confirm ${productName(checkout.product || checkout.product_snapshot || checkout)}` : "Confirm order");
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
    return <div className="buyer-v2__container buyer-v2__page"><StatePanel eyebrow="Access setup" title="Access confirmed" body="Your access is already recorded. Hatch is finishing the receipt, so do not submit again.">
      <span className="buyer-v2__spinner" aria-hidden="true" />
      {mutation.error ? <InlineError error={mutation.error} /> : null}
      <Button type="button" loading={mutation.status === "pending"} onClick={confirm}>Retry setup</Button>
      {orderId ? <LinkButton variant="secondary" to={`${ORDERS_ROOT}/${encodeURIComponent(orderId)}`} navigate={navigate}>View confirmed order</LinkButton> : null}
    </StatePanel></div>;
  }

  if (checkout.status === "refunded") {
    return <div className="buyer-v2__container buyer-v2__page"><StatePanel tone="warning" eyebrow="Access removed" title="This access is no longer active." body="The receipt remains available for your records.">{checkout.order_id ? <LinkButton to={`${ORDERS_ROOT}/${encodeURIComponent(checkout.order_id)}`} navigate={navigate}>View receipt</LinkButton> : null}<LinkButton variant="secondary" to={productPath(product)} navigate={navigate}>Return to Product</LinkButton></StatePanel></div>;
  }

  return (
    <div className="buyer-v2__container buyer-v2__page buyer-v2__checkout-page">
      <RouterLink className="buyer-v2__back-link" to={productPath(product)} navigate={navigate}>← Back to product</RouterLink>
      <header className="buyer-v2__page-heading"><span className="buyer-v2__eyebrow">Permanent access</span><h1>Confirm this Product.</h1><p>Your access is pinned to the Product release shown here.</p></header>
      <div className="buyer-v2__checkout-grid">
        <section className="buyer-v2__receipt-card">
          <div className="buyer-v2__receipt-product"><span>{creatorName(checkout.creator || product)}</span><h2>{productName(product)}</h2><p>{productPromise(product)}</p></div>
          <DefinitionList rows={[
            ["Release", checkout.release_label || checkout.release_snapshot?.label || product.release_label || "Current approved release"],
            ["Access", "Permanent access"],
            ["Payment", "Not required"]
          ]} />
        </section>
        <CheckoutSummary
          product={{ ...product, name: productName(product), currency: "USD" }}
          lineItems={[{ label: "Permanent access", detail: checkout.release_label || checkout.release_snapshot?.label || product.release_label || "Current approved release", amount_minor: 0 }]}
          totals={{ subtotal_minor: 0, total_minor: 0, subtotal_label: "Free", total_label: "Free", currency: "USD" }}
          busy={mutation.status === "pending"}
          error={mutation.error ? friendlyError(mutation.error) : undefined}
          action={{ label: mutation.status === "pending" ? "Adding to your account…" : "Add to my account", disabled: !accepted || expired, onClick: confirm }}
          legal="The Product and release are resolved by the server."
        >
          <HatchCheckbox checked={accepted} onCheckedChange={(checked) => setAccepted(checked === true)} disabled={expired} label="Add this Product to my account." />
          {expired ? <HatchInlineAlert tone="warning">This access request is no longer current. Return to the Product and try again.</HatchInlineAlert> : null}
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
  usePageTitle(ready ? "Your Agent is ready" : "Confirming your order");

  useEffect(() => {
    if (resource.status !== "ready" || ready || failed) return undefined;
    const timer = window.setTimeout(resource.reload, 2200);
    return () => window.clearTimeout(timer);
  }, [resource.status, ready, failed, resource.reload]);

  if (resource.status === "loading") return <div className="buyer-v2__container buyer-v2__page"><PageSkeleton label="Confirming your order" /></div>;
  if (resource.status === "error" && resource.error?.status >= 500) return <div className="buyer-v2__container buyer-v2__page"><StatePanel tone="warning" eyebrow="Receipt syncing" title="Purchase completed; receipt temporarily unavailable." body="Do not place another order. Hatch is retaining the confirmed purchase and will reload the receipt when the service recovers."><Button type="button" onClick={resource.reload}>Try receipt again</Button></StatePanel></div>;
  if (resource.status === "error") return <div className="buyer-v2__container buyer-v2__page"><RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo={`${ORDERS_ROOT}/${id}/success`} /></div>;

  const { order, entitlement, entitlementError } = data;
  const product = order.product_snapshot || order.product || order;
  const amount = orderAmount(order);
  const entitlementId = order.entitlement_id || entitlement?.entitlement_id || entitlement?.id;

  if (failed) {
    return <div className="buyer-v2__container buyer-v2__page"><StatePanel tone="error" eyebrow="Payment not completed" title="Your account was not charged successfully." body="No access was granted. Return to the order to review the payment status and available recovery action."><LinkButton to={`${ORDERS_ROOT}/${encodeURIComponent(id)}`} navigate={navigate}>View order</LinkButton></StatePanel></div>;
  }

  if (!ready) {
    return <div className="buyer-v2__container buyer-v2__page"><StatePanel eyebrow="Confirming payment" title="We’re confirming your order…" body="Do not submit another order. This page reads the authoritative payment and access status and updates automatically."><span className="buyer-v2__spinner" aria-hidden="true" /><LinkButton variant="secondary" to={`${ORDERS_ROOT}/${encodeURIComponent(id)}`} navigate={navigate}>View order status</LinkButton></StatePanel></div>;
  }

  return (
    <div className="buyer-v2__container buyer-v2__page buyer-v2__success-page">
      <section className="buyer-v2__success-hero">
        <span className="buyer-v2__success-mark" aria-hidden="true">✓</span>
        <span className="buyer-v2__eyebrow">Access granted</span>
        <h1>{productName(product)} is ready.</h1>
        <p>Order #{orderReference(order)} · {amount === 0 ? "Free" : money(amount, order.currency)} · Access granted</p>
        {entitlementError ? <HatchInlineAlert tone="warning" action={<Button size="small" variant="ghost" type="button" onClick={resource.reload}>Retry</Button>}>Purchase completed; some access details are temporarily unavailable.</HatchInlineAlert> : null}
        <div className="buyer-v2__success-actions">
          <Button asChild><a href={desktopUrl(entitlement, product)} onClick={() => trackPortalEvent(request, "desktop_open_clicked", productTelemetry(product))}>Open Hatch Desktop</a></Button>
          <Button asChild variant="secondary"><a href={downloadUrl} target="_blank" rel="noreferrer" onClick={() => trackPortalEvent(request, "desktop_download_clicked", productTelemetry(product))}>Download Hatch Desktop</a></Button>
        </div>
      </section>
      <section className="buyer-v2__next-steps">
        <span className="buyer-v2__eyebrow">What happens next</span>
        <ol><li><span>1</span>Sign in to Desktop with this account.</li><li><span>2</span>Choose this Agent and a Workspace.</li><li><span>3</span>Review local permissions before changes.</li></ol>
        <div className="buyer-v2__detail-links">
          <RouterLink to={`/orders/${encodeURIComponent(orderReference(order))}`} navigate={navigate}>View order receipt →</RouterLink>
          {entitlementId ? <RouterLink to={libraryPathFor(product, entitlement)} navigate={navigate}>View access details →</RouterLink> : null}
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
  usePageTitle("Your Agent library");

  return (
    <div className="buyer-v2__container buyer-v2__page">
      <header className="buyer-v2__page-heading"><span className="buyer-v2__eyebrow">Your library</span><h1>Agents linked to your account.</h1><p>Access and release policy stay visible here. Zero-price purchases do not expire or run out.</p></header>
      {resource.status === "loading" ? <CardSkeleton count={2} label="Loading your library" /> : null}
      {resource.status === "error" ? <RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo={LIBRARY_ROOT} /> : null}
      {resource.status === "ready" && resource.items.length ? <section className="buyer-v2__list-grid" aria-label="Your entitlements">{resource.items.map((item) => <EntitlementCard key={entitlementIdFor(item)} entitlement={item} navigate={navigate} />)}</section> : null}
      {resource.status === "ready" && !resource.items.length ? <EmptyState title="Your library is empty" body="Explore products and choose a method that fits your task." action={<LinkButton to={EXPLORE_ROOT} navigate={navigate}>Explore products</LinkButton>} /> : null}
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
      <div className="buyer-v2__card-footer"><span>{unitsLabel(entitlement)}</span><LinkButton variant="secondary" to={`${LIBRARY_ROOT}/${encodeURIComponent(id)}`} navigate={navigate}>View access</LinkButton></div>
    </article>
  );
}

function EntitlementPage({ id, request, navigate, session, downloadUrl }) {
  const endpoint = `${BUYER_PORTAL_V2_ENDPOINTS.entitlements}/${encodeURIComponent(id)}`;
  const resource = useRemote(async (signal) => unwrap(await callRequest(request, endpoint, { signal }), ["entitlement"]), endpoint);
  usePageTitle(resource.data ? `${productName(resource.data.product || resource.data)} access` : "Access details");
  useUnauthorized(resource.error, session);
  if (resource.status === "loading") return <div className="buyer-v2__container buyer-v2__page"><DetailSkeleton /></div>;
  if (resource.status === "error") return <div className="buyer-v2__container buyer-v2__page"><RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo={`${LIBRARY_ROOT}/${id}`} /></div>;

  const entitlement = resource.data;
  const product = entitlement.product || entitlement.product_snapshot || entitlement;
  const status = accessStatus(entitlement);
  const deliveries = arrayValue(entitlement.deliveries || entitlement.delivery_history, []);
  const orderId = entitlement.order_id || entitlement.order?.order_id || entitlement.order?.id;
  const canOpen = ["active", "reserved"].includes(status);
  return (
    <div className="buyer-v2__container buyer-v2__page">
      <RouterLink className="buyer-v2__back-link" to={LIBRARY_ROOT} navigate={navigate}>← Back to Library</RouterLink>
      <header className="buyer-v2__detail-heading"><div><span className="buyer-v2__eyebrow">Access details</span><h1>{productName(product)}</h1><p>by {creatorName(entitlement.creator || product)}</p></div><StatusChip status={status} label={entitlementStatusLabel(status)} /></header>
      <div className="buyer-v2__detail-grid">
        <section className="buyer-v2__detail-card"><h2>Your entitlement</h2><DefinitionList rows={[
          ["Status", entitlementStatusLabel(status)],
          ["Access", unitsLabel(entitlement)],
          ["Release", entitlement.release_label || entitlement.release?.label || entitlement.release_id || "Pinned purchase release"],
          ["Purchased version", entitlement.purchased_corpus_digest || entitlement.corpus_digest || "—"],
          ["Effective version", entitlement.effective_corpus_digest || entitlement.purchased_corpus_digest || entitlement.corpus_digest || "—"],
          ["Version policy", versionPolicyLabel(entitlement.version_policy)],
          ["Valid from", dateTime(entitlement.valid_from || entitlement.granted_at || entitlement.created_at)],
          ["Expires", entitlement.expires_at ? dateTime(entitlement.expires_at) : "No scheduled expiry"],
          ["Refund / cancellation", entitlement.refund_status || entitlement.cancellation_status || (status === "revoked" ? "Access revoked" : "None")],
          ["Support reference", entitlement.entitlement_id || entitlement.id]
        ]} />{orderId ? <RouterLink className="buyer-v2__text-link" to={`${ORDERS_ROOT}/${encodeURIComponent(orderId)}`} navigate={navigate}>View originating order →</RouterLink> : null}</section>
        <aside className="buyer-v2__activation-card"><span className="buyer-v2__eyebrow">Desktop activation</span><h2>{canOpen ? "Continue in your Workspace." : entitlementRecoveryTitle(status)}</h2><p>{entitlementRecoveryCopy(status)}</p>{canOpen ? <Button asChild><a href={desktopUrl(entitlement, product)} onClick={() => trackPortalEvent(request, "desktop_open_clicked", productTelemetry(product))}>Open Hatch Desktop</a></Button> : null}<a className="buyer-v2__secondary-download" href={downloadUrl} target="_blank" rel="noreferrer" onClick={() => trackPortalEvent(request, "desktop_download_clicked", productTelemetry(product))}>Download Hatch Desktop</a></aside>
      </div>
      <section className="buyer-v2__timeline-section"><div><span className="buyer-v2__eyebrow">Access history</span><h2>Activity, without your private content.</h2><p>Your purchase and access status stay visible on Web. Workspace paths, source files and conversations stay private.</p></div>{deliveries.length ? <Timeline entries={deliveries.map(deliveryTimelineEntry)} /> : <EmptyState compact title="Permanent access" body="Open Hatch Desktop when you are ready to use this access." />}</section>
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
  usePageTitle("Your orders");
  useUnauthorized(resource.error, session);

  return (
    <div className="buyer-v2__container buyer-v2__page">
      <header className="buyer-v2__page-heading"><span className="buyer-v2__eyebrow">Order history</span><h1>Your complete receipts.</h1><p>Amounts, payment, access and refund remain separate and traceable.</p></header>
      <label className="buyer-v2__select-label">Order status<Select label="Order status" value={filter} onValueChange={(value) => navigateTo(navigate, value === "all" ? ORDERS_ROOT : `${ORDERS_ROOT}?status=${encodeURIComponent(value)}`)} options={[{ value: "all", label: "All orders" }, { value: "fulfilled", label: "Fulfilled" }, { value: "pending", label: "Pending" }, { value: "refunded", label: "Refunded" }]} /></label>
      {resource.status === "loading" ? <ListSkeleton label="Loading orders" /> : null}
      {resource.status === "error" ? <RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo={ORDERS_ROOT} /> : null}
      {resource.status === "ready" && resource.items.length ? <section className="buyer-v2__order-list" aria-label="Orders">{resource.items.map((order) => <OrderRow key={orderIdFor(order)} order={order} navigate={navigate} />)}</section> : null}
      {resource.status === "ready" && !resource.items.length ? <EmptyState title="No orders in this view" body="Orders appear after you add a Product." action={<LinkButton to={EXPLORE_ROOT} navigate={navigate}>Explore products</LinkButton>} /> : null}
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
      <div className="buyer-v2__order-row-status"><strong>{orderAmount(order) === 0 ? "Free" : money(orderAmount(order), order.currency)}</strong><StatusChip status={orderStatus(order)} label={orderStatusLabel(order)} /></div>
      <LinkButton variant="secondary" to={`/orders/${encodeURIComponent(orderReference(order))}`} navigate={navigate}>View order</LinkButton>
    </article>
  );
}

function OrderPage({ id, request, navigate, session }) {
  const endpoint = `${BUYER_PORTAL_V2_ENDPOINTS.orders}/${encodeURIComponent(id)}`;
  const resource = useRemote(async (signal) => unwrap(await callRequest(request, endpoint, { signal }), ["order"]), endpoint);
  const [refundState, setRefundState] = useState({ status: "idle", error: null });
  const refundIntentKey = useRef(requestId());
  usePageTitle(resource.data ? `${productName(resource.data.product_snapshot || resource.data.product || resource.data)} order` : "Order details");
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
  const reversalLabel = canCancelAccess ? "Cancel this purchase" : "Request refund";
  const reversalSuccess = canCancelAccess ? "Purchase cancelled." : "Refund request received.";
  const totalMinor = orderAmount(order);
  const subtotalMinor = numberOr(order.subtotal_minor, totalMinor);
  const discountMinor = numberOr(order.discount_minor, 0);
  const taxLabel = order.tax_minor == null ? "Not calculated" : money(numberOr(order.tax_minor, 0), order.currency);

  return (
    <div className="buyer-v2__container buyer-v2__page">
      <RouterLink className="buyer-v2__back-link" to={ORDERS_ROOT} navigate={navigate}>← Back to Orders</RouterLink>
      <header className="buyer-v2__detail-heading"><div><span className="buyer-v2__eyebrow">Order #{orderReference(order)}</span><h1>{productName(product)}</h1><p>Created {dateTime(order.created_at || order.occurred_at)}</p></div><StatusChip status={orderStatus(order)} label={orderStatusLabel(order)} /></header>
      <div className="buyer-v2__detail-grid">
        <section className="buyer-v2__detail-card"><h2>Receipt</h2><DefinitionList rows={[
          ["Creator", creatorName(order.creator || product)],
          ["Subtotal", subtotalMinor === 0 ? "Free" : money(subtotalMinor, order.currency)],
          ["Discount", discountMinor === 0 ? money(0, order.currency) : `−${money(discountMinor, order.currency)}`],
          ["Tax", taxLabel],
          ["Total", totalMinor === 0 ? "Free" : money(totalMinor, order.currency)],
          ["Payment", paymentStatusLabel(order.payment_status || order.payment?.status, totalMinor)],
          ["Access", entitlementStatusLabel(accessStatus(order.entitlement || { status: order.entitlement_status }))],
          ["Release", order.release_snapshot?.label || order.release_snapshot?.release_id || order.release_label || order.release_id || "Purchase-time release"]
        ]} />{entitlementId ? <RouterLink className="buyer-v2__text-link" to={`${LIBRARY_ROOT}/${encodeURIComponent(entitlementId)}`} navigate={navigate}>View access details →</RouterLink> : null}</section>
        <aside className="buyer-v2__order-actions"><span className="buyer-v2__eyebrow">Order actions</span><h2>{orderActionTitle(order)}</h2><p>{orderActionCopy(order)}</p>{successReady(order, order.entitlement) ? <LinkButton to={`/orders/${encodeURIComponent(orderReference(order))}/success`} navigate={navigate}>Open activation steps</LinkButton> : null}{canReverseOrder ? <Button variant="secondary" type="button" loading={refundState.status === "pending"} onClick={requestRefund}>{reversalLabel}</Button> : null}{refundState.error ? <InlineError error={refundState.error} /> : null}{refundState.status === "succeeded" ? <div className="buyer-v2__inline-notice" role="status">{reversalSuccess}</div> : null}</aside>
      </div>
      <section className="buyer-v2__timeline-section"><div><span className="buyer-v2__eyebrow">Access history</span><h2>What happened, in order.</h2></div><Timeline entries={entries} /></section>
    </div>
  );
}

function NotFoundPage({ navigate }) {
  usePageTitle("Page not found");
  return <div className="buyer-v2__container buyer-v2__page"><StatePanel eyebrow="404" title="This page is not available." body="The link may be incomplete, or this public product may have been removed."><LinkButton to={EXPLORE_ROOT} navigate={navigate}>Explore products</LinkButton></StatePanel></div>;
}

function RedirectPage({ to, navigate }) {
  useEffect(() => navigateTo(navigate, to, { replace: true }), [navigate, to]);
  return <main className="buyer-v2 buyer-v2__redirect" aria-live="polite"><p>Taking you to sign in…</p><RouterLink to={to} navigate={navigate}>Continue to sign in</RouterLink></main>;
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
  if (status === 401) return <StatePanel tone="error" eyebrow="Session expired" title="Sign in to continue." body="Your task is safe. After signing in, you’ll return to this page."><LinkButton to={`/sign-in?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`} navigate={navigate}>Sign in</LinkButton></StatePanel>;
  if (status === 403) return <StatePanel tone="error" eyebrow="Access denied" title="This account cannot view that resource." body="Return to a page available to this account."><LinkButton to={EXPLORE_ROOT} navigate={navigate}>Explore products</LinkButton></StatePanel>;
  if (status === 404) return <StatePanel tone="error" eyebrow="Not found" title="That resource is no longer available." body="A previous receipt may still be available from your Orders."><LinkButton to={ORDERS_ROOT} navigate={navigate}>View Orders</LinkButton></StatePanel>;
  if (status === 409) return <StatePanel tone="error" eyebrow="Details changed" title="Review the latest version before continuing." body={friendlyError(error)}><Button type="button" onClick={onRetry}>Refresh details</Button></StatePanel>;
  return <StatePanel tone="error" title="Your task is still here." body={friendlyError(error)}><Button type="button" onClick={onRetry}>Try again</Button></StatePanel>;
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
  return <div className="buyer-v2__detail-skeleton" aria-busy="true" aria-label="Loading details"><i /><i /><i /><i /></div>;
}

function PageSkeleton({ label }) {
  return <div className="buyer-v2__page-skeleton" aria-busy="true" aria-label={label}><span className="buyer-v2__spinner" aria-hidden="true" /><p>{label}…</p></div>;
}

function LoadMore({ resource }) {
  return <div className="buyer-v2__load-more">{resource.moreError ? <InlineError error={resource.moreError} /> : null}<Button variant="secondary" type="button" loading={resource.loadingMore} onClick={resource.loadMore}>Load more</Button></div>;
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
function productName(value) { return value?.product_name || value?.name || value?.product?.name || "Creator Agent"; }
function productPromise(value) { return value?.promise || value?.product_description || value?.description || value?.product?.promise || value?.product?.description || "A practical Creator method for work in your own Workspace."; }
function creatorName(value) { return value?.creator_name || value?.creator_display_name || value?.display_name || value?.name || value?.creator?.display_name || value?.creator?.name || value?.creator?.handle || "Hatch Creator"; }
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

function money(minor, currency = "USD") {
  const amount = Number(minor);
  if (!Number.isFinite(amount)) return "—";
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(amount / 100); }
  catch { return `${currency || "USD"} ${(amount / 100).toFixed(2)}`; }
}

function accessStatus(value) {
  const status = value?.status || value?.entitlement_status || "none";
  if (["granted", "available"].includes(status)) return "active";
  if (["fulfillment_pending", "provisioning"].includes(status)) return "pending";
  return status;
}

function entitlementStatusLabel(status) {
  return ({ active: "Available", reserved: "In progress", pending: "Setting up", consumed: "Used", expired: "Expired", suspended: "Paused", revoked: "Access ended", none: "No access" })[status] || sentenceCase(status);
}

function entitlementSummary(value) {
  const status = accessStatus(value);
  if (value?.access_mode === "unmetered") return value.summary || "Permanent access. Open Hatch Desktop with this account and choose a Workspace.";
  if (status === "reserved") return "Access setup is in progress.";
  if (status === "consumed") return "This access is no longer active.";
  if (status === "expired") return "This access has expired. Return to the Product to get access again.";
  if (["suspended", "revoked"].includes(status)) return value.status_reason_label || "Access is unavailable. Review the recovery details.";
  return value.summary || "Open Hatch Desktop with this account and choose a Workspace.";
}

function unitsLabel(value) {
  if (value?.access_mode === "unmetered" || value?.unlimited === true) return "Permanent access";
  if (value.remaining_units == null && value.units_remaining == null) return "Access details";
  const units = Number(value.remaining_units ?? value.units_remaining);
  return `${units} access ${units === 1 ? "use" : "uses"} available`;
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
  return ({ fulfilled: "Access granted", pending: "Pending", payment_pending: "Payment pending", refund_pending: "Refund pending", refunded: "Refunded", cancelled: "Cancelled", failed: "Failed" })[status] || sentenceCase(status);
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

function orderActionTitle(order) {
  if (orderStatus(order) === "cancelled") return "Purchase cancelled.";
  if (orderStatus(order) === "refunded") return "This order was refunded.";
  if (paymentFailed(order)) return "Payment was not completed.";
  if (successReady(order, order.entitlement)) return "Your access is ready.";
  return "This order is still processing.";
}

function orderActionCopy(order) {
  if (orderStatus(order) === "cancelled") return "The zero-value receipt and access-revocation timeline remain available for your records.";
  if (orderStatus(order) === "refunded") return "The receipt and refund timeline remain available for your records.";
  if (paymentFailed(order)) return "No active entitlement is created for an unsuccessful payment.";
  if (successReady(order, order.entitlement)) return "Open the activation steps or review the linked entitlement.";
  return "Refresh this durable order page instead of submitting a duplicate checkout.";
}

function orderTimeline(order) {
  if (Array.isArray(order.timeline) && order.timeline.length) return order.timeline.map((entry) => ({ id: entry.id || entry.event_id, label: entry.label || sentenceCase(entry.type || entry.event_type), detail: entry.detail || entry.summary, time: entry.occurred_at || entry.created_at, tone: entry.status === "failed" ? "error" : "" }));
  const entries = [{ label: "Order created", time: order.created_at || order.occurred_at }];
  const paymentStatus = order.payment_status || order.payment?.status;
  if (orderAmount(order) === 0 || paymentStatus === "not_required") entries.push({ label: "Payment not required", time: order.payment?.updated_at || order.created_at });
  else if (["succeeded", "paid"].includes(paymentStatus)) entries.push({ label: "Payment succeeded", time: order.payment?.succeeded_at || order.paid_at });
  else if (paymentStatus) entries.push({ label: `Payment ${sentenceCase(paymentStatus)}`, time: order.payment?.updated_at, tone: paymentFailed(order) ? "error" : "" });
  if (order.entitlement_id || order.entitlement) entries.push({ label: "Access granted", time: order.entitlement?.granted_at || order.fulfilled_at });
  for (const delivery of arrayValue(order.deliveries, [])) entries.push(deliveryTimelineEntry(delivery));
  if (order.refund || order.refund_status) entries.push({ label: `Refund ${sentenceCase(order.refund?.status || order.refund_status)}`, time: order.refund?.updated_at || order.refunded_at });
  return entries;
}

function deliveryTimelineEntry(delivery) {
  const status = delivery.status || delivery.delivery_status || "completed";
  return { id: delivery.delivery_id || delivery.id, label: `Activity ${sentenceCase(status)}`, detail: delivery.artifact_type ? `Artifact type: ${sentenceCase(delivery.artifact_type)}` : delivery.summary, time: delivery.completed_at || delivery.started_at || delivery.created_at, tone: status === "failed" ? "error" : "" };
}

function versionPolicyLabel(value) {
  if (!value || value === "pinned") return "Pinned to purchased release";
  if (value === "compatible_tracking") return "Compatible release updates allowed";
  return sentenceCase(value);
}

function entitlementRecoveryTitle(status) {
  if (status === "consumed") return "This access has been used.";
  if (status === "expired") return "This access has expired.";
  if (status === "pending") return "Access is still being prepared.";
  return "Desktop activation is unavailable.";
}

function entitlementRecoveryCopy(status) {
  if (["consumed", "expired"].includes(status)) return "Return to the public Product to review available access.";
  if (status === "pending") return "Keep this page and order receipt; fulfillment will update without another checkout.";
  return "Review the originating order for a reason and available support action.";
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

function textValue(value) { return typeof value === "string" ? value : value?.label || value?.summary || value?.description || "Product detail"; }

function dateTime(value, dateOnly = false) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-US", dateOnly ? { dateStyle: "medium" } : { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function initialsFor(user) {
  if (user?.initials) return user.initials;
  const value = user?.display_name || user?.name || user?.email || "Account";
  return value.split(/\s+|@/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "A";
}

function friendlyError(error) {
  if (!error) return "Something went wrong. Try again.";
  if (error.code === "release_changed") return "The Product changed after this request began. Refresh and confirm the current release.";
  if (error.status === 429) return "Too many requests. Wait a moment, then try again.";
  if (error.status >= 500) return "Hatch is temporarily unavailable. Your current task has not been discarded.";
  return error.message || "Something went wrong. Try again.";
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
  const text = String(value || "").replaceAll("_", " ");
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "Unknown";
}

function cssToken(value) { return String(value || "unknown").toLowerCase().replace(/[^a-z0-9-]/g, "-"); }
