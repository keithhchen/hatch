export type Lang = "zh" | "en" | "ja";

import { detectWebLocale } from "../webI18n.js";

export function langFromBrowser(): Lang {
  return detectWebLocale() as Lang;
}
