import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExaSearchProvider, ParallelSearchProvider, SearchUnavailableError, canonicalUrl, searchProviderFrom } from "./search.js";
import { FalImageGenerator, ImageUnavailableError, imageGeneratorFrom, imageTool } from "./image.js";
import { factoryAgentTools } from "./factoryTools.js";
import { WorkbenchStore } from "./store.js";
import { initialAgentDefinitions } from "./definitions.js";
import { InMemoryModelRoleResolver } from "../modelRoles.js";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

test("Exa gets the recommended request: query, objective, auto, highlights, x-api-key", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const exa = new ExaSearchProvider("k", async (url, init) => { seen = { url: String(url), init: init! }; return json({ results: [{ title: "T", url: "https://a.example/x", highlights: ["h1"], publishedDate: "2026-01-01" }] }); });
  const response = await exa.search({ query: "q", objective: "o" });
  assert.equal(seen!.url, "https://api.exa.ai/search");
  assert.equal((seen!.init.headers as Record<string, string>)["x-api-key"], "k");
  assert.deepEqual(JSON.parse(String(seen!.init.body)), { query: "q", objective: "o", type: "auto", contents: { highlights: true } });
  assert.deepEqual(response.results, [{ title: "T", url: "https://a.example/x", publishedAt: "2026-01-01", excerpts: ["h1"] }]);
});

test("Parallel is called in basic mode, and its results are deduplicated, de-mirrored and cleaned", async () => {
  let body: unknown;
  const parallel = new ParallelSearchProvider("k", async (_url, init) => {
    body = JSON.parse(String(init!.body));
    return json({ results: [
      { title: "A", url: "https://www.site.com/post/?utm=1", excerpts: ["Expand user menu\nreal text\nReply"] },
      { title: "A again", url: "https://site.com/post#c", excerpts: ["dup"] },
      { title: "mirror", url: "https://pear.autos/x", excerpts: ["m"] },
      { title: "B", url: "https://other.com/b", excerpts: ["b"] },
    ] });
  });
  const response = await parallel.search({ query: "q", objective: "o" });
  assert.deepEqual(body, { objective: "o", search_queries: ["q"], mode: "basic" });
  assert.deepEqual(response.results.map(hit => hit.url), ["https://www.site.com/post/?utm=1", "https://other.com/b"]);
  assert.deepEqual(response.results[0]!.excerpts, ["real text"]);
  assert.equal(canonicalUrl("https://www.a.com/x/?q=1#f"), "a.com/x");
});

test("the search provider is parallel by default, exa by config, and a missing key is a real error", () => {
  assert.equal(searchProviderFrom({ PARALLEL_API_KEY: "p" }).name, "parallel");
  assert.equal(searchProviderFrom({ HATCH_SEARCH_PROVIDER: "exa", EXA_API_KEY: "e" }).name, "exa");
  assert.throws(() => searchProviderFrom({ EXA_API_KEY: "e" }), SearchUnavailableError);
  assert.throws(() => searchProviderFrom({ HATCH_SEARCH_PROVIDER: "bing" }), SearchUnavailableError);
});

test("fal Queue: submit, poll the returned status_url, fetch the returned response_url, download", async () => {
  const calls: string[] = [];
  let polls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const u = String(url); calls.push(`${init?.method ?? "GET"} ${u}`);
    if (u === "https://queue.fal.run/openai/gpt-image-2.6/flare/edit") {
      assert.equal((init!.headers as Record<string, string>).authorization, "Key fk");
      assert.deepEqual(JSON.parse(String(init!.body)).image_urls, ["data:image/png;base64,AA=="]);
      return json({ request_id: "r1", status_url: "https://queue.fal.run/x/status", response_url: "https://queue.fal.run/x/result" }, 200);
    }
    if (u.endsWith("/status")) return json({ status: ++polls < 2 ? "IN_PROGRESS" : "COMPLETED" }, polls < 2 ? 202 : 200);
    if (u.endsWith("/result")) return json({ images: [{ url: "https://v3.fal.media/a.jpg", content_type: "image/jpeg" }] });
    return new Response(Buffer.from("jpgbytes"), { status: 200 });
  };
  const images = await new FalImageGenerator("fk", fetcher, { pollMs: 1 }).generate({ mode: "edit", input: { prompt: "p", image_urls: ["data:image/png;base64,AA=="] } });
  assert.equal(images[0]!.bytes.toString(), "jpgbytes");
  assert.equal(calls.filter(call => call.endsWith("/status")).length, 2);
});

test("a rejected fal request surfaces fal's own error", async () => {
  const generator = new FalImageGenerator("fk", async () => json({ detail: [{ loc: ["body", "prompt"], msg: "field required", type: "missing" }] }, 422));
  await assert.rejects(generator.generate({ mode: "text-to-image", input: {} }), /422.*field required/);
  assert.throws(() => imageGeneratorFrom({}), ImageUnavailableError);
});

