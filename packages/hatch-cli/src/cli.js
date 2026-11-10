import { COMMANDS } from "./commands.js";
import { HatchContext } from "./context.js";
import { HatchError } from "./errors.js";
import { serveMcp } from "./mcp.js";
import { CommandRegistry } from "./registry.js";

export const VERSION = "0.1.0";
const GLOBAL_BOOLEANS = ["json", "help", "h", "version", "g"];

export function parseArgs(argv, booleans) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out._.push(...argv.slice(i + 1)); break; }
    const m = a.match(/^--?([^=]+)(?:=(.*))?$/);
    if (!m || a === "-") { out._.push(a); continue; }
    const [, name, inline] = m;
    // A repeated option collects its values.
    const set = (value) => { out.flags[name] = name in out.flags && !booleans.has(name) ? [].concat(out.flags[name], value) : value; };
    if (inline !== undefined) set(inline);
    else if (booleans.has(name)) out.flags[name] = true;
    else if (i + 1 < argv.length) set(argv[++i]);
    else throw new HatchError(`Option --${name} needs a value.`, { code: "usage" });
  }
  return out;
}

const optionLines = (c) => Object.entries(c.options ?? {}).map(([n, o]) => `      --${n}${o.type === "string" ? " <value>" : ""}  ${o.describe}`);

export function helpText(registry, command) {
  if (command) return [`hatch ${command.usage}`, `  ${command.describe}`, ...optionLines(command)].join("\n");
  const rows = registry.all.map((c) => `  ${c.usage.padEnd(62)} ${c.describe}`);
  return ["Usage: hatch <command> [options]", "", "Commands:", ...rows, `  ${"mcp".padEnd(62)} Serve the MCP tools over stdio`, "",
    "Global options: --json  --profile <name>  --help  --version",
    "Environment: HATCH_API_URL, HATCH_WEB_URL, HATCH_API_KEY"].join("\n");
}

export async function main(argv, deps) {
  const registry = new CommandRegistry(COMMANDS);
  const stdout = deps.stdout, stderr = deps.stderr;
  let json = false;
  try {
    const args = parseArgs(argv, registry.booleanFlags(GLOBAL_BOOLEANS));
    json = Boolean(args.flags.json);
    if (args.flags.version) { stdout.write(`${VERSION}\n`); return 0; }
    const ctx = new HatchContext({ ...deps, json, profile: args.flags.profile ?? "default" });

    if (args._[0] === "mcp") { await serveMcp(ctx, registry, { input: deps.stdin, output: stdout }); return 0; }
    const resolved = registry.resolve(args._);
    if (!resolved) {
      if (args._.length === 0 || args.flags.help || args.flags.h) { stdout.write(`${helpText(registry)}\n`); return 0; }
      throw new HatchError(`Unknown command: ${args._.join(" ")}. Try \`hatch --help\`.`, { code: "usage" });
    }
    if (args.flags.help || args.flags.h) { stdout.write(`${helpText(registry, resolved.command)}\n`); return 0; }

    const result = await resolved.command.run(ctx, { _: resolved.rest, flags: args.flags });
    ctx.print(json || !resolved.command.format ? JSON.stringify(result, null, 2) : resolved.command.format(result));
    return ctx.exitCode;
  } catch (error) {
    const e = error instanceof HatchError ? error : new HatchError(error.message ?? String(error), { code: "internal" });
    stderr.write(json ? `${JSON.stringify({ error: { code: e.code, message: e.message, status: e.status, ...(e.clientMessageId ? { client_message_id: e.clientMessageId } : {}) } })}\n` : `hatch: ${e.message}\n`);
    return e.code === "usage" ? 2 : 1;
  }
}
