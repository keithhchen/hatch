const onepagerMediaBaseUrl = String(import.meta.env.VITE_HATCH_ONEPAGER_MEDIA_BASE_URL ?? "").replace(/\/+$/, "");

export function onepagerMediaUrl(fileName: string): string {
  return onepagerMediaBaseUrl ? `${onepagerMediaBaseUrl}/${fileName}` : `/assets/onepager/${fileName}`;
}
