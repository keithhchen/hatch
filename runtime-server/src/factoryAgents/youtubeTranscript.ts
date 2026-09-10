import { execFile } from "node:child_process";
import { readBoundedResponseText } from "../boundedResponse.js";

type CaptionFormat = { ext?: string; url?: string; name?: string };
type YoutubeMetadata = {
  id?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  timestamp?: number;
  upload_date?: string;
  duration?: number;
  language?: string;
  original_language?: string;
  subtitles?: Record<string, CaptionFormat[]>;
  automatic_captions?: Record<string, CaptionFormat[]>;
};

export type YoutubeTranscript = {
  videoId: string;
  url: string;
  title: string;
  channel?: string;
  publishedAt?: string;
  durationSeconds?: number;
  language: string;
  source: "manual" | "automatic";
  retrievedAt: string;
  segments: Array<{ startSeconds: number; endSeconds: number; text: string }>;
  transcript: string;
};

export async function fetchYoutubeTranscript(
  input: { url: string; languages?: string[] },
  options: { binary?: string; fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {}
): Promise<YoutubeTranscript> {
  const url = normalizeYoutubeVideoUrl(input.url);
  const binary = options.binary ?? process.env.HATCH_YT_DLP_BIN ?? "yt-dlp";
  const metadata = JSON.parse(await run(binary, ["--dump-single-json", "--skip-download", "--no-playlist", "--js-runtimes", "node", url], options.signal)) as YoutubeMetadata;
  const selected = selectCaption(metadata, input.languages ?? []);
  if (!selected) throw new Error("No public manual or automatic transcript is available for this YouTube video");
  const response = await (options.fetch ?? globalThis.fetch)(selected.url, { signal: options.signal });
  if (!response.ok) throw new Error(`YouTube transcript download failed (${response.status})`);
  const raw = await readBoundedResponseText(response, 12 * 1024 * 1024);
  const segments = selected.ext === "json3" ? parseJson3(raw) : parseVtt(raw);
  if (!segments.length) throw new Error("YouTube returned an empty transcript");
  return {
    videoId: String(metadata.id ?? new URL(url).searchParams.get("v") ?? ""),
    url,
    title: String(metadata.title ?? "YouTube video"),
    ...(metadata.channel || metadata.uploader ? { channel: String(metadata.channel ?? metadata.uploader) } : {}),
    ...(publishedAt(metadata) ? { publishedAt: publishedAt(metadata) } : {}),
    ...(Number.isFinite(metadata.duration) ? { durationSeconds: Number(metadata.duration) } : {}),
    language: selected.language,
    source: selected.source,
    retrievedAt: new Date().toISOString(),
    segments,
    transcript: segments.map(segment => segment.text).join("\n")
  };
}

function selectCaption(metadata: YoutubeMetadata, requested: string[]): { language: string; source: "manual" | "automatic"; ext: string; url: string } | undefined {
  const preferences = [...requested, metadata.original_language, metadata.language, "en", "zh-Hans", "zh", "ja"].filter((value): value is string => Boolean(value));
  for (const [source, tracks] of [["manual", metadata.subtitles], ["automatic", metadata.automatic_captions]] as const) {
    const languages = Object.keys(tracks ?? {});
    const ordered = [...preferences.flatMap(preference => languages.filter(language => language === preference || language.startsWith(`${preference}-`))), ...languages];
    for (const language of [...new Set(ordered)]) {
      const formats = tracks?.[language] ?? [];
      const format = formats.find(item => item.ext === "json3" && item.url) ?? formats.find(item => item.ext === "vtt" && item.url);
      if (format?.url && format.ext) return { language, source, ext: format.ext, url: format.url };
    }
  }
  return undefined;
}

function parseJson3(raw: string): YoutubeTranscript["segments"] {
  const payload = JSON.parse(raw) as { events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }> };
  return (payload.events ?? []).flatMap(event => {
    const text = (event.segs ?? []).map(segment => segment.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (!text || text === "[Music]") return [];
    const startSeconds = Number(event.tStartMs ?? 0) / 1000;
    return [{ startSeconds, endSeconds: startSeconds + Number(event.dDurationMs ?? 0) / 1000, text }];
  });
}

function parseVtt(raw: string): YoutubeTranscript["segments"] {
  const blocks = raw.replace(/\r/g, "").split(/\n\n+/);
  return blocks.flatMap(block => {
    const lines = block.split("\n").filter(Boolean);
    const timingIndex = lines.findIndex(line => line.includes(" --> "));
    if (timingIndex < 0) return [];
    const [start, end] = lines[timingIndex].split(" --> ");
    const text = lines.slice(timingIndex + 1).join(" ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    return text ? [{ startSeconds: vttTime(start), endSeconds: vttTime(end), text }] : [];
  });
}

function vttTime(value: string): number {
  const parts = value.trim().split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function normalizeYoutubeVideoUrl(value: string): string {
  const parsed = new URL(value);
  let videoId = "";
  if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(parsed.hostname)) {
    if (parsed.pathname === "/watch") videoId = parsed.searchParams.get("v") ?? "";
    else videoId = parsed.pathname.match(/^\/(?:shorts|live)\/([\w-]{6,})/)?.[1] ?? "";
  } else if (parsed.hostname === "youtu.be") videoId = parsed.pathname.slice(1).split("/")[0];
  if (!/^[\w-]{6,}$/.test(videoId)) throw new Error("Provide one public YouTube video URL");
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function publishedAt(metadata: YoutubeMetadata): string | undefined {
  if (Number.isFinite(metadata.timestamp)) return new Date(Number(metadata.timestamp) * 1000).toISOString();
  return /^\d{8}$/.test(metadata.upload_date ?? "") ? `${metadata.upload_date!.slice(0, 4)}-${metadata.upload_date!.slice(4, 6)}-${metadata.upload_date!.slice(6, 8)}` : undefined;
}

function run(binary: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => execFile(binary, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000, signal }, (error, stdout, stderr) => {
    if (error) reject(new Error(`YouTube transcript extraction failed: ${String(stderr).trim() || error.message}`));
    else resolve(stdout);
  }));
}
