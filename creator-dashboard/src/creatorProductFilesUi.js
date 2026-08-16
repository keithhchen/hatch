const PROCESSING_STATUSES = new Set(["pending", "processing", "projecting", "queued", "uploading"]);
const ERROR_STATUSES = new Set(["error", "failed", "projection_failed", "rejected"]);
const READY_STATUSES = new Set(["available", "complete", "completed", "ready"]);

export function productFileState(file) {
  const status = String(file?.status ?? "").toLowerCase();
  if (ERROR_STATUSES.has(status)) return "error";
  if (PROCESSING_STATUSES.has(status)) return "processing";
  if (READY_STATUSES.has(status)) return "ready";

  const projection = file?.projection;
  return projection?.kind && projection?.sha256 && (projection?.content_ref || projection?.contentRef)
    ? "ready"
    : "processing";
}

export function shouldPollProductFiles(files) {
  return files.some((file) => productFileState(file) === "processing");
}

export function canGenerateProductVersion(files) {
  return files.length > 0 && files.every((file) => productFileState(file) === "ready");
}
