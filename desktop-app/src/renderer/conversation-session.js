import { openDraftSession } from "./conversation-draft.js";
import { committedResultAfterCancellation, localToolCancellationError, localToolTransportDeadlineMs } from "./local-tool-lifecycle.js";

// A window selects/subscribes; it never lends its mutable selection to a
// transport callback. These objects live until logout/window close, not navigation.
export function createConversationSessionManager() {
  const sessions = new Map();
  let selected = null;
  let closing = null;
  let teardown = false;
  return {
    beginTeardown() { teardown = true; },
    endTeardown() {
      for (const [key, session] of sessions) if (session.disposed) sessions.delete(key);
      teardown = false;
    },
    get(scope) {
      const key = JSON.stringify([scope.accountId, scope.entitlementId, scope.conversationId]);
      if (!sessions.has(key)) {
        const session = createConversationSession({ ...scope, key });
        // A sign-out render may request its empty selection while old sessions
        // drain. It is a sealed view, never a new executor during teardown.
        if (closing || teardown) session.disposed = true;
        sessions.set(key, session);
      }
      return sessions.get(key);
    },
    select(session) { selected = session; return session; },
    isSelected(session) { return selected === session && !session.disposed; },
    values: () => [...sessions.values()],
    closeAll() {
      if (closing) return closing;
      selected = null;
      const owned = [...sessions.values()];
      closing = Promise.allSettled(owned.map((session) => session.close())).then((results) => {
        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Could not close conversation sessions");
        for (const [key, session] of sessions) if (session.disposed) sessions.delete(key);
      }).finally(() => { closing = null; });
      return closing;
    }
  };
}

