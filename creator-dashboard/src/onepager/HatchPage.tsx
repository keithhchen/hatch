"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Lang } from "./locale";
import { jaCopy } from "./copy.ja";

const copy = {
  zh: {
    meta: "EXPERT CREATOR ECONOMY",
    nav: ["产品缺口", "如何创建", "用户访谈", "商业模式", "长期愿景", "合作伙伴", "联系"],
    read: "继续阅读",
    exploreCreators: "探索 Creator",
    buildProduct: "创建你的 Expert 产品",
    contactLink: "联系 Hatch",
    heroTitleA: "把知识付费",
    heroTitleB: "变成能干活的 Agent。",
    heroBody:
      "Hatch 让已经拥有受众的 Expert Creator，把自己的方法做成可收费、能交付成果的 Agent——无需组建软件团队，也不必亲自完成每一次服务。",
    heroFilmLabel: "Hatch 产品发布影片",
        heroFilmPoster: "/assets/onepager/hatch-launch-poster.jpg",
        heroFilmSrc: "/assets/onepager/hatch-launch-zh.mp4",
    continuum: [
      {
        label: "COURSE",
        title: "课程",
        body: "可以规模化，但每个人得到的是同一套内容。",
      },
      {
        label: "HATCH AGENT",
        title: "Agent 产品",
        body: "按照 Creator 的标准，针对用户 Context 完成工作。",
      },
      {
        label: "CONSULTING",
        title: "咨询",
        body: "可以解决具体问题，但依赖 Creator 本人的时间。",
      },
    ],
    continuumBridge: "两者之间缺失的产品层",
    gapEyebrow: "01 · THE PRODUCT GAP",
    gapTitle: "Creator 有了受众之后，\n还能卖什么？",
    gapBody:
      "Expert Creator 已经可以通过社交媒体、课程、社群和 Newsletter 建立信任与分发。但他们仍然只能在可规模化的内容，与高价值却无法规模化的本人服务之间选择。",
    gapBody2:
      "与此同时，用户已经在把 Creator 的公开视频、文章和方法交给通用 AI，请它修改材料、生成方案或完成工作。需求并没有消失，但由 AI 产生的使用和收入正在绕过 Creator。",
    gapQuote:
      "Creator Economy 已经解决了“谁拥有受众”；Hatch 要解决的是：Creator 接下来能够卖什么，以及如何规模化交付。",
    gapList: [
      ["内容与课程", "规模化，但个性化交付很浅。"],
      ["咨询、批改与陪跑", "更接近结果，但受限于本人时间。"],
      ["Prompt 与 Skill", "容易复制、安装门槛高，也不是完整消费产品。"],
    ],
    productEyebrow: "02 · THE PLATFORM",
    productTitle: "Creator 自己创建。\nHatch 在背后运行。",
    productBody:
      "Hatch 是标准化平台，不是定制 Agent 工作室，也不做以 Hatch 为中心的 Consumer Marketplace。Creator 的身份、风格和产品体验始终在前。",
    productPrinciple:
      "Hatch 不先复制一个完整的人，再为分身寻找用途。它先确定用户愿意付费让这位 Creator 完成什么，再提取这项产品所需要的方法、判断、数据、工具和人工介入。",
    processIntro:
      "把一套方法做成真正可用、可收费的产品，通常需要产品设计、Agent 工程、质量评估、支付和持续运营。Hatch 将这套工作变成 Creator 可以自行完成的标准流程。",
    steps: [
      {
        n: "01",
        title: "定义产品",
        body: "明确谁会购买、交付什么、如何收费、什么算合格，以及什么时候必须由本人介入。",
      },
      {
        n: "02",
        title: "导入方法",
        body: "导入课程、案例、历史交付、修改记录和专有数据；Interview Agent 围绕真实案例补齐隐性判断。",
      },
      {
        n: "03",
        title: "生成并校准",
        body: "Hatch 组合方法、数据、工具和工作流，并生成 Expert Evals；Creator 通过比较和修改校准自己的标准。",
      },
      {
        n: "04",
        title: "发布与收费",
        body: "设定价格，生成产品页面与链接，再放入社交媒体、课程、社群或网站。",
      },
      {
        n: "05",
        title: "持续交付",
        body: "Agent 完成主要工作，Creator 处理边界案例；真实纠正继续更新产品的标准与边界。",
      },
    ],
    skillLabel: "A SKILL IS NOT YET A PRODUCT",
    skillTitle: "一份 Skill 太薄了。",
    skillBody:
      "Skill 通常只能装下一套 SOP、instructions 或 taste。真正能工作的专家产品，还可能需要专有数据库、工具、历史案例和 Eval。",
    fullProduct:
      "Hatch 把这些能力放进一个低摩擦、可支付、受控运行的完整体验。用户得到成果，却不必安装 Skill，也拿不到 Creator 的底层方法与数据。",
    workExamples: [
      "改好的简历",
      "Growth Audit",
      "健身计划",
      "短视频脚本",
      "模拟面试",
      "股票分析",
      "销售话术",
      "内容日历",
      "课程作业批改",
      "品牌 Brief",
      "Notion 知识库",
      "写作 Review",
      "短视频剪辑",
      "营销诊断",
      "合同红线稿",
      "谈判策略",
      "定价方案",
      "用户研究报告",
      "Pitch Deck",
      "分镜脚本",
      "饮食计划",
      "产品体验诊断",
      "播客粗剪",
      "品牌命名清单",
    ],
    interviewEyebrow: "03 · USER INTERVIEWS",
    interviewTitle: "真实的创作者访谈，\n指向产品缺口。",
    interviews: [
      {
        role: "EXAM EDUCATOR",
        stat: "¥800",
        suffix: "／月",
        evidenceLabel: "受访者原有定价",
        title: "需求已经存在，产能却跟不上。",
        body: "一位考试教学博主在录播课之外推出作业批改服务。上线后即有数十名学生付费，却因团队没有足够时间交付而关闭。",
        insight:
          "考试知识与评分规则都能免费找到；学生购买的是她对拿分细节的选择、反复强调和具体反馈。",
      },
      {
        role: "GROWTH MARKETING PROFESSIONAL",
        stat: "¥100K+",
        suffix: "／企业项目",
        evidenceLabel: "受访者原有定价",
        title: "“有企业问我，能不能买我的 Skill。",
        body: "但我不能把它当文件卖——很容易被复制、盗版，也会把原本高价值的方法压成几百块的数字产品。",
        insight:
          "我想让客户付费使用这套方法，而不是买走它。”",
      },
    ],
    expertLabel: "WHAT MAKES AN EXPERT DIFFERENT",
    expertTitle: "不是知道得更多，而是选择不同。",
    expertBody:
      "Creator Agent 不需要在普世意义上“优于”通用模型。不同的股票分析者有不同策略，不同的健身 Creator 有不同流派。通用模型倾向于把答案写满；Expert 的价值往往在于他给什么更高权重、注意哪些容易被忽视的细节，以及知道什么应该留白、删除或根本不做。",
    expertEval:
      "Hatch 的 Eval 不追求证明某位 Creator 拥有普世意义上的“最佳答案”，而是验证他的差异能否被稳定体现，Agent 能否按其标准交付他愿意认可的成果，以及用户是否愿意为这种差异付费。",
    businessEyebrow: "04 · BUSINESS MODEL",
    businessTitle: "Creator 获得收入，\nHatch 才获得收入。",
    businessBody:
      "Creator 自行定义产品、价格和体验，并通过已有受众分发。最终用户按次购买或订阅某一位 Creator 的 Agent；Hatch 不收固定月费，也不运营面向消费者的 Agent Marketplace，而是从交易收入中获得 10%。",
    businessFacts: [
      {
        stat: "10%",
        label: "Hatch transaction share",
        body: "无固定月费；按次购买或订阅均由具体产品的 Value Proposition 决定。",
      },
      {
        stat: "300K+",
        label: "Patreon creators",
        body: "近 8,000 万粉丝，每年向 Creator 支付超过 20 亿美元。",
      },
      {
        stat: "5M",
        label: "Substack paid subscriptions",
        body: "Creator 保留订阅收入的 90%（支付处理费另计）。",
      },
    ],
    businessClosing:
      "这些平台主要帮助 Creator 销售内容与会员。Hatch 要增加下一类商品：能够读取用户 Context、执行工作并交付成果的 Creator Agent。",
    scale:
      "Hatch 的增长不来自软件席位，而来自 Creator 持续产生的 AI Agent GMV。",
    visionBody:
      "过去，一位专家要把自己的服务变成可规模化产品，要么亲自交付，要么组建产品、工程、运营和服务团队。Hatch 把这套产品化与履约能力标准化，让 Creator 可以自行创建、发布和经营自己的 AI 产品。",
    final:
      "Hatch 是 Expert Creator Economy 的产品、履约与交易基础设施。Expert Creator 无需组建软件团队，也能拥有一个持续创收的 AI 产品。",
    founderLabel: "WHY HATCH",
    founder: [
      "Hatch 源于创始人跨领域的实践。早年参与家族教育企业的经营，做过课程、培训与 coaching，也亲历过优质内容被盗版和复制。",
      "MBA 毕业后，他主导了多家不同领域企业的 AI 部署，长期工作于多模态、模型推理、方法论、流程管理与评测标准的交叉地带。",
      "他相信：当公开知识可以被通用 AI 轻易复制，Hatch 可以帮助专家蒸馏自己的选择、标准与方法，并将其变成可持续创收的 AI 产品。",
    ],
    partnersKicker: "一起 Hatch 点什么。",
    partnersLabel: "WHO WE WANT TO PARTNER WITH",
    partnersTitle: "我们希望与谁合作",
    partnerTypes: [
      {
        label: "CREATORS",
        title: "已有受众、方法与服务的创作者",
        body: "将课程、咨询或内容，延展为自己的 Agent 产品。",
      },
      {
        label: "INSTITUTIONS",
        title: "内容版权方、媒体/IP 机构或创作者渠道方",
        body: "让成熟内容资产，或一批 Creator 的方法，变成新的 Agent 产品。",
      },
    ],
    contactLabel: "START A CONVERSATION",
    contactTitle: "一起 Hatch 点什么。",
    contactBody:
      "如果你看到了合作的可能、认识我们该见的人，或只是想继续聊聊，欢迎留个联系方式。",
    contactFields: {
      name: "姓名",
      email: "邮箱",
      partnerType: "你的身份是什么？",
      message: "想做的产品、已有的内容资产，或任何想告诉我们的事（选填）",
    },
    contactOptions: ["创作者", "内容版权方、媒体/IP 机构或创作者渠道方", "投资人"],
    contactLaunch: "联系 Hatch",
    contactClose: "关闭",
    contactSubmit: "发送信息",
    contactSending: "正在发送…",
    contactSuccess: "收到。我们会尽快联系你。",
    contactError: "暂时没有发送成功，请稍后再试。",
  },
  en: {
    meta: "EXPERT CREATOR ECONOMY",
    nav: ["The gap", "How it works", "Interviews", "Business model", "Vision", "Partners", "Contact"],
    read: "Read the thesis",
    exploreCreators: "Explore creators",
    buildProduct: "Build your own expert product",
    contactLink: "Contact Hatch",
    heroTitleA: "Turn knowledge products",
    heroTitleB: "into agents that do the work.",
    heroBody:
      "Hatch lets expert creators with an audience turn their methods into paid agents that deliver usable work—without a software team or doing every job themselves.",
    heroFilmLabel: "Hatch product launch film",
    heroFilmPoster: "/assets/onepager/hatch-launch-poster.jpg",
    heroFilmSrc: "/assets/onepager/hatch-launch-en.mp4",
    continuum: [
      {
        label: "COURSE",
        title: "Courses",
        body: "They scale, but everyone gets the same material.",
      },
      {
        label: "HATCH AGENT",
        title: "Agent products",
        body: "They use each user’s context and follow the creator’s standards.",
      },
      {
        label: "CONSULTING",
        title: "Consulting",
        body: "It solves specific problems, but depends on the creator’s time.",
      },
    ],
    continuumBridge: "The missing layer between them",
    gapEyebrow: "01 · THE PRODUCT GAP",
    gapTitle: "Creators own the audience.\nWhat can they sell next?",
    gapBody:
      "Expert creators already build trust and reach through social media, courses, communities, and newsletters. Yet they still choose between scalable content and high-value services that depend on their own time.",
    gapBody2:
      "Meanwhile, audiences are already feeding creators’ public videos, writing, and methods into general-purpose AI to revise materials, generate plans, and complete work. Demand remains, but the resulting usage and revenue bypass the creator.",
    gapQuote:
      "The creator economy solved audience-building. Hatch solves what expert creators can sell next—and how to deliver it at scale.",
    gapList: [
      ["Content and courses", "They scale, but offer little personalization."],
      ["Consulting, review, and coaching", "More tailored, but constrained by the creator’s time."],
      ["Prompts and Skills", "Easy to copy, hard to install, and not products on their own."],
    ],
    productEyebrow: "02 · THE PLATFORM",
    productTitle: "Creators build it.\nHatch runs it.",
    productBody:
      "Hatch is a platform, not a custom agent studio or a consumer marketplace. The creator—not Hatch—owns the identity, style, and customer experience.",
    productPrinciple:
      "Hatch starts with the job people would pay a creator to do—not a full digital clone. It then assembles the method, judgment, data, tools, and human oversight needed to deliver it.",
    processIntro:
      "Making a method into a product people can use and pay for normally takes product design, agent engineering, evaluation, payments, and operations. Hatch packages that work into a repeatable creation flow for creators.",
    steps: [
      {
        n: "01",
        title: "Define the product",
        body: "Specify who buys it, what they receive, how it is priced, what good looks like, and when the creator needs to step in.",
      },
      {
        n: "02",
        title: "Import the method",
        body: "Bring in courses, cases, prior deliverables, revisions, and proprietary data. Hatch’s Interview Agent uses real cases to draw out tacit judgment.",
      },
      {
        n: "03",
        title: "Generate and calibrate",
        body: "Hatch combines the method, data, tools, and workflow, then builds expert-specific evals. The creator calibrates the agent through testing and correction.",
      },
      {
        n: "04",
        title: "Publish and charge",
        body: "Set a price, create a product page and link, then distribute through social, courses, communities, or a website.",
      },
      {
        n: "05",
        title: "Deliver continuously",
        body: "The agent does the core work; the creator handles edge cases. Corrections from real use keep refining the product.",
      },
    ],
    skillLabel: "A SKILL IS NOT YET A PRODUCT",
    skillTitle: "A Skill on its own is too thin.",
    skillBody:
      "A Skill can capture an SOP, instructions, or taste. A real expert product often also needs proprietary data, tools, prior cases, and evals.",
    fullProduct:
      "Hatch turns them into a paid product that is easy to use and controlled by the creator. Users get the finished work without installing a Skill—or taking the creator’s method or data.",
    workExamples: [
      "Rewritten résumé",
      "Growth audit",
      "Fitness plan",
      "Video script",
      "Interview practice",
      "Stock analysis",
      "Sales messaging",
      "Content calendar",
      "Homework review",
      "Brand brief",
      "Notion workspace setup",
      "Writing review",
      "Edited short-form video",
      "Go-to-market diagnosis",
      "Contract redline",
      "Negotiation brief",
      "Pricing strategy",
      "Research synthesis",
      "Pitch deck",
      "Storyboard",
      "Meal plan",
      "Product teardown",
      "Podcast rough cut",
      "Brand naming shortlist",
    ],
    interviewEyebrow: "03 · USER INTERVIEWS",
    interviewTitle: "Creator interviews reveal\na missing product layer.",
    interviews: [
      {
        role: "EXAM EDUCATOR",
        stat: "¥800",
        suffix: " / month",
        evidenceLabel: "Interviewee’s existing price",
        title: "The demand was there. The capacity wasn’t.",
        body: "An exam educator added homework review to her recorded course. Dozens of students paid right away, but her team could not keep up.",
        insight:
          "The material and grading rules were freely available. Students paid for the details she chose to prioritize, repeat, and address in feedback.",
      },
      {
        role: "GROWTH MARKETING PROFESSIONAL",
        stat: "¥100K+",
        suffix: " / enterprise engagement",
        evidenceLabel: "Interviewee’s existing price",
        title: "“Companies have asked if they can buy my Skill.",
        body: "But I can’t sell it as a file. It would be easy to copy or pirate, and a high-value growth method would end up as a cheap digital download.",
        insight:
          "I want clients to pay to use the method—not own it.”",
      },
    ],
    expertLabel: "WHAT MAKES AN EXPERT DIFFERENT",
    expertTitle: "Not more knowledge. Different choices.",
    expertBody:
      "A creator agent does not have to be universally better than a general-purpose model. Investors follow different strategies; fitness creators follow different schools of thought. General-purpose models tend to fill the page. An expert’s value lies in what they prioritize, the easy-to-miss details they notice, and what they choose to leave out—or not do at all.",
    expertEval:
      "Hatch evals do not try to prove a creator has the universally best answer. They test whether what makes that creator distinct comes through consistently, whether the agent produces work they will stand behind, and whether users will pay for it.",
    businessEyebrow: "04 · BUSINESS MODEL",
    businessTitle: "Hatch earns only\nwhen the creator earns.",
    businessBody:
      "Creators set the product, price, and experience, then sell to the audience they have already built. Customers buy a task or subscribe to a particular creator’s agent. Hatch charges no monthly fee and takes 10% of each transaction; it does not run a consumer marketplace.",
    businessFacts: [
      {
        stat: "10%",
        label: "Hatch transaction share",
        body: "No fixed monthly fee. Whether a product is sold once or by subscription depends on its value proposition.",
      },
      {
        stat: "300K+",
        label: "Patreon creators",
        body: "Nearly 80 million fans pay creators more than US$2 billion per year.",
      },
      {
        stat: "5M",
        label: "Substack paid subscriptions",
        body: "Creators keep 90% of subscription revenue, before payment-processing fees.",
      },
    ],
    businessClosing:
      "Those platforms help creators sell content and memberships. Hatch adds a new category: creator agents that work with a customer’s context and deliver usable outputs.",
    scale:
      "Hatch grows with creator-agent GMV, not software seats.",
    visionBody:
      "Until now, an expert who wanted to make a service scalable had two choices: deliver it personally or build product, engineering, operations, and service teams. Hatch standardizes the work of productizing and delivering that service, so creators can build, publish, and run their own AI products.",
    final:
      "Hatch is the product, fulfillment, and commerce infrastructure for the expert creator economy. Expert creators can own a revenue-generating AI product—without a software team.",
    founderLabel: "WHY HATCH",
    founder: [
      "Hatch grew out of the founder’s work across education and AI. He grew up helping run his family’s education business, building courses, training programs, and coaching—and seeing valuable content copied and pirated.",
      "After his MBA, he led AI deployments across sectors, working at the intersection of multimodal systems, model inference, methodology, workflow management, and evaluation.",
      "He believes that as general-purpose AI makes public knowledge easy to copy, Hatch can help experts distill their choices, standards, and methods into revenue-generating AI products.",
    ],
    partnersKicker: "LET’S HATCH SOMETHING.",
    partnersLabel: "WHO WE WANT TO PARTNER WITH",
    partnersTitle: "Who we want to partner with",
    partnerTypes: [
      {
        label: "CREATORS",
        title: "Creators with an audience, a distinct method, and a service to scale",
        body: "Turn courses, consulting, or content into agent products.",
      },
      {
        label: "INSTITUTIONS",
        title: "Content rights holders, media/IP organizations, and creator channels",
        body: "Turn established content assets—or a roster of creators—into new agent products.",
      },
    ],
    contactLabel: "START A CONVERSATION",
    contactTitle: "Let’s hatch something.",
    contactBody:
      "See a way to work together, know someone we should meet, or want to continue the conversation? Leave us a note.",
    contactFields: {
      name: "Name",
      email: "Email",
      partnerType: "Which best describes you?",
      message: "A product, asset, or idea you’d like to explore (optional)",
    },
    contactOptions: ["Creator", "Content rights holder, media/IP organization, or creator channel", "Investor"],
    contactLaunch: "Contact Hatch",
    contactClose: "Close",
    contactSubmit: "Send",
    contactSending: "Sending…",
    contactSuccess: "Thanks—we’ll be in touch soon.",
    contactError: "Something went wrong. Please try again.",
  },
  ja: jaCopy,
} as const;

