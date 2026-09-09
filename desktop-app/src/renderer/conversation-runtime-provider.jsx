import React from "react";
import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";

// Mount inside the keyed Conversation boundary. This is a view adapter, not
// the durable session: navigation must never retarget an existing message store.
export function ConversationRuntimeProvider({ adapter, children }) {
  const runtime = useExternalStoreRuntime(adapter);
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
