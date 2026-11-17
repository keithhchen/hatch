import { expect, test } from "@playwright/test";
import {
  e2eControl,
  expectNoSeriousAccessibilityViolations,
  keyboardTabTo,
  signIn
} from "./helpers.js";

const PUBLIC_PRODUCT = "/products/f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42";
const PUBLIC_PRODUCT_ID = "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42";
const PAGINATION_PRODUCT_ID = "d4b6f3a1-2c87-4e59-9a10-6b7c8d9e0f12";
const BUYER_TOKEN = "buyer-e2e-token";

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-1280", "Stateful Commerce journeys run once; responsive behavior has its own project matrix.");
});

test("R02 sign-up preserves the Product intent and returns to the selected Product", async ({ page }, testInfo) => {
  await page.goto(PUBLIC_PRODUCT);
  await page.getByRole("link", { name: "Get access" }).click();
  await expect(page).toHaveURL(/\/sign-in\?returnTo=/);
  await expect(page.getByText("Signal Resume Review").first()).toBeVisible();
  await expect(page.getByText("Free access", { exact: true }).first()).toBeVisible();

  await page.getByRole("link", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/sign-up\?returnTo=/);
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe(PUBLIC_PRODUCT);
  await page.getByLabel("Name").fill("Signup Return Buyer");
  await page.getByLabel("Email").fill(uniqueEmail("signup-return", testInfo));
  await page.getByLabel("Password").fill("signup-return-password");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(PUBLIC_PRODUCT)}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Signal Resume Review" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Get access" })).toBeEnabled();
});

test("R03 duplicate submit plus a lost response retries to one free order and entitlement", async ({ page, request }, testInfo) => {
  const email = uniqueEmail("duplicate-retry", testInfo);
  await createBuyerFromProduct(page, email, "Duplicate Retry Buyer");
  const profile = await browserJson(page, "/v1/auth/me");

  await page.getByRole("button", { name: "Get access" }).click();
  await expect(page).toHaveURL(/\/checkout\//);
  await page.getByLabel("Add this Product to my account.").check();

  const checkoutId = new URL(page.url()).pathname.split("/").at(-1);
  const confirmUrl = `/v1/checkout-sessions/${encodeURIComponent(checkoutId)}/confirm`;
  const duplicateBodies = [];
  let injectLostResponse = true;
  await page.route(`**${confirmUrl}`, async (route) => {
    if (!injectLostResponse) return route.continue();
    injectLostResponse = false;
    const intercepted = route.request();
    const duplicatePromise = request.fetch(intercepted.url(), {
      method: intercepted.method(),
      headers: intercepted.headers(),
      data: intercepted.postDataBuffer() ?? undefined,
      failOnStatusCode: false
    });
    const firstResponse = await route.fetch();
    const duplicateResponse = await duplicatePromise;
    duplicateBodies.push(await firstResponse.json(), await duplicateResponse.json());
    expect(firstResponse.ok()).toBeTruthy();
    expect(duplicateResponse.ok()).toBeTruthy();
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "upstream_response_lost",
          message: "The upstream commit succeeded, but the browser-facing response was lost."
        }
      })
    });
  });

  await page.getByRole("button", { name: "Add to my account" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(duplicateBodies).toHaveLength(2);
  expect(new Set(duplicateBodies.map((body) => body.order_id)).size).toBe(1);
  expect(new Set(duplicateBodies.map((body) => body.entitlement_id)).size).toBe(1);

  await page.unroute(`**${confirmUrl}`);
  const retryResponse = page.waitForResponse((response) => response.url().endsWith(confirmUrl) && response.request().method() === "POST");
  await page.getByRole("button", { name: "Add to my account" }).click();
  expect((await retryResponse).status()).toBe(200);
  await expect(page).toHaveURL(/\/explore\/orders\/[^/]+\/success$/);
  await expect(page.getByText(/Free · Access granted/)).toBeVisible();

  const [orders, entitlements, commerceState] = await Promise.all([
    browserJson(page, "/v1/user/orders?limit=100"),
    browserJson(page, "/v1/user/entitlements?limit=100"),
    e2eControl(request, `/__e2e/commerce?buyer_id=${encodeURIComponent(profile.id)}`)
  ]);
  expect(orders.orders).toHaveLength(1);
  expect(entitlements.entitlements).toHaveLength(1);
  expect(orders.orders[0].payment_status).toBe("not_required");
  expect(commerceState.events.filter((event) => event.event_type === "order.placed")).toHaveLength(1);
  expect(commerceState.events.filter((event) => event.event_type === "entitlement.granted")).toHaveLength(1);
  expect(commerceState.events.filter((event) => event.event_type === "revenue.recognized")).toHaveLength(0);
  expect(commerceState.access).toHaveLength(1);
});

