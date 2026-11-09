import { createHash } from "node:crypto";
import net from "node:net";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const sha = (value) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
export const hex = (value) => createHash("sha256").update(value).digest("hex");

export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Polls `probe` until it returns something truthy; throws on timeout. */
export async function until(what, probe, { timeoutMs = 30_000, everyMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await Promise.resolve().then(probe).catch(() => undefined);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(everyMs);
  }
}

export const percentile = (values, p) => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

export const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
};
