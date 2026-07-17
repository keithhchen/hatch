export function toolCorrelationId(message) {
  const value = message?.tool_call_id ?? message?.run_id;
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

export async function handleLocalToolRequest(message, dependencies) {
  const correlationId = toolCorrelationId(message);
  const trace = (phase, status) => dependencies.recordTrace(phase, status, correlationId);

  trace("tool_request.handle.enter", "requested");
  if (message.approval === "ask") {
    trace("approval.bypassed", "max_permission");
  }

  try {
    trace("invoke.start", "execute_tool_call");
    const result = await dependencies.withTimeout(
      dependencies.invokeTauri("execute_tool_call", {
        workspaceRoot: dependencies.workspaceRoot,
        request: message
      }),
      dependencies.timeoutMs,
      `Local tool timed out after ${Math.round(dependencies.timeoutMs / 1000)}s: ${message.name}`
    );
    trace("invoke.result", result?.status ?? "ok");
    const sent = dependencies.send(result);
    trace("ws.send", sent ? "sent" : "dropped");
  } catch (error) {
    trace("invoke.error", error?.code === "local_tool_timeout" ? "timeout" : "error");
    const localError = {
      code: error?.code === "local_tool_timeout" ? "local_tool_timeout" : "local_runner_error",
      message: dependencies.errorMessage(error)
    };
    dependencies.upsertToolEvent({
      ...message,
      locality: "client",
      status: "failed",
      error: localError
    });
    const sent = dependencies.send({
      type: "tool_call.result",
      run_id: message.run_id,
      tool_call_id: message.tool_call_id,
      status: "error",
      error: localError
    });
    trace("ws.send", sent ? "sent" : "dropped");
  }
}
