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

test("public Creator and Product pages stay connected by UUID", async ({ page }) => {
  await page.goto("/creators/6f6a3d24-48af-4f27-9c50-0d4f7e4e8a21");
  await expect(page.getByRole("heading", { level: 1, name: "Maya Creator" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Signal Resume Review" })).toBeVisible();

  await page.locator(".buyer-v2__catalog-card").filter({ has: page.getByRole("heading", { level: 2, name: "Signal Resume Review" }) }).getByRole("link", { name: "View details" }).click();
  await expect(page).toHaveURL(/\/products\/f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42$/);
  const creatorLink = page.getByRole("link", { name: "Maya Creator", exact: true }).first();
  await expect(creatorLink).toHaveAttribute("href", "/creators/6f6a3d24-48af-4f27-9c50-0d4f7e4e8a21");
  await creatorLink.click();
  await expect(page).toHaveURL(/\/creators\/6f6a3d24-48af-4f27-9c50-0d4f7e4e8a21$/);
  await expect(page.getByRole("heading", { level: 2, name: "Signal Resume Review" })).toBeVisible();
});

test("anonymous Buyer completes free checkout and can recover every durable route", async ({ page, context }) => {
  await page.goto("/products/f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42");
  await expectNoSeriousAccessibilityViolations(page);

  await page.getByRole("link", { name: "Get access" }).click();
  await expect(page).toHaveURL(/\/sign-in\?returnTo=/);
  await expect(page.getByText("Signal Resume Review").first()).toBeVisible();
  await page.getByLabel("Email").fill("buyer@example.test");
  await page.getByLabel("Password").fill("buyer-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page).toHaveURL(/\/products\/f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42$/);
  await page.getByRole("button", { name: "Get access" }).click();
  await expect(page).toHaveURL(/\/checkout\//);
  await expect(page.getByRole("heading", { level: 1, name: "Confirm this Product." })).toBeVisible();
  await page.getByLabel("Add this Product to my account.").check();
  await page.getByRole("button", { name: "Add to my account" }).click();

  await expect(page).toHaveURL(/\/orders\/[^/]+\/success$/);
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
  await expect(page).toHaveURL(/\/orders\/[^/]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "Signal Resume Review" })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: /^Not required$/ })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Access granted", { exact: true }).first()).toBeVisible();

  await page.goto(successUrl);
  await page.getByRole("link", { name: "View access details" }).click();
  await expect(page).toHaveURL(/\/library\/[^/]+$/);
  await expect(page.getByRole("link", { name: "Back to Library" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Explore" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Signal Resume Review" })).toBeVisible();
  await page.getByRole("link", { name: "Back to Library" }).click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByRole("heading", { level: 1, name: "Agents linked to your account." })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Agents linked to your account." })).toBeVisible();

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
  await expect(page).toHaveURL(/\/explore$/);
});

test("Creator can recover Home, Products and free Access routes", async ({ page }) => {
  await signIn(page, "creator", "/studio");
  await expect(page.getByRole("heading", { level: 1, name: /Maya, here’s the next useful step/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "Products", exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/products$/);
  await expect(page.getByRole("heading", { level: 1, name: "From a method to a product people can use." })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Open product" }).first()).toBeVisible();

  await page.getByRole("button", { name: "Orders", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "See who can use each product." })).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
});

test("keyboard reaches skip navigation and route changes focus the Creator h1", async ({ page }) => {
  await page.goto("/products/f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42");
  const skipLink = page.getByRole("link", { name: "Skip to content" });
  await keyboardTabTo(page, skipLink);
  await expect(skipLink).toBeFocused();

  await signIn(page, "creator", "/studio");
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await page.getByRole("button", { name: "Products", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "From a method to a product people can use." })).toBeFocused();
});
