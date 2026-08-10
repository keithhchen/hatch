const SETTINGS_VERSION = 1;

export function createDesktopSettingsStore({ read = async () => null, write = async () => {} } = {}) {
  let state = emptySettings();
  let loaded = false;
  let writeChain = Promise.resolve();

  return {
    async load() {
      if (loaded) return state;
      try {
        const raw = await read();
        state = normalizeSettings(raw);
      } catch {
        state = emptySettings();
      }
      loaded = true;
      return state;
    },
    getProfile(profileId, key, fallback = undefined) {
      return state.accounts?.[String(profileId)]?.[key] ?? fallback;
    },
    setProfile(profileId, key, value) {
      const id = String(profileId || "anonymous");
      if (!state.accounts[id]) state.accounts[id] = {};
      if (value === undefined) delete state.accounts[id][key];
      else state.accounts[id][key] = value;
      persist();
    },
    removeProfile(profileId, key) {
      const id = String(profileId || "anonymous");
      if (!state.accounts[id]) return;
      delete state.accounts[id][key];
      persist();
    },
    snapshot() {
      return JSON.parse(JSON.stringify(state));
    }
  };

  function persist() {
    const serialized = JSON.stringify(state);
    writeChain = writeChain.then(() => write(serialized)).catch(() => {});
  }
}

export function createTauriSettingsStore(invokeImpl) {
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
      } catch {
        // Keep the in-memory fallback for the current renderer lifetime.
      }
    }
  });
}

function emptySettings() {
  return { schema_version: SETTINGS_VERSION, accounts: {} };
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
  return { schema_version: SETTINGS_VERSION, accounts };
}
