import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardApp } from "../server.mjs";
import { answeredCount, assignNames, buildFormMd, draftStore, fileMediaType, formatElapsed, isAcceptedFile, resumeView, submissionIds, validateIntake } from "./artifactForm.js";
import { ArtifactApi, loadArtifact } from "./artifactClient.js";
import { ArtifactRoute } from "./artifactRoute.js";
import { WebChatRoute } from "./webChatRoute.js";

const fields = [
  { id: "grade", label: "孩子现在读几年级？", type: "choice", required: true, options: ["初二", "初三"] },
  { id: "story", label: "最近的情况", type: "long_text", required: true },
  { id: "subjects", label: "弱项科目", type: "multi", options: ["数学", "英语"] },
  { id: "reports", label: "成绩单", type: "files", required: false }
];
const file = (name, type = "") => ({ name, type, size: 10 });

test("form.md: answers, a files field's paths, then a 文件 section listing every file by its /attachments path", () => {
  const md = buildFormMd("升学规划", fields, { grade: "初三", story: "暂无", subjects: ["数学", "英语"], reports: "见附件" }, { reports: ["期中.pdf", "期末.jpg"] });
  assert.equal(md, [
    "# 升学规划", "## 孩子现在读几年级？\n\n初三", "## 最近的情况\n\n暂无", "## 弱项科目\n\n数学、英语",
    "## 成绩单\n\n见附件\n- /attachments/期中.pdf\n- /attachments/期末.jpg",
    "## Files\n\n- /attachments/form.md\n- /attachments/期中.pdf (成绩单)\n- /attachments/期末.jpg (成绩单)"
  ].join("\n\n") + "\n");
  assert.equal(buildFormMd("P", fields, { grade: "初二" }, {}), "# P\n\n## 孩子现在读几年级？\n\n初二\n\n## Files\n\n- /attachments/form.md\n");
});

test("file names are made unique like the Runtime's flat view: same name gets (2), (3) before the extension, in upload order", () => {
  assert.deepEqual(assignNames(["问卷.md", "奖状.jpg", "奖状.jpg", "奖状.jpg", "问卷.md", "README"]), ["问卷.md", "奖状.jpg", "奖状 (2).jpg", "奖状 (3).jpg", "问卷 (2).md", "README"]);
  assert.deepEqual(assignNames(["a (2).jpg", "a.jpg", "a.jpg"]), ["a (2).jpg", "a.jpg", "a (3).jpg"], "a taken name is never reused");
  assert.deepEqual(assignNames(["x", "x", ".env", ".env"]), ["x", "x (2)", ".env", ".env (2)"]);
  const md = buildFormMd("P", fields, {}, { reports: assignNames(["奖状.jpg", "奖状.jpg"]) });
  assert.match(md, /- \/attachments\/奖状 \(2\)\.jpg \(成绩单\)/);
});

test("intake validation: required fields, a typed 暂无 counts, files answer a files field, at most 20 files (form.md comes on top)", () => {
  assert.deepEqual(validateIntake(fields, {}, {}), [{ field: "grade", code: "required" }, { field: "story", code: "required" }]);
  assert.deepEqual(validateIntake(fields, { grade: "初二", story: "暂无/不确定" }, {}), []);
  assert.deepEqual(validateIntake(fields, { grade: "初二", story: "  " }, {}).map(problem => problem.field), ["story"]);
  const requiredFiles = [{ id: "docs", label: "资料", type: "files", required: true }];
  assert.equal(validateIntake(requiredFiles, {}, { docs: [file("a.pdf")] }).length, 0);
  const eleven = Array.from({ length: 21 }, (_, index) => file(`${index}.pdf`));
  assert.deepEqual(validateIntake(requiredFiles, {}, { docs: eleven }), [{ field: null, code: "fileLimit" }]);
  assert.equal(validateIntake(requiredFiles, {}, { docs: eleven.slice(0, 20) }).length, 0);
  assert.equal(answeredCount(fields, { grade: "初二", subjects: [] }, { reports: [file("a.pdf")] }), 2);
});

