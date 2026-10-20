"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { LanguageSwitcher } from "../LanguageSwitcher.jsx";
import { useLocale } from "../locale.jsx";

type Lang = "zh" | "en" | "ja";
type Example = { field: string; client: string; reply: string };
type Role = { label: string; examples: Example[] };

const TRY_HREF = "/studio";
const DEMO_HREF = "/chat/product/802f2105-e28e-4ddc-996a-0a97a7fa4bb5";

const copy = {
  zh: {
    heroTitleA: "你见客户的时候，",
    heroTitleB: "它在接下一个。",
    heroBody: "它用你的方式回咨询、筛出真客户；你接不过来的单，它按你的标准来做。",
    tryCta: "免费试试",
    tryNote: "不收月费 · 你的内容不给别人用",
    demoTag: "示例",
    demoBooked: "已为你约好 · 周四 20:00 · 附需求简介",
    roles: [
      {
        label: "销售",
        examples: [
          { field: "保险", client: "孩子刚出生，该先买什么？", reply: "先别急着挑产品。家里谁是主要收入来源？房贷还有多少年？" },
          { field: "财富管理", client: "手上有 200 万，放香港还是放国内？", reply: "先说用途：这笔钱几年内会用到吗？是给孩子读书，还是养老？" },
          { field: "房产", client: "预算 500 万，学区和通勤只能选一个？", reply: "孩子现在几岁？你们两个人每天在哪里上班？" },
          { field: "医美", client: "法令纹做填充还是线雕？", reply: "能接受多久的恢复期？之前做过什么项目吗？" },
        ],
      },
      {
        label: "顾问",
        examples: [
          { field: "餐饮经营", client: "新店开了三个月，翻台率上不去。", reply: "客单价多少？午市和晚市各坐满几成？" },
          { field: "法律", client: "合伙人要退出，股份怎么算？", reply: "当初的合伙协议里，写了退出条款吗？" },
          { field: "财税", client: "个体户转公司，税会高多少？", reply: "去年营收大概多少？成本里能开票的占几成？" },
          { field: "出海", client: "想在日本开公司，从哪一步开始？", reply: "你做什么业务？需要本人去日本常驻吗？" },
        ],
      },
      {
        label: "教练",
        examples: [
          { field: "职业发展", client: "工作五年，想转产品经理来得及吗？", reply: "来得及。你现在做什么？最想转的原因是什么？" },
          { field: "健身", client: "练了三个月，体重一点没变。", reply: "说说你一周练几次，每天大概吃些什么？" },
          { field: "销售教练", client: "客户总说“我再考虑考虑”。", reply: "把你们最后那几句对话原样发我，我们看卡在哪。" },
          { field: "情感", client: "吵架后他三天没回消息。", reply: "先说说，这次吵的是什么？" },
        ],
      },
      {
        label: "老师",
        examples: [
          { field: "留学文书", client: "高三了，文书一个字没写，还来得及吗？", reply: "来得及，先别急着写。你最投入的那件事是什么？" },
          { field: "雅思", client: "作文一直 6 分，怎么上 7？", reply: "发一篇你最近写的给我，我先看卡在哪。" },
          { field: "日本受验", client: "评定不高，还能冲推荐入学吗？", reply: "志望校是哪几所？现在的评定平均是多少？" },
          { field: "作品集", client: "跨专业申设计，作品集从哪开始？", reply: "本科学什么的？目标学校有哪几所？" },
        ],
      },
    ] as Role[],
    painLabel: "你是不是这样",
    pains: ["每天回 3 小时私信，成交没几单。", "批改卖爆了，两个人做不过来，只能停。"],
    helpLabel: "它能帮你做什么",
    helps: [
      { label: "成交前", body: "替你回那些重复的问题，把真想买的约给你。" },
      { label: "成交后", body: "替你接那些接不过来的单，你定价、你抽查。" },
    ],
    howLabel: "怎么做出来",
    howTitle: "你跟它聊一小时，它就学会你是怎么判断的。",
    howSteps: ["先读你发过的内容", "一次只问一个问题，追问你怎么判断", "自己出题考自己，考过了才上线"],
    howNote: "它不碰你收费的工作，只干你本来就没钱拿的那部分。",
    demoLabel: "先试一个",
    demoTitle: "跟一位留学顾问的 AI 聊两句。",
    demoBody: "看它怎么追问、怎么判断。",
    demoCta: "去聊聊",
    finalTitle: "首批 30 位，我们陪你一起做。",
    finalBody: "不收月费。你赚钱，我们才赚钱。",
    partnerLink: "机构合作",
    contactLabel: "START A CONVERSATION",
    contactTitle: "一起 Hatch 点什么。",
    contactFields: {
      name: "姓名",
      email: "邮箱",
      partnerType: "你的身份是什么？",
      message: "想做的产品、已有的内容资产，或任何想告诉我们的事（选填）",
    },
    contactOptions: ["Expert", "内容版权方、媒体/IP 机构或 Expert 渠道方", "投资人"],
    contactClose: "关闭",
    contactSubmit: "发送信息",
    contactSending: "正在发送…",
    contactSuccess: "收到。我们会尽快联系你。",
    contactError: "暂时没有发送成功，请稍后再试。",
  },
  en: {
    heroTitleA: "While you're with a client,",
    heroTitleB: "it takes the next one.",
    heroBody:
      "It answers inquiries your way and finds the real buyers. The work you can't take on, it does to your standard.",
    tryCta: "Try it free",
    tryNote: "No monthly fee · Your content is never shared",
    demoTag: "Example",
    demoBooked: "Booked for you · Thu 8:00 pm · brief attached",
    roles: [
      {
        label: "Sales",
        examples: [
          { field: "Insurance", client: "We just had a baby. What should we buy first?", reply: "Before any product: who's the main earner, and how many years are left on the mortgage?" },
          { field: "Wealth", client: "I have $300k. Hong Kong or keep it at home?", reply: "First, when will you need this money? School fees, or retirement?" },
          { field: "Real estate", client: "Good schools or a short commute. Can't have both?", reply: "How old is your child, and where do you both work?" },
          { field: "Aesthetics", client: "Filler or thread lift for smile lines?", reply: "How much downtime can you accept? Any treatments before?" },
        ],
      },
      {
        label: "Consulting",
        examples: [
          { field: "Restaurants", client: "Three months in, our table turnover is stuck.", reply: "What's your average check? How full are lunch and dinner?" },
          { field: "Law", client: "My partner wants out. How do we split the shares?", reply: "Does your partnership agreement have an exit clause?" },
          { field: "Tax", client: "Sole trader to company: how much more tax?", reply: "Roughly what was last year's revenue, and how much of your cost is invoiced?" },
          { field: "Going global", client: "I want to set up in Japan. Where do I start?", reply: "What's the business, and do you need to live there?" },
        ],
      },
      {
        label: "Coaching",
        examples: [
          { field: "Career", client: "Five years in. Too late to move into product?", reply: "Not too late. What do you do now, and why product?" },
          { field: "Fitness", client: "Three months of training, zero weight change.", reply: "How often do you train, and what does a normal day of eating look like?" },
          { field: "Sales coaching", client: "Clients keep saying 'let me think about it.'", reply: "Send me the last few lines of that conversation, word for word." },
          { field: "Relationships", client: "He hasn't replied for three days since our fight.", reply: "First, what was the fight about?" },
        ],
      },
      {
        label: "Teaching",
        examples: [
          { field: "College essays", client: "Senior year, no essay yet. Is it too late?", reply: "It's not. Don't start writing yet. What do you care about most?" },
          { field: "IELTS", client: "Stuck at 6 in writing. How do I get a 7?", reply: "Send me your latest essay. I'll show you where it's stuck." },
          { field: "Japan admissions", client: "Low grades. Can I still try for a recommendation?", reply: "Which schools, and what's your current grade average?" },
          { field: "Portfolios", client: "Switching into design. Where does a portfolio start?", reply: "What did you study, and which schools are you aiming for?" },
        ],
      },
    ] as Role[],
    painLabel: "Sound familiar?",
    pains: ["Three hours of DMs a day, hardly any sales.", "Your review service sold out, and you had to shut it down."],
    helpLabel: "What it does for you",
    helps: [
      { label: "Before the sale", body: "Answers the repeat questions and books the real buyers with you." },
      { label: "After the sale", body: "Takes the work you can't take on. You set the price and spot-check." },
    ],
    howLabel: "How it gets made",
    howTitle: "Talk with it for an hour. It learns how you make calls.",
    howSteps: ["Reads what you've published", "Asks one question at a time, and digs into your reasoning", "Tests itself, and goes live only when it passes"],
    howNote: "It never touches your paid work, only the part you were never paid for.",
    demoLabel: "Try one first",
    demoTitle: "Chat with an admissions consultant's AI.",
    demoBody: "See how it asks and how it judges.",
    demoCta: "Start a chat",
    finalTitle: "Our first 30 experts get us beside them.",
    finalBody: "No monthly fee. We earn only when you earn.",
    partnerLink: "For organizations",
    contactLabel: "START A CONVERSATION",
    contactTitle: "Let's hatch something.",
    contactFields: {
      name: "Name",
      email: "Email",
      partnerType: "Which best describes you?",
      message: "A product, asset, or idea you'd like to explore (optional)",
    },
    contactOptions: ["Expert", "Content rights holder, media/IP organization, or expert channel", "Investor"],
    contactClose: "Close",
    contactSubmit: "Send",
    contactSending: "Sending…",
    contactSuccess: "Thanks—we'll be in touch soon.",
    contactError: "Something went wrong. Please try again.",
  },
  ja: {
    heroTitleA: "あなたが接客している間に、",
    heroTitleB: "次の一人を受けてくれる。",
    heroBody: "あなたのやり方で問い合わせに答え、本気のお客様を見極める。手が回らない仕事は、あなたの基準でこなします。",
    tryCta: "無料で試す",
    tryNote: "月額費用なし · あなたのコンテンツは他に使いません",
    demoTag: "例",
    demoBooked: "予約済み · 木曜 20:00 · 相談内容のメモ付き",
    roles: [
      {
        label: "営業",
        examples: [
          { field: "保険", client: "子どもが生まれました。まず何に入るべき？", reply: "商品の前に。家計の柱はどなたで、住宅ローンはあと何年ですか？" },
          { field: "資産運用", client: "2,000万円、香港と国内どちらに置くべき？", reply: "まず使い道から。何年以内に使う予定のお金ですか？" },
          { field: "不動産", client: "学区と通勤、どちらかしか選べない？", reply: "お子さんは何歳で、お二人の勤務地はどこですか？" },
          { field: "美容医療", client: "ほうれい線、ヒアルロン酸と糸リフトどっち？", reply: "ダウンタイムはどのくらいまで大丈夫ですか？" },
        ],
      },
      {
        label: "コンサル",
        examples: [
          { field: "飲食経営", client: "開店3か月、回転率が上がりません。", reply: "客単価は？ランチとディナーはそれぞれ何割埋まっていますか？" },
          { field: "法律", client: "共同経営者が抜けたい。株はどう分ける？", reply: "最初の契約に、退出時の取り決めはありますか？" },
          { field: "税務", client: "個人事業から法人化すると税金は増える？", reply: "昨年の売上と、経費の内訳を教えてください。" },
          { field: "海外進出", client: "中国で事業を始めたい。何から？", reply: "どんな事業で、現地に常駐する予定はありますか？" },
        ],
      },
      {
        label: "コーチ",
        examples: [
          { field: "キャリア", client: "社会人5年目、今からPMに転職できる？", reply: "できます。今のお仕事と、PMを目指す理由は？" },
          { field: "フィットネス", client: "3か月トレーニングしても体重が変わらない。", reply: "週に何回、普段どんな食事をしていますか？" },
          { field: "営業コーチ", client: "「検討します」で毎回止まります。", reply: "最後のやりとりを、そのまま送ってください。" },
          { field: "恋愛", client: "けんかしてから3日返信がない。", reply: "まず、何がきっかけでしたか？" },
        ],
      },
      {
        label: "先生",
        examples: [
          { field: "留学エッセイ", client: "高3でエッセイが一文字も書けていません。", reply: "まだ間に合います。まず、一番打ち込んだことは何ですか？" },
          { field: "IELTS", client: "ライティングが6から上がりません。", reply: "最近書いたものを一本送ってください。どこで止まっているか見ます。" },
          { field: "受験", client: "評定が低くても推薦は狙えますか？", reply: "志望校はどこで、今の評定平均はいくつですか？" },
          { field: "ポートフォリオ", client: "他分野からデザインへ。何から作れば？", reply: "大学での専攻と、志望校を教えてください。" },
        ],
      },
    ] as Role[],
    painLabel: "こんなことはありませんか",
    pains: ["毎日3時間DMを返しても、成約はわずか。", "添削サービスが売れすぎて、二人では回らず止めた。"],
    helpLabel: "できること",
    helps: [
      { label: "成約まで", body: "よくある質問に答え、本気のお客様をあなたの予約につなぎます。" },
      { label: "成約のあと", body: "手が回らない仕事を引き受けます。価格もチェックもあなた次第。" },
    ],
    howLabel: "つくり方",
    howTitle: "1時間話すだけで、あなたの判断の仕方を覚えます。",
    howSteps: ["あなたの発信を読み込む", "一度に一つずつ質問し、判断の理由を掘り下げる", "自分でテストし、合格してから公開"],
    howNote: "あなたの有料の仕事には触れません。もともとお金にならなかった部分だけを担います。",
    demoLabel: "まず試す",
    demoTitle: "留学コンサルタントのAIと話してみる。",
    demoBody: "どう質問し、どう判断するかを見てください。",
    demoCta: "話してみる",
    finalTitle: "最初の30名と、一緒につくります。",
    finalBody: "月額費用なし。あなたが稼いだときだけ、私たちも稼ぎます。",
    partnerLink: "法人の方",
    contactLabel: "START A CONVERSATION",
    contactTitle: "一緒に、何かをHatchしよう。",
    contactFields: {
      name: "お名前",
      email: "メールアドレス",
      partnerType: "あなたについて",
      message: "つくりたいプロダクトやお持ちのコンテンツなど（任意）",
    },
    contactOptions: ["Expert", "コンテンツ権利者・メディア/IP企業・Expertチャネル", "投資家"],
    contactClose: "閉じる",
    contactSubmit: "送信する",
    contactSending: "送信中…",
    contactSuccess: "ありがとうございます。近日中にご連絡します。",
    contactError: "送信できませんでした。時間をおいて再度お試しください。",
  },
};