const sectionLinks = ["gap", "product", "interviews", "business", "vision", "partners", "contact"];

function StepGraphic({ step, lang }: { step: string; lang: Lang }) {
  const labels =
    lang === "ja"
      ? {
          buyer: "購入者",
          output: "成果物",
          price: "価格",
          course: "講座",
          cases: "事例",
          edits: "修正",
          data: "データ",
          result: "成果物",
        }
      : {
          buyer: "BUYER",
          output: "OUTPUT",
          price: "PRICE",
          course: "COURSE",
          cases: "CASES",
          edits: "EDITS",
          data: "DATA",
          result: "RESULT",
        };

  switch (step) {
    case "01":
      return (
        <div className="step-graphic step-graphic--brief" aria-hidden="true">
          <div className="mini-topline">
            <span>PRODUCT BRIEF</span>
            <i />
          </div>
          <div className="brief-rows">
            <div>
              <span>{labels.buyer}</span>
              <i />
            </div>
            <div>
              <span>{labels.output}</span>
              <i />
            </div>
            <div>
              <span>{labels.price}</span>
              <i />
            </div>
          </div>
        </div>
      );
    case "02":
      return (
        <div className="step-graphic step-graphic--inputs" aria-hidden="true">
          <div className="input-stack">
            <span>{labels.course}</span>
            <span>{labels.cases}</span>
            <span>{labels.edits}</span>
          </div>
          <div className="input-plus">+</div>
          <div className="data-card">
            <span>{labels.data}</span>
            <i />
            <i />
            <i />
          </div>
        </div>
      );
    case "03":
      return (
        <div className="step-graphic step-graphic--eval" aria-hidden="true">
          <div className="eval-candidates">
            <div className="eval-candidate eval-candidate--reject">
              <i />
              <i />
              <b>×</b>
            </div>
            <div className="eval-candidate eval-candidate--accept">
              <i />
              <i />
              <b>✓</b>
            </div>
          </div>
          <div className="eval-track">
            <span>EVAL</span>
            <i />
            <em />
          </div>
        </div>
      );
    case "04":
      return (
        <div className="step-graphic step-graphic--publish" aria-hidden="true">
          <div className="publish-link">
            <span>CREATOR.LINK</span>
            <b>↗</b>
          </div>
          <div className="publish-product">
            <i />
            <div>
              <span />
              <span />
            </div>
            <strong>$</strong>
          </div>
        </div>
      );
    default:
      return (
        <div className="step-graphic step-graphic--delivery" aria-hidden="true">
          <div className="delivery-checks">
            <div>
              <i>✓</i>
              <span />
            </div>
            <div>
              <i>✓</i>
              <span />
            </div>
          </div>
          <div className="delivery-output">
            <b>{labels.result}</b>
            <span />
            <em>↻</em>
          </div>
        </div>
      );
  }
}

