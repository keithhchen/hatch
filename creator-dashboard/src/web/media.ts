const webMediaBaseUrl = String(import.meta.env.VITE_HATCH_WEB_MEDIA_BASE_URL ?? "").replace(/\/+$/, "");

export function webMediaUrl(fileName: string): string {
  return webMediaBaseUrl ? `${webMediaBaseUrl}/${fileName}` : `/assets/web/${fileName}`;
}
