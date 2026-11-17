import assert from "node:assert/strict";
import test from "node:test";
import { createGuestTokens } from "../guest.mjs";

// The same vector is asserted by the Runtime's GuestTokens (runtime-server/src/guestToken.ts): both sides must sign identically.
const SECRET = "test-secret";
const ID = "AAAAAAAAAAAAAAAAAAAAAA";
const VECTOR = "hatch_guest.AAAAAAAAAAAAAAAAAAAAAA.11uyaf4c9WCb8v4Y3ku-QqEl5bHz1TY1ABhDPbYoLxI";

test("guest tokens match the Runtime's signing vector", () => {
  const tokens = createGuestTokens(SECRET);
  assert.equal(tokens.issue(ID), VECTOR);
  assert.equal(tokens.verify(VECTOR), true);
});

test("a minted guest token verifies; tampered, foreign-secret or malformed tokens do not", () => {
  const tokens = createGuestTokens(SECRET);
  const minted = tokens.mint();
  assert.equal(tokens.verify(minted), true);
  assert.notEqual(minted, tokens.mint());
  assert.equal(tokens.verify(`${minted}x`), false);
  assert.equal(tokens.verify(minted.replace(/\.[^.]+\./, ".BBBBBBBBBBBBBBBBBBBBBB.")), false);
  assert.equal(createGuestTokens("other").verify(minted), false);
  for (const bad of [undefined, "", "hatch_guest.", "hatch_guest.short.sig", "Bearer x", `${VECTOR}.extra`]) assert.equal(tokens.verify(bad), false);
  assert.throws(() => createGuestTokens(""), /signing secret/);
});
