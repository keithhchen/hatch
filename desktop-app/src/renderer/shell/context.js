import { createContext, useContext } from "react";
import { PLATFORM } from "../config.js";

/** `{ app: DesktopWindow, t }` for every shell component. */
export const DesktopContext = createContext(null);
export const useDesktop = () => useContext(DesktopContext);

const MAC = PLATFORM === "macos";

/** Platform-correct shortcut label, e.g. shortcut("K") → "⌘K" / "Ctrl+K". */
export const shortcut = (key, { shift = false } = {}) => MAC
  ? `${shift ? "⇧" : ""}⌘${key}`
  : `Ctrl+${shift ? "Shift+" : ""}${key}`;
