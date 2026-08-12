import { expect, test } from "@playwright/test";
import {
  e2eControl,
  expectNoSeriousAccessibilityViolations,
  keyboardTabTo,
  signIn
} from "./helpers.js";

const PUBLIC_PRODUCT = "/creators/creator-e2e/signal-resume-review";
const CREATOR_TOKEN = "creator-e2e-token";
const BUYER_TOKEN = "buyer-e2e-token";

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-1280", "Stateful Commerce journeys run once; responsive behavior has its own project matrix.");
});

test("R02 sign-up preserves the product intent and returns to the selected offer", async ({ page }, testInfo) => {
  await page.goto(PUBLIC_PRODUCT);
  await page.getByRole("link", { name: "Get for free" }).click();
  await expect(page).toHaveURL(/\/sign-in\?returnTo=/);
  await expect(page.getByText("Signal Resume Review").first()).toBeVisible();
  await expect(page.getByText("Free", { exact: true }).first()).toBeVisible();

  await page.getByRole("link", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/sign-up\?returnTo=/);
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe(PUBLIC_PRODUCT);
  await page.getByLabel("Name").fill("Signup Return Buyer");
  await page.getByLabel("Email").fill(uniqueEmail("signup-return", testInfo));
  await page.getByLabel("Password").fill("signup-return-password");
  await page.getByLabel("I agree to the Hatch Terms and Privacy Policy.").check();
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(PUBLIC_PRODUCT)}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Signal Resume Review" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Get for free" })).toBeEnabled();
});

