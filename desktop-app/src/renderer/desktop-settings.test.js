import { describe, expect, it, vi } from "vitest";
import { createDesktopSettingsStore, createTauriSettingsStore } from "./desktop-settings.js";

describe("desktop native settings", () => {
  it("keeps non-secret preferences scoped by account and persists updates", async () => {
    let serialized = null;
    const store = createDesktopSettingsStore({
      read: async () => serialized,
      write: async (next) => { serialized = next; }
    });
    await store.load();
    store.setProfile("user_123", "last_selected_entitlement_id", "ent_signal");
    store.setProfile("user_123", "workspace_root", "/tmp/project");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getProfile("user_123", "last_selected_entitlement_id")).toBe("ent_signal");
    expect(JSON.parse(serialized)).toEqual({
      schema_version: 1,
      accounts: { user_123: { last_selected_entitlement_id: "ent_signal", workspace_root: "/tmp/project" } }
    });
    expect(store.getProfile("other", "last_selected_entitlement_id", "none")).toBe("none");
  });

  it("uses Tauri app-data commands instead of Web Storage", async () => {
    const values = new Map();
    const invoke = vi.fn(async (command, args) => {
      if (command === "read_app_settings") return values.get("settings") || "{}";
      if (command === "write_app_settings") values.set("settings", args.settings);
      return null;
    });
    const store = createTauriSettingsStore(invoke);
    await store.load();
    store.setProfile("user_123", "permission_mode", "read-only");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invoke).toHaveBeenCalledWith("read_app_settings");
    expect(invoke).toHaveBeenCalledWith("write_app_settings", expect.objectContaining({ settings: expect.stringContaining("permission_mode") }));
    expect(invoke.mock.calls.some(([command]) => command.includes("localStorage"))).toBe(false);
  });
});
