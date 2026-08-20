import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getFactoryNode, factoryNodes } from "./nodeRegistry.js";
import type { NodeScope } from "../node.js";
import type { NodeExecutionState, NodeExecutionStateStore } from "../nodeExecution.js";
import { nodeObjectReference, NodeOssStore, type NodeStorage } from "../nodeStorage.js";
import { NodeRuntimeError } from "../nodeRuntime.js";
import type { NodeExecutionWorker } from "../nodeWorker.js";

export type NodeHttpRequest = {
  method: string;
  pathname: string;
  body?: Record<string, unknown>;
};

export type NodeHttpResponse = {
  status: number;
  body: unknown;
};

export type NodeHttpContext = {
  executions?: NodeExecutionStateStore;
  storage?: NodeStorage;
  worker?: NodeExecutionWorker;
};

/** The Creator-facing control-plane API for the Studio Node graph. */
export async function handleNodeHttp(
  request: NodeHttpRequest,
  context: NodeHttpContext
): Promise<NodeHttpResponse | undefined> {
  const graphMatch = request.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/nodes$/);
  if (graphMatch && request.method === "GET") {
    if (!context.executions) return { status: 503, body: { detail: "Factory Node control plane is unavailable" } };
    const productId = decodeURIComponent(graphMatch[1]!);
    const executions = await context.executions.list(productId);
    return {
      status: 200,
      body: {
        product_id: productId,
        nodes: Object.values(factoryNodes).map(nodeDefinitionView),
        executions: executions.map(executionView)
      }
    };
  }

  const startMatch = request.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/nodes\/([^/]+)\/executions$/);
  if (startMatch && request.method === "POST") {
    if (!context.worker || !context.executions || !context.storage) {
      return { status: 503, body: { detail: "Factory Node control plane is unavailable" } };
    }
    const productId = decodeURIComponent(startMatch[1]!);
    const nodeName = decodeURIComponent(startMatch[2]!);
    const node = getFactoryNode(nodeName);
    const body = request.body ?? {};
    const parsedInput = node.inputSchema.safeParse(body.input);
    if (!parsedInput.success) {
      return { status: 422, body: { detail: z.prettifyError(parsedInput.error), code: "invalid_node_input" } };
    }
    const executionId = typeof body.execution_id === "string" && body.execution_id.trim()
      ? body.execution_id.trim()
      : `execution-${randomUUID()}`;
    const scope: NodeScope = { productId, nodeName, executionId };
    const inputRef = nodeObjectReference(scope, "input.json");
    try {
      await new NodeOssStore(context.storage).writeInput(scope, parsedInput.data);
      const state = await context.executions.ensure(scope, inputRef);
      context.worker.enqueue(scope);
      return { status: 202, body: { execution: executionView({ ...state, nodeName, executionId }) } };
    } catch (error) {
      if (error instanceof NodeRuntimeError) {
        return { status: 409, body: { detail: error.message, code: error.code } };
      }
      return { status: 409, body: { detail: error instanceof Error ? error.message : String(error), code: "execution_conflict" } };
    }
  }

  const executionMatch = request.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/nodes\/([^/]+)\/executions\/([^/]+)$/);
  if (executionMatch && request.method === "GET") {
    if (!context.executions) return { status: 503, body: { detail: "Factory Node control plane is unavailable" } };
    const productId = decodeURIComponent(executionMatch[1]!);
    const nodeName = decodeURIComponent(executionMatch[2]!);
    getFactoryNode(nodeName);
    const executionId = decodeURIComponent(executionMatch[3]!);
    const state = await context.executions.load({ productId, nodeName, executionId });
    return state
      ? { status: 200, body: { execution: executionView({ ...state, nodeName, executionId }) } }
      : { status: 404, body: { detail: "Node execution not found" } };
  }

  return undefined;
}

function nodeDefinitionView(node: ReturnType<typeof getFactoryNode>): Record<string, unknown> {
  return {
    name: node.name,
    input_schema: z.toJSONSchema(node.inputSchema, { target: "openAi" }),
    actor: {
      session_policy: node.actor.sessionPolicy,
      output_schema: z.toJSONSchema(node.actor.outputSchema, { target: "openAi" })
    },
    critic: {
      session_policy: node.critic.sessionPolicy,
      output_schema: z.toJSONSchema(node.critic.outputSchema, { target: "openAi" })
    }
  };
}

function executionView(
  value: NodeExecutionState & { nodeName: string; executionId: string }
): Record<string, unknown> {
  return {
    node_name: value.nodeName,
    execution_id: value.executionId,
    state: value.state,
    round: value.round,
    input_ref: value.inputRef,
    ...(value.candidateRef ? { candidate_ref: value.candidateRef } : {}),
    ...(value.feedbackRef ? { feedback_ref: value.feedbackRef } : {}),
    ...(value.outputRef ? { output_ref: value.outputRef } : {}),
    ...(value.errorMessage ? { error_message: value.errorMessage } : {}),
    ...(value.leaseOwner ? { lease_owner: value.leaseOwner } : {}),
    ...(value.leaseExpiresAt ? { lease_expires_at: value.leaseExpiresAt } : {}),
    ...(value.createdAt ? { created_at: value.createdAt } : {}),
    ...(value.updatedAt ? { updated_at: value.updatedAt } : {})
  };
}
