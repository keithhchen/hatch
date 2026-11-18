/** What a Hatch Desktop user sees in place of a reply. User-facing text, not a model prompt. */
export const DESKTOP_RETIRED_CODE = "desktop_retired";
export const DESKTOP_RETIRED_NOTICE = "Hatch 桌面版已不再支持，请使用网页版：https://gethatchapp.com\nHatch Desktop is no longer supported. Please use the web app: https://gethatchapp.com\nHatch デスクトップ版は終了しました。Web 版をご利用ください：https://gethatchapp.com";

/**
 * A hello or message from the Desktop app, read before the frame is validated. Released builds send no `client`, but their hello carries
 * the app's version ("0.2.2"; web sends "hatch-web") and an acquirer's build sends the `entitlement_id` this Runtime no longer has.
 * A message has neither: the socket that said hello as a Desktop is a Desktop (see runtimeSocket).
 */
export function isDesktopFrame(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const frame = raw as { type?: unknown; client?: unknown; client_version?: unknown; entitlement_id?: unknown };
  if (frame.type !== "client.hello" && frame.type !== "client.message") return false;
  if (frame.client !== undefined) return frame.client === "desktop";
  return frame.entitlement_id !== undefined || (frame.type === "client.hello" && typeof frame.client_version === "string" && /^\d+\.\d+/.test(frame.client_version));
}