function DemoChat({ t }: { t: (typeof copy)[Lang] }) {
  const [role, setRole] = useState(t.roles.length - 1);
  const [index, setIndex] = useState(0);
  const examples = t.roles[role].examples;
  const example = examples[index % examples.length];

  useEffect(() => {
    const timer = window.setInterval(() => setIndex((i) => i + 1), 4200);
    return () => window.clearInterval(timer);
  }, [role]);

  return (
    <div className="lp-demo">
      <div className="lp-roles" role="tablist">
        {t.roles.map((r, i) => (
          <button
            key={r.label}
            type="button"
            role="tab"
            aria-selected={i === role}
            className={i === role ? "active" : ""}
            onClick={() => {
              setRole(i);
              setIndex(0);
            }}
          >
            {r.label}
          </button>
        ))}
      </div>
      <div className="lp-chat" key={`${role}-${index % examples.length}`}>
        <div className="lp-chat-head">
          <span>{example.field}</span>
          <em>{t.demoTag}</em>
        </div>
        <p className="lp-bubble lp-bubble-client">{example.client}</p>
        <p className="lp-bubble lp-bubble-agent">{example.reply}</p>
        <p className="lp-booked">✓ {t.demoBooked}</p>
      </div>
      <div className="lp-fields">
        {examples.map((e, i) => (
          <button
            key={e.field}
            type="button"
            className={i === index % examples.length ? "active" : ""}
            onClick={() => setIndex(i)}
          >
            {e.field}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function HatchPage() {
  const { locale: lang } = useLocale();
  const [contactStatus, setContactStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [isContactDialogOpen, setIsContactDialogOpen] = useState(false);
  const contactDialogRef = useRef<HTMLDialogElement>(null);
  const t = copy[lang as Lang];

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Hatch — AI products for expert creators";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  useEffect(() => {
    const dialog = contactDialogRef.current;
    if (!dialog) return;
    if (isContactDialogOpen && !dialog.open) dialog.showModal();
    if (!isContactDialogOpen && dialog.open) dialog.close();
  }, [isContactDialogOpen]);

  async function handleContactSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setContactStatus("submitting");
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.get("name"),
          email: data.get("email"),
          partnerType: data.get("partnerType"),
          message: data.get("message"),
          website: data.get("website"),
          language: lang,
        }),
      });
      if (!response.ok) throw new Error("Contact submission failed");
      form.reset();
      setContactStatus("success");
    } catch {
      setContactStatus("error");
    }
  }

  function openContactDialog() {
    setContactStatus("idle");
    setIsContactDialogOpen(true);
  }

  const tryButton = (
    <a className="hero-cta hero-cta-primary" href={TRY_HREF}>
      {t.tryCta}
      <span className="cta-arrow" aria-hidden="true">→</span>
    </a>
  );

  return (
    <main className={`site is-${lang}`}>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Hatch home">
          Hatch<span className="brand-dot">.</span>
        </a>
        <span />
        <LanguageSwitcher className="lang-switch" compact />
      </header>

      <section className="hero lp-hero" id="top">
        <div className="lp-hero-grid">
          <div>
            <h1>
              <span>{t.heroTitleA}</span>
              <em>{t.heroTitleB}</em>
            </h1>
            <p className="hero-body">{t.heroBody}</p>
            <div className="lp-actions">
              {tryButton}
              <p className="lp-note">{t.tryNote}</p>
            </div>
          </div>
          <DemoChat key={lang} t={t} />
        </div>
      </section>

      <section className="lp-band">
        <div className="lp-col">
          <p className="eyebrow">{t.painLabel}</p>
          {t.pains.map((pain) => (
            <h2 className="lp-pain" key={pain}>{pain}</h2>
          ))}
        </div>
        <div className="lp-col">
          <p className="eyebrow">{t.helpLabel}</p>
          {t.helps.map((help) => (
            <div className="lp-help" key={help.label}>
              <span>{help.label}</span>
              <p>{help.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-how">
        <p className="eyebrow">{t.howLabel}</p>
        <h2 className="display-title">{t.howTitle}</h2>
        <ol className="lp-steps">
          {t.howSteps.map((step, i) => (
            <li key={step}>
              <span>0{i + 1}</span>
              {step}
            </li>
          ))}
        </ol>
        <p className="lp-reassure">{t.howNote}</p>
      </section>

      <section className="lp-try">
        <div>
          <p className="eyebrow">{t.demoLabel}</p>
          <h2>{t.demoTitle}</h2>
          <p>{t.demoBody}</p>
        </div>
        <a className="hero-cta hero-cta-secondary" href={DEMO_HREF}>
          {t.demoCta}
          <span className="cta-arrow" aria-hidden="true">→</span>
        </a>
      </section>

      <section className="lp-final">
        <h2 className="display-title">{t.finalTitle}</h2>
        <p>{t.finalBody}</p>
        <div className="lp-actions">
          {tryButton}
          <button className="text-link lp-partner" type="button" onClick={openContactDialog}>
            {t.partnerLink} →
          </button>
        </div>
      </section>

      <dialog
        className="contact-dialog"
        ref={contactDialogRef}
        aria-labelledby="contact-dialog-title"
        onClose={() => setIsContactDialogOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <div className="contact-dialog-inner">
          <div className="contact-dialog-heading">
            <p className="eyebrow">{t.contactLabel}</p>
            <button
              className="contact-dialog-close"
              type="button"
              onClick={() => contactDialogRef.current?.close()}
              aria-label={t.contactClose}
            >
              ×
            </button>
          </div>
          <div className="contact-copy">
            <h3 id="contact-dialog-title">{t.contactTitle}</h3>
            <form className="contact-form" onSubmit={handleContactSubmit}>
              <label className="contact-field">
                <span>{t.contactFields.name}</span>
                <input name="name" autoComplete="name" required maxLength={100} />
              </label>
              <label className="contact-field">
                <span>{t.contactFields.email}</span>
                <input name="email" type="email" autoComplete="email" required maxLength={320} />
              </label>
              <label className="contact-field">
                <span>{t.contactFields.partnerType}</span>
                <select name="partnerType" defaultValue="" required>
                  <option value="" disabled>
                    —
                  </option>
                  {t.contactOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label className="contact-field contact-message">
                <span>{t.contactFields.message}</span>
                <textarea name="message" rows={4} maxLength={4000} />
              </label>
              <input className="contact-honeypot" name="website" type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" />
              <div className="contact-actions">
                <button type="submit" disabled={contactStatus === "submitting"}>
                  {contactStatus === "submitting" ? t.contactSending : t.contactSubmit}
                  <span aria-hidden="true">→</span>
                </button>
                <p className={`contact-status ${contactStatus}`} aria-live="polite">
                  {contactStatus === "success" ? t.contactSuccess : contactStatus === "error" ? t.contactError : ""}
                </p>
              </div>
            </form>
          </div>
        </div>
      </dialog>

      <footer>
        <div>
          <a className="brand footer-brand" href="#top">
            Hatch<span className="brand-dot">.</span>
          </a>
        </div>
      </footer>
    </main>
  );
}
