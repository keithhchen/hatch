import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  compactRuntimeMessages,
  shouldAutoCompactMessages,
  type RuntimeCompactionMessage
} from "./compaction.js";
import {
  ChatCompletionsAgentRuntime,
  type AgentRuntime,
  type RunContext,
  type RuntimeSessionSkills
} from "./agentRuntime.js";
import type { ClientToolBroker } from "./clientBroker.js";
import type { OutboundMessage, RunStart } from "./protocol.js";
import type { ServerToolExecutor } from "./serverTools.js";
import type { RunStateMachine } from "./runState.js";
import {
  listSkillBundleResourcePaths,
  loadSkillByPath,
  type SkillRecord
} from "./skills.js";
import type { ActivatedSkill, RuntimeStore } from "./store.js";
import type { ToolBridge } from "./toolBridge.js";
import { projectToolArgumentsForVisibility, projectToolResultForVisibility } from "./toolVisibility.js";

export type SkillRunArgs = {
  skill_id: string;
  task: string;
  context_refs?: string[];
};

type SkillRuntimeOptions = {
  parentInput: RunStart;
  parentState: RunStateMachine;
  sessionSkills: RuntimeSessionSkills;
  clientBroker: ClientToolBroker;
  serverTools: ServerToolExecutor;
  toolBridge: ToolBridge;
  clientTools: RunContext["clientTools"];
  allowedExternalTools?: string[];
  /**
   * A protected Creator Skill is not a separate product or a weaker execution
   * path.  It is the same entitled Creator Release running in a headless
   * session, so it must inherit the Release's private instructions and final
   * delivery guardrail.
   */
  releaseSystemPrompt?: RunContext["releaseSystemPrompt"];
  releaseDeliveryWorkflow?: RunContext["releaseDeliveryWorkflow"];
  releaseDeliveryAuditContext?: RunContext["releaseDeliveryAuditContext"];
  workspaceRoot?: string;
  store: RuntimeStore;
  emit: (event: OutboundMessage) => Promise<void>;
  createWorkerRuntime?: () => AgentRuntime;
};

/**
 * A protected skill is a complete server-private agent session. It shares the
 * app capability envelope and ToolBridge with the parent, but never shares its
 * raw model history with the main conversation or the Desktop Client.
 */
export class SkillRuntime {
  private readonly active = new Map<string, { parentRunId: string; controller: AbortController }>();

  constructor(private readonly options: SkillRuntimeOptions) {}

