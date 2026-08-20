import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClientToolBroker } from "../clientBroker.js";
import { PiAgentRuntime } from "../piAgentRuntime.js";
import { RunStateMachine } from "../runState.js";
import { ServerToolExecutor } from "../serverTools.js";
import { RuntimeStore } from "../store.js";
import type { HatchCandidateExecutor } from "./types.js";

/**
 * @deprecated Unit-test-only instruction harness. Production Creator Factory
 * uses cliCandidateExecutor.ts so candidates traverse the full Hatch Runtime
 * server/session/Corpus path.
 *
 * Execute a candidate through Hatch's production PiAgentRuntime. The harness
 * has no buyer workspace, conversation history, or Creator answer. Runtime
 * scratch events are removed after each case; the Factory writes the durable,
 * correctly sealed trace after this function returns.
 */
export function createHatchCandidateRuntimeExecutor(): HatchCandidateExecutor {
  return async (execution) => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "hatch-candidate-runtime-"));
    let broker: ClientToolBroker | undefined;
    let runtimeRunId: string | undefined;
    try {
      if (execution.signal?.aborted) {
        throw new Error("Factory candidate evaluation aborted");
      }
      const runId = `factory_eval_${randomUUID().replaceAll("-", "")}`;
      runtimeRunId = runId;
      const conversationId = `factory_eval_conversation_${randomUUID().replaceAll("-", "")}`;
      const store = new RuntimeStore(scratch);
      const state = new RunStateMachine(runId, conversationId, store);
      broker = new ClientToolBroker(async () => {
        throw new Error("Creator Factory candidate evaluation has no buyer-local tools");
      }, store);
      // Candidate evaluation must measure only the distilled Corpus. It still
      // uses Hatch's production PiAgentRuntime, but deliberately exposes no
      // Hatch/server, Creator/external, buyer/client, local, or Skill tools.
      // Passing an explicit empty list is materially different from relying on
      // the ordinary Runtime defaults, which include always-available tools.
      const runtime = new PiAgentRuntime({
        toolDefinitions: [],
        allowRequestedArtifactDelivery: false
      });
      const chunks: string[] = [];
      await state.queued();
      await state.start();
      try {
        for await (const event of runtime.run({
          type: "client.message",
          run_id: runId,
          client_message_id: runId,
          conversation_id: conversationId,
          message: { role: "user", content: execution.question }
        }, {
          abortSignal: execution.signal,
          clientBroker: broker,
          serverTools: new ServerToolExecutor(),
          state,
          messages: [{ role: "user", content: execution.question }],
          sessionSkills: {
            records: [],
            visibleRecords: [],
            rendered: {
              section: "",
              aliases: {},
              report: {
                total_count: 0,
                included_count: 0,
                omitted_count: 0,
                truncated_description_chars: 0,
                truncated_description_count: 0
              }
            }
          },
          clientTools: [],
          allowedExternalTools: [],
          externalToolDefinitions: [],
          knowledgeAvailable: false,
          agentSystemPrompt: execution.systemInstructions
        })) {
          if (event.type === "assistant.delta" && event.delta.kind === "text") chunks.push(event.delta.content);
        }
        if (state.status === "running") await state.complete();
        const result = chunks.join("");
        if (!result.trim()) throw new Error("Hatch candidate Runtime returned an empty result");
        return result;
      } catch (error) {
        if (["running", "waiting_for_tool", "compacting"].includes(state.status)) {
          await state.fail(error instanceof Error ? error.message : String(error));
        }
        throw error;
      }
    } finally {
      try {
        if (broker && runtimeRunId) {
          await broker.cancelRun(runtimeRunId, "Factory candidate evaluation ended");
        }
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
  };
}
