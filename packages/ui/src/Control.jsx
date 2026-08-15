import React from "react";
import { Button } from "./Button.jsx";
import { Select } from "./Overlays.jsx";

/**
 * Shared control entrypoint for compact action/select surfaces.
 * The rendered primitive stays semantic: Button remains a real button and
 * Select remains the Radix select. This component owns the shared control
 * density so consumers do not tune two separate primitives into alignment.
 */
export function Control({ kind = "button", size = "compact", ...props }) {
  if (kind === "select") return <Select {...props} size={size} />;
  return <Button {...props} size={size} />;
}
