import { Streamdown, defaultComponents } from "streamdown";
import { linkKind } from "../domain/form-pages.js";
import "streamdown/styles.css";

function MarkdownTable({ children, node, ...attributes }) {
  return <div className="web-chat__table-scroll"><table {...attributes}>{children}</table></div>;
}

// A Hatch link is a plain anchor (the chat opens it in its page panel); every other link keeps Streamdown's link-safety flow.
function MarkdownLink({ node, children, ...attributes }) {
  const DefaultLink = defaultComponents.a;
  return linkKind(attributes.href ?? "", window.location.origin) === "other"
    ? <DefaultLink node={node} {...attributes}>{children}</DefaultLink>
    : <a href={attributes.href} className="wrap-anywhere font-medium text-primary underline">{children}</a>;
}

const markdownComponents = Object.freeze({ table: MarkdownTable, a: MarkdownLink });
const streamingAnimation = Object.freeze({
  animation: "fadeIn",
  duration: 160,
  easing: "ease-out",
  sep: "char"
});

export function MessageResponse({ children, isAnimating = false }) {
  return <Streamdown animated={streamingAnimation} components={markdownComponents} controls={{ code: false }} isAnimating={isAnimating}>{children}</Streamdown>;
}
