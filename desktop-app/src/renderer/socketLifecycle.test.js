import { describe, expect, it, vi } from "vitest";
import {
  createSocketLifecycleState,
  handleCurrentSocketClose,
  invalidateSocket,
  isCurrentSocket,
  registerSocket
} from "./socketLifecycle.js";

describe("desktop socket lifecycle", () => {
  it("ignores events from a superseded socket", () => {
    const state = createSocketLifecycleState();
    const first = {};
    const second = {};
    const firstGeneration = registerSocket(state, first);
    const secondGeneration = registerSocket(state, second);

    expect(isCurrentSocket(state, first, firstGeneration)).toBe(false);
    expect(isCurrentSocket(state, second, secondGeneration)).toBe(true);
  });

  it("runs close cleanup exactly once for the current socket", () => {
    const state = createSocketLifecycleState();
    const socket = {};
    const generation = registerSocket(state, socket);
    const onClose = vi.fn();

    expect(handleCurrentSocketClose(state, socket, generation, onClose)).toBe(true);
    expect(handleCurrentSocketClose(state, socket, generation, onClose)).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("invalidates the active socket before an intentional disconnect", () => {
    const state = createSocketLifecycleState();
    const socket = {};
    const generation = registerSocket(state, socket);

    expect(invalidateSocket(state, socket)).toBe(true);
    expect(isCurrentSocket(state, socket, generation)).toBe(false);
  });
});