export function createConversationSession(scope) {
  const refs = new Map();
  const listeners = new Set();
  let state = {
    workspace: "", workspaceDraft: "", workspaceGrant: null, workspaceDraftGrant: null, workspaceGranted: false,
    droppedFiles: [], permissionMode: "ask-before-changes", status: "Offline", connected: false,
    runtimeRetryExhausted: false, chatLoading: false, running: false, messages: [], historyPage: null,
    olderLoading: false, olderError: "", taskBrief: null, composerDraft: "",
    composerRestoreRequest: { nonce: 0, value: "" }, approvalRequests: {},
    draftState: { key: "", status: "loading", error: "" }, draftRetry: 0,
    readingPosition: { top: 0, followTail: true }, ui: {}
  };
  const nativeContexts = new Map();
  const nativeRegistrations = new Set();
  const nativeClears = new Map();
  let draftOpening;
  let closePromise;
  const session = {
    scope: Object.freeze({ ...scope }), disposed: false,
    ref(name, initial = null) {
      if (!refs.has(name)) refs.set(name, { current: initial });
      return refs.get(name);
    },
    snapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    saveReadingPosition(viewport) {
      if (!viewport) return;
      const top = Math.max(0, Number(viewport.scrollTop) || 0);
      session.ref("viewportScrollTopRef", 0).current = top;
      session.set("readingPosition", { top, followTail: viewport.scrollHeight - viewport.clientHeight - top < 24 });
    },
    restoreReadingPosition(viewport) {
      if (!viewport) return;
      viewport.scrollTop = state.readingPosition.followTail ? viewport.scrollHeight : state.readingPosition.top;
    },
    setUi(key, update, initial) {
      session.set("ui", (ui) => ({ ...ui, [key]: typeof update === "function" ? update(ui[key] ?? initial) : update }));
    },
    set(name, update) {
      if (session.disposed) return;
      const next = typeof update === "function" ? update(state[name]) : update;
      if (Object.is(next, state[name])) return;
      state = { ...state, [name]: next };
      for (const listener of listeners) listener();
    },
    async openDraft(invoke) {
      if (session.disposed) throw new Error("Conversation session is closed");
      const holder = session.ref("draftSessionRef");
      if (holder.current) return holder.current;
      if (draftOpening) return draftOpening;
      const key = JSON.stringify([scope.accountId, scope.conversationId]);
      draftOpening = openDraftSession(invoke, { accountId: scope.accountId, conversationId: scope.conversationId },
        (status, error) => session.set("draftState", { key, status, error: error ? String(error.message || error) : "" }))
        .then((draft) => {
          holder.current = { key, session: draft };
          session.publishDraft();
          session.set("draftState", { key, status: "ready", error: "" });
          return holder.current;
        }).finally(() => { draftOpening = null; });
      return draftOpening;
    },
    publishDraft() {
      const draft = session.ref("draftSessionRef").current?.session.snapshot();
      if (!draft || session.disposed) return;
      session.ref("composerDraftRef").current = draft.text;
      session.ref("droppedFilesRef").current = draft.attachments;
      session.set("composerDraft", draft.text);
      session.set("droppedFiles", draft.attachments);
      session.set("composerRestoreRequest", (current) => ({ nonce: current.nonce + 1, value: draft.text }));
    },
    async acceptSubmission(receipt) {
      if (draftOpening) await draftOpening;
      const draft = session.ref("draftSessionRef").current?.session;
      if (!draft || session.disposed) return false;
      const accepted = await draft.acceptSubmission(receipt);
      if (accepted) session.publishDraft();
      return accepted;
    },
    async registerNativeContext(invoke, input) {
      if (session.disposed || input.conversationId !== scope.conversationId || !input.runId) {
        throw new Error("Native context must belong to this live Conversation and run");
      }
      const registration = (async () => {
        const result = await invoke("set_window_tool_context", input);
        if (typeof result?.context_id !== "string" || !result.context_id) throw new Error("Native context registration returned no context_id");
        const context = Object.freeze({ contextId: result.context_id, runId: input.runId });
        nativeContexts.set(input.runId, context);
        if (session.disposed) {
          await session.clearNativeContext(invoke, input.runId);
          throw new Error("Conversation closed during native context registration");
        }
        return context;
      })();
      nativeRegistrations.add(registration);
      try { return await registration; } finally { nativeRegistrations.delete(registration); }
    },
    nativeContext(runId) {
      const context = nativeContexts.get(runId);
      if (!context) throw new Error("No native context for this Conversation run");
      return context;
    },
    async clearNativeContext(invoke, runId) {
      const context = nativeContexts.get(runId);
      if (!context) return;
      if (nativeClears.has(context)) return nativeClears.get(context);
      const clearing = (async () => {
        const result = await invoke("clear_window_tool_context", context);
        if (!result || !["cleared", "already_revoked"].includes(result.status)
          || result.context_id !== context.contextId || result.run_id !== context.runId) {
          throw new Error("Native context clear returned an invalid receipt");
        }
        if (nativeContexts.get(runId) === context) nativeContexts.delete(runId);
      })().finally(() => nativeClears.delete(context));
      nativeClears.set(context, clearing);
      return clearing;
    },
    async clearNativeContexts(invoke) {
      await Promise.allSettled([...nativeRegistrations]);
      const results = await Promise.allSettled([...nativeContexts.keys()].map((id) => session.clearNativeContext(invoke, id)));
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Could not clear native contexts");
    },
    executeTool(message, options) {
      if (session.disposed) return Promise.reject(new Error("Conversation session is closed"));
      return executeLocalTool(session, message, options);
    },
    async cancelTools(reason, runId = null) {
      const pending = [...session.ref("pendingLocalToolsRef", new Map()).current.values()]
        .filter((entry) => !runId || entry.runId === runId);
      const outcomes = await Promise.allSettled(pending.map((entry) => entry.cancel(reason)));
      return outcomes.every((outcome) => outcome.status === "fulfilled");
    },
    isTransport(socket, token) {
      return !session.disposed && Boolean(socket) && session.ref("socketRef").current === socket
        && session.ref("connectionTokenRef", 0).current === token
        && !session.ref("intentionalDisconnectRef", true).current;
    },
    send(message) {
      const socket = session.ref("socketRef").current;
      if (!session.isTransport(socket, session.ref("connectionTokenRef", 0).current) || socket.readyState !== 1) return false;
      try { socket.send(JSON.stringify(message)); return true; } catch { return false; }
    },
    attachSocket(socket, token, handlers) {
      session.ref("socketRef").current = socket;
      const current = () => session.isTransport(socket, token);
      for (const [name, handler] of Object.entries(handlers)) {
        socket.addEventListener(name, (event) => {
          if (!current()) return;
          void Promise.resolve().then(() => current() && handler(event, session)).catch((error) => {
            if (current()) session.set("status", String(error.message || error));
          });
        });
      }
    },
    async cancel(reason = "user_requested") {
      const run = session.ref("activeRunRef").current;
      if (!run) return;
      session.send({ type: "turn.cancel", run_id: run.runId, reason });
      const stopped = await session.cancelTools?.(reason, run.runId);
      session.set("status", stopped === false ? "Couldn't confirm that the local tool stopped" : "Cancelling");
    },
    async close() {
      if (closePromise) return closePromise;
      // Seal transports synchronously, before any draft/native asynchronous work.
      session.disposed = true;
      session.ref("intentionalDisconnectRef", true).current = true;
      session.ref("connectionTokenRef", 0).current++;
      clearTimeout(session.ref("reconnectTimerRef").current);
      clearTimeout(session.ref("viewportScrollPersistTimerRef").current);
      session.ref("reconnectTimerRef").current = null;
      session.ref("socketRef").current?.close();
      session.ref("socketRef").current = null;
      session.ref("textRevealRef").current?.discard();
      state = { ...state, connected: false, running: false, chatLoading: false,
        draftState: { ...state.draftState, status: "closing" } };
      for (const listener of listeners) listener();
      for (const resolve of session.ref("approvalResolversRef", new Map()).current.values()) resolve(false);
      session.ref("approvalResolversRef").current.clear();
      closePromise = (async () => {
        // A failed initialization acquired no draft lease. It must not prevent
        // independently owned tools from being cancelled and cleared.
        await Promise.allSettled([draftOpening]);
        // Native results must be consumed by cancel/poll before clear makes
        // the opaque context unavailable. No window-wide clear fallback.
        const results = await Promise.allSettled([
          session.cancelTools?.("window_closed"),
          session.ref("draftSessionRef").current?.session.close()
        ]);
        const failures = results.filter((result) => result.status === "rejected");
        if (results[0].value === false) throw new Error("Could not confirm local tool cancellation");
        if (results[0].status === "fulfilled") {
          try { await session.clearContexts?.(); }
          catch (reason) { failures.push({ reason }); }
        }
        if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Could not close conversation");
        listeners.clear();
      })().catch((error) => { closePromise = null; throw error; });
      return closePromise;
    }
  };
  return session;
}

