import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { isNative, nativeInvoke, nativeWindow } from "./bridge.js";

/**
 * OS attention for pending approvals: the Dock/taskbar badge carries the
 * count, and an approval in a conversation the user is not looking at posts
 * a system notification and asks for window attention.
 */
export class ApprovalAttention {
  constructor() {
    this.permission = null;
  }

  setPendingCount(count) {
    void nativeWindow.setBadgeCount(count);
  }

  async announce({ title, body }) {
    if (!isNative()) return;
    void nativeInvoke("request_window_attention").catch(() => {});
    try {
      this.permission ??= (await isPermissionGranted()) || (await requestPermission()) === "granted";
      if (this.permission) sendNotification({ title, body });
    } catch {
      // Notifications are optional OS affordances; the badge and the inline
      // approval remain the source of truth.
    }
  }
}
