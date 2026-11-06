export class CommandRegistry {
  constructor(commands) {
    // Longest name first so "ingest status" wins over "ingest".
    this.all = commands;
    this.commands = [...commands].sort((a, b) => b.name.split(" ").length - a.name.split(" ").length);
  }

  // positional -> { command, rest } | null
  resolve(positional) {
    for (const command of this.commands) {
      const words = command.name.split(" ");
      if (words.every((w, i) => positional[i] === w)) return { command, rest: positional.slice(words.length) };
    }
    return null;
  }

  booleanFlags(extra = []) {
    const names = this.commands.flatMap((c) => Object.entries(c.options ?? {}).filter(([, o]) => o.type === "boolean").map(([n]) => n));
    return new Set([...names, ...extra]);
  }

  mcpTools() { return this.commands.filter((c) => c.mcp); }
}
