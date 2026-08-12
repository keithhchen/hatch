import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultMetadata,
  createProductMetadata,
  createUnavailableProductMetadata,
  injectProductMetadata,
  renderProductMetadataTags
} from "../publicMetadata.mjs";

test("product metadata has a canonical encoded route and escaped Open Graph fields", () => {
  const metadata = createProductMetadata({
    origin: "https://hatch.example/internal/path?ignored=1",
    creatorSlug: "maya/chen",
    productSlug: "resume review",
    productName: 'Signal </title><script>alert("x")</script>',
    creatorName: 'Maya "Trusted" & Co',
    description: 'Review <strong>private</strong> work & return "evidence".',
    imageUrl: "/assets/product card.png"
  });

  assert.equal(metadata.canonicalUrl, "https://hatch.example/agents/maya%2Fchen/resume%20review");
  const tags = renderProductMetadataTags(metadata);
  assert.match(tags, /<link rel="canonical" href="https:\/\/hatch\.example\/agents\/maya%2Fchen\/resume%20review"/);
  assert.match(tags, /og:title/);
  assert.match(tags, /&lt;\/title&gt;&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(tags, /Maya &quot;Trusted&quot; &amp; Co/);
  assert.doesNotMatch(tags, /<script>/);
  assert.doesNotMatch(tags, /<strong>/);
});

test("metadata injection replaces a generic title and is deterministic", () => {
  const shell = "<!doctype html><html><head><title>Generic</title></head><body></body></html>";
  const metadata = createProductMetadata({
    origin: "http://127.0.0.1:8500",
    creatorSlug: "maya",
    productSlug: "signal",
    productName: "Signal Review",
    creatorName: "Maya",
    description: "Evidence-first review."
  });
  const once = injectProductMetadata(shell, metadata);
  const twice = injectProductMetadata(once, metadata);

  assert.equal((twice.match(/rel="canonical"/g) ?? []).length, 1);
  assert.equal((twice.match(/<title>/g) ?? []).length, 1);
  assert.match(twice, /<title>Signal Review by Maya · Hatch<\/title>/);
});

test("metadata rejects executable or credential-bearing URL schemes", () => {
  assert.throws(() => createDefaultMetadata("javascript:alert(1)"), /HTTP/);
  assert.throws(() => createProductMetadata({
    origin: "https://user:secret@example.test",
    creatorSlug: "creator",
    productSlug: "product"
  }), /credentials/);
  assert.throws(() => renderProductMetadataTags({
    title: "Agent",
    description: "Description",
    canonicalUrl: "data:text/html,unsafe"
  }), /HTTP/);
});

test("unavailable product metadata keeps the requested canonical URL without inventing a product", () => {
  const metadata = createUnavailableProductMetadata("https://hatch.example", "maya creator", "withdrawn/product");
  assert.equal(metadata.title, "Agent unavailable · Hatch");
  assert.equal(metadata.canonicalUrl, "https://hatch.example/agents/maya%20creator/withdrawn%2Fproduct");
  assert.match(renderProductMetadataTags(metadata), /Creator Agent is unavailable or has been withdrawn/);
});
