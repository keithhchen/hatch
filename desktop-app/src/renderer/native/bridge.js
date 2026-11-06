import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invokeDesktopCommand } from "./invoke-boundary.js";

/** True inside the packaged Tauri app (not the Vite preview). */
export const isNative = () => Boolean(globalThis.window?.__TAURI_INTERNALS__);

/** Invoke a native command; outside the packaged app it fails as desktop_only. */
export const nativeInvoke = (command, args) => invokeDesktopCommand(command, args, { invokeImpl: invoke, packaged: isNative() });

export const currentWindowLabel = () => isNative() ? getCurrentWindow().label : "main";

/** Listen to a Tauri event; returns a synchronous unsubscribe. */
export function onNativeEvent(event, handler) {
  if (!isNative()) return () => {};
  let disposed = false;
  let stop = null;
  listen(event, ({ payload }) => { if (!disposed) handler(payload); })
    .then(unlisten => { if (disposed) unlisten(); else stop = unlisten; })
    .catch(() => {});
  return () => { disposed = true; stop?.(); };
}

export const emitNativeEvent = (event, payload) => isNative() ? emit(event, payload).catch(() => {}) : Promise.resolve();
export const emitNativeEventTo = (label, event, payload) => isNative() ? emitTo(label, event, payload).catch(() => {}) : Promise.resolve();

/**
 * Reveal the (hidden) native window once React has painted its first frame.
 * A hidden WebView pauses animation frames, so a timer also reveals it —
 * otherwise a window hidden at sign-in would wait forever.
 */
export function revealWhenPainted() {
  let done = false;
  const reveal = () => {
    if (done) return;
    done = true;
    if (isNative()) void nativeInvoke("app_ready").catch(() => {});
  };
  requestAnimationFrame(() => requestAnimationFrame(reveal));
  setTimeout(reveal, 150);
}

/** Window-level native affordances; each is a no-op in the Vite preview. */
export const nativeWindow = {
  setTitle: title => { document.title = title; if (isNative()) void getCurrentWindow().setTitle(title).catch(() => {}); },
  setTheme: theme => isNative() ? getCurrentWindow().setTheme(theme === "system" ? null : theme).catch(() => {}) : Promise.resolve(),
  hide: () => isNative() ? getCurrentWindow().hide() : Promise.resolve(),
  close: () => isNative() ? getCurrentWindow().close() : Promise.resolve(),
  isFocused: () => isNative() ? getCurrentWindow().isFocused() : Promise.resolve(document.hasFocus()),
  onCloseRequested: handler => {
    if (!isNative()) return () => {};
    let stop = null;
    let disposed = false;
    getCurrentWindow().onCloseRequested(handler).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; });
    return () => { disposed = true; stop?.(); };
  },
  destroy: () => isNative() ? getCurrentWindow().destroy() : Promise.resolve()
};

/** Open an allowlisted Hatch web page in the system browser. */
export function openInBrowser(url) {
  if (isNative()) return nativeInvoke("open_external_url", { url });
  window.open(url, "_blank", "noopener,noreferrer");
  return Promise.resolve();
}
