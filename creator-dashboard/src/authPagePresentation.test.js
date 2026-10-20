import assert from "node:assert/strict";
import test from "node:test";
import { createAuthPagePresentation } from "./authPagePresentation.js";
import { buyerT } from "./buyerI18n.js";

const presentation = (locale, options) => createAuthPagePresentation((key) => buyerT(locale, key))(options);

test("Hatch sign-in and signup share the expert product promise in every locale", () => {
  const titles = {
    en: "Real experts, on call.",
    zh: "真正的专家，随时在线。",
    ja: "本物の専門家に、いつでも。"
  };
  const descriptions = {
    en: "Ask the Agents they built about your own situation, any time.",
    zh: "随时向他们打造的 Agent 说说你的情况。",
    ja: "専門家が作った Agent に、いつでも自分の状況を相談できます。"
  };
  for (const locale of ["en", "zh", "ja"]) {
    const signIn = presentation(locale, { signingUp: false, studioIntent: false, productIntent: false });
    const signUp = presentation(locale, { signingUp: true, studioIntent: false, productIntent: false });
    assert.equal(signIn.heroTitle, titles[locale]);
    assert.equal(signUp.heroTitle, titles[locale]);
    assert.equal(signIn.heroDescription, descriptions[locale]);
    assert.equal(signUp.heroDescription, descriptions[locale]);
    assert.ok(signIn.pill && signUp.pill && signIn.pill !== signUp.pill);
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