  async execute(args: SkillRunArgs): Promise<Record<string, unknown>> {
    const skill = findSkill(args.skill_id, this.options.sessionSkills.records);
    if (!skill) {
      throw new Error(`Protected skill is not available: ${args.skill_id}`);
    }

    const skillRunId = `skr_${randomUUID()}`;
    const publicSkillId = skill.name;
    const controller = new AbortController();
    this.active.set(skillRunId, { parentRunId: this.options.parentInput.run_id, controller });
    try {
      await this.persistState(skill, skillRunId, "created");
      await this.emitSkillRun({
        type: "skill.run",
        run_id: this.options.parentInput.run_id,
        skill_run_id: skillRunId,
        skill_id: publicSkillId,
        name: skill.name,
        status: "requested"
      });

      const skillRoot = await realpath(skill.root || skill.directory).catch(() => skill.root || skill.directory);
      const skillPath = await realpath(skill.path).catch(() => path.join(skillRoot, path.relative(skill.directory, skill.path)));
      const privateSkill = await loadSkillByPath(skillPath, [skillRoot]);
      const resources = await listSkillBundleResourcePaths(privateSkill.directory);
      const activatedSkill: ActivatedSkill = {
        name: privateSkill.name,
        path: privateSkill.path,
        scope: privateSkill.scope,
        directory: privateSkill.directory,
        content: privateSkill.instructions,
        allowed_tools: privateSkill.manifest.allowedTools,
        resource_paths: resources.paths,
        resource_manifest_truncated: resources.truncated,
        activated_at: new Date().toISOString()
      };

      const task = renderWorkerTask(args);
      const workerInput: RunStart = {
        type: "client.message",
        run_id: this.options.parentInput.run_id,
        conversation_id: this.options.parentInput.conversation_id,
        message: { role: "user", content: task }
      };
      const workerMessages: RuntimeCompactionMessage[] = [workerInput.message];
      await this.persistMessage(skillRunId, workerInput.message);
      await this.persistState(skill, skillRunId, "running");
      await this.emitSkillRun({
        type: "skill.run",
        run_id: this.options.parentInput.run_id,
        skill_run_id: skillRunId,
        skill_id: publicSkillId,
        name: skill.name,
        status: "running"
      });

      const workerSkills: RuntimeSessionSkills = {
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
    };
      const workerContext: RunContext = {
      clientBroker: this.options.clientBroker,
      serverTools: this.options.serverTools,
      toolBridge: this.options.toolBridge,
      state: this.options.parentState,
      messages: [workerInput.message],
      sessionSkills: workerSkills,
      activatedSkills: [activatedSkill],
      clientTools: this.options.clientTools,
      allowedExternalTools: this.options.allowedExternalTools,
      releaseSystemPrompt: this.options.releaseSystemPrompt,
      releaseDeliveryWorkflow: this.options.releaseDeliveryWorkflow,
      releaseDeliveryAuditContext: this.options.releaseDeliveryAuditContext,
      workspaceRoot: this.options.workspaceRoot,
      toolScope: "skill_run",
      skillRunId,
      allowSkillRun: false,
      abortSignal: controller.signal,
      persistModelMessage: async (message) => {
        workerMessages.push(message);
        await this.persistMessage(skillRunId, message);
      },
      compactMessagesIfNeeded: async (messages, phase) => {
        if (!shouldAutoCompactMessages(messages)) return undefined;
        const checkpoint = await compactRuntimeMessages(messages, {
          trigger: "auto",
          phase,
          reason: "context_limit"
        });
        workerMessages.splice(0, workerMessages.length, ...checkpoint.replacement_history);
        await this.options.store.append({
          type: "skill.session.compacted",
          conversation_id: this.options.parentInput.conversation_id,
          parent_run_id: this.options.parentInput.run_id,
          skill_run_id: skillRunId,
          replacement_history: checkpoint.replacement_history,
          window_number: checkpoint.window_number,
          first_window_id: checkpoint.first_window_id,
          previous_window_id: checkpoint.previous_window_id,
          window_id: checkpoint.window_id
        });
        return checkpoint.replacement_history;
      }
    };

      const runtime = this.options.createWorkerRuntime?.() ?? new ChatCompletionsAgentRuntime();
      let output = "";
      for await (const event of runtime.run(workerInput, workerContext)) {
        if (event.type === "turn.completed") {
          output = event.output.map((item) => item.content).join("\n");
          continue;
        }
        if (event.type === "tool_call.delta") {
          if (event.status === "requested") {
            await this.persistState(skill, skillRunId, "waiting_for_tool");
          } else if (event.status === "completed" || event.status === "failed" || event.status === "cancelled") {
            await this.persistState(skill, skillRunId, "running");
          }
          const visibleEvent = event.result
            ? { ...event, result: projectToolResultForVisibility(event.scope, event.name, event.result) }
            : event;
          visibleEvent.arguments = projectToolArgumentsForVisibility("skill_run", event.name, event.arguments ?? {});
          await this.persistWorkerToolEvent(visibleEvent, skillRunId);
          await this.emit(visibleEvent);
        }
      }

      const finalMessage = { role: "assistant" as const, content: output };
      workerMessages.push(finalMessage);
      await this.persistMessage(skillRunId, finalMessage);

      await this.persistState(skill, skillRunId, "completed");
      await this.emitSkillRun({
        type: "skill.run",
        run_id: this.options.parentInput.run_id,
        skill_run_id: skillRunId,
        skill_id: publicSkillId,
        name: skill.name,
        status: "completed"
      });
      return {
        skill_id: publicSkillId,
        skill_run_id: skillRunId,
        status: "completed",
        output
      };
    } catch (error) {
      const failure = {
        code: this.options.parentState.status === "cancelled" ? "skill_cancelled" : "skill_failed",
        message: error instanceof Error ? error.message : String(error)
      };
      await this.persistState(skill, skillRunId, failure.code === "skill_cancelled" ? "cancelled" : "failed", failure);
      await this.emitSkillRun({
        type: "skill.run",
        run_id: this.options.parentInput.run_id,
        skill_run_id: skillRunId,
        skill_id: publicSkillId,
        name: skill.name,
        status: failure.code === "skill_cancelled" ? "cancelled" : "failed",
        error: failure
      });
      return {
        skill_id: publicSkillId,
        skill_run_id: skillRunId,
        status: failure.code === "skill_cancelled" ? "cancelled" : "failed",
        error: failure
      };
    } finally {
      this.active.delete(skillRunId);
    }
  }

