import assert from "node:assert/strict";
import test from "node:test";
import { CREATOR_NODE_TIP_NODES, getCreatorNodeCopy, getCreatorNodeTips } from "./creatorNodeTips.js";

test("each Creator node has a 30-line clue bank", () => {
  for (const node of CREATOR_NODE_TIP_NODES) {
    assert.equal(getCreatorNodeTips("zh", node).length, 30, `${node} zh`);
    assert.equal(getCreatorNodeTips("en", node).length, 30, `${node} en`);
  }
});

test("unsupported locales keep the English companion copy", () => {
  assert.equal(getCreatorNodeTips("ja", "corpus").length, 30);
  assert.equal(getCreatorNodeCopy("ja", "corpus").headline, getCreatorNodeCopy("en", "corpus").headline);
});
