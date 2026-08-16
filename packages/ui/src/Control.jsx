import { Button } from "./Button.jsx";
import { Select } from "./Overlays.jsx";
export { ControlContent, controlClassName } from "./ControlAppearance.jsx";

/**
 * Thin behavior adapters. They choose the semantic primitive; appearance
 * remains in ControlAppearance and is consumed by each primitive directly.
 */
export function ButtonControl({ size = "compact", surface = "raised", ...props }) {
  return <Button {...props} size={size} surface={surface} />;
}

export function SelectControl({ size = "compact", surface = "raised", ...props }) {
  return <Select {...props} size={size} surface={surface} />;
}
