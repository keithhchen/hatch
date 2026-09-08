import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createTranslator } from "./i18n.js";

// Exercise the renderer's pure state selector without starting its native WebView.
const source = readFileSync(new URL("./main.jsx", import.meta.url), "utf8");
const selector = source.slice(source.indexOf("function desktopConversationLoadingKey("), source.indexOf("function DesktopConnectionStatus("));
const loadingKey = runInNewContext(`(${selector.trim()})`);
const idle = {
  conversationReady: false,
  conversationLibraryStatus: "ready",
  windowStateRestored: true,
  chatLoading: false,
  status: "Offline",
  runtimeRetryExhausted: false,
  workspaceGranted: true,
  hasConversation: true
};

describe("desktop conversation loading presentation", () => {
  it.each([
    [{ windowStateRestored: false }, "connection.loadingWorkspace"],
    [{ conversationLibraryStatus: "idle" }, "connection.loadingLibrary"],
    [{ conversationLibraryStatus: "loading" }, "connection.loadingLibrary"],
    [{}, "connection.connecting"],
    [{ chatLoading: true, status: "Loading history..." }, "connection.loadingHistory"],
    [{ chatLoading: true, status: "Connection lost — restoring your session…" }, "connection.connecting"],
    [{ chatLoading: true, status: "Connection unavailable — network error" }, "connection.connecting"],
    [{ conversationReady: true }, null],
    [{ runtimeRetryExhausted: true }, null],
    [{ conversationLibraryStatus: "unavailable", chatLoading: true }, null],
    [{ workspaceGranted: false }, null],
    [{ hasConversation: false }, null]
  ])("maps %j to %s", (patch, expected) => {
    expect(loadingKey({ ...idle, ...patch })).toBe(expected);
  });

  it("returns to loading when manually retrying an exhausted connection", () => {
    expect(loadingKey({ ...idle, runtimeRetryExhausted: true })).toBeNull();
    expect(loadingKey({ ...idle, chatLoading: true, status: "Restoring connection…" })).toBe("connection.connecting");
  });

  it.each(["en", "zh-CN", "ja"])("localizes every loading phase in %s", (language) => {
    const t = createTranslator(language);
    for (const key of ["connection.loadingWorkspace", "connection.loadingLibrary", "connection.loadingHistory", "connection.connecting"]) {
      expect(t(key)).not.toBe(key);
      expect(t(key)).not.toBe(t("conversation.offlineTitle"));
    }
  });
});
