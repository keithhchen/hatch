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
      throw new Error("Hatch couldn't open the Creator Agent catalog in your system browser. Try again.");
    }
    const opened = windowObject?.open?.(catalogUrl, "_blank", "noopener,noreferrer");
    if (!opened) throw new Error("Allow pop-ups to open the Creator Agent catalog in your browser.");
    return "web-preview";
  }
}
