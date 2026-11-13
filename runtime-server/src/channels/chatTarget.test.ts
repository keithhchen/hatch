import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantTarget } from "../assistant/assistantTarget.js";
import type { ChatGateway } from "../chat/gateway.js";
import type { ContentPart } from "../surfaces/contract.js";
import { targetConformance, type TargetRig } from "./adapterConformance.js";
import { ChatFlow } from "./chatTarget.js";
import type { ChannelConnection } from "./connections.js";
import type { Inbound } from "./ports.js";
import { ProductTarget } from "./productTarget.js";
import type { ChannelAdapter, InboundEvent } from "./types.js";

const ACCOUNT = "a0000000-0000-4000-8000-000000000001";
const connection = (target: ChannelConnection["target"]): ChannelConnection => ({ id: "c0000000-0000-4000-8000-000000000001", ownerAccountId: ACCOUNT, channel: "telegram", scope: "", client: "im", target, audience: "self", taskSpecific: false, state: "active" });

const adapter = (acknowledged: string[], failure: { next?: Error }): ChannelAdapter => ({
  kind: "telegram", scope: "", maxFileBytes: 1000, capabilities: () => ({ stream: false, edit: false, typing: false, buttons: true, maxLength: 4096, canInitiate: true, idempotentSend: false }),
  available: () => true, connectUrl: () => "", send: async () => undefined,
  download: async file => Buffer.from(file.ref),
  acknowledge: async (_event, text) => { if (failure.next) { const error = failure.next; failure.next = undefined; throw error; } acknowledged.push(text ?? ""); },
});

/** The things both fakes do the same way: keep messages by key like Chat does, fail on demand, count uploads. */
function backend() {
  const state = { messages: new Map<string, { key: string; parts: ContentPart[]; runId: string }>(), failure: undefined as Error | undefined, trace: [] as string[], uploads: 0 };
  const store = (key: string, parts: ContentPart[]) => {
    if (state.failure) { const failure = state.failure; state.failure = undefined; throw failure; }
    state.trace.push("persist");
    const known = state.messages.get(key) ?? { key, parts, runId: `run-${state.messages.size + 1}` };
    state.messages.set(key, known);
    return { runId: known.runId };
  };
  const upload = async (name: string) => ({ assetId: `asset-${++state.uploads}`, kind: name.endsWith(".jpg") ? "image" as const : "file" as const });
  return { state, store, upload };
}

function rigOf(target: ChatFlow, shape: { connection: ChannelConnection; principal: Inbound["principal"] }, state: ReturnType<typeof backend>["state"]): TargetRig {
  const notices: string[] = [];
  const acknowledged: string[] = [];
  const ackFailure: { next?: Error } = {};
  const platform = adapter(acknowledged, ackFailure);
  return {
    deliver: (event: InboundEvent) => target.handle({
      id: `inbox-${Math.random()}`, connection: shape.connection, event, adapter: platform, principal: shape.principal,
      address: { connectionId: shape.connection.id, ...event.address }, notify: async text => { notices.push(text); },
    }),
    messages: () => [...state.messages.values()].map(({ key, parts }) => ({ key, parts })),
    notices: () => notices,
    failNext: error => { state.failure = error; },
    trace: () => state.trace,
    failAcknowledgeNext: error => { ackFailure.next = error; },
    acknowledgements: () => acknowledged,
  };
}

targetConformance("Product target", () => {
  const { state, store, upload } = backend();
  const gateway: ChatGateway = { send: async (_principal, _conversation, _client, key, parts) => ({ ...store(key, parts), outcome: "started", conversationId: "c", messageId: key, acceptedAt: "" }), upload: (_p, _c, input) => upload(input.name), restart: async (_p, _t, key) => { state.trace.push(`restart:${key}`); return { conversationId: "c2" }; }, progress: async () => undefined };
  const shape = { connection: connection({ kind: "product", productId: "p1" }), principal: { kind: "account" as const, accountId: ACCOUNT } };
  return rigOf(new ChatFlow(new ProductTarget({ gateway, limiter: { take: async () => 0 } })), shape, state);
});

targetConformance("Assistant target", () => {
  const { state, store, upload } = backend();
  const decided = new Set<string>();
  const assistant = {
    hear: async (_account: string, input: { id: string; parts: ContentPart[]; system?: boolean }) => ({ ...store(input.id, input.parts), outcome: "started" as const, conversationId: "c", messageId: input.id, acceptedAt: "" }),
    upload: (_account: string, name: string) => upload(name),
    /** Deciding is keyed like the real service: a press decided before is replayed, not decided again. */
    decide: async (_account: string, taskId: string, action: string, key: string) => {
      const replayed = decided.has(key);
      if (!replayed) { decided.add(key); state.trace.push(`act:${action}`); }
      return { task: { id: taskId } as any, replayed };
    },
    linked: async () => "", reviewButtons: async () => [],
  };
  const shape = { connection: connection({ kind: "assistant" }), principal: { kind: "account" as const, accountId: ACCOUNT } };
  return rigOf(new ChatFlow(new AssistantTarget(assistant)), shape, state);
}, { button: { eventId: "b1", address: { threadId: "42", senderId: "42" }, button: { taskId: "11111111-1111-4111-8111-111111111111", action: "approve" } } });

test("/new and /new@Bot restart a Product conversation instead of being sent; text after it is a message", async () => {
  const { state, store, upload } = backend();
  const gateway: ChatGateway = { send: async (_p, _c, _cl, key, parts) => ({ ...store(key, parts), outcome: "started", conversationId: "c", messageId: key, acceptedAt: "" }), upload: (_p, _c, input) => upload(input.name), restart: async (_p, _t, key) => { state.trace.push(`restart:${key}`); return { conversationId: "c2" }; }, progress: async () => undefined };
  const rig = rigOf(new ChatFlow(new ProductTarget({ gateway, limiter: { take: async () => 0 } })), { connection: connection({ kind: "product", productId: "p1" }), principal: { kind: "contact", connectionId: "c0000000-0000-4000-8000-000000000001", contactId: "u1" } }, state);
  for (const text of ["/new", " /NEW@shop_bot "]) {
    const handled = await rig.deliver({ eventId: `e-${text.trim()}`, address: { threadId: "42", senderId: "42" }, text });
    assert.deepEqual(handled, { replied: true });
  }
  assert.deepEqual(rig.trace(), ["restart:telegram::e-/new", "restart:telegram::e-/NEW@shop_bot"]);
  assert.equal(rig.messages().length, 0);
  assert.match(rig.notices().at(-1)!, /starting fresh/);
  await rig.deliver({ eventId: "e3", address: { threadId: "42", senderId: "42" }, text: "/news please" });
  assert.equal(rig.messages().length, 1, "only the command is special");
});
