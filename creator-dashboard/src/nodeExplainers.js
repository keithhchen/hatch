// Per-node explainer videos. Add a node by adding an entry; nodes without an entry show no explainer.
// Files live in public/assets/web/ and are published to OSS by Web CI (see .github/workflows/web.yml);
// `en` is the version without subtitles and the fallback for any other locale.
export const NODE_EXPLAINERS = Object.freeze({
  interview: { zh: "interview-16x9-zh.mp4", en: "interview-16x9-none.mp4", ja: "interview-16x9-ja.mp4", poster: "interview-poster.png" }
});

/** The Studio Agent role that runs each node. */
const NODE_OF_ROLE = Object.freeze({ voice: "interview" });

export const explainerNodeForRole = role => NODE_OF_ROLE[role] ?? null;

/** { src, poster } for a node in a locale, or null when the node has no video. */
export function explainerFor(node, locale, base = "/assets/web", manifest = NODE_EXPLAINERS) {
  const entry = manifest[node];
  if (!entry) return null;
  const root = base.replace(/\/$/, "");
  return { src: `${root}/${entry[locale] ?? entry.en}`, poster: `/assets/web/${entry.poster}` };
}
