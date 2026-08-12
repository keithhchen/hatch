import React, { useEffect, useMemo, useRef, useState } from "react";
import { StorefrontDetails } from "./StorefrontDetails.jsx";
import "./buyerPortalV2.css";

const DEFAULT_DOWNLOAD_URL = "https://github.com/keithhchen/hatch/releases/latest";
const PUBLIC_ROUTE_NAMES = new Set(["catalog", "product", "sign-in", "sign-up", "account-help", "not-found"]);

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
 *   GET  /v1/catalog/agents -> Agent[] | { agents: Agent[] }
 *   GET  /v1/catalog/agents/:creator/:product -> Agent | { agent: Agent }
 *   POST /v1/checkout-sessions -> Checkout | { checkout_session: Checkout }
 *   GET  /v1/checkout-sessions/:id -> same as above
 *   POST /v1/checkout-sessions/:id/confirm
 *        -> { order_id, status, entitlement_id?, redirect_url? }
 *   GET  /v1/user/orders -> { orders: Order[], next_cursor? }
 *   GET  /v1/user/orders/:id -> Order | { order: Order }
 *   GET  /v1/user/entitlements -> { entitlements: Entitlement[], next_cursor? }
 *   GET  /v1/user/entitlements/:id -> Entitlement | { entitlement: Entitlement }
 *
 * Product/checkout/order payloads may expose either nested snapshots or the
 * equivalent flat migration fields. Helpers in this module normalize both.
 */
export const BUYER_PORTAL_V2_ENDPOINTS = Object.freeze({
  catalog: "/v1/catalog/agents",
  checkoutSessions: "/v1/checkout-sessions",
  orders: "/v1/user/orders",
  entitlements: "/v1/user/entitlements"
});

