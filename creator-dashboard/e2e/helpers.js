import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";

const e2eDashboardPort = Number(process.env.HATCH_E2E_PORT ?? 18_500);
const e2eRegistryPort = Number(process.env.HATCH_E2E_REGISTRY_PORT ?? e2eDashboardPort + 1);
const e2eControlToken = "hatch-commerce-v2-e2e-control";

export async function signIn(page, role = "buyer", returnTo = "/explore") {
  const credentials = role === "creator"
    ? { email: "creator@example.test", password: "creator-password" }
    : { email: "buyer@example.test", password: "buyer-password" };
  await page.goto(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(escapeRegExp(returnTo.split("?")[0])));
}

export async function expectNoHorizontalOverflow(page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth
  }));
  expect(dimensions.document, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.body, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport + 1);
}

export async function expectNoSeriousAccessibilityViolations(page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const violations = result.violations.filter((violation) => ["serious", "critical"].includes(violation.impact));
  expect(violations, violations.map((item) => `${item.id}: ${item.help}`).join("\n")).toEqual([]);
}

export async function keyboardTabTo(page, target, maxTabs = 60) {
  await expect(target).toBeVisible();
  for (let index = 0; index < maxTabs; index += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target, `Keyboard focus did not reach the target after ${maxTabs} Tab presses.`).toBeFocused();
}

export async function e2eControl(request, pathname, options = {}) {
  const response = await request.fetch(`http://127.0.0.1:${e2eRegistryPort}${pathname}`, {
    ...options,
    headers: {
      "x-hatch-e2e-control": e2eControlToken,
      ...(options.headers ?? {})
    },
    failOnStatusCode: false
  });
  const payload = await response.json();
  expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
  return payload;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
