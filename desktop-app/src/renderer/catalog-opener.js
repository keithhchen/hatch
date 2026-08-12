import { englishMessage } from "./i18n.js";

export async function openCreatorAgentCatalog({
  catalogUrl,
  invokeImpl,
  windowObject = window,
  packaged = Boolean(windowObject?.__TAURI_INTERNALS__)
}) {
  try {
    await invokeImpl("open_external_url", { url: catalogUrl });
    return "system-browser";
  } catch {
    // A packaged app must never turn a failed native allowlisted open into a
    // WebView navigation. The browser-only fallback exists solely for Vite UAT.
    if (packaged) {
      throw localizedError(
        englishMessage("error.catalog.openSystemBrowserFailed"),
        "error.catalog.openSystemBrowserFailed"
      );
    }
    const opened = windowObject?.open?.(catalogUrl, "_blank", "noopener,noreferrer");
    if (!opened) {
      throw localizedError(
        englishMessage("error.catalog.popupsBlocked"),
        "error.catalog.popupsBlocked"
      );
    }
    return "web-preview";
  }
}

function localizedError(message, i18nKey) {
  const error = new Error(message);
  error.i18nKey = i18nKey;
  return error;
}
