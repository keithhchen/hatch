import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-serif-sc";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/dm-mono/400.css";
import { BuyerPortalV2 } from "./BuyerPortalV2.jsx";
import { CreatorPortalV2 } from "./CreatorPortalV2.jsx";
import { dashboardRequest } from "./data.js";
import "../../packages/brand/tokens.css";
import "./styles.css";

const CREATOR_ROOT = "/portal/creator";

function App() {
  const location = useBrowserLocation();
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
  }, [clearSession]);

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

  const invalidate = useCallback((error) => {
    if (!error || error.status === 401 || error.status === 403) clearSession();
  }, [clearSession]);

  const buyerSession = {
    status: sessionStatus,
    user: profile,
    signIn,
    signUp,
    signOut,
    invalidate
  };

  if (location.pathname === "/" || location.pathname === "/portal" || location.pathname === "/portal/") {
    if (location.pathname.startsWith("/portal") && sessionStatus === "loading") return <AppLoading />;
    const destination = profile?.role === "creator" ? CREATOR_ROOT : profile?.role === "user" ? "/portal/library" : "/agents";
    return <RouteRedirect to={destination} navigate={location.navigate} />;
  }

  if (location.pathname === "/download") {
    return <RouteRedirect to="/agents" navigate={location.navigate} />;
  }

  if (location.pathname === CREATOR_ROOT || location.pathname.startsWith(`${CREATOR_ROOT}/`)) {
    if (sessionStatus === "loading") return <AppLoading />;
    if (sessionStatus !== "authenticated") {
      return <RouteRedirect to={`/sign-in?returnTo=${encodeURIComponent(location.href)}`} navigate={location.navigate} />;
    }
    if (profile?.role !== "creator") {
      return <RoleBoundary navigate={location.navigate} />;
    }
    return (
      <CreatorPortalV2
        pathname={location.pathname}
        navigate={location.navigate}
        request={dashboardRequest}
        profile={profile}
        onLogout={async () => {
          await signOut();
          location.navigate("/agents", { replace: true });
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
  return <main className="loading-page" aria-busy="true"><span className="hatch-wordmark">Hatch.</span><p>Opening your workspace…</p></main>;
}

function RoleBoundary({ navigate }) {
  return (
    <main className="loading-page">
      <span className="hatch-wordmark">Hatch.</span>
      <h1>Creator access is required.</h1>
      <p>This account can use purchased Agents, but it cannot edit Creator products.</p>
      <button className="primary" type="button" onClick={() => navigate("/portal/library", { replace: true })}>Open your library</button>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
