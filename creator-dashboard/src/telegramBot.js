import qrcode from "qrcode-generator";
// A Product's own Telegram bot, as the Publish page drives it: the Registry holds the truth, this only asks and tells.
const CONNECTIONS = "/v1/creator/connections";
export const TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{30,}$/;
export const BOTFATHER_URL = "https://t.me/BotFather";

export const cleanToken = (text) => String(text ?? "").trim();
export const isTokenShape = (text) => TOKEN_PATTERN.test(cleanToken(text));
export const botLink = (username) => `https://t.me/${String(username).replace(/^@/, "")}`;

/** The Product's bot out of a channels view: its @username, or null when it has none. */
export function botOf(channels) {
  const telegram = (channels ?? []).find((channel) => channel.kind === "telegram");
  return telegram?.configured && telegram.handle ? { username: String(telegram.handle).replace(/^@/, "") } : null;
}

/** Which copy key says why a call failed, in words an Expert who has never seen a bot can act on. Null: use the generic message. */
export function telegramErrorKey(error) {
  if (error?.code === "telegram_probe_failed" || error?.code === "invalid_credentials") return "sxtgInvalidToken";
  if (error?.code === "channel_unavailable") return "sxtgUnavailable";
  if (error?.code === "product_not_found") return "sxtgProductMissing";
  if (!error?.status) return "sxtgNetwork";
  return null;
}

/** The QR code of a link as rows of dark/light modules, made here: no service sees the link. */
export function qrMatrix(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => qr.isDark(row, column)));
}
export const QUIET_ZONE = 4;
/** One SVG path for the dark modules, and the side of the picture, inside the quiet zone scanners need. */
export const qrPath = (matrix) => matrix.flatMap((row, y) => row.flatMap((dark, x) => dark ? [`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`] : [])).join("");
export const qrSide = (matrix) => matrix.length + 2 * QUIET_ZONE;

export class TelegramBotClient {
  constructor(request, productId) { this.request = request; this.productId = productId; }
  async get() { return botOf((await this.request(`${CONNECTIONS}?product_id=${encodeURIComponent(this.productId)}`)).channels); }
  async connect(token) {
    return botOf((await this.request(`${CONNECTIONS}/telegram/credentials`, { method: "POST", body: JSON.stringify({ product_id: this.productId, token: cleanToken(token) }) })).channels);
  }
  async disconnect() {
    await this.request(`${CONNECTIONS}/telegram?product_id=${encodeURIComponent(this.productId)}`, { method: "DELETE", body: JSON.stringify({}) });
  }
}
