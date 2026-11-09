import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import * as CredentialPackage from "@alicloud/credentials";
import * as GreenPackage from "@alicloud/green20220302";
import { ImageModerationRequest, TextModerationPlusRequest } from "@alicloud/green20220302";
import { Config as OpenApiConfig } from "@alicloud/openapi-client";
import { RuntimeOptions } from "@alicloud/tea-util";
import { AssetError, type ContentModerator, type Moderated } from "./domain.js";

type Verdict = Awaited<ReturnType<ContentModerator["check"]>>;
type Typed<T extends Moderated["type"]> = { check(content: Extract<Moderated, { type: T }>): Promise<Verdict> };

/** Moderation is by content type: each type goes to the moderator that knows it. Audio arrives as its transcript, so it is text. */
export class ModeratorsByType implements ContentModerator {
  constructor(private readonly byType: { [T in Moderated["type"]]: Typed<T> }) {}
  check(content: Moderated): Promise<Verdict> {
    return content.type === "text" ? this.byType.text.check(content) : this.byType.image.check(content);
  }
}

type Reply<Data> = { statusCode?: number; body?: { code?: number; data?: Data } };
type Risk = { riskLevel?: string; result?: Array<{ label?: string }> };
type UploadToken = { accessKeyId?: string; accessKeySecret?: string; securityToken?: string; bucketName?: string; fileNamePrefix?: string; ossInternalEndPoint?: string; ossInternetEndPoint?: string };

/** The part of the Aliyun Green SDK client (@alicloud/green20220302) the moderators use. */
export interface GreenClient {
  textModerationPlusWithOptions(request: TextModerationPlusRequest, runtime: RuntimeOptions): Promise<Reply<Risk>>;
  imageModerationWithOptions(request: ImageModerationRequest, runtime: RuntimeOptions): Promise<Reply<Risk>>;
  describeUploadTokenWithOptions(runtime: RuntimeOptions): Promise<Reply<UploadToken>>;
}

const RUNTIME = new RuntimeOptions({ connectTimeout: 3_000, readTimeout: 10_000, autoretry: false, maxAttempts: 1 });
/** Aliyun's levels: none, low, medium, high. Hatch has no manual review, so medium is withheld like high. */
const WITHHELD = new Set(["medium", "high"]);
const KNOWN = new Set(["none", "low", ...WITHHELD]);

const unavailable = (what: string) => new AssetError("unavailable", `Content moderation is unavailable: ${what}`);

/** A call that throws is as unavailable as one that is answered badly. */
async function guarded<T>(what: string, call: () => Promise<T>): Promise<T> {
  try { return await call(); } catch (error) { throw error instanceof AssetError ? error : unavailable(`${what}: ${error instanceof Error ? error.message : String(error)}`); }
}

/** A reply that is not a clear verdict is an error, never a pass. */
function verdictOf(reply: Reply<Risk>, what: string): Verdict {
  const data = reply.body?.data;
  if (reply.statusCode !== 200 || reply.body?.code !== 200) throw unavailable(`${what} request failed (code ${reply.body?.code ?? reply.statusCode})`);
  if (!data?.riskLevel || !KNOWN.has(data.riskLevel)) throw unavailable(`${what} returned no risk level`);
  if (!WITHHELD.has(data.riskLevel)) return { allowed: true };
  const labels = (data.result ?? []).map(item => item.label).filter(label => label && label !== "nonLabel");
  return { allowed: false, reason: `${what} was flagged as ${data.riskLevel} risk${labels.length ? `: ${labels.join(", ")}` : ""}` };
}

/** Moderation Plus' limit for one request is 2000 characters. */
export const TEXT_CHUNK = 2000;
const CONCURRENT = 8;

/** Text by TextModerationPlus, service `comment_detection_pro`. Long text goes in pieces; the first piece that is withheld decides. */
export class AliyunTextModerator implements Typed<"text"> {
  constructor(private readonly client: GreenClient, private readonly service = "comment_detection_pro") {}

  async check({ text }: { text: string }): Promise<Verdict> {
    const pieces = Array.from({ length: Math.ceil(text.length / TEXT_CHUNK) }, (_, index) => text.slice(index * TEXT_CHUNK, (index + 1) * TEXT_CHUNK));
    for (let at = 0; at < pieces.length; at += CONCURRENT) {
      const verdicts = await Promise.all(pieces.slice(at, at + CONCURRENT).map(piece => this.piece(piece)));
      const withheld = verdicts.find(verdict => !verdict.allowed);
      if (withheld) return withheld;
    }
    return { allowed: true };
  }

