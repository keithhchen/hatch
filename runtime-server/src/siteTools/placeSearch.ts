import { callJson, requireString, type Fetch, type SiteLookup } from "./ports.js";

const FIELDS = "places.displayName,places.formattedAddress,places.types,places.rating,places.userRatingCount,places.googleMapsUri,places.businessStatus";

/** Business and place search on a map: up to five matches. */
export class PlaceSearch implements SiteLookup<{ query?: unknown }> {
  constructor(private readonly fetcher: Fetch, private readonly key: string) {}

  async run(args: { query?: unknown }, signal?: AbortSignal) {
    const textQuery = requireString(args.query, "query");
    const body = await callJson(this.fetcher, "https://places.googleapis.com/v1/places:searchText",
      { method: "POST", headers: { "content-type": "application/json", "X-Goog-Api-Key": this.key, "X-Goog-FieldMask": FIELDS }, body: JSON.stringify({ textQuery }) }, 30_000, signal) as
      { places?: Array<{ displayName?: { text?: string }; formattedAddress?: string; types?: string[]; rating?: number; userRatingCount?: number; googleMapsUri?: string; businessStatus?: string }> };
    return { places: (body?.places ?? []).slice(0, 5).map(place => ({ name: place.displayName?.text, address: place.formattedAddress, types: place.types, rating: place.rating, rating_count: place.userRatingCount, map_url: place.googleMapsUri, status: place.businessStatus })) };
  }
}
