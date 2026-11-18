import React, { useEffect, useMemo, useState } from "react";
import { useAnalytics } from "./analytics/AnalyticsProvider.jsx";
import { agentPageViewed, chatStarted, errorShown, ownAgentOpened, signupStarted, viaFromReferrer } from "./analytics/events.js";
import { withTracking } from "./analytics/tracking.js";
import { AlertCircle, ArrowRight, Inbox, Pencil, SearchX } from "lucide-react";
import {
  Button,
  InlineAlert as HatchInlineAlert,
  Input,
  SegmentedControl,
} from "@hatch/ui";
import { WebBrand } from "./WebBrand.jsx";
import { StorefrontDetails } from "./StorefrontDetails.jsx";
import { AccountAvatar } from "./AccountAvatar.jsx";
import { useLocale } from "./locale.jsx";
import { buyerT } from "./buyerI18n.js";
import { createAuthPagePresentation } from "./authPagePresentation.js";
import { creatorPublicModel } from "./storefrontModel.js";
import { exploreModel, removeFromLibrary } from "./exploreModel.js";
import { BuyerAccountControls, BuyerLanguageMenu } from "./BuyerAccountControls.jsx";
import { AccountAvatarSettings } from "./AccountAvatarSettings.jsx";
import "./buyerPortalV2.css";

const EXPLORE_ROOT = "/explore";
const STUDIO_ROOT = "/studio";
const LIBRARY_ROOT = "/library";
const ACCOUNT_ROOT = "/account";
const PUBLIC_ROUTE_NAMES = new Set(["catalog", "library", "creator", "product", "sign-in", "sign-up", "account-help", "not-found"]);
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
 *   { status: "loading" | "anonymous" | "authenticated", user?, signIn?, signUp?, signOut?, invalidate? }
 *
 *   GET    /v1/public/products -> Product[] | { products: Product[] }
 *   GET    /v1/public/products/:product_id -> Product | { product: Product, agent?: Product }
 *   GET    /v1/library?status=active -> { entitlements: LibraryItem[], next_cursor? }
 *   DELETE /v1/library/:product_id -> { removed: boolean }
 *
 * Anyone can chat with any live Agent, signed in or not. Chatting saves it to the
 * account's library; the library is only a list to reopen it from.
 */
export const BUYER_PORTAL_V2_ENDPOINTS = Object.freeze({
  catalog: "/v1/public/products",
  library: "/v1/library"
});