function executeLocalTool(conversationSession, message, { invoke, isTransportCurrent = () => true, requestApproval }) {
    const approvalResolversRef = conversationSession.ref("approvalResolversRef", new Map());
    const pendingLocalToolsRef = conversationSession.ref("pendingLocalToolsRef", new Map());
    const nativeContext = conversationSession.nativeContext(message.run_id);
    const request = { ...message };
    const deadlineMs = localToolTransportDeadlineMs(request);
    return new Promise((resolve, reject) => {
      let settled = false;
      let cancellationPromise = null;
      let pollTimer;
      let deadlineTimer;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(pollTimer);
        clearTimeout(deadlineTimer);
        approvalResolversRef.current.delete(request.tool_call_id);
        if (pendingLocalToolsRef.current.get(request.tool_call_id)?.request === request) {
          pendingLocalToolsRef.current.delete(request.tool_call_id);
        }
        callback(value);
      };
      const cancel = (reason) => {
        if (settled) return Promise.resolve(true);
        if (cancellationPromise) return cancellationPromise;
        cancellationPromise = (async () => {
          try {
            const acknowledged = await invoke("cancel_tool_call", {
              ...nativeContext, toolCallId: request.tool_call_id
            });
            if (!acknowledged) {
              const completed = await invoke("poll_tool_call", {
                ...nativeContext, toolCallId: request.tool_call_id
              });
              if (completed) {
                finish(resolve, completed);
                return true;
              }
              const missing = new Error(`Native local tool job was not found: ${request.tool_call_id}`);
              missing.code = "local_tool_cancel_failed";
              throw missing;
            }
            const completed = await invoke("poll_tool_call", {
              ...nativeContext, toolCallId: request.tool_call_id
            });
            // A non-shell file operation may commit between the cancel signal
            // and its next safe point. Preserve that honest native result
            // instead of falsely claiming the operation was stopped.
            const committed = committedResultAfterCancellation(completed);
            if (committed) {
              finish(resolve, committed);
              return true;
            }
            finish(reject, localToolCancellationError(request, reason, deadlineMs));
            return true;
          } catch (error) {
            const cancellationError = error instanceof Error ? error : new Error(String(error?.message || error));
            if (conversationSession.disposed && /^run_tool_context_revoked:/.test(cancellationError.message)) {
              // Authority was revoked, not proof that an OS process stopped.
              // Surface the real failure to the tool consumer while allowing
              // teardown to release the now inaccessible context.
              finish(reject, cancellationError);
              return { authorityRevoked: true };
            }
            if (!cancellationError.code) cancellationError.code = "local_tool_cancel_failed";
            finish(reject, cancellationError);
            throw cancellationError;
          }
        })();
        return cancellationPromise;
      };
      const poll = async () => {
        if (settled) return;
        try {
          const result = await invoke("poll_tool_call", {
            ...nativeContext, toolCallId: request.tool_call_id
          });
          if (result) {
            finish(resolve, result);
            return;
          }
        } catch (error) {
          finish(reject, error);
          return;
        }
        pollTimer = setTimeout(poll, 100);
      };

      pendingLocalToolsRef.current.set(request.tool_call_id, {
        request,
        runId: request.run_id,
        cancel
      });
      deadlineTimer = setTimeout(() => {
        void cancel("timeout").catch(() => {});
      }, deadlineMs);

      invoke("execute_tool_call", { ...nativeContext, request }).then((submission) => {
        if (!isTransportCurrent()) {
          void cancel("transport_failure").catch(() => {});
          return;
        }
        if (submission?.status === "approval_required") {
          // The visual inline gate is only a projection of the native pending
          // record. The renderer cannot manufacture approval metadata; its
          // action names an already-recorded call in this WebviewWindow.
          void requestApproval(request).then(async (approved) => {
            if (!isTransportCurrent()) {
              finish(reject, localToolCancellationError(request, "transport_failure", deadlineMs));
              return;
            }
            try {
              await invoke(approved ? "approve_pending_tool_call" : "deny_pending_tool_call", {
                ...nativeContext, toolCallId: request.tool_call_id
              });
            } catch (error) {
              finish(reject, error);
            }
          });
        }
        poll();
      }).catch((error) => finish(reject, error));
    });
  }
