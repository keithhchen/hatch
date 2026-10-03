import { latestThinkingText } from "../webChatActivityPresentation.js";

export function WebChatThinkingTicker({ content }) {
  const text = latestThinkingText(content, 50);
  if (!text) return null;

  return <span className="web-chat__activity-thinking-preview">
    <span className="web-chat__thinking-ticker-track">
      <span className="web-chat__thinking-ticker-copy">{text}</span>
      <span className="web-chat__thinking-ticker-copy" aria-hidden="true">{text}</span>
    </span>
  </span>;
}
