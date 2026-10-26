import { describe, expect, it, vi } from "vitest";
import { COMMAND, parseNativeCommand, routeNativeCommand } from "./commands.js";

describe("native menu commands", () => {
  it("accepts only known command ids", () => {
    expect(parseNativeCommand({ id: COMMAND.FIND, source: "menu" })).toEqual({ id: "edit.find" });
    expect(parseNativeCommand({ id: "conversation.search" })).toBeNull();
    expect(parseNativeCommand({ id: "conversation.openWindow" })).toBeNull();
    expect(parseNativeCommand({ id: "agent.select.3" })).toBeNull();
    expect(parseNativeCommand({ id: "inspector.toggle" })).toBeNull();
    expect(parseNativeCommand(null)).toBeNull();
  });

  it("routes to the window's handler", () => {
    const find = vi.fn();
    expect(routeNativeCommand({ id: COMMAND.FIND }, { [COMMAND.FIND]: find })).toBe(true);
    expect(routeNativeCommand({ id: "agent.select.1" }, { "agent.select": vi.fn() })).toBe(false);
    expect(routeNativeCommand({ id: COMMAND.STOP }, {})).toBe(false);
    expect(find).toHaveBeenCalledOnce();
  });
});
