import { randomUUID } from "node:crypto";
import type http from "node:http";
import type { AgentCorpusResolverLike as AgentCorpusResolver } from "../agentCorpus.js";
import { conversationBinding, durableConversationId, type LegacyHmacAuth, type SessionBinding } from "../chat/sessionBinding.js";
import { ConversationError as ConversationHttpError } from "../conversations/conversation.js";
import type { ConversationRecord, ConversationRepository } from "../conversationRepository.js";
import type { AuthIdentityResolver, EntitlementResolver } from "../entitlements.js";
import { requireAllowedOrigin, requireConversationBinding } from "../http/requestBinding.js";
import { readJsonObject, writeJsonBounded } from "../http/httpSupport.js";
import type { ArtifactMode } from "./mode.js";
import type { ReportRecord } from "./ports.js";

export type ArtifactRouteDeps = {
  artifact: ArtifactMode;
  repository: ConversationRepository;
  entitlementResolver: EntitlementResolver | undefined;
  agentCorpusResolver: AgentCorpusResolver | undefined;
  authIdentityResolver: AuthIdentityResolver | undefined;
  legacyHmacAuth: LegacyHmacAuth;
  maxHttpResponseBytes: number;
  allowedOrigins: readonly string[];
};

const FILES = { "free.pdf": ["freePdf", "application/pdf"], "preview.png": ["preview", "image/png"], "full.pdf": ["fullPdf", "application/pdf"] } as const;

/** What a viewer may fetch of a report: the free files once it is ready, the full PDF once it is unlocked or the viewer owns the product (an owner is bound with creatorId = userId). */
export function reportAccess(record: ReportRecord, binding: Pick<SessionBinding, "creatorId" | "userId">) {
  const ready = record.status === "ready";
  const unlocked = Boolean(record.unlockedAt);
  return { ready, unlocked, files: { free_pdf: ready, preview: ready, full_pdf: ready && (unlocked || binding.creatorId === binding.userId) } };
}

/** `/v1/products/:productId/artifact[/conversations]`: the intake, and the viewer's artifact conversations. */
export async function handleProductArtifactRequest(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: ArtifactRouteDeps): Promise<boolean> {
  const match = url.pathname.match(/^\/v1\/products\/([^/]+)\/artifact(\/conversations)?$/);
  if (!match) return false;
  const productId = decodeURIComponent(match[1]!);
  const { artifact, repository } = deps;
  // The viewer is bound the way a chat conversation's creator is: by the entitlement the web names, or as the product's owner.
  const bound = new URL(url);
  if (!bound.searchParams.get("entitlement_id")) bound.searchParams.set("product_id", productId);
  const binding = await requireConversationBinding(req, bound, deps.entitlementResolver, deps.agentCorpusResolver, deps.authIdentityResolver, deps.legacyHmacAuth);
  if (binding.productId !== productId) throw new ConversationHttpError(403, "entitlement_required", "This entitlement is for another product.");
  const write = (status: number, body: unknown) => writeJsonBounded(res, status, body, deps.maxHttpResponseBytes);
  const config = await artifact.configs.get(productId);
  if (!config) throw new ConversationHttpError(404, "artifact_not_found", "This product has no report mode.");

  if (!match[2]) {
    if (req.method !== "GET") throw new ConversationHttpError(405, "method_not_allowed", "Use GET.");
    write(200, { intake: config.intake });
    return true;
  }
  const repoBinding = conversationBinding(binding);
  if (req.method === "GET") {
    const reports = await artifact.reports.list(repoBinding.ownerAccountId, productId);
    const rows = await Promise.all(reports.map(async (report) => {
      const conversation = await repository.getConversation(report.conversationId);
      return conversation && { conversation_id: conversation.publicId, status: report.status, created_at: report.createdAt, ...(report.readyAt ? { ready_at: report.readyAt } : {}), unlocked: Boolean(report.unlockedAt) };
    }));
    write(200, rows.filter(Boolean));
    return true;
  }
  if (req.method !== "POST") throw new ConversationHttpError(405, "method_not_allowed", "Use GET or POST.");
  requireAllowedOrigin(req, deps.allowedOrigins);
  // A repeated create with the same key is the same conversation and the same report, never a second.
  const header = req.headers["idempotency-key"];
  const body = await readJsonObject(req).catch(() => ({} as Record<string, unknown>));
  const key = (typeof header === "string" ? header : typeof body.client_request_id === "string" ? body.client_request_id : "").trim().slice(0, 256);
  const publicId = `conv_${randomUUID().replaceAll("-", "")}`;
  const { conversation, created } = await repository.createConversation({
    ...repoBinding, id: durableConversationId(binding, publicId), publicId, ...(key ? { clientRequestId: key } : {}),
    ...(binding.agentCorpus?.product.name ? { title: binding.agentCorpus.product.name } : {})
  });
  await artifact.reports.create({ conversationId: conversation.id, productId, ownerAccountId: conversation.ownerAccountId });
  write(created ? 201 : 200, { conversation_id: conversation.publicId });
  return true;
}

/** `/v1/conversations/:id/report[/files/:name]`, for a conversation already bound and authorized by the caller. */
export async function handleReportRequest(
  req: http.IncomingMessage, res: http.ServerResponse, rest: string, conversation: ConversationRecord, binding: SessionBinding,
  artifact: ArtifactMode, maxHttpResponseBytes: number
): Promise<boolean> {
  const match = rest.match(/^\/report(?:\/files\/([^/]+))?$/);
  if (!match) return false;
  if (req.method !== "GET") throw new ConversationHttpError(405, "method_not_allowed", "Use GET.");
  const record = await artifact.reports.get(conversation.id);
  if (!record) throw new ConversationHttpError(404, "report_not_found", "This conversation has no report.");
  const access = reportAccess(record, binding);
  if (!match[1]) {
    writeJsonBounded(res, 200, {
      status: record.status, unlocked: access.unlocked, files: access.files, ...(record.error ? { error: record.error } : {}),
      stage: record.stage, attempt: record.attempt, ...(record.startedAt ? { started_at: record.startedAt } : {}),
      // Development only: the waiting animation's raw steps. To be limited to the product owner or hidden once the UI is settled.
      steps: record.steps
    }, maxHttpResponseBytes);
    return true;
  }
  const name = decodeURIComponent(match[1]) as keyof typeof FILES;
  const file = FILES[name];
  if (!file) throw new ConversationHttpError(404, "report_file_not_found", "Unknown report file.");
  if (!access.ready || !record.keys) throw new ConversationHttpError(404, "report_not_ready", "The report is not ready.");
  if (name === "full.pdf" && !access.files.full_pdf) throw new ConversationHttpError(403, "report_locked", "The full report is locked.");
  const bytes = await artifact.blobs.get(record.keys[file[0]]);
  res.writeHead(200, { "content-type": file[1], "content-length": bytes.length, "cache-control": "private, no-store" });
  res.end(bytes);
  return true;
}
