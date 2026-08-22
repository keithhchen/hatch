import assert from "node:assert/strict";
import test from "node:test";
import { CREATOR_NODE_TIP_NODES, getCreatorNodeTips } from "./creatorNodeTips.js";

test("each Creator node has a 30-line clue bank", () => {
  for (const node of CREATOR_NODE_TIP_NODES) {
    assert.equal(getCreatorNodeTips("zh", node).length, 30, `${node} zh`);
    assert.equal(getCreatorNodeTips("en", node).length, 30, `${node} en`);
    assert.equal(getCreatorNodeTips("ja", node).length, 30, `${node} ja`);
  }
});

test("Japanese clue copy is not an English fallback", () => {
  assert.notEqual(getCreatorNodeTips("ja", "corpus")[0], getCreatorNodeTips("en", "corpus")[0]);
});
