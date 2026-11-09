/**
 * VERIFICATION TOOL ONLY. Loaded into the Runtime with `node --import` (Stack option `runtimeNodeArgs`). It does not change what the
 * product sends: it wraps globalThis.fetch for the LLM provider hosts, appends each request body to the JSONL file named by
 * VERIFY_MODEL_RECORD, forwards the request unchanged to the real provider, and appends the provider's `usage` when the response
 * ends. The product exposes neither the model request nor the provider's raw usage, so this is how they are observed.
 */
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const file = process.env.VERIFY_MODEL_RECORD;
const hosts = ["api.moonshot.cn", "api.moonshot.ai", "generativelanguage.googleapis.com", "api.deepseek.com"];
const real = globalThis.fetch;
const write = (record) => { try { appendFileSync(file, `${JSON.stringify(record)}\n`); } catch { /* recording must never break the product */ } };

const usageIn = (text) => {
  let usage;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const chunk = JSON.parse(line.slice(5).trim());
      const found = chunk.usage ?? chunk.choices?.[0]?.usage ?? chunk.usageMetadata;
      if (found) usage = found;
    } catch { /* not json */ }
  }
  return usage;
};

if (file) {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!hosts.some((host) => url.includes(host)) || typeof init?.body !== "string") return real(input, init);
    const id = randomUUID();
    write({ kind: "request", id, at: Date.now(), url: url.replace(/key=[^&]+/, "key=REDACTED"), body: init.body });
    const response = await real(input, init);
    response.clone().text().then((text) => write({ kind: "usage", id, at: Date.now(), status: response.status, usage: usageIn(text) }), () => undefined);
    return response;
  };
}
