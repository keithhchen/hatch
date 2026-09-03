import assert from "node:assert/strict";
import test from "node:test";

import {
  documentSkillNameForPath,
  documentSkillNameForAsset,
  findDocumentSkillForAsset,
  findDocumentSkillForPath,
  type SkillRecord
} from "./skills.js";

test("document extensions route to the corresponding complete Skill", () => {
  assert.equal(documentSkillNameForPath("brief.pdf"), "pdf");
  assert.equal(documentSkillNameForPath("brief.docx"), "documents");
  assert.equal(documentSkillNameForPath("brief.docm"), "documents");
  assert.equal(documentSkillNameForPath("budget.xlsx"), "spreadsheets");
  assert.equal(documentSkillNameForPath("budget.xltm"), "spreadsheets");
  assert.equal(documentSkillNameForPath("deck.pptx"), "presentations");
  assert.equal(documentSkillNameForPath("deck.pptm"), "presentations");
  assert.equal(documentSkillNameForPath("notes.md"), undefined);
  assert.equal(documentSkillNameForAsset("upload", "application/pdf"), "pdf");
  assert.equal(documentSkillNameForAsset("upload", "text/csv; charset=utf-8"), "spreadsheets");
  assert.equal(documentSkillNameForAsset("upload", "application/vnd.ms-word.document.macroEnabled.12"), "documents");
  assert.equal(documentSkillNameForAsset("upload", "application/vnd.ms-excel.sheet.macroEnabled.12"), "spreadsheets");
  assert.equal(documentSkillNameForAsset("upload", "application/vnd.ms-powerpoint.presentation.macroEnabled.12"), "presentations");
});

test("qualified plugin Skill names still satisfy document routing", () => {
  const records = [
    { name: "office:documents", path: "/skills/documents/SKILL.md" },
    { name: "office:pdf", path: "/skills/pdf/SKILL.md" }
  ] as SkillRecord[];
  assert.equal(findDocumentSkillForPath(records, "brief.docx")?.name, "office:documents");
  assert.equal(findDocumentSkillForPath(records, "brief.pdf")?.name, "office:pdf");
  assert.equal(findDocumentSkillForAsset(records, "upload", "application/pdf")?.name, "office:pdf");
});
