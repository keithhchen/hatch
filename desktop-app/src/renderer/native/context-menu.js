import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { isNative } from "./bridge.js";

const EDITABLE = "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox']";

export function isEditableTarget(target) {
  const element = target?.nodeType === 3 ? target.parentElement : target;
  return Boolean(element?.closest?.(EDITABLE));
}

const SEPARATOR = "separator";

async function buildItem(item) {
  if (item === SEPARATOR) return PredefinedMenuItem.new({ item: "Separator" });
  if (item.predefined) return PredefinedMenuItem.new({ item: item.predefined });
  if (item.items) return Submenu.new({ text: item.label, items: await Promise.all(item.items.map(buildItem)) });
  if (item.checked !== undefined) return CheckMenuItem.new({ text: item.label, checked: item.checked, enabled: item.enabled ?? true, action: () => void item.action?.() });
  return MenuItem.new({ text: item.label, enabled: item.enabled ?? true, action: () => void item.action?.() });
}

/**
 * Pop up a native menu at the pointer. Items are `{ label, action, enabled, checked? }`,
 * `{ label, items }` (a submenu), `{ predefined: "Copy" }` or the string "separator".
 */
export async function popupNativeMenu(items) {
  if (!isNative()) return;
  const menu = await Menu.new({ items: await Promise.all(items.map(buildItem)) });
  await menu.popup();
}

/** A React onContextMenu handler that shows a native menu instead of WebKit's. */
export const nativeContextMenu = items => event => {
  if (!isNative()) return;
  event.preventDefault();
  event.stopPropagation();
  void popupNativeMenu(typeof items === "function" ? items() : items);
};

/**
 * Every right click gets a native menu: editable fields get the standard
 * edit items, selected text gets Copy, everything else gets nothing (never
 * WebKit's Reload / Inspect Element). Surfaces with their own menus stop
 * propagation before this listener runs.
 */
export function installNativeContextMenus() {
  if (!isNative()) return () => {};
  const handle = event => {
    event.preventDefault();
    if (isEditableTarget(event.target)) {
      void popupNativeMenu([{ predefined: "Undo" }, { predefined: "Redo" }, SEPARATOR, { predefined: "Cut" }, { predefined: "Copy" }, { predefined: "Paste" }, SEPARATOR, { predefined: "SelectAll" }]);
    } else if (String(window.getSelection?.() ?? "").trim()) {
      void popupNativeMenu([{ predefined: "Copy" }, SEPARATOR, { predefined: "SelectAll" }]);
    }
  };
  document.addEventListener("contextmenu", handle);
  return () => document.removeEventListener("contextmenu", handle);
}

export { SEPARATOR };
