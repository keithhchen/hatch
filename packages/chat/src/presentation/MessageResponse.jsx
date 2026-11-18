import { Suspense, lazy } from "react";

// The markdown stack (Streamdown, parse5, marked) is large and not needed for first paint: it loads on demand,
// and until it arrives the message shows as plain text, never an empty box.
const MarkdownBody = lazy(() => import("./MarkdownBody.jsx"));

export function MessageResponse({ children, isAnimating = false }) {
  return (
    <Suspense fallback={<span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{children}</span>}>
      <MarkdownBody isAnimating={isAnimating}>{children}</MarkdownBody>
    </Suspense>
  );
}