  private async piece(content: string): Promise<Verdict> {
    const request = new TextModerationPlusRequest({ service: this.service, serviceParameters: JSON.stringify({ content }) });
    return guarded("Text", async () => verdictOf(await this.client.textModerationPlusWithOptions(request, RUNTIME), "Text"));
  }
}

/** Puts an image where ImageModeration can read it: Aliyun's upload bucket. */
export interface ImageStage {
  put(token: UploadToken, object: string, bytes: Buffer): Promise<void>;
}

type OssClient = { put(name: string, content: Buffer): Promise<unknown> };

/** Uploads with the temporary credentials DescribeUploadToken hands out. */
export class AliyunOssStage implements ImageStage {
  constructor(private readonly internal: boolean) {}
  async put(token: UploadToken, object: string, bytes: Buffer): Promise<void> {
    const OSS = createRequire(import.meta.url)("ali-oss") as new (options: Record<string, unknown>) => OssClient;
    const client = new OSS({ accessKeyId: token.accessKeyId, accessKeySecret: token.accessKeySecret, stsToken: token.securityToken, bucket: token.bucketName, endpoint: this.internal ? token.ossInternalEndPoint : token.ossInternetEndPoint, secure: true });
    await client.put(object, bytes);
  }
}

const EXTENSION: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/**
 * Images by ImageModeration, service `baselineCheck`, in Aliyun's documented local-file flow: DescribeUploadToken,
 * upload to the bucket it names, then check that object by ossBucketName, ossObjectName and ossRegionId.
 */
export class AliyunImageModerator implements Typed<"image"> {
  constructor(private readonly client: GreenClient, private readonly stage: ImageStage, private readonly region: string, private readonly service = "baselineCheck") {}

  check(image: { bytes: Buffer; mime: string }): Promise<Verdict> { return guarded("Image", () => this.moderate(image)); }

  private async moderate({ bytes, mime }: { bytes: Buffer; mime: string }): Promise<Verdict> {
    const reply = await this.client.describeUploadTokenWithOptions(RUNTIME);
    const token = reply.body?.data;
    if (reply.statusCode !== 200 || reply.body?.code !== 200 || !token?.bucketName || !token.fileNamePrefix) throw unavailable("no upload token for the image");
    const object = `${token.fileNamePrefix}${randomUUID()}.${EXTENSION[mime] ?? "jpg"}`;
    await this.stage.put(token, object, bytes);
    const request = new ImageModerationRequest({ service: this.service, serviceParameters: JSON.stringify({ ossBucketName: token.bucketName, ossObjectName: object, ossRegionId: this.region }) });
    return verdictOf(await this.client.imageModerationWithOptions(request, RUNTIME), "Image");
  }
}

/** The SDK is CommonJS: its constructor sits behind one or two `default`s, as in outputGuard.ts. */
function commonJsDefault(module: { default?: unknown }): any {
  const value = module.default;
  if (typeof value === "function") return value;
  if (value && typeof value === "object" && "default" in value) return (value as { default: unknown }).default;
  throw new Error("Alibaba SDK default export is unavailable");
}

/**
 * The moderator the output guard's configuration asks for: on with HATCH_OUTPUT_GUARD=aliyun|enforce, in its region and
 * endpoint, with the Alibaba default credential chain. Nothing when that is off: the caller then has no moderator.
 */
export function aliyunModeratorFromEnvironment(environment: NodeJS.ProcessEnv = process.env): ContentModerator | undefined {
  const mode = environment.HATCH_OUTPUT_GUARD?.trim().toLowerCase();
  if (mode !== "aliyun" && mode !== "enforce") return undefined;
  const region = environment.HATCH_OUTPUT_GUARD_REGION?.trim() || "cn-shanghai";
  const endpoint = environment.HATCH_OUTPUT_GUARD_ENDPOINT?.trim() || "green-cip-vpc.cn-shanghai.aliyuncs.com";
  const Credential = commonJsDefault(CredentialPackage) as new () => unknown;
  const Green = commonJsDefault(GreenPackage) as new (config: OpenApiConfig) => GreenClient;
  const client = new Green(new OpenApiConfig({ credential: new Credential(), regionId: region, endpoint, connectTimeout: 3_000, readTimeout: 10_000 }));
  return new ModeratorsByType({ text: new AliyunTextModerator(client), image: new AliyunImageModerator(client, new AliyunOssStage(/-vpc\./.test(endpoint)), region) });
}
