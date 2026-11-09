import http from "node:http";
import net from "node:net";

/**
 * VERIFICATION TOOL ONLY. A path router standing where Caddy stands in production (see /Caddyfile): Chat paths go to a Runtime
 * instance, everything else to the Registry. It is the single address every client, the `hatch` CLI and the Registry's own
 * call into Chat use, so a Runtime instance can be killed or replaced behind it. Retries another instance only when the
 * connection could not be made (nothing was sent).
 */
export class Edge {
  constructor() { this.runtimes = []; this.registry = undefined; this.turn = 0; this.served = []; }

  setRuntimes(ports) { this.runtimes = [...ports]; }
  setRegistry(port) { this.registry = port; }

  target(pathname) {
    if (/^\/v1\/runtime\/products\/[^/]+\/release$/.test(pathname)) return { kind: "registry", path: (p) => p };
    if (/^\/v1\/runtime(\/|$)/.test(pathname)) return { kind: "runtime", path: (p) => p.replace(/^\/v1/, "") };
    if (/^\/(runtime|conversations)(\/|$)/.test(pathname) || /^\/v1\/(conversations|me\/creator-agents|service\/chat)(\/|$)/.test(pathname) || pathname === "/v1/conversations") return { kind: "runtime", path: (p) => p };
    return { kind: "registry", path: (p) => p };
  }

  async start() {
    this.server = http.createServer((request, response) => this.proxy(request, response));
    this.server.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = this.server.address().port;
    return this;
  }
  get url() { return `http://127.0.0.1:${this.port}`; }
  async stop() { this.server.closeAllConnections(); await new Promise((resolve) => this.server.close(resolve)); }

  candidates(kind) {
    if (kind === "registry") return this.registry ? [this.registry] : [];
    const ports = this.runtimes; if (!ports.length) return [];
    const start = this.turn++ % ports.length;
    return [...ports.slice(start), ...ports.slice(0, start)];
  }

  proxy(request, response) {
    const url = new URL(request.url, "http://edge.local");
    const target = this.target(url.pathname);
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const attempt = (ports) => {
        const port = ports.shift();
        if (port === undefined) { response.writeHead(502); response.end("no upstream"); return; }
        const upstream = http.request({ host: "127.0.0.1", port, method: request.method, path: target.path(url.pathname) + url.search, headers: { ...request.headers, host: `127.0.0.1:${port}` } }, (answer) => {
          this.served.push({ kind: target.kind, port, path: url.pathname, status: answer.statusCode });
          response.writeHead(answer.statusCode ?? 502, { ...answer.headers, "x-verify-upstream": String(port) });
          answer.pipe(response);
          response.on("close", () => answer.destroy());
        });
        upstream.on("error", (error) => { if (!response.headersSent && ["ECONNREFUSED", "ECONNRESET"].includes(error.code) && ports.length) return attempt(ports); if (!response.headersSent) { response.writeHead(502); response.end(String(error)); } else response.destroy(); });
        response.on("close", () => upstream.destroy());
        upstream.end(body);
      };
      attempt(this.candidates(target.kind));
    });
  }

  upgrade(request, socket, head) {
    const url = new URL(request.url, "http://edge.local");
    const target = this.target(url.pathname);
    const ports = this.candidates(target.kind);
    const attempt = () => {
      const port = ports.shift();
      if (port === undefined) { socket.destroy(); return; }
      const upstream = net.connect(port, "127.0.0.1");
      upstream.on("error", () => { if (!upstream.connected && ports.length) return attempt(); socket.destroy(); });
      upstream.on("connect", () => {
        upstream.connected = true;
        const lines = [`${request.method} ${target.path(url.pathname)}${url.search} HTTP/1.1`];
        for (let i = 0; i < request.rawHeaders.length; i += 2) lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i].toLowerCase() === "host" ? `127.0.0.1:${port}` : request.rawHeaders[i + 1]}`);
        upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket);
        socket.on("close", () => upstream.destroy()); upstream.on("close", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
      });
    };
    attempt();
  }
}
