import assert from "node:assert/strict";
import test from "node:test";
import { parseCorpusCompilation, parseEvaluation, parseQuestions } from "./creatorLearning/markdown.js";
import { createFactoryLlmPromptRunner } from "./creatorLearning/factoryLlm.js";
import type { FactoryPromptCall } from "./creatorLearning/types.js";

type SubmittedToolCall = {
  id: string;
  name: string;
  /** Pass a string to exercise malformed raw provider arguments. */
  arguments: Record<string, unknown> | string;
};

function sse(chunks: unknown[]): Response {
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function toolTurn(calls: SubmittedToolCall[]): Response {
  return toolTurnWithFinish(calls, "tool_calls");
}

function toolTurnWithFinish(calls: SubmittedToolCall[], finishReason: "tool_calls" | "length"): Response {
  return sse([
    {
      id: `chatcmpl-${calls[0]?.id ?? "tools"}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "kimi-k2.6",
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments)
            }
          }))
        },
        finish_reason: null
      }]
    },
    {
      id: `chatcmpl-${calls[0]?.id ?? "tools"}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "kimi-k2.6",
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
    }
  ]);
}

function textTurn(text = "done", finishReason: "stop" | "length" = "stop"): Response {
  return sse([
    {
      id: "chatcmpl-text",
      object: "chat.completion.chunk",
      created: 1,
      model: "kimi-k2.6",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }]
    },
    {
      id: "chatcmpl-text",
      object: "chat.completion.chunk",
      created: 1,
      model: "kimi-k2.6",
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
    }
  ]);
}

async function run(
  call: FactoryPromptCall,
  responses: Response[]
): Promise<{ output: string; requests: Array<Record<string, unknown>> }> {
  const requests: Array<Record<string, unknown>> = [];
  const runner = createFactoryLlmPromptRunner({
    apiKey: "submission-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected extra provider turn");
      return response;
    }
  });
  return { output: await runner(call), requests };
}

test("submission tools retain full-batch recovery, Unicode, idempotency, and terminate on accepted mixed finalize", async () => {
  const longUnicode = `直接发布：${"创业判断不是模板。".repeat(6_000)}`;
  assert.ok(Buffer.byteLength(longUnicode, "utf8") >= 128 * 1024, "fixture must exercise at least 128 KiB of Unicode body text");
  const { output, requests } = await run({
    purpose: "eval.generate_questions",
    systemPrompt: "question system",
    prompt: "full loose input",
    outputContract: { kind: "question_set", expectedCount: 2 }
  }, [
    toolTurn([
      {
        id: "q1-a",
        name: "submit_question",
        arguments: { id: "Q1", question: longUnicode, intent: "测取舍", leakage_group: "bootstrap-offer" }
      },
      {
        id: "q1-idempotent",
        name: "submit_question",
        arguments: { id: "Q1", question: longUnicode, intent: "测取舍", leakage_group: "bootstrap-offer" }
      },
      { id: "incomplete-finalize", name: "finalize_questions", arguments: {} }
    ]),
    toolTurn([
      {
        id: "replacement-q1",
        name: "submit_question",
        arguments: { id: "Q1", question: longUnicode, intent: "测取舍", leakage_group: "bootstrap-offer" }
      },
      {
        id: "q2",
        name: "submit_question",
        arguments: { id: "Q2", question: "给出可销售成品。", intent: "测成品", leakage_group: "sellable-output" }
      },
      { id: "questions-finalize", name: "finalize_questions", arguments: {} }
    ])
  ]);

  const questions = parseQuestions(output);
  assert.equal(questions.length, 2);
  assert.equal(questions[0]!.question, longUnicode);
  assert.equal(requests.length, 2, "an accepted mixed submit+finalize batch must end without another provider turn");
  const initialPayload = JSON.stringify(requests[0]);
  assert.match(initialPayload, /complete your private reasoning and the entire artifact/i);
  assert.match(initialPayload, /contract-specific finalization rule/i);
  assert.match(initialPayload, /do not wait for receipts between parts/i);

  const receiptTexts = ((requests[1]!.messages as Array<Record<string, unknown>>) ?? [])
    .filter((message) => message.role === "tool")
    .map((message) => String(message.content ?? ""));
  assert.ok(receiptTexts.some((value) => value.includes("STAGED status=IDEMPOTENT question; questions=1/2; next=finalize_questions")));
  assert.ok(receiptTexts.some((value) => value.includes("REJECTED code=QUESTION_COUNT_MISMATCH; draft cleared")));
  assert.ok(receiptTexts.every((value) => value.length < 320), "every receipt must stay short");
  assert.ok(receiptTexts.every((value) => !value.includes(longUnicode.slice(0, 50))), "receipt must not echo submitted body");
});

