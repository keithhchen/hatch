import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AI_LINKS, copyImportPrompt } from "./importDialog.js";
import { IMPORT_PROMPTS } from "./importPrompts.js";
import { createFactoryAgentTranslator } from "./factoryAgentsI18n.js";

const source = await readFile(new URL("./FactoryAgents.jsx", import.meta.url), "utf8");

test("Copy writes the prompt of the current locale and reports copied", async () => {
  for (const locale of ["en", "zh", "ja"]) {
    const written = [];
    assert.equal(await copyImportPrompt(locale, { writeText: async text => { written.push(text); } }), "copied");
    assert.deepEqual(written, [IMPORT_PROMPTS[locale]]);
  }
  assert.notEqual(IMPORT_PROMPTS.zh, IMPORT_PROMPTS.en);
});

test("a failing clipboard is reported as failed, never as copied", async () => {
  assert.equal(await copyImportPrompt("en", { writeText: async () => { throw new Error("denied"); } }), "failed");
  assert.equal(await copyImportPrompt("en", undefined), "failed");
});

test("the three AI links open in a new tab with noopener", () => {
  assert.deepEqual(AI_LINKS.map(link => [link.name, link.href]), [["ChatGPT", "https://chatgpt.com"], ["Gemini", "https://gemini.google.com"], ["Claude", "https://claude.ai"]]);
  assert.match(source, /<a key=\{link\.name\} href=\{link\.href\} target="_blank" rel="noopener noreferrer">/);
});

test("the prompt text is never rendered and the Upload page textarea is gone", () => {
  assert.doesNotMatch(source, /importPrompt|IMPORT_PROMPTS/);
  assert.doesNotMatch(source, /factory-upload-text|manualTextLabel|saveText/);
  const upload = source.slice(source.indexOf("function SourceUploadWorkspace"), source.indexOf("function ImportFromAi"));
  assert.doesNotMatch(upload, /<Textarea/);
  assert.match(upload, /<ImportFromAi saveManualText=\{saveManualText\}/);
});

test("the pasted text is saved to input/manual, disabled while empty or saving, and failures show the server error", () => {
  assert.match(source, /path: `input\/manual\/imported-from-ai-\$\{/);
  assert.match(source, /disabled=\{!text\.trim\(\) \|\| saving\}/);
  assert.match(source, /await saveManualText\(text\); setText\(""\); setOpen\(false\)/);
  assert.match(source, /catch \(e\) \{ setError\(e\.message\); \}/);
  assert.match(source, /\{error \? <InlineAlert tone="error">\{error\}<\/InlineAlert> : null\}/);
});

test("dialog copy exists in en, zh and ja", () => {
  const keys = ["importFromAi", "importIntro", "importCopy", "importCopied", "importCopyFailed", "importOrAgent", "importPasteLabel", "importSave"];
  const en = createFactoryAgentTranslator("en");
  for (const locale of ["zh", "ja"]) { const t = createFactoryAgentTranslator(locale); for (const key of keys) assert.notEqual(t(key), en(key), `${locale}.${key}`); }
  assert.equal(en("importFromAi"), "Import from other AI");
  assert.equal(createFactoryAgentTranslator("zh")("importFromAi"), "从其他 AI 导入");
  assert.equal(createFactoryAgentTranslator("ja")("importSave"), "取り込んで保存");
});