test("R04 changed release has zero Access side effects and requires a fresh confirmation", async ({ page, request }, testInfo) => {
  await resetBaseRelease(request);
  const email = uniqueEmail("release-change", testInfo);
  try {
    await createBuyerFromProduct(page, email, "Release Change Buyer");
    const profile = await browserJson(page, "/v1/auth/me");
    await page.getByRole("button", { name: "Get access" }).click();
    await expect(page).toHaveURL(/\/checkout\//);

    await e2eControl(request, "/__e2e/release", {
      method: "POST",
      data: {
        product_id: PUBLIC_PRODUCT_ID,
        corpus_digest: `sha256:${"b".repeat(64)}`
      }
    });
    await page.getByLabel("Add this Product to my account.").check();
    const changedResponse = page.waitForResponse((response) => response.url().endsWith("/confirm") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Add to my account" }).click();
    expect((await changedResponse).status()).toBe(409);

    await expect(page.getByText("This access request is no longer current.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add to my account" })).toBeDisabled();
    const noSideEffects = await e2eControl(request, `/__e2e/commerce?buyer_id=${encodeURIComponent(profile.id)}`);
    expect(noSideEffects.events).toEqual([]);
    expect(noSideEffects.access).toEqual([]);

    await resetBaseRelease(request);
    await page.getByRole("link", { name: "Back to product" }).click();
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(PUBLIC_PRODUCT)}$`));
    await page.getByRole("button", { name: "Get access" }).click();
    await page.getByLabel("Add this Product to my account.").check();
    await page.getByRole("button", { name: "Add to my account" }).click();
    await expect(page).toHaveURL(/\/explore\/orders\/[^/]+\/success$/);

    const afterFreshConfirmation = await e2eControl(request, `/__e2e/commerce?buyer_id=${encodeURIComponent(profile.id)}`);
    expect(afterFreshConfirmation.events.filter((event) => event.event_type === "order.placed")).toHaveLength(1);
    expect(afterFreshConfirmation.events.filter((event) => event.event_type === "entitlement.granted")).toHaveLength(1);
  } finally {
    await resetBaseRelease(request);
  }
});

test("R30 keyboard-only Buyer flow completes free checkout with stable focus and ARIA semantics", async ({ page }, testInfo) => {
  const email = uniqueEmail("keyboard-free-checkout", testInfo);

  await page.goto(PUBLIC_PRODUCT);
  const productHeading = page.getByRole("heading", { level: 1, name: "Signal Resume Review" });
  await expect(productHeading).toBeVisible();
  const skipLink = page.getByRole("link", { name: "Skip to content" });
  await keyboardTabTo(page, skipLink);
  await expect(skipLink).toBeFocused();
  await expectNoSeriousAccessibilityViolations(page);

  const anonymousCta = page.getByRole("link", { name: "Get access" });
  await keyboardTabTo(page, anonymousCta);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/sign-in\?returnTo=/);
  await expect(page.locator("main.buyer-v2 h1")).toBeFocused();
  await expectNoSeriousAccessibilityViolations(page);

  const createAccountLink = page.getByRole("link", { name: "Create account" });
  await keyboardTabTo(page, createAccountLink);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/sign-up\?returnTo=/);
  await expect(page.locator("main.buyer-v2 h1")).toBeFocused();

  await keyboardType(page, page.getByLabel("Name"), "Keyboard Checkout Buyer");
  await keyboardType(page, page.getByLabel("Email"), email);
  await keyboardType(page, page.getByLabel("Password"), "keyboard-checkout-password");
  const createAccount = page.getByRole("button", { name: "Create account" });
  await keyboardTabTo(page, createAccount);
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(PUBLIC_PRODUCT)}$`));
  await expect(productHeading).toBeFocused();
  const authenticatedCta = page.getByRole("button", { name: "Get access" });
  await keyboardTabTo(page, authenticatedCta);
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/checkout\//);
  const checkoutHeading = page.getByRole("heading", { level: 1, name: "Confirm this Product." });
  await expect(checkoutHeading).toBeFocused();
  await expectNoSeriousAccessibilityViolations(page);
  const confirmation = page.getByLabel("Add this Product to my account.");
  await keyboardTabTo(page, confirmation);
  await page.keyboard.press("Space");
  await expect(confirmation).toBeChecked();
  const confirmOrder = page.getByRole("button", { name: "Add to my account" });
  await expect(confirmOrder).toHaveAttribute("aria-busy", "false");
  await keyboardTabTo(page, confirmOrder);
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/explore\/orders\/[^/]+\/success$/);
  const successHeading = page.getByRole("heading", { level: 1, name: "Signal Resume Review is ready." });
  await expect(successHeading).toBeFocused();
  await expect(page.getByText(/Free · Access granted/)).toBeVisible();
  await expect(page.getByText(/Desktop/)).toHaveCount(0);
  await expectNoSeriousAccessibilityViolations(page);
});