test("invalid finalize clears the draft and requires a complete replacement", async () => {
  const { output, requests } = await run({
    purpose: "eval.generate_questions",
    systemPrompt: "question system",
    prompt: "input",
    outputContract: { kind: "question_set", expectedCount: 2 }
  }, [
    toolTurn([
      {
        id: "first-only",
        name: "submit_question",
        arguments: { id: "Q1", question: "obsolete", intent: "old", leakage_group: "old" }
      },
      { id: "early-finalize", name: "finalize_questions", arguments: {} }
    ]),
    toolTurn([
      {
        id: "replacement-one",
        name: "submit_question",
        arguments: { id: "Q1", question: "replacement one", intent: "new", leakage_group: "new-one" }
      },
      {
        id: "replacement-two",
        name: "submit_question",
        arguments: { id: "Q2", question: "replacement two", intent: "new", leakage_group: "new-two" }
      },
      { id: "valid-finalize", name: "finalize_questions", arguments: {} }
    ])
  ]);

  assert.deepEqual(parseQuestions(output).map((item) => item.question), ["replacement one", "replacement two"]);
  assert.equal(requests.length, 2, "a rejected mixed finalizer must continue, while the accepted replacement must terminate");
  assert.match(JSON.stringify(requests[1]), /REJECTED code=QUESTION_COUNT_MISMATCH; draft cleared/);
});

test("question handoff preserves Markdown headings inside an authored question", async () => {
  const nestedHeading = [
    "Review this candidate packet:",
    "",
    "## Q99 — Candidate facts",
    "",
    "The candidate has five years of experience.",
    "",
    "## Draft answer",
    "",
    "Return one spoken rewrite."
  ].join("\n");
  const { output } = await run({
    purpose: "eval.generate_questions",
    systemPrompt: "question system",
    prompt: "input",
    outputContract: { kind: "question_set", expectedCount: 1 }
  }, [
    toolTurn([
      {
        id: "nested-heading-question",
        name: "submit_question",
        arguments: { id: "provider-made-id", question: nestedHeading, intent: "Tests the full packet.", leakage_group: "nested-heading" }
      },
      { id: "finalize", name: "finalize_questions", arguments: {} }
    ])
  ]);

  const [question] = parseQuestions(output);
  assert.equal(question?.id, "Q1", "the host owns the canonical handoff ID");
  assert.equal(question?.question, nestedHeading);
});

