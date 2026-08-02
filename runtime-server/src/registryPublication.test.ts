import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { requirePublishedRelease } from "./registryPublication.js";
import type { CreatorReleasePublic } from "./release.js";

const release = {
  contract_version: "1",
  creator_id: "maya-chen",
  product_id: "signal-resume-review",
  release_id: "signal-resume-review@1.0.0",
  digest: `sha256:${"7".repeat(64)}`,
  version: "1.0.0",
  creator: { id: "maya-chen", name: "Maya Chen" },
  product: {
    name: "Signal Resume Review",
    description: "Review",
    promise: "Deliver review",
    price: { amount_minor: 3900, currency: "USD", model: "per_delivery", unit: "review" },
    supported_local_capabilities: ["fs.read", "fs.write"],
    boundaries: []
  },
  presentation: {}
} satisfies CreatorReleasePublic;

async function serve(payload: unknown, status = 200): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

test("connected purchase accepts an exact already-published Registry Release", async () => {
  const fixture = await serve({
    status: "published",
    creator_id: release.creator_id,
    product_id: release.product_id,
    release_id: release.release_id,
    release_digest: release.digest,
    published_at: "2026-07-31T14:00:00.000Z"
  });
  try {
    const result = await requirePublishedRelease(fixture.url, release);
    assert.equal(result.release_digest, release.digest);
  } finally {
    await fixture.close();
  }
});

test("connected purchase fails closed before writes for missing or mismatched publication", async () => {
  const missing = await serve({ detail: "not found" }, 404);
  try {
    await assert.rejects(
      requirePublishedRelease(missing.url, release),
      /did not resolve the Release before purchase: HTTP 404/
    );
  } finally {
    await missing.close();
  }

  const wrongDigest = await serve({
    status: "published",
    creator_id: release.creator_id,
    product_id: release.product_id,
    release_id: release.release_id,
    release_digest: `sha256:${"8".repeat(64)}`,
    published_at: "2026-07-31T14:00:00.000Z"
  });
  try {
    await assert.rejects(
      requirePublishedRelease(wrongDigest.url, release),
      /does not match the exact Creator Release/
    );
  } finally {
    await wrongDigest.close();
  }
});
