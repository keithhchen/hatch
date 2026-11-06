import path from "node:path";

/** A file name that is safe as one path segment anywhere (disk, object key), keeping Unicode letters. */
export const safeName = (name: string, fallback = "item"): string => {
  const base = name.normalize("NFC").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f:*?"<>|]/g, "-").replace(/\s+/g, "-").replace(/^[.\-]+/, "").slice(0, 100);
  return cleaned || fallback;
};

export const stemOf = (name: string) => path.parse(name).name || name;

/** A readable label for a link: host and path. */
export const labelOfUrl = (url: string): string => {
  const { hostname, pathname } = new URL(url);
  return safeName(`${hostname}${pathname === "/" ? "" : pathname.replace(/\//g, "-")}`, "link");
};

const MEDIA_TYPES: Record<string, string> = {
  ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain", ".html": "text/html", ".json": "application/json",
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip", ".csv": "text/csv",
};

export const mediaTypeOf = (name: string, declared?: string): string =>
  declared?.trim() || MEDIA_TYPES[path.extname(name).toLowerCase()] || "application/octet-stream";
