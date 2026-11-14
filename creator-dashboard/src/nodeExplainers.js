// Per-node explainer videos come from the Help catalog (../helpCatalog.mjs); a node with no catalog video shows no explainer.
import { helpItemForNode, localizeHelpItem } from "../helpCatalog.mjs";

/** The Studio Agent role that runs each node. */
const NODE_OF_ROLE = Object.freeze({ voice: "interview" });

export const explainerNodeForRole = role => NODE_OF_ROLE[role] ?? null;

/** { src, poster } for a node in a locale, or null when the node has no video. */
export function explainerFor(node, locale, base, items) {
  const item = helpItemForNode(node, items);
  if (!item) return null;
  const { src, poster } = localizeHelpItem(item, locale, base);
  return { src, poster };
}
