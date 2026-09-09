import React, { useLayoutEffect, useRef } from "react";
import { ComposerPrimitive, unstable_useComposerInput } from "@assistant-ui/react";

// assistant-ui owns live editing/IME; the Conversation Session owns saved text.
// Mounts read the current snapshot. Restore commands apply only while mounted.
export function DesktopComposerInput({ draftKey, initialDraft, restoreDraftNonce,
  restoreDraftValue, ready, onDraftChange, ...props }) {
  const { setText } = unstable_useComposerInput();
  const appliedDraftRef = useRef(null);
  useLayoutEffect(() => {
    if (!ready) {
      appliedDraftRef.current = null;
      setText("");
      return;
    }
    const applied = appliedDraftRef.current;
    const entering = applied?.key !== draftKey;
    if (!entering && applied.nonce === restoreDraftNonce) return;
    appliedDraftRef.current = { key: draftKey, nonce: restoreDraftNonce };
    setText(String((entering ? initialDraft : restoreDraftValue) ?? ""));
  }, [draftKey, initialDraft, ready, restoreDraftNonce, restoreDraftValue, setText]);
  return <ComposerPrimitive.Input {...props} onChange={(event) => onDraftChange?.(event.target.value)} />;
}