export function BuyerPortalV2({
  pathname = "/agents",
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

  if (segments.length === 1 && segments[0] === "agents") return { name: "catalog", params: {} };
  if (segments.length === 3 && segments[0] === "agents") {
    return { name: "product", params: { creatorSlug: segments[1], productSlug: segments[2] } };
  }
  if (segments.length === 1 && segments[0] === "sign-in") return { name: "sign-in", params: {} };
  if (segments.length === 1 && segments[0] === "sign-up") return { name: "sign-up", params: {} };
  if (segments.length === 2 && segments[0] === "account" && segments[1] === "help") return { name: "account-help", params: {} };
  if (segments.length === 2 && segments[0] === "portal" && segments[1] === "library") return { name: "library", params: {} };
  if (segments.length === 2 && segments[0] === "portal" && segments[1] === "settings") return { name: "settings", params: {} };
  if (segments.length === 2 && segments[0] === "portal" && segments[1] === "subscriptions") return { name: "subscriptions", params: {} };
  if (segments.length === 3 && segments[0] === "portal" && segments[1] === "library") {
    return { name: "entitlement", params: { entitlementId: segments[2] } };
  }
  if (segments.length === 3 && segments[0] === "portal" && segments[1] === "checkout") {
    return { name: "checkout", params: { checkoutSessionId: segments[2] } };
  }
  if (segments.length === 2 && segments[0] === "portal" && segments[1] === "orders") return { name: "orders", params: {} };
  if (segments.length === 4 && segments[0] === "portal" && segments[1] === "orders" && segments[3] === "success") {
    return { name: "success", params: { orderId: segments[2] } };
  }
  if (segments.length === 3 && segments[0] === "portal" && segments[1] === "orders") {
    return { name: "order", params: { orderId: segments[2] } };
  }
  return { name: "not-found", params: {} };
}

function BuyerShell({ route, navigate, session, downloadUrl, children }) {
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const authenticated = session.status === "authenticated";
  const active = route.name === "catalog" || route.name === "product"
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
      navigateTo(navigate, "/agents", { replace: true });
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
          <RouterLink className="buyer-v2__brand" to="/agents" navigate={navigate} aria-label="Hatch home">
            <span aria-hidden="true" className="buyer-v2__brand-mark">H</span><span>Hatch.</span>
          </RouterLink>
          <nav className="buyer-v2__nav" aria-label="Buyer navigation">
            <RouterLink to="/agents" navigate={navigate} aria-current={active === "explore" ? "page" : undefined}>Explore</RouterLink>
            {authenticated ? <RouterLink to="/portal/library" navigate={navigate} aria-current={active === "library" ? "page" : undefined}>Library</RouterLink> : null}
            {authenticated ? <RouterLink to="/portal/orders" navigate={navigate} aria-current={active === "orders" ? "page" : undefined}>Orders</RouterLink> : null}
          </nav>
          <div className="buyer-v2__account">
            <a className="buyer-v2__download-quiet" href={downloadUrl} target="_blank" rel="noreferrer">Download</a>
            {authenticated ? (
              <>
                <RouterLink className="buyer-v2__avatar" to="/portal/settings" navigate={navigate} aria-label="Account settings" aria-current={active === "settings" ? "page" : undefined}>{initialsFor(session.user)}</RouterLink>
                <button type="button" className="buyer-v2__plain-button" disabled={signingOut} onClick={signOut}>{signingOut ? "Signing out…" : "Sign out"}</button>
              </>
            ) : (
              <RouterLink className="buyer-v2__header-cta" to="/sign-in?returnTo=%2Fagents" navigate={navigate}>Sign in</RouterLink>
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
  usePageTitle("Creator Agents");
  const resource = useRemote(async (signal) => {
    const response = await callRequest(request, BUYER_PORTAL_V2_ENDPOINTS.catalog, { signal });
    return collectionFrom(response, ["agents", "items"]);
  }, "catalog");

  return (
    <div className="buyer-v2__container buyer-v2__page">
      <header className="buyer-v2__page-heading buyer-v2__catalog-heading">
        <span className="buyer-v2__eyebrow">Creator Agents</span>
        <h1>Methods you can put to work.</h1>
        <p>Understand the promise and boundaries first. Add an Agent to your account only when it fits the job.</p>
      </header>
      {resource.status === "loading" ? <CardSkeleton count={3} label="Loading Creator Agents" /> : null}
      {resource.status === "error" ? <RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo="/agents" /> : null}
      {resource.status === "ready" && resource.data.length ? (
        <section className="buyer-v2__catalog-grid" aria-label="Available Creator Agents">
          {resource.data.map((product) => <CatalogCard key={productKey(product)} product={product} navigate={navigate} authenticated={session.status === "authenticated"} />)}
        </section>
      ) : null}
      {resource.status === "ready" && resource.data.length === 0 ? (
        <EmptyState title="No Agents are public yet" body="Published Creator Agents will appear here. Try again later." />
      ) : null}
    </div>
  );
}

function CatalogCard({ product, navigate }) {
  const path = productPath(product);
  const offer = offerFor(product);
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
        <div><strong>{accessStatus(access) === "active" ? "In your library" : offerLabel(offer)}</strong><span>{offerUnitLabel(offer)}</span></div>
        <RouterLink className="buyer-v2__button buyer-v2__button--secondary" to={path} navigate={navigate}>View details</RouterLink>
      </div>
    </article>
  );
}

function ProductPage({ route, request, navigate, session, downloadUrl }) {
  const { creatorSlug, productSlug } = route.params;
  const path = `/agents/${encodeURIComponent(creatorSlug)}/${encodeURIComponent(productSlug)}`;
  const endpoint = `${BUYER_PORTAL_V2_ENDPOINTS.catalog}/${encodeURIComponent(creatorSlug)}/${encodeURIComponent(productSlug)}`;
  const resource = useRemote(async (signal) => unwrap(await callRequest(request, endpoint, { signal }), ["agent", "product"]), endpoint);
  const product = resource.data;
  usePageTitle(product ? productName(product) : "Agent details");

  if (resource.status === "loading") return <div className="buyer-v2__container buyer-v2__page"><DetailSkeleton /></div>;
  if (resource.status === "error") return <div className="buyer-v2__container buyer-v2__page"><RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo={path} /></div>;

  const examples = arrayValue(product.examples || product.proof, []);
  const desktopRequirement = product.desktop_requirement || "macOS app and a Hatch account. You select the Workspace before the Agent can work with local files.";

  return (
    <div className="buyer-v2__container buyer-v2__page">
      <RouterLink className="buyer-v2__back-link" to="/agents" navigate={navigate}>← All Creator Agents</RouterLink>
      <StorefrontDetails
        product={product}
        creatorName={creatorName(product)}
        offer={offerFor(product)}
        offerText={offerLabel(offerFor(product))}
        desktopRequirement={desktopRequirement}
        refundPolicy={refundCopy(product)}
        releaseLabel={product.release_label || product.release?.label}
        action={<ProductAction embedded product={product} currentPath={path} request={request} navigate={navigate} session={session} downloadUrl={downloadUrl} />}
      />

      <section className="buyer-v2__wide-section">
        <span className="buyer-v2__eyebrow">How it works</span>
        <h2>From access to a reviewed delivery.</h2>
        <ol className="buyer-v2__steps">
          <li><span>1</span><div><strong>Add the Agent</strong><p>Confirm the current offer and receive account access.</p></div></li>
          <li><span>2</span><div><strong>Open Hatch Desktop</strong><p>Sign in with the same account and choose a local Workspace.</p></div></li>
          <li><span>3</span><div><strong>Review and deliver</strong><p>Approve permissions and save the finished artifact where you control it.</p></div></li>
        </ol>
      </section>

      {examples.length ? <InfoSection className="buyer-v2__wide-section" eyebrow="Representative examples" title="Evidence, without exposing protected instructions." items={examples} /> : null}
    </div>
  );
}

function ProductAction({ product, currentPath, request, navigate, session, downloadUrl, embedded = false }) {
  const offer = offerFor(product);
  const access = accessFor(product);
  const status = accessStatus(access);
  const [mutation, setMutation] = useState({ status: "idle", error: null });
  const checkoutIntentKey = useRef(requestId());
  const amount = offerAmount(offer);
  const purchasable = Boolean(offer && offerId(offer) && productId(product)) && product.available !== false && product.status !== "withdrawn";
  const isAnonymous = session.status !== "authenticated";
  const isOwnerCreator = session.user?.role === "creator"
    && String(session.user?.id ?? "") === String(product.creator_id ?? product.creator?.id ?? "");

  async function startCheckout() {
    if (!purchasable || mutation.status === "pending") return;
    setMutation({ status: "pending", error: null });
    try {
      const response = await callRequest(request, BUYER_PORTAL_V2_ENDPOINTS.checkoutSessions, jsonMutation("POST", {
        product_id: productId(product),
        offer_id: offerId(offer)
      }, checkoutIntentKey.current));
      const checkout = unwrap(response, ["checkout_session", "checkout"]);
      const id = checkout.checkout_session_id || checkout.id;
      if (!id) throw clientContractError("Checkout response did not include checkout_session_id.");
      navigateTo(navigate, `/portal/checkout/${encodeURIComponent(id)}`);
    } catch (error) {
      setMutation({ status: "error", error });
    }
  }

  let title = amount === 0 ? "Add this Agent to your account." : "Confirm the offer before you pay.";
  let body = amount === 0 ? "No payment is required. The order and delivery access are still recorded." : `${offerLabel(offer)} for the delivery scope shown at checkout.`;
  let action = null;

  if (isOwnerCreator) {
    title = "This is your published storefront.";
    body = "Buyers see the same promise, boundaries and active offer shown here.";
    action = <RouterLink className="buyer-v2__button buyer-v2__button--secondary" to={`/portal/creator/products/${encodeURIComponent(productId(product))}`} navigate={navigate}>Manage product</RouterLink>;
  } else if (status === "active" || status === "reserved") {
    title = status === "reserved" ? "A delivery is in progress." : "This Agent is ready.";
    body = status === "reserved" ? "Return to Hatch Desktop to continue safely." : "Open Hatch Desktop with this account, then choose a Workspace.";
    action = <><RouterLink className="buyer-v2__button buyer-v2__button--primary" to={`/portal/library/${encodeURIComponent(access.entitlement_id ?? access.id)}`} navigate={navigate}>View access</RouterLink><a className="buyer-v2__button buyer-v2__button--secondary" href={desktopUrl(access, product)} onClick={() => trackPortalEvent(request, "desktop_open_clicked", productTelemetry(product))}>Open Hatch Desktop</a></>;
  } else if (status === "pending") {
    title = "Setting up your access…";
    body = "Your order is confirmed. Access will appear as soon as fulfillment finishes.";
    action = <button type="button" className="buyer-v2__button buyer-v2__button--primary" disabled aria-busy="true">Setting up access…</button>;
  } else if (!purchasable) {
    title = "This Agent is not currently for sale.";
    body = "The Creator may publish a new offer later. Existing receipts remain available to buyers.";
  } else if (isAnonymous) {
    const authPath = `/sign-in?returnTo=${encodeURIComponent(currentPath)}`;
    action = <RouterLink className="buyer-v2__button buyer-v2__button--primary" to={authPath} navigate={navigate}>{amount === 0 ? "Get for free" : `Buy for ${money(amount, offer.currency)}`}</RouterLink>;
  } else {
    action = <button type="button" className="buyer-v2__button buyer-v2__button--primary" disabled={mutation.status === "pending"} onClick={startCheckout} aria-busy={mutation.status === "pending"}>{mutation.status === "pending" ? "Opening checkout…" : amount === 0 ? "Get for free" : `Buy for ${money(amount, offer.currency)}`}</button>;
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
    <aside className="buyer-v2__action-card" aria-label="Offer">
      <span className="buyer-v2__eyebrow">Current offer</span>
      <div className="buyer-v2__price"><strong>{offerLabel(offer)}</strong><span>{offerUnitLabel(offer)}</span></div>
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
      navigateTo(navigate, "/agents", { replace: true });
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
      <div className="buyer-v2__detail-links"><button type="button" className="buyer-v2__button buyer-v2__button--secondary" disabled={status === "pending"} onClick={signOut}>{status === "pending" ? "Signing out…" : "Sign out"}</button><RouterLink to="/account/help" navigate={navigate}>Account help</RouterLink></div>
    </section>
  </div>;
}

function AccountHelpPage({ session, navigate }) {
  usePageTitle("Account help");
  return <div className="buyer-v2__container buyer-v2__page">
    <header className="buyer-v2__page-heading"><span className="buyer-v2__eyebrow">Account help</span><h1>Get back to the right account.</h1><p>Orders and Agent access belong to the account that confirmed checkout. Use that same account in Hatch Desktop.</p></header>
    <section className="buyer-v2__decision-grid">
      <article className="buyer-v2__info-card"><span className="buyer-v2__eyebrow">Session</span><h2>{session.status === "authenticated" ? "You are signed in." : "Sign in to continue."}</h2><p>If a receipt or Agent is missing, confirm that Web and Desktop use the same account.</p>{session.status === "authenticated" ? <RouterLink className="buyer-v2__button buyer-v2__button--secondary" to="/portal/settings" navigate={navigate}>View settings</RouterLink> : <RouterLink className="buyer-v2__button buyer-v2__button--primary" to="/sign-in?returnTo=%2Faccount%2Fhelp" navigate={navigate}>Sign in</RouterLink>}</article>
      <article className="buyer-v2__info-card"><span className="buyer-v2__eyebrow">Purchase support</span><h2>Keep the support reference.</h2><p>Open the order or entitlement detail and include its support reference when reporting a payment, refund, or access problem.</p><RouterLink className="buyer-v2__button buyer-v2__button--secondary" to={session.status === "authenticated" ? "/portal/orders" : "/agents"} navigate={navigate}>{session.status === "authenticated" ? "View orders" : "Browse Agents"}</RouterLink></article>
    </section>
  </div>;
}

function SubscriptionsPage({ navigate }) {
  usePageTitle("Subscriptions");
  return <div className="buyer-v2__container buyer-v2__page"><StatePanel eyebrow="Subscriptions" title="No subscription products are enabled." body="Hatch V2 supports one-time per-delivery offers. Subscription billing remains unavailable until its renewal, grace, proration and cancellation policy is complete."><RouterLink className="buyer-v2__button buyer-v2__button--primary" to="/agents" navigate={navigate}>Browse per-delivery Agents</RouterLink></StatePanel></div>;
}

function AuthPage({ mode, search, request, navigate, session }) {
  const signingUp = mode === "sign-up";
  const params = new URLSearchParams(search);
  const returnTo = safeReturnTo(params.get("returnTo") || "/portal/library");
  const intentRoute = matchBuyerRoute(returnTo.split("?")[0]);
  const productIntent = intentRoute.name === "product";
  const intentEndpoint = productIntent ? `${BUYER_PORTAL_V2_ENDPOINTS.catalog}/${encodeURIComponent(intentRoute.params.creatorSlug)}/${encodeURIComponent(intentRoute.params.productSlug)}` : "";
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
        <RouterLink className="buyer-v2__brand buyer-v2__brand--inverse" to="/agents" navigate={navigate}><span aria-hidden="true" className="buyer-v2__brand-mark">H</span><span>Hatch.</span></RouterLink>
        <div>
          <span className="buyer-v2__eyebrow">Continue your task</span>
          {productIntent && intent.status === "loading" ? <div className="buyer-v2__auth-intent-skeleton" aria-label="Loading offer" /> : null}
          {productIntent && intent.status === "ready" ? <><h1>{productName(intent.data)}</h1><p>{productPromise(intent.data)}</p><strong>{offerLabel(offerFor(intent.data))}</strong><small>by {creatorName(intent.data)}</small></> : null}
          {!productIntent ? <><h1>Your Agents, orders and access in one place.</h1><p>Use the same Hatch account on Web and Desktop.</p></> : null}
        </div>
      </section>
      <section className="buyer-v2__auth-form-panel">
        <form className="buyer-v2__auth-form" onSubmit={submit}>
          <span className="buyer-v2__eyebrow">Hatch account</span>
          <h2>{signingUp ? "Create your account" : "Sign in to Hatch"}</h2>
          <p>{signingUp ? "Create an account, then return to the offer you selected." : "Sign in, then continue exactly where you left off."}</p>
          {signingUp ? <Field label="Name"><input required autoComplete="name" value={form.display_name} onChange={(event) => setForm({ ...form, display_name: event.target.value })} /></Field> : null}
          <Field label="Email"><input required type="email" autoComplete="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field>
          <Field label="Password"><input required minLength={8} type="password" autoComplete={signingUp ? "new-password" : "current-password"} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field>
          {signingUp ? <label className="buyer-v2__checkbox"><input required type="checkbox" checked={form.terms} onChange={(event) => setForm({ ...form, terms: event.target.checked })} /><span>I agree to the Hatch Terms and Privacy Policy.</span></label> : null}
          {submission.error ? <InlineError error={submission.error} /> : null}
          <button className="buyer-v2__button buyer-v2__button--primary buyer-v2__button--wide" disabled={submission.status === "pending"} aria-busy={submission.status === "pending"}>{submission.status === "pending" ? "Please wait…" : signingUp ? "Create account" : "Sign in"}</button>
          <p className="buyer-v2__auth-switch">{signingUp ? "Already have an account?" : "New to Hatch?"} <RouterLink to={`${signingUp ? "/sign-in" : "/sign-up"}?returnTo=${encodeURIComponent(returnTo)}`} navigate={navigate}>{signingUp ? "Sign in" : "Create account"}</RouterLink></p>
        </form>
      </section>
    </main>
  );
}

function CheckoutPage({ id, request, navigate, session, openPayment }) {
  const endpoint = `${BUYER_PORTAL_V2_ENDPOINTS.checkoutSessions}/${encodeURIComponent(id)}`;
  const resource = useRemote(async (signal) => unwrap(await callRequest(request, endpoint, { signal }), ["checkout_session", "checkout"]), endpoint);
  const [accepted, setAccepted] = useState(false);
  const [mutation, setMutation] = useState({ status: "idle", error: null });
  const confirmationIntentKey = useRef(requestId());
  const checkout = resource.data;
  const fulfillmentPending = checkout?.status === "fulfillment_pending";
  const paymentPending = checkout?.status === "payment_pending";
  usePageTitle(checkout ? `Confirm ${productName(checkout.product || checkout.product_snapshot || checkout)}` : "Confirm order");
  useUnauthorized(resource.error, session);

  useEffect(() => {
    if ((!fulfillmentPending && !paymentPending) || mutation.status === "pending") return undefined;
    const timer = window.setTimeout(resource.reload, 3000);
    return () => window.clearTimeout(timer);
  }, [fulfillmentPending, paymentPending, mutation.status, resource.reload]);

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
      const redirectUrl = result.redirect_url || result.payment_url || response.redirect_url;
      const orderId = result.order_id || result.id || response.order_id;
      if (redirectUrl) {
        openPayment(redirectUrl);
        return;
      }
      if (["pending", "processing", "payment_pending", "requires_action"].includes(confirmationStatus)) {
        setMutation({ status: "idle", error: null });
        resource.reload();
        return;
      }
      if (["failed", "cancelled", "payment_failed"].includes(confirmationStatus)) {
        const paymentError = new Error("Payment was not completed. No access was granted.");
        paymentError.code = `payment_${confirmationStatus}`;
        setMutation({ status: "error", error: paymentError });
        resource.reload();
        return;
      }
      if (!orderId) throw clientContractError("Checkout confirmation did not include order_id.");
      navigateTo(navigate, `/portal/orders/${encodeURIComponent(orderId)}/success`, { replace: true });
    } catch (error) {
      setMutation({ status: "error", error });
      if (error.status === 409 || error.status === 502 || error.code === "fulfillment_pending") resource.reload();
    }
  }

  if (resource.status === "loading") return <div className="buyer-v2__container buyer-v2__page"><DetailSkeleton /></div>;
  if (resource.status === "error") return <div className="buyer-v2__container buyer-v2__page"><RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo={`/portal/checkout/${id}`} /></div>;

  const product = checkout.product_snapshot || checkout.product || checkout;
  const offer = checkout.offer_snapshot || checkout.offer || offerFor(checkout);
  const totals = checkout.totals || checkout;
  const total = numberOr(totals.total_minor, offerAmount(offer));
  const expired = ["expired", "offer_changed", "cancelled"].includes(checkout.status) || (checkout.status === "open" && checkout.expires_at && Date.parse(checkout.expires_at) <= Date.now());
  const quoteChange = checkout.quote_change || mutation.error?.details;

  if (fulfillmentPending) {
    const orderId = checkout.order_id || checkout.order?.order_id;
    return <div className="buyer-v2__container buyer-v2__page"><StatePanel eyebrow="Access setup" title="Order confirmed; setting up access" body="Your order is already recorded. Hatch is retrying the access projection, so do not place another order.">
      <span className="buyer-v2__spinner" aria-hidden="true" />
      {mutation.error ? <InlineError error={mutation.error} /> : null}
      <button type="button" className="buyer-v2__button buyer-v2__button--primary" disabled={mutation.status === "pending"} onClick={confirm} aria-busy={mutation.status === "pending"}>{mutation.status === "pending" ? "Retrying setup…" : "Retry setup"}</button>
      {orderId ? <RouterLink className="buyer-v2__button buyer-v2__button--secondary" to={`/portal/orders/${encodeURIComponent(orderId)}`} navigate={navigate}>View confirmed order</RouterLink> : null}
    </StatePanel></div>;
  }

  if (checkout.status === "requires_action") {
    return <div className="buyer-v2__container buyer-v2__page"><StatePanel eyebrow="Payment verification" title="One more payment step is required." body="Your order has not been granted yet. Complete the provider verification, then Hatch will read the authoritative payment status.">
      {checkout.payment_redirect_url ? <button type="button" className="buyer-v2__button buyer-v2__button--primary" onClick={() => openPayment(checkout.payment_redirect_url)}>Continue verification</button> : null}
      <button type="button" className="buyer-v2__button buyer-v2__button--secondary" onClick={resource.reload}>Check payment status</button>
    </StatePanel></div>;
  }

  if (paymentPending) {
    return <div className="buyer-v2__container buyer-v2__page"><StatePanel eyebrow="Payment processing" title="We’re confirming your payment…" body="Do not submit another order. Hatch is polling the provider-backed payment record."><span className="buyer-v2__spinner" aria-hidden="true" /><button type="button" className="buyer-v2__button buyer-v2__button--secondary" onClick={resource.reload}>Check now</button></StatePanel></div>;
  }

  if (checkout.status === "payment_failed") {
    return <div className="buyer-v2__container buyer-v2__page"><StatePanel tone="error" eyebrow="Payment not completed" title="No access was granted." body="The payment failed or was cancelled. Return to the current product offer to start a fresh checkout."><RouterLink className="buyer-v2__button buyer-v2__button--primary" to={productPath(product)} navigate={navigate}>Review current offer</RouterLink></StatePanel></div>;
  }

  if (checkout.status === "refunded") {
    return <div className="buyer-v2__container buyer-v2__page"><StatePanel tone="warning" eyebrow="Access setup refunded" title="Your payment was refunded." body="Hatch could not finish access setup within the recovery window, so the original payment was refunded instead of leaving the purchase pending.">{checkout.order_id ? <RouterLink className="buyer-v2__button buyer-v2__button--primary" to={`/portal/orders/${encodeURIComponent(checkout.order_id)}`} navigate={navigate}>View refund receipt</RouterLink> : null}<RouterLink className="buyer-v2__button buyer-v2__button--secondary" to={productPath(product)} navigate={navigate}>Return to product</RouterLink></StatePanel></div>;
  }

  return (
    <div className="buyer-v2__container buyer-v2__page buyer-v2__checkout-page">
      <RouterLink className="buyer-v2__back-link" to={productPath(product)} navigate={navigate}>← Back to product</RouterLink>
      <header className="buyer-v2__page-heading"><span className="buyer-v2__eyebrow">Order confirmation</span><h1>Review the real offer.</h1><p>This order is pinned to the product, release and price shown here.</p></header>
      <div className="buyer-v2__checkout-grid">
        <section className="buyer-v2__receipt-card">
          <div className="buyer-v2__receipt-product"><span>{creatorName(checkout.creator || product)}</span><h2>{productName(product)}</h2><p>{productPromise(product)}</p></div>
          <DefinitionList rows={[
            ["Release", checkout.release_label || checkout.release_snapshot?.label || product.release_label || "Current approved release"],
            ["Delivery units", String(offer.included_units ?? checkout.entitlement_scope?.included_units ?? 1)],
            ["Access", checkout.entitlement_scope?.label || offerUnitLabel(offer) || "Per delivery"],
            ["Payment", total === 0 ? "No payment required" : checkout.payment_method_summary || "Secure payment"],
            ["Terms", checkout.refund_policy?.summary || checkout.refund_policy_summary || "The offer policy shown at checkout applies"]
          ]} />
        </section>
        <aside className="buyer-v2__order-summary">
          <span className="buyer-v2__eyebrow">Order summary</span>
          <PriceRow label="Subtotal" value={money(numberOr(totals.subtotal_minor, total), offer.currency)} />
          {totals.discount_minor ? <PriceRow label="Discount" value={`−${money(totals.discount_minor, offer.currency)}`} /> : null}
          <PriceRow label="Tax" value={totals.tax_minor == null ? "Not calculated" : money(totals.tax_minor, offer.currency)} />
          <PriceRow label="Total" value={money(total, offer.currency)} total />
          <label className="buyer-v2__checkbox"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} disabled={expired} /><span>I confirm this offer and its refund terms.</span></label>
          {expired ? <div className="buyer-v2__inline-notice" role="status">This checkout is no longer current. Return to the product to review the latest offer.{quoteChange?.previous_offer || quoteChange?.current_offer ? <dl className="buyer-v2__quote-change"><div><dt>Previously quoted</dt><dd>{quoteChange.previous_offer ? offerLabel(quoteChange.previous_offer) : "Unavailable"}</dd></div><div><dt>Current offer</dt><dd>{quoteChange.current_offer ? offerLabel(quoteChange.current_offer) : "No longer for sale"}</dd></div></dl> : null}</div> : null}
          {mutation.error ? <InlineError error={mutation.error} /> : null}
          <button type="button" className="buyer-v2__button buyer-v2__button--primary buyer-v2__button--wide" disabled={!accepted || expired || mutation.status === "pending"} onClick={confirm} aria-busy={mutation.status === "pending"}>{mutation.status === "pending" ? total === 0 ? "Adding to your account…" : "Opening payment…" : total === 0 ? "Add to my account" : `Pay ${money(total, offer.currency)}`}</button>
          <small>Amount, Creator and release are resolved by the server. This page never submits its displayed price as authority.</small>
        </aside>
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
  if (resource.status === "error" && resource.error?.status >= 500) return <div className="buyer-v2__container buyer-v2__page"><StatePanel tone="warning" eyebrow="Receipt syncing" title="Purchase completed; receipt temporarily unavailable." body="Do not place another order. Hatch is retaining the confirmed purchase and will reload the receipt when the service recovers."><button type="button" className="buyer-v2__button buyer-v2__button--primary" onClick={resource.reload}>Try receipt again</button></StatePanel></div>;
  if (resource.status === "error") return <div className="buyer-v2__container buyer-v2__page"><RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo={`/portal/orders/${id}/success`} /></div>;

  const { order, entitlement, entitlementError } = data;
  const product = order.product_snapshot || order.product || order;
  const amount = orderAmount(order);
  const entitlementId = order.entitlement_id || entitlement?.entitlement_id || entitlement?.id;

  if (failed) {
    return <div className="buyer-v2__container buyer-v2__page"><StatePanel tone="error" eyebrow="Payment not completed" title="Your account was not charged successfully." body="No access was granted. Return to the order to review the payment status and available recovery action."><RouterLink className="buyer-v2__button buyer-v2__button--primary" to={`/portal/orders/${encodeURIComponent(id)}`} navigate={navigate}>View order</RouterLink></StatePanel></div>;
  }

  if (!ready) {
    return <div className="buyer-v2__container buyer-v2__page"><StatePanel eyebrow="Confirming payment" title="We’re confirming your order…" body="Do not submit another order. This page reads the authoritative payment and access status and updates automatically."><span className="buyer-v2__spinner" aria-hidden="true" /><RouterLink className="buyer-v2__button buyer-v2__button--secondary" to={`/portal/orders/${encodeURIComponent(id)}`} navigate={navigate}>View order status</RouterLink></StatePanel></div>;
  }

  return (
    <div className="buyer-v2__container buyer-v2__page buyer-v2__success-page">
      <section className="buyer-v2__success-hero">
        <span className="buyer-v2__success-mark" aria-hidden="true">✓</span>
        <span className="buyer-v2__eyebrow">Access granted</span>
        <h1>{productName(product)} is ready.</h1>
        <p>Order #{orderReference(order)} · {amount === 0 ? "Free" : money(amount, order.currency)} · Access granted</p>
        {entitlementError ? <div className="buyer-v2__inline-notice" role="status">Purchase completed; some access details are temporarily unavailable. <button type="button" onClick={resource.reload}>Retry</button></div> : null}
        <div className="buyer-v2__success-actions">
          <a className="buyer-v2__button buyer-v2__button--primary" href={desktopUrl(entitlement, product)} onClick={() => trackPortalEvent(request, "desktop_open_clicked", productTelemetry(product))}>Open Hatch Desktop</a>
          <a className="buyer-v2__button buyer-v2__button--secondary" href={downloadUrl} target="_blank" rel="noreferrer" onClick={() => trackPortalEvent(request, "desktop_download_clicked", productTelemetry(product))}>Download Hatch Desktop</a>
        </div>
      </section>
      <section className="buyer-v2__next-steps">
        <span className="buyer-v2__eyebrow">What happens next</span>
        <ol><li><span>1</span>Sign in to Desktop with this account.</li><li><span>2</span>Choose this Agent and a Workspace.</li><li><span>3</span>Review local permissions before changes.</li></ol>
        <div className="buyer-v2__detail-links">
          <RouterLink to={`/portal/orders/${encodeURIComponent(id)}`} navigate={navigate}>View order receipt →</RouterLink>
          {entitlementId ? <RouterLink to={`/portal/library/${encodeURIComponent(entitlementId)}`} navigate={navigate}>View access details →</RouterLink> : null}
        </div>
      </section>
    </div>
  );
}