test("generate_image mirrors the model's parameters, reads edit inputs from the node folder and saves into output/images", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-image-tool-"));
  try {
    const store = new WorkbenchStore(root);
    const session = await store.create("content-creation");
    await store.put(session.id, "output/base.png", Buffer.from("png"), { actor: "host", mimeType: "image/png" });
    let sent: Record<string, unknown> = {};
    const fetcher: typeof fetch = async (url, init) => {
      const u = String(url);
      if (u.startsWith("https://queue.fal.run/openai")) { sent = JSON.parse(String(init!.body)); return json({ request_id: "r", status_url: "https://q/s", response_url: "https://q/r" }); }
      if (u === "https://q/s") return json({ status: "COMPLETED" });
      if (u === "https://q/r") return json({ images: [{ url: "https://f/i.jpg" }] });
      return new Response(Buffer.from("jpg"));
    };
    const tool = imageTool(store, session.id, () => undefined, new FalImageGenerator("k", fetcher, { pollMs: 1 }));
    for (const parameter of ["prompt", "mode", "input_images", "image_size", "quality", "reasoning_effort", "background", "num_images", "output_format"]) assert.ok(parameter in (tool.parameters as { properties: object }).properties, parameter);
    await assert.rejects(tool.execute("c", { mode: "edit", prompt: "p" } as never), /needs input_images/);
    const out = await tool.execute("c", { mode: "edit", prompt: "p", input_images: ["output/base.png"], image_size: "portrait_4_3" } as never);
    assert.equal((sent.image_urls as string[])[0], `data:image/png;base64,${Buffer.from("png").toString("base64")}`);
    assert.equal(sent.output_format, "jpeg");
    const { paths } = JSON.parse((out.content[0] as { text: string }).text);
    assert.match(paths[0], /^output\/images\/image-[0-9a-f]+\.jpg$/);
    assert.equal((await store.read(session.id, paths[0])).bytes.toString(), "jpg");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the new node kinds are defined with their own tools, and a missing key fails the node instead of dropping the tool", async () => {
  const definitions = await initialAgentDefinitions();
  const inspiration = definitions.find(d => d.role === "inspiration")!;
  const content = definitions.find(d => d.role === "content-creation")!;
  assert.ok(inspiration.tools.includes("web_search") && inspiration.tools.includes("web_scrape") && !inspiration.tools.includes("generate_image"));
  assert.ok(content.tools.includes("generate_image") && !content.tools.includes("web_search"));
  assert.match(content.systemPrompt, /LinkedIn/); assert.match(content.systemPrompt, /note\.com/); assert.match(content.systemPrompt, /知乎/);
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-node-tools-"));
  try {
    const store = new WorkbenchStore(root);
    const session = await store.create("inspiration");
    const base = { store, id: session.id, signal: new AbortController().signal, changed: () => undefined };
    await assert.rejects(factoryAgentTools({ ...base, definition: inspiration, env: {} }), /Web search is unavailable: it is not configured on this server/);
    const tools = await factoryAgentTools({ ...base, definition: inspiration, env: { PARALLEL_API_KEY: "p" } });
    assert.ok(tools.some(tool => tool.name === "web_search"));
    // The other nodes with web_search simply have no search when none is configured.
    const research = definitions.find(d => d.role === "research")!;
    assert.ok(!(await factoryAgentTools({ ...base, definition: research, env: {} })).some(tool => tool.name === "web_search"));
    const contentSession = await store.create("content-creation");
    await assert.rejects(factoryAgentTools({ ...base, id: contentSession.id, definition: content, env: {} }), /Image generation is unavailable: it is not configured on this server/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a database seeded before the new node kinds gains them on open, and keeps what it had", async () => {
  const { PostgresAgentDefinitionRepository } = await import("./definitions.js");
  const old = (await initialAgentDefinitions()).filter(d => d.role !== "inspiration" && d.role !== "content-creation");
  const rows = old.map(definition => ({ role: definition.role as string, definition: { ...definition, hint: { ...definition.hint, en: "edited" } } as Record<string, unknown> }));
  const query = async (text: string, values?: unknown[]) => {
    if (text.includes("COUNT(*)")) return { rows: [{ count: rows.length }] };
    if (text.includes("SELECT role")) return { rows: rows.map(row => ({ ...row })) };
    if (text.includes("INSERT INTO")) { const [role, definition] = values! as [string, string]; if (!rows.some(row => row.role === role)) rows.push({ role, definition: JSON.parse(definition) }); }
    return { rows: [] };
  };
  const repository = await PostgresAgentDefinitionRepository.open({ query, connect: async () => ({ query, release() {} }) } as never);
  const listed = await repository.list();
  assert.equal(listed.length, 7);
  assert.equal(listed.find(d => d.role === "research")!.hint.en, "edited");
});

test("what the model or user sees of the image service carries no vendor or model names", async () => {
  const { scrub, FalError } = await import("./image.js");
  const message = scrub('fal failed (422): {"detail":[{"msg":"bad openai/gpt-image-2.6/flare/edit input at https://queue.fal.run/openai/x"}]}');
  assert.doesNotMatch(message, /fal|openai|gpt-image/i);
  assert.match(new FalError("fal.ai 429 concurrent_requests_limit").message, /429 concurrent_requests_limit/);
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-image-names-"));
  try {
    const store = new WorkbenchStore(root);
    const session = await store.create("content-creation");
    const tool = imageTool(store, session.id, () => undefined, new FalImageGenerator("k", async () => json({}), {}));
    assert.doesNotMatch(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }), /fal|openai|gpt/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("each node kind has its own model role, seeded as kimi-k3.1-pro", async () => {
  const models = new InMemoryModelRoleResolver();
  assert.equal((await models.resolve("inspiration")).name, "kimi-k3.1-pro");
  assert.equal((await models.resolve("content")).name, "kimi-k3.1-pro");
});
