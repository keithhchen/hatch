import { lazy } from "react";
import { reportStaleBuild } from "./sentry.js";

const KEY = "hatch.staleBuildReload";

/**
 * A tab opened before a deploy still asks for the old build's chunks. The page reloads to pick up the current build, at most
 * once per build per tab: if the same build fails again after its reload, the failure is real and surfaces (no reload loop).
 * `build` is the entry script URL, which is content-hashed, so it identifies the build this page is running.
 */
export function createStaleBuildReload({ target = window, build = import.meta.url, report = reportStaleBuild } = {}) {
  let reloading = false;
  return () => {
    if (reloading) return true;
    const key = `${KEY}:${build}`;
    let tried = true; // storage unavailable: cannot prove this is the first attempt, so never risk a loop
    try { tried = target.sessionStorage.getItem(key) === "1"; } catch { /* keep tried = true */ }
    report({ build, reloading: !tried });
    if (tried) return false;
    try { target.sessionStorage.setItem(key, "1"); } catch { return false; }
    reloading = true;
    target.location.reload();
    return true;
  };
}

let shared;
export const reloadOnceForBuild = () => (shared ??= createStaleBuildReload())();

// Vite reports a failed chunk preload as `vite:preloadError`; recover by reloading, otherwise let the error surface.
export function reloadOnStaleBuild(target = window, reload = reloadOnceForBuild) {
  target.addEventListener("vite:preloadError", (event) => {
    if (reload()) event.preventDefault();
  });
}

// React.lazy whose rejected dynamic import reloads once; the fallback stays up until the page reloads.
export function lazyWithReload(load, reload = reloadOnceForBuild) {
  return lazy(() => load().catch((error) => {
    if (reload()) return new Promise(() => {});
    throw error;
  }));
}
