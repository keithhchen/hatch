const KEY = "hatch.staleBuildReload";
const WINDOW_MS = 10_000;

/**
 * A tab opened before a deploy still asks for the old build's chunks, which the new build no longer serves. Vite reports that
 * as `vite:preloadError`; the page reloads once to pick up the current build. A second failure soon after is a real error
 * and is left to surface (and reach Sentry), so a broken deploy cannot loop the page.
 */
export function reloadOnStaleBuild(target = window, storage = () => target.sessionStorage, now = () => Date.now()) {
  target.addEventListener("vite:preloadError", (event) => {
    let last = 0;
    try { last = Number(storage()?.getItem(KEY)) || 0; } catch { /* storage unavailable: reload anyway, once per page */ }
    if (now() - last < WINDOW_MS) return;
    event.preventDefault();
    try { storage()?.setItem(KEY, String(now())); } catch { /* ignore */ }
    target.location.reload();
  });
}
