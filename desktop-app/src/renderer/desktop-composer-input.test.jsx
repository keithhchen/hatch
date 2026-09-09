// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopComposerInput } from "./desktop-composer-input.jsx";

const { setText } = vi.hoisted(() => ({ setText: vi.fn() }));
vi.mock("@assistant-ui/react", () => ({
  unstable_useComposerInput: () => ({ setText }),
  ComposerPrimitive: { Input: (props) => <textarea {...props} /> }
}));
let root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  setText.mockClear();
});
afterEach(() => { act(() => root.unmount()); });
function render(props = {}) {
  act(() => root.render(<DesktopComposerInput key={props.draftKey || "A"}
    draftKey="A" initialDraft="latest typed text" restoreDraftNonce={1}
    restoreDraftValue="" ready {...props} />));
}
it("does not replay an old empty restore command on A → B → A remount", () => {
  render();
  render({ draftKey: "B", initialDraft: "B text" });
  render();
  expect(setText.mock.calls.map(([value]) => value)).toEqual(["latest typed text", "B text", "latest typed text"]);
});
it("applies a new explicit restore once, without overwriting subsequent typing", () => {
  render();
  render({ restoreDraftNonce: 2, restoreDraftValue: "returned submission" });
  render({ initialDraft: "new typing", restoreDraftNonce: 2, restoreDraftValue: "returned submission" });
  expect(setText.mock.calls.map(([value]) => value)).toEqual(["latest typed text", "returned submission"]);
});
it("uses the current snapshot when asynchronous draft loading becomes ready", () => {
  render({ ready: false });
  render({ initialDraft: "loaded draft", restoreDraftNonce: 9, restoreDraftValue: "old" });
  expect(setText.mock.calls.map(([value]) => value)).toEqual(["", "loaded draft"]);
});
