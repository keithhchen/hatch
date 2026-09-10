import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fetchYoutubeTranscript } from "./youtubeTranscript.js";

test("YouTube transcript prefers requested manual captions and preserves timestamps", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-youtube-transcript-"));
  const binary = path.join(directory, "fake-yt-dlp");
  const metadata = {
    id: "UF8uR6Z6KLc",
    title: "A useful talk",
    channel: "Example channel",
    duration: 42,
    original_language: "en",
    subtitles: { en: [{ ext: "json3", url: "https://captions.test/manual" }] },
    automatic_captions: { zh: [{ ext: "json3", url: "https://captions.test/automatic" }] }
  };
  await writeFile(binary, `#!/bin/sh\nprintf '%s' '${JSON.stringify(metadata)}'\n`);
  await chmod(binary, 0o755);
  const transcript = await fetchYoutubeTranscript(
    { url: "https://youtu.be/UF8uR6Z6KLc?feature=shared", languages: ["en"] },
    {
      binary,
      fetch: async url => {
        assert.equal(String(url), "https://captions.test/manual");
        return new Response(JSON.stringify({ events: [
          { tStartMs: 1250, dDurationMs: 2500, segs: [{ utf8: "First " }, { utf8: "idea" }] },
          { tStartMs: 4000, dDurationMs: 1000, segs: [{ utf8: "Second idea" }] }
        ] }));
      }
    }
  );
  assert.equal(transcript.source, "manual");
  assert.equal(transcript.language, "en");
  assert.equal(transcript.url, "https://www.youtube.com/watch?v=UF8uR6Z6KLc");
  assert.deepEqual(transcript.segments[0], { startSeconds: 1.25, endSeconds: 3.75, text: "First idea" });
  assert.equal(transcript.transcript, "First idea\nSecond idea");
});

test("YouTube transcript rejects playlists and non-video pages", async () => {
  await assert.rejects(() => fetchYoutubeTranscript({ url: "https://www.youtube.com/playlist?list=abc" }), /one public YouTube video URL/);
});