test("strict raw JSON gate rejects a malformed later call with zero batch mutation", async () => {
  const preservedEvidence = "  NEW COMPLETE EVIDENCE\n    indented code-like line\ntrailing spaces stay  ";
  const { output, requests } = await run({
    purpose: "evidence.extract",
    systemPrompt: "evidence system",
    prompt: "all source files",
    outputContract: { kind: "evidence_ledger", requiredSections: ["Product evidence", "Boundaries"] }
  }, [
    toolTurn([
      {
        id: "apparently-valid-first",
        name: "submit_evidence_section",
        arguments: { section: "Product evidence", markdown: "OLD MUST BE ROLLED BACK" }
      },
      {
        id: "truncated-second",
        name: "submit_evidence_section",
        arguments: "{\"section\":\"Boundaries\",\"markdown\":\"partial but salvageable\""
      },
      { id: "blocked-finalize", name: "finalize_evidence", arguments: {} }
    ]),
    toolTurn([
      {
        id: "clean-one",
        name: "submit_evidence_section",
        arguments: { section: "Product evidence", markdown: preservedEvidence }
      },
      {
        id: "clean-two",
        name: "submit_evidence_section",
        arguments: { section: "Boundaries", markdown: "NEW COMPLETE BOUNDARY" }
      },
      { id: "evidence-finalize", name: "finalize_evidence", arguments: {} }
    ])
  ]);

  assert.ok(output.includes(`## Product evidence\n\n${preservedEvidence}\n`), "long Markdown body must not be trimmed or normalized");
  assert.doesNotMatch(output, /OLD MUST BE ROLLED BACK/);
  assert.equal(requests.length, 2, "an error in a mixed batch must keep the repair turn available");
  const errorReceipts = ((requests[1]!.messages as Array<Record<string, unknown>>) ?? [])
    .filter((message) => message.role === "tool")
    .map((message) => String(message.content ?? ""));
  assert.ok(errorReceipts.some((value) => /BATCH_REJECTED code=(TOOL_ARGUMENT_INVALID|RAW_ARGUMENTS_INVALID_JSON)/.test(value)));
  assert.ok(errorReceipts.some((value) => value.includes("BATCH_REJECTED code=BATCH_PRIOR_TOOL_ERROR")));
  assert.ok(errorReceipts.every((value) => !value.includes("partial but salvageable")), "framework error receipt must not echo malformed args");
  assert.ok(errorReceipts.every((value) => value !== "FINALIZED" && !value.startsWith("FINALIZED;")));
});

test("Evidence accepts a complete submit turn followed by a finalize-only turn", async () => {
  const { output, requests } = await run({
    purpose: "evidence.extract",
    systemPrompt: "evidence system",
    prompt: "input",
    outputContract: { kind: "evidence_ledger", requiredSections: ["Product evidence", "Boundaries"] }
  }, [
    toolTurn([
      { id: "evidence-product", name: "submit_evidence_section", arguments: { section: "Product evidence", markdown: "Observed product evidence." } },
      { id: "evidence-boundaries", name: "submit_evidence_section", arguments: { section: "Boundaries", markdown: "Known boundary." } }
    ]),
    toolTurn([{ id: "evidence-finalize", name: "finalize_evidence", arguments: {} }])
  ]);

  assert.match(output, /## Product evidence\n\nObserved product evidence\./);
  assert.match(output, /## Boundaries\n\nKnown boundary\./);
  assert.equal(requests.length, 2, "a provider may split Evidence submission and finalization across turns");
  assert.match(JSON.stringify(requests[1]), /pending finalize/);
});

test("a length-terminated batch carrying complete-looking tool args never finalizes", async () => {
  let telemetry: Parameters<NonNullable<FactoryPromptCall["reportFailureTelemetry"]>>[0] | undefined;
  const runner = createFactoryLlmPromptRunner({
    apiKey: "submission-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    fetch: async () => toolTurnWithFinish([
      {
        id: "length-submit",
        name: "submit_evidence_section",
        arguments: { section: "Product evidence", markdown: "must not commit" }
      },
      { id: "length-finalize", name: "finalize_evidence", arguments: {} }
    ], "length")
  });
  await assert.rejects(
    () => runner({
      purpose: "evidence.extract",
      systemPrompt: "evidence system",
      prompt: "input",
      outputContract: { kind: "evidence_ledger", requiredSections: ["Product evidence"] },
      reportFailureTelemetry: (value) => { telemetry = value; }
    }),
    /did not complete: length/
  );
  assert.equal(telemetry?.code, "provider_incomplete");
});

