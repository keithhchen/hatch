import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultMetadata,
  createProductMetadata,
  createProductNoScriptFallback,
  createUnavailableProductMetadata,
  injectProductNoScriptFallback,
  injectProductMetadata,
  renderProductMetadataTags
} from "../publicMetadata.mjs";

test("product metadata has a canonical encoded route and escaped Open Graph fields", () => {
  const metadata = createProductMetadata({
    origin: "https://hatch.example/internal/path?ignored=1",
    creatorId: "6f6a3d24-48af-4f27-9c50-0d4f7e4e8a21",
    productId: "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42",
    productName: 'Signal </title><script>alert("x")</script>',
    creatorName: 'Maya "Trusted" & Co',
    description: 'Review <strong>private</strong> work & return "evidence".',
    imageUrl: "/assets/product card.png"
  });

  assert.equal(metadata.canonicalUrl, "https://hatch.example/products/f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42");
  const tags = renderProductMetadataTags(metadata);
  assert.match(tags, /<link rel="canonical" href="https:\/\/hatch\.example\/products\/f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42"/);
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
    creatorId: "6f6a3d24-48af-4f27-9c50-0d4f7e4e8a21",
    productId: "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42",
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
    creatorId: "6f6a3d24-48af-4f27-9c50-0d4f7e4e8a21",
    productId: "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42"
  }), /credentials/);
  assert.throws(() => renderProductMetadataTags({
    title: "Agent",
    description: "Description",
    canonicalUrl: "data:text/html,unsafe"
  }), /HTTP/);
});

test("unavailable product metadata keeps the requested canonical URL without inventing a product", () => {
  const metadata = createUnavailableProductMetadata("https://hatch.example", "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42");
  assert.equal(metadata.title, "Agent unavailable · Hatch");
  assert.equal(metadata.canonicalUrl, "https://hatch.example/products/f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42");
  assert.match(renderProductMetadataTags(metadata), /Creator Agent is unavailable or has been withdrawn/);
});

test("public Product shell remains useful with JavaScript disabled", () => {
  const fallback = createProductNoScriptFallback({
    creatorId: "6f6a3d24-48af-4f27-9c50-0d4f7e4e8a21",
    creatorName: "Maya <Creator>",
    productId: "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42",
    productName: "Signal Review",
    description: "Evidence-first review.",
    amountMinor: 0
  });
  const html = injectProductNoScriptFallback(
    "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>",
    fallback
  );
  assert.match(html, /data-hatch-product-fallback="true"/);
  assert.match(html, /Maya &lt;Creator&gt;/);
  assert.match(html, /href="\/sign-in\?returnTo=%2Fproducts%2Ff9c4e2b7-7d14-4d72-9a63-1e91e58d6c42"/);
  assert.doesNotMatch(html, /<script>/);
});
