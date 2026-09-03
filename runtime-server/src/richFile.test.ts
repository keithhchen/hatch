import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import * as XLSX from "xlsx";
import { extractRichDocument, normalizeRichFileReadResult } from "./richFile.js";

test("rich file adapter projects DOCX text while retaining binary data only ephemerally", async () => {
  const bytes = minimalDocx("Hatch document text");
  const result = await normalizeRichFileReadResult({
    path: "brief.docx",
    content_type: "document",
    mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes: bytes.length,
    data_base64: bytes.toString("base64")
  });

  assert.match(String(result.content), /Hatch document text/);
  assert.deepEqual(result.extraction, { format: "docx", truncated: false });
  assert.equal(result.data_base64, bytes.toString("base64"));
});

test("rich file adapter projects XLSX and PPTX content with bounded text", async () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([["Guest", "Dish"], ["Alice", "Noodles"]]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Dinner");
  const xlsxBytes = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  const xlsx = await extractRichDocument("dinner.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xlsxBytes);
  assert.equal(xlsx.format, "xlsx");
  assert.match(xlsx.content, /Guest\tDish/);
  assert.match(xlsx.content, /Alice\tNoodles/);

  const pptxBytes = zipSync({
    "ppt/slides/slide1.xml": strToU8("<p:sld xmlns:a=\"urn:a\"><a:t>Launch plan</a:t><a:t>Q4</a:t></p:sld>"),
    "ppt/slides/slide2.xml": strToU8("<p:sld xmlns:a=\"urn:a\"><a:t>Next steps</a:t></p:sld>")
  });
  const pptx = await extractRichDocument(
    "plan.pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    Buffer.from(pptxBytes)
  );
  assert.equal(pptx.format, "pptx");
  assert.match(pptx.content, /Launch plan Q4/);
  assert.match(pptx.content, /Next steps/);
});

test("rich file adapter projects PDF pages into bounded text", async () => {
  const bytes = minimalPdf("PDF text from Hatch");
  const result = await normalizeRichFileReadResult({
    path: "brief.pdf",
    content_type: "document",
    mime_type: "application/pdf",
    bytes: bytes.length,
    data_base64: bytes.toString("base64")
  });

  assert.match(String(result.content), /PDF text from Hatch/);
  assert.deepEqual(result.extraction, { format: "pdf", truncated: false });
});

test("rich file adapter reports unsupported legacy formats without exposing a fake projection", async () => {
  const result = await normalizeRichFileReadResult({
    path: "legacy.doc",
    content_type: "document",
    mime_type: "application/msword",
    bytes: 3,
    data_base64: Buffer.from([1, 2, 3]).toString("base64")
  });

  assert.deepEqual(result.extraction, {
    format: "doc",
    status: "unavailable",
    error: "No built-in text projection for application/msword"
  });
  assert.equal(result.content, undefined);
});

function minimalDocx(text: string): Buffer {
  const documentXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
  return Buffer.from(zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/document.xml": strToU8(documentXml)
  }));
}

function minimalPdf(text: string): Buffer {
  const escapedText = text.replace(/[\\()]/g, (value) => `\\${value}`);
  const contentStream = `BT /F1 12 Tf 72 720 Td (${escapedText}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(contentStream, "utf8")} >>\nstream\n${contentStream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}