test("the host enforces one finalizer in last position before any batch mutation", async () => {
  const { output, requests } = await run({
    purpose: "eval.generate_questions",
    systemPrompt: "question system",
    prompt: "input",
    outputContract: { kind: "question_set", expectedCount: 1 }
  }, [
    toolTurn([
      { id: "too-early-finalizer", name: "finalize_questions", arguments: {} },
      {
        id: "must-not-stage",
        name: "submit_question",
        arguments: { id: "Q1", question: "must roll back", intent: "test", leakage_group: "topology" }
      }
    ]),
    toolTurn([
      { id: "restart-first", name: "restart_submission", arguments: {} },
      {
        id: "valid-question",
        name: "submit_question",
        arguments: { id: "Q1", question: "valid replacement", intent: "test", leakage_group: "topology" }
      },
      { id: "last-finalizer", name: "finalize_questions", arguments: {} }
    ])
  ]);

  assert.equal(parseQuestions(output)[0]!.question, "valid replacement");
  const receipts = ((requests[1]!.messages as Array<Record<string, unknown>>) ?? [])
    .filter((message) => message.role === "tool")
    .map((message) => String(message.content ?? ""));
  assert.ok(receipts.every((value) => value.includes("BATCH_REJECTED code=BATCH_FINALIZER_MUST_BE_LAST")));
  assert.ok(receipts.every((value) => !value.startsWith("FINALIZED")));
});

test("duplicate finalizers reject the whole batch instead of racing transaction commit", async () => {
  const { output, requests } = await run({
    purpose: "eval.generate_questions",
    systemPrompt: "question system",
    prompt: "input",
    outputContract: { kind: "question_set", expectedCount: 1 }
  }, [
    toolTurn([
      {
        id: "question-before-duplicates",
        name: "submit_question",
        arguments: { id: "Q1", question: "discard", intent: "test", leakage_group: "duplicate-finalizer" }
      },
      { id: "duplicate-finalizer-one", name: "finalize_questions", arguments: {} },
      { id: "duplicate-finalizer-two", name: "finalize_questions", arguments: {} }
    ]),
    toolTurn([
      {
        id: "valid-question-after-duplicates",
        name: "submit_question",
        arguments: { id: "Q1", question: "kept", intent: "test", leakage_group: "duplicate-finalizer" }
      },
      { id: "single-finalizer", name: "finalize_questions", arguments: {} }
    ])
  ]);
  assert.equal(parseQuestions(output)[0]!.question, "kept");
  assert.match(JSON.stringify(requests[1]), /BATCH_FINALIZER_DUPLICATE/);
  assert.doesNotMatch(JSON.stringify(requests[1]), /FINALIZED; atomic batch accepted/);
});

test("a conflicting sibling rolls back the whole batch and never exposes a false FINALIZED receipt", async () => {
  const { output, requests } = await run({
    purpose: "eval.generate_questions",
    systemPrompt: "question system",
    prompt: "input",
    outputContract: { kind: "question_set", expectedCount: 1 }
  }, [
    toolTurn([
      {
        id: "original",
        name: "submit_question",
        arguments: { id: "Q1", question: "original", intent: "intent", leakage_group: "group" }
      },
      {
        id: "conflict",
        name: "submit_question",
        arguments: { id: "Q1", question: "conflicting", intent: "intent", leakage_group: "group" }
      },
      { id: "must-not-finalize", name: "finalize_questions", arguments: {} }
    ]),
    toolTurn([
      { id: "restart", name: "restart_submission", arguments: {} },
      {
        id: "replacement",
        name: "submit_question",
        arguments: { id: "Q1", question: "replacement", intent: "intent", leakage_group: "group" }
      },
      { id: "finalize-replacement", name: "finalize_questions", arguments: {} }
    ])
  ]);

  assert.equal(parseQuestions(output)[0]!.question, "replacement");
  const receipts = ((requests[1]!.messages as Array<Record<string, unknown>>) ?? [])
    .filter((message) => message.role === "tool")
    .map((message) => String(message.content ?? ""));
  assert.ok(receipts.some((value) => value.includes("BATCH_REJECTED code=SUBMISSION_CONFLICT")));
  assert.ok(receipts.some((value) => value.includes("BATCH_REJECTED code=BATCH_PRIOR_TOOL_ERROR")));
  assert.ok(receipts.every((value) => !value.startsWith("FINALIZED")));
});

