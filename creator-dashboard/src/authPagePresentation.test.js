import assert from "node:assert/strict";
import test from "node:test";
import { createAuthPagePresentation } from "./authPagePresentation.js";
import { buyerT } from "./buyerI18n.js";

const presentation = (locale, options) => createAuthPagePresentation((key) => buyerT(locale, key))(options);

test("Hatch sign-in and sign-up use plain product titles in every locale", () => {
  const titles = {
    en: ["Sign in", "Create account"],
    zh: ["登录", "创建账户"],
    ja: ["ログイン", "アカウントを作成"]
  };
  for (const locale of ["en", "zh", "ja"]) {
    const signIn = presentation(locale, { signingUp: false, productIntent: false });
    const signUp = presentation(locale, { signingUp: true, productIntent: false });
    assert.deepEqual([signIn.title, signUp.title], titles[locale]);
    assert.ok(signIn.description && signUp.description && signIn.description !== signUp.description);
    for (const copy of [signIn, signUp]) {
      for (const value of Object.values(copy)) assert.doesNotMatch(value, /[!！?？]/, `${locale}: ${value}`);
    }
  }
});

test("product return path keeps product-specific descriptions", () => {
  for (const locale of ["en", "zh", "ja"]) {
    const signIn = presentation(locale, { signingUp: false, productIntent: true });
    const signUp = presentation(locale, { signingUp: true, productIntent: true });
    assert.notEqual(signIn.action, signUp.action);
    assert.notEqual(signIn.description, signUp.description);
    assert.equal(signIn.description, buyerT(locale, "Sign in to continue to this Agent."));
  }
});
