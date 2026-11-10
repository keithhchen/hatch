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

const adapter = (acknowledged: string[]): ChannelAdapter => ({
  kind: "telegram", scope: "", maxFileBytes: 1000, capabilities: () => ({ stream: false, edit: false, typing: false, buttons: true, maxLength: 4096, canInitiate: true, idempotentSend: false }),
  available: () => true, connectUrl: () => "", send: async () => undefined,
  download: async file => Buffer.from(file.ref),
  acknowledge: async (_event, text) => { acknowledged.push(text ?? ""); },
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

function rigOf(target: ChatFlow, shape: { connection: ChannelConnection; principal: Inbound["principal"]; speaker?: Inbound["speaker"] }, state: ReturnType<typeof backend>["state"]): TargetRig {
  const notices: string[] = [];
  const acknowledged: string[] = [];
  const platform = adapter(acknowledged);
  return {
    deliver: (event: InboundEvent) => target.handle({
      id: `inbox-${Math.random()}`, connection: shape.connection, event, adapter: platform, principal: shape.principal, speaker: shape.speaker ?? { role: "owner" },
      address: { connectionId: shape.connection.id, ...event.address }, notify: async text => { notices.push(text); },
    }),
    messages: () => [...state.messages.values()].map(({ key, parts }) => ({ key, parts })),
    notices: () => notices,
    failNext: error => { state.failure = error; },
    trace: () => state.trace,
  };
}

targetConformance("Product target", () => {
  const { state, store, upload } = backend();
  const gateway: ChatGateway = { send: async (_principal, _conversation, _client, key, parts) => ({ ...store(key, parts), outcome: "started", conversationId: "c", messageId: key, acceptedAt: "" }), upload: (_p, _c, input) => upload(input.name), progress: async () => undefined };
  const shape = { connection: connection({ kind: "product", productId: "p1" }), principal: { kind: "account" as const, accountId: ACCOUNT } };
  return rigOf(new ChatFlow(new ProductTarget({ gateway, limiter: { take: async () => 0 } })), shape, state);
});

targetConformance("Assistant target", () => {
  const { state, store, upload } = backend();
  const assistant = {
    hear: async (_account: string, input: { id: string; parts: ContentPart[]; system?: boolean }) => ({ ...store(input.id, input.parts), outcome: "started" as const, conversationId: "c", messageId: input.id, acceptedAt: "" }),
    upload: (_account: string, name: string) => upload(name),
    approve: async (_account: string, taskId: string) => { state.trace.push("act:approve"); return { id: taskId } as any; },
    decline: async (_account: string, taskId: string) => { state.trace.push("act:decline"); return { id: taskId } as any; },
    linked: async () => "", reviewButtons: async () => [],
  };
  const shape = { connection: connection({ kind: "assistant" }), principal: { kind: "account" as const, accountId: ACCOUNT } };
  return rigOf(new ChatFlow(new AssistantTarget(assistant)), shape, state);
}, { button: { eventId: "b1", address: { threadId: "42", senderId: "42" }, button: { taskId: "11111111-1111-4111-8111-111111111111", action: "approve" } } });

test("Assistant target: a guest's words, and a guest's file with no words, carry the guest marker", async () => {
  const { state, store, upload } = backend();
  const assistant = { hear: async (_a: string, input: { id: string; parts: ContentPart[] }) => ({ ...store(input.id, input.parts), outcome: "started" as const, conversationId: "c", messageId: input.id, acceptedAt: "" }), upload: (_a: string, name: string) => upload(name), approve: async () => ({}) as any, decline: async () => ({}) as any, linked: async () => "", reviewButtons: async () => [] };
  const guestConnection = connection({ kind: "assistant" });
  const rig = rigOf(new ChatFlow(new AssistantTarget(assistant)), { connection: guestConnection, principal: { kind: "contact", connectionId: guestConnection.id, contactId: "k1" }, speaker: { role: "guest", label: "小王" } }, state);
  await rig.deliver({ eventId: "g1", address: { threadId: "42", senderId: "42" }, text: "帮我看看" });
  await rig.deliver({ eventId: "g2", address: { threadId: "42", senderId: "42" }, file: { ref: "f", name: "a.pdf", size: 1 } });
  const [first, second] = rig.messages();
  assert.match((first!.parts[0] as { text: string }).text, /^\[小王，专家授权的人，不是专家本人\] 帮我看看$/);
  assert.match((second!.parts[0] as { text: string }).text, /^\[小王，专家授权的人，不是专家本人\] （发来一个文件）$/);
  assert.equal(second!.parts[1]!.type, "file");
});
