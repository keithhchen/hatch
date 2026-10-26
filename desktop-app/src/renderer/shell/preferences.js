import { createTranslator, normalizeLanguagePreference, resolveLanguage, systemLocales } from "../i18n.js";
import { Observable } from "../observable.js";

export const PREFERENCES_EVENT = "hatch://preferences";
export const THEMES = Object.freeze(["system", "light", "dark"]);
const normalizeTheme = value => THEMES.includes(value) ? value : "system";

/** Apply a theme preference to the document (the init script did the first paint). */
export function applyTheme(theme) {
  const root = document.documentElement;
  const dark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  root.dataset.theme = dark ? "dark" : "light";
  root.style.colorScheme = dark ? "dark" : "light";
}

/**
 * App-wide preferences (language, appearance), persisted natively and
 * broadcast so every Hatch window follows a change immediately.
 */
export class AppPreferences extends Observable {
  constructor({ invoke, emit, onEvent }) {
    super({ language: "system", theme: "system", ready: false });
    Object.assign(this, { invoke, emit });
    this.stop = onEvent(PREFERENCES_EVENT, payload => this.apply(payload));
    this.media = window.matchMedia?.("(prefers-color-scheme: dark)");
    this.media?.addEventListener?.("change", () => { if (this.state.theme === "system") applyTheme("system"); });
  }

  get t() {
    return createTranslator(resolveLanguage(this.state.language, systemLocales()));
  }

  async load() {
    let saved = {};
    try {
      saved = JSON.parse(await this.invoke("read_app_settings"))?.app ?? {};
    } catch {
      saved = {};
    }
    this.apply({ ...saved, ready: true });
  }

  apply({ language = this.state.language, theme = this.state.theme, ready = this.state.ready }) {
    const next = { language: normalizeLanguagePreference(language), theme: normalizeTheme(theme), ready };
    this.setState(next);
    applyTheme(next.theme);
    document.documentElement.lang = resolveLanguage(next.language, systemLocales());
  }

  async set(key, value) {
    const previous = this.state[key];
    this.apply({ [key]: value });
    try {
      await this.invoke("patch_app_settings", { patch: { app: { set: { [key]: this.state[key] } } } });
      void this.emit(PREFERENCES_EVENT, { [key]: this.state[key] });
    } catch (error) {
      this.apply({ [key]: previous });
      throw error;
    }
  }
}
