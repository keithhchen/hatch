import React, { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@hatch/ui/theme.css";
import { HatchUIProvider, UnavailableState } from "@hatch/ui";
import { LocaleProvider } from "./locale.jsx";
import { dashboardRequest } from "./data.js";
import { parseDevelopersRoute } from "./developersGuide.js";
import { parseHelpRoute } from "./helpRoute.js";
import { WebChatRoute } from "./webChatRoute.js";
import { ArtifactRoute } from "./artifactRoute.js";
import { WebBrand } from "./WebBrand.jsx";
import "./styles.css";
import "./webTheme.css";
import { captureRenderError, startSentry } from "./sentry.js";
import { AnalyticsProvider, useAccountIdentity, useAnalytics } from "./analytics/AnalyticsProvider.jsx";
import { guestSignedInCarriedOver } from "./analytics/events.js";
import { IM_LINK_PATH } from "./imLink.js";
import { createAnalytics } from "./analytics/createAnalytics.js";
import { lazyWithReload, reloadOnStaleBuild } from "./staleBuild.js";
import { startEarlyLoad, takeEarlyMe } from "./earlyLoad.js";

startSentry(import.meta.env);
const analytics = createAnalytics(import.meta.env);
reloadOnStaleBuild();
startEarlyLoad(window.location.pathname, dashboardRequest);

const CREATOR_ROOT = "/studio";
const BuyerPortalV2 = lazyWithReload(() => import("./BuyerPortalV2.jsx").then(({ BuyerPortalV2: Component }) => ({ default: Component })));
const CreatorPortalV2 = lazyWithReload(() => import("./CreatorPortalV2.jsx").then(({ CreatorPortalV2: Component }) => ({ default: Component })));
const DownloadPage = lazyWithReload(() => import("./DownloadPage.jsx").then(({ DownloadPage: Component }) => ({ default: Component })));
const DevelopersPage = lazyWithReload(() => import("./DevelopersPage.jsx"));
const HelpPage = lazyWithReload(() => import("./HelpPage.jsx"));
const WebPage = lazyWithReload(() => import("./web/WebPage.jsx"));
const WebChatPage = lazyWithReload(() => import("./WebChatPage.jsx"));
const ArtifactPage = lazyWithReload(() => import("./ArtifactPage.jsx"));
const DesktopSignInPage = lazyWithReload(() => import("./DesktopSignInPage.jsx"));
const ImLinkPage = lazyWithReload(() => import("./ImLinkPage.jsx"));

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, details) {
    console.error("Hatch Web failed to render", error, details);
    captureRenderError(error, details);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="loading-page">
        <UnavailableState
          title="Hatch could not open this page."
          body="Reload to try again. Your account and product data have not been changed."
          action={{ label: "Reload", onClick: () => window.location.reload() }}
        />
      </main>
    );
  }
}

