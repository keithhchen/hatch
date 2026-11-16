const ARTIFACT_ROUTE = /^\/artifact\/([0-9a-f-]{36})(?:\/([a-z0-9._~-]+))?\/?$/i;

/** Artifact conversations live beside chat, on their own paths. */
export const ArtifactRoute = Object.freeze({
  parse(pathname) {
    const match = ARTIFACT_ROUTE.exec(pathname);
    if (!match) return null;
    return Object.freeze({ productId: match[1], conversationId: match[2] ?? null });
  },

  productPath(productId) {
    return `/artifact/${encodeURIComponent(productId)}`;
  },

  conversationPath(productId, conversationId) {
    return `${this.productPath(productId)}/${encodeURIComponent(conversationId)}`;
  }
});
