import { MemoryAttemptLimiter, limiterKey, rateLimitedAccessCodes } from "../accessCodes/rateLimit.js";
import type http from "node:http";
import { PostgresProductCapabilities } from "../agentBox/capabilities.js";
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
export async function openHatchPay(options: { pool: PostgresQueryExecutor; environment: NodeJS.ProcessEnv }): Promise<{ codes: AccessCodes; accessCodesFor: (headers: http.IncomingHttpHeaders) => AccessCodes; pay?: HatchPay }> {
  const configured = hatchPayConfigFromEnvironment(options.environment);
  const codes = new PostgresAccessCodes(options.pool, "config" in configured ? configured.config.priceFen : undefined);
  await codes.initialize();
  // One limiter for the whole Runtime: 30 failed redeems or lookups per client address per 10 minutes.
  const limiter = new MemoryAttemptLimiter();
  const accessCodesFor = (headers: http.IncomingHttpHeaders) => rateLimitedAccessCodes(codes, limiter, limiterKey(headers));
  if (!("config" in configured)) {
    log.warn("hatch_pay_disabled", { reason: configured.disabled });
    return { codes, accessCodesFor };
  }
  const capabilities = new PostgresProductCapabilities(options.pool);
  await capabilities.initialize();
  const { config } = configured;
  let wechat: WeChatPayV3;
  try { wechat = new WeChatPayV3(config.wechat); } catch (error) {
    log.warn("hatch_pay_disabled", { reason: `WeChat Pay keys do not load: ${error instanceof Error ? error.message : String(error)}` });
    return { codes, accessCodesFor };
  }
  log.info("hatch_pay_enabled", { publicBase: config.publicBase, priceFen: config.priceFen });
  return {
    codes, accessCodesFor,
    pay: new HatchPay({
      capabilities, codes, wechat, openids: new WeChatOAuth(config.wechat.appid, config.mpAppSecret), email: new ResendSender(config.resendApiKey),
      emailFrom: config.emailFrom, publicBase: config.publicBase, priceFen: config.priceFen
    })
  };
}
