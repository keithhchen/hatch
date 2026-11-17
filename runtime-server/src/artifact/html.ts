import { defaultTreeAdapter, parse, type DefaultTreeAdapterMap } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type Doc = DefaultTreeAdapterMap["document"];

export const MAX_REPORT_HTML_BYTES = 2 * 1024 * 1024;

const isElement = (node: Node): node is Element => defaultTreeAdapter.isElementNode(node);
const children = (node: Node): Node[] => "childNodes" in node ? node.childNodes : [];
const elements = (node: Node): Element[] => children(node).filter(isElement);

function* walk(node: Node): Generator<Element> {
  for (const child of children(node)) {
    if (isElement(child)) yield child;
    yield* walk(child);
  }
}

const FORBIDDEN_TAGS = new Set(["script", "link", "iframe", "object", "embed", "base"]);

/** What may not appear anywhere: the renderer prints the page offline, and a report is never interactive. */
function forbidden(document: Doc): string[] {
  const found = new Set<string>();
  for (const element of walk(document)) {
    if (FORBIDDEN_TAGS.has(element.tagName)) found.add(`<${element.tagName}> is not allowed (no scripts, links or embedded pages)`);
    for (const { name, value } of element.attrs) {
      if (name.startsWith("on")) found.add(`The ${name} attribute is not allowed (no scripts)`);
      if ((name === "src" || name === "srcset" || name === "poster") && !/^\s*data:/i.test(value)) found.add(`<${element.tagName} ${name}> must not load anything external; there are no images, fonts or frames to load`);
      if (name === "style" && /url\(\s*["']?(?!data:)/i.test(value)) found.add("A style attribute must not load anything external (url(...))");
    }
    if (element.tagName === "style") {
      const css = children(element).map((c) => ("value" in c ? c.value : "")).join("");
      if (/@import/i.test(css) || /url\(\s*["']?(?!data:|#)/i.test(css)) found.add("<style> must be self-contained: no @import, no url(...) to load fonts or images");
    }
  }
  return [...found];
}

/** A report document checked against the HTML contract: every way it breaks it, to be fixed at once; none when it is good. */
export function validateReportHtml(html: string): string[] {
  if (typeof html !== "string" || !html.trim()) return ["html is empty"];
  if (Buffer.byteLength(html, "utf8") > MAX_REPORT_HTML_BYTES) return [`The HTML is larger than ${MAX_REPORT_HTML_BYTES / 1024 / 1024} MB; shorten it`];
  const errors: string[] = [];
  if (!/^\s*(<!--[\s\S]*?-->\s*)*<!doctype html/i.test(html)) errors.push("Start with <!doctype html>: one complete HTML document");
  const document = parse(html);
  const root = elements(document)[0];
  const body = root && elements(root).find((e) => e.tagName === "body");
  if (!body) return [...errors, "There is no <body>"];
  errors.push(...forbidden(document));
  if (![...walk(document)].some((e) => e.tagName === "style")) errors.push("Add one inline <style>");
  return errors;
}
