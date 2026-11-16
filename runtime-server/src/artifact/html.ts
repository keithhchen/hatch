import { defaultTreeAdapter, html as htmlSpec, parse, serialize, type DefaultTreeAdapterMap } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type Doc = DefaultTreeAdapterMap["document"];

export const MAX_REPORT_HTML_BYTES = 2 * 1024 * 1024;

/** The report document, checked against the HTML contract; or every way it breaks the contract, to be fixed at once. */
export type ReportHtml = { ok: true; freeHtml: string; sections: Array<{ access: "free" | "paid"; title: string }> } | { ok: false; errors: string[] };

const isElement = (node: Node): node is Element => defaultTreeAdapter.isElementNode(node);
const attr = (element: Element, name: string) => element.attrs.find((a) => a.name === name)?.value;
const children = (node: Node): Node[] => "childNodes" in node ? node.childNodes : [];
const elements = (node: Node): Element[] => children(node).filter(isElement);

function* walk(node: Node): Generator<Element> {
  for (const child of children(node)) {
    if (isElement(child)) yield child;
    yield* walk(child);
  }
  
}

const HEADING = /^h[1-3]$/;
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

/** The container of the report's sections: <body>, or the one <main> that wraps them all. */
function container(body: Element): Element {
  const content = elements(body).filter((e) => e.tagName !== "style");
  return content.length === 1 && content[0]!.tagName === "main" ? content[0]! : body;
}

const firstHeading = (section: Element): Element | undefined => { for (const element of walk(section)) if (HEADING.test(element.tagName)) return element; return undefined; };
const textOf = (node: Node): string => "value" in node && node.nodeName === "#text" ? node.value : children(node).map(textOf).join("");

/**
 * Validates the report and derives the free HTML with a real HTML parser. A locked section keeps only its first
 * heading and an empty `<p class="locked">`, and gains `data-locked`; what was in it is not in the output at all.
 */
export function deriveFreeHtml(html: string): ReportHtml {
  if (typeof html !== "string" || !html.trim()) return { ok: false, errors: ["html is empty"] };
  if (Buffer.byteLength(html, "utf8") > MAX_REPORT_HTML_BYTES) return { ok: false, errors: [`The HTML is larger than ${MAX_REPORT_HTML_BYTES / 1024 / 1024} MB; shorten it`] };
  const errors: string[] = [];
  if (!/^\s*(<!--[\s\S]*?-->\s*)*<!doctype html/i.test(html)) errors.push("Start with <!doctype html>: one complete HTML document");
  const document = parse(html);
  const root = elements(document)[0];
  const body = root && elements(root).find((e) => e.tagName === "body");
  if (!body) return { ok: false, errors: [...errors, "There is no <body>"] };
  errors.push(...forbidden(document));
  if (!elements(root).some((e) => e.tagName === "head" && [...walk(e)].some((c) => c.tagName === "style")) && ![...walk(body)].some((e) => e.tagName === "style")) errors.push("Add one inline <style>");

  const top = elements(container(body)).filter((e) => e.tagName === "section");
  if (!top.length) errors.push("There are no top-level <section> elements; put each report section directly inside <body> (or one <main>)");
  const sections: Array<{ access: "free" | "paid"; title: string; element: Element }> = [];
  top.forEach((element, index) => {
    const access = attr(element, "data-access");
    const heading = firstHeading(element);
    const where = `Section ${index + 1}`;
    if (access !== "free" && access !== "paid") errors.push(`${where} needs data-access="free" or data-access="paid"${access ? ` (got "${access}")` : ""}`);
    if (!heading) errors.push(`${where} needs a heading (h1, h2 or h3) as its title`);
    else if (access === "free" || access === "paid") sections.push({ access, title: textOf(heading).trim(), element });
  });
  if (!errors.length) {
    if (!sections.some((s) => s.access === "free")) errors.push('There must be at least one data-access="free" section');
    if (!sections.some((s) => s.access === "paid")) errors.push('There must be at least one data-access="paid" section');
  }
  if (errors.length) return { ok: false, errors };

  for (const { access, element } of sections) {
    if (access !== "paid") continue;
    const heading = firstHeading(element)!;
    const lock = defaultTreeAdapter.createElement("p", htmlSpec.NS.HTML, [{ name: "class", value: "locked" }]);
    element.childNodes = [];
    for (const child of [heading, lock]) { child.parentNode = element; element.childNodes.push(child); }
    element.attrs.push({ name: "data-locked", value: "" });
  }
  appendLockedLayout(body);
  return { ok: true, freeHtml: serialize(document), sections: sections.map(({ access, title }) => ({ access, title })) };
}


/**
 * The report's own CSS starts each section on a new page; a locked section is only a heading, so in the free version
 * the locked ones flow together on one page instead of each filling a page of its own. Added last, so it wins.
 */
const LOCKED_LAYOUT = `section[data-locked]{break-before:auto!important;page-break-before:auto!important;break-after:auto!important;page-break-after:auto!important;min-height:0!important;height:auto!important;margin-top:6mm!important}
section[data-locked]:not(section[data-locked] + section[data-locked]){break-before:page!important;page-break-before:always!important}`;

function appendLockedLayout(body: Element): void {
  const style = defaultTreeAdapter.createElement("style", htmlSpec.NS.HTML, [{ name: "data-hatch", value: "locked-layout" }]);
  defaultTreeAdapter.insertText(style, LOCKED_LAYOUT);
  style.parentNode = body;
  body.childNodes.push(style);
}
