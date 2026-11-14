import { expect, test } from "@playwright/test";

// Mounts the real Studio workbench in Chromium against stubbed API responses, so a render crash
// (full-page "Hatch could not open this page." or the Studio region fallback) fails CI before deploy.
const PRODUCT = "11111111-1111-4111-8111-111111111111";
const ROOT = `/v1/creator/products/${PRODUCT}/factory-agents`;
const agents = ["voice", "generation"].map(role => ({ role, name: role, state: role === "voice" ? "ready" : "locked" }));
const session = { id: "s1", role: "voice", status: "idle", messages: [], files: [], todos: [], updatedAt: "2026-01-01T00:00:00Z" };
const json = body => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

test.beforeEach(async ({ page }) => {
  await page.route(/\/v1\//, route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/me") return route.fulfill(json({ id: "u1", email: "a@example.test", display_name: "Test" }));
    if (path === `/v1/creator/products/${PRODUCT}`) return route.fulfill(json({ product: { product_id: PRODUCT, product_name: "Smoke", status: "draft" } }));
    if (path === `${ROOT}/config`) return route.fulfill(json({ agents, manualFiles: [], services: { model: true } }));
    if (path === `${ROOT}/events`) return route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "snapshot", sessions: [session], agents, manualFiles: [] })}\n\n` });
    if (path === `${ROOT}/sessions/s1`) return route.fulfill(json(session));
    if (path === `${ROOT}/sessions/s1/events`) return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": open\n\n" });
    return route.fulfill(json({}));
  });
});

const CRASHED = /Hatch could not open this page\.|This part of the page failed to open\./;
for (const [name, path, ready] of [
  ["Workspace and ChatPanel", "sources/voice", ".factory-chat textarea"],
  ["ImportFromAi", "sources/uploads", ".factory-import__open"],
  ["AgentIntro", "build/generation", ".factory-agent-intro"]
]) {
  test(`${name} render without crashing`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`/studio/factory/${PRODUCT}/${path}`);
    await expect(page.locator(ready).or(page.getByText(CRASHED)).first()).toBeVisible();
    await expect(page.getByText(CRASHED)).toHaveCount(0);
    await expect(page.locator(ready).first()).toBeVisible();
    expect(errors).toEqual([]);
  });
}
