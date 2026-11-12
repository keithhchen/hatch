// API keys: a port over the dashboard `request` helper plus pure view-model helpers.
// Tokens are returned once by create() and are never stored or logged here.
const ROOT = "/v1/auth/api-keys";
// Settings route + the id of the API keys section there.
export const API_KEYS_PATH = "/studio/settings#api-keys";
export const LOGIN_COMMAND = "hatch login --api-key-stdin";

export class ApiKeysClient {
  #request;
  constructor(request) { this.#request = request; }
  async list() { return sortNewestFirst((await this.#request(ROOT))?.api_keys ?? []); }
  create(name) { return this.#request(ROOT, { method: "POST", body: JSON.stringify({ name: String(name).trim() }) }); }
  async revoke(id) { await this.#request(`${ROOT}/${encodeURIComponent(id)}`, { method: "DELETE" }); }
}

/** True only when the real key list loaded and is empty; a failure is never read as "no keys". */
export const hasNoApiKeys = (request) => new ApiKeysClient(request).list().then((keys) => keys.length === 0, () => false);

export const sortNewestFirst = (keys) => [...keys].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));

const INTL = { en: "en", zh: "zh-CN", ja: "ja-JP" };

/** Returns a formatter for one locale; null/invalid dates use `empty`. */
export const dateFormatter = (locale, empty) => (value) => {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.valueOf())) return empty;
  return new Intl.DateTimeFormat(INTL[locale] ?? "en", { dateStyle: "medium" }).format(date);
};

/** Table row view-model: what the list renders for one key. */
export const keyRow = (key, format, neverLabel) => ({
  id: key.id,
  name: key.name,
  created: format(key.created_at),
  lastUsed: key.last_seen_at ? format(key.last_seen_at) : neverLabel,
  expires: key.expires_at ? format(key.expires_at) : neverLabel
});
