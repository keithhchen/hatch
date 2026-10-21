import assert from "node:assert/strict";
import test from "node:test";
import { readinessChecklist, READINESS_CHECKS } from "./studioAgentReadiness.js";
import { createCreatorTranslator, CREATOR_LOCALES } from "./creatorI18n.js";

test("readiness maps the server checks and keeps unknown blockers raw", () => {
  const list = readinessChecklist({
    candidate_approved: false, no_critical_failures: false, public_copy_complete: true, ownership_valid: true,
    materialization_ready: false, product_identity_valid: true,
    blockers: ["candidate approval is stale", "critical candidate gates are incomplete", "Registry materialization is not ready", "new server rule"],
    ready: false
  });
  assert.deepEqual(list.items.filter((item) => !item.ready).map((item) => item.key), ["candidate_approved", "no_critical_failures", "materialization_ready"]);
  assert.deepEqual(list.unknownBlockers, ["new server rule"]);
  assert.equal(list.blocking, 4);
  assert.equal(list.ready, false);
  assert.equal(readinessChecklist(undefined), null);
});

test("every readiness check is localized", () => {
  for (const locale of CREATOR_LOCALES) {
    const t = createCreatorTranslator(locale);
    for (const { key } of READINESS_CHECKS) for (const prefix of ["sxCheck_", "sxCheckOk_", "sxCheckFix_"]) assert.notEqual(t(prefix + key), prefix + key, `${locale}.${prefix}${key}`);
  }
});
