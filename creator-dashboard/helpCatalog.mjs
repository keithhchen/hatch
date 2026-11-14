// The Help catalog: every article and video Hatch publishes, as data. The Help pages, the Studio node explainers,
// the server's SEO head and the sitemap all read this one list; adding an item here adds it everywhere.
// Video files live in public/assets/web/ and are published to OSS by Web CI (see .github/workflows/web.yml).
// `en` is the version without subtitles and the fallback for any other locale.
export const HELP_LOCALES = Object.freeze(["en", "zh", "ja"]);
export const HELP_KINDS = Object.freeze(["video", "article"]);
export const LOCAL_MEDIA_BASE = "/assets/web";

export const HELP_ITEMS = Object.freeze([
  {
    id: "interview",
    kind: "video",
    node: "interview",
    published: "2026-11-14",
    duration: "PT1M6S",
    poster: "interview-poster.jpg",
    video: { zh: "interview-16x9-zh.mp4", en: "interview-16x9-none.mp4", ja: "interview-16x9-ja.mp4" },
    copy: {
      en: { title: "How the Interview works", description: "A one-minute look at the Interview step in Studio: Hatch asks about the judgment calls only you know, and your answers shape your Agent." },
      zh: { title: "访谈是怎么进行的", description: "一分钟了解 Studio 里的访谈：Hatch 会追问只存在于你经验中的判断，你的回答会塑造你的 Agent。" },
      ja: { title: "インタビューの進め方", description: "Studio のインタビューを 1 分で紹介。あなたの経験にしかない判断を問いかけ、その答えがあなたの Agent を形づくります。" }
    }
  }
]);

/** Page chrome per locale; `video` and `article` are the group headings. */
export const HELP_PAGE_COPY = Object.freeze({
  en: { index: "Help", description: "Videos and guides for building your Agent with Hatch.", video: "Videos", article: "Articles", notFound: "Not found" },
  zh: { index: "帮助", description: "用 Hatch 构建你的 Agent 的视频与指南。", video: "视频", article: "文章", notFound: "未找到" },
  ja: { index: "ヘルプ", description: "Hatch で Agent を作るための動画とガイド。", video: "動画", article: "記事", notFound: "見つかりません" }
});

export const helpItem = (id, items = HELP_ITEMS) => items.find(item => item.id === id) ?? null;
export const helpItemForNode = (node, items = HELP_ITEMS) => items.find(item => item.node === node && item.video) ?? null;
/** /help, /help/<id>; a non-English language is the ?lang= query. */
export const helpPath = (item, lang) => `/help${item ? `/${item.id}` : ""}${lang && lang !== "en" ? `?lang=${lang}` : ""}`;

/** An item in one locale: text falls back to English, the video to the no-subtitle file. `base` is where videos are hosted (OSS or local). */
export function localizeHelpItem(item, locale, base = LOCAL_MEDIA_BASE) {
  const root = base.replace(/\/$/, "");
  const { title, description } = item.copy[locale] ?? item.copy.en;
  return {
    id: item.id, kind: item.kind, node: item.node, published: item.published, duration: item.duration, title, description,
    ...(item.video ? { src: `${root}/${item.video[locale] ?? item.video.en}` } : {}),
    ...(item.poster ? { poster: `${LOCAL_MEDIA_BASE}/${item.poster}` } : {})
  };
}

/** Items grouped by kind, in catalog order; kinds with no item are left out. */
export function helpGroups(locale, base, items = HELP_ITEMS) {
  return HELP_KINDS
    .map(kind => ({ kind, items: items.filter(item => item.kind === kind).map(item => localizeHelpItem(item, locale, base)) }))
    .filter(group => group.items.length);
}
