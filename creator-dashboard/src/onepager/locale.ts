export type Lang = "zh" | "en" | "ja";

export function langFromBrowser(): Lang {
  if (typeof navigator === "undefined") return "en";
  const language = String(navigator.language ?? "").toLowerCase();
  if (language.startsWith("ja")) return "ja";
  return language.startsWith("zh") ? "zh" : "en";
}