test("a repeated finalizer validation code stops semantic repair loops even when authored content changes", async () => {
  const responses = [
    toolTurn([
      {
        id: "first-incomplete",
        name: "submit_question",
        arguments: { id: "Q1", question: "same", intent: "same", leakage_group: "same" }
      },
      { id: "first-rejected-finalizer", name: "finalize_questions", arguments: {} }
    ]),
    toolTurn([
      {
        id: "same-incomplete-new-call-id",
        name: "submit_question",
        arguments: { id: "Q1", question: "different authored attempt", intent: "changed", leakage_group: "changed" }
      },
      { id: "same-rejected-finalizer-new-call-id", name: "finalize_questions", arguments: {} }
    ])
  ];
  let providerTurns = 0;
  let telemetry: Parameters<NonNullable<FactoryPromptCall["reportFailureTelemetry"]>>[0] | undefined;
  const runner = createFactoryLlmPromptRunner({
    apiKey: "submission-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    fetch: async () => {
      providerTurns += 1;
      const response = responses.shift();
      if (!response) throw new Error("Semantic validation cycle was not stopped");
      return response;
    }
  });

  await assert.rejects(
    () => runner({
      purpose: "eval.generate_questions",
      systemPrompt: "question system",
      prompt: "input",
      outputContract: { kind: "question_set", expectedCount: 2 },
      reportFailureTelemetry: (value) => { telemetry = value; }
    }),
    /repeated final validation failure QUESTION_COUNT_MISMATCH/
  );
  assert.equal(providerTurns, 2, "one explicit repair attempt is allowed before the same structural failure stops the run");
  assert.equal(telemetry?.code, "exact_submission_cycle");
  assert.equal(telemetry?.exactCycleKind, "repeated_final_validation");
  assert.equal(telemetry?.lastToolTurn?.finalizerOutcome, "rejected");
  assert.equal(telemetry?.lastToolTurn?.finalizerValidationCode, "QUESTION_COUNT_MISMATCH");
  assert.equal(JSON.stringify(telemetry).includes("authored"), false, "telemetry must not retain authored IDs, args, or content");
});

test("a repeated batch without its required finalizer is classified without weakening exact-cycle detection", async () => {
  let telemetry: Parameters<NonNullable<FactoryPromptCall["reportFailureTelemetry"]>>[0] | undefined;
  const responses = [
    toolTurn([{ id: "missing-finalizer-one", name: "submit_question", arguments: { id: "Q1", question: "one", intent: "one", leakage_group: "one" } }]),
    toolTurn([{ id: "missing-finalizer-two", name: "submit_question", arguments: { id: "Q1", question: "one", intent: "one", leakage_group: "one" } }])
  ];
  const runner = createFactoryLlmPromptRunner({
    apiKey: "submission-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    fetch: async () => responses.shift() ?? (() => { throw new Error("cycle not stopped"); })()
  });
  await assert.rejects(() => runner({
    purpose: "eval.generate_questions",
    systemPrompt: "question system",
    prompt: "input",
    outputContract: { kind: "question_set", expectedCount: 1 },
    reportFailureTelemetry: (value) => { telemetry = value; }
  }), /exact submission tool cycle/);
  assert.equal(telemetry?.exactCycleKind, "missing_finalizer");
  assert.equal(telemetry?.lastToolTurn?.transaction, "rolled_back");
});

test("runner refuses normal prose completion without an accepted finalize", async () => {
  let telemetry: Parameters<NonNullable<FactoryPromptCall["reportFailureTelemetry"]>>[0] | undefined;
  const runner = createFactoryLlmPromptRunner({
    apiKey: "submission-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    fetch: async () => textTurn("I wrote the artifact in prose but did not submit it.")
  });
  await assert.rejects(
    () => runner({
      purpose: "eval.judge_result",
      systemPrompt: "eval system",
      prompt: "input",
      outputContract: { kind: "evaluation_verdict" },
      reportFailureTelemetry: (value) => { telemetry = value; }
    }),
    /ended without an accepted finalize tool call/
  );
  assert.equal(telemetry?.code, "stopped_without_finalize");
});

