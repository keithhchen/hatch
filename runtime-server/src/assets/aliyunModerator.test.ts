import assert from "node:assert/strict";
import test from "node:test";
import { AliyunImageModerator, AliyunTextModerator, aliyunModeratorFromEnvironment, ModeratorsByType, TEXT_CHUNK, type GreenClient, type ImageStage } from "./aliyunModerator.js";
import { AssetError, type Moderated } from "./domain.js";

// A test-only client: it records the request contract and answers what the test says. No Aliyun endpoint is called;
// whether the real service accepts these requests is not verified here.
type Answer = { statusCode?: number; body?: { code?: number; data?: { riskLevel?: string; result?: Array<{ label?: string }> } } };
const ok = (riskLevel?: string, labels: string[] = []): Answer => ({ statusCode: 200, body: { code: 200, data: { ...(riskLevel ? { riskLevel } : {}), result: labels.map(label => ({ label })) } } });

function fake(answer: (service: string, parameters: Record<string, any>) => Answer | Error = () => ok("none")) {
  const calls: Array<{ api: string; service?: string; parameters: Record<string, any> }> = [];
  const reply = (api: string, request: { service?: string; serviceParameters?: string }) => {
    const parameters = JSON.parse(request.serviceParameters ?? "{}");
    calls.push({ api, service: request.service, parameters });
    const result = answer(request.service!, parameters);
    if (result instanceof Error) throw result;
    return Promise.resolve(result);
  };
  const client: GreenClient = {
    textModerationPlusWithOptions: async request => reply("TextModerationPlus", request),
    imageModerationWithOptions: async request => reply("ImageModeration", request),
    describeUploadTokenWithOptions: async () => ({ statusCode: 200, body: { code: 200, data: { bucketName: "green-bucket", fileNamePrefix: "upload/1/", accessKeyId: "id", accessKeySecret: "secret", securityToken: "sts" } } }),
  };
  return { client, calls };
}
const staged: Array<{ object: string; bytes: number; bucket?: string }> = [];
const stage: ImageStage = { put: async (token, object, bytes) => { staged.push({ object, bytes: bytes.length, bucket: token.bucketName }); } };
const picture = { bytes: Buffer.from("pixels"), mime: "image/png" };

test("text goes to TextModerationPlus as comment_detection_pro, in pieces of at most 2000 characters", async () => {
  const { client, calls } = fake();
  assert.deepEqual(await new AliyunTextModerator(client).check({ text: "x".repeat(TEXT_CHUNK * 2 + 5) }), { allowed: true });
  assert.deepEqual(calls.map(call => [call.api, call.service, call.parameters.content.length]), [TEXT_CHUNK, TEXT_CHUNK, 5].map(length => ["TextModerationPlus", "comment_detection_pro", length]));
});

test("medium and high risk are withheld with the labels, never the content; low and none pass", async () => {
  for (const [level, allowed] of [["none", true], ["low", true], ["medium", false], ["high", false]] as const) {
    const verdict = await new AliyunTextModerator(fake(() => ok(level, ["porn", "nonLabel"])).client).check({ text: "secret words" });
    assert.equal(verdict.allowed, allowed, level);
    if (!verdict.allowed) { assert.match(verdict.reason, new RegExp(`${level} risk: porn$`)); assert.ok(!verdict.reason.includes("secret")); }
  }
});

test("one risky piece of a long text withholds all of it", async () => {
  const { client } = fake((_service, { content }) => ok(content.includes("BAD") ? "high" : "none"));
  assert.equal((await new AliyunTextModerator(client).check({ text: `${"a".repeat(TEXT_CHUNK * 3)}BAD${"a".repeat(10)}` })).allowed, false);
});

test("an answer that is not a clear verdict is an unavailable error, never a pass", async () => {
  const bad: Array<Answer | Error> = [{ statusCode: 500 }, { statusCode: 200, body: { code: 588 } }, ok(), ok("unheard-of"), new Error("socket hang up")];
  const unavailable = (error: unknown) => error instanceof AssetError && error.code === "unavailable";
  for (const answer of bad) {
    const { client } = fake(() => answer);
    await assert.rejects(new AliyunTextModerator(client).check({ text: "hello" }), unavailable);
    await assert.rejects(new AliyunImageModerator(client, stage, "cn-shanghai").check(picture), unavailable);
  }
});

test("an image is uploaded with a DescribeUploadToken token, then checked by object as baselineCheck", async () => {
  staged.length = 0;
  const { client, calls } = fake();
  assert.deepEqual(await new AliyunImageModerator(client, stage, "cn-shanghai").check(picture), { allowed: true });
  assert.equal(staged.length, 1);
  assert.match(staged[0]!.object, /^upload\/1\/[0-9a-f-]{36}\.png$/);
  assert.equal(staged[0]!.bucket, "green-bucket");
  assert.deepEqual([calls[0]!.api, calls[0]!.service, calls[0]!.parameters], ["ImageModeration", "baselineCheck", { ossBucketName: "green-bucket", ossObjectName: staged[0]!.object, ossRegionId: "cn-shanghai" }]);
  const withheld = await new AliyunImageModerator(fake(() => ok("high", ["violence"])).client, stage, "cn-shanghai").check(picture);
  assert.deepEqual(withheld, { allowed: false, reason: "Image was flagged as high risk: violence" });
});

test("content goes to the moderator of its type; audio is its transcript, so text", async () => {
  const seen: string[] = [];
  const typed = (type: string) => ({ check: async () => { seen.push(type); return { allowed: true as const }; } });
  const moderator = new ModeratorsByType({ text: typed("text"), image: typed("image") });
  await moderator.check({ type: "text", text: "a transcript" } satisfies Moderated);
  await moderator.check({ type: "image", ...picture });
  assert.deepEqual(seen, ["text", "image"]);
});

test("without the output guard's configuration there is no moderator, so uploads stay unavailable", () => {
  for (const mode of [undefined, "", "off", "disabled"]) assert.equal(aliyunModeratorFromEnvironment({ HATCH_OUTPUT_GUARD: mode }), undefined);
  assert.ok(aliyunModeratorFromEnvironment({ HATCH_OUTPUT_GUARD: "aliyun" }) instanceof ModeratorsByType, "configured: built from the SDK, nothing is called until an upload");
});
