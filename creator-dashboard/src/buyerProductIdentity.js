// Display identity (product name + Expert name) for buyer entitlement and order
// records. Some records carry no product/creator snapshot, and the server then
// echoes the product UUID as the name. A raw identifier is never a name: the
// public product record fills the gap, and an unknown name stays null so the UI
// can say "Untitled Agent" and omit the Expert instead of showing an ID.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function snapshotOf(record) {
  return record?.product_snapshot || record?.product || {};
}

export function recordProductId(record) {
  const snapshot = snapshotOf(record);
  return record?.product_id || snapshot.product_id || snapshot.id || null;
}

function firstName(candidates, identifiers) {
  for (const value of candidates) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text && !UUID_PATTERN.test(text) && !identifiers.has(text)) return text;
  }
  return null;
}

// record: Entitlement | Order. publicProduct: an item of GET /v1/public/products, or null.
export function resolveProductIdentity(record, publicProduct = null) {
  const snapshot = snapshotOf(record);
  const identifiers = new Set([recordProductId(record), record?.creator_id, snapshot.creator_id].filter(Boolean));
  return {
    name: firstName([
      record?.product_name, snapshot.product_name, snapshot.name,
      publicProduct?.product_name, publicProduct?.product?.name, publicProduct?.name
    ], identifiers),
    creatorName: firstName([
      record?.creator?.display_name, record?.creator?.name, record?.creator_display_name, record?.creator_name,
      snapshot.creator?.display_name, snapshot.creator?.name, snapshot.creator_name,
      publicProduct?.creator_name, publicProduct?.creator?.name
    ], identifiers)
  };
}

export function identityIsComplete(identity) {
  return Boolean(identity.name && identity.creatorName);
}

export function indexPublicProducts(payload) {
  const items = Array.isArray(payload) ? payload : Array.isArray(payload?.products) ? payload.products : [];
  return new Map(items.filter((item) => item?.product_id).map((item) => [item.product_id, item]));
}

// One catalog fetch per request function (i.e. per signed-in portal session),
// shared by every card on the page. A failed fetch is not cached, so a later
// render can retry.
export function createPublicProductDirectory(loadCatalog) {
  let pending = null;
  return function publicProductIndex() {
    if (!pending) {
      pending = Promise.resolve().then(loadCatalog).then(indexPublicProducts);
      pending.catch(() => { pending = null; });
    }
    return pending;
  };
}