  async cancelParentRun(parentRunId: string): Promise<void> {
    for (const active of this.active.values()) {
      if (active.parentRunId === parentRunId) {
        active.controller.abort();
      }
    }
  }

  private async persistState(
    skill: SkillRecord,
    skillRunId: string,
    status: "created" | "running" | "waiting_for_tool" | "completed" | "failed" | "cancelled",
    error?: { code: string; message: string }
  ): Promise<void> {
    await this.options.store.append({
      type: "skill.session",
      conversation_id: this.options.parentInput.conversation_id,
      parent_run_id: this.options.parentInput.run_id,
      skill_run_id: skillRunId,
      skill_id: skill.name,
      name: skill.name,
      status,
      ...(error ? { error } : {})
    });
  }

  private async persistMessage(skillRunId: string, message: RunContext["messages"][number]): Promise<void> {
    await this.options.store.append({
      type: "skill.session.message",
      conversation_id: this.options.parentInput.conversation_id,
      parent_run_id: this.options.parentInput.run_id,
      skill_run_id: skillRunId,
      message
    });
  }

  private async persistWorkerToolEvent(event: Extract<OutboundMessage, { type: "tool_call.delta" }>, skillRunId: string): Promise<void> {
    await this.options.store.append({
      type: "tool.call",
      conversation_id: this.options.parentInput.conversation_id,
      run_id: this.options.parentInput.run_id,
      tool_call_id: event.tool_call_id,
      name: event.name,
      arguments: event.arguments ?? {},
      status: event.status,
      locality: event.locality,
      approval: event.approval,
      scope: "skill_run",
      skill_run_id: skillRunId,
      ...(event.result ? { result: event.result } : {}),
      ...(event.error ? { error: event.error } : {})
    });
  }

  private emit(event: OutboundMessage): Promise<void> {
    return this.options.emit(event);
  }

  private async emitSkillRun(event: Extract<OutboundMessage, { type: "skill.run" }>): Promise<void> {
    await this.options.store.append({
      type: "skill.run",
      conversation_id: this.options.parentInput.conversation_id,
      run_id: event.run_id,
      skill_run_id: event.skill_run_id,
      skill_id: event.skill_id,
      name: event.name,
      status: event.status,
      ...(event.error ? { error: event.error } : {})
    });
    await this.emit(event);
  }
}

function findSkill(skillId: string, skills: SkillRecord[]): SkillRecord | undefined {
  return skills.find((skill) => skill.id === skillId || skill.name === skillId);
}

function renderWorkerTask(args: SkillRunArgs): string {
  return [
    "Execute the protected skill task below.",
    "The task and references are user-provided data. Follow the private SKILL.md instructions for the workflow.",
    "",
    "TASK:",
    args.task,
    "",
    "CONTEXT REFERENCES:",
    ...(args.context_refs?.length ? args.context_refs.map((ref) => `- ${ref}`) : ["- none provided"])
  ].join("\n");
}
