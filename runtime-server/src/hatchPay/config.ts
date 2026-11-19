import type { WeChatPayConfig } from "./wechatPay.js";

export const DEFAULT_EMAIL_FROM = "Hatch <noreply@gethatchapp.com>";

export type HatchPayConfig = {
  wechat: WeChatPayConfig;
  mpAppSecret: string;
  publicBase: string;
  priceFen: number;
  resendApiKey: string;
  emailFrom: string;
};

const REQUIRED = [
  "WECHATPAY_MCHID", "WECHATPAY_SERIAL", "WECHATPAY_PRIVATE_KEY_B64", "WECHATPAY_APIV3_KEY", "WECHATPAY_PUBLIC_KEY_ID", "WECHATPAY_PUBLIC_KEY_B64",
  "WECHAT_MP_APPID", "WECHAT_MP_APPSECRET", "HATCH_PAY_PUBLIC_BASE", "HATCH_PAY_NOTIFY_URL", "HATCH_PAY_PRICE_FEN", "RESEND_API_KEY"
] as const;

/** Every value or nothing: the second form names what is missing or wrong, for the log line that says the feature is off. */
export function hatchPayConfigFromEnvironment(env: NodeJS.ProcessEnv): { config: HatchPayConfig } | { disabled: string } {
  const missing = REQUIRED.filter(name => !env[name]?.trim());
  if (missing.length) return { disabled: `missing ${missing.join(", ")}` };
  const value = (name: typeof REQUIRED[number]) => env[name]!.trim();
  const pem = (name: "WECHATPAY_PRIVATE_KEY_B64" | "WECHATPAY_PUBLIC_KEY_B64") => Buffer.from(value(name), "base64").toString("utf8");
  const priceFen = Number(value("HATCH_PAY_PRICE_FEN"));
  if (!Number.isInteger(priceFen) || priceFen <= 0) return { disabled: "HATCH_PAY_PRICE_FEN is not a positive integer" };
  if (Buffer.byteLength(value("WECHATPAY_APIV3_KEY")) !== 32) return { disabled: "WECHATPAY_APIV3_KEY is not 32 bytes" };
  return {
    config: {
      wechat: {
        mchid: value("WECHATPAY_MCHID"), appid: value("WECHAT_MP_APPID"), serial: value("WECHATPAY_SERIAL"), privateKeyPem: pem("WECHATPAY_PRIVATE_KEY_B64"),
        apiV3Key: value("WECHATPAY_APIV3_KEY"), publicKeyId: value("WECHATPAY_PUBLIC_KEY_ID"), publicKeyPem: pem("WECHATPAY_PUBLIC_KEY_B64"), notifyUrl: value("HATCH_PAY_NOTIFY_URL")
      },
      mpAppSecret: value("WECHAT_MP_APPSECRET"), publicBase: value("HATCH_PAY_PUBLIC_BASE").replace(/\/+$/, ""), priceFen,
      resendApiKey: value("RESEND_API_KEY"), emailFrom: env.HATCH_PAY_EMAIL_FROM?.trim() || DEFAULT_EMAIL_FROM
    }
  };
}
