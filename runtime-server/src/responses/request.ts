import { invalidRequest, unsupported } from "./errors.js";

/** Where an attachment's bytes come from: the request itself (a data URL), an https URL the server fetches, or a file the account uploaded to the Files API. */
export type AttachmentSource = { kind: "data"; mediaType: string; base64: string } | { kind: "url"; url: string } | { kind: "file"; id: string };

export type InputPart =
  | { type: "text"; text: string }
  | { type: "image"; source: AttachmentSource }
  | { type: "file"; source: AttachmentSource; filename?: string };

/** What this deployment of the API offers. Attachments (image and file input, the Files API) are built but not public yet. */
export type ResponsesFeatures = { attachments: boolean };

/** The caller's answer to a tool that asked for approval (`mcp_approval_response`). */
export type ApprovalAnswer = { requestId: string; approve: boolean; reason?: string; param: string };

export type CreateResponseRequest = {
  model?: string;
  /** A conversation id, from `conversation` as a string or `{ id }`. */
  conversationId?: string;
  previousResponseId?: string;
  /** Raw: validated against the Product's Brief when the conversation is created. */
  taskBrief?: unknown;
  parts: InputPart[];
  approvals: ApprovalAnswer[];
  stream: boolean;
  background: boolean;
  includeToolCalls: boolean;
};