export default function HatchPage({ initialLang }: { initialLang: Lang }) {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [contactStatus, setContactStatus] = useState<
    "idle" | "submitting" | "success" | "error"
  >("idle");
  const [isContactDialogOpen, setIsContactDialogOpen] = useState(false);
  const contactDialogRef = useRef<HTMLDialogElement>(null);
  const t = copy[lang];

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : lang === "ja" ? "ja" : "en";
  }, [lang]);

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

    if (isContactDialogOpen && !dialog.open) {
      dialog.showModal();
    }

    if (!isContactDialogOpen && dialog.open) {
      dialog.close();
    }
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

      if (!response.ok) {
        throw new Error("Contact submission failed");
      }

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

  return (
    <main className={`site is-${lang}`}>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Hatch home">
          Hatch<span className="brand-dot">.</span>
        </a>
        <nav className="desktop-nav" aria-label="Page sections">
          {t.nav.map((item, index) => (
            <a href={`#${sectionLinks[index]}`} key={sectionLinks[index]}>
              {item}
            </a>
          ))}
        </nav>
        <div className="lang-switch" aria-label="Language switcher">
          <button
            type="button"
            className={lang === "zh" ? "active" : ""}
            aria-pressed={lang === "zh"}
            onClick={() => setLang("zh")}
          >
            中
          </button>
          <span aria-hidden="true">/</span>
          <button
            type="button"
            className={lang === "ja" ? "active" : ""}
            aria-pressed={lang === "ja"}
            onClick={() => setLang("ja")}
          >
            日
          </button>
          <span aria-hidden="true">/</span>
          <button
            type="button"
            className={lang === "en" ? "active" : ""}
            aria-pressed={lang === "en"}
            onClick={() => setLang("en")}
          >
            EN
          </button>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-meta eyebrow">{t.meta}</div>
        <div className="hero-grid">
          <div className="hero-main">
            <h1>
              <span>{t.heroTitleA}</span>
              <em>{t.heroTitleB}</em>
            </h1>
            <p className="hero-body">{t.heroBody}</p>
            <div className="hero-actions">
              <a className="hero-cta hero-cta-primary" href="/explore">
                {t.exploreCreators}
                <span aria-hidden="true">↗</span>
              </a>
              <a className="hero-cta hero-cta-secondary" href="/studio">
                {t.buildProduct}
                <span aria-hidden="true">↗</span>
              </a>
              <a className="text-link" href="#gap">
                {t.read}
                <span aria-hidden="true">↓</span>
              </a>
              <button className="text-link text-link-contact hero-contact-link" type="button" onClick={openContactDialog}>
                {t.contactLink}
                <span aria-hidden="true">→</span>
              </button>
            </div>
          </div>
          <div className="hero-film">
            <video
              aria-label={t.heroFilmLabel}
              controls
              key={lang}
              playsInline
              poster={t.heroFilmPoster}
              preload="metadata"
            >
              <source src={t.heroFilmSrc} type="video/mp4" />
            </video>
          </div>
        </div>

        <div className="positioning-map" aria-label="Product positioning">
          <article className="positioning-pole">
            <p className="eyebrow">{t.continuum[0].label}</p>
            <h2>{t.continuum[0].title}</h2>
            <p>{t.continuum[0].body}</p>
          </article>
          <div className="positioning-bridge">
            <p className="bridge-label eyebrow">{t.continuumBridge}</p>
            <article className="positioning-focus">
              <p className="eyebrow">{t.continuum[1].label}</p>
              <h2>{t.continuum[1].title}</h2>
              <p>{t.continuum[1].body}</p>
            </article>
          </div>
          <article className="positioning-pole positioning-pole-right">
            <p className="eyebrow">{t.continuum[2].label}</p>
            <h2>{t.continuum[2].title}</h2>
            <p>{t.continuum[2].body}</p>
          </article>
        </div>
      </section>

      <section className="editorial-section" id="gap">
        <div className="section-index eyebrow">{t.gapEyebrow}</div>
        <div className="section-content gap-content">
          <h2 className="display-title multiline">{t.gapTitle}</h2>
          <p className="lead">{t.gapBody}</p>
          <p className="lead gap-followup">{t.gapBody2}</p>
          <div className="gap-list">
            {t.gapList.map(([title, body], index) => (
              <div className="gap-row" key={title}>
                <span className="mono-index">0{index + 1}</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            ))}
          </div>
          <blockquote>{t.gapQuote}</blockquote>
        </div>
      </section>

      <section className="editorial-section product-section" id="product">
        <div className="section-index eyebrow">{t.productEyebrow}</div>
        <div className="section-content">
          <div className="section-intro">
            <h2 className="display-title multiline">{t.productTitle}</h2>
            <p className="lead">{t.productBody}</p>
          </div>
          <blockquote className="product-principle">{t.productPrinciple}</blockquote>
          <p className="process-intro">{t.processIntro}</p>
          <div className="steps">
            {t.steps.map((step) => (
              <article className="step" key={step.n}>
                <span className="step-number">{step.n}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
                <StepGraphic step={step.n} lang={lang} />
              </article>
            ))}
          </div>

          <div className="skill-note">
            <div>
              <p className="eyebrow">{t.skillLabel}</p>
              <h3>{t.skillTitle}</h3>
            </div>
            <div>
              <p>{t.skillBody}</p>
              <p className="skill-answer">{t.fullProduct}</p>
            </div>
          </div>

          <div className="artifact-line" aria-label="Example creator products">
            {t.workExamples.map((example) => (
              <span key={example}>{example}</span>
            ))}
          </div>
        </div>
      </section>

      <section className="editorial-section" id="interviews">
        <div className="section-index eyebrow">{t.interviewEyebrow}</div>
        <div className="section-content">
          <h2 className="display-title multiline">{t.interviewTitle}</h2>
          <div className="field-notes">
            {t.interviews.map((interview) => (
              <article className="field-note" key={interview.title}>
                <p className="field-role">{interview.role}</p>
                <h3>{interview.title}</h3>
                <p>{interview.body}</p>
                <p className="field-insight">{interview.insight}</p>
                <div className="field-evidence">
                  <span>{interview.evidenceLabel}</span>
                  <strong>{interview.stat}</strong>
                  <span>{interview.suffix}</span>
                </div>
              </article>
            ))}
          </div>

          <div className="expert-note">
            <p className="eyebrow">{t.expertLabel}</p>
            <div>
              <h3>{t.expertTitle}</h3>
              <p>{t.expertBody}</p>
              <p>{t.expertEval}</p>
            </div>
          </div>
        </div>
      </section>

      <section className="editorial-section business-section" id="business">
        <div className="section-index eyebrow">{t.businessEyebrow}</div>
        <div className="section-content">
          <div className="section-intro">
            <h2 className="display-title multiline">{t.businessTitle}</h2>
            <p className="lead">{t.businessBody}</p>
          </div>
          <div className="business-facts">
            {t.businessFacts.map((fact) => (
              <article key={fact.label}>
                <strong>{fact.stat}</strong>
                <p className="eyebrow">{fact.label}</p>
                <p>{fact.body}</p>
              </article>
            ))}
          </div>
          <p className="business-closing">{t.businessClosing}</p>
          <p className="scale-line">{t.scale}</p>
        </div>
      </section>

      <section className="vision-section" id="vision">
        <div className="vision-inner">
          <div className="vision-copy vision-copy-standalone">
            <p>{t.visionBody}</p>
          </div>
          <p className="final-vision">{t.final}</p>
          <div className="founder-note">
            <p className="eyebrow">{t.founderLabel}</p>
            <div className="founder-copy">
              {t.founder.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="contact-section" id="contact">
        <div className="contact-note" id="partners">
          <p className="eyebrow">{t.partnersKicker}</p>
          <div className="contact-copy">
            <h3>{t.partnersTitle}</h3>
            <div className="contact-partner-types">
              {t.partnerTypes.map((partner) => (
                <article key={partner.label}>
                  <p className="eyebrow">{partner.label}</p>
                  <h4>{partner.title}</h4>
                  <p>{partner.body}</p>
                </article>
              ))}
            </div>
            <button className="contact-launch" type="button" onClick={openContactDialog}>
              {t.contactLaunch}
              <span aria-hidden="true">→</span>
            </button>
          </div>
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
              <input
                className="contact-honeypot"
                name="website"
                type="text"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
              />
              <div className="contact-actions">
                <button type="submit" disabled={contactStatus === "submitting"}>
                  {contactStatus === "submitting" ? t.contactSending : t.contactSubmit}
                  <span aria-hidden="true">→</span>
                </button>
                <p className={`contact-status ${contactStatus}`} aria-live="polite">
                  {contactStatus === "success"
                    ? t.contactSuccess
                    : contactStatus === "error"
                      ? t.contactError
                      : ""}
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
