import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { TavilySearchProvider, TavilyScrapeProvider, FirecrawlScrapeProvider } from "./webProviders.js";
import { digest, result } from "./files.js";
import { WorkbenchStore } from "./store.js";
import { fetchYoutubeTranscript } from "./youtubeTranscript.js";

export function webTools(store: WorkbenchStore, id: string, changed: () => void, env: NodeJS.ProcessEnv = process.env): AgentTool[] {
  const search = new TavilySearchProvider({ apiKey: env.TAVILY_API_KEY });
  const scrape = env.HATCH_FACTORY_SCRAPE_PROVIDER === "firecrawl"
    ? new FirecrawlScrapeProvider({ apiKey: env.FIRECRAWL_API_KEY })
    : new TavilyScrapeProvider({ apiKey: env.TAVILY_API_KEY });
  if (env.HATCH_FACTORY_SCRAPE_PROVIDER && !["tavily", "firecrawl"].includes(env.HATCH_FACTORY_SCRAPE_PROVIDER)) throw new Error("Unknown scrape provider");
  return [
    { name: "web_search", label: "搜索资料", description: "Search public web evidence using Tavily. Returns source links/snippets, not verified full documents. Follow useful leads with web_scrape. No generated answer.", parameters: Type.Object({ query: Type.String({ minLength: 1 }), max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })), domains: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })), topic: Type.Optional(Type.Union([Type.Literal("general"), Type.Literal("news")])) }), execute: async (_id, raw, signal) => {
      const a = raw as { query: string; max_results?: number; domains?: string[]; topic?: "general" | "news" };
      const evidence = await search.search({ query: a.query, maxResults: a.max_results ?? 6, includeDomains: a.domains, topic: a.topic, searchDepth: "advanced" }, AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(90000)]));
      return result(evidence);
    } },
    { name: "web_scrape", label: "读取网页原文", description: "Fetch one public URL and save the provider's complete extracted Markdown, with provenance, under output/sources/. Use read to inspect all of it. This does not guarantee video transcription or authenticated-page access.", parameters: Type.Object({ url: Type.String() }), execute: async (_id, raw, signal) => {
      const a = raw as { url: string };
      const evidence = await scrape.scrape({ url: a.url, extractDepth: "advanced", format: "markdown" }, AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(90000)]));
      const body = `# ${evidence.title ?? evidence.url}\n\nSource: ${evidence.url}\nRetrieved: ${evidence.retrievedAt}\nProvider: ${evidence.provider}\nRepresentation: provider-extracted Markdown; not a video transcript unless the source itself contains one.\n\n---\n\n${evidence.content}`;
      const sourceUrl = new URL(evidence.url);
      const label = (evidence.title || sourceUrl.pathname.split("/").filter(Boolean).at(-1) || sourceUrl.hostname)
        .normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "source";
      const file = await store.put(id, `output/sources/${label}-${digest(body).slice(7, 19)}.md`, Buffer.from(body), { actor: "host", readonly: true });
      changed();
      return result({ ...file, source: evidence.url, retrievedAt: evidence.retrievedAt, note: "Read the saved file in full. Extraction may omit inaccessible page content." });
    } },
    { name: "youtube_transcript", label: "读取 YouTube 字幕", description: "Fetch the complete public manual or automatic transcript for one YouTube video, preserve timestamps and metadata, and save it under output/sources/. Use read to inspect the saved transcript in full.", parameters: Type.Object({ url: Type.String(), languages: Type.Optional(Type.Array(Type.String(), { maxItems: 8 })) }), execute: async (_id, raw, signal) => {
      const a = raw as { url: string; languages?: string[] };
      const transcript = await fetchYoutubeTranscript(a, { signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(150000)]) });
      const stamp = (seconds: number) => { const whole = Math.max(0, Math.floor(seconds)); return `${Math.floor(whole / 3600).toString().padStart(2, "0")}:${Math.floor(whole % 3600 / 60).toString().padStart(2, "0")}:${(whole % 60).toString().padStart(2, "0")}`; };
      const body = `# ${transcript.title}\n\nSource: ${transcript.url}\nChannel: ${transcript.channel ?? "Unknown"}\nPublished: ${transcript.publishedAt ?? "Unknown"}\nRetrieved: ${transcript.retrievedAt}\nLanguage: ${transcript.language}\nTranscript source: ${transcript.source}\nRepresentation: public YouTube captions with timestamps; automatic captions may contain recognition errors.\n\n---\n\n${transcript.segments.map(segment => `**[${stamp(segment.startSeconds)}]** ${segment.text}`).join("\n\n")}`;
      const label = transcript.title.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || transcript.videoId;
      const file = await store.put(id, `output/sources/youtube-${label}-${transcript.videoId}.md`, Buffer.from(body), { actor: "host", readonly: true });
      changed();
      return result({ ...file, source: transcript.url, language: transcript.language, transcriptSource: transcript.source, segments: transcript.segments.length, note: "Read the saved transcript in full. Verify names, numbers, and decisive wording when captions are automatic." });
    } }
  ];
}
