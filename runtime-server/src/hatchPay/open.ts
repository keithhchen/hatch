import { PostgresAccessCodes } from "../accessCodes/postgresAccessCodes.js";
import type { AccessCodes } from "../accessCodes/accessCodes.js";
import { log } from "../observability/log.js";
import type { PostgresQueryExecutor } from "../postgresStore.js";
import { hatchPayConfigFromEnvironment } from "./config.js";
import { ResendSender } from "./email.js";
import { HatchPay } from "./routes.js";
import { WeChatOAuth } from "./wechatOAuth.js";
import { WeChatPayV3 } from "./wechatPay.js";

/**
 * Access codes (always, so an operator's free codes redeem) and WeChat Pay (only with every setting present; the log line says what is
 * missing). The pay routes answer 503 while it is off.
 */
export async function openHatchPay(options: { pool: PostgresQueryExecutor; environment: NodeJS.ProcessEnv }): Promise<{ codes: AccessCodes; pay?: HatchPay }> {
  const configured = hatchPayConfigFromEnvironment(options.environment);
  const codes = new PostgresAccessCodes(options.pool, "config" in configured ? configured.config.priceFen : undefined);
  await codes.initialize();
  if (!("config" in configured)) {
    log.warn("hatch_pay_disabled", { reason: configured.disabled });
    return { codes };
  }
  const { config } = configured;
  let wechat: WeChatPayV3;
  try { wechat = new WeChatPayV3(config.wechat); } catch (error) {
    log.warn("hatch_pay_disabled", { reason: `WeChat Pay keys do not load: ${error instanceof Error ? error.message : String(error)}` });
    return { codes };
  }
  log.info("hatch_pay_enabled", { publicBase: config.publicBase, priceFen: config.priceFen });
  return {
    codes,
    pay: new HatchPay({
      codes, wechat, openids: new WeChatOAuth(config.wechat.appid, config.mpAppSecret), email: new ResendSender(config.resendApiKey),
      emailFrom: config.emailFrom, publicBase: config.publicBase, priceFen: config.priceFen
    })
  };
}
