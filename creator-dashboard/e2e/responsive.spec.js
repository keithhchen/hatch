import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, signIn } from "./helpers.js";

test("canonical public product is readable without auth at every acceptance viewport", async ({ page }, testInfo) => {
  const response = await page.goto("/agents/creator-e2e/signal-resume-review");
  expect(response).not.toBeNull();
  const canonicalUrl = `${new URL(page.url()).origin}/agents/creator-e2e/signal-resume-review`;
  const serverHtml = await response.text();
  expect(serverHtml).toContain("<title>Signal Resume Review by Maya Creator · Hatch</title>");
  expect(serverHtml).toContain(`<link rel="canonical" href="${canonicalUrl}" />`);
  expect(serverHtml).toContain('<meta name="description" content="Find the strongest credible signal without inventing evidence." />');
  expect(serverHtml).toContain('<meta property="og:title" content="Signal Resume Review by Maya Creator · Hatch" />');
  expect(serverHtml).toContain(`<meta property="og:url" content="${canonicalUrl}" />`);
  const unavailableUrl = `${new URL(page.url()).origin}/agents/creator-e2e/not-published`;
  const unavailableResponse = await page.request.get(unavailableUrl);
  expect(unavailableResponse.status()).toBe(404);
  const unavailableHtml = await unavailableResponse.text();
  expect(unavailableHtml).toContain("<title>Agent unavailable · Hatch</title>");
  expect(unavailableHtml).toContain(`<link rel="canonical" href="${unavailableUrl}" />`);
  await expect(page).toHaveTitle(/Signal Resume Review/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", canonicalUrl);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", "Find the strongest credible signal without inventing evidence.");
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "Signal Resume Review by Maya Creator · Hatch");
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", canonicalUrl);
  await expect(page.getByRole("heading", { level: 1, name: "Signal Resume Review" })).toBeVisible();
  await expect(page.getByText("By Maya Creator", { exact: true })).toBeVisible();
  await expect(page.getByText("Find the strongest credible signal without inventing evidence.", { exact: true })).toBeVisible();
  await expect(page.getByText("A resume and target role", { exact: true })).toBeVisible();
  await expect(page.getByText("Evidence-backed rewrite plan", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Get for free" })).toBeVisible();
  await expect(page.getByText("Does not invent employers, metrics, or outcomes.")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await expect(page).toHaveScreenshot(`public-product-${testInfo.project.name}.png`, {
    fullPage: true,
    animations: "disabled",
    caret: "hide",
    maxDiffPixelRatio: 0.03,
    threshold: 0.25
  });

  if (testInfo.project.name.startsWith("mobile-")) {
    const primaryAction = page.locator(".storefront-shared__offer").getByRole("link", { name: "Get for free" });
    await primaryAction.scrollIntoViewIfNeeded();
    const hitTest = await primaryAction.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(centerX, centerY);
      const blockers = [...document.querySelectorAll("body *")].filter((candidate) => {
        if (candidate === element || candidate.contains(element) || element.contains(candidate)) return false;
        const position = getComputedStyle(candidate).position;
        if (position !== "fixed" && position !== "sticky") return false;
        const candidateRect = candidate.getBoundingClientRect();
        return candidateRect.left < rect.right
          && candidateRect.right > rect.left
          && candidateRect.top < rect.bottom
          && candidateRect.bottom > rect.top;
      });
      return {
        width: rect.width,
        height: rect.height,
        insideViewport: rect.top >= 0 && rect.bottom <= window.innerHeight,
        hitTarget: hit?.closest("a,button") === element,
        blockers: blockers.map((candidate) => candidate.className || candidate.tagName)
      };
    });
    expect(hitTest.height).toBeGreaterThanOrEqual(44);
    expect(hitTest.width).toBeGreaterThanOrEqual(44);
    expect(hitTest.insideViewport).toBeTruthy();
    expect(hitTest.hitTarget, JSON.stringify(hitTest)).toBeTruthy();
    expect(hitTest.blockers).toEqual([]);
    await primaryAction.click();
    await expect(page).toHaveURL(/\/sign-in\?returnTo=/);
  }
});

test("authenticated mobile navigation keeps account controls reachable", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile-"), "Mobile account controls are covered at both acceptance widths.");
  await signIn(page, "buyer", "/portal/library");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
