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
      schema_version: 2,
      app: { language: "system" },
      accounts: { user_123: { last_selected_entitlement_id: "ent_signal", workspace_grant: { grant_id: "grant_project", display_path: "/tmp/project" } } }
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

  it("stores the app language globally instead of under an account", async () => {
    let serialized = null;
    const store = createDesktopSettingsStore({
      read: async () => serialized,
      write: async (next) => { serialized = next; }
    });
    await store.load();

    await store.setApp("language", "zh-CN");

    expect(store.getApp("language")).toBe("zh-CN");
    expect(store.getProfile("user_123", "language", "missing")).toBe("missing");
    expect(JSON.parse(serialized)).toEqual({
      schema_version: 2,
      app: { language: "zh-CN" },
      accounts: {}
    });
  });

  it("restores the saved app language after a renderer restart", async () => {
    let serialized = null;
    const persistence = {
      read: async () => serialized,
      write: async (next) => { serialized = next; }
    };
    const firstBoot = createDesktopSettingsStore(persistence);
    await firstBoot.load();
    await firstBoot.setApp("language", "ja");

    const nextBoot = createDesktopSettingsStore(persistence);
    await nextBoot.load();

    expect(nextBoot.getApp("language")).toBe("ja");
    expect(nextBoot.snapshot().accounts).toEqual({});
  });

  it("migrates v1 settings to v2 without losing account preferences", async () => {
    const store = createDesktopSettingsStore({
      read: async () => JSON.stringify({
        schema_version: 1,
        accounts: {
          user_123: {
            permission_mode: "allow-changes",
            workspace_grant: { grant_id: "workspace_123", display_path: "/tmp/project" }
          }
        }
      })
    });

    await store.load();

    expect(store.snapshot()).toEqual({
      schema_version: 2,
      app: { language: "system" },
      accounts: {
        user_123: {
          permission_mode: "allow-changes",
          workspace_grant: { grant_id: "workspace_123", display_path: "/tmp/project" }
        }
      }
    });
  });

  it("repairs a damaged app section while preserving valid account data", async () => {
    const store = createDesktopSettingsStore({
      read: async () => ({
        schema_version: "damaged",
        app: { language: null },
        accounts: { user_123: { conversation_id: "conversation_123" } }
      })
    });

    await store.load();

    expect(store.getApp("language")).toBe("system");
    expect(store.getProfile("user_123", "conversation_id")).toBe("conversation_123");
  });

  it("clears a language override back to system and persists the reset", async () => {
    let serialized = JSON.stringify({
      schema_version: 2,
      app: { language: "zh-CN" },
      accounts: { user_123: { permission_mode: "read-only" } }
    });
    const store = createDesktopSettingsStore({
      read: async () => serialized,
      write: async (next) => { serialized = next; }
    });
    await store.load();

    await store.clearAppKey("language");

    expect(store.getApp("language")).toBe("system");
    expect(JSON.parse(serialized)).toEqual({
      schema_version: 2,
      app: { language: "system" },
      accounts: { user_123: { permission_mode: "read-only" } }
    });
  });

  it("rolls back an app setting when native persistence fails", async () => {
    const store = createDesktopSettingsStore({
      read: async () => JSON.stringify({ schema_version: 2, app: { language: "en" }, accounts: {} }),
      write: async () => { throw new Error("native store unavailable"); }
    });
    await store.load();

    await expect(store.setApp("language", "ja")).rejects.toThrow("native store unavailable");

    expect(store.getApp("language")).toBe("en");
  });

  it.each([
    {
      name: "keeps the second value when the first write fails and the second succeeds",
      failedWrites: [1],
      expectedResults: ["rejected", "fulfilled"],
      expectedLanguage: "ja"
    },
    {
      name: "rolls back to the first value when the first write succeeds and the second fails",
      failedWrites: [2],
      expectedResults: ["fulfilled", "rejected"],
      expectedLanguage: "zh-CN"
    },
    {
      name: "rolls back to the original value when both writes fail",
      failedWrites: [1, 2],
      expectedResults: ["rejected", "rejected"],
      expectedLanguage: "system"
    }
  ])("$name", async ({ failedWrites, expectedResults, expectedLanguage }) => {
    let serialized = JSON.stringify({
      schema_version: 2,
      app: { language: "system" },
      accounts: {}
    });
    let writeNumber = 0;
    const store = createDesktopSettingsStore({
      read: async () => serialized,
      write: async (next) => {
        writeNumber += 1;
        if (failedWrites.includes(writeNumber)) {
          throw new Error(`write ${writeNumber} failed`);
        }
        serialized = next;
      }
    });
    await store.load();

    const firstWrite = store.setApp("language", "zh-CN");
    const secondWrite = store.setApp("language", "ja");
    const results = await Promise.allSettled([firstWrite, secondWrite]);

    expect(results.map(({ status }) => status)).toEqual(expectedResults);
    expect(store.getApp("language")).toBe(expectedLanguage);
    expect(JSON.parse(serialized).app.language).toBe(expectedLanguage);
  });

  it("does not let a later profile write persist a failed language mutation", async () => {
    let serialized = JSON.stringify({
      schema_version: 2,
      app: { language: "system" },
      accounts: {}
    });
    let writeNumber = 0;
    let markProfilePersisted;
    const profilePersisted = new Promise((resolve) => { markProfilePersisted = resolve; });
    const store = createDesktopSettingsStore({
      read: async () => serialized,
      write: async (next) => {
        writeNumber += 1;
        if (writeNumber === 1) throw new Error("language write failed");
        serialized = next;
        markProfilePersisted();
      }
    });
    await store.load();

    const languageWrite = store.setApp("language", "ja");
    store.setProfile("user_123", "permission_mode", "allow-changes");

    await expect(languageWrite).rejects.toThrow("language write failed");
    await profilePersisted;
    expect(store.getApp("language")).toBe("system");
    expect(store.getProfile("user_123", "permission_mode")).toBe("allow-changes");
    expect(JSON.parse(serialized)).toEqual({
      schema_version: 2,
      app: { language: "system" },
      accounts: { user_123: { permission_mode: "allow-changes" } }
    });
  });

  it("serializes app setting writes", async () => {
    let releaseFirstWrite;
    let markFirstWriteStarted;
    const firstWriteStarted = new Promise((resolve) => { markFirstWriteStarted = resolve; });
    const writtenLanguages = [];
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const store = createDesktopSettingsStore({
      write: async (serialized) => {
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        writtenLanguages.push(JSON.parse(serialized).app.language);
        if (writtenLanguages.length === 1) {
          markFirstWriteStarted();
          await new Promise((resolve) => { releaseFirstWrite = resolve; });
        }
        activeWrites -= 1;
      }
    });
    await store.load();

    const firstWrite = store.setApp("language", "zh-CN");
    await firstWriteStarted;
    const secondWrite = store.setApp("language", "ja");
    await Promise.resolve();

    expect(writtenLanguages).toEqual(["zh-CN"]);
    releaseFirstWrite();
    await Promise.all([firstWrite, secondWrite]);
    expect(writtenLanguages).toEqual(["zh-CN", "ja"]);
    expect(maxActiveWrites).toBe(1);
  });
});
