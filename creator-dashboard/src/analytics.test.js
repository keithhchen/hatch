import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { createAnalytics } from "./analytics/createAnalytics.js";
import * as events from "./analytics/events.js";
import { noopAnalytics } from "./analytics/noopAnalytics.js";
import { createVideoMilestones, withTracking } from "./analytics/tracking.js";

const recorder = () => { const seen = []; return { seen, identify: (id) => seen.push(["identify", id]), reset: () => seen.push(["reset"]), track: (e) => seen.push(e) }; };

test("catalog functions return [name, props] tuples", () => {
  assert.deepEqual(events.studioStepOpened({ agentId: "a1", step: "build" }), ["studio_step_opened", { agent_id: "a1", step: "build" }]);
  assert.deepEqual(events.studioStepOpened({ agentId: "a1", step: "ask" }), ["studio_step_opened", { agent_id: "a1", step: "interview" }], "named as the server names it");
  assert.deepEqual(events.videoPlayed({ videoId: "v", positionS: 1, durationS: 60 }), ["video_played", { video_id: "v", position_s: 1, duration_s: 60 }]);
  assert.deepEqual(events.askuserAnswered({ questions: 3, skipped: 1 }), ["askuser_answered", { questions: 3, skipped: 1 }]);
  assert.deepEqual(events.shareLinkCopied({ agentId: "a1", link: "chat" }), ["share_link_copied", { agent_id: "a1", link: "chat" }]);
  assert.deepEqual(events.errorShown({ area: "buyer", category: "500" }), ["error_shown", { area: "buyer", category: "500" }]);
  assert.deepEqual(events.chatStarted({ agentId: "a1" }), ["chat_started", { agent_id: "a1" }]);
  assert.deepEqual(events.guestLimitReached({ agentId: "a1" }), ["guest_limit_reached", { agent_id: "a1" }]);
  assert.deepEqual(events.guestSignedInCarriedOver({ moved: 2 }), ["guest_signed_in_carried_over", { moved: 2 }]);
});

test("viaFromReferrer", () => {
  const origin = "https://hatch.test";
  assert.equal(viaOf(""), "direct");
  assert.equal(viaOf("https://t.me/x"), "share");
  assert.equal(viaOf("https://hatch.test/explore"), "catalog");
  assert.equal(viaOf("https://hatch.test/"), "direct");
  function viaOf(referrer) { return events.viaFromReferrer(referrer, origin); }
});

test("withTracking tracks first, then runs the handler with its arguments", () => {
  const analytics = recorder();
  const order = [];
  const tracked = { track: (e) => order.push(["track", e[0]]) };
  const result = withTracking(tracked, events.chatStarted({ agentId: "a1" }))((x) => { order.push(["handler", x]); return x * 2; })(21);
  assert.equal(result, 42);
  assert.deepEqual(order, [["track", "chat_started"], ["handler", 21]]);
  assert.equal(analytics.seen.length, 0);
});

test("a throwing tracker never breaks the handler", () => {
  let ran = false;
  withTracking({ track() { throw new Error("down"); } }, events.chatStarted({ agentId: "a1" }))(() => { ran = true; })();
  assert.equal(ran, true);
});

test("video milestones fire once each per play-through", () => {
  const m = createVideoMilestones();
  assert.deepEqual(m.advance(0.1), []);
  assert.deepEqual(m.advance(0.3), [25]);
  assert.deepEqual(m.advance(0.31), []);
  assert.deepEqual(m.advance(0.8), [50, 75]);
  m.restart();
  assert.deepEqual(m.advance(0.26), [25]);
});

test("createAnalytics picks PostHog only with a key", () => {
  assert.equal(createAnalytics({}), noopAnalytics);
  const adapter = recorder();
  assert.equal(createAnalytics({ VITE_POSTHOG_KEY: "phc_x" }, (key) => { assert.equal(key, "phc_x"); return adapter; }), adapter);
});

test("only the PostHog adapter imports a PostHog SDK", () => {
  const root = join(import.meta.dirname);
  const files = (dir) => readdirSync(dir).flatMap((name) => { const p = join(dir, name); return statSync(p).isDirectory() ? files(p) : [p]; });
  const offenders = files(root)
    .filter((p) => /\.(jsx?|tsx?|mjs)$/.test(p) && !p.endsWith("analytics.test.js") && relative(root, p) !== join("analytics", "posthogAnalytics.js"))
    .filter((p) => /posthog-js|@posthog\//.test(readFileSync(p, "utf8")));
  assert.deepEqual(offenders, []);
});

test("the PostHog adapter loads the SDK later and delivers calls made before it arrived, in order; a failed load is silent", async () => {
  const { createPostHogAnalytics } = await import("./analytics/posthogAnalytics.js");
  const calls = [];
  const fake = { init: (key) => calls.push(["init", key]), identify: (id) => calls.push(["identify", id]), reset: () => calls.push(["reset"]), capture: (name, props) => calls.push(["capture", name, props]) };
  const analytics = createPostHogAnalytics("phc_test", async () => fake);
  analytics.identify("acct_1");
  analytics.track(["video_played", { video_id: "upload" }]);
  assert.deepEqual(calls, [], "nothing runs synchronously");
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.deepEqual(calls, [["init", "phc_test"], ["identify", "acct_1"], ["capture", "video_played", { video_id: "upload" }]]);
  const broken = createPostHogAnalytics("phc_test", async () => { throw new Error("blocked"); });
  broken.track(["video_played", {}]);
  await new Promise((resolve) => setTimeout(resolve, 1700));
});
