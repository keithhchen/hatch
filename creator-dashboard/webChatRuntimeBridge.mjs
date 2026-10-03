import { WebSocket } from "ws";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

export class WebChatCapabilityPolicy {
  prepare(message, helloSent, token) {
    if (!helloSent) {
      if (message?.type !== "client.hello" || message.auth_token || message.license_token || message.local_tools?.length) {
        throw new Error("Invalid session start");
      }
      return { ...message, auth_token: token, local_tools: [] };
    }
    if (message?.type === "client.message") {
      if (message.local_tools?.length) throw new Error("Local tools unavailable");
      if (message.message?.attachments?.some(entry => entry.kind !== "asset" || !IMAGE_TYPES.has(entry.media_type))) {
        throw new Error("Only image attachments are available");
      }
      return { ...message, local_tools: [] };
    }
    if (message?.type === "tool_call.result"
      && message.status === "error"
      && message.error?.code === "web_local_tool_unavailable") {
      return {
        type: "tool_call.result",
        run_id: message.run_id,
        tool_call_id: message.tool_call_id,
        status: "error",
        error: { code: "web_local_tool_unavailable", message: "此浏览器不能运行本地工具。" }
      };
    }
    if (message?.type === "turn.cancel") return message;
    throw new Error("Unsupported client message");
  }
}

export class WebChatRuntimeBridge {
  constructor({ browser, runtimeUrl, token, policy = new WebChatCapabilityPolicy() }) {
    this.browser = browser;
    this.token = token;
    this.policy = policy;
    this.helloSent = false;
    this.pending = [];
    const upstreamUrl = new URL("/runtime", runtimeUrl);
    upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
    this.upstream = new WebSocket(upstreamUrl, { maxPayload: 160 * 1024 * 1024, handshakeTimeout: 20_000 });
  }

  connect() {
    this.browser.on("message", (data, binary) => this.receive(data, binary));
    this.upstream.on("open", () => {
      for (const wire of this.pending.splice(0)) this.upstream.send(wire);
    });
    this.upstream.on("message", (data, binary) => {
      if (this.browser.readyState === WebSocket.OPEN) this.browser.send(data, { binary });
    });
    this.upstream.on("error", () => this.close(1011, "Runtime unavailable"));
    this.upstream.on("close", () => {
      if (this.browser.readyState === WebSocket.OPEN) this.browser.close(1011, "Runtime disconnected");
    });
    this.browser.on("close", () => {
      if (this.upstream.readyState === WebSocket.OPEN) this.upstream.close();
      else this.upstream.terminate();
    });
    this.browser.on("error", () => this.close(1011, "Browser connection failed"));
  }

  receive(data, binary) {
    if (binary) { this.close(1003, "Text messages required"); return; }
    let message;
    try { message = JSON.parse(data.toString()); }
    catch { this.close(1007, "Invalid JSON"); return; }
    let prepared;
    try { prepared = this.policy.prepare(message, this.helloSent, this.token); }
    catch (error) { this.close(1008, error.message); return; }
    if (!this.helloSent) this.helloSent = true;
    const wire = JSON.stringify(prepared);
    if (this.upstream.readyState === WebSocket.OPEN) this.upstream.send(wire);
    else if (this.pending.length < 2) this.pending.push(wire);
    else this.close(1008, "Runtime connection pending");
  }

  close(code, reason) {
    if (this.browser.readyState === WebSocket.OPEN) this.browser.close(code, reason);
    if (this.upstream.readyState === WebSocket.OPEN) this.upstream.close(code, reason);
    else if (this.upstream.readyState === WebSocket.CONNECTING) this.upstream.terminate();
  }
}
