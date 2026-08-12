const SETTINGS_VERSION = 1;

export function createDesktopSettingsStore({ read = async () => null, write = async () => {}, patch = null } = {}) {
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
      persistProfilePatch(id, value === undefined ? { remove: [key] } : { set: { [key]: value } });
    },
    async importProfile(profileId, values) {
      if (!values || typeof values !== "object" || Array.isArray(values)) {
        throw new Error("Imported Desktop settings must be an object.");
      }
      const id = String(profileId || "anonymous");
      const previous = state;
      state = {
        ...state,
        accounts: {
          ...state.accounts,
          [id]: { ...(state.accounts[id] ?? {}), ...values }
        }
      };
      try {
        await enqueueProfilePatch(id, { set: values });
      } catch (error) {
        state = previous;
        throw error;
      }
      return state.accounts[id];
    },
    removeProfile(profileId, key) {
      const id = String(profileId || "anonymous");
      if (!state.accounts[id]) return;
      delete state.accounts[id][key];
      persistProfilePatch(id, { remove: [key] });
    },
    async clearProfileKey(profileId, key) {
      const id = String(profileId || "anonymous");
      if (!state.accounts[id] || !(key in state.accounts[id])) return;
      const previous = state;
      const nextProfile = { ...state.accounts[id] };
      delete nextProfile[key];
      state = {
        ...state,
        accounts: {
          ...state.accounts,
          [id]: nextProfile
        }
      };
      try {
        await enqueueProfilePatch(id, { remove: [key] });
      } catch (error) {
        state = previous;
        throw error;
      }
    },
    snapshot() {
      return JSON.parse(JSON.stringify(state));
    }
  };

  function persist() {
    void enqueueWrite(JSON.stringify(state));
  }

  function persistProfilePatch(profileId, operation) {
    if (typeof patch === "function") {
      void enqueueProfilePatch(profileId, operation);
    } else {
      persist();
    }
  }

  function enqueueProfilePatch(profileId, operation) {
    if (typeof patch !== "function") return enqueueWrite(JSON.stringify(state));
    const pending = writeChain.then(() => patch({ profileId, ...operation }));
    writeChain = pending.catch(() => {});
    return pending;
  }

  function enqueueWrite(serialized) {
    const pending = writeChain.then(() => write(serialized));
    writeChain = pending.catch(() => {});
    return pending;
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
    },
    async patch(request) {
      try {
        await invokeImpl("patch_app_settings", { patch: request });
      } catch (error) {
        if (strict) throw error;
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
