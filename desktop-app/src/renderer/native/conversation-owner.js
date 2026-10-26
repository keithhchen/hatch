// Native registry is the sole ownership authority. This object only retains the
// acquired lease and routes activation intents; it never copies message state.
export function createConversationOwner({ invoke, listen, onActivate, onError }) {
  let ready;
  let disposed = false;
  let unlisten;
  const pending = new WeakMap();
  const start = () => {
    if (disposed) return Promise.reject(new Error("Conversation owner listener is disposed"));
    return ready ??= listen("hatch://conversation-activate", (event) => {
      if (disposed) return;
      const payload = event?.payload;
      if (!payload || ![payload.accountId, payload.entitlementId, payload.conversationId]
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
    claim(session) {
      if (session.disposed || disposed) return Promise.resolve(false);
      if (pending.has(session)) return pending.get(session);
      const operation = (async () => {
        await start(); // Register before native can route another window here.
        if (session.disposed || disposed) return false;
        const result = await invoke("claim_conversation_session", session.scope);
        if (!result || typeof result.owned !== "boolean" || typeof result.windowLabel !== "string") {
          throw new Error("Native conversation owner response was invalid");
        }
        if (!result.owned) {
          return false;
        }
        if (!result.lease) throw new Error("Native conversation owner lease is missing");
        const args = { accountId: session.scope.accountId, conversationId: session.scope.conversationId, lease: result.lease };
        session.releaseOwnership = async () => { await invoke("release_conversation_session", args); };
        // close() awaits this claim and releases only after all tools drain.
        if (session.disposed || disposed) return false;
        return true;
      })().finally(() => pending.delete(session));
      pending.set(session, operation);
      session.ownershipOpening = operation;
      return operation;
    }
  };
}