function LibraryPage({ search, request, navigate }) {
  const params = new URLSearchParams(search);
  const filter = ["active", "past"].includes(params.get("status")) ? params.get("status") : "all";
  const resource = useCursorCollection(async (cursor, signal) => {
    const query = new URLSearchParams();
    if (filter !== "all") query.set("status", filter);
    if (cursor) query.set("cursor", cursor);
    const response = await callRequest(request, `${BUYER_PORTAL_V2_ENDPOINTS.entitlements}?${query}`, { signal });
    return pageFrom(response, ["entitlements", "creator_agents", "items"]);
  }, `entitlements:${filter}`);
  usePageTitle("Your Agent library");

  function setFilter(next) {
    navigateTo(navigate, next === "all" ? "/portal/library" : `/portal/library?status=${next}`);
  }

  return (
    <div className="buyer-v2__container buyer-v2__page">
      <header className="buyer-v2__page-heading"><span className="buyer-v2__eyebrow">Your library</span><h1>Agents your account can use.</h1><p>Access, release policy and remaining delivery units stay visible here.</p></header>
      <div className="buyer-v2__filters" role="group" aria-label="Library filter">{[["all", "All"], ["active", "Active"], ["past", "Past access"]].map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>
      {resource.status === "loading" ? <CardSkeleton count={2} label="Loading your library" /> : null}
      {resource.status === "error" ? <RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo="/portal/library" /> : null}
      {resource.status === "ready" && resource.items.length ? <section className="buyer-v2__list-grid" aria-label="Your entitlements">{resource.items.map((item) => <EntitlementCard key={entitlementIdFor(item)} entitlement={item} navigate={navigate} />)}</section> : null}
      {resource.status === "ready" && !resource.items.length ? <EmptyState title={filter === "all" ? "Your library is empty" : "No access in this view"} body={filter === "all" ? "Explore Creator Agents and choose a method that fits your task." : "Choose another filter or explore available Creator Agents."} action={<RouterLink className="buyer-v2__button buyer-v2__button--primary" to="/agents" navigate={navigate}>Explore Agents</RouterLink>} /> : null}
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
      <div className="buyer-v2__card-footer"><span>{unitsLabel(entitlement)}</span><RouterLink className="buyer-v2__button buyer-v2__button--secondary" to={`/portal/library/${encodeURIComponent(id)}`} navigate={navigate}>View access</RouterLink></div>
    </article>
  );
}

function EntitlementPage({ id, request, navigate, session, downloadUrl }) {
  const endpoint = `${BUYER_PORTAL_V2_ENDPOINTS.entitlements}/${encodeURIComponent(id)}`;
  const resource = useRemote(async (signal) => unwrap(await callRequest(request, endpoint, { signal }), ["entitlement"]), endpoint);
  usePageTitle(resource.data ? `${productName(resource.data.product || resource.data)} access` : "Access details");
  useUnauthorized(resource.error, session);
  if (resource.status === "loading") return <div className="buyer-v2__container buyer-v2__page"><DetailSkeleton /></div>;
  if (resource.status === "error") return <div className="buyer-v2__container buyer-v2__page"><RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo={`/portal/library/${id}`} /></div>;

  const entitlement = resource.data;
  const product = entitlement.product || entitlement.product_snapshot || entitlement;
  const status = accessStatus(entitlement);
  const deliveries = arrayValue(entitlement.deliveries || entitlement.delivery_history, []);
  const orderId = entitlement.order_id || entitlement.order?.order_id || entitlement.order?.id;
  const canOpen = ["active", "reserved"].includes(status);
  return (
    <div className="buyer-v2__container buyer-v2__page">
      <RouterLink className="buyer-v2__back-link" to="/portal/library" navigate={navigate}>← Back to Library</RouterLink>
      <header className="buyer-v2__detail-heading"><div><span className="buyer-v2__eyebrow">Access details</span><h1>{productName(product)}</h1><p>by {creatorName(entitlement.creator || product)}</p></div><StatusChip status={status} label={entitlementStatusLabel(status)} /></header>
      <div className="buyer-v2__detail-grid">
        <section className="buyer-v2__detail-card"><h2>Your entitlement</h2><DefinitionList rows={[
          ["Status", entitlementStatusLabel(status)],
          ["Remaining units", unitsLabel(entitlement)],
          ["Release", entitlement.release_label || entitlement.release?.label || entitlement.release_id || "Pinned purchase release"],
          ["Purchased version", entitlement.purchased_corpus_digest || entitlement.corpus_digest || "—"],
          ["Effective version", entitlement.effective_corpus_digest || entitlement.purchased_corpus_digest || entitlement.corpus_digest || "—"],
          ["Version policy", versionPolicyLabel(entitlement.version_policy)],
          ["Valid from", dateTime(entitlement.valid_from || entitlement.granted_at || entitlement.created_at)],
          ["Expires", entitlement.expires_at ? dateTime(entitlement.expires_at) : "No scheduled expiry"],
          ["Refund / cancellation", entitlement.refund_status || entitlement.cancellation_status || (status === "revoked" ? "Access revoked" : "None")],
          ["Support reference", entitlement.entitlement_id || entitlement.id]
        ]} />{orderId ? <RouterLink className="buyer-v2__text-link" to={`/portal/orders/${encodeURIComponent(orderId)}`} navigate={navigate}>View originating order →</RouterLink> : null}</section>
        <aside className="buyer-v2__activation-card"><span className="buyer-v2__eyebrow">Desktop activation</span><h2>{canOpen ? "Continue in your Workspace." : entitlementRecoveryTitle(status)}</h2><p>{entitlementRecoveryCopy(status)}</p>{canOpen ? <a className="buyer-v2__button buyer-v2__button--primary" href={desktopUrl(entitlement, product)} onClick={() => trackPortalEvent(request, "desktop_open_clicked", productTelemetry(product))}>Open Hatch Desktop</a> : null}<a className="buyer-v2__secondary-download" href={downloadUrl} target="_blank" rel="noreferrer" onClick={() => trackPortalEvent(request, "desktop_download_clicked", productTelemetry(product))}>Download Hatch Desktop</a></aside>
      </div>
      <section className="buyer-v2__timeline-section"><div><span className="buyer-v2__eyebrow">Delivery history</span><h2>Activity, without your private content.</h2><p>Only delivery metadata and artifact type appear on Web. Workspace paths, source files and conversations stay private.</p></div>{deliveries.length ? <Timeline entries={deliveries.map(deliveryTimelineEntry)} /> : <EmptyState compact title="No deliveries yet" body="Open Hatch Desktop when you are ready to use this access." />}</section>
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
      <header className="buyer-v2__page-heading"><span className="buyer-v2__eyebrow">Order history</span><h1>Your complete receipts.</h1><p>Amounts, payment, access, delivery and refund remain separate and traceable.</p></header>
      <label className="buyer-v2__select-label">Order status<select value={filter} onChange={(event) => navigateTo(navigate, event.target.value === "all" ? "/portal/orders" : `/portal/orders?status=${encodeURIComponent(event.target.value)}`)}><option value="all">All orders</option><option value="fulfilled">Fulfilled</option><option value="pending">Pending</option><option value="refunded">Refunded</option></select></label>
      {resource.status === "loading" ? <ListSkeleton label="Loading orders" /> : null}
      {resource.status === "error" ? <RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo="/portal/orders" /> : null}
      {resource.status === "ready" && resource.items.length ? <section className="buyer-v2__order-list" aria-label="Orders">{resource.items.map((order) => <OrderRow key={orderIdFor(order)} order={order} navigate={navigate} />)}</section> : null}
      {resource.status === "ready" && !resource.items.length ? <EmptyState title="No orders in this view" body="Orders appear after you confirm a free or paid offer." action={<RouterLink className="buyer-v2__button buyer-v2__button--primary" to="/agents" navigate={navigate}>Explore Agents</RouterLink>} /> : null}
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
      <RouterLink className="buyer-v2__button buyer-v2__button--secondary" to={`/portal/orders/${encodeURIComponent(id)}`} navigate={navigate}>View order</RouterLink>
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
      await callRequest(request, `${endpoint}/refund-requests`, jsonMutation("POST", { reason: "buyer_requested" }, refundIntentKey.current));
      setRefundState({ status: "succeeded", error: null });
      resource.reload();
    } catch (error) {
      setRefundState({ status: "error", error });
    }
  }

  if (resource.status === "loading") return <div className="buyer-v2__container buyer-v2__page"><DetailSkeleton /></div>;
  if (resource.status === "error") return <div className="buyer-v2__container buyer-v2__page"><RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} returnTo={`/portal/orders/${id}`} /></div>;
  const order = resource.data;
  const product = order.product_snapshot || order.product || order;
  const entitlementId = order.entitlement_id || order.entitlement?.entitlement_id || order.entitlement?.id;
  const entries = orderTimeline(order);
  const canRefund = Boolean(order.actions?.can_request_refund || order.can_request_refund);
  const canCancelAccess = Boolean(order.actions?.can_cancel_access || order.can_cancel_access);
  const canReverseOrder = canRefund || canCancelAccess;
  const reversalLabel = canCancelAccess ? "Remove free access" : "Request refund";
  const reversalSuccess = canCancelAccess ? "Free access removed." : "Refund request received.";
  const totalMinor = orderAmount(order);
  const subtotalMinor = numberOr(order.subtotal_minor, totalMinor);
  const discountMinor = numberOr(order.discount_minor, 0);
  const taxLabel = order.tax_minor == null ? "Not calculated" : money(numberOr(order.tax_minor, 0), order.currency);

  return (
    <div className="buyer-v2__container buyer-v2__page">
      <RouterLink className="buyer-v2__back-link" to="/portal/orders" navigate={navigate}>← Back to Orders</RouterLink>
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
          ["Offer", order.offer_snapshot ? `${offerLabel(order.offer_snapshot)} · ${offerUnitLabel(order.offer_snapshot)}` : order.offer_label || "Purchase-time offer snapshot"],
          ["Release", order.release_snapshot?.label || order.release_snapshot?.release_id || order.release_label || order.release_id || "Purchase-time release"]
        ]} />{entitlementId ? <RouterLink className="buyer-v2__text-link" to={`/portal/library/${encodeURIComponent(entitlementId)}`} navigate={navigate}>View access details →</RouterLink> : null}</section>
        <aside className="buyer-v2__order-actions"><span className="buyer-v2__eyebrow">Order actions</span><h2>{orderActionTitle(order)}</h2><p>{orderActionCopy(order)}</p>{successReady(order, order.entitlement) ? <RouterLink className="buyer-v2__button buyer-v2__button--primary" to={`/portal/orders/${encodeURIComponent(id)}/success`} navigate={navigate}>Open activation steps</RouterLink> : null}{canReverseOrder ? <button className="buyer-v2__button buyer-v2__button--secondary" type="button" disabled={refundState.status === "pending"} onClick={requestRefund}>{refundState.status === "pending" ? "Submitting request…" : reversalLabel}</button> : null}{refundState.error ? <InlineError error={refundState.error} /> : null}{refundState.status === "succeeded" ? <div className="buyer-v2__inline-notice" role="status">{reversalSuccess}</div> : null}</aside>
      </div>
      <section className="buyer-v2__timeline-section"><div><span className="buyer-v2__eyebrow">Commerce timeline</span><h2>What happened, in order.</h2></div><Timeline entries={entries} /></section>
    </div>
  );
}

