import React from "react";
import { Button } from "./Button.jsx";
import { Select } from "./Overlays.jsx";
import { cn } from "./utils.js";

/**
 * Shared control entrypoint for compact action/select surfaces.
 * The rendered primitive stays semantic: Button remains a real button and
 * Select remains the Radix select. This component owns the shared control
 * density so consumers do not tune two separate primitives into alignment.
 */
export function Control({ kind = "button", size = "compact", surface, className, ...props }) {
  const classes = cn("hui-control", surface && `hui-control--${surface}`, className);
  if (kind === "select") return <Select {...props} className={classes} size={size} />;
  return <Button {...props} className={classes} size={size} />;
}
