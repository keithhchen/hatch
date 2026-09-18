import assert from "node:assert/strict";
import test from "node:test";
import { createAskUserTool } from "./factoryTools.js";

test("askuser normalizes one question batch and ends the current turn", async () => {
  const tool = createAskUserTool();
  const response = await tool.execute("call-1", {
    questions: [
      {
        question: "Who is this for?",
        options: ["Creators", { id: "consumer", label: "Consumers", description: "People buying the finished service" }],
      },
      { id: "channel", question: "Which channel matters first?", options: [], multiSelect: true },
    ],
  });
  assert.equal(response.terminate, true);
  assert.equal(response.details.type, "askuser");
  assert.deepEqual(response.details.questions, [
    {
      id: "question-1",
      question: "Who is this for?",
      options: [
        { id: "option-1", label: "Creators" },
        { id: "consumer", label: "Consumers", description: "People buying the finished service" },
      ],
      multiSelect: false,
      required: true,
    },
    { id: "channel", question: "Which channel matters first?", options: [], multiSelect: true, required: true },
  ]);
});

test("askuser rejects duplicate question ids", async () => {
  const tool = createAskUserTool();
  await assert.rejects(
    tool.execute("call-2", { questions: [
      { id: "same", question: "One", options: [] },
      { id: "same", question: "Two", options: [] },
    ] }),
    /question ids must be unique/
  );
});
