// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ThreadPrimitive, MessagePrimitive } from "@assistant-ui/react";
import { ConversationRuntimeProvider } from "./conversation-runtime-provider.jsx";

let root;
let container;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));
function Message() {
  return <MessagePrimitive.Root><MessagePrimitive.Parts /></MessagePrimitive.Root>;
}
const messages = ["first", "second"].map((text, index) => ({
  id: `A-${index}`, role: "user", content: [{ type: "text", text }]
}));
async function render(key, items) {
  await act(async () => root.render(
    <ConversationRuntimeProvider key={key} adapter={{ messages: items, onNew: async () => {} }}>
      <ThreadPrimitive.Messages components={{ Message }} />
    </ConversationRuntimeProvider>
  ));
}
it("switches populated A → empty B → A with real assistant-ui stores", async () => {
  await render("A", messages);
  expect(container.textContent).toBe("firstsecond");
  await render("B", []);
  expect(container.textContent).toBe("");
  await render("A", messages);
  expect(container.textContent).toBe("firstsecond");
});
it("updates messages within the same conversation", async () => {
  await render("A", messages.slice(0, 1));
  await render("A", messages);
  expect(container.textContent).toBe("firstsecond");
});
