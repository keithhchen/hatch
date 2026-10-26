import { describe, expect, it, vi } from "vitest";
import { COMMAND, parseNativeCommand, routeNativeCommand } from "./commands.js";

describe("native menu commands", () => {
  it("accepts only known command ids and Agent 1–9", () => {
    expect(parseNativeCommand({ id: COMMAND.SEARCH, source: "menu" })).toEqual({ id: "conversation.search" });
    expect(parseNativeCommand({ id: "agent.select.3" })).toEqual({ id: "agent.select", agentIndex: 2 });
    expect(parseNativeCommand({ id: "agent.select.0" })).toBeNull();
    expect(parseNativeCommand({ id: "inspector.toggle" })).toBeNull();
    expect(parseNativeCommand(null)).toBeNull();
  });

  it("routes to the window's handler", () => {
    const find = vi.fn();
    const agent = vi.fn();
    expect(routeNativeCommand({ id: COMMAND.FIND }, { [COMMAND.FIND]: find })).toBe(true);
    expect(routeNativeCommand({ id: "agent.select.1" }, { "agent.select": agent })).toBe(true);
    expect(routeNativeCommand({ id: COMMAND.STOP }, {})).toBe(false);
    expect(find).toHaveBeenCalledOnce();
    expect(agent).toHaveBeenCalledWith(0);
  });
});
