import { Streamdown } from "streamdown";
import "streamdown/styles.css";

function MarkdownTable({ children, node, ...attributes }) {
  return <div className="web-chat__table-scroll"><table {...attributes}>{children}</table></div>;
}

const markdownComponents = Object.freeze({ table: MarkdownTable });
const streamingAnimation = Object.freeze({
  animation: "fadeIn",
  duration: 160,
  easing: "ease-out",
  sep: "char"
});

export function MessageResponse({ children, isAnimating = false }) {
  return <Streamdown animated={streamingAnimation} components={markdownComponents} controls={{ code: false }} isAnimating={isAnimating}>{children}</Streamdown>;
}