test("file types: images, PDF and Word, by type or by extension", () => {
  assert.equal(fileMediaType(file("a.docx")), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.ok(isAcceptedFile(file("IMG.JPG")) && isAcceptedFile(file("a.pdf")) && isAcceptedFile(file("x", "image/heic")));
  assert.ok(!isAcceptedFile(file("a.zip")));
});

test("drafts survive per product, and a missing or failing storage breaks nothing", () => {
  const map = new Map();
  const storage = { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
  const draft = draftStore(storage, "p1");
  draft.save({ grade: "初二" });
  assert.deepEqual(draft.load(), { grade: "初二" });
  assert.deepEqual(draftStore(storage, "p2").load(), {});
  draft.clear();
  assert.deepEqual(draft.load(), {});
  assert.deepEqual(draftStore(null, "p1").load(), {});
  draftStore(null, "p1").save({ a: 1 });
  assert.equal(formatElapsed(187_000), "3:07");
});

test("artifact has its own route beside chat; neither parses the other's paths", () => {
  const product = "22222222-2222-4222-8222-222222222222";
  assert.deepEqual({ ...ArtifactRoute.parse(`/artifact/${product}`) }, { productId: product, conversationId: null });
  assert.deepEqual({ ...ArtifactRoute.parse(`/artifact/${product}/c1`) }, { productId: product, conversationId: "c1" });
  assert.equal(ArtifactRoute.conversationPath(product, "c 1"), `/artifact/${product}/c%201`);
  assert.equal(ArtifactRoute.parse(`/chat/product/${product}`), null);
  assert.equal(WebChatRoute.parse(`/artifact/${product}`), null);
});

test("loading an artifact product: definition and the buyer's reports; a chat-only product is not one", async () => {
  const calls = [];
  const request = async url => {
    calls.push(url);
    if (url.includes("/products/chat-product/")) throw Object.assign(new Error("not found"), { status: 404 });
    if (url.includes("/artifact/conversations")) return [{ conversation_id: "c9", status: "ready" }];
    return { intake: { fields } };
  };
  assert.equal(await loadArtifact(request, { entitlement_id: "e1" }, "chat-product"), null);
  const mode = await loadArtifact(request, { entitlement_id: "e1" }, "artifact-product");
  assert.deepEqual(mode.conversations, [{ conversation_id: "c9", status: "ready" }]);
  assert.deepEqual(calls.slice(1), ["/v1/web-chat/products/artifact-product/artifact?entitlement_id=e1", "/v1/web-chat/products/artifact-product/artifact/conversations?entitlement_id=e1"]);
  await assert.rejects(loadArtifact(async () => { throw Object.assign(new Error("boom"), { status: 500 }); }, {}, "p"), /boom/);
});

test("submit sequence: create, upload form.md then every file, then a message with the form text only", async () => {
  const log = [];
  const request = async (url, init) => { log.push(`${init?.method ?? "GET"} ${url.split("?")[0]} key=${init?.headers?.["idempotency-key"]}`); return { conversation_id: "c1" }; };
  const api = new ArtifactApi(request, { entitlement_id: "e1" });
  api.upload = async (conversationId, file, name, mediaType) => { log.push(`upload ${conversationId} ${name} ${mediaType}`); return {}; };
  api.transport.connect = (conversationId, { onOpen, onEvent }) => {
    const connection = { hello: () => setTimeout(() => onEvent({ type: "session.ready" })), close() {}, send: message => { log.push(`message ${JSON.stringify(Object.keys(message).sort())} ${message.clientMessageId} ${message.runId}`); setTimeout(() => onEvent({ type: "message.accepted", client_message_id: message.clientMessageId })); } };
    setTimeout(onOpen);
    return connection;
  };
  const ids = submissionIds("k1");
  const conversationId = await api.createConversation("p1", "k1");
  await api.upload(conversationId, {}, "form.md", "text/markdown");
  await api.upload(conversationId, {}, "a.pdf", "application/pdf");
  await api.sendFirstMessage(conversationId, "# P\n", ids);
  assert.deepEqual(log, [
    "POST /v1/web-chat/products/p1/artifact/conversations key=k1", "upload c1 form.md text/markdown", "upload c1 a.pdf application/pdf",
    'message ["clientMessageId","content","localTools","runId"] message_k1 run_k1'
  ]);
});

// Explicit upstream stub for proxy transport tests, never product UAT: it checks only that bytes pass through unchanged.
test("the web-chat proxy streams asset uploads up and report files down as raw bytes, and routes the artifact definition", { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-artifact-proxy-"));
  const account = { id: "11111111-1111-4111-8111-111111111111", email: "fixture@example.test", display_name: "Fixture" };
  const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x80]);
  const seen = [];
  const registry = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/v1/auth/me" ? account : {}));
  });
  const runtime = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, type: req.headers["content-type"], key: req.headers["idempotency-key"], body: Buffer.concat(chunks) });
    if (req.method === "POST") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ asset_id: "asset_1" })); }
    if (req.url.includes("/report/files/")) { res.setHeader("content-type", "application/pdf"); return res.end(pdf); }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ intake: { fields: [] } }));
  });
  await Promise.all([registry, runtime].map(server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve))));
  const dashboard = await createDashboardApp({ ledgerPath: path.join(root, "ledger.jsonl"), registryUrl: `http://127.0.0.1:${registry.address().port}`, runtimeUrl: `http://127.0.0.1:${runtime.address().port}`, publicOrigin: "http://dashboard.test" });
  const api = createServer(dashboard.handler);
  await new Promise(resolve => api.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${api.address().port}`;
  const headers = { authorization: "Bearer api-key-1" };
  try {
    const upload = await fetch(`${base}/v1/web-chat/conversations/c1/assets?name=%E6%88%90%E7%BB%A9.pdf&entitlement_id=e1`, { method: "POST", headers: { ...headers, "content-type": "application/pdf" }, body: pdf });
    assert.equal(upload.status, 200);
    assert.deepEqual(await upload.json(), { asset_id: "asset_1" });
    assert.equal(seen[0].url, "/v1/conversations/c1/assets?name=%E6%88%90%E7%BB%A9.pdf&entitlement_id=e1");
    assert.equal(seen[0].type, "application/pdf");
    assert.equal(seen[0].authorization, "Bearer api-key-1");
    assert.deepEqual(seen[0].body, pdf);

    const download = await fetch(`${base}/v1/web-chat/conversations/c1/report/files/free.pdf?entitlement_id=e1`, { headers });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "application/pdf");
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdf);

    const definition = await fetch(`${base}/v1/web-chat/products/p1/artifact?entitlement_id=e1`, { headers });
    assert.equal(definition.status, 200);
    assert.equal(seen.at(-1).url, "/v1/products/p1/artifact?entitlement_id=e1");
    const created = await fetch(`${base}/v1/web-chat/products/p1/artifact/conversations?entitlement_id=e1`, { method: "POST", headers: { ...headers, "content-type": "application/json", "idempotency-key": "k-1" }, body: "{}" });
    assert.equal(created.status, 200);
    assert.equal(seen.at(-1).url, "/v1/products/p1/artifact/conversations?entitlement_id=e1");
    assert.equal(seen.at(-1).method, "POST");
    assert.equal(seen.at(-1).key, "k-1", "the submission key reaches the Runtime");
    await (await fetch(`${base}/v1/web-chat/products/p1/artifact/conversations?entitlement_id=e1`, { headers })).text();
    assert.equal(seen.at(-1).method, "GET");

    const before = seen.length;
    const oversize = await fetch(`${base}/v1/web-chat/conversations/c1/assets?name=big.png`, { method: "POST", headers: { ...headers, "content-type": "image/png" }, body: Buffer.alloc(20 * 1024 * 1024 + 1) });
    assert.equal(oversize.status, 413);
    assert.equal(seen.length, before, "an oversize image never reaches the Runtime");
  } finally {
    api.closeAllConnections(); registry.closeAllConnections(); runtime.closeAllConnections();
    await Promise.all([api, registry, runtime].map(server => new Promise(resolve => server.close(resolve))));
  }
});

test("one submission key per submission: made once, kept across refreshes and retries, gone after success", () => {
  const map = new Map();
  const storage = { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
  let made = 0;
  const generate = () => `key${++made}`;
  const first = draftStore(storage, "p1").submissionKey(generate);
  assert.equal(draftStore(storage, "p1").submissionKey(generate), first, "a refresh or double click reuses the key");
  assert.equal(made, 1);
  assert.notEqual(draftStore(storage, "p2").submissionKey(generate), first, "per product");
  draftStore(storage, "p1").clear();
  assert.notEqual(draftStore(storage, "p1").submissionKey(generate), first, "a new submission after success gets a new key");
  assert.equal(draftStore(null, "p1").submissionKey(generate).startsWith("key"), true, "no storage still submits");
  assert.deepEqual(submissionIds("k"), { clientMessageId: "message_k", runId: "run_k" });
});

test("resume decision comes from the server's reports: draft continues the intake, anything else shows the report", () => {
  const list = [{ conversation_id: "c3", status: "draft" }, { conversation_id: "c2", status: "ready" }];
  assert.deepEqual(resumeView([], null), { view: "intake", draftConversationId: null });
  assert.deepEqual(resumeView(list, null), { view: "intake", draftConversationId: "c3" }, "a draft is continued, never replaced by a new conversation");
  assert.deepEqual(resumeView([{ conversation_id: "c4", status: "generating" }, ...list], null), { view: "report", conversationId: "c4" });
  assert.deepEqual(resumeView(list, "c2"), { view: "report", conversationId: "c2" });
  assert.deepEqual(resumeView(list, "c3"), { view: "intake", draftConversationId: "c3" });
  assert.deepEqual(resumeView(list.slice(1), null, { startNew: true }), { view: "intake", draftConversationId: null }, "new report after a finished one");
  assert.deepEqual(resumeView(list, "zzz"), { view: "report", conversationId: "zzz" });
});

test("a trilingual intake shows each reader their language, and falls back when one is missing", async () => {
  const { localizeIntake, localized } = await import("./artifactForm.js");
  const intake = { fields: [{ id: "grade", type: "choice", label: { zh: "几年级", en: "Grade", ja: "学年" }, help: { zh: "选一个" }, options: [{ zh: "初二", en: "Grade 8", ja: "中学2年" }, "Other"] }] };
  assert.deepEqual(localizeIntake(intake, "ja").fields[0], { id: "grade", type: "choice", label: "学年", help: "选一个", options: ["中学2年", "Other"] });
  assert.equal(localizeIntake(intake, "en").fields[0].options[0], "Grade 8");
  assert.equal(localized("plain", "ja"), "plain");
  assert.equal(localized({ zh: "只有中文" }, "en"), "只有中文");
});
