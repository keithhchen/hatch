// VERIFICATION TOOL ONLY. FAKE #2 of the stand-in (see moderator-stand-in-preload.mjs): a module-load hook, not a product change on disk.
// chatToolsForRun() in dist/agentRuntime.js drops every server tool whose runtime name is not `hatch.*` or in the Product's allowlist, and a
// Product's allowlist only ever holds Creator http/mcp tools, so the Chat attachment tools (attachments.ls/grep/read) are never declared
// to the model. The hook lets `attachments.*` through, so the tools' own behaviour can be measured. Everything else is unchanged.
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith("/dist/agentRuntime.js")) return result;
  const source = String(result.source);
  const from = '|| spec.runtimeName.startsWith("hatch.")';
  if (!source.includes(from)) throw new Error("stand-in loader: the declaration filter was not found in dist/agentRuntime.js");
  return { ...result, source: source.replace(from, `${from} || spec.runtimeName.startsWith("attachments.")`) };
}
