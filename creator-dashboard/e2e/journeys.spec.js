import { expect, test } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  expectNoSeriousAccessibilityViolations,
  keyboardTabTo,
  signIn
} from "./helpers.js";

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-1280", "Full journeys run once; responsive coverage is a separate matrix.");
});

test("anonymous Buyer completes free checkout and can recover every durable route", async ({ page, context }) => {
  await page.goto("/agents/creator-e2e/signal-resume-review");
  await expectNoSeriousAccessibilityViolations(page);

  await page.getByRole("link", { name: "Get for free" }).click();
  await expect(page).toHaveURL(/\/sign-in\?returnTo=/);
  await expect(page.getByText("Signal Resume Review").first()).toBeVisible();
  await page.getByLabel("Email").fill("buyer@example.test");
  await page.getByLabel("Password").fill("buyer-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page).toHaveURL(/\/agents\/creator-e2e\/signal-resume-review$/);
  await page.getByRole("button", { name: "Get for free" }).click();
  await expect(page).toHaveURL(/\/portal\/checkout\//);
  await expect(page.getByRole("heading", { level: 1, name: "Review the real offer." })).toBeVisible();
  await page.getByLabel("I confirm this offer and its refund terms.").check();
  await page.getByRole("button", { name: "Add to my account" }).click();

  await expect(page).toHaveURL(/\/portal\/orders\/[^/]+\/success$/);
  const successUrl = page.url();
  await expect(page.getByRole("heading", { level: 1, name: "Signal Resume Review is ready." })).toBeVisible();
  await expect(page.getByText(/Free · Access granted/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Hatch Desktop" })).toHaveAttribute("href", /^hatch:\/\//);
  await expect(page.getByRole("link", { name: "Download Hatch Desktop" })).toHaveAttribute("href", /^https:\/\//);
  await expectNoHorizontalOverflow(page);
  await expectNoSeriousAccessibilityViolations(page);
  await expect(page).toHaveScreenshot("buyer-success.png", { fullPage: true, animations: "disabled", threshold: 0.25, maxDiffPixelRatio: 0.03 });

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Signal Resume Review is ready." })).toBeVisible();
  await page.getByRole("link", { name: "View order receipt" }).click();
  await expect(page).toHaveURL(/\/portal\/orders\/[^/]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "Signal Resume Review" })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: /^Not required$/ })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Access granted", { exact: true }).first()).toBeVisible();

  await page.goto(successUrl);
  await page.getByRole("link", { name: "View access details" }).click();
  await expect(page).toHaveURL(/\/portal\/library\/[^/]+$/);
  await expect(page.getByRole("link", { name: "Back to Library" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Explore" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Signal Resume Review" })).toBeVisible();
  await page.getByRole("link", { name: "Back to Library" }).click();
  await expect(page).toHaveURL(/\/portal\/library$/);
  await expect(page.getByRole("heading", { level: 1, name: "Agents your account can use." })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Agents your account can use." })).toBeVisible();

  await context.clearCookies();
  const protectedPath = new URL(successUrl).pathname;
  await page.goto(protectedPath);
  await expect(page).toHaveURL(/\/sign-in\?returnTo=/);
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe(protectedPath);
  await expect(page.getByRole("heading", { level: 2, name: "Sign in to Hatch" })).toBeVisible();
  await page.getByLabel("Email").fill("buyer@example.test");
  await page.getByLabel("Password").fill("buyer-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${protectedPath}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Signal Resume Review is ready." })).toBeVisible();

  await context.clearCookies();
  await page.goto("/sign-in?returnTo=https%3A%2F%2Fevil.example%2Fsteal");
  await page.getByLabel("Email").fill("buyer@example.test");
  await page.getByLabel("Password").fill("buyer-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/agents$/);
});

test("Creator can recover Home, Products, Orders and honest Payouts routes", async ({ page }) => {
  await signIn(page, "creator", "/portal/creator");
  await expect(page.getByRole("heading", { level: 1, name: /Maya, here’s the next useful step/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "Products", exact: true }).click();
  await expect(page).toHaveURL(/\/portal\/creator\/products$/);
  await expect(page.getByRole("heading", { level: 1, name: "From a method to a product people can use." })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Open product" }).first()).toBeVisible();

  await page.getByRole("button", { name: "Orders", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sales, delivery, and revenue—together." })).toBeVisible();
  await page.getByRole("button", { name: "Payouts", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Connect payouts before showing a balance." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Setup unavailable" })).toBeDisabled();
  await expectNoSeriousAccessibilityViolations(page);
});

test("keyboard reaches skip navigation and route changes focus the Creator h1", async ({ page }) => {
  await page.goto("/agents/creator-e2e/signal-resume-review");
  const skipLink = page.getByRole("link", { name: "Skip to content" });
  await keyboardTabTo(page, skipLink);
  await expect(skipLink).toBeFocused();

  await signIn(page, "creator", "/portal/creator");
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await page.getByRole("button", { name: "Products", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "From a method to a product people can use." })).toBeFocused();
});