test("evaluation and corpus audit tools canonical-render the existing evaluation contract", async () => {
  const evaluation = await run({
    purpose: "eval.judge_result",
    systemPrompt: "eval system",
    prompt: "input",
    outputContract: { kind: "evaluation_verdict" }
  }, [
    toolTurn([
      {
        id: "verdict",
        name: "submit_evaluation",
        arguments: { pass: false, diagnosis: "缺少明确取舍", few_shot: "可作为边界例", corpus_reflection: "加入 System 决策规则" }
      },
      { id: "verdict-finalize", name: "finalize_evaluation", arguments: {} }
    ])
  ]);
  assert.equal(parseEvaluation(evaluation.output).pass, false);

  const audit = await run({
    purpose: "eval.audit_corpus",
    systemPrompt: "audit system",
    prompt: "input",
    outputContract: { kind: "corpus_audit" }
  }, [
    toolTurn([
      {
        id: "audit",
        name: "submit_corpus_audit",
        arguments: { pass: true, diagnosis: "完整", corpus_reflection: "None" }
      },
      { id: "audit-finalize", name: "finalize_corpus_audit", arguments: {} }
    ])
  ]);
  const parsedAudit = parseEvaluation(audit.output);
  assert.equal(parsedAudit.pass, true);
  assert.equal(parsedAudit.fewShot, "None — this audit does not create a runtime few-shot.");
});

test("Corpus audit accepts a provider split submit and finalize turn", async () => {
  const { output, requests } = await run({
    purpose: "eval.audit_corpus",
    systemPrompt: "audit system",
    prompt: "input",
    outputContract: { kind: "corpus_audit" }
  }, [
    toolTurn([{
      id: "audit-submit-only",
      name: "submit_corpus_audit",
      arguments: { pass: true, diagnosis: "complete", corpus_reflection: "No changes required." }
    }]),
    toolTurn([{ id: "audit-finalize-only", name: "finalize_corpus_audit", arguments: {} }])
  ]);

  assert.equal(parseEvaluation(output).pass, true);
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[0]), /submit_corpus_audit/);
  assert.match(JSON.stringify(requests[1]), /STAGED status=ACCEPTED evaluation/);
});

test("Evaluation accepts a provider split submit and finalize turn", async () => {
  const { output, requests } = await run({
    purpose: "eval.judge_result",
    systemPrompt: "eval system",
    prompt: "input",
    outputContract: { kind: "evaluation_verdict" }
  }, [
    toolTurn([{
      id: "evaluation-submit-only",
      name: "submit_evaluation",
      arguments: { pass: true, diagnosis: "complete", few_shot: "None", corpus_reflection: "None" }
    }]),
    toolTurn([{ id: "evaluation-finalize-only", name: "finalize_evaluation", arguments: {} }])
  ]);

  assert.equal(parseEvaluation(output).pass, true);
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[0]), /submit_evaluation/);
  assert.match(JSON.stringify(requests[1]), /STAGED status=ACCEPTED evaluation/);
});

test("Corpus finalization returns precise safe repair codes for audit and relationship failures", async () => {
  const missingSection = [
    "## Retained\nNone.",
    "## Added or changed\n- system.",
    "## Removed\nNone.",
    "## Merged\nNone.",
    "## Conflict resolutions\nNone."
  ].join("\n");
  const completePreservation = [
    missingSection,
    "## Asset identity, path, or layer changes\nNone."
  ].join("\n");
  const envelopeCollision = minimalCorpusCalls("envelope-collision", completePreservation, "offer-builder");
  envelopeCollision[3]!.arguments = {
    section: "change_rationale",
    markdown: "Complete replacement.\n# Change rationale\nPRIVATE-AUTHORED-SENTINEL"
  };
  const { output, requests } = await run({
    purpose: "corpus.compile",
    systemPrompt: "compiler system",
    prompt: "full evidence",
    outputContract: { kind: "corpus_compilation", availableToolIds: [] }
  }, [
    toolTurn(minimalCorpusCalls("audit-missing", missingSection, "offer-builder")),
    toolTurn(minimalCorpusCalls("parent-missing", completePreservation, "missing-skill")),
    toolTurn(envelopeCollision),
    toolTurn(minimalCorpusCalls("corrected", completePreservation, "offer-builder"))
  ]);

  assert.equal(parseCorpusCompilation(output).references[0]!.parentSkillId, "offer-builder");
  assert.match(JSON.stringify(requests[1]), /REJECTED code=CORPUS_PRESERVATION_SECTION_COUNT/);
  assert.match(JSON.stringify(requests[2]), /REJECTED code=CORPUS_REFERENCE_PARENT_UNKNOWN/);
  const collisionReceipts = ((requests[3]!.messages as Array<Record<string, unknown>>) ?? [])
    .filter((message) => message.role === "tool")
    .map((message) => String(message.content ?? ""));
  assert.ok(collisionReceipts.some((value) => value.includes("REJECTED code=CORPUS_ENVELOPE_SECTION_COUNT")));
  assert.ok(collisionReceipts.every((value) => !value.includes("PRIVATE-AUTHORED-SENTINEL")));
  assert.doesNotMatch(JSON.stringify(requests[1]), /Canonical Corpus contract rejected; check asset metadata/);
});