function App() {
  const location = useBrowserLocation();
  const isDownloadRoute = location.pathname === "/download";
  const isWebRoute = location.pathname === "/";
  const developersRoute = parseDevelopersRoute(location.pathname);
  const helpRoute = parseHelpRoute(location.pathname);
  const [profile, setProfile] = useState(null);
  const [sessionStatus, setSessionStatus] = useState("loading");
  useAccountIdentity(profile?.id);
  const carryOverSettled = useGuestCarryOver(sessionStatus);
  const chatWaiting = sessionStatus === "loading" || !carryOverSettled;

  const clearSession = useCallback(() => {
    setProfile(null);
    setSessionStatus("anonymous");
  }, []);

  const acceptSession = useCallback((result) => {
    const nextProfile = result.profile ?? result.account ?? result.user;
    if (!nextProfile) throw new Error("The authentication response is incomplete.");
    setProfile(nextProfile);
    setSessionStatus("authenticated");
    return result;
  }, []);

  useEffect(() => {
    if (isDownloadRoute || isWebRoute || developersRoute || helpRoute) {
      setSessionStatus("anonymous");
      return undefined;
    }
    let active = true;
    setSessionStatus("loading");
    (takeEarlyMe() ?? dashboardRequest("/v1/auth/me"))
      .then((nextProfile) => {
        if (!active) return;
        setProfile(nextProfile);
        setSessionStatus("authenticated");
      })
      .catch((error) => {
        if (!active) return;
        if (error.status === 401) clearSession();
        else setSessionStatus(profile ? "authenticated" : "anonymous");
    });
    return () => { active = false; };
  }, [clearSession, isDownloadRoute, isWebRoute, Boolean(developersRoute), Boolean(helpRoute)]);

  const signIn = useCallback(async (credentials) => {
    const result = await dashboardRequest("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify(credentials)
    });
    return acceptSession(result);
  }, [acceptSession]);

  const signUp = useCallback(async (details) => {
    const result = await dashboardRequest("/v1/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        email: details.email,
        password: details.password,
        display_name: details.display_name
      })
    });
    return acceptSession(result);
  }, [acceptSession]);

  const signOut = useCallback(async () => {
    try {
      await dashboardRequest("/v1/auth/logout", { method: "POST" });
    } finally {
      clearSession();
    }
  }, [clearSession]);

  const signOutFromChat = useCallback(async () => {
    await signOut();
    location.navigate("/studio", { replace: true });
  }, [location.navigate, signOut]);

  const invalidate = useCallback((error) => {
    if (!error || error.status === 401) clearSession();
  }, [clearSession]);

  // A chat whose session ended mid-conversation goes to sign-in (and back, via returnTo), not to a Retry that can only fail again.
  const chatRequest = useCallback(async (path, options) => {
    try { return await dashboardRequest(path, options); }
    catch (error) { if (error?.status === 401) clearSession(); throw error; }
  }, [clearSession]);

  const buyerSession = {
    status: sessionStatus,
    user: profile,
    updateUser: setProfile,
    signIn,
    signUp,
    signOut,
    invalidate
  };

  // The UUID cutover intentionally has no legacy Portal redirect. Unknown
  // legacy paths must remain 404 so stale links cannot silently target a
  // different resource.

  if (isDownloadRoute) {
    return <Suspense fallback={<AppLoading />}><DownloadPage /></Suspense>;
  }

  if (developersRoute) {
    return <Suspense fallback={<AppLoading />}><DevelopersPage tab={developersRoute.tab} navigate={location.navigate} /></Suspense>;
  }

  if (helpRoute) {
    return <Suspense fallback={<AppLoading />}><HelpPage slug={helpRoute.slug} navigate={location.navigate} /></Suspense>;
  }

  if (isWebRoute) {
    return (
      <Suspense fallback={<AppLoading />}>
        <WebPage />
      </Suspense>
    );
  }

  if (location.pathname === "/desktop/sign-in") {
    if (sessionStatus === "loading") return <AppLoading />;
    if (sessionStatus !== "authenticated") {
      return <RouteRedirect to={`/sign-in?returnTo=${encodeURIComponent(location.href)}`} navigate={location.navigate} />;
    }
    return <Suspense fallback={<AppLoading />}><DesktopSignInPage search={location.search} profile={profile} request={dashboardRequest} /></Suspense>;
  }

  if (location.pathname === IM_LINK_PATH) {
    if (sessionStatus === "loading") return <AppLoading />;
    if (sessionStatus !== "authenticated") {
      return <RouteRedirect to={`/sign-in?returnTo=${encodeURIComponent(location.href)}`} navigate={location.navigate} />;
    }
    return <Suspense fallback={<AppLoading />}><ImLinkPage search={location.search} request={chatRequest} navigate={location.navigate} /></Suspense>;
  }

  // Anyone can chat: a signed-out visitor opens the page as a guest, and the server asks them to sign in when the guest limit is reached.
  // `profile` is null for a guest. After a guest's conversations move to the account, the page is mounted again to read them.
  const chatRoute = WebChatRoute.parse(location.pathname);
  if (chatRoute) {
    if (chatWaiting) return <AppLoading />;
    return <Suspense fallback={<AppLoading />}><WebChatPage productId={chatRoute.productId} conversationId={chatRoute.conversationId} request={chatRequest} navigate={location.navigate} profile={profile} onSignOut={signOutFromChat} /></Suspense>;
  }

  const artifactRoute = ArtifactRoute.parse(location.pathname);
  if (artifactRoute) {
    if (chatWaiting) return <AppLoading />;
    return <Suspense fallback={<AppLoading />}><ArtifactPage productId={artifactRoute.productId} conversationId={artifactRoute.conversationId} search={location.search} request={chatRequest} navigate={location.navigate} profile={profile} onSignOut={signOutFromChat} /></Suspense>;
  }

  if (location.pathname === CREATOR_ROOT
    || location.pathname.startsWith(`${CREATOR_ROOT}/`)) {
    if (chatWaiting) return <AppLoading />;
    if (sessionStatus !== "authenticated") {
      return <RouteRedirect to={`/sign-up?returnTo=${encodeURIComponent(location.href)}`} navigate={location.navigate} />;
    }
    return (
      <Suspense fallback={<AppLoading />}>
        <CreatorPortalV2
          pathname={location.pathname}
          navigate={location.navigate}
          request={dashboardRequest}
          profile={profile}
          onProfileChange={setProfile}
          onLogout={async () => {
            await signOut();
            location.navigate("/studio", { replace: true });
          }}
        />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<AppLoading />}>
      <BuyerPortalV2
        pathname={location.pathname}
        search={location.search}
        navigate={location.navigate}
        request={dashboardRequest}
        session={buyerSession}
      />
    </Suspense>
  );
}

