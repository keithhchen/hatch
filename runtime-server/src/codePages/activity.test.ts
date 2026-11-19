import assert from "node:assert/strict";
import { test } from "node:test";
import { activityLine, recentActivity } from "./activity.js";

test("a tool call becomes a plain line, in progress until it has completed, and never carries a tool name", () => {
  assert.equal(activityLine({ name: "page_speed", status: "requested" }), "正在对比手机端与电脑端的打开速度");
  assert.equal(activityLine({ name: "page_speed", status: "completed" }), "已对比手机端与电脑端的打开速度");
  assert.equal(activityLine({ name: "box.bash", arguments: { command: "openssl s_client -connect x.com:443" }, status: "completed" }), "已检查网站的 HTTPS 证书");
  assert.equal(activityLine({ name: "box.bash", arguments: { command: "ls -la" }, status: "completed" }), undefined);
  assert.equal(activityLine({ name: "page_speed", status: "failed" }), undefined);
  assert.equal(activityLine({ name: "publish_html", status: "requested" }), undefined);
});

test("a thing asked twice shows once at its latest state, oldest first, capped", () => {
  const lines = recentActivity([
    { name: "fetch_url", status: "completed" }, { name: "page_speed", status: "requested" }, { name: "fetch_url", status: "requested" }
  ]);
  assert.deepEqual(lines, ["正在对比手机端与电脑端的打开速度", "正在打开官网页面，看海外买家看到的样子"]);
  assert.equal(recentActivity(Array.from({ length: 20 }, () => ({ name: "write", status: "completed" })), 3).length, 1);
});