export function BuyerPortalV2({
  pathname = EXPLORE_ROOT,
  search = "",
  navigate,
  request,
  session = { status: "anonymous" }
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
  if (route.name === "catalog" || route.name === "library") {
    page = <ExplorePage tab={route.name === "library" ? "library" : "discover"} request={request} navigate={navigate} session={session} />;
  } else if (route.name === "creator") {
    page = <CreatorPublicPage creatorId={route.params.creatorId} request={request} navigate={navigate} session={session} />;
  } else if (route.name === "product") {
    page = <ProductPage route={route} request={request} navigate={navigate} session={session} />;
  } else if (route.name === "sign-in" || route.name === "sign-up") {
    return <AuthPage mode={route.name} search={location.search} request={request} navigate={navigate} session={session} />;
  } else if (route.name === "settings") {
    page = <SettingsPage session={session} request={request} navigate={navigate} />;
  } else if (route.name === "account-help") {
    page = <AccountHelpPage session={session} navigate={navigate} />;
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
  if (segments.length === 1 && segments[0] === "library") return { name: "library", params: {} };
  if (segments.length === 1 && segments[0] === "sign-in") return { name: "sign-in", params: {} };
  if (segments.length === 1 && segments[0] === "sign-up") return { name: "sign-up", params: {} };
  if (segments.length === 2 && segments[0] === "account" && segments[1] === "help") return { name: "account-help", params: {} };
  if (segments.length === 1 && segments[0] === "account") return { name: "settings", params: {} };
  return { name: "not-found", params: {} };
}

function BuyerShell({ route, navigate, session, children }) {
  const t = useBuyerCopy();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(null);
  const authenticated = session.status === "authenticated";
  const exploring = ["catalog", "library", "creator", "product"].includes(route.name);

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
          <WebBrand as={RouterLink} className="buyer-v2__brand" to="/" navigate={navigate} aria-label={t("Hatch home")} />
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
function Notice({ icon: Icon, media, title, body, children, tone = "neutral", headingLevel = 2 }) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <section className={`buyer-v2__notice web-card is-${tone}`}>
      {media}
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

function ExplorePage({ tab, request, navigate, session }) {
  const t = useBuyerCopy();
  const library = tab === "library";
  usePageTitle(library ? t("My library") : t("Explore"));
  const authenticated = session.status === "authenticated";
  const accountId = authenticated ? session.user?.id : null;
  const resource = useRemote(async (signal) => {
    const [catalog, owned, saved] = await Promise.all([
      callRequest(request, BUYER_PORTAL_V2_ENDPOINTS.catalog, { signal }),
      authenticated ? callRequest(request, "/v1/creator/products", { signal }) : null,
      authenticated ? loadLibrary(request, signal) : []
    ]);
    return exploreModel({
      accountId,
      ownedProducts: collectionFrom(owned, ["products"]),
      saved,
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
      <SegmentedControl
        className="buyer-v2__explore-tabs"
        ariaLabel={t("Explore")}
        value={tab}
        onValueChange={(value) => navigateTo(navigate, value === "library" ? LIBRARY_ROOT : EXPLORE_ROOT)}
        items={[{ value: "discover", label: t("Discover") }, { value: "library", label: t("My library") }]}
      />
      <PageIntro title={library ? t("My library") : t("Discover")} />
      {library
        ? <LibraryPanel resource={resource} request={request} navigate={navigate} session={session} />
        : discover}
    </div>
  );
}

/** The Agents this account keeps to come back to, and the ones it published. Signed out, the library asks to sign in. */
function LibraryPanel({ resource, request, navigate, session }) {
  const t = useBuyerCopy();
  const [removed, setRemoved] = useState(() => new Set());
  const [failure, setFailure] = useState(null);
  const model = resource.data;

  async function remove(row) {
    setFailure(null);
    setRemoved((current) => new Set(current).add(row.productId));
    try {
      await removeFromLibrary(request, row.productId);
      resource.reload();
    } catch (error) {
      setRemoved((current) => { const next = new Set(current); next.delete(row.productId); return next; });
      setFailure(error);
    }
  }

  if (session.status === "anonymous") return <Notice icon={Inbox} title={t("Sign in to see your library")}><LinkButton className="web-btn-yolk" to={`/sign-in?returnTo=${encodeURIComponent(LIBRARY_ROOT)}`} navigate={navigate}>{t("Sign in")}</LinkButton></Notice>;
  if (resource.status === "error") return <RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} session={session} returnTo={LIBRARY_ROOT} />;
  if (!model) return <ListSkeleton label={t("Loading Agents")} />;
  const saved = model.saved.filter((row) => !removed.has(row.productId));
  const draftsLink = model.draftCount ? <RouterLink to={STUDIO_ROOT} navigate={navigate}>{t("{count} in progress in Studio →", { count: model.draftCount })}</RouterLink> : null;
  if (!saved.length && !model.published.length) return <EmptyState title={t("Your library is empty")} action={<><LinkButton className="web-btn-yolk" to={EXPLORE_ROOT} navigate={navigate}>{t("Browse Agents")}</LinkButton><LinkButton variant="secondary" to={STUDIO_ROOT} navigate={navigate}>{t("Open Studio")}</LinkButton></>} />;
  return (
    <div className="buyer-v2__library">
      {failure ? <InlineError error={failure} /> : null}
      {saved.length ? <MyAgentsGroup id="library-saved" title={t("Saved")} rows={saved} navigate={navigate} onRemove={remove} /> : null}
      <MyAgentsGroup id="library-published" title={t("Published by me")} rows={model.published} navigate={navigate}
        links={model.published.length ? draftsLink : <>{draftsLink}<RouterLink to={`${STUDIO_ROOT}/products/new`} navigate={navigate}>{t("Publish your first Agent in Studio →")}</RouterLink></>} />
    </div>
  );
}

function MyAgentsGroup({ id, title, rows, navigate, links, onRemove }) {
  const t = useBuyerCopy();
  return (
    <section className="buyer-v2__my-group" aria-labelledby={id}>
      <h3 id={id} className="buyer-v2__my-group-title">{title}</h3>
      {rows.length ? <ul className="buyer-v2__my-agents">
        {rows.map((row) => (
          <li key={row.key}>
            <RouterLink className="buyer-v2__my-agent" to={row.href} navigate={navigate}>
              <AccountAvatar className="buyer-v2__creator-avatar" size="medium" src={creatorAvatarUrl(row.creator)} name={row.name || t("Untitled Agent")} />
              <span><strong>{row.name || t("Untitled Agent")}</strong><small>{row.kind === "owned" ? t("Your Agent") : creatorName(row.creator, t)}</small></span>
              <ArrowRight aria-hidden="true" />
            </RouterLink>
            {onRemove ? <Button variant="ghost" size="small" onClick={() => onRemove(row)} aria-label={`${t("Remove")}: ${row.name || t("Untitled Agent")}`}>{t("Remove")}</Button> : null}
          </li>
        ))}
      </ul> : null}
      {links ? <nav className="buyer-v2__side-links" aria-label={title}>{links}</nav> : null}
    </section>
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
  return (
    <RouterLink className="buyer-v2__catalog-card web-card" to={productPath(product)} navigate={navigate}>
      <div className="buyer-v2__card-topline">
        <CreatorIdentity className="buyer-v2__catalog-creator" value={product} />
        {product.creator_verified || product.creator?.verified ? <span className="buyer-v2__verified">{t('Verified')}</span> : null}
      </div>
      <h2>{productName(product, t)}</h2>
      <p>{productPromise(product, t)}</p>
      <div className="buyer-v2__card-footer">
        <span className="buyer-v2__card-go">{t('Details')}<ArrowRight aria-hidden="true" /></span>
      </div>
    </RouterLink>
  );
}

/* ---------- Product ---------- */

function ProductPage({ route, request, navigate, session }) {
  const t = useBuyerCopy();
  const { productId } = route.params;
  const path = `/products/${encodeURIComponent(productId)}`;
  const endpoint = `${BUYER_PORTAL_V2_ENDPOINTS.catalog}/${encodeURIComponent(productId)}`;
  const resource = useRemote(async (signal) => unwrap(await callRequest(request, endpoint, { signal }), ["agent", "product"]), endpoint);
  const product = resource.data;
  usePageTitle(product ? productName(product, t) : t("Agent details"));
  const analytics = useAnalytics();
  useEffect(() => { if (product) analytics.track(agentPageViewed({ agentId: productId, via: viaFromReferrer(document.referrer, window.location.origin) })); }, [analytics, productId, Boolean(product)]);

  if (resource.status === "loading") return <div className="buyer-v2__container buyer-v2__page"><DetailSkeleton /></div>;
  if (resource.status === "error") return <div className="buyer-v2__container buyer-v2__page"><RouteError error={resource.error} onRetry={resource.reload} navigate={navigate} session={session} returnTo={path} /></div>;

  const examples = arrayValue(product.examples || product.proof, []);
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
        releaseLabel={product.release_label || product.release?.label}
        action={<ProductAction product={product} navigate={navigate} session={session} />}
      />

      <section className="buyer-v2__how">
        <h2>{t('How it works')}</h2>
        <ol className="buyer-v2__steps">
          <li className="web-card"><span>1</span><strong>{t('Start a conversation')}</strong></li>
          <li className="web-card"><span>2</span><strong>{t('Pick up where you left off')}</strong><p>{t('Agents you chat with are saved to My library.')}</p></li>
          <li className="web-card"><span>3</span><strong>{t("The expert's own judgment")}</strong><p>{t("Answers draw on this expert's methods and experience, in their own style — not a generic AI answer.")}</p></li>
        </ol>
      </section>

      {examples.length ? <InfoSection title={t('Example questions')} items={examples} /> : null}
    </div>
  );
}

function ProductAction({ product, navigate, session }) {
  const t = useBuyerCopy();
  const id = productId(product);
  const available = Boolean(id) && product.availability === "published" && product.available !== false && product.status !== "withdrawn";
  const isOwner = isOwnProduct(session, product);
  const analytics = useAnalytics();
  useEffect(() => { if (isOwner) analytics.track(ownAgentOpened({ agentId: id })); }, [analytics, isOwner]);
  const trackChat = withTracking(analytics, chatStarted({ agentId: id }))();
  const chat = <LinkButton className="web-btn-yolk" to={`/chat/product/${encodeURIComponent(id)}`} navigate={navigate} onClick={trackChat}>{t(isOwner ? "Go to chat" : "Start chat")}</LinkButton>;

  let contents;
  if (!available) contents = <h2>{t("This product is unavailable")}</h2>;
  else if (isOwner) contents = <><h2>{t("Your Agent")}</h2>{chat}<LinkButton variant="secondary" to={`${STUDIO_ROOT}/products/${encodeURIComponent(id)}`} navigate={navigate}>{t("Manage product")}</LinkButton></>;
  else contents = chat;
  return <div className="buyer-v2__storefront-action">{contents}</div>;
}

/* ---------- Account ---------- */

function SettingsPage({ session, request, navigate }) {
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
  const updateUser = session.updateUser ?? (() => {});
  return <div className="buyer-v2__container buyer-v2__page buyer-v2__narrow">
    <PageIntro title={t('Account')} />
    <section className="buyer-v2__settings-surface web-card" aria-label={t('Signed-in account')}>
      <div className="buyer-v2__settings-identity">
        <AccountAvatar className="buyer-v2__settings-avatar" size="large" src={session.user?.avatar_url} name={name} />
        <div>
          <DisplayNameEditor name={name} request={request} onUserUpdated={updateUser} />
          {session.user?.email ? <p>{session.user.email}</p> : null}
        </div>
      </div>
      <AccountAvatarSettings user={session.user} onUserUpdated={updateUser} t={t} />
      {error ? <InlineError error={error} /> : null}
      <div className="buyer-v2__settings-actions">
        <Button type="button" variant="secondary" loading={status === "pending"} onClick={signOut}>{t('Sign out')}</Button>
      </div>
    </section>
  </div>;
}

// Registry is the authority for the limit; the input only stops obvious overruns.
const MAX_DISPLAY_NAME_LENGTH = 128;

function DisplayNameEditor({ name, request, onUserUpdated }) {
  const t = useBuyerCopy();
  const [draft, setDraft] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const cancel = () => { setDraft(null); setError(null); };
  async function save() {
    const value = draft.trim().replace(/\s+/g, " ");
    if (!value) { setError(new Error(t("Enter a name."))); return; }
    if (value === name) { cancel(); return; }
    setPending(true);
    setError(null);
    try {
      onUserUpdated(await callRequest(request, "/v1/auth/me", jsonMutation("PATCH", { display_name: value })));
      setDraft(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }
  if (draft === null) return <div className="buyer-v2__settings-name">
    <h2>{name}</h2>
    <Button type="button" variant="ghost" size="small" leading={<Pencil aria-hidden="true" />} onClick={() => setDraft(name)}>{t("Edit name")}</Button>
  </div>;
  return <form className="buyer-v2__settings-name-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <Input
      autoFocus
      required
      aria-label={t("Name")}
      autoComplete="name"
      maxLength={MAX_DISPLAY_NAME_LENGTH}
      value={draft}
      disabled={pending}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancel(); } }}
    />
    <Button type="submit" size="small" loading={pending}>{t("Save")}</Button>
    <Button type="button" variant="ghost" size="small" disabled={pending} onClick={cancel}>{t("Cancel")}</Button>
    {error ? <InlineError error={error} /> : null}
  </form>;
}

function AccountHelpPage({ session, navigate }) {
  const t = useBuyerCopy();
  const authenticated = session.status === "authenticated";
  usePageTitle(t("Account help"));
  return <div className="buyer-v2__container buyer-v2__page">
    <PageIntro title={t('Account help')} />
    <div className="buyer-v2__help-cards">
      <article className="buyer-v2__info-card web-card">
        <h2>{authenticated ? t("Check your account") : t("Sign in")}</h2>
        {authenticated ? <small className="buyer-v2__help-account">{t("Signed in as {name}", { name: session.user?.email || session.user?.display_name || t("Hatch account") })}</small> : null}
        <p>{authenticated ? t("If My library is empty, your chats may belong to a different email. Sign out and sign in with that email.") : t("Sign in with the email you used before.")}</p>
        {authenticated
          ? <LinkButton variant="secondary" to={ACCOUNT_ROOT} navigate={navigate}>{t('Account settings')}</LinkButton>
          : <LinkButton className="web-btn-yolk" to="/sign-in?returnTo=%2Faccount%2Fhelp" navigate={navigate}>{t('Sign in')}</LinkButton>}
      </article>
    </div>
  </div>;
}

/* ---------- Auth ---------- */

/** How each platform sign-in reads; the Registry decides which of them are offered. */
const PLATFORM_LOGINS = {
  telegram: { action: "Log in with Telegram", failed: "Telegram login failed. Try again." },
  line: { action: "Log in with LINE", failed: "LINE login failed. Try again." },
  discord: { action: "Log in with Discord", failed: "Discord login failed. Try again." },
};

function AuthPage({ mode, search, request, navigate, session }) {
  const t = useBuyerCopy();
  const signingUp = mode === "sign-up";
  const params = new URLSearchParams(search);
  const returnTo = safeReturnTo(params.get("returnTo") || STUDIO_ROOT);
  const intentRoute = matchBuyerRoute(returnTo.split("?")[0]);
  const productIntent = intentRoute.name === "product";
  const presentation = createAuthPagePresentation(t)({ signingUp, productIntent });
  const intentEndpoint = productIntent ? `${BUYER_PORTAL_V2_ENDPOINTS.catalog}/${encodeURIComponent(intentRoute.params.productId)}` : "";
  const intent = useRemote(async (signal) => unwrap(await callRequest(request, intentEndpoint, { signal }), ["agent", "product"]), intentEndpoint || "no-intent", productIntent);
  const [form, setForm] = useState({ display_name: "", email: "", password: "" });
  const [submission, setSubmission] = useState({ status: "idle", error: null });
  const logins = useRemote(async (signal) => callRequest(request, "/v1/auth/providers", { signal }), "platform-logins");
  const failedLogin = Object.keys(PLATFORM_LOGINS).find((kind) => params.get(kind) === "failed");
  const authBrandClassName = "buyer-v2__brand";
  const photo = signingUp ? "v_morning" : "v_window";
  usePageTitle(presentation.title);
  const analytics = useAnalytics();
  useEffect(() => { if (signingUp) analytics.track(signupStarted({ method: "email" })); }, [analytics, signingUp]);

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
        <WebBrand as={RouterLink} className={authBrandClassName} to="/" navigate={navigate} aria-label={t("Hatch home")} />
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
          {failedLogin ? <InlineError error={new Error(t(PLATFORM_LOGINS[failedLogin].failed))} /> : null}
          {(logins.data?.providers ?? []).filter((kind) => PLATFORM_LOGINS[kind]).map((kind) => <Button key={kind} asChild variant="secondary" className="buyer-v2__button--wide"><a href={`/v1/auth/${kind}/start?returnTo=${encodeURIComponent(returnTo)}`}>{t(PLATFORM_LOGINS[kind].action)}</a></Button>)}
        </form>
        <nav className="buyer-v2__auth-links" aria-label={presentation.switchAction}>
          <RouterLink className="buyer-v2__auth-switch" to={`${signingUp ? "/sign-in" : "/sign-up"}?returnTo=${encodeURIComponent(returnTo)}`} navigate={navigate}>{presentation.switchAction}</RouterLink>
          {!signingUp ? <RouterLink className="buyer-v2__auth-help" to="/account/help" navigate={navigate}>{t("Account help")}</RouterLink> : null}
        </nav>
      </section>
    </main>
  );
}

/* ---------- Library ---------- */

async function loadLibrary(request, signal) {
  const items = [];
  const visitedCursors = new Set();
  let cursor = null;
  do {
    const query = new URLSearchParams({ status: "active", limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const response = await callRequest(request, `${BUYER_PORTAL_V2_ENDPOINTS.library}?${query}`, { signal });
    const page = pageFrom(response, ["entitlements", "creator_agents", "items"]);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && visitedCursors.has(cursor)) throw new Error("The library list repeated its pagination cursor.");
    if (cursor) visitedCursors.add(cursor);
  } while (cursor);
  return items;
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

function CreatorIdentity({ value, name: knownName, className = "" }) {
  const t = useBuyerCopy();
  const name = knownName || creatorName(value, t);
  return <span className={`buyer-v2__creator-identity ${className}`.trim()}><AccountAvatar className="buyer-v2__creator-avatar" size="medium" src={creatorAvatarUrl(value)} name={name} /><span>{name}</span></span>;
}

function RouteError({ error, onRetry, navigate, session, returnTo }) {
  const t = useBuyerCopy();
  const status = error?.status;
  const analytics = useAnalytics();
  useEffect(() => analytics.track(errorShown({ area: "buyer", category: String(status ?? "unknown") })), [analytics, status]);
  if (status === 401) return <StatePanel title={t('Session expired')} body={t('Sign in again to continue. You will return to this page.')}><LinkButton className="web-btn-yolk" to={`/sign-in?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`} navigate={navigate}>{t('Sign in')}</LinkButton></StatePanel>;
  if (status === 403) return <StatePanel icon={AlertCircle} title={t("No access to this page")} body={t("This page may belong to another account. Check the email you are signed in with.")}><LinkButton to="/account/help" navigate={navigate}>{t('Account help')}</LinkButton><LinkButton variant="secondary" to={EXPLORE_ROOT} navigate={navigate}>{t('Browse Agents')}</LinkButton></StatePanel>;
  if (status === 404) return <StatePanel icon={SearchX} title={t('Not found')} body={t("It may have been removed, or the link is incomplete.")}><LinkButton to={EXPLORE_ROOT} navigate={navigate}>{t('Browse Agents')}</LinkButton></StatePanel>;
  if (status === 409) return <StatePanel tone="warning" title={t('Details changed')} body={friendlyError(error, t)}><Button type="button" onClick={onRetry}>{t('Refresh')}</Button></StatePanel>;
  return <StatePanel tone="error" title={t("Could not load")} body={friendlyError(error, t)}><Button type="button" onClick={onRetry}>{t('Try again')}</Button></StatePanel>;
}

function InlineError({ error }) {
  const t = useBuyerCopy();
  return <div className="buyer-v2__inline-error" role="alert">{friendlyError(error, t)}</div>;
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

function LinkButton({ to, navigate, variant = "primary", children, ...props }) {
  return <Button asChild variant={variant} {...props}><RouterLink to={to} navigate={navigate}>{children}</RouterLink></Button>;
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
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\") || /[\u0000-\u001f]/.test(candidate)) return STUDIO_ROOT;
  const destination = new URL(candidate, "https://hatch.invalid");
  if (destination.origin !== "https://hatch.invalid") return STUDIO_ROOT;
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

const identity = (key) => key;
function productId(value) { return value?.product_id || value?.product?.id || value?.product?.product_id || value?.id; }
function productName(value, t = identity) { return value?.product_name || value?.name || value?.product?.name || t("Expert Agent"); }
function productPromise(value, t = identity) { return value?.promise || value?.product_description || value?.description || value?.product?.promise || value?.product?.description || t("An Agent built from an expert's method."); }
function creatorName(value, t = identity) { return value?.creator_name || value?.creator_display_name || value?.display_name || value?.name || value?.creator?.display_name || value?.creator?.name || value?.creator?.handle || t("Hatch Expert"); }
function creatorAvatarUrl(value) { return value?.creator_avatar_url || value?.avatar_url || value?.image_url || value?.creator?.avatar_url || value?.creator?.image_url; }
function productPath(value) {
  const product = productId(value);
  return product ? `/products/${encodeURIComponent(product)}` : STUDIO_ROOT;
}

function productKey(value) { return productId(value) || "product"; }

function arrayValue(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) return [value];
  return fallback;
}

function textValue(value, t = identity) { return typeof value === "string" ? value : value?.label || value?.summary || value?.description || t("Product detail"); }

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

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}
