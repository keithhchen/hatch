import { Streamdown } from "streamdown";
import "streamdown/styles.css";

function WebChatMarkdownTable({ children, node, ...attributes }) {
  return <div className="web-chat__table-scroll"><table {...attributes}>{children}</table></div>;
}

const markdownComponents = Object.freeze({ table: WebChatMarkdownTable });
const streamingAnimation = Object.freeze({
  animation: "fadeIn",
  duration: 160,
  easing: "ease-out",
  sep: "char"
});

export function WebChatMessageResponse({ children, isAnimating = false }) {
  return <Streamdown animated={streamingAnimation} components={markdownComponents} isAnimating={isAnimating}>{children}</Streamdown>;
}