test("R03 duplicate submit plus a lost response retries to one free order and entitlement", async ({ page, request }, testInfo) => {
  const email = uniqueEmail("duplicate-retry", testInfo);
  await createBuyerFromProduct(page, email, "Duplicate Retry Buyer");
  const profile = await browserJson(page, "/v1/auth/me");

  await page.getByRole("button", { name: "Get for free" }).click();
  await expect(page).toHaveURL(/\/checkout\//);
  await page.getByLabel("I confirm this offer and its refund terms.").check();

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
  await expect(page).toHaveURL(/\/orders\/[^/]+\/success$/);
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

test("R04 changed offer shows the old/new quote, has zero Commerce side effects, then requires a fresh confirmation", async ({ page, request }, testInfo) => {
  await resetBaseOffer(request, 1);
  const email = uniqueEmail("offer-change", testInfo);
  try {
    await createBuyerFromProduct(page, email, "Offer Change Buyer");
    const profile = await browserJson(page, "/v1/auth/me");
    await page.getByRole("button", { name: "Get for free" }).click();
    await expect(page).toHaveURL(/\/checkout\//);

    await e2eControl(request, "/__e2e/offer", {
      method: "POST",
      data: {
        product_id: "signal-resume-review",
        offer: { revision: 2, amount_minor: 4900, currency: "USD" }
      }
    });
    await page.getByLabel("I confirm this offer and its refund terms.").check();
    const changedResponse = page.waitForResponse((response) => response.url().endsWith("/confirm") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Add to my account" }).click();
    expect((await changedResponse).status()).toBe(409);

    await expect(page.getByText("This checkout is no longer current.")).toBeVisible();
    await expect(page.getByRole("definition").filter({ hasText: "Free" })).toBeVisible();
    await expect(page.getByRole("definition").filter({ hasText: "$49.00" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add to my account" })).toBeDisabled();
    const noSideEffects = await e2eControl(request, `/__e2e/commerce?buyer_id=${encodeURIComponent(profile.id)}`);
    expect(noSideEffects.events).toEqual([]);
    expect(noSideEffects.access).toEqual([]);

    await resetBaseOffer(request, 3);
    await page.getByRole("link", { name: "Back to product" }).click();
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(PUBLIC_PRODUCT)}$`));
    await page.getByRole("button", { name: "Get for free" }).click();
    await page.getByLabel("I confirm this offer and its refund terms.").check();
    await page.getByRole("button", { name: "Add to my account" }).click();
    await expect(page).toHaveURL(/\/orders\/[^/]+\/success$/);

    const afterFreshConfirmation = await e2eControl(request, `/__e2e/commerce?buyer_id=${encodeURIComponent(profile.id)}`);
    expect(afterFreshConfirmation.events.filter((event) => event.event_type === "order.placed")).toHaveLength(1);
    expect(afterFreshConfirmation.events.filter((event) => event.event_type === "entitlement.granted")).toHaveLength(1);
  } finally {
    await resetBaseOffer(request, 1);
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

  const anonymousCta = page.getByRole("link", { name: "Get for free" });
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
  const terms = page.getByLabel("I agree to the Hatch Terms and Privacy Policy.");
  await keyboardTabTo(page, terms);
  await page.keyboard.press("Space");
  await expect(terms).toBeChecked();
  const createAccount = page.getByRole("button", { name: "Create account" });
  await keyboardTabTo(page, createAccount);
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(PUBLIC_PRODUCT)}$`));
  await expect(productHeading).toBeFocused();
  const authenticatedCta = page.getByRole("button", { name: "Get for free" });
  await keyboardTabTo(page, authenticatedCta);
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/checkout\//);
  const checkoutHeading = page.getByRole("heading", { level: 1, name: "Review the real offer." });
  await expect(checkoutHeading).toBeFocused();
  await expectNoSeriousAccessibilityViolations(page);
  const confirmation = page.getByLabel("I confirm this offer and its refund terms.");
  await keyboardTabTo(page, confirmation);
  await page.keyboard.press("Space");
  await expect(confirmation).toBeChecked();
  const confirmOrder = page.getByRole("button", { name: "Add to my account" });
  await expect(confirmOrder).toHaveAttribute("aria-busy", "false");
  await keyboardTabTo(page, confirmOrder);
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/orders\/[^/]+\/success$/);
  const successHeading = page.getByRole("heading", { level: 1, name: "Signal Resume Review is ready." });
  await expect(successHeading).toBeFocused();
  await expect(page.getByText("Access granted", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Hatch Desktop" })).toHaveAttribute("href", /^hatch:\/\//);
  await expectNoSeriousAccessibilityViolations(page);
});

test("R13 Factory autosave survives refresh and a failed flush blocks in-app navigation", async ({ page }) => {
  await signIn(page, "creator", "/studio/products/new/factory");
  const taskName = `Refresh-safe Browser Draft ${Date.now()}`;
  await page.getByLabel("Task name").fill(taskName);
  await page.getByLabel("Task promise").fill("Save this task on the server before navigation.");
  await page.getByLabel("Source title").fill("Browser acceptance source");
  await page.getByLabel("Source content").fill("Private source text used only to prove server autosave recovery.");
  await page.getByLabel("Source content").blur();
  await expect(page.getByText(/^Saved /)).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Task name")).toHaveValue(taskName);
  await expect(page.getByLabel("Task promise")).toHaveValue("Save this task on the server before navigation.");
  await expect(page.getByLabel("Source content")).toHaveValue("Private source text used only to prove server autosave recovery.");

  let failedWrites = 0;
  await page.route("**/v1/creator/factory-drafts/default", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    failedWrites += 1;
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "autosave_unavailable", message: "Injected autosave outage." } })
    });
  });
  await page.getByLabel("Task name").fill(`${taskName} unsaved`);
  await page.getByRole("button", { name: "Products", exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/products\/new\/factory$/);
  await expect(page.getByRole("alert")).toContainText("kept you on this page");
  expect(failedWrites).toBeGreaterThan(0);

  await page.unroute("**/v1/creator/factory-drafts/default");
  await page.getByRole("button", { name: "Products", exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/products$/);
});

test("R14 two browser sessions reject a stale Factory draft instead of overwriting the newer server version", async ({ browser }) => {
  const firstContext = await browser.newContext();
  const staleContext = await browser.newContext();
  const firstPage = await firstContext.newPage();
  const stalePage = await staleContext.newPage();
  const firstValue = `First browser wins ${Date.now()}`;
  const staleValue = `Stale browser must not overwrite ${Date.now()}`;
  try {
    await Promise.all([
      signIn(firstPage, "creator", "/studio/products/new/factory"),
      signIn(stalePage, "creator", "/studio/products/new/factory")
    ]);
    await expect(firstPage.getByLabel("Task name")).toBeVisible();
    await expect(stalePage.getByLabel("Task name")).toBeVisible();

    await firstPage.getByLabel("Task name").fill(firstValue);
    await firstPage.getByLabel("Task name").blur();
    await expect(firstPage.getByText(/^Saved /)).toBeVisible();

    await stalePage.getByLabel("Task name").fill(staleValue);
    await stalePage.getByLabel("Task name").blur();
    await expect(stalePage.getByText("Couldn't save")).toBeVisible();
    await expect(stalePage.getByRole("alert")).toContainText("changed in another tab");

    await firstPage.reload();
    await expect(firstPage.getByLabel("Task name")).toHaveValue(firstValue);
    await expect(firstPage.getByLabel("Task name")).not.toHaveValue(staleValue);
  } finally {
    await Promise.all([firstContext.close(), staleContext.close()]);
  }
});

test("R15 a replacement Factory question batch quarantines old answers and exposes explicit recovery", async ({ page, context, request }) => {
  const runId = "factory_question_replacement";
  const oldAnswer = "Prioritize the signed customer interview and preserve its exact scope.";
  const newAnswer = "Use the verified delivery log and exclude the superseded interview draft.";
  const route = `/studio/factory/${runId}`;
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await e2eControl(request, "/__e2e/factory-question-batch", {
    method: "POST",
    data: {
      run_id: runId,
      version: 1,
      question_batch_id: "browser-question-batch-1",
      questions: [{
        id: "old-reference-answer",
        question: "What evidence should the first draft prioritize?"
      }],
      reset_submissions: true
    }
  });

  await signIn(page, "creator", route);
  const oldQuestion = page.getByRole("textbox", { name: /What evidence should the first draft prioritize/ });
  await expect(oldQuestion).toBeVisible();
  await oldQuestion.fill(oldAnswer);
  const stableUrl = page.url();

  await e2eControl(request, "/__e2e/factory-question-batch", {
    method: "POST",
    data: {
      run_id: runId,
      version: 2,
      question_batch_id: "browser-question-batch-2",
      questions: [{
        id: "new-reference-answer",
        question: "Which evidence is authoritative after the source revision?"
      }]
    }
  });

  const recovery = page.getByRole("complementary", { name: "The question batch changed" });
  await expect(recovery).toBeVisible({ timeout: 9_000 });
  expect(page.url()).toBe(stableUrl);
  const currentAnswer = page.getByRole("textbox", { name: /Which evidence is authoritative after the source revision/ });
  await expect(currentAnswer).toHaveValue("");
  await expect(page.getByRole("button", { name: "Submit all answers" })).toBeDisabled();
  await expect(recovery.getByLabel("Earlier answer 1")).toHaveValue(oldAnswer);
  await expect(recovery.getByLabel("Earlier answer 1")).toHaveAttribute("readonly", "");

  const beforeSubmit = await e2eControl(request, `/__e2e/factory-answer-submissions?run_id=${encodeURIComponent(runId)}`);
  expect(beforeSubmit.submissions).toEqual([]);
  await recovery.getByRole("button", { name: "Copy answer" }).click();
  await expect(recovery.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(oldAnswer);

  await currentAnswer.fill(newAnswer);
  const answerResponse = page.waitForResponse((response) => response.url().endsWith(`/v1/creator/factory-runs/${runId}/answers`) && response.request().method() === "PUT");
  await page.getByRole("button", { name: "Submit all answers" }).click();
  expect((await answerResponse).status()).toBe(202);
  await expect(page.getByRole("heading", { level: 3, name: "Hatch is advancing the graph" })).toBeVisible();

  const afterSubmit = await e2eControl(request, `/__e2e/factory-answer-submissions?run_id=${encodeURIComponent(runId)}`);
  expect(afterSubmit.submissions).toEqual([{
    run_id: runId,
    expected_version: 2,
    submission_id: expect.any(String),
    question_batch_id: "browser-question-batch-2",
    answers: [{ question_id: "new-reference-answer", answer: newAnswer }]
  }]);
  expect(JSON.stringify(afterSubmit.submissions)).not.toContain(oldAnswer);
});

test("R16 a failed critical gate disables keyboard approval and the server rejects a forged approve", async ({ page, request }) => {
  const productId = "blocked-browser-product";
  const candidateId = "factory_blocked_browser";
  await signIn(page, "creator", `/studio/products/${productId}/candidates/${candidateId}`);
  await expect(page.getByRole("heading", { level: 2, name: "Critical gates block approval" })).toBeVisible();
  await expect(page.getByText("Blocked", { exact: true })).toBeVisible();
  const approve = page.getByRole("button", { name: "Approve candidate" });
  await expect(approve).toBeDisabled();
  await approve.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/candidates/${candidateId}$`));

  const product = await apiJson(await request.get(`/v1/creator/products/${productId}`, {
    headers: bearer(CREATOR_TOKEN)
  }));
  const forged = await request.post(`/v1/creator/products/${productId}/candidates/${candidateId}/approve`, {
    headers: { ...bearer(CREATOR_TOKEN), "idempotency-key": `blocked-approve-${Date.now()}` },
    data: {
      expected_version: product.product.resource_version,
      report_digest: "sha256:forged",
      acknowledgements: []
    }
  });
  expect(forged.status()).toBe(409);
  expect((await forged.json()).error.code).toBe("candidate_incomplete");
});

test("R19/R20/R30 keyboard Creator flow publishes two immutable releases, shares, survives Registry rollback failure, and preserves purchase snapshots", async ({ page, context, request }, testInfo) => {
  const productId = `browser-flow-product-r${testInfo.retry}`;
  const candidateV1 = `factory_${productId.replaceAll("-", "_")}_v1`;
  const candidateV2 = `factory_${productId.replaceAll("-", "_")}_v2`;
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await signIn(page, "creator", "/studio/products/new/factory");
  await page.getByLabel("Task name").fill(productId);
  await page.getByLabel("Task promise").fill("Turn an approved method into a shareable, immutable delivery.");
  await page.getByLabel("Source title").fill("Reviewed Creator method");
  await page.getByLabel("Source content").fill("Use only evidence the Creator explicitly supplied and preserve Buyer privacy.");
  const startDistillation = page.getByRole("button", { name: "Start distillation" });
  await startDistillation.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/studio/factory/${candidateV1}$`));
  const reviewCandidate = page.getByRole("button", { name: "Review candidate" });
  await reviewCandidate.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/studio/products/${productId}/candidates/${candidateV1}$`));
  await keyboardApproveCandidate(page, true);
  await keyboardSaveFreeOfferAndPublish(page, productId);
  const shareLink = page.getByLabel("Share link");
  await expect(shareLink).toHaveValue(`/creators/creator-e2e/${productId}`);
  const copyLink = page.getByRole("button", { name: "Copy link" });
  await copyLink.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`/creators/creator-e2e/${productId}`);

  const firstProduct = (await creatorProduct(request, productId)).product;
  expect(firstProduct.releases).toHaveLength(1);
  const firstRelease = firstProduct.release;
  const buyerSnapshot = await createBuyerSnapshotOrder(request, productId, firstProduct.offer_active.offer_id);
  expect(buyerSnapshot.order.release_id).toBe(firstRelease.release_id);
  expect(buyerSnapshot.entitlement.purchased_corpus_digest).toBe(firstRelease.corpus_digest);

  await page.goto(`/studio/products/${productId}/candidates/${candidateV2}`);
  await keyboardApproveCandidate(page, false);
  await keyboardSaveFreeOfferAndPublish(page, productId);
  const secondProduct = (await creatorProduct(request, productId)).product;
  expect(secondProduct.releases).toHaveLength(2);
  expect(secondProduct.release.release_id).not.toBe(firstRelease.release_id);
  expect(secondProduct.releases.map((release) => release.corpus_digest)).toEqual([
    firstRelease.corpus_digest,
    secondProduct.release.corpus_digest
  ]);

  const missingReason = await request.post(`/v1/creator/products/${productId}/releases/${firstRelease.release_id}/rollback`, {
    headers: { ...bearer(CREATOR_TOKEN), "idempotency-key": `rollback-no-reason-${Date.now()}` },
    data: {
      expected_version: secondProduct.resource_version,
      offer_revision: firstRelease.offer_revision,
      reason: ""
    }
  });
  expect(missingReason.status()).toBe(422);
  expect((await missingReason.json()).error.code).toBe("audit_reason_required");

  await page.goto(`/studio/products/${productId}/releases/${firstRelease.release_id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Release" })).toBeVisible();
  await page.getByLabel("Offer revision").selectOption(String(firstRelease.offer_revision));
  await page.getByLabel("Audit reason").fill("Restore the first browser-verified behavior.");
  const reviewRollback = page.getByRole("button", { name: "Review rollback" });
  await reviewRollback.focus();
  await page.keyboard.press("Enter");
  await e2eControl(request, "/__e2e/fail-next-release-activation", { method: "POST" });
  const confirmRollback = page.getByRole("button", { name: "Confirm rollback" });
  await confirmRollback.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".cpv2-alert")).toContainText("Retry with the same request ID");
  await expect(page.locator(".cpv2-alert")).not.toContainText("Injected Registry activation outage");
  const failedState = await e2eControl(request, `/__e2e/product-state?product_id=${encodeURIComponent(productId)}`);
  expect(failedState.product.release.release_id).toBe(secondProduct.release.release_id);
  expect(failedState.product.status).toBe("rolling_back");

  await confirmRollback.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("Historical orders were not changed");

  const [rolledBackProductPayload, orderAfter, entitlementAfter, finalState] = await Promise.all([
    creatorProduct(request, productId),
    buyerOrder(request, buyerSnapshot.order.order_id),
    buyerEntitlement(request, buyerSnapshot.entitlement.entitlement_id),
    e2eControl(request, `/__e2e/product-state?product_id=${encodeURIComponent(productId)}`)
  ]);
  const rolledBackProduct = rolledBackProductPayload.product;
  expect(rolledBackProduct.release.release_id).toBe(firstRelease.release_id);
  expect(rolledBackProduct.releases).toHaveLength(2);
  expect(rolledBackProduct.releases.filter((release) => release.current)).toHaveLength(1);
  expect(orderAfter.order.release_id).toBe(buyerSnapshot.order.release_id);
  expect(orderAfter.order.offer_revision).toBe(buyerSnapshot.order.offer_revision);
  expect(entitlementAfter.entitlement.purchased_corpus_digest).toBe(buyerSnapshot.entitlement.purchased_corpus_digest);
  expect(finalState.last_release_activation).toMatchObject({
    product_id: productId,
    release_id: firstRelease.release_id,
    corpus_digest: firstRelease.corpus_digest
  });
  const rollbackAudit = finalState.product.audit_log.filter((entry) => ["release.rollback_started", "release.rolled_back"].includes(entry.action));
  expect(rollbackAudit.map((entry) => entry.action)).toEqual(["release.rollback_started", "release.rolled_back"]);
  expect(rollbackAudit.every((entry) => entry.actor_id === "creator-e2e" && entry.reason === "Restore the first browser-verified behavior.")).toBeTruthy();
});

test("R21 Creator Orders uses a real cursor to load all 13 filtered orders", async ({ page }) => {
  await signIn(page, "creator", "/studio/orders");
  await page.getByLabel("Product ID").fill("pagination-product");
  const firstPage = page.waitForResponse((response) => response.url().includes("/v1/creator/orders?") && response.url().includes("product=pagination-product") && response.url().includes("limit=12"));
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
  await page.getByLabel("I agree to the Hatch Terms and Privacy Policy.").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(PUBLIC_PRODUCT)}$`));
}

async function keyboardType(page, target, value) {
  await keyboardTabTo(page, target);
  await page.keyboard.type(value);
  await expect(target).toHaveValue(value);
}

async function keyboardApproveCandidate(page, acknowledgeLoss) {
  await expect(page.getByRole("heading", { level: 1, name: /Candidate v/ })).toBeFocused();
  if (acknowledgeLoss) {
    const acknowledgement = page.getByLabel("Minor stylistic compression");
    await acknowledgement.focus();
    await page.keyboard.press("Space");
    await expect(acknowledgement).toBeChecked();
  }
  const approve = page.getByRole("button", { name: "Approve candidate" });
  await expect(approve).toBeEnabled();
  await approve.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/offer$/);
}

async function keyboardSaveFreeOfferAndPublish(page, productId) {
  await expect(page.getByRole("heading", { level: 1, name: "Define one clear delivery unit." })).toBeFocused();
  const save = page.getByRole("button", { name: "Save and preview" });
  await save.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/studio/products/${escapeRegExp(productId)}/preview`));
  await expect(page.getByRole("heading", { level: 1, name: "See exactly what Buyers will see." })).toBeFocused();
  const publish = page.getByRole("button", { name: "Publish", exact: true });
  await expect(publish).toBeEnabled();
  await publish.focus();
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("button", { name: "Confirm publish" });
  await expect(confirm).toBeEnabled();
  await confirm.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Your product is live" })).toBeVisible();
  await expect(page.locator(".cpv2-published")).toHaveAttribute("aria-live", "polite");
}

async function resetBaseOffer(request, revision) {
  return e2eControl(request, "/__e2e/offer", {
    method: "POST",
    data: {
      product_id: "signal-resume-review",
      offer: { revision, amount_minor: 0, currency: "USD" }
    }
  });
}

async function creatorProduct(request, productId) {
  return apiJson(await request.get(`/v1/creator/products/${productId}`, { headers: bearer(CREATOR_TOKEN) }));
}

async function createBuyerSnapshotOrder(request, productId, offerId) {
  const checkoutPayload = await apiJson(await request.post("/v1/checkout-sessions", {
    headers: { ...bearer(BUYER_TOKEN), "idempotency-key": `snapshot-checkout-${productId}` },
    data: { product_id: productId, offer_id: offerId }
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