test("Corpus tools derive paths and canonical-render every layer in one accepted mixed batch", async () => {
  const preservation = [
    "## Retained\nNone — initial compilation.",
    "## Added or changed\n- system and offer skill added.",
    "## Removed\nNone.",
    "## Merged\nNone.",
    "## Conflict resolutions\nNone.",
    "## Asset identity, path, or layer changes\nNone."
  ].join("\n");
  const { output, requests } = await run({
    purpose: "corpus.compile",
    systemPrompt: "compiler system",
    prompt: "full evidence and QA",
    outputContract: { kind: "corpus_compilation", availableToolIds: ["hatch.web_search"] }
  }, [
    toolTurn([
      {
        id: "system",
        name: "submit_system_instructions",
        arguments: { content: "# Identity\nMake decisive, publishable work." }
      },
      {
        id: "skill",
        name: "submit_skill",
        arguments: {
          id: "offer-builder",
          name: "Offer Builder",
          when_to_use: "When turning expertise into a sellable offer.",
          allowed_tool_ids: ["hatch.web_search"],
          content: "# Procedure\nChoose one painful outcome."
        }
      },
      {
        id: "reference",
        name: "submit_reference",
        arguments: {
          id: "offer-method",
          parent_skill_id: "offer-builder",
          reference_kind: "method",
          content: "# Method\nPrefer a narrow promise."
        }
      },
      {
        id: "knowledge",
        name: "submit_knowledge",
        arguments: { id: "case-library", source_summary: "Creator-authorized cases", content: "# Cases\nA bootstrapped launch." }
      },
      {
        id: "rationale",
        name: "submit_corpus_audit_section",
        arguments: { section: "change_rationale", markdown: "Initial complete compilation." }
      },
      {
        id: "trace",
        name: "submit_corpus_audit_section",
        arguments: { section: "requirements_traceability", markdown: "- R1: Creator evidence → offer-builder." }
      },
      {
        id: "preservation",
        name: "submit_corpus_audit_section",
        arguments: { section: "preservation_audit", markdown: preservation }
      },
      { id: "corpus-finalize", name: "finalize_corpus", arguments: {} }
    ])
  ]);

  const corpus = parseCorpusCompilation(output, { availableToolIds: ["hatch.web_search"] });
  assert.equal(corpus.skills[0]!.path, "skills/offer-builder/SKILL.md");
  assert.equal(corpus.references[0]!.path, "skills/offer-builder/references/offer-method.md");
  assert.equal(corpus.knowledge[0]!.path, "knowledge/case-library.md");
  assert.equal(requests.length, 1, "the complete Corpus handoff and accepted finalizer must terminate the first tool turn");
  const offeredSchemas = JSON.stringify((requests[0].tools as unknown[]) ?? []);
  assert.doesNotMatch(offeredSchemas, /\"path\"/);
  assert.doesNotMatch(offeredSchemas, /manifest|sha256/i);
  assert.match(offeredSchemas, /exactly one level-2 subsection/);
  assert.match(offeredSchemas, /## Retained; ## Added or changed; ## Removed; ## Merged; ## Conflict resolutions; ## Asset identity, path, or layer changes/);
  assert.match(offeredSchemas, /original synthesis of supported meaning/);
  assert.match(offeredSchemas, /Never quote, transcribe, lightly edit, sentence-by-sentence paraphrase, or split authorized source prose across assets/);
});

test("Corpus draft commits bounded partial turns and repairs a rejected finalizer in place", async () => {
  const preservation = [
    "## Retained\nNone — initial compilation.",
    "## Added or changed\n- system, skill, and reference added.",
    "## Removed\nNone.",
    "## Merged\nNone.",
    "## Conflict resolutions\nNone.",
    "## Asset identity, path, or layer changes\nNone."
  ].join("\n");
  const { output, requests } = await run({
    purpose: "corpus.compile",
    systemPrompt: "compiler system",
    prompt: "complete evidence",
    outputContract: { kind: "corpus_compilation", availableToolIds: [] }
  }, [
    toolTurn([
      { id: "partial-system", name: "submit_system_instructions", arguments: { content: "# Identity\nDecide clearly." } },
      {
        id: "partial-skill",
        name: "submit_skill",
        arguments: {
          id: "offer-builder",
          name: "Offer Builder",
          when_to_use: "When building an offer.",
          allowed_tool_ids: [],
          content: "# Procedure\nChoose one outcome."
        }
      }
    ]),
    toolTurn([
      {
        id: "bad-reference",
        name: "submit_reference",
        arguments: {
          id: "offer-method",
          parent_skill_id: "missing-skill",
          reference_kind: "method",
          content: "# Method\nPrefer a narrow promise."
        }
      },
      { id: "rationale", name: "submit_corpus_audit_section", arguments: { section: "change_rationale", markdown: "Initial compilation." } },
      { id: "trace", name: "submit_corpus_audit_section", arguments: { section: "requirements_traceability", markdown: "- R1 -> offer-builder." } },
      { id: "preservation", name: "submit_corpus_audit_section", arguments: { section: "preservation_audit", markdown: preservation } },
      { id: "bad-finalize", name: "finalize_corpus", arguments: {} }
    ]),
    toolTurn([
      {
        id: "fixed-reference",
        name: "submit_reference",
        arguments: {
          id: "offer-method",
          parent_skill_id: "offer-builder",
          reference_kind: "method",
          content: "# Method\nPrefer a narrow promise."
        }
      },
      { id: "fixed-finalize", name: "finalize_corpus", arguments: {} }
    ])
  ]);

  const corpus = parseCorpusCompilation(output);
  assert.equal(corpus.systemInstructions, "# Identity\nDecide clearly.");
  assert.equal(corpus.references[0]!.parentSkillId, "offer-builder");
  assert.equal(requests.length, 3);
  assert.match(JSON.stringify(requests[1]), /system=1\/1; skills=1/);
  assert.match(JSON.stringify(requests[2]), /REJECTED code=CORPUS_REFERENCE_PARENT_UNKNOWN; complete draft retained/);
});

function minimalCorpusCalls(
  prefix: string,
  preservation: string,
  parentSkillId: string
): SubmittedToolCall[] {
  return [
    {
      id: `${prefix}-system`,
      name: "submit_system_instructions",
      arguments: { content: "# Identity\nReturn a complete publishable result." }
    },
    {
      id: `${prefix}-skill`,
      name: "submit_skill",
      arguments: {
        id: "offer-builder",
        name: "Offer Builder",
        when_to_use: "When building an offer.",
        allowed_tool_ids: [],
        content: "# Procedure\nChoose one outcome."
      }
    },
    {
      id: `${prefix}-reference`,
      name: "submit_reference",
      arguments: {
        id: "offer-method",
        parent_skill_id: parentSkillId,
        reference_kind: "method",
        content: "# Method\nPrefer a narrow promise."
      }
    },
    {
      id: `${prefix}-rationale`,
      name: "submit_corpus_audit_section",
      arguments: { section: "change_rationale", markdown: "Complete replacement." }
    },
    {
      id: `${prefix}-trace`,
      name: "submit_corpus_audit_section",
      arguments: { section: "requirements_traceability", markdown: "- R1 -> system." }
    },
    {
      id: `${prefix}-preservation`,
      name: "submit_corpus_audit_section",
      arguments: { section: "preservation_audit", markdown: preservation }
    },
    { id: `${prefix}-finalize`, name: "finalize_corpus", arguments: {} }
  ];
}
