import { createServer } from "node:http";
import { HatchError } from "./errors.js";

const page = (text) => `<!doctype html><meta charset="utf-8"><title>Hatch</title><body style="font-family:system-ui;margin:3rem"><h2>${text}</h2>You can close this tab.`;

// RFC 8252 loopback redirect receiver: one callback, state-checked.
export class LoopbackReceiver {
  constructor({ state, timeoutMs = 5 * 60 * 1000 }) {
    this.state = state;
    this.timeoutMs = timeoutMs;
    this.server = createServer((req, res) => this.#handle(req, res));
    this.result = new Promise((resolve, reject) => { this.settle = { resolve, reject }; });
    this.result.catch(() => {});
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    this.timer = setTimeout(() => this.settle.reject(new HatchError("Timed out waiting for browser sign-in (5 minutes).", { code: "login_timeout" })), this.timeoutMs);
    this.timer.unref?.();
    return `http://127.0.0.1:${this.server.address().port}/callback`;
  }

  #handle(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
    const reply = (status, text) => res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(page(text));
    if (url.searchParams.get("state") !== this.state) {
      reply(400, "Sign-in rejected: state mismatch.");
      this.settle.reject(new HatchError("Sign-in callback state did not match; aborting.", { code: "state_mismatch" }));
    } else if (url.searchParams.get("error") || !url.searchParams.get("code")) {
      reply(400, "Sign-in failed.");
      this.settle.reject(new HatchError(`Sign-in failed: ${url.searchParams.get("error") ?? "no code returned"}`, { code: "login_failed" }));
    } else {
      reply(200, "Signed in to Hatch.");
      this.settle.resolve(url.searchParams.get("code"));
    }
  }

  async wait() {
    try { return await this.result; } finally { await this.close(); }
  }

  close() {
    clearTimeout(this.timer);
    this.server.closeAllConnections?.();
    return new Promise((resolve) => this.server.listening ? this.server.close(() => resolve()) : resolve());
  }
}
