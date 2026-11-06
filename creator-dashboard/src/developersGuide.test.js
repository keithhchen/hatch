import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEVELOPER_LOCALES, DevelopersGuide, METHODS, ORIGIN, parseDevelopersRoute } from "./developersGuide.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

test("/developers is a public route with one tab per method", () => {
  assert.deepEqual(parseDevelopersRoute("/developers"), { tab: "cli" });
  assert.deepEqual(parseDevelopersRoute("/developers/"), { tab: "cli" });
  assert.deepEqual(parseDevelopersRoute("/developers/api?x=1"), { tab: "api" });
  assert.deepEqual(parseDevelopersRoute("/developers/mcp"), { tab: "mcp" });
  assert.equal(parseDevelopersRoute("/developers/other"), null);
  assert.equal(parseDevelopersRoute("/developers/cli/extra"), null);
  assert.equal(parseDevelopersRoute("/developer"), null);
  assert.equal(parseDevelopersRoute("/studio/developers"), null);
  for (const method of METHODS) assert.deepEqual(parseDevelopersRoute(method.path), { tab: method.id });
});

test("every locale titles every step of every method", () => {
  assert.deepEqual([...DEVELOPER_LOCALES].sort(), ["en", "ja", "zh"]);
  for (const locale of DEVELOPER_LOCALES) {
    const guide = DevelopersGuide.forLocale(locale);
    assert.deepEqual(guide.tabs.map((tab) => tab.id), ["cli", "api", "mcp"]);
    for (const tab of guide.tabs) {
      assert.ok(tab.label);
      tab.steps.forEach((step, index) => {
        assert.equal(step.number, index + 1);
        assert.ok(step.title, `${locale}/${tab.id}/${step.id} needs a title`);
        assert.ok(step.code.length, `${tab.id}/${step.id} needs code`);
      });
    }
  }
});

test("code is shared across locales and an unknown locale or tab falls back", () => {
  const code = (locale) => DevelopersGuide.forLocale(locale).tabs.map((tab) => tab.steps.map((step) => step.code));
  assert.deepEqual(code("zh"), code("en"));
  assert.deepEqual(code("ja"), code("en"));
  assert.equal(DevelopersGuide.forLocale("fr").copy.title, "Developers");
  assert.equal(DevelopersGuide.forLocale("en").tab("nope").id, "cli");
});

test("snippets target production and the documented endpoints", () => {
  const all = DevelopersGuide.forLocale("en").tabs.flatMap((tab) => tab.steps.flatMap((step) => step.code.map((block) => block.text))).join("\n");
  assert.ok(all.includes(`npm install -g ${ORIGIN}/downloads/hatch-cli.tgz`));
  for (const fragment of ["/v1/auth/me", "/v1/creator/products", "/listing", "/ingest", "expected_updated_at", "content_base64", "base64 -i notes.pdf | tr -d '\\n'", "/workers/research/messages?wait=60", "/workers/research/events", "/v1/creator/assistant/conversation/messages", "hatch chat <product-id> research", "worker_send", "hatch login --api-key-stdin", "claude mcp add hatch -- hatch mcp", "[mcp_servers.hatch]"]) {
    assert.ok(all.includes(fragment), `missing ${fragment}`);
  }
  assert.doesNotMatch(all, /localhost|127\.0\.0\.1/);
});

test("docs/unified-api-guide.md carries every English snippet", () => {
  const markdown = readFileSync(`${repoRoot}/docs/unified-api-guide.md`, "utf8");
  for (const tab of DevelopersGuide.forLocale("en").tabs) {
    for (const step of tab.steps) {
      assert.ok(markdown.includes(step.title), `guide lacks "${step.title}"`);
      for (const block of step.code) assert.ok(markdown.includes(block.text), `guide lacks code of ${tab.id}/${step.id}`);
    }
  }
});
