import assert from "node:assert/strict";
import { test } from "node:test";
import { png, saying } from "../assets/kit.test.js";
import { alice, dm, ended, text, thread, withFixture } from "../chat/kit.test.js";
import { HttpChatGateway } from "./runtimeChat.js";

const remoteTo = (port: number, serviceToken = "service-secret") => new HttpChatGateway({ baseUrl: `http://127.0.0.1:${port}`, serviceToken });

test("the Registry's adapter carries the one Chat contract across a process boundary", () => withFixture({ assets: true, moderator: { transcriber: saying("hello") } }, async ({ port, runtime }) => {
  const remote = remoteTo(port);
  const sent = await remote.send(alice, thread, dm, "evt-1", text("hi"));
  assert.equal(sent.outcome, "started");
  assert.deepEqual(await ended(remote, sent.runId), { runId: sent.runId, status: "completed", text: "echo: hi" });
  // A retried platform event: the same message and Run, whichever side asks.
  const again = await remote.send(alice, thread, dm, "evt-1", text("hi"));
  assert.deepEqual([again.outcome, again.runId], ["replayed", sent.runId]);
  assert.deepEqual(await ended(runtime.chat, sent.runId), await ended(remote, sent.runId));
  // Bytes travel as the body of an upload; the asset is then a ready part of a message.
  const { assetId } = await remote.upload(alice, thread, { name: "photo.png", bytes: await png(20, 20) });
  const withImage = await remote.send(alice, thread, dm, "evt-2", [{ type: "image", assetId }]);
  assert.equal((await ended(remote, withImage.runId)).status, "completed");
  assert.match((await ended(remote, withImage.runId)).text, /\[image: \/attachments\/msg_[0-9a-f]{16}\/photo\.png\]/);
  // A refusal reaches the caller as the same error Chat raised; a Run that does not exist is not an error.
  await assert.rejects(remote.send(alice, { kind: "conversation", id: "nobody" }, dm, "evt-3", text("hi")), { code: "conversation_not_found", status: 404 });
  await assert.rejects(remote.upload(alice, thread, { name: "a.txt", bytes: Buffer.alloc(0) }), { code: "invalid_upload", status: 400 });
  assert.equal(await remote.progress("run_unknown"), undefined);
  // Parts are validated at the door.
  await assert.rejects(remote.send(alice, thread, dm, "evt-4", [{ type: "image", assetId: "" }]), { code: "invalid_request", status: 400 });
}));

test("only the channel layer's service token opens the door, and with none configured the door stays shut", async () => {
  await withFixture({}, async ({ port }) => {
    await assert.rejects(remoteTo(port, "not-the-token").send(alice, thread, dm, "evt-1", text("hi")), { code: "service_auth_required", status: 401 });
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/service/chat/runs/run_x`)).status, 401);
  });
  await withFixture({ noServiceToken: true }, async ({ port }) => {
    await assert.rejects(remoteTo(port).progress("run_x"), { code: "service_unavailable", status: 503 });
  });
});
