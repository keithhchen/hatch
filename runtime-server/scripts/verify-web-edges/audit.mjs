import { norm } from "./browser.mjs";

const matches = (patterns, text) => patterns.some((p) => (p instanceof RegExp ? p.test(text) : text.includes(p)));

/** Parsed server log lines at or after `since` (ISO). Lines that are not JSON are kept raw. */
export function logLines(web, since) {
  const out = [];
  for (const [source, text] of Object.entries(web.logs())) {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let json;
      try { json = JSON.parse(line); } catch { /* raw */ }
      if (json && json.ts && json.ts < since) continue;
      out.push({ source, line: line.slice(0, 500), json });
    }
  }
  return out;
}

/** What in the server logs is not business as usual. */
export function suspiciousLogs(lines) {
  return lines.filter(({ line, json }) => {
    if (json) return ["warn", "error"].includes(json.level) || (json.event === "access" && json.status >= 400) || /turn\.failed|unhandled|uncaught/i.test(line);
    return /error|exception|unhandled|ECONN|EPIPE/i.test(line) && !/ExperimentalWarning|trace-warnings/.test(line);
  });
}

/**
 * Turns everything the browsers and servers recorded into findings. A finding is anything that is not explained by `expected`
 * ({ alerts, console, http, failed, logs, frames }: patterns, each of which must carry a reason in the scenario that passes it).
 */
export function audit({ clients, world, conversationId, web, since, expected = {}, uiPicture }) {
  const findings = [];
  const add = (kind, detail) => findings.push({ kind, detail });
  for (const client of clients) {
    const w = client.watch;
    for (const a of w.alerts) if (!matches(expected.alerts ?? [], a.text)) add("ui-alert", `[${w.label} +${a.at}ms] ${a.text}`);
    for (const c of w.console) {
      // Chrome echoes every failed request as a console error; the request itself is judged below.
      if (/Failed to load resource/.test(c.text)) continue;
      if (!matches(expected.console ?? [], c.text)) add("console", `[${w.label} +${c.at}ms] ${c.type}: ${c.text}`);
    }
    for (const e of w.pageErrors) if (!matches(expected.console ?? [], e.text)) add("page-error", `[${w.label} +${e.at}ms] ${e.text}`);
    for (const r of w.http) { const s = `${r.method} ${r.status} ${r.url}`; if (!matches(expected.http ?? [], s)) add("http", `[${w.label} +${r.at}ms] ${s}`); }
    for (const r of w.failed) { const s = `${r.method} ${r.url} ${r.error}`; if (!matches(expected.failed ?? [], s)) add("request-failed", `[${w.label} +${r.at}ms] ${s}`); }
    for (const f of w.frames.filter((f) => f.dir === "<-" && /^(turn\.failed|error)$/.test(f.type))) {
      const s = `${f.type} ${f.code ?? ""}`; if (!matches(expected.frames ?? [], s)) add("ws-failure-frame", `[${w.label} +${f.at}ms] ${s}`);
    }
  }
  for (const entry of suspiciousLogs(logLines(web, since))) if (!matches(expected.logs ?? [], entry.line)) add("server-log", `${entry.source}: ${entry.line.slice(0, 300)}`);
  if (uiPicture) findings.push(...uiPicture);
  return findings;
}

/** UI messages versus the Runtime's history: no lost, no duplicated, no altered message. */
export async function compareToServer(client, world, conversationId, { page = client.page } = {}) {
  const ui = (await client.messages(page)).filter((m) => m.text || m.role === "user");
  const server = await world.messages(conversationId);
  const key = (m) => `${m.role}:${norm(m.text)}`;
  const problems = [];
  const uiKeys = ui.map(key); const serverKeys = server.map(key);
  if (JSON.stringify(uiKeys) !== JSON.stringify(serverKeys)) {
    const serverOnly = serverKeys.filter((k) => !uiKeys.includes(k)); const uiOnly = uiKeys.filter((k) => !serverKeys.includes(k));
    const dupes = uiKeys.filter((k, i) => uiKeys.indexOf(k) !== i);
    problems.push({ kind: "ui-vs-server", detail: `${client.label}: UI has ${ui.length} message(s), server has ${server.length}. Missing in UI: ${JSON.stringify(serverOnly.map((k) => k.slice(0, 60)))}; only in UI: ${JSON.stringify(uiOnly.map((k) => k.slice(0, 60)))}; duplicated in UI: ${JSON.stringify(dupes.map((k) => k.slice(0, 60)))}; order ${uiKeys.map((k) => k.slice(0, 12)).join("|")} vs ${serverKeys.map((k) => k.slice(0, 12)).join("|")}` });
  }
  return { problems, ui, server };
}
