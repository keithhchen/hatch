import { escapeHtml } from "./email.js";

/**
 * Copied from the report email (agentBox/reportEmail.ts on feat/report-email) so this branch stands alone; dedupe at merge.
 * `{{name}}` is the value (HTML-escaped unless `plain`); `{{#name}}…{{/name}}` stays only when the value is not empty. Unknown names are
 * empty. Blocks do not nest.
 */
export function renderTemplate(source: string, values: Record<string, string | undefined>, plain = false): string {
  const value = (name: string) => values[name]?.trim() ?? "";
  return source
    .replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, name: string, body: string) => value(name) ? body : "")
    .replace(/\{\{(\w+)\}\}/g, (_, name: string) => plain ? value(name) : escapeHtml(value(name)));
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/** The plain-text alternative of any template: links kept as "text (url)", blocks on their own lines. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(head|style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, text: string) => `${text.replace(/<[^>]*>/g, "")} (${href})`)
    .replace(/<br\s*\/?>|<\/(p|tr|div|h\d|li)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, entity => ENTITIES[entity]!)
    .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
