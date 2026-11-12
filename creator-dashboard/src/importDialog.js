import { importPrompt } from "./importPrompts.js";

export const AI_LINKS = [{ name: "ChatGPT", href: "https://chatgpt.com" }, { name: "Gemini", href: "https://gemini.google.com" }, { name: "Claude", href: "https://claude.ai" }];

export async function copyImportPrompt(locale, clipboard = globalThis.navigator?.clipboard) {
  try { await clipboard.writeText(importPrompt(locale)); return "copied"; } catch { return "failed"; }
}