test("R21 Creator Orders uses a real cursor to load all 13 filtered orders", async ({ page }) => {
  await signIn(page, "creator", "/studio/orders");
  await page.getByLabel("Product ID").fill(PAGINATION_PRODUCT_ID);
  const firstPage = page.waitForResponse((response) => response.url().includes("/v1/creator/orders?") && response.url().includes(`product=${PAGINATION_PRODUCT_ID}`) && response.url().includes("limit=12"));
  await page.getByLabel("Rows per page").selectOption("12");
  expect((await firstPage).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("Loaded 12 orders; more are available.");
  await expect(page.getByRole("listitem")).toHaveCount(12);

  const secondPage = page.waitForResponse((response) => response.url().includes("/v1/creator/orders?") && response.url().includes("cursor="));
  await page.getByRole("button", { name: "Load next page" }).click();
  const secondPagePayload = await (await secondPage).json();
  expect(secondPagePayload.next_cursor).toBeNull();
  await expect(page.getByRole("status")).toHaveText("Loaded 13 orders; end of results.");
  await expect(page.getByRole("listitem")).toHaveCount(13);
  const orderReferences = await page.locator(".cpv2-order .cpv2-kicker").allTextContents();
  expect(new Set(orderReferences).size).toBe(13);
  await expect(page.getByRole("button", { name: "Load next page" })).toHaveCount(0);
});

async function createBuyerFromProduct(page, email, displayName) {
  await page.goto(`/sign-up?returnTo=${encodeURIComponent(PUBLIC_PRODUCT)}`);
  await page.getByLabel("Name").fill(displayName);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("browser-e2e-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(PUBLIC_PRODUCT)}$`));
}

async function keyboardType(page, target, value) {
  await keyboardTabTo(page, target);
  await page.keyboard.type(value);
  await expect(target).toHaveValue(value);
}



async function resetBaseRelease(request) {
  return e2eControl(request, "/__e2e/release", {
    method: "POST",
    data: {
      product_id: PUBLIC_PRODUCT_ID,
      corpus_digest: `sha256:${"a".repeat(64)}`
    }
  });
}


async function createBuyerSnapshotOrder(request, productId) {
  const checkoutPayload = await apiJson(await request.post("/v1/checkout-sessions", {
    headers: { ...bearer(BUYER_TOKEN), "idempotency-key": `snapshot-checkout-${productId}` },
    data: { product_id: productId }
  }));
  const checkoutId = checkoutPayload.checkout_session.checkout_session_id;
  const confirmed = await apiJson(await request.post(`/v1/checkout-sessions/${checkoutId}/confirm`, {
    headers: { ...bearer(BUYER_TOKEN), "idempotency-key": `snapshot-confirm-${productId}` },
    data: {}
  }));
  expect(confirmed.payment.status).toBe("not_required");
  const [orderPayload, entitlementPayload] = await Promise.all([
    buyerOrder(request, confirmed.order_id),
    buyerEntitlement(request, confirmed.entitlement_id)
  ]);
  return { order: orderPayload.order, entitlement: entitlementPayload.entitlement };
}

function buyerOrder(request, orderId) {
  return request.get(`/v1/user/orders/${orderId}`, { headers: bearer(BUYER_TOKEN) }).then(apiJson);
}

function buyerEntitlement(request, entitlementId) {
  return request.get(`/v1/user/entitlements/${entitlementId}`, { headers: bearer(BUYER_TOKEN) }).then(apiJson);
}

async function browserJson(page, pathname) {
  return page.evaluate(async (path) => {
    const response = await fetch(path, { credentials: "same-origin" });
    const payload = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(payload));
    return payload;
  }, pathname);
}

async function apiJson(response) {
  const payload = await response.json();
  expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
  return payload;
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function uniqueEmail(label, testInfo) {
  return `${label}-${testInfo.project.name}-${testInfo.retry}-${Date.now()}@example.test`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