/** Accepted and ignored, as the contract documents. */
const IGNORED = ["temperature", "top_p", "user", "service_tier", "prompt_cache_key", "prompt_cache_retention", "safety_identifier", "top_logprobs", "stream_options"];
const KNOWN = new Set([
  "model", "input", "conversation", "previous_response_id", "task_brief", "stream", "background", "store", "include", "metadata",
  "instructions", "tools", "tool_choice", "text", "reasoning", "max_output_tokens", "max_tool_calls", "parallel_tool_calls", "truncation", "prompt",
  ...IGNORED
]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const present = (value: unknown): boolean => value !== undefined && value !== null;

/** Rejects, naming the parameter, everything this API does not do: the Agent owns its instructions, tools and reasoning. */
function rejectUnsupported(body: Record<string, unknown>): void {
  for (const key of Object.keys(body)) {
    if (!KNOWN.has(key)) throw invalidRequest("unknown_parameter", `Unknown parameter: '${key}'.`, key);
  }
  if (present(body.instructions)) throw unsupported("instructions", "instructions is not supported: the Agent owns its instructions.");
  if (Array.isArray(body.tools) ? body.tools.length > 0 : present(body.tools)) throw unsupported("tools", "tools is not supported: the Agent owns its tools.");
  if (present(body.tool_choice) && body.tool_choice !== "auto") throw unsupported("tool_choice", "tool_choice is not supported other than \"auto\".");
  if (present(body.reasoning)) throw unsupported("reasoning");
  if (present(body.max_output_tokens)) throw unsupported("max_output_tokens");
  if (present(body.max_tool_calls)) throw unsupported("max_tool_calls");
  if (present(body.parallel_tool_calls)) throw unsupported("parallel_tool_calls");
  if (present(body.truncation)) throw unsupported("truncation");
  if (present(body.prompt)) throw unsupported("prompt");
  if (body.store === false) throw unsupported("store", "store must be true: responses are part of the conversation record.");
  if (isRecord(body.metadata) && Object.keys(body.metadata).length > 0) throw unsupported("metadata", "metadata is not supported on responses.");
  if (present(body.text)) {
    const format = isRecord(body.text) ? body.text.format : undefined;
    if (!isRecord(body.text) || (present(format) && !(isRecord(format) && format.type === "text"))) throw unsupported("text.format", "text.format is not supported other than \"text\".");
  }
}

function includeToolCalls(value: unknown): boolean {
  if (!present(value)) return false;
  if (!Array.isArray(value)) throw invalidRequest("invalid_request", "include must be an array.", "include");
  let tools = false;
  value.forEach((entry, index) => {
    if (entry === "hatch.tool_calls") tools = true;
    else throw unsupported(`include[${index}]`, `include value ${JSON.stringify(entry)} is not supported.`);
  });
  return tools;
}

const fileSource = (value: unknown, param: string): AttachmentSource => {
  if (typeof value !== "string" || !value) throw invalidRequest("invalid_request", `${param} must be a string.`, param);
  return { kind: "file", id: value };
};

/** One attachment source from `image_url`, `file_data` or `file_url`. */
function sourceOf(value: unknown, param: string, kind: "image" | "file"): AttachmentSource {
  if (typeof value !== "string" || !value) throw invalidRequest("invalid_request", `${param} must be a string.`, param);
  if (value.startsWith("data:")) {
    const match = value.match(/^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s);
    if (!match || !/;base64$/i.test(match[2] ?? "")) throw invalidRequest("invalid_request", `${param} must be a base64 data URL.`, param);
    const mediaType = match[1] || (kind === "image" ? "image/png" : "application/octet-stream");
    return { kind: "data", mediaType, base64: match[3] ?? "" };
  }
  if (/^https:\/\//i.test(value)) return { kind: "url", url: value };
  throw invalidRequest("invalid_request", `${param} must be a data URL or an https URL.`, param);
}

function partOf(part: unknown, param: string, features: ResponsesFeatures): InputPart {
  if (!isRecord(part)) throw invalidRequest("invalid_request", `${param} must be an object.`, param);
  if (part.type === "input_text") {
    if (typeof part.text !== "string") throw invalidRequest("invalid_request", `${param}.text must be a string.`, `${param}.text`);
    return { type: "text", text: part.text };
  }
  if ((part.type === "input_image" || part.type === "input_file") && !features.attachments) {
    throw unsupported(param, "Image and file input are not available yet.");
  }
  if (part.type === "input_image") {
    if (present(part.file_id)) return { type: "image", source: fileSource(part.file_id, `${param}.file_id`) };
    return { type: "image", source: sourceOf(part.image_url, `${param}.image_url`, "image") };
  }
  if (part.type === "input_file") {
    if (present(part.file_id)) return { type: "file", source: fileSource(part.file_id, `${param}.file_id`) };
    const filename = typeof part.filename === "string" && part.filename ? part.filename : undefined;
    const raw = present(part.file_data) ? part.file_data : part.file_url;
    return { type: "file", source: sourceOf(raw, present(part.file_data) ? `${param}.file_data` : `${param}.file_url`, "file"), ...(filename ? { filename } : {}) };
  }
  throw unsupported(`${param}.type`, `Input content of type ${JSON.stringify(part.type)} is not supported.`);
}

function parseInput(input: unknown, features: ResponsesFeatures): { parts: InputPart[]; approvals: ApprovalAnswer[] } {
  const parts: InputPart[] = [];
  const approvals: ApprovalAnswer[] = [];
  if (!present(input)) return { parts, approvals };
  if (typeof input === "string") return { parts: input.trim() ? [{ type: "text", text: input }] : [], approvals };
  if (!Array.isArray(input)) throw invalidRequest("invalid_request", "input must be a string or an array of items.", "input");
  input.forEach((item, index) => {
    const param = `input[${index}]`;
    if (!isRecord(item)) throw invalidRequest("invalid_request", `${param} must be an object.`, param);
    if (item.type === "mcp_approval_response") {
      if (typeof item.approval_request_id !== "string" || typeof item.approve !== "boolean") {
        throw invalidRequest("invalid_request", `${param} needs approval_request_id and approve.`, param);
      }
      approvals.push({ requestId: item.approval_request_id, approve: item.approve, ...(typeof item.reason === "string" ? { reason: item.reason } : {}), param });
      return;
    }
    if (present(item.type) && item.type !== "message") throw unsupported(`${param}.type`, `Input items of type ${JSON.stringify(item.type)} are not supported.`);
    if (item.role !== "user") throw unsupported(`${param}.role`, "Only user messages are accepted as input: the Agent owns its instructions.");
    if (typeof item.content === "string") {
      if (item.content.trim()) parts.push({ type: "text", text: item.content });
      return;
    }
    if (!Array.isArray(item.content)) throw invalidRequest("invalid_request", `${param}.content must be a string or an array.`, `${param}.content`);
    item.content.forEach((part, at) => parts.push(partOf(part, `${param}.content[${at}]`, features)));
  });
  return { parts, approvals };
}

/** The body of `POST /responses`, validated: what it asks for in the domain's terms, or the first parameter this API refuses. */
export function parseCreateResponse(body: Record<string, unknown>, features: ResponsesFeatures): CreateResponseRequest {
  rejectUnsupported(body);
  for (const flag of ["stream", "background"] as const) {
    if (present(body[flag]) && typeof body[flag] !== "boolean") throw invalidRequest("invalid_request", `${flag} must be a boolean.`, flag);
  }
  if (present(body.model) && typeof body.model !== "string") throw invalidRequest("invalid_request", "model must be a string.", "model");
  if (present(body.previous_response_id) && typeof body.previous_response_id !== "string") throw invalidRequest("invalid_request", "previous_response_id must be a string.", "previous_response_id");
  const reference = body.conversation;
  const conversationId = typeof reference === "string" ? reference : isRecord(reference) && typeof reference.id === "string" ? reference.id : undefined;
  if (present(reference) && !conversationId) throw invalidRequest("invalid_request", "conversation must be an id or an object with an id.", "conversation");
  if (conversationId && present(body.previous_response_id)) throw invalidRequest("invalid_request", "Send conversation or previous_response_id, not both.", "previous_response_id");
  const { parts, approvals } = parseInput(body.input, features);
  if (approvals.length && parts.length) throw invalidRequest("invalid_request", "Answer approvals in their own request: input cannot mix mcp_approval_response with messages.", "input");
  return {
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(typeof body.previous_response_id === "string" ? { previousResponseId: body.previous_response_id } : {}),
    ...(present(body.task_brief) ? { taskBrief: body.task_brief } : {}),
    parts, approvals,
    stream: body.stream === true,
    background: body.background === true,
    includeToolCalls: includeToolCalls(body.include)
  };
}