function NotFoundPage({ navigate }) {
  usePageTitle("Page not found");
  return <div className="buyer-v2__container buyer-v2__page"><StatePanel eyebrow="404" title="This page is not available." body="The link may be incomplete, or this public product may have been removed."><RouterLink className="buyer-v2__button buyer-v2__button--primary" to="/agents" navigate={navigate}>Browse Creator Agents</RouterLink></StatePanel></div>;
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
  return <section className={`buyer-v2__state-panel buyer-v2__state-panel--${tone}`}><span className="buyer-v2__eyebrow">{eyebrow}</span><h1>{title}</h1><p>{body}</p><div className="buyer-v2__state-actions">{children}</div></section>;
}

function EmptyState({ title, body, action, compact = false }) {
  return <section className={`buyer-v2__empty${compact ? " buyer-v2__empty--compact" : ""}`}><span aria-hidden="true">○</span><h2>{title}</h2><p>{body}</p>{action}</section>;
}

function RouteError({ error, onRetry, navigate, returnTo }) {
  const status = error?.status;
  if (status === 401) return <StatePanel tone="error" eyebrow="Session expired" title="Sign in to continue." body="Your task is safe. After signing in, you’ll return to this page."><RouterLink className="buyer-v2__button buyer-v2__button--primary" to={`/sign-in?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`} navigate={navigate}>Sign in</RouterLink></StatePanel>;
  if (status === 403) return <StatePanel tone="error" eyebrow="Access denied" title="This account cannot view that resource." body="Return to a page available to this account."><RouterLink className="buyer-v2__button buyer-v2__button--primary" to="/agents" navigate={navigate}>Browse Agents</RouterLink></StatePanel>;
  if (status === 404) return <StatePanel tone="error" eyebrow="Not found" title="That resource is no longer available." body="A previous receipt may still be available from your Orders."><RouterLink className="buyer-v2__button buyer-v2__button--primary" to="/portal/orders" navigate={navigate}>View Orders</RouterLink></StatePanel>;
  if (status === 409) return <StatePanel tone="error" eyebrow="Details changed" title="Review the latest version before continuing." body={friendlyError(error)}><button type="button" className="buyer-v2__button buyer-v2__button--primary" onClick={onRetry}>Refresh details</button></StatePanel>;
  return <StatePanel tone="error" eyebrow="Couldn’t load this page" title="Your task is still here." body={friendlyError(error)}><button type="button" className="buyer-v2__button buyer-v2__button--primary" onClick={onRetry}>Try again</button></StatePanel>;
}

