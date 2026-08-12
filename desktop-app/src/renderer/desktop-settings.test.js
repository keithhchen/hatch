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
    store.setProfile("user_123", "workspace_grant", { grant_id: "grant_project", display_path: "/tmp/project" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getProfile("user_123", "last_selected_entitlement_id")).toBe("ent_signal");
    expect(JSON.parse(serialized)).toEqual({
      schema_version: 1,
      accounts: { user_123: { last_selected_entitlement_id: "ent_signal", workspace_grant: { grant_id: "grant_project", display_path: "/tmp/project" } } }
    });
    expect(store.getProfile("other", "last_selected_entitlement_id", "none")).toBe("none");
  });

  it("uses Tauri app-data commands instead of Web Storage", async () => {
    const values = new Map();
    const invoke = vi.fn(async (command, args) => {
      if (command === "read_app_settings") return values.get("settings") || "{}";
      if (command === "write_app_settings") values.set("settings", args.settings);
      if (command === "patch_app_settings") {
        const current = JSON.parse(values.get("settings") || "{}");
        current.schema_version ??= 1;
        current.accounts ??= {};
        const id = args.patch.profileId;
        current.accounts[id] ??= {};
        for (const [key, value] of Object.entries(args.patch.set || {})) current.accounts[id][key] = value;
        for (const key of args.patch.remove || []) delete current.accounts[id][key];
        values.set("settings", JSON.stringify(current));
      }
      return null;
    });
    const store = createTauriSettingsStore(invoke);
    await store.load();
    store.setProfile("user_123", "permission_mode", "read-only");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invoke).toHaveBeenCalledWith("read_app_settings");
    expect(invoke).toHaveBeenCalledWith("patch_app_settings", {
      patch: { profileId: "user_123", set: { permission_mode: "read-only" } }
    });
    expect(invoke.mock.calls.some(([command]) => command.includes("localStorage"))).toBe(false);
  });

  it("uses native field patches so two renderer stores cannot erase each other's window-adjacent preferences", async () => {
    let serialized = JSON.stringify({ schema_version: 1, accounts: { user_123: { theme: "dark" } } });
    const native = async (command, args) => {
      if (command === "read_app_settings") return serialized;
      if (command === "patch_app_settings") {
        const current = JSON.parse(serialized);
        const profile = current.accounts[args.patch.profileId] ??= {};
        Object.assign(profile, args.patch.set || {});
        for (const key of args.patch.remove || []) delete profile[key];
        serialized = JSON.stringify(current);
      }
      return null;
    };
    const first = createTauriSettingsStore(native);
    const second = createTauriSettingsStore(native);
    await Promise.all([first.load(), second.load()]);
    first.setProfile("user_123", "workspace_grant", { grant_id: "grant_a" });
    second.setProfile("user_123", "permission_mode", "allow-changes");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(serialized).accounts.user_123).toEqual({
      theme: "dark",
      workspace_grant: { grant_id: "grant_a" },
      permission_mode: "allow-changes"
    });
  });
});
