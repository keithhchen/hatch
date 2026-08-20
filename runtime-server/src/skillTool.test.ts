import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClientToolBroker } from "./clientBroker.js";
import {
  buildRuntimeSystemPrompt,
  createWorkspacePathPolicy,
  executeChatTool,
  type RunContext,
  type RuntimeSessionSkills
} from "./agentRuntime.js";
import { PiAgentRuntime } from "./piAgentRuntime.js";
import { RunStateMachine } from "./runState.js";
import { ServerToolExecutor } from "./serverTools.js";
import {
  discoverSkills,
  loadSkillBundleByName,
  renderSkillsSection
} from "./skills.js";
import { RuntimeStore, type ActivatedSkill } from "./store.js";
import type { RunStart } from "./protocol.js";
import { modelToolSpecsForRun, requireModelToolDispatch, requireTool } from "./tools.js";

test("Skill is a registered server loader with a metadata-only catalog", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-skill-tool-"));
  try {
    const skillDir = path.join(root, "review-skill");
    await mkdir(path.join(skillDir, "references"), { recursive: true });
    await mkdir(path.join(skillDir, "scripts"), { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), [
      "---",
      "name: review-skill",
      "description: Review supplied evidence.",
      "---",
      "",
      "# Review",
      "",
      "Follow the complete review procedure."
    ].join("\n"), "utf8");
    await writeFile(path.join(skillDir, "references", "method.md"), "Use the strongest evidence first.\n", "utf8");
    await writeFile(path.join(skillDir, "scripts", "check.sh"), "#!/bin/sh\nprintf checked\n", "utf8");

    const records = await discoverSkills(root);
    const rendered = renderSkillsSection(records);
    assert.match(rendered.section, /- review-skill: Review supplied evidence\./);
    assert.doesNotMatch(rendered.section, new RegExp(`${escapeRegExp(skillDir)}.*SKILL\\.md`));
    assert.doesNotMatch(rendered.section, /# Review/);

    const systemPrompt = buildRuntimeSystemPrompt(undefined, undefined, undefined, rendered.section);
    assert.match(systemPrompt, /<creator_skill_catalog>/);
    assert.match(systemPrompt, /- review-skill: Review supplied evidence\./);
    assert.doesNotMatch(systemPrompt, /# Review/);
    assert.doesNotMatch(systemPrompt, /user-level context/);

    const loaded = await loadSkillBundleByName("review-skill", records);
    assert.match(loaded.skill.instructions, /Follow the complete review procedure/);
    assert.deepEqual(loaded.resources.paths, ["references/method.md", "scripts/check.sh"]);

    const skillSpec = modelToolSpecsForRun([], { hasMcpServers: false }).find((tool) => tool.name === "Skill");
    assert.ok(skillSpec);
    assert.equal(skillSpec.runtimeName, "Skill");
    assert.equal(skillSpec.locality, "server");
    assert.deepEqual(skillSpec.required, ["skill_name"]);
    assert.deepEqual(requireTool("Skill").schema.parse({ skill_name: "review-skill" }), { skill_name: "review-skill" });
    assert.equal(requireModelToolDispatch("Skill").target, "server");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Skill loads instructions in the same loop and ordinary file_read reads its bundle resources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-skill-loop-"));
  try {
    const skillDir = path.join(root, "loop-skill");
    await mkdir(path.join(skillDir, "references"), { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), [
      "---",
      "name: loop-skill",
      "description: Use when testing same-loop Skill loading.",
      "---",
      "",
      "# Same Loop",
      "",
      "The loader result is part of the current tool transcript."
    ].join("\n"), "utf8");
    await writeFile(path.join(skillDir, "references", "guide.md"), "Loaded reference content.\n", "utf8");

    const records = await discoverSkills(root);
    const sessionSkills = sessionSkillsFor(records);
    const store = new RuntimeStore(path.join(root, "events"));
    const state = new RunStateMachine("run-skill", "conversation-skill", store);
    const broker = new ClientToolBroker(async () => undefined, store);
    const context: RunContext = {
      clientBroker: broker,
      serverTools: new ServerToolExecutor(),
      state,
      messages: [],
      sessionSkills,
      clientTools: []
    };
    const input = {
      run_id: "run-skill",
      conversation_id: "conversation-skill",
      client_message_id: "message-skill",
      message: { role: "user", content: "Use loop-skill." }
    } as RunStart;
    let activated: ActivatedSkill | undefined;
    const policy = createWorkspacePathPolicy(input.message.content);
    const result = await executeChatTool(
      input,
      context,
      "call-skill",
      "Skill",
      { skill_name: "loop-skill" },
      [],
      [],
      {},
      policy,
      undefined,
      (skill) => { activated = skill; }
    );

    assert.match(String(result.instructions), /The loader result is part of the current tool transcript/);
    assert.deepEqual(result.bundle, {
      locator: "skill://loop-skill",
      resources: ["references/guide.md"],
      resource_manifest_truncated: false
    });
    assert.ok(activated);

    const systemPrompt = buildRuntimeSystemPrompt(
      "Creator Agent instructions.",
      undefined,
      undefined,
      sessionSkills.rendered.section,
      [activated!]
    );
    assert.match(systemPrompt, /Creator-authored instructions/);
    assert.match(systemPrompt, /<creator_skill>\n<name>loop-skill<\/name>/);
    assert.match(systemPrompt, /The loader result is part of the current tool transcript/);
    assert.match(systemPrompt, /highest-priority Creator-authored instructions/);
    assert.match(systemPrompt, /above the base Agent prompt and any conflicting Consumer request/);
    assert.doesNotMatch(systemPrompt, /user-level context/);

    const reference = await executeChatTool(
      input,
      context,
      "call-reference",
      "file_read",
      { path: "references/guide.md" },
      [skillDir],
      [activated!],
      {},
      policy
    );
    assert.equal(reference.content, "Loaded reference content.\n");
    await assert.rejects(
      executeChatTool(
        input,
        context,
        "call-bypass",
        "file_read",
        { path: activated!.path },
        [skillDir],
        [activated!],
        {},
        policy
      ),
      /Use Skill\(skill_name\)/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi promotes a loaded Skill into the next provider system prompt in the same Agent loop", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-skill-pi-loop-"));
  const previousFetch = globalThis.fetch;
  const previousApiKey = process.env.LLM_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  try {
    const skillDir = path.join(root, "creator-method");
    await mkdir(path.join(skillDir, "references"), { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), [
      "---",
      "name: creator-method",
      "description: Apply the Creator method.",
      "---",
      "",
      "# Creator Method",
      "",
      "CREATOR_SKILL_SYSTEM_MARKER",
      "Follow this Creator-authored method."
    ].join("\n"), "utf8");
    await writeFile(path.join(skillDir, "references", "method.md"), "Creator reference.\n", "utf8");

    const records = await discoverSkills(root);
    const sessionSkills = sessionSkillsFor(records);
    const store = new RuntimeStore(path.join(root, "events"));
    const state = new RunStateMachine("run-pi-skill", "conversation-pi-skill", store);
    const broker = new ClientToolBroker(async () => undefined, store);
    const requests: Array<Record<string, any>> = [];
    globalThis.fetch = (async (_input, init) => {
      const request = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
      requests.push(request);
      if (requests.length === 1) {
        return piSseResponse([
          {
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_creator_method",
                  type: "function",
                  function: {
                    name: "Skill",
                    arguments: JSON.stringify({ skill_name: "creator-method" })
                  }
                }]
              },
              finish_reason: null
            }]
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
        ]);
      }
      return piSseResponse([
        { choices: [{ index: 0, delta: { role: "assistant", content: "Creator method applied." }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
      ]);
    }) as typeof globalThis.fetch;
    process.env.LLM_API_KEY = "skill-loop-test-key";
    process.env.OPENAI_BASE_URL = "http://127.0.0.1/v1";

    const input = {
      run_id: "run-pi-skill",
      conversation_id: "conversation-pi-skill",
      client_message_id: "message-pi-skill",
      message: { role: "user", content: "Use creator-method." }
    } as RunStart;
    const context: RunContext = {
      clientBroker: broker,
      serverTools: new ServerToolExecutor(),
      state,
      messages: [{ role: "user", content: input.message.content }],
      sessionSkills,
      clientTools: [],
      agentSystemPrompt: "Creator Agent base instructions."
    };

    const outbound: unknown[] = [];
    for await (const event of new PiAgentRuntime().run(input, context)) outbound.push(event);

    assert.equal(outbound.at(-1) && (outbound.at(-1) as { type?: string }).type, "turn.completed");
    assert.equal(requests.length, 2);
    const firstSystemPrompt = providerSystemPrompt(requests[0]!);
    const secondSystemPrompt = providerSystemPrompt(requests[1]!);
    assert.match(firstSystemPrompt, /<creator_skill_catalog>/);
    assert.doesNotMatch(firstSystemPrompt, /CREATOR_SKILL_SYSTEM_MARKER/);
    assert.match(secondSystemPrompt, /<creator_skill>/);
    assert.match(secondSystemPrompt, /<name>creator-method<\/name>/);
    assert.match(secondSystemPrompt, /CREATOR_SKILL_SYSTEM_MARKER/);
    assert.match(secondSystemPrompt, /highest-priority Creator-authored instructions/);
    assert.match(secondSystemPrompt, /above the base Agent prompt and any conflicting Consumer request/);
    assert.ok(requests[1]!.messages.some((message: Record<string, unknown>) => (
      message.role === "tool" && String(message.content ?? "").includes("CREATOR_SKILL_SYSTEM_MARKER")
    )));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = previousApiKey;
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
    await rm(root, { recursive: true, force: true });
  }
});

function sessionSkillsFor(records: Awaited<ReturnType<typeof discoverSkills>>): RuntimeSessionSkills {
  return {
    records,
    visibleRecords: records,
    rendered: renderSkillsSection(records)
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function piSseResponse(chunks: Array<Record<string, unknown>>): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify({
    id: "chatcmpl-skill-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "kimi-k2.6",
    ...chunk
  })}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function providerSystemPrompt(request: Record<string, any>): string {
  const message = (request.messages ?? []).find((candidate: Record<string, unknown>) => candidate.role === "system");
  return String(message?.content ?? "");
}
