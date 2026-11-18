import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { DESKTOP_RETIRED_CODE, DESKTOP_RETIRED_NOTICE, isDesktopFrame } from "./chat/desktopRetired.js";
import { createRuntimeServer } from "./index.js";

const ID = "44444444-4444-4444-8444-444444444444";
const OLD_DESKTOP_HELLO = { type: "client.hello", protocol_version: "0.8", auth_token: "t", conversation_id: "c1", entitlement_id: ID, client_version: "0.2.2", local_tools: ["file_read"] };
const OLD_DESKTOP_MESSAGE = { type: "client.message", run_id: "r1", conversation_id: "c1", local_tools: ["file_read"], message: { role: "user", content: "hi" } };

test("the notice says it in Chinese, English and Japanese, with the web address", () => {
  assert.match(DESKTOP_RETIRED_NOTICE, /桌面版/);
  assert.match(DESKTOP_RETIRED_NOTICE, /Desktop is no longer supported/);
  assert.match(DESKTOP_RETIRED_NOTICE, /デスクトップ/);
  assert.equal(DESKTOP_RETIRED_NOTICE.match(/https:\/\/gethatchapp\.com/g)?.length, 3);
});

test("a Desktop frame is told apart from web, with or without `client`", () => {
  assert.equal(isDesktopFrame(OLD_DESKTOP_HELLO), true);
  assert.equal(isDesktopFrame({ ...OLD_DESKTOP_HELLO, entitlement_id: undefined }), true, "released builds send their app version and no client");
  assert.equal(isDesktopFrame({ ...OLD_DESKTOP_HELLO, client_version: undefined }), true, "an entitlement_id alone is a released Desktop");
  assert.equal(isDesktopFrame({ type: "client.hello", client: "desktop", local_tools: [] }), true);
  assert.equal(isDesktopFrame({ type: "client.hello", local_tools: [], client_version: "hatch-web" }), false);
  assert.equal(isDesktopFrame({ type: "client.message", client: "web", local_tools: ["file_read"] }), false);
  assert.equal(isDesktopFrame({ type: "client.hello", local_tools: ["file_read"] }), false, "local tools alone are not a Desktop");
  // The other real clients of the socket: the dashboard's web chat (client_version "hatch-web", time_zone) and the Factory's Hatch tool (none).
  assert.equal(isDesktopFrame({ type: "client.hello", protocol_version: "0.8", conversation_id: "c", product_id: ID, client_version: "hatch-web", local_tools: [], time_zone: "Asia/Tokyo" }), false);
  assert.equal(isDesktopFrame({ type: "client.hello", protocol_version: "0.8", conversation_id: "c", auth_token: "t", product_id: ID, local_tools: [] }), false);
  assert.equal(isDesktopFrame({ type: "tool_call.result", client: "desktop" }), false);
  assert.equal(isDesktopFrame(null), false);
});

test("a Desktop hello and message get the notice, and start no Run", async () => {
  const runtime = createRuntimeServer({ insecureLocalMode: true });
  await new Promise<void>(resolve => runtime.server.listen(0, "127.0.0.1", resolve));
  const { port } = runtime.server.address() as { port: number };
  const socket = new WebSocket(`ws://127.0.0.1:${port}/runtime`);
  const inbox: Array<Record<string, any>> = [];
  socket.on("message", data => inbox.push(JSON.parse(String(data))));
  await new Promise(resolve => socket.once("open", resolve));
  const next = async (match: (m: Record<string, any>) => boolean) => { for (let i = 0; i < 200; i++) { const found = inbox.find(match); if (found) return found; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error(`nothing: ${JSON.stringify(inbox)}`); };
  try {
    for (const hello of [OLD_DESKTOP_HELLO, { ...OLD_DESKTOP_HELLO, entitlement_id: undefined }]) {
      inbox.length = 0;
      socket.send(JSON.stringify(hello));
      const refused = await next(m => m.type === "session.error");
      assert.deepEqual(refused.error, { code: DESKTOP_RETIRED_CODE, message: DESKTOP_RETIRED_NOTICE });
    }
    inbox.length = 0;
    socket.send(JSON.stringify(OLD_DESKTOP_MESSAGE));
    const failed = await next(m => m.type === "turn.failed");
    assert.equal(failed.run_id, "r1");
    assert.deepEqual(failed.error, { code: DESKTOP_RETIRED_CODE, message: DESKTOP_RETIRED_NOTICE });
    assert.deepEqual(inbox.map(m => m.type), ["turn.failed"], "no Run started: no accepted, state or model events");
  } finally { socket.close(); await runtime.close(); }
});

test("a released Desktop asking for conversations by entitlement_id gets the notice over HTTP", async () => {
  const runtime = createRuntimeServer({ insecureLocalMode: true });
  await new Promise<void>(resolve => runtime.server.listen(0, "127.0.0.1", resolve));
  const { port } = runtime.server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/conversations?entitlement_id=${ID}&status=active`, { headers: { authorization: "Bearer t" } });
    assert.equal(response.status, 403);
    const body = await response.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, DESKTOP_RETIRED_CODE);
    assert.equal(body.error.message, DESKTOP_RETIRED_NOTICE);
  } finally { await runtime.close(); }
});
