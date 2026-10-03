const WEB_CHAT_ROUTE = /^\/chat\/product\/([0-9a-f-]{36})(?:\/conversation\/([a-z0-9._~-]+))?\/?$/i;

export const WebChatRoute = Object.freeze({
  parse(pathname) {
    const match = WEB_CHAT_ROUTE.exec(pathname);
    if (!match) return null;
    return Object.freeze({ productId: match[1], conversationId: match[2] ?? null });
  },

  productPath(productId) {
    return `/chat/product/${encodeURIComponent(productId)}`;
  },

  conversationPath(productId, conversationId) {
    return `${this.productPath(productId)}/conversation/${encodeURIComponent(conversationId)}`;
  }
});
