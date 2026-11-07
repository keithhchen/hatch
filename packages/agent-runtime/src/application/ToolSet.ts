import type { Tool } from "../ports/runtime-ports.js";
import type { ToolRegistry } from "../ports/runtime-ports.js";

export class ToolSet implements ToolRegistry {
	private readonly toolsByName: ReadonlyMap<string, Tool>;

	constructor(tools: readonly Tool[]) {
		const toolsByName = new Map<string, Tool>();
		for (const tool of tools) {
			const name = tool.definition.name;
			if (toolsByName.has(name)) throw new Error(`Duplicate tool name: ${name}`);
			toolsByName.set(name, tool);
		}
		this.toolsByName = toolsByName;
	}

	list(): readonly Tool[] {
		return [...this.toolsByName.values()];
	}

	get(name: string): Tool {
		const tool = this.toolsByName.get(name);
		if (tool === undefined) throw new Error(`Unknown tool: ${name}`);
		return tool;
	}
}
