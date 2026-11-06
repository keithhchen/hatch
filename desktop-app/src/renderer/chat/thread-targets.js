import { ChatTimeline, approvalDecision, groupTimelineEntries, partitionAttachments } from "@hatch/chat";

/**
 * Resolves a right-click inside the shared ChatView thread to the durable
 * thing under the pointer — the tool calls of an activity row, or a message
 * attachment — from the controller's own state. The DOM is used only to find
 * which message and which row; every value comes from the conversation model.
 * (ChatView renders one <article> per message, and one body child per
 * grouped timeline entry; thread-targets.test.jsx pins that contract.)
 */

const ROW = ".web-chat__activity-trigger, .web-chat__activity-modal, .web-chat__approval, .web-chat__activity-block";
const text = value => typeof value === "string" && value.trim() ? value.trim() : "";

function messageAt(element, messages) {
  const article = element?.closest?.("article.web-chat__message");
  const thread = article?.parentElement;
  if (!article || !thread) return null;
  const index = [...thread.children].filter(child => child.matches("article.web-chat__message")).indexOf(article);
  return index >= 0 && messages[index] ? { article, message: messages[index] } : null;
}

const timelineOf = message => message.transient ? message.timeline ?? [] : ChatTimeline.fromHistory(message);

/** Tool entries of the activity row under `element` (a group yields all of its tools). */
export function toolEntriesAt(element, state) {
  const row = element?.closest?.(ROW);
  const located = row && messageAt(row, state.messages);
  if (!located) return [];
  const modal = row.closest(".web-chat__activity-modal");
  const anchor = modal ? modal.previousElementSibling : row.closest(".web-chat__approval") ?? row;
  const body = anchor?.parentElement;
  if (!body?.matches(".web-chat__message-body")) return [];
  const ordinal = [...body.children].filter(child => child.tagName !== "DIALOG").indexOf(anchor);
  // Desktop shows every activity kind, so ChatView renders the whole timeline.
  const item = groupTimelineEntries(timelineOf(located.message), entry => approvalDecision(entry, state.approvals ?? {}) !== null)[ordinal];
  if (!item) return [];
  let entries = item.kind === "activity_group" ? item.entries : [item];
  if (modal) {
    const block = row.closest(".web-chat__activity-modal-items > *");
    const index = block ? [...block.parentElement.children].indexOf(block) : -1;
    if (index >= 0 && entries[index]) entries = [entries[index]];
  }
  return entries.filter(entry => entry.kind === "tool");
}

/** The file a tool produced or touched, and its output text. */
export function toolArtifact(content) {
  const args = content?.arguments ?? {};
  const result = content?.result;
  const path = [result?.path, result?.artifact_path, result?.file_path, args.path, args.file_path].map(text).find(Boolean) ?? "";
  const output = typeof result === "string" ? result
    : text(result?.output) || text(result?.content) || (result !== undefined && result !== null ? JSON.stringify(result, null, 2) : "");
  return { path, output };
}

/**
 * A path inside the granted folder, relative to it. Absolute paths outside
 * the folder are refused here; native re-checks containment authoritatively.
 */
export function artifactRelativePath(artifactPath, workspaceRoot) {
  const artifact = text(artifactPath).replaceAll("\\", "/");
  const root = text(workspaceRoot).replaceAll("\\", "/").replace(/\/+$/, "");
  if (!artifact || !root) return "";
  if (artifact.startsWith(`${root}/`)) return artifact.slice(root.length + 1);
  if (artifact.startsWith("/") || /^[A-Za-z]:\//.test(artifact)) return "";
  return artifact.replace(/^\.\//, "");
}

/** The message attachment under `element`, with its native local copy reference when it has one. */
export function attachmentAt(element, state, accepts) {
  const chip = element?.closest?.(".web-chat__attachments > *, .web-chat__pictures > *");
  const located = chip && messageAt(chip, state.messages);
  if (!located) return null;
  const { files, pictures } = partitionAttachments(located.message, accepts);
  const list = chip.parentElement.matches(".web-chat__attachments") ? files : pictures;
  const attachment = list[[...chip.parentElement.children].indexOf(chip)];
  if (!attachment) return null;
  const local = attachment.kind === "local_file" && text(attachment.attachment_id) && text(attachment.host_id) && text(attachment.sha256)
    ? { contextId: attachment.attachment_id, hostId: attachment.host_id, sha256: attachment.sha256 }
    : null;
  return { attachment, local };
}
