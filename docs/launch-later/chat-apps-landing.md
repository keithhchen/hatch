# Landing: chat inside messaging apps (removed until the channel is live)

Removed from the landing page on 2026-11-12 because clients cannot yet chat with an Expert's AI inside
messaging apps (LINE, WhatsApp, Instagram, WeChat). Bring it back when that channel is live for clients.

## How to bring it back

The removal is one commit, made to revert cleanly:

```bash
git log --all --oneline --grep "no longer promises chat inside messaging apps"   # removal commit
git revert <that commit>
```

If later edits make the revert conflict, the full removed change is below; apply it in reverse
(`git apply -R`) or copy the pieces by hand.

## What was removed

- The "Wherever your clients are, it's there" section: a scrolling strip of platform logos (Xiaohongshu, WeChat,
  TikTok, LINE, WhatsApp, Instagram, YouTube, X, Stripe, Alipay) and the note "Works with one link. On LINE,
  WhatsApp and Instagram, clients can chat right inside the app." in en, zh and ja, with its styles.
- LINE and WhatsApp in the FAQ answer "Where do clients come from?".
- "LINE official account" as a scenario source (ja).
- DM wording: the hero's rotating word (私信 / DMs / DM), the story title "from DM to sale", and the clock event
  "answered a DM".

## The removed change

