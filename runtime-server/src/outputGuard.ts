import * as CredentialPackage from "@alicloud/credentials";
import * as GreenPackage from "@alicloud/green20220302";
import { MultiModalGuardRequest } from "@alicloud/green20220302";
import { Config as OpenApiConfig } from "@alicloud/openapi-client";
import { RuntimeOptions } from "@alicloud/tea-util";

export type OutputGuardVerdict = "pass" | "block";

export const DEFAULT_OUTPUT_GUARD_FIRST_SEGMENT_CHARS = 100;
export const DEFAULT_OUTPUT_GUARD_LATER_SEGMENT_CHARS = 250;

export const OUTPUT_GUARD_BLOCKED_MODEL_MESSAGE =
  "My previous response was blocked before delivery and was not shown to the user. I must not reproduce or continue the blocked content.";

export type OutputGuardInput = {
  content: string;
  chatId: string;
  sessionId: string;
  done: boolean;
};

export interface OutputGuard {
  check(input: OutputGuardInput): Promise<OutputGuardVerdict>;
}

export class PassThroughOutputGuard implements OutputGuard {
  async check(): Promise<OutputGuardVerdict> {
    return "pass";
  }
}

export type GuardedOutputResult = {
  released: string[];
  blocked: boolean;
};

export type OutputGuardTiming = {
  segment: number;
  done: boolean;
  content_chars: number;
  detection_chars: number;
  started_ms: number;
  duration_ms: number;
  outcome: "pass" | "block" | "degraded";
};

/**
 * Per-run text buffer. It contains no durable state and never logs content.
 */
export class GuardedAssistantOutput {
  private pending = "";
  private detectionOverlap = "";
  private first = true;
  private terminal = false;
  private segment = 0;

  constructor(
    private readonly guard: OutputGuard,
    private readonly runId: string,
    private readonly firstSegmentChars = DEFAULT_OUTPUT_GUARD_FIRST_SEGMENT_CHARS,
    private readonly laterSegmentChars = DEFAULT_OUTPUT_GUARD_LATER_SEGMENT_CHARS,
    private readonly detectionOverlapChars = firstSegmentChars,
    private readonly observeTiming?: (timing: OutputGuardTiming) => void,
    private readonly clock: () => number = () => performance.now()
  ) {}

  async push(content: string): Promise<GuardedOutputResult> {
    if (this.terminal || !content) {
      return { released: [], blocked: this.terminal };
    }
    this.pending += content;
    const released: string[] = [];
    while (!this.terminal) {
      const threshold = this.first ? this.firstSegmentChars : this.laterSegmentChars;
      // Leave at least one character for a non-empty final done=true request.
      if (this.pending.length <= threshold) break;
      const cut = segmentBoundary(this.pending, threshold);
      const segment = this.pending.slice(0, cut);
      this.pending = this.pending.slice(cut);
      const verdict = await this.check(segment, false);
      this.first = false;
      if (verdict === "block") break;
      released.push(segment);
    }
    return { released, blocked: this.terminal };
  }

  async finish(): Promise<GuardedOutputResult> {
    if (this.terminal) {
      return { released: [], blocked: true };
    }
    if (!this.pending) {
      return { released: [], blocked: false };
    }
    const segment = this.pending;
    this.pending = "";
    const verdict = await this.check(segment, true);
    this.first = false;
    return verdict === "pass"
      ? { released: [segment], blocked: false }
      : { released: [], blocked: true };
  }

  private async check(content: string, done: boolean): Promise<OutputGuardVerdict> {
    const detectionContent = this.detectionOverlap + content;
    const segment = ++this.segment;
    const started = this.clock();
    try {
      const verdict = await this.guard.check({
        content: detectionContent,
        chatId: this.runId,
        sessionId: this.runId,
        done
      });
      this.observeTiming?.({
        segment,
        done,
        content_chars: content.length,
        detection_chars: detectionContent.length,
        started_ms: started,
        duration_ms: this.clock() - started,
        outcome: verdict
      });
      if (verdict === "block") {
        this.terminal = true;
        this.pending = "";
        this.detectionOverlap = "";
        return "block";
      }
    } catch {
      this.observeTiming?.({
        segment,
        done,
        content_chars: content.length,
        detection_chars: detectionContent.length,
        started_ms: started,
        duration_ms: this.clock() - started,
        outcome: "degraded"
      });
      // Guard availability must not turn a provider outage into a failed user
      // turn. Only an explicit provider block withholds generated text.
    }
    this.detectionOverlap = this.detectionOverlapChars > 0
      ? detectionContent.slice(-this.detectionOverlapChars)
      : "";
    return "pass";
  }
}

