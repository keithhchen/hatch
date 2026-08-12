import { englishMessage } from "./i18n.js";

const SETTINGS_VERSION = 2;
const DEFAULT_APP_SETTINGS = Object.freeze({ language: "system" });

export function createDesktopSettingsStore({ read = async () => null, write = async () => {} } = {}) {
  let state = emptySettings();
  let loaded = false;
  let writeChain = Promise.resolve();
  let persistedState = state;
  let pendingMutations = [];
  let nextMutationId = 1;

  return {
    async load() {
      if (loaded) return state;
      try {
        const raw = await read();
        state = normalizeSettings(raw);
      } catch {
        state = emptySettings();
      }
      persistedState = state;
      pendingMutations = [];
      loaded = true;
      return state;
    },
    getProfile(profileId, key, fallback = undefined) {
      return state.accounts?.[String(profileId)]?.[key] ?? fallback;
    },
    getApp(key, fallback = undefined) {
      return state.app?.[key] ?? fallback;
    },
    setApp(key, value) {
      return updateApp(key, value);
    },
    setProfile(profileId, key, value) {
      void updateProfile(profileId, key, value).catch(() => {});
    },
    async importProfile(profileId, values) {
      if (!values || typeof values !== "object" || Array.isArray(values)) {
        throw new Error(englishMessage("error.settings.invalidImport"));
      }
      const id = String(profileId || "anonymous");
      await enqueueMutation((current) => ({
        ...current,
        accounts: {
          ...current.accounts,
          [id]: { ...(current.accounts[id] ?? {}), ...values }
        }
      }));
      return state.accounts[id];
    },
    removeProfile(profileId, key) {
      const id = String(profileId || "anonymous");
      if (!state.accounts[id]) return;
      void updateProfile(profileId, key, undefined).catch(() => {});
    },
    async clearProfileKey(profileId, key) {
      const id = String(profileId || "anonymous");
      if (!state.accounts[id] || !(key in state.accounts[id])) return;
      await updateProfile(profileId, key, undefined);
    },
    async clearAppKey(key) {
      const hasDefault = Object.prototype.hasOwnProperty.call(DEFAULT_APP_SETTINGS, key);
      if (!(key in state.app) && !hasDefault) return;
      if (hasDefault && state.app[key] === DEFAULT_APP_SETTINGS[key]) return;
      await updateApp(key, undefined);
    },
    snapshot() {
      return JSON.parse(JSON.stringify(state));
    }
  };

  function updateApp(key, value) {
    return enqueueMutation((current) => {
      const nextApp = { ...current.app };
      if (value === undefined) restoreAppDefault(nextApp, key);
      else nextApp[key] = value;
      return { ...current, app: nextApp };
    });
  }

  function updateProfile(profileId, key, value) {
    const id = String(profileId || "anonymous");
    return enqueueMutation((current) => {
      const nextProfile = { ...(current.accounts[id] ?? {}) };
      if (value === undefined) delete nextProfile[key];
      else nextProfile[key] = value;
      return {
        ...current,
        accounts: { ...current.accounts, [id]: nextProfile }
      };
    });
  }

  function enqueueMutation(apply) {
    const mutation = { id: nextMutationId++, apply };
    pendingMutations.push(mutation);
    state = apply(state);
    const pending = writeChain.then(async () => {
      const nextPersistedState = apply(persistedState);
      await write(JSON.stringify(nextPersistedState));
      persistedState = nextPersistedState;
      settleMutation(mutation.id);
    }).catch((error) => {
      settleMutation(mutation.id);
      throw error;
    });
    writeChain = pending.catch(() => {});
    return pending;
  }

  function settleMutation(id) {
    pendingMutations = pendingMutations.filter((mutation) => mutation.id !== id);
    state = pendingMutations.reduce(
      (current, mutation) => mutation.apply(current),
      persistedState
    );
  }
}

export function createTauriSettingsStore(invokeImpl, { strict = false } = {}) {
  let fallback = null;
  return createDesktopSettingsStore({
    async read() {
      try {
        const value = await invokeImpl("read_app_settings");
        if (typeof value === "string" && value.trim()) fallback = value;
      } catch {
        // Vite renderer tests have no native app-data bridge.
      }
      return fallback;
    },
    async write(serialized) {
      fallback = serialized;
      try {
        await invokeImpl("write_app_settings", { settings: serialized });
      } catch (error) {
        // Keep the in-memory fallback for the current renderer lifetime.
        if (strict) throw error;
      }
    }
  });
}

function emptySettings() {
  return { schema_version: SETTINGS_VERSION, app: { ...DEFAULT_APP_SETTINGS }, accounts: {} };
}

function normalizeSettings(value) {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { parsed = null; }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptySettings();
  const accounts = parsed.accounts && typeof parsed.accounts === "object" && !Array.isArray(parsed.accounts)
    ? parsed.accounts
    : {};
  const storedApp = parsed.app && typeof parsed.app === "object" && !Array.isArray(parsed.app)
    ? parsed.app
    : {};
  const app = { ...DEFAULT_APP_SETTINGS, ...storedApp };
  if (typeof app.language !== "string" || !app.language.trim()) {
    app.language = DEFAULT_APP_SETTINGS.language;
  }
  return { schema_version: SETTINGS_VERSION, app, accounts };
}

function restoreAppDefault(app, key) {
  delete app[key];
  if (Object.prototype.hasOwnProperty.call(DEFAULT_APP_SETTINGS, key)) {
    app[key] = DEFAULT_APP_SETTINGS[key];
  }
}
