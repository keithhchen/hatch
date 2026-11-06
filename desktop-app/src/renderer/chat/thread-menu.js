import { SEPARATOR } from "../native/context-menu.js";
import { artifactRelativePath, attachmentAt, toolArtifact, toolEntriesAt } from "./thread-targets.js";

const fileName = path => path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || path;

/** Tool content with its full result: history rows may store only a detail reference. */
async function fullContent(entry, session) {
  const { content } = entry;
  if (content.result !== undefined || !content.detailRef) return content;
  try {
    const { tool } = await session.controller.transport.toolDetail(session.conversationId, content.detailRef);
    return { ...content, arguments: tool?.arguments ?? content.arguments, result: tool?.result };
  } catch {
    return content;
  }
}

/**
 * Native context menu items for a right-click in a conversation thread:
 * a tool row offers Reveal in Finder / Quick Look / Copy Path / Copy Output
 * for the file it produced; an attachment offers Save As… / Open for its
 * native local copy. Returns null when the pointer is on neither.
 */
export async function threadMenuItems({ target, session, t, invoke, copy, report }) {
  const state = session.controller.getState();
  const attachment = attachmentAt(target, state, mediaType => session.controller.attachments.accepts(mediaType));
  if (attachment?.local) {
    const call = command => () => invoke(command, attachment.local).catch(report);
    return [
      { label: t("menu.saveAttachment"), action: call("save_local_attachment") },
      { label: t("menu.openAttachment"), action: call("open_local_attachment") }
    ];
  }
  const tools = toolEntriesAt(target, state);
  if (!tools.length) return null;
  const grant = session.workspace.grant;
  const groups = (await Promise.all(tools.map(entry => fullContent(entry, session)))).map(toolArtifact).filter(item => item.path || item.output);
  if (!groups.length) return null;
  const itemsFor = ({ path, output }) => {
    const relativePath = artifactRelativePath(path, grant?.display_path);
    const request = { request: { workspaceGrantId: grant?.grant_id, relativePath } };
    const inFolder = Boolean(grant && relativePath);
    return [
      { label: t("menu.revealArtifact"), enabled: inFolder, action: () => invoke("reveal_workspace_artifact", request).catch(report) },
      { label: t("menu.quickLook"), enabled: inFolder, action: () => invoke("open_workspace_artifact", request).catch(report) },
      SEPARATOR,
      { label: t("menu.copyPath"), enabled: Boolean(path), action: () => copy(path).catch(report) },
      { label: t("menu.copyOutput"), enabled: Boolean(output), action: () => copy(output).catch(report) }
    ];
  };
  if (groups.length === 1) return itemsFor(groups[0]);
  return groups.map(group => ({ label: group.path ? fileName(group.path) : t("menu.toolOutput"), items: itemsFor(group) }));
}
