import assert from "node:assert/strict";
import test from "node:test";
import { createAuthPagePresentation } from "./authPagePresentation.js";
import { buyerT } from "./buyerI18n.js";

const presentation = (locale, options) => createAuthPagePresentation((key) => buyerT(locale, key))(options);

test("Hatch sign-in and signup share the expert product promise in every locale", () => {
  const titles = {
    en: "Expert agents that deliver.",
    zh: "能够交付成果的专家 Agent。",
    ja: "成果を届ける専門家の Agent。"
  };
  const descriptions = {
    en: "View the expert products you subscribe to on Hatch.",
    zh: "查看你在 Hatch 平台上订阅的专家产品。",
    ja: "Hatch で購読している専門家の製品を確認できます。"
  };
  for (const locale of ["en", "zh", "ja"]) {
    const signIn = presentation(locale, { signingUp: false, studioIntent: false, productIntent: false });
    const signUp = presentation(locale, { signingUp: true, studioIntent: false, productIntent: false });
    assert.equal(signIn.heroTitle, titles[locale]);
    assert.equal(signUp.heroTitle, titles[locale]);
    assert.equal(signIn.heroDescription, descriptions[locale]);
    assert.equal(signUp.heroDescription, descriptions[locale]);
  }
});

test("Studio sign-in and signup share the Agent product promise and use Hatch Expert", () => {
  for (const locale of ["en", "zh", "ja"]) {
    const signIn = presentation(locale, { signingUp: false, studioIntent: true, productIntent: false });
    const signUp = presentation(locale, { signingUp: true, studioIntent: true, productIntent: false });
    assert.equal(signIn.heroTitle, signUp.heroTitle);
    assert.match(signUp.title, /Hatch Expert/);
    assert.match(signUp.action, /Hatch Expert/);
    assert.notEqual(signIn.title, signUp.title);
    assert.notEqual(signIn.description, signUp.description);
    assert.equal(signIn.heroTitle, buyerT(locale, "Turn your expertise into an Agent product."));
  }
});

test("product return path retains product-specific account actions", () => {
  for (const locale of ["en", "zh", "ja"]) {
    const signIn = presentation(locale, { signingUp: false, studioIntent: false, productIntent: true });
    const signUp = presentation(locale, { signingUp: true, studioIntent: false, productIntent: true });
    assert.notEqual(signIn.action, signUp.action);
    assert.notEqual(signIn.description, signUp.description);
    assert.equal(signIn.heroTitle, "");
  }
});
