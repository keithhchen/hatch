import { describe, expect, it, vi } from "vitest";
import { DesktopConversationTransport } from "./desktop-transport.js";

const socketUrl = "wss://hatch.example/v1/runtime";

/** Recording fetch / WebSocket doubles for this unit test only. */
function recorder(payload = {}) {
  const requests = [];
  const fetchImpl = vi.fn(async (url, init) => {
    requests.push({ url: new URL(url), init });
    return { ok: true, status: 200, json: async () => payload, blob: async () => new Blob(["x"]) };
  });
  return { requests, fetchImpl };
}

class RecordingSocket {
  constructor(url) { this.url = url; this.sent = []; this.readyState = 1; }
  send(frame) { this.sent.push(JSON.parse(frame)); }
  close() { this.readyState = 3; }
}

describe("Desktop conversation transport", () => {
  it("addresses an owned Agent by product_id only", async () => {
    const { requests, fetchImpl } = recorder({ conversations: [] });
    const transport = new DesktopConversationTransport({ token: "tok", binding: { productId: "p1" }, clientVersion: "1.2.3", fetchImpl, socketUrl });
    await transport.list(null);
    const { url, init } = requests[0];
    expect(`${url.origin}${url.pathname}`).toBe("https://hatch.example/v1/conversations");
    expect(url.searchParams.get("product_id")).toBe("p1");
    expect(url.searchParams.has("entitlement_id")).toBe(false);
    expect(url.searchParams.get("status")).toBe("active");
    expect(init.headers.authorization).toBe("Bearer tok");
  });

  it("addresses an acquired Agent by entitlement_id only, in REST and in hello", () => {
    const { fetchImpl } = recorder();
    const transport = new DesktopConversationTransport({ token: "tok", binding: { entitlementId: "e1" }, clientVersion: "1.2.3", fetchImpl, socketUrl, WebSocketImpl: RecordingSocket });
    const connection = transport.connect("conv_1", { onOpen() {}, onEvent() {}, onClose() {} });
    connection.hello(["file_read"]);
    connection.send({ runId: "run_1", clientMessageId: "m1", content: "hi", localTools: ["file_read"] });
    const [hello, message] = connection.socket.sent;
    expect(hello).toEqual({ type: "client.hello", protocol_version: "0.8", auth_token: "tok", conversation_id: "conv_1", entitlement_id: "e1", client_version: "1.2.3", local_tools: ["file_read"], time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    expect(hello.product_id).toBeUndefined();
    expect(message).toMatchObject({ type: "client.message", run_id: "run_1", conversation_id: "conv_1", time_zone: hello.time_zone, message: { role: "user", content: "hi" } });
  });

  it("wraps tool detail and serves bearer-protected assets as object URLs", async () => {
    const { requests, fetchImpl } = recorder({ tool: { tool_call_id: "t1" } });
    globalThis.URL.createObjectURL ??= () => "blob:hatch";
    const transport = new DesktopConversationTransport({ token: "tok", binding: { productId: "p1" }, fetchImpl, socketUrl });
    expect(await transport.toolDetail("conv_1", { run_id: "r", tool_call_id: "t1" })).toEqual({ tool: { tool_call_id: "t1" } });
    const source = await transport.assetSource("conv_1", "asset_1");
    expect(source).toMatch(/^blob:/);
    expect(await transport.assetSource("conv_1", "asset_1")).toBe(source);
    const asset = requests.find(request => request.url.pathname.endsWith("/assets/asset_1"));
    expect(asset.init.headers.authorization).toBe("Bearer tok");
    expect(requests.filter(request => request.url.pathname.endsWith("/assets/asset_1"))).toHaveLength(1);
  });
});
