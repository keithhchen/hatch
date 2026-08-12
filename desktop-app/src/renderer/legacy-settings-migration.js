import { PERMISSION_POLICIES } from "./product-policy.js";
import { englishMessage } from "./i18n.js";

export const LEGACY_SETTINGS_IMPORT_MARKER = "legacy_web_storage_import_v1";

const MIGRATION_STATUS_KEYS = Object.freeze({
  "not-available": "migration.status.notAvailable",
  "already-imported": "migration.status.alreadyImported",
  completed: "migration.status.completed",
  "nothing-to-import": "migration.status.nothingToImport"
});

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
    return migrationResult("not-available");
  }
  // Secret cleanup is independent from preference migration. Never copy or
  // parse legacy auth payloads; remove every known key even if native settings
  // persistence later fails.
  purgeLegacySensitiveStorage(legacyStorage);
  if (settingsStore.getProfile(profileId, LEGACY_SETTINGS_IMPORT_MARKER, false)) {
    return migrationResult("already-imported");
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

  try {
    await settingsStore.importProfile(profileId, {
      ...imported,
      [LEGACY_SETTINGS_IMPORT_MARKER]: true
    });
  } catch (error) {
    throw annotateError(error, "error.migration.importFailed");
  }
  for (const key of removableKeys) legacyStorage.removeItem(key);

  const migrated = importedKeys.length > 0;
  const reset = resetKeys.length > 0;
  const status = migrated || reset ? "completed" : "nothing-to-import";
  return migrationResult(status, {
    importedKeys,
    resetKeys,
    notice: migrationNotice({ migrated, reset }),
    noticeKey: migrationNoticeKey({ migrated, reset })
  });
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
    return englishMessage("migration.notice.importedAndReset");
  }
  if (migrated) return englishMessage("migration.notice.imported");
  if (reset) return englishMessage("migration.notice.reset");
  return "";
}

function migrationNoticeKey({ migrated, reset }) {
  if (migrated && reset) return "migration.notice.importedAndReset";
  if (migrated) return "migration.notice.imported";
  if (reset) return "migration.notice.reset";
  return "";
}

function migrationResult(status, values = {}) {
  return {
    status,
    statusKey: MIGRATION_STATUS_KEYS[status],
    notice: "",
    noticeKey: "",
    ...values
  };
}

function annotateError(error, i18nKey) {
  if (!error || typeof error !== "object") return error;
  error.i18nKey = i18nKey;
  return error;
}