function InlineError({ error }) {
  return <div className="buyer-v2__inline-error" role="alert">{friendlyError(error)}</div>;
}

function StatusChip({ status, label }) {
  return <span className={`buyer-v2__status buyer-v2__status--${cssToken(status || "unknown")}`}>{label}</span>;
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
  return <div className="buyer-v2__load-more">{resource.moreError ? <InlineError error={resource.moreError} /> : null}<button className="buyer-v2__button buyer-v2__button--secondary" type="button" disabled={resource.loadingMore} onClick={resource.loadMore}>{resource.loadingMore ? "Loading…" : "Load more"}</button></div>;
}

function RouterLink({ to, navigate, onClick, children, ...props }) {
  function handleClick(event) {
    onClick?.(event);
    if (event.defaultPrevented || !navigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target) return;
    event.preventDefault();
    navigate(to);
  }
  return <a {...props} href={to} onClick={handleClick}>{children}</a>;
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
  const offer = offerFor(product);
  return {
    creator_id: product?.creator_id ?? product?.creator?.id,
    product_id: productId(product),
    offer_id: offerId(offer),
    offer_revision: offer?.revision,
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
  const pathname = String(value || "/agents").split("#")[0].split("?")[0];
  if (!pathname.startsWith("/")) return "/agents";
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

function normalizeSearch(value) {
  if (!value) return "";
  return String(value).startsWith("?") ? String(value) : `?${value}`;
}

function safeReturnTo(value) {
  const candidate = String(value || "");
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\") || /[\u0000-\u001f]/.test(candidate)) return "/agents";
  const pathname = candidate.split("?")[0].split("#")[0];
  const allowed = pathname === "/agents" || pathname.startsWith("/agents/") || pathname.startsWith("/portal/") || pathname.startsWith("/account/");
  return allowed ? candidate : "/agents";
}

function navigateTo(navigate, to, options) {
  if (typeof navigate === "function") return navigate(to, options);
  if (typeof window !== "undefined") {
    if (options?.replace) window.location.replace(to);
    else window.location.assign(to);
  }
  return undefined;
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

function offerFor(value) {
  if (!value) return null;
  const nested = value.active_offer || value.offer || value.offer_snapshot;
  if (nested) return nested;
  if (value.price_minor != null || value.amount_minor != null) return { offer_id: value.offer_id, amount_minor: value.amount_minor ?? value.price_minor, currency: value.currency, model: value.pricing_model || value.purchase_model, unit: value.unit, included_units: value.included_units };
  return null;
}

function accessFor(value) {
  return value?.entitlement || value?.access || (value?.entitlement_status ? { status: value.entitlement_status } : null);
}

function productId(value) { return value?.product_id || value?.product?.id || value?.product?.product_id || value?.id; }
function offerId(value) { return value?.offer_id || value?.id || value?.revision_id; }
function productName(value) { return value?.product_name || value?.name || value?.product?.name || "Creator Agent"; }
function productPromise(value) { return value?.promise || value?.product_description || value?.description || value?.product?.promise || value?.product?.description || "A practical Creator method for work in your own Workspace."; }
function creatorName(value) { return value?.creator_name || value?.creator_display_name || value?.display_name || value?.name || value?.creator?.display_name || value?.creator?.name || value?.creator?.handle || "Hatch Creator"; }
function creatorId(value) { return value?.creator_id || value?.creator_slug || value?.creator?.id || value?.creator?.slug || ""; }
function entitlementIdFor(value) { return value?.entitlement_id || value?.id || `${value?.creator_id || "creator"}:${value?.agent_id || productId(value)}`; }
function orderIdFor(value) { return value?.order_id || value?.id; }

function productPath(value) {
  const creator = value?.creator_slug || value?.creator?.slug || value?.creator_id || value?.creator?.id || "creator";
  const product = value?.product_slug || value?.slug || productId(value) || value?.agent_id || "agent";
  return `/agents/${encodeURIComponent(creator)}/${encodeURIComponent(product)}`;
}

function productKey(value) { return `${value?.creator_id || value?.creator_slug || value?.creator?.id || "creator"}:${productId(value) || value?.agent_id || value?.product_slug || "product"}`; }

function offerAmount(offer) {
  if (!offer) return null;
  return numberOr(offer.amount_minor, numberOr(offer.price_minor, null));
}

function offerLabel(offer) {
  const amount = offerAmount(offer);
  if (amount == null) return "Not for sale";
  if (amount === 0) return "Free";
  return money(amount, offer.currency);
}

function offerUnitLabel(offer) {
  if (!offer) return "No active offer";
  const model = offer.purchase_model || offer.model || offer.pricing_model;
  const unit = offer.unit || offer.billing_unit;
  if (model === "subscription") return offer.interval ? `per ${offer.interval}` : "subscription";
  if (unit === "delivery" || model === "per_delivery") return "per delivery";
  return unit ? `per ${String(unit).replaceAll("_", " ")}` : "account access";
}

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
  return ({ active: "Active", reserved: "In progress", pending: "Setting up", consumed: "Consumed", expired: "Expired", suspended: "Suspended", revoked: "Revoked", none: "No access" })[status] || sentenceCase(status);
}

function entitlementSummary(value) {
  const status = accessStatus(value);
  if (status === "reserved") return "A delivery unit is reserved for work already in progress.";
  if (status === "consumed") return "The included delivery has been used. Your receipt remains available.";
  if (status === "expired") return "This access has expired. Review the current offer to renew.";
  if (["suspended", "revoked"].includes(status)) return value.status_reason_label || "Access is unavailable. Review the recovery details.";
  return value.summary || "Open Hatch Desktop with this account and choose a Workspace.";
}

function unitsLabel(value) {
  if (value.remaining_units == null && value.units_remaining == null) return value.unlimited ? "Unlimited deliveries" : "Access details";
  const units = Number(value.remaining_units ?? value.units_remaining);
  return `${units} ${units === 1 ? "delivery" : "deliveries"} available`;
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
  if (orderStatus(order) === "cancelled") return "Free access was removed.";
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
  return { id: delivery.delivery_id || delivery.id, label: `Delivery ${sentenceCase(status)}`, detail: delivery.artifact_type ? `Artifact type: ${sentenceCase(delivery.artifact_type)}` : delivery.summary, time: delivery.completed_at || delivery.started_at || delivery.created_at, tone: status === "failed" ? "error" : "" };
}

function versionPolicyLabel(value) {
  if (!value || value === "pinned") return "Pinned to purchased release";
  if (value === "compatible_tracking") return "Compatible release updates allowed";
  return sentenceCase(value);
}

function entitlementRecoveryTitle(status) {
  if (status === "consumed") return "This delivery has been used.";
  if (status === "expired") return "This access has expired.";
  if (status === "pending") return "Access is still being prepared.";
  return "Desktop activation is unavailable.";
}

function entitlementRecoveryCopy(status) {
  if (["consumed", "expired"].includes(status)) return "Return to the public product to review the current offer before purchasing another delivery.";
  if (status === "pending") return "Keep this page and order receipt; fulfillment will update without another checkout.";
  return "Review the originating order for a reason and available support action.";
}

function desktopUrl(entitlement, product) {
  const params = new URLSearchParams();
  const entitlementId = entitlement?.entitlement_id || entitlement?.id;
  if (entitlementId) params.set("entitlement", entitlementId);
  const id = productId(product);
  if (id) params.set("product", id);
  return `hatch://agents/open${params.toString() ? `?${params}` : ""}`;
}

function refundCopy(product) {
  return product.refund_policy?.summary || product.refund_policy_summary || "The purchase-time refund policy is shown again before final confirmation and stays attached to your receipt.";
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
  if (error.code === "offer_changed") return "The offer changed after this checkout began. Refresh and confirm the latest amount and scope.";
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