/**
 * Once per page load, as soon as the session is authenticated: the visitor's guest conversations become the account's.
 * Returns true once that call has finished (moved or nothing to move) or there is no session to carry over to (it is not waited for while signed out), so the
 * pages that read those conversations mount only afterwards. A failure is not shown: the server keeps the guest until
 * it succeeds, and the next page load asks again.
 */
function useGuestCarryOver(sessionStatus) {
  const analytics = useAnalytics();
  const asked = useRef(false);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (sessionStatus !== "authenticated" || asked.current) return;
    asked.current = true;
    dashboardRequest("/v1/web-chat/guest/carry-over", { method: "POST", body: "{}" })
      .then(({ moved }) => { if (moved > 0) analytics.track(guestSignedInCarriedOver({ moved })); })
      .catch(() => {})
      .finally(() => setSettled(true));
  }, [analytics, sessionStatus]);
  return sessionStatus !== "authenticated" || settled;
}

function useBrowserLocation() {
  const read = () => ({
    pathname: window.location.pathname,
    search: window.location.search,
    href: `${window.location.pathname}${window.location.search}${window.location.hash}`
  });
  const [value, setValue] = useState(read);

  useEffect(() => {
    const update = () => setValue(read());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);

  const navigate = useCallback((to, options = {}) => {
    const target = new URL(to, window.location.origin);
    if (target.origin !== window.location.origin) {
      window.location.assign(target.href);
      return;
    }
    window.history[options.replace ? "replaceState" : "pushState"]({}, "", `${target.pathname}${target.search}${target.hash}`);
    setValue(read());
    window.scrollTo({ top: 0, left: 0 });
  }, []);

  return { ...value, navigate };
}

function RouteRedirect({ to, navigate }) {
  useEffect(() => navigate(to, { replace: true }), [to, navigate]);
  return <AppLoading />;
}

function AppLoading() {
  return <main className="loading-page" aria-busy="true"><WebBrand as="span" className="loading-brand" /></main>;
}

createRoot(document.getElementById("root")).render(
  <AppErrorBoundary>
    <AnalyticsProvider analytics={analytics}>
      <HatchUIProvider atmosphere toasts className="hatch-app-paper">
        <LocaleProvider><App /></LocaleProvider>
      </HatchUIProvider>
    </AnalyticsProvider>
  </AppErrorBoundary>
);

scheduleFontAssets();

function scheduleFontAssets() {
  if (typeof window === "undefined") return;
  const load = () => { void import("@hatch/ui/fonts"); };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(load, { timeout: 1000 });
  } else {
    window.setTimeout(load, 0);
  }
}
