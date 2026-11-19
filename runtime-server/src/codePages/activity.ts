/** What a Run's tool call is, in words a buyer understands: [what it matches, the verb, the thing]. Calls that match nothing are not shown. */
const RULES: Array<[RegExp, string, string]> = [
  [/openssl|certificate|\bssl\b|\btls\b/, "检查", "网站的 HTTPS 证书"],
  [/\bdig\b|nslookup|whois|geoip|traceroute/, "确认", "服务器所在的地区"],
  [/page_?speed|lighthouse|web_?vitals/, "对比", "手机端与电脑端的打开速度"],
  [/google_?maps|places|map_?search/, "查看", "Google 地图上的商家信息"],
  [/fetch|crawl|browse|screenshot|scrape|curl|wget/, "打开", "官网页面，看海外买家看到的样子"],
  [/search|\bexa\b/, "查找", "公开的行业与口碑信息"],
  [/(^|[._])(write|edit)$/, "撰写", "报告内容"]
];

export type ToolCallView = { name: string; arguments?: Record<string, unknown>; status?: string };

/** One plain-language line for a tool call: in progress while requested, past tense once it has completed. Never the tool's own name. */
export function activityLine(call: ToolCallView): string | undefined {
  if (call.status === "failed" || call.status === "cancelled") return undefined;
  const haystack = `${call.name} ${/bash|shell|exec/.test(call.name) ? JSON.stringify(call.arguments ?? {}) : ""}`.trim().toLowerCase();
  const rule = RULES.find(([pattern]) => pattern.test(haystack));
  if (!rule) return undefined;
  return call.status === "completed" ? `已${rule[1]}${rule[2]}` : `正在${rule[1]}${rule[2]}`;
}

/** The latest distinct lines, oldest first. A thing done once and asked again shows once, at its latest state. */
export function recentActivity(calls: ToolCallView[], limit = 6): string[] {
  const lines = new Map<string, string>();
  for (const call of calls) {
    const line = activityLine(call);
    if (!line) continue;
    const thing = line.replace(/^(已|正在)/, "");
    lines.delete(thing);
    lines.set(thing, line);
  }
  return [...lines.values()].slice(-limit);
}
