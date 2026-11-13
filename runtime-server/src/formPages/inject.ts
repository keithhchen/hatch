import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FormSchema } from "./schema.js";

export type FormView = {
  formId: string;
  token: string;
  schema: FormSchema;
  answers: Record<string, unknown>;
  /** The version of each answer the page holds: what a save is checked against. */
  versions: Record<string, number>;
  status: "open" | "submitted";
};

const REFERENCE = new URL("../../prompts/factory-agents/voice/form-reference/", import.meta.url);
let baseCss: string | undefined;
/** Hatch's base styles for form pages: the same file the agent is shown, so what it sees is what the page gets. */
export const formBaseCss = (): string => baseCss ??= readFileSync(fileURLToPath(new URL("base.css", REFERENCE)), "utf8");

/** The `window.hatch` of one page. It carries the page's link token, so the agent's own code never handles one. */
const CLIENT = `(function () {
  var d = window.__HATCH_FORM__; delete window.__HATCH_FORM__;
  var base = "/form/" + d.formId, token = "t=" + encodeURIComponent(d.token);
  var hatch = window.hatch = { schema: d.schema, answers: d.answers, status: d.status, save: save, clear: clear, submit: submit };
  function call(method, path, body) {
    return fetch(base + path + (path.indexOf("?") < 0 ? "?" : "&") + token, { method: method, credentials: "omit", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined })
      .catch(function () { throw new Error("网络不通，内容还在，稍后再试"); })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error((j.error && j.error.message) || "没保存成功，内容还在，稍后再试"); return j; }); });
  }
  function write(id, value) {
    return call("POST", "/answers/" + encodeURIComponent(id), { value: value, base: d.versions[id] || 0 }).then(function (j) { d.versions[id] = j.version; hatch.answers[id] = value; });
  }
  function save(id, value) { return write(id, value); }
  function clear(id) {
    return call("DELETE", "/answers/" + encodeURIComponent(id) + "?base=" + (d.versions[id] || 0)).then(function (j) { d.versions[id] = j.version; delete hatch.answers[id]; });
  }
  function submit() { return call("POST", "/submit").then(function () { hatch.status = "submitted"; }); }
})();`;

/** `</script>`, and the two line separators JSON allows but scripts do not, cannot end or break the data. */
const embedded = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(new RegExp("[\\u2028\\u2029]", "g"), c => `\\u${c.charCodeAt(0).toString(16)}`);

/**
 * The page the agent wrote, with what Hatch adds, first in <head> so the agent's own CSS and scripts come after:
 * the base styles, the page's data and the client. A page without a <head> gets one.
 */
export function renderFormPage(html: string, view: FormView): string {
  const css = formBaseCss().split("</style").join("<\\/style");
  const inject = `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style data-hatch-base>${css}</style><script>window.__HATCH_FORM__=${embedded(view)};${CLIENT}</script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + inject + html.slice(head.index + head[0].length);
  const root = /<html(\s[^>]*)?>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + `<head>${inject}</head>` + html.slice(root.index + root[0].length);
  return `<!doctype html><html><head><meta charset="utf-8">${inject}</head><body>${html}</body></html>`;
}
