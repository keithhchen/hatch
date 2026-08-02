import type { CreatorReleasePublic } from "./release.js";

export type RegistryPublication = {
  status: string;
  creator_id: string;
  product_id: string;
  release_id: string;
  release_digest: string;
  published_at: string;
  [key: string]: unknown;
};

export async function requirePublishedRelease(
  registryUrl: string,
  release: CreatorReleasePublic
): Promise<RegistryPublication> {
  const url = new URL(`/v1/creator-releases/${encodeURIComponent(release.release_id)}`, registryUrl);
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Registry did not resolve the Release before purchase: HTTP ${response.status}`);
  }
  const publication = await response.json() as RegistryPublication;
  const exact = publication.status === "published"
    && publication.creator_id === release.creator_id
    && publication.product_id === release.product_id
    && publication.release_id === release.release_id
    && publication.release_digest === release.digest
    && typeof publication.published_at === "string"
    && Number.isFinite(Date.parse(publication.published_at));
  if (!exact) {
    throw new Error("Registry publication does not match the exact Creator Release");
  }
  return publication;
}
