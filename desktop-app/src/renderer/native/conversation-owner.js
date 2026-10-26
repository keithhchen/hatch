// Native registry is the sole ownership authority: one window owns a
// Conversation (its draft lease and local tool contexts). This object only
// retains the acquired lease and routes activation intents to `onActivate`.
export function createConversationOwner({ invoke, listen, onActivate, onError }) {
  let ready;
  let disposed = false;
  let unlisten;
  const pending = new Map();
  const start = () => {
    if (disposed) return Promise.reject(new Error("Conversation owner listener is disposed"));
    return ready ??= listen("hatch://conversation-activate", (event) => {
      if (disposed) return;
      const payload = event?.payload;
      if (!payload || ![payload.accountId, payload.accessKey, payload.conversationId]
        .every((value) => typeof value === "string" && value.length > 0)) return;
      void Promise.resolve().then(() => !disposed && onActivate(payload)).catch(onError);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
  };
  return {
    start,
    dispose() {
      disposed = true;
      unlisten?.();
      unlisten = undefined;
    },
    /**
     * Claim `{ accountId, conversationId, accessKey }` for this window.
     * Resolves to a release function, or null when another window owns it
     * (native has already focused that window).
     */
    claim(scope) {
      const key = JSON.stringify([scope.accountId, scope.conversationId]);
      if (disposed) return Promise.resolve(null);
      if (pending.has(key)) return pending.get(key);
      const operation = (async () => {
        await start(); // Register before native can route another window here.
        const result = await invoke("claim_conversation_session", scope);
        if (!result || typeof result.owned !== "boolean" || typeof result.windowLabel !== "string") {
          throw new Error("Native conversation owner response was invalid");
        }
        if (!result.owned) return null;
        if (!result.lease) throw new Error("Native conversation owner lease is missing");
        const args = { accountId: scope.accountId, conversationId: scope.conversationId, lease: result.lease };
        return () => invoke("release_conversation_session", args);
      })().finally(() => pending.delete(key));
      pending.set(key, operation);
      return operation;
    }
  };
}
