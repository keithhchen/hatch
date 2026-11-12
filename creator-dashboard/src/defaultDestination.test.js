import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { retiredPortalRedirect } from "../server.mjs";

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const main = read("main.jsx");
const buyer = read("BuyerPortalV2.jsx");

test("Studio and chat sign-out land on /studio", () => {
  assert.match(main, /signOutFromChat[\s\S]*?await signOut\(\);\s*location\.navigate\("\/studio", \{ replace: true \}\)/);
  assert.match(main, /onLogout=\{async \(\) => \{\s*await signOut\(\);\s*location\.navigate\("\/studio", \{ replace: true \}\)/);
});

test("buyer sign-out stays on /explore", () => {
  const matches = buyer.match(/await session\.signOut\(\);\s*navigateTo\(navigate, EXPLORE_ROOT, \{ replace: true \}\)/g) || [];
  assert.equal(matches.length, 2);
});

test("sign-in default, safeReturnTo fallback and product fallback are /studio", () => {
  assert.match(buyer, /const STUDIO_ROOT = "\/studio"/);
  assert.match(buyer, /safeReturnTo\(params\.get\("returnTo"\) \|\| STUDIO_ROOT\)/);
  const safeReturnTo = buyer.slice(buyer.indexOf("function safeReturnTo"), buyer.indexOf("function creatorName"));
  assert.equal((safeReturnTo.match(/return STUDIO_ROOT/g) || []).length, 2);
  assert.doesNotMatch(safeReturnTo, /EXPLORE_ROOT/);
  assert.match(buyer, /\/products\/\$\{encodeURIComponent\(product\)\}` : STUDIO_ROOT/);
});

test("retired /home and /library go to /studio; /orders stays under /explore", () => {
  for (const path of ["/home", "/library", "/library/ent-1"]) assert.equal(retiredPortalRedirect(path), "/studio");
  assert.equal(retiredPortalRedirect("/orders/HAT-1"), "/explore/orders/HAT-1");
});

test("every brand logo links to /", () => {
  assert.match(buyer, /className=\{?"?buyer-v2__brand"?[^>]*to="\/"/);
  assert.match(buyer, /className=\{authBrandClassName\} to="\/"/);
  assert.match(read("WebChatPage.jsx"), /<WebBrand href="\/" className="web-chat__brand"/);
  assert.match(read("DevelopersPage.jsx"), /<WebBrand className="developers-page__brand" href="\/"/);
  assert.match(read("DownloadPage.jsx"), /<WebBrand className="download-page__brand" href="\/"/);
  assert.match(read("webChatGate.jsx"), /<WebBrand href="\/" \/>/);
});

test("non-logo home links go to /studio", () => {
  assert.match(read("CreatorPortalV2.jsx"), /className="sx-back" href="\/"[^\n]*go\("\/"\)/);
  assert.match(read("DownloadPage.jsx"), /className="download-page__web" href="\/studio"/);
  assert.equal((read("WebChatPage.jsx").match(/href="\/studio"/g) || []).length, 2);
});
