/**
 * Creator / Agent presentation identity, resolved from whatever the host has:
 * an access record, a public product detail, or a Runtime session projection.
 * The fallback chain is the union of Desktop product-policy and Web chat.
 */
export const DEFAULT_CREATOR_IDENTITY = Object.freeze({
  productName: "Expert Agent",
  creatorName: "Hatch Expert",
  description: "Work with this Expert Agent in your own files and context."
});

const first = (...values) => values.find(value => typeof value === "string" ? value.trim() : value != null);

export function creatorInitials(name) {
  return String(name ?? "").trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() || "").join("") || "C";
}

/**
 * @param {{ access?: object, product?: object, defaults?: Partial<typeof DEFAULT_CREATOR_IDENTITY> }} sources
 */
export function resolveCreatorIdentity({ access, product, defaults = {} } = {}) {
  const fallback = { ...DEFAULT_CREATOR_IDENTITY, ...defaults };
  const source = access?.product ?? product;
  const creator = access?.creator ?? source?.creator ?? {};
  const creatorName = first(creator.name, creator.display_name, source?.creator_name, fallback.creatorName);
  return Object.freeze({
    productId: first(source?.id, source?.product_id, access?.product_id) ?? null,
    productName: first(source?.name, source?.product_name, source?.product?.name, access?.product_name, fallback.productName),
    creatorName,
    creatorInitials: creatorInitials(creatorName),
    creatorAvatarUrl: first(creator.avatar_url, creator.image_url, access?.creator_avatar_url, source?.creator_avatar_url) ?? null,
    description: first(source?.description, fallback.description),
    promise: source?.promise ?? null,
    presentation: access?.presentation ?? source?.presentation ?? {},
    briefSpec: access?.brief_spec ?? source?.brief_spec ?? null
  });
}

/** Identity from a Runtime `session.ready.creator_agent` projection, or null. */
export function creatorIdentityFromSession(message, defaults) {
  const agent = message?.creator_agent;
  if (!agent?.creator?.name || !agent?.product?.name) return null;
  return resolveCreatorIdentity({ access: { creator: agent.creator, product: agent.product, presentation: agent.presentation }, defaults });
}

/**
 * A Runtime projection may refine the identity, but only when the host's
 * binding check accepts it; it never replaces a known identity with a fallback.
 * `matchesBinding(message)` is host-owned so access semantics stay outside.
 */
export function refineCreatorIdentity(current, message, matchesBinding) {
  const runtime = creatorIdentityFromSession(message);
  if (!runtime || !matchesBinding(message)) return current;
  return Object.freeze({ ...runtime, creatorAvatarUrl: runtime.creatorAvatarUrl ?? current?.creatorAvatarUrl ?? null });
}
