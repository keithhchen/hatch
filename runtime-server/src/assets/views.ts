import type { Asset } from "./domain.js";

export const ATTACHMENTS_ROOT = "/attachments";

/** Every asset of one message gets a distinct path; a repeated name is prefixed by its asset id. */
export function pathsFor(messageId: string, assets: readonly Asset[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const a of assets) counts.set(a.record.name, (counts.get(a.record.name) ?? 0) + 1);
  return new Map(assets.map(a => [a.id, `${ATTACHMENTS_ROOT}/${messageId}/${counts.get(a.record.name)! > 1 ? `${a.id.slice(0, 8)}-` : ""}${a.record.name}`]));
}

/** What the model reads next to an image, and what replaces it once its pixels are dropped. */
export const imageLabel = (path: string) => `[image: ${path}]`;

const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The single line the model sees for a file. The content stays reachable by path. */
export const fileLine = (asset: Asset, path: string) => `[file: ${asset.record.name} | ${asset.record.mime} | ${size(asset.record.bytes)} | ${path}]`;

export type ImageSlot = { id: string; bytes: number; label: string };

/**
 * Drops the oldest images until the rest fit the byte budget. Input is oldest
 * first; the newest image is always kept. A dropped image is replaced by its label.
 */
export function fitImagesToBudget(images: readonly ImageSlot[], budgetBytes: number): Array<ImageSlot & { kept: boolean }> {
  let used = 0;
  let dropping = false;
  const decided = [...images].reverse().map((image, index) => {
    used += image.bytes;
    dropping ||= index > 0 && used > budgetBytes;
    return { ...image, kept: !dropping };
  });
  return decided.reverse();
}