```diff
commit 1dddc6377ea5d0cc8e6b1246eceeff928b135eb8
Author: Keith Chen <keithhchen@icloud.com>
Date:   Thu Nov 12 10:49:10 2026 +0800

    The landing page no longer promises chat inside messaging apps
    
    That channel is not live for clients yet. Removed: the 'wherever your clients are' section (messaging-app logo strip and
    its note), LINE and WhatsApp in the FAQ, LINE official account as a scenario source, and DM wording (hero word, story
    title, clock event). Saved for relaunch in docs/launch-later/chat-apps-landing.md; this commit reverts cleanly.
    
    Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

diff --git a/creator-dashboard/src/web/HatchPage.tsx b/creator-dashboard/src/web/HatchPage.tsx
index ba4d1ece..8edc4226 100644
--- a/creator-dashboard/src/web/HatchPage.tsx
+++ b/creator-dashboard/src/web/HatchPage.tsx
@@ -8,19 +8,6 @@ import { landingCopy, type Lang, type LandingCopy, type Scenario } from "./landi
 const SHOW_PRICING = false;
 const LOCKUP = "/assets/web/hatch-lockup.svg";
 const LANG_NAMES: Record<Lang, string> = { zh: "中文", en: "English", ja: "日本語" };
-const PLATFORMS: [string, string, string][] = [
-  ["xiaohongshu", "小红书", "Xiaohongshu"],
-  ["wechat", "微信", "WeChat"],
-  ["tiktok", "抖音", "TikTok"],
-  ["line", "LINE", "LINE"],
-  ["whatsapp", "WhatsApp", "WhatsApp"],
-  ["instagram", "Instagram", "Instagram"],
-  ["youtube", "YouTube", "YouTube"],
-  ["x", "X", "X"],
-  ["stripe", "Stripe", "Stripe"],
-  ["alipay", "支付宝", "Alipay"],
-];
-
 function Egg({ size = 22 }: { size?: number }) {
   return (
     <svg viewBox="0 0 36 44" width={size * 0.82} height={size} aria-hidden="true">
@@ -46,16 +33,6 @@ function Typed({ text }: { text: string }) {
   );
 }
 
-function Logo({ slug, name }: { slug: string; name: string }) {
-  const [ok, setOk] = useState(true);
-  return (
-    <span className="logo">
-      {ok && <img src={`https://cdn.simpleicons.org/${slug}`} alt="" width={22} height={22} loading="lazy" onError={() => setOk(false)} />}
-      {name}
-    </span>
-  );
-}
-
 function FlipWords({ words }: { words: string[] }) {
   const [i, setI] = useState(2);
   useEffect(() => {
@@ -840,18 +817,6 @@ export default function HatchPage() {
 
       <Asset t={t} />
 
-      <section className="where">
-        <span className="pill">{t.whereLabel}</span>
-        <div className="marquee">
-          <div className="logos">
-            {[...PLATFORMS, ...PLATFORMS].map(([slug, zhName, name], i) => (
-              <Logo key={`${slug}-${i}`} slug={slug} name={lang === "zh" ? zhName : name} />
-            ))}
-          </div>
-        </div>
-        <p className="fine">{t.whereNote}</p>
-      </section>
-
       <Learn t={t} s={s} />
 
       <Stories t={t} />
diff --git a/creator-dashboard/src/web/landingCopy.ts b/creator-dashboard/src/web/landingCopy.ts
index 11e394ec..53bd19b1 100644
--- a/creator-dashboard/src/web/landingCopy.ts
+++ b/creator-dashboard/src/web/landingCopy.ts
@@ -17,14 +17,14 @@ const zh = {
   nav: { story: "它怎么接客户", learn: "它怎么学会你", pricing: "价格", faq: "常见问题", login: "登录", try: "免费试试" },
   heroEyebrow: "为专家打造的私有智能",
   heroTitleA: ["忙不过来的", "，"] as [string, string],
-  heroWords: ["私信", "咨询", "客户", "订单", "交付"],
+  heroWords: ["提问", "咨询", "客户", "订单", "交付"],
   heroTitleB: "交给你的 AI 分身。",
   heroBody: "Hatch 替专家回咨询、谈成交、做交付。按你的方法，用你的口吻。",
   pickLabel: "你是做什么的？",
   roles: ["销售", "顾问", "教练", "老师"],
   tryCta: "免费试试",
   trial: { title: "三步，拥有你的专属分身", steps: [{ title: "提交你的素材", body: "课程、文章、录音、聊天记录皆可，无需整理。" }, { title: "深度理解，专访追问", body: "提炼只存在于你经验中的判断。" }, { title: "获得你的分身链接", body: "经你确认后上线，分享给用户，由它代你解答。" }], cta: "前往 Studio", mini: { pdf: "课程讲义.pdf", link: "文章", voice: "0:42", chatA: "这个方案怎么选？", chatB: "先看预算", ask: "那次你为什么没接这个客户？", noted: "已记录", outline: ["人格与语气", "判断方式", "底线"], name: "你的分身", url: "hatch.ai/你的名字", copy: "复制", userQ: "我该先做哪一步？", aiA: "先看你的预算，再…" } },
-  storyTitle: (field: string) => `一位${field}客户，从私信到成交。`,
+  storyTitle: (field: string) => `一位${field}客户，从咨询到成交。`,
   storySteps: [
     { title: "客户从你的主页点进来", body: "放一个链接就行，不用换平台。", soon: false },
     { title: "它先用你的判断接住", body: "不是泛泛的建议，是你本人会说的那句。", soon: false },
@@ -41,7 +41,7 @@ const zh = {
   assetLabel: "它会成为你的资产",
   assetTitle: "一份会自己长大的判断。",
   vault: { items: ["你的笔记", "你的案例", "你的录音"], other: "别的模型", locked: "只为你工作" },
-  clock: { you: "你在见", youN: "1 位客户", it: "它同时在接", unit: "位", events: ["02:14 · 回了一条私信", "11:30 · 成交一单 ¥490", "21:05 · 交付一份报告"] },
+  clock: { you: "你在见", youN: "1 位客户", it: "它同时在接", unit: "位", events: ["02:14 · 回答了一个问题", "11:30 · 成交一单 ¥490", "21:05 · 交付一份报告"] },
   growth: { like: "像你", marks: ["第 1 天 · 读完你的内容", "第 30 天 · 记住 23 次纠正", "第 180 天 · 越来越像你"] },
   assets: [
     { title: "只属于你", body: "用你的方法做，只为你工作，不拿去训练别人的模型。" },
@@ -100,8 +100,6 @@ const zh = {
   ],
   storyPrefix: "给一位",
   photoTag: "图片占位 · 待生成",
-  whereLabel: "你的客户在哪里，它就在哪里",
-  whereNote: "放一个链接就能用；在 LINE、WhatsApp、Instagram，客户可以直接在原来的 App 里聊。",
   compareLabel: "跟你已经试过的有什么不同",
   compareCols: ["Hatch", "通用 AI", "自动回复", "录课程"],
   compareReplies: ["这是个很好的问题！以下是一些通用建议：1. 明确目标 2. 了解基本情况 3. 咨询专业人士……", "您好，消息已收到，顾问会尽快回复您～", "这个问题在课程第 3 章有详细讲解，欢迎购买完整课程。"],
@@ -131,7 +129,7 @@ const zh = {
     { q: "它会不会抢走我的客户？", a: "不会。它只接你本来没时间接的：重复的咨询和接不过来的单。真想找你的人，它会交给你。" },
     { q: "要花我多少时间？", a: "大约一小时的对话。读资料、写规则、出考题都由 Hatch 的 agent 来做。" },
     { q: "它说错了怎么办？", a: "上线前它要先通过你认可的考题；上线后你可以抽查和纠正，它会记住。" },
-    { q: "客户从哪里来？", a: "从你已经有的地方：小红书、公众号、LINE、Instagram、个人主页。你只要放上一个链接。" },
+    { q: "客户从哪里来？", a: "从你已经有的地方：小红书、公众号、个人主页。你只要放上一个链接。" },
     { q: "我的内容安全吗？", a: "只用来做你的 AI，不训练别的模型，不经你同意不公开，随时可以删除。" },
   ],
   finalTitle: "你花了十年练出来的判断，值得被更多人买到。",
@@ -164,14 +162,14 @@ const en: LandingCopy = {
   nav: { story: "How it takes clients", learn: "How it learns you", pricing: "Pricing", faq: "FAQ", login: "Log in", try: "Try it free" },
   heroEyebrow: "Private Intelligence for Experts",
   heroTitleA: ["Too many ", "?"] as [string, string],
-  heroWords: ["DMs", "inquiries", "clients", "orders", "deliverables"],
+  heroWords: ["questions", "inquiries", "clients", "orders", "deliverables"],
   heroTitleB: "Hand them to your AI persona.",
   heroBody: "Hatch answers inquiries, closes sales, and delivers the work for experts. Your method, your voice.",
   pickLabel: "What do you do?",
   roles: ["Sales", "Consulting", "Coaching", "Teaching"],
   tryCta: "Try it free",
   trial: { title: "Keep being you. We'll do the rest.", steps: [{ title: "Hand us what you already have", body: "Talks, posts, voice notes, client chats. No tidying up." }, { title: "We read you, then ask you", body: "We dig for the calls that only live in your head." }, { title: "Get a link to your AI", body: "It goes live only when you say so. Share it, and it answers for you." }], cta: "Start in Studio", mini: { pdf: "Course notes.pdf", link: "Article", voice: "0:42", chatA: "Which plan fits me?", chatB: "Start with budget", ask: "Why did you turn that client down?", noted: "Noted", outline: ["Voice", "How you judge", "Lines you hold"], name: "Your AI", url: "hatch.ai/you", copy: "Copy", userQ: "Where should I start?", aiA: "Start with your budget, then…" } },
-  storyTitle: (field: string) => `One ${field.toLowerCase()} client, from DM to sale.`,
+  storyTitle: (field: string) => `One ${field.toLowerCase()} client, from question to sale.`,
   storySteps: [
     { title: "A client taps the link in your bio", body: "One link. No new platform.", soon: false },
     { title: "It answers with your judgment", body: "Not generic advice. What you'd actually say.", soon: false },
@@ -188,7 +186,7 @@ const en: LandingCopy = {
   assetLabel: "It becomes an asset",
   assetTitle: "Judgment that keeps growing.",
   vault: { items: ["Your posts", "Your cases", "Your recordings"], other: "Other models", locked: "Works only for you" },
-  clock: { you: "You are seeing", youN: "1 client", it: "It is taking", unit: "", events: ["02:14 · answered a DM", "11:30 · closed a sale", "21:05 · delivered a report"] },
+  clock: { you: "You are seeing", youN: "1 client", it: "It is taking", unit: "", events: ["02:14 · answered a question", "11:30 · closed a sale", "21:05 · delivered a report"] },
   growth: { like: "Like you", marks: ["Day 1 · read your work", "Day 30 · 23 corrections kept", "Day 180 · more like you"] },
   assets: [
     { title: "Yours alone", body: "Built from your method, working only for you, never used to train anyone else's model." },
@@ -247,8 +245,6 @@ const en: LandingCopy = {
   ],
   storyPrefix: "For a",
   photoTag: "Image placeholder · to generate",
-  whereLabel: "Wherever your clients are, it's there",
-  whereNote: "Works with one link. On LINE, WhatsApp and Instagram, clients can chat right inside the app.",
   compareLabel: "How it differs from what you've tried",
   compareCols: ["Hatch", "General AI", "Auto-reply", "Courses"],
   compareReplies: ["Great question! Here are some general tips: 1. Define your goals 2. Assess your situation 3. Consult a professional…", "Hi! We got your message. An advisor will reply soon.", "This is covered in detail in Chapter 3. Get the full course to learn more."],
@@ -278,7 +274,7 @@ const en: LandingCopy = {
     { q: "Will it take my clients?", a: "No. It only takes what you had no time for: repeat inquiries and work you'd turn away. People who want you, it hands to you." },
     { q: "How much of my time does it take?", a: "About an hour of conversation. Hatch's agents do the reading, rule-writing and testing." },
     { q: "What if it gets something wrong?", a: "It must pass tests you approve before going live, and you can spot-check and correct it after." },
-    { q: "Where do clients come from?", a: "Where you already are: Instagram, LINE, WhatsApp, newsletters, your site. Just add a link." },
+    { q: "Where do clients come from?", a: "Where you already are: Instagram, newsletters, your site. Just add a link." },
     { q: "Is my content safe?", a: "Used only for your AI, never to train other models, never published without your OK, and deletable anytime." },
   ],
   finalTitle: "Judgment you spent a decade building deserves more buyers.",
@@ -309,14 +305,14 @@ const ja: LandingCopy = {
   nav: { story: "お客様の受け方", learn: "あなたの学び方", pricing: "料金", faq: "よくある質問", login: "ログイン", try: "無料で試す" },
   heroEyebrow: "専門家のためのプライベート・インテリジェンス",
   heroTitleA: ["手が回らない", "は、"] as [string, string],
-  heroWords: ["DM", "相談", "お客様", "注文", "納品"],
+  heroWords: ["質問", "相談", "お客様", "注文", "納品"],
   heroTitleB: "あなたのAI分身に。",
   heroBody: "Hatchは専門家に代わって、相談に答え、成約し、納品まで担います。あなたのやり方、あなたの言葉で。",
   pickLabel: "あなたのお仕事は？",
   roles: ["営業", "コンサル", "コーチ", "先生"],
   tryCta: "無料で試す",
   trial: { title: "あなたはそのままで。あとは任せて。", steps: [{ title: "手元にあるものを渡す", body: "講義、記事、録音、お客様とのチャット。整理は不要。" }, { title: "読み込んで、問いかける", body: "あなたの頭の中にしかない判断を、掘り起こします。" }, { title: "あなたのAIのリンクが届く", body: "公開はあなたの承認後。リンクを送れば、あなたの代わりに答えます。" }], cta: "Studioではじめる", mini: { pdf: "講義資料.pdf", link: "記事", voice: "0:42", chatA: "どのプランが合う？", chatB: "まず予算から", ask: "なぜあの依頼を断ったのですか？", noted: "記録しました", outline: ["人柄と語り口", "判断の仕方", "譲れない線"], name: "あなたのAI", url: "hatch.ai/you", copy: "コピー", userQ: "何から始めればいい？", aiA: "まず予算を見て、それから…" } },
-  storyTitle: (field: string) => `${field}のお客様、DMから成約まで。`,
+  storyTitle: (field: string) => `${field}のお客様、相談から成約まで。`,
   storySteps: [
     { title: "プロフィールのリンクから来る", body: "リンク一つ。新しいサービスは不要。", soon: false },
     { title: "あなたの判断で受け止める", body: "一般論ではなく、あなたが実際に言う一言で。", soon: false },
@@ -333,7 +329,7 @@ const ja: LandingCopy = {
   assetLabel: "あなたの資産になる",
   assetTitle: "育ち続ける、あなたの判断。",
   vault: { items: ["あなたの投稿", "あなたの事例", "あなたの録音"], other: "他のモデル", locked: "あなただけのために" },
-  clock: { you: "あなたは", youN: "1人と面談中", it: "AIは同時に", unit: "人", events: ["02:14 · DMに返信", "11:30 · 1件成約", "21:05 · レポートを納品"] },
+  clock: { you: "あなたは", youN: "1人と面談中", it: "AIは同時に", unit: "人", events: ["02:14 · 質問に回答", "11:30 · 1件成約", "21:05 · レポートを納品"] },
   growth: { like: "あなたらしさ", marks: ["1日目 · 発信を読了", "30日目 · 修正23件を記憶", "180日目 · もっとあなたらしく"] },
   assets: [
     { title: "あなただけのもの", body: "あなたのやり方でつくり、あなたのためだけに働き、他のモデルの学習には使いません。" },
@@ -392,8 +388,6 @@ const ja: LandingCopy = {
   ],
   storyPrefix: "",
   photoTag: "画像プレースホルダー · 生成予定",
-  whereLabel: "お客様がいる場所に、そのまま",
-  whereNote: "リンク一つで使えます。LINE、WhatsApp、Instagramなら、いつものアプリの中で話せます。",
   compareLabel: "これまで試したものとの違い",
   compareCols: ["Hatch", "汎用AI", "自動返信", "講座"],
   compareReplies: ["いい質問ですね！一般的なアドバイスです：1. 目標を明確に 2. 状況を整理 3. 専門家に相談……", "メッセージを受け付けました。担当者より順次ご返信します。", "この内容は講座の第3章で詳しく解説しています。ぜひ講座をご購入ください。"],
@@ -423,7 +417,7 @@ const ja: LandingCopy = {
     { q: "お客様を取られませんか？", a: "取りません。受けるのは、あなたに時間がなかった問い合わせと仕事だけ。あなたに会いたい人は、あなたにつなぎます。" },
     { q: "どのくらい時間がかかりますか？", a: "約1時間の会話です。読み込み、ルールづくり、テストはHatchのagentが行います。" },
     { q: "間違えたらどうなりますか？", a: "公開前にあなたが認めたテストに合格する必要があり、公開後もチェックと修正ができます。" },
-    { q: "お客様はどこから来ますか？", a: "あなたがすでにいる場所から。LINE、Instagram、noteなどにリンクを置くだけです。" },
+    { q: "お客様はどこから来ますか？", a: "あなたがすでにいる場所から。Instagram、noteなどにリンクを置くだけです。" },
     { q: "コンテンツは安全ですか？", a: "あなたのAIにだけ使い、他のモデルの学習には使わず、無断で公開せず、いつでも削除できます。" },
   ],
   finalTitle: "十年かけて磨いた判断を、もっと多くの人へ。",
@@ -439,13 +433,13 @@ const ja: LandingCopy = {
   contactSuccess: "ありがとうございます。近日中にご連絡します。",
   contactError: "送信できませんでした。時間をおいて再度お試しください。",
   scenarios: [
-    { field: "保険", role: 0, source: "LINE公式アカウントから", client: "子どもが生まれました。まず何の保険に入るべき？", take: "お子さんの保険から選ばなくて大丈夫です。今は医療で十分。大事なのは親の保障です。", ask: "家計の柱はどなたで、住宅ローンはあと何年ですか？", offer: { name: "家族の保障プラン 1対1", meta: "60分 · あなた本人", price: "¥15,000" }, delivered: "保障の不足分析 · 納品済み · 確認済み ✓", notify: "新しい注文 · 家族の保障プラン ¥15,000 · 家族メモ付き", interviewQ: "親が先、子どもは後と言いましたね。子どもの保険を止めた相談は、どんなケースでしたか？" },
+    { field: "保険", role: 0, source: "Instagramのプロフィールから", client: "子どもが生まれました。まず何の保険に入るべき？", take: "お子さんの保険から選ばなくて大丈夫です。今は医療で十分。大事なのは親の保障です。", ask: "家計の柱はどなたで、住宅ローンはあと何年ですか？", offer: { name: "家族の保障プラン 1対1", meta: "60分 · あなた本人", price: "¥15,000" }, delivered: "保障の不足分析 · 納品済み · 確認済み ✓", notify: "新しい注文 · 家族の保障プラン ¥15,000 · 家族メモ付き", interviewQ: "親が先、子どもは後と言いましたね。子どもの保険を止めた相談は、どんなケースでしたか？" },
     { field: "資産運用", role: 0, source: "noteの記事から", client: "2,000万円の余裕資金、どこに置くべき？", take: "どこに置くかより先に、何のためのお金かが大事です。", ask: "何年以内に使いますか？教育費、住宅、それとも老後？", offer: { name: "資産配分チェック", meta: "72時間でレポート", price: "¥20,000" }, delivered: "資産配分チェック · 納品済み · 確認済み ✓", notify: "新しい注文 · 資産配分チェック ¥20,000 · 顧客メモ付き", interviewQ: "お客様が高利回りにこだわるとき、どの一言で止めますか？" },
-    { field: "飲食経営", role: 1, source: "LINE公式アカウントから", client: "開店3か月、回転率が上がりません。", take: "回転が悪いのは、提供の遅さより、メニューで迷う時間が長いことが多いです。", ask: "客単価は？ランチとディナーはそれぞれ何割埋まっていますか？", offer: { name: "メニュー構成診断", meta: "3日で納品", price: "¥30,000" }, delivered: "メニュー構成診断 · 納品済み · 確認済み ✓", notify: "新しい注文 · メニュー診断 ¥30,000 · 店舗メモ付き", interviewQ: "初めての店に入ったとき、最初にどこを見ますか？" },
+    { field: "飲食経営", role: 1, source: "ウェブサイトから", client: "開店3か月、回転率が上がりません。", take: "回転が悪いのは、提供の遅さより、メニューで迷う時間が長いことが多いです。", ask: "客単価は？ランチとディナーはそれぞれ何割埋まっていますか？", offer: { name: "メニュー構成診断", meta: "3日で納品", price: "¥30,000" }, delivered: "メニュー構成診断 · 納品済み · 確認済み ✓", notify: "新しい注文 · メニュー診断 ¥30,000 · 店舗メモ付き", interviewQ: "初めての店に入ったとき、最初にどこを見ますか？" },
     { field: "法律", role: 1, source: "ウェブサイトから", client: "共同経営者が抜けたいと言っています。株はどう分ける？", take: "今の会社の価値より先に、最初に交わした契約を見ます。", ask: "契約に退出時の取り決めはありますか？資金調達はしていますか？", offer: { name: "共同経営者の退出相談", meta: "45分 · あなた本人", price: "¥25,000" }, delivered: "契約条項の整理 · 納品済み · 確認済み ✓", notify: "新しい注文 · 退出相談 ¥25,000 · 案件メモ付き", interviewQ: "どんなとき、「この件は争わないほうがいい」と伝えますか？" },
     { field: "キャリア", role: 2, source: "Xのプロフィールから", client: "社会人5年目、今からPMに転職できますか？", take: "できます。難しいのは年齢ではなく、なぜ転職するのかを説明することです。", ask: "今のお仕事は？転職したいと思った瞬間に何がありましたか？", offer: { name: "転職用の職務経歴書リライト", meta: "48時間で納品", price: "¥12,000" }, delivered: "職務経歴書リライト · 納品済み · チェック済み ✓", notify: "新しい注文 · 職務経歴書リライト ¥12,000 · 経歴メモ付き", interviewQ: "数秒で転職できる人か分かると言いましたね。何を見ていますか？" },
     { field: "フィットネス", role: 2, source: "Instagramのプロフィールから", client: "3か月トレーニングしても体重が変わりません。", take: "まだ量は増やさないで。3か月変わらないのは、たいてい練習より食事です。", ask: "週に何回？昨日食べたものを全部教えてください。", offer: { name: "4週間のトレーニング＋食事プラン", meta: "24時間で納品", price: "¥8,800" }, delivered: "4週間プラン · 納品済み · チェック済み ✓", notify: "新しい注文 · 4週間プラン ¥8,800 · 体組成メモ付き", interviewQ: "「ほとんど食べていない」と言われたら、次に何を聞きますか？" },
-    { field: "留学エッセイ", role: 3, source: "LINE公式アカウントから", client: "高3でEDまであと2か月、エッセイが一文字も書けていません。", take: "まだ間に合います。2か月で提出できる形にするのは可能です。完璧な素材を待たず、本当にあった出来事から始めましょう。", ask: "どの活動に一番打ち込み、一番手応えがありましたか？", offer: { name: "メインエッセイ添削", meta: "48時間で納品 · コンサルタント確認", price: "¥9,800" }, delivered: "メインエッセイ添削 · 納品済み · 確認済み ✓", notify: "新しい注文 · エッセイ添削 ¥9,800 · 生徒メモ付き", interviewQ: "真剣な生徒ほどAIを使わないと言いましたね。どの原稿でその線を引きましたか？" },
+    { field: "留学エッセイ", role: 3, source: "noteの記事から", client: "高3でEDまであと2か月、エッセイが一文字も書けていません。", take: "まだ間に合います。2か月で提出できる形にするのは可能です。完璧な素材を待たず、本当にあった出来事から始めましょう。", ask: "どの活動に一番打ち込み、一番手応えがありましたか？", offer: { name: "メインエッセイ添削", meta: "48時間で納品 · コンサルタント確認", price: "¥9,800" }, delivered: "メインエッセイ添削 · 納品済み · 確認済み ✓", notify: "新しい注文 · エッセイ添削 ¥9,800 · 生徒メモ付き", interviewQ: "真剣な生徒ほどAIを使わないと言いましたね。どの原稿でその線を引きましたか？" },
     { field: "数学の個別指導", role: 3, source: "Instagramのプロフィールから", client: "中2の子の数学が90点から70点に落ちました。すぐ塾に入れるべき？", take: "まだ急がなくて大丈夫。こんなに急に下がるときは、たいてい一つの単元でつまずいているだけです。", ask: "最近どのテストでいちばん点を落としましたか？計算ミスですか、それとも問題の意味がわからない？", offer: { name: "学習診断 + 4週間プラン", meta: "48時間でレポート · 講師が確認", price: "¥8,000" }, delivered: "学習診断レポート · 納品済み · 確認済み ✓", notify: "新しい注文 · 学習診断 ¥8,000 · 生徒プロフィール付き", interviewQ: "保護者が「うっかりミスが多いだけ」と言ったら、まずどのテストを見ますか？" },
   ],
 };
diff --git a/creator-dashboard/src/web/web.css b/creator-dashboard/src/web/web.css
index 329ab287..fba96610 100644
--- a/creator-dashboard/src/web/web.css
+++ b/creator-dashboard/src/web/web.css
@@ -106,15 +106,6 @@ button { font: inherit; color: inherit; }
 
 /* Asset: the long view */
 
-/* Where */
-.where { padding: 56px 0; text-align: center; }
-.where .fine { padding: 0 var(--pad); }
-.marquee { overflow: hidden; mask-image: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent); }
-.marquee .logos { flex-wrap: nowrap; justify-content: flex-start; width: max-content; max-width: none; animation: slide 40s linear infinite; }
-@keyframes slide { to { transform: translateX(-50%); } }
-.logos { display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; margin: 24px auto 16px; max-width: 1100px; }
-.logo { display: inline-flex; flex: none; align-items: center; gap: 10px; padding: 12px 22px; border-radius: 999px; background: var(--card); box-shadow: 0 8px 24px rgba(23, 21, 15, 0.06); font-size: 15px; font-weight: 600; }
-.logo img { display: block; }
 
 /* Generic section */
 .section { padding: clamp(72px, 9vw, 128px) var(--pad); }
```