export function createOutputGuardFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): OutputGuard {
  const mode = environment.HATCH_OUTPUT_GUARD?.trim().toLowerCase();
  if (!mode || mode === "off" || mode === "disabled") {
    return new PassThroughOutputGuard();
  }
  if (mode !== "aliyun" && mode !== "enforce") {
    throw new Error("HATCH_OUTPUT_GUARD must be one of: off, aliyun, enforce");
  }
  return new AliyunOutputGuard({
    region: environment.HATCH_OUTPUT_GUARD_REGION?.trim() || "cn-shanghai",
    endpoint: environment.HATCH_OUTPUT_GUARD_ENDPOINT?.trim()
      || "green-cip-vpc.cn-shanghai.aliyuncs.com",
    service: environment.HATCH_OUTPUT_GUARD_SERVICE?.trim()
      || "response_security_check_pro"
  });
}

type AliyunOutputGuardOptions = {
  region: string;
  endpoint: string;
  service: string;
};

export class AliyunOutputGuard implements OutputGuard {
  private readonly client: {
    multiModalGuardWithOptions(
      request: MultiModalGuardRequest,
      runtime: RuntimeOptions
    ): Promise<{
      statusCode?: number;
      body?: {
        code?: number;
        data?: {
          suggestion?: string;
          detail?: Array<{
            type?: string;
            suggestion?: string;
          }>;
        };
      };
    }>;
  };
  private readonly runtime = new RuntimeOptions({
    connectTimeout: 3_000,
    readTimeout: 10_000,
    autoretry: false,
    maxAttempts: 1
  });

  constructor(private readonly options: AliyunOutputGuardOptions) {
    const CredentialConstructor = commonJsDefault(CredentialPackage) as new () => unknown;
    const GreenConstructor = commonJsDefault(GreenPackage) as new (
      config: OpenApiConfig
    ) => AliyunOutputGuard["client"];
    const credential = new CredentialConstructor();
    this.client = new GreenConstructor(new OpenApiConfig({
      credential,
      regionId: options.region,
      endpoint: options.endpoint,
      connectTimeout: 3_000,
      readTimeout: 10_000
    }));
  }

  async check(input: OutputGuardInput): Promise<OutputGuardVerdict> {
    const request = new MultiModalGuardRequest({
      service: this.options.service,
      serviceParameters: JSON.stringify({
        content: input.content,
        chatId: input.chatId,
        sessionId: input.sessionId,
        done: input.done
      })
    });
    const response = await this.client.multiModalGuardWithOptions(request, this.runtime);
    const body = response.body;
    if (response.statusCode !== 200 || body?.code !== 200) {
      throw new Error("Alibaba Output Guard request failed");
    }
    return outputLeakVerdict(body.data?.detail);
  }
}

/**
 * The service can run several independent protection dimensions. Hatch uses
 * this adapter only for output disclosure, so input-oriented prompt-attack or
 * general content-moderation verdicts must not widen the product policy.
 * Missing or malformed custom-label results throw here and are degraded to
 * pass by GuardedAssistantOutput. Only an explicit custom-label block is a
 * content-filter outcome.
 */
export function outputLeakVerdict(
  detail: Array<{ type?: string; suggestion?: string }> | undefined
): OutputGuardVerdict {
  const customLabels = detail?.filter((item) => item.type === "customLabel") ?? [];
  if (customLabels.length === 0) {
    throw new Error("Alibaba Output Guard customLabel result is unavailable");
  }
  if (customLabels.some((item) => item.suggestion === "block")) {
    return "block";
  }
  if (customLabels.every((item) => item.suggestion === "pass")) {
    return "pass";
  }
  throw new Error("Alibaba Output Guard customLabel result is invalid");
}

function commonJsDefault(module: { default?: unknown }): any {
  const value = module.default;
  if (typeof value === "function") return value;
  if (value && typeof value === "object" && "default" in value) {
    return (value as { default: unknown }).default;
  }
  throw new Error("Alibaba SDK default export is unavailable");
}

function segmentBoundary(content: string, threshold: number): number {
  const minimumNaturalBoundary = Math.floor(threshold * 0.6);
  for (let index = threshold - 1; index >= minimumNaturalBoundary; index -= 1) {
    if ("。！？.!?\n".includes(content[index] ?? "")) {
      return index + 1;
    }
  }
  return threshold;
}
