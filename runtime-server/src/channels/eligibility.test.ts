import assert from "node:assert/strict";
import test from "node:test";
import type { ChannelConnection } from "./connections.js";
import { ChannelPolicyError, guarded } from "./eligibility.js";
import type { Inbound, TargetHandler } from "./ports.js";

const connection = (channel: string): ChannelConnection => ({ id: "c", ownerAccountId: "a", channel, client: "im", target: { kind: "assistant" }, audience: "self", taskSpecific: false, state: "active", scope: "" });
const refuse = () => { throw new ChannelPolicyError("no", "not here"); };

function recording() {
  const seen: string[] = [];
  const handler: TargetHandler = { async handle(inbound) { seen.push(inbound.connection.channel); return { replied: true }; }, async linked() { return "linked"; } };
  return { seen, handler };
}

test("a rule runs before the Agent, only for its own platform", async () => {
  const { seen, handler } = recording();
  const target = guarded(handler, { whatsapp: refuse });
  await assert.rejects(target.handle({ connection: connection("whatsapp") } as Inbound), ChannelPolicyError);
  await assert.rejects(target.linked(connection("whatsapp")), ChannelPolicyError);
  assert.deepEqual(seen, []);
  assert.deepEqual(await target.handle({ connection: connection("telegram") } as Inbound), { replied: true });
  assert.equal(await target.linked(connection("telegram")), "linked");
  assert.deepEqual(seen, ["telegram"]);
});
