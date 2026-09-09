import React, { Suspense, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@hatch/ui/fonts";
import "@hatch/ui/theme.css";
import { Button, HatchBrand, HatchUIProvider, UnavailableState } from "@hatch/ui";
import { BuyerPortalV2 } from "./BuyerPortalV2.jsx";
import { CreatorPortalV2 } from "./CreatorPortalV2.jsx";
import { DownloadPage } from "./DownloadPage.jsx";
import { dashboardRequest } from "./data.js";
import { WebLocaleProvider, useWebLocale } from "./WebLocaleProvider.jsx";
import "./styles.css";

const CREATOR_ROOT = "/studio";
const WebPage = React.lazy(() => import("./web/WebPage.jsx"));

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
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="loading-page">
        <UnavailableState
          title={this.props.t("common.pageUnavailable")}
          body={this.props.t("common.pageUnavailableBody")}
          action={{ label: this.props.t("common.reload"), onClick: () => window.location.reload() }}
        />
      </main>
    );
  }
}

function LocalizedErrorBoundary({ children }) {
  const { t } = useWebLocale();
  return <AppErrorBoundary t={t}>{children}</AppErrorBoundary>;
}

function App() {
  const location = useBrowserLocation();
  const isDownloadRoute = location.pathname === "/download";
  const isWebRoute = location.pathname === "/";
  const [profile, setProfile] = useState(null);
  const [sessionStatus, setSessionStatus] = useState("loading");

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
    if (isDownloadRoute || isWebRoute) {
      setSessionStatus("anonymous");
      return undefined;
    }
    let active = true;
    setSessionStatus("loading");
    dashboardRequest("/v1/auth/me")
      .then((nextProfile) => {
        if (!active) return;
        setProfile(nextProfile);
        setSessionStatus("authenticated");
      })
      .catch((error) => {
        if (!active) return;
        if (error.status === 401 || error.status === 403) clearSession();
        else setSessionStatus(profile ? "authenticated" : "anonymous");
    });
    return () => { active = false; };
  }, [clearSession, isDownloadRoute, isWebRoute]);

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

  const creatorSignUp = useCallback(async (details) => {
    const result = await dashboardRequest("/v1/auth/creator-signup", {
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

  const invalidate = useCallback((error) => {
    if (!error || error.status === 401 || error.status === 403) clearSession();
  }, [clearSession]);

  const buyerSession = {
    status: sessionStatus,
    user: profile,
    signIn,
    signUp,
    creatorSignUp,
    signOut,
    invalidate
  };

  // The UUID cutover intentionally has no legacy Portal redirect. Unknown
  // legacy paths must remain 404 so stale links cannot silently target a
  // different resource.

  if (isDownloadRoute) return <DownloadPage />;

  if (isWebRoute) {
    return (
      <Suspense fallback={<AppLoading />}>
        <WebPage />
      </Suspense>
    );
  }

  if (location.pathname === CREATOR_ROOT
    || location.pathname.startsWith(`${CREATOR_ROOT}/`)) {
    if (sessionStatus === "loading") return <AppLoading />;
    if (sessionStatus !== "authenticated") {
      return <RouteRedirect to={`/sign-up?returnTo=${encodeURIComponent(location.href)}`} navigate={location.navigate} />;
    }
    if (profile?.role !== "creator") {
      return <RoleBoundary navigate={location.navigate} onCreateCreator={async () => {
        await signOut();
        location.navigate(`/sign-up?returnTo=${encodeURIComponent(location.href)}`, { replace: true });
      }} />;
    }
    return (
      <CreatorPortalV2
        pathname={location.pathname}
        navigate={location.navigate}
        request={dashboardRequest}
        profile={profile}
        onLogout={async () => {
          await signOut();
          location.navigate("/explore", { replace: true });
        }}
      />
    );
  }

  return (
    <BuyerPortalV2
      pathname={location.pathname}
      search={location.search}
      navigate={location.navigate}
      request={dashboardRequest}
      session={buyerSession}
    />
  );
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
  const { t } = useWebLocale();
  return <main className="loading-page" aria-busy="true"><HatchBrand className="loading-brand" /><p>{t("common.openingWorkspace")}</p></main>;
}

function RoleBoundary({ navigate, onCreateCreator }) {
  const { t } = useWebLocale();
  return (
    <main className="loading-page">
      <HatchBrand className="loading-brand" />
      <h1>{t("common.creatorAccessRequired")}</h1>
      <p>{t("common.creatorAccessBody")}</p>
      {onCreateCreator ? <Button type="button" onClick={() => void onCreateCreator()}>{t("common.createCreatorAccount")}</Button> : null}
      <Button type="button" onClick={() => navigate("/library", { replace: true })}>{t("common.openYourLibrary")}</Button>
    </main>
  );
}

createRoot(document.getElementById("root")).render(
  <WebLocaleProvider>
    <LocalizedErrorBoundary>
      <HatchUIProvider atmosphere toasts className="hatch-app-paper">
        <App />
      </HatchUIProvider>
    </LocalizedErrorBoundary>
  </WebLocaleProvider>
);
