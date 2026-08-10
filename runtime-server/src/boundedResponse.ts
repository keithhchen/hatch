export const MAX_RUNTIME_RESPONSE_BODY_BYTES = 4 * 1024 * 1024;

/** Read an untrusted HTTP response without allowing Content-Length or chunked bodies to exhaust memory. */
export async function readBoundedResponseText(
  response: Response,
  maxBytes = MAX_RUNTIME_RESPONSE_BODY_BYTES
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Response body exceeds the ${maxBytes} byte limit`);
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Response body exceeds the ${maxBytes} byte limit`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

export async function readBoundedJsonObject(
  response: Response,
  maxBytes = MAX_RUNTIME_RESPONSE_BODY_BYTES
): Promise<Record<string, unknown>> {
  const text = await readBoundedResponseText(response, maxBytes);
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Response body is not a JSON object");
  }
  return value as Record<string, unknown>;
}

export function assertBoundedJsonValue(
  value: unknown,
  maxBytes = MAX_RUNTIME_RESPONSE_BODY_BYTES
): void {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error(`Tool result exceeds the ${maxBytes} byte limit`);
  }
}
