import { PERMISSION_POLICIES } from "./product-policy.js";

export const LEGACY_SETTINGS_IMPORT_MARKER = "legacy_web_storage_import_v1";

const LEGACY_FIELDS = Object.freeze([
  Object.freeze({ legacy: "permissionMode", native: "permission_mode", validate: validPermission }),
  Object.freeze({ legacy: "conversationId", native: "conversation_id", validate: validConversationId })
]);
// A path string is not an OS authorization. Workspace access must be chosen
// again so native code can create an opaque grant from the folder picker.
const RESET_ONLY_FIELDS = Object.freeze(["workspaceRoot", "activeRun"]);
const LEGACY_AUTH_ACTIVE_KEY = "hatch.auth.activeProfile";
const LEGACY_AUTH_PROFILE_PREFIX = "hatch.auth.profile.";

export async function importLegacyProfileSettings({ profileId, legacyStorage, settingsStore }) {
  if (!profileId || !legacyStorage || !settingsStore?.importProfile) {
    return { status: "not-available", notice: "" };
  }
  // Secret cleanup is independent from preference migration. Never copy or
  // parse legacy auth payloads; remove every known key even if native settings
  // persistence later fails.
  purgeLegacySensitiveStorage(legacyStorage);
  if (settingsStore.getProfile(profileId, LEGACY_SETTINGS_IMPORT_MARKER, false)) {
    return { status: "already-imported", notice: "" };
  }

  const imported = {};
  const importedKeys = [];
  const resetKeys = [];
  const removableKeys = [];
  for (const field of LEGACY_FIELDS) {
    const key = legacyProfileStorageKey(profileId, field.legacy);
    const value = legacyStorage.getItem(key);
    if (value === null) continue;
    removableKeys.push(key);
    if (field.validate(value)) {
      imported[field.native] = value.trim();
      importedKeys.push(field.native);
    } else {
      resetKeys.push(field.legacy);
    }
  }
  for (const field of RESET_ONLY_FIELDS) {
    const key = legacyProfileStorageKey(profileId, field);
    if (legacyStorage.getItem(key) === null) continue;
    removableKeys.push(key);
    resetKeys.push(field);
  }

  await settingsStore.importProfile(profileId, {
    ...imported,
    [LEGACY_SETTINGS_IMPORT_MARKER]: true
  });
  for (const key of removableKeys) legacyStorage.removeItem(key);

  const migrated = importedKeys.length > 0;
  const reset = resetKeys.length > 0;
  return {
    status: migrated || reset ? "completed" : "nothing-to-import",
    importedKeys,
    resetKeys,
    notice: migrationNotice({ migrated, reset })
  };
}

export function legacyProfileStorageKey(profileId, field) {
  return `hatch.profile.${encodeURIComponent(profileId)}.${field}`;
}

export function purgeLegacyAuthStorage(legacyStorage) {
  const keys = [LEGACY_AUTH_ACTIVE_KEY];
  for (let index = 0; index < Number(legacyStorage.length ?? 0); index += 1) {
    const key = legacyStorage.key(index);
    if (typeof key === "string" && key.startsWith(LEGACY_AUTH_PROFILE_PREFIX)) keys.push(key);
  }
  for (const key of new Set(keys)) legacyStorage.removeItem(key);
}

export function purgeLegacySensitiveStorage(legacyStorage) {
  purgeLegacyAuthStorage(legacyStorage);
  legacyStorage.removeItem("hatch.debug.lastTurnTiming");
}

function validPermission(value) {
  return value === PERMISSION_POLICIES.ASK_BEFORE_CHANGES
    || value === PERMISSION_POLICIES.ALLOW_CHANGES;
}

function validConversationId(value) {
  const trimmed = String(value).trim();
  return trimmed.length > 0
    && trimmed.length <= 256
    && /^[A-Za-z0-9._:-]+$/.test(trimmed);
}

function migrationNotice({ migrated, reset }) {
  if (migrated && reset) {
    return "Previous Desktop preferences were moved to Hatch app storage. An unfinished task or invalid legacy value was safely reset.";
  }
  if (migrated) return "Previous Desktop preferences were moved to Hatch app storage.";
  if (reset) return "An unfinished task or invalid legacy setting was safely reset. Choose a workspace again if needed.";
  return "";
}
