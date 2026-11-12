import assert from "node:assert/strict";
import test from "node:test";
import { StudioPanel } from "./panel.js";

test("the timezone is recorded when it is an IANA name, and refused when it is not", async () => {
  const set: string[] = [];
  const panel = new StudioPanel({ tasks: { open: async () => [] }, channels: async () => [], timezones: { valid: name => name === "Asia/Shanghai", set: async (_account, name) => { set.push(name); } } });
  await panel.setTimezone("a1", "Asia/Shanghai");
  await assert.rejects(panel.setTimezone("a1", "Mars/Base"), { status: 400, code: "invalid_timezone" });
  assert.deepEqual(set, ["Asia/Shanghai"]);
});
