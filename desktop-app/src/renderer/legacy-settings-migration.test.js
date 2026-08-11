import { describe, expect, it, vi } from "vitest";
import { createDesktopSettingsStore } from "./desktop-settings.js";
import {
  LEGACY_SETTINGS_IMPORT_MARKER,
  importLegacyProfileSettings,
  legacyProfileStorageKey,
  purgeLegacySensitiveStorage
} from "./legacy-settings-migration.js";

describe("one-time legacy Desktop settings migration", () => {
  it("deletes known legacy secrets before a profile is available", () => {
    const storage = memoryWebStorage(new Map([
      ["hatch.auth.activeProfile", "user_jordan"],
      ["hatch.auth.profile.user_jordan", JSON.stringify({ accessToken: "old-token" })],
      ["hatch.debug.lastTurnTiming", JSON.stringify({ client_ms: 1 })],
      ["unrelated.preference", "keep"]
    ]));

    purgeLegacySensitiveStorage(storage);

    expect(storage.peek("hatch.auth.activeProfile")).toBeNull();
    expect(storage.peek("hatch.auth.profile.user_jordan")).toBeNull();
    expect(storage.peek("hatch.debug.lastTurnTiming")).toBeNull();
    expect(storage.peek("unrelated.preference")).toBe("keep");
  });

  it("imports only the non-secret whitelist and deletes auth keys without reading them", async () => {
    const profileId = "user/jordan";
    const authKey = "hatch.auth.profile.user%2Fjordan";
    const storage = memoryWebStorage(new Map([
      [legacyProfileStorageKey(profileId, "workspaceRoot"), "/Users/jordan/project"],
      [legacyProfileStorageKey(profileId, "permissionMode"), "allow-changes"],
      [legacyProfileStorageKey(profileId, "conversationId"), "conversation_user_jordan"],
      [legacyProfileStorageKey(profileId, "activeRun"), JSON.stringify({ runId: "stale" })],
      ["hatch.auth.activeProfile", profileId],
      [authKey, JSON.stringify({ accessToken: "must-not-migrate" })]
    ]));
    const store = createDesktopSettingsStore({ read: async () => null, write: async () => {} });
    await store.load();

    const result = await importLegacyProfileSettings({ profileId, legacyStorage: storage, settingsStore: store });

    expect(store.snapshot().accounts[profileId]).toEqual({
      permission_mode: "allow-changes",
      conversation_id: "conversation_user_jordan",
      [LEGACY_SETTINGS_IMPORT_MARKER]: true
    });
    expect(result).toMatchObject({
      status: "completed",
      statusKey: "migration.status.completed",
      importedKeys: ["permission_mode", "conversation_id"],
      resetKeys: ["workspaceRoot", "activeRun"],
      noticeKey: "migration.notice.importedAndReset"
    });
    expect(storage.peek("hatch.auth.activeProfile")).toBeNull();
    expect(storage.peek(authKey)).toBeNull();
    expect(storage.readKeys).not.toContain("hatch.auth.activeProfile");
    expect(storage.readKeys).not.toContain(authKey);
  });

  it("keeps legacy values when the native write fails", async () => {
    const profileId = "user_jordan";
    const workspaceKey = legacyProfileStorageKey(profileId, "workspaceRoot");
    const authKey = "hatch.auth.profile.user_jordan";
    const storage = memoryWebStorage(new Map([
      [workspaceKey, "/Users/jordan/project"],
      ["hatch.auth.activeProfile", profileId],
      [authKey, JSON.stringify({ accessToken: "must-be-deleted" })]
    ]));
    const store = createDesktopSettingsStore({
      read: async () => null,
      write: async () => { throw new Error("native store unavailable"); }
    });
    await store.load();

    const error = await importLegacyProfileSettings({ profileId, legacyStorage: storage, settingsStore: store })
      .catch((caught) => caught);
    expect(error).toMatchObject({
      message: "native store unavailable",
      i18nKey: "error.migration.importFailed"
    });
    expect(storage.getItem(workspaceKey)).toBe("/Users/jordan/project");
    expect(storage.peek("hatch.auth.activeProfile")).toBeNull();
    expect(storage.peek(authKey)).toBeNull();
    expect(store.snapshot().accounts[profileId]).toBeUndefined();
  });

  it("runs once after the native marker is committed", async () => {
    const profileId = "user_jordan";
    const storage = memoryWebStorage();
    const store = createDesktopSettingsStore({
      read: async () => JSON.stringify({
        schema_version: 1,
        accounts: { [profileId]: { [LEGACY_SETTINGS_IMPORT_MARKER]: true } }
      }),
      write: vi.fn()
    });
    await store.load();

    await expect(importLegacyProfileSettings({ profileId, legacyStorage: storage, settingsStore: store }))
      .resolves.toEqual({
        status: "already-imported",
        statusKey: "migration.status.alreadyImported",
        notice: "",
        noticeKey: ""
      });
    expect(storage.readKeys).toEqual([]);
  });

  it("returns stable status and notice keys for every migration outcome", async () => {
    await expect(importLegacyProfileSettings({})).resolves.toEqual({
      status: "not-available",
      statusKey: "migration.status.notAvailable",
      notice: "",
      noticeKey: ""
    });

    const profileId = "user_empty";
    const storage = memoryWebStorage();
    const store = createDesktopSettingsStore({ read: async () => null, write: async () => {} });
    await store.load();
    await expect(importLegacyProfileSettings({ profileId, legacyStorage: storage, settingsStore: store }))
      .resolves.toEqual({
        status: "nothing-to-import",
        statusKey: "migration.status.nothingToImport",
        notice: "",
        noticeKey: "",
        importedKeys: [],
        resetKeys: []
      });
  });
});

function memoryWebStorage(values = new Map()) {
  const readKeys = [];
  return {
    readKeys,
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { readKeys.push(key); return values.has(key) ? values.get(key) : null; },
    removeItem(key) { values.delete(key); },
    peek(key) { return values.has(key) ? values.get(key) : null; }
  };
}
