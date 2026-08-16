import React from "react";
import { cn } from "./utils.js";

/**
 * The visual contract for compact controls.
 *
 * This module is intentionally behavior-agnostic: it does not import a
 * button, select, or Radix primitive. Button and Select own their semantic
 * roots and consume this appearance contract independently.
 */
export function controlClassName({ size = "compact", surface = "raised", className } = {}) {
  return cn(
    "hui-control",
    size === "compact" && "hui-control--compact",
    surface && `hui-control--${surface}`,
    className
  );
}

export function ControlContent({ leading, trailing, children }) {
  return (
    <>
      {leading ? <span className="hui-control-leading">{leading}</span> : null}
      <span className="hui-control-value">{children}</span>
      {trailing ? <span className="hui-control-trailing">{trailing}</span> : null}
    </>
  );
}
