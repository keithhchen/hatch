import { createInterface } from "node:readline";
import { HatchError } from "./errors.js";

export const PROTOCOL_VERSION = "2025-06-18";

// Minimal MCP server (JSON-RPC 2.0, newline-delimited) over the same command objects as the CLI.
export class McpServer {
  constructor(ctx, registry, version = "0.1.0") {
    this.ctx = ctx;
    this.tools = new Map(registry.mcpTools().map((c) => [c.mcp.name, c]));
    this.version = version;
  }

  async handle(message) {
    const { id, method, params } = message;
    if (id === undefined) return null; // notifications get no reply
    try {
      return { jsonrpc: "2.0", id, result: await this.#dispatch(method, params ?? {}) };
    } catch (error) {
      return { jsonrpc: "2.0", id, error: { code: error.rpcCode ?? -32603, message: error.message } };
    }
  }

  async #dispatch(method, params) {
    switch (method) {
      case "initialize":
        return { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "hatch", version: this.version } };
      case "ping": return {};
      case "tools/list":
        return { tools: [...this.tools.values()].map((c) => ({ name: c.mcp.name, description: c.mcp.description, inputSchema: c.mcp.inputSchema })) };
      case "tools/call": return this.#call(params);
      default: throw Object.assign(new Error(`Method not found: ${method}`), { rpcCode: -32601 });
    }
  }

  async #call({ name, arguments: input = {} }) {
    const command = this.tools.get(name);
    if (!command) throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
    const text = (t, isError) => ({ content: [{ type: "text", text: t }], isError });
    try {
      const result = await command.run(this.ctx, command.mcp.toArgs(input));
      return text(JSON.stringify(result, null, 2), false);
    } catch (error) {
      return text(error instanceof HatchError ? error.message : `Internal error: ${error.message}`, true);
    }
  }

  async serve(input, output) {
    const pending = [];
    const reply = async (line) => {
      let message;
      try { message = JSON.parse(line); } catch {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
        return;
      }
      const response = await this.handle(message);
      if (response) output.write(`${JSON.stringify(response)}\n`);
    };
    const rl = createInterface({ input });
    rl.on("line", (line) => { if (line.trim()) pending.push(reply(line)); });
    await new Promise((resolve) => rl.once("close", resolve));
    await Promise.all(pending);
  }
}

export const serveMcp = (ctx, registry, { input, output }) => new McpServer(ctx, registry).serve(input, output);
