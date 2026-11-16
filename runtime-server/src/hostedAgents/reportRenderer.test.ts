import assert from "node:assert/strict";
import test from "node:test";
import type { HostedAgentProvider, HostedResult, HostedTask } from "./ports.js";
import { createHostedReportRenderer, HostedReportRenderer, RENDER_NOT_CONFIGURED } from "./reportRenderer.js";

const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2000, 1)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000, 1)]);
const input = { fullHtml: "<p>full</p>", freeHtml: "<p>free</p>" };

const fake = (result: Partial<HostedResult>) => {
  const tasks: HostedTask[] = [];
  const provider: HostedAgentProvider = {
    run: async task => { tasks.push(task); return { sessionId: "s1", status: "done", text: "ok", artifacts: [], ...result }; },
  };
  return { provider, tasks };
};

test("uploads both HTML files and returns the three validated outputs", async () => {
  const { provider, tasks } = fake({ artifacts: [{ name: "full.pdf", bytes: pdf }, { name: "free.pdf", bytes: pdf }, { name: "preview.png", bytes: png }, { name: "result.json", bytes: Buffer.from("{}") }] });
  const out = await new HostedReportRenderer(provider).render(input);
  assert.equal(out.preview, png);
  assert.deepEqual(tasks[0]!.files.map(f => [f.name, f.bytes.toString()]), [["full.html", "<p>full</p>"], ["free.html", "<p>free</p>"]]);
  assert.deepEqual(tasks[0]!.secrets, []);
});

test("a missing artifact fails with the hosted error", async () => {
  const { provider } = fake({ status: "failed", error: "script crashed", artifacts: [{ name: "full.pdf", bytes: pdf }] });
  await assert.rejects(new HostedReportRenderer(provider).render(input), /did not produce free\.pdf: script crashed/);
});

test("bad magic bytes or tiny files are rejected", async () => {
  const ok = [{ name: "full.pdf", bytes: pdf }, { name: "free.pdf", bytes: pdf }];
  await assert.rejects(new HostedReportRenderer(fake({ artifacts: [...ok, { name: "preview.png", bytes: pdf }] }).provider).render(input), /invalid preview\.png/);
  await assert.rejects(new HostedReportRenderer(fake({ artifacts: [{ name: "full.pdf", bytes: Buffer.from("%PDF-") }, ...ok.slice(1), { name: "preview.png", bytes: png }] }).provider).render(input), /invalid full\.pdf/);
});

test("without a key the renderer says it is not configured", async () => {
  await assert.rejects(createHostedReportRenderer({}).render(input), new RegExp(RENDER_NOT_CONFIGURED));
});
