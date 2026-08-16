const MESSAGES = {
  en: {
    language: "Language",
    english: "English",
    chinese: "中文",
    japanese: "日本語",
    files: "Files",
    aboutYou: "About you",
    review: "Review",
    brief: "Brief",
    complete: "Complete",
    briefTitle: "Define the task brief",
    briefBody: "Write the questions a buyer must answer before work begins. This is a plain text form.",
    addBriefQuestion: "Add question",
    briefQuestion: "Question",
    briefQuestionPlaceholder: "What should the buyer tell you before you start?",
    requiredQuestion: "Required",
    moveQuestionUp: "Move question up",
    moveQuestionDown: "Move question down",
    saveBriefAndContinue: "Save brief and continue to publish",
    briefSaved: "Brief saved.",
    optional: "optional",
    briefRequiredBeforePublish: "Add and save at least one Brief question before publishing.",
    backToBrief: "Back to Brief",
    giveMaterial: "Give Hatch the material behind your method.",
    uploadFiles: "Upload files",
    localFilesOnly: "Local files only; repeat uploads are allowed.",
    startDistillation: "Generate version",
    continueWithFiles: "Continue with these files",
    helpUnderstand: "Help Hatch understand you.",
    questionOf: (current, total) => `Question ${current} of ${total}`,
    sourceEvidence: "Source evidence",
    whatHatchFound: "What Hatch found",
    yourContext: "Your context",
    addContext: "Add the context, influence, or nuance…",
    saveAndNext: "Save and next",
    finishAndReview: "Finish and review",
    reviewResult: "Does this result meet your standard?",
    userSituation: "User situation",
    yourMethod: "Your method",
    currentResponse: "Current response",
    useResult: "Use this result",
    correctResult: "Correct this result",
    removeQuestion: "Remove this question",
    fullCorpus: "Full Corpus",
    viewProductDetails: "View Product Details",
    publishProduct: "Publish product",
    generateAnotherVersion: "Generate another version",
    published: "Published",
    noRun: "Start distillation from Files to generate the first version.",
    noQuestions: "Hatch has not generated an About you question yet.",
    waiting: "Hatch is working…",
    saved: "Saved",
    saving: "Saving…",
    correctionSaved: "Correction saved. Generate another version when you are ready.",
    versionGenerated: "A new version is being generated.",
    productPublished: "Your product is published.",
    filesReady: (count) => `${count} file${count === 1 ? "" : "s"} ready`,
    product: "Product",
    unnamedFile: "Unnamed file",
    ready: "Ready",
    fileStatus_ready: "Ready",
    fileStatus_processing: "Preparing",
    fileStatus_error: "Could not prepare",
    imageNative: "Image · native",
    markdownProjection: "Markdown projection",
    uploadForProduct: "Upload local files for this Product.",
    evaluationPassed: "Evaluation passed",
    evaluationFailed: "Evaluation failed",
    whatProductDelivers: "What does your product deliver?",
    saveProductPromise: "Save product promise",
    productPromiseSaved: "Product promise saved.",
    products: "Products",
    browse: "Browse",
    currentVersion: "Current version",
    version: (number, status) => `Version ${number} · ${status}`,
    sourceNote: "PDF, DOCX, XLSX, CSV, TXT, Markdown, JSON and HTML become Markdown. Images stay native for Kimi K2.6.",
    whatShouldHatchHaveDone: "What should Hatch have done?",
    why: "Why?",
    evaluationUnavailable: "Evaluation unavailable",
    corpusUnavailable: "Corpus unavailable"
    ,reviewStatus_accepted: "Used in this version"
    ,reviewStatus_corrected: "Correction saved"
    ,reviewStatus_rejected_question: "Removed from review"
    ,reviewStatus_judge_disputed: "Quality check disputed"
    ,createProduct: "Create product"
    ,startProductTitle: "Start with one useful product."
    ,startProductBody: "Name the result people will receive, then add the material behind your method."
    ,productName: "Product name"
    ,productNameHint: "This name identifies the product in your studio."
    ,describeResult: "Describe the result someone will receive."
    ,filesCount: (count) => `${count} file${count === 1 ? "" : "s"}`
    ,filesAdded: (count) => `${count} file${count === 1 ? "" : "s"} added to this Product.`
    ,filesUnavailable: "Files unavailable"
    ,filesAddedTitle: "Files added"
    ,productFiles: "Product files"
    ,addFilesBody: "Add as many local files as you need. They stay with this Product and are versioned when you generate."
    ,generateVersion: "Generate version"
    ,noFilesYet: "No files yet"
    ,firstFileForProduct: "Upload the first file for this Product."
    ,productCouldNotBeCreated: "Product could not be created"
  },
  zh: {
    language: "语言",
    english: "English",
    chinese: "中文",
    japanese: "日本語",
    files: "文件",
    aboutYou: "关于你",
    review: "审核",
    brief: "Brief",
    complete: "完成",
    briefTitle: "定义任务 Brief",
    briefBody: "写下用户开工前必须回答的问题。这是普通文字表单，不涉及 AI。",
    addBriefQuestion: "添加问题",
    briefQuestion: "问题",
    briefQuestionPlaceholder: "开始工作前，你希望用户告诉你什么？",
    requiredQuestion: "必填",
    moveQuestionUp: "问题上移",
    moveQuestionDown: "问题下移",
    saveBriefAndContinue: "保存 Brief，继续发布",
    briefSaved: "Brief 已保存。",
    optional: "选填",
    briefRequiredBeforePublish: "发布前请至少添加并保存一个 Brief 问题。",
    backToBrief: "返回 Brief",
    giveMaterial: "把支撑你方法的材料交给 Hatch。",
    uploadFiles: "上传文件",
    localFilesOnly: "仅支持本地文件，可以分批上传。",
    startDistillation: "生成版本",
    continueWithFiles: "使用这些文件继续",
    helpUnderstand: "帮助 Hatch 更了解你。",
    questionOf: (current, total) => `问题 ${current} / ${total}`,
    sourceEvidence: "来源证据",
    whatHatchFound: "Hatch 找到的内容",
    yourContext: "你的背景",
    addContext: "补充背景、影响或细节……",
    saveAndNext: "保存并继续",
    finishAndReview: "完成并审核",
    reviewResult: "这个结果符合你的标准吗？",
    userSituation: "用户情境",
    yourMethod: "你的方法",
    currentResponse: "当前回答",
    useResult: "采用这个结果",
    correctResult: "修正这个结果",
    removeQuestion: "移除这个问题",
    fullCorpus: "完整 Corpus",
    viewProductDetails: "查看产品详情",
    publishProduct: "发布产品",
    generateAnotherVersion: "生成新版本",
    published: "已发布",
    noRun: "请先在“文件”中开始提炼，生成第一个版本。",
    noQuestions: "Hatch 还没有生成“关于你”的问题。",
    waiting: "Hatch 正在处理……",
    saved: "已保存",
    saving: "保存中……",
    correctionSaved: "修正已保存。准备好后可以生成新版本。",
    versionGenerated: "正在生成新版本。",
    productPublished: "你的产品已发布。",
    filesReady: (count) => `${count} 个文件已准备好`,
    product: "产品",
    unnamedFile: "未命名文件",
    ready: "已准备好",
    fileStatus_ready: "已准备好",
    fileStatus_processing: "准备中",
    fileStatus_error: "无法处理",
    imageNative: "图片 · 原生读取",
    markdownProjection: "Markdown 投影",
    uploadForProduct: "为这个产品上传本地文件。",
    evaluationPassed: "评估通过",
    evaluationFailed: "评估未通过",
    whatProductDelivers: "你的产品交付什么？",
    saveProductPromise: "保存产品承诺",
    productPromiseSaved: "产品承诺已保存。",
    products: "产品",
    browse: "浏览",
    currentVersion: "当前版本",
    version: (number, status) => `版本 ${number} · ${status}`,
    sourceNote: "PDF、DOCX、XLSX、CSV、TXT、Markdown、JSON 和 HTML 会转换为 Markdown。图片由 Kimi K2.6 原生读取。",
    whatShouldHatchHaveDone: "Hatch 应该怎么做？",
    why: "为什么？",
    evaluationUnavailable: "评估不可用",
    corpusUnavailable: "Corpus 不可用"
    ,reviewStatus_accepted: "已纳入此版本"
    ,reviewStatus_corrected: "修正已保存"
    ,reviewStatus_rejected_question: "已从审核中移除"
    ,reviewStatus_judge_disputed: "质量检查有争议"
    ,createProduct: "创建产品"
    ,startProductTitle: "从一个有用的产品开始。"
    ,startProductBody: "先写下用户将获得的结果，再添加支撑你方法的材料。"
    ,productName: "产品名称"
    ,productNameHint: "这个名称用于在 Studio 中识别产品。"
    ,describeResult: "描述用户将获得的结果。"
    ,filesCount: (count) => `${count} 个文件`
    ,filesAdded: (count) => `已向该产品添加 ${count} 个文件。`
    ,filesUnavailable: "文件不可用"
    ,filesAddedTitle: "文件已添加"
    ,productFiles: "产品文件"
    ,addFilesBody: "可以多次添加本地文件。它们会跟随这个产品，并在生成版本时被锁定。"
    ,generateVersion: "生成版本"
    ,noFilesYet: "还没有文件"
    ,firstFileForProduct: "为这个产品上传第一个文件。"
    ,productCouldNotBeCreated: "产品无法创建"
  },
  ja: {
    language: "言語",
    english: "English",
    chinese: "中文",
    japanese: "日本語",
    files: "ファイル",
    aboutYou: "あなたについて",
    review: "レビュー",
    brief: "Brief",
    complete: "完了",
    briefTitle: "タスク Brief を定義",
    briefBody: "作業開始前に購入者が答える質問を書きます。通常のテキストフォームです。",
    addBriefQuestion: "質問を追加",
    briefQuestion: "質問",
    briefQuestionPlaceholder: "開始前に購入者から何を聞きたいですか？",
    requiredQuestion: "必須",
    moveQuestionUp: "質問を上へ",
    moveQuestionDown: "質問を下へ",
    saveBriefAndContinue: "Brief を保存して公開へ進む",
    briefSaved: "Brief を保存しました。",
    optional: "任意",
    briefRequiredBeforePublish: "公開前に Brief の質問を1つ以上保存してください。",
    backToBrief: "Brief に戻る",
    giveMaterial: "あなたの方法を支える資料を Hatch に渡します。",
    uploadFiles: "ファイルをアップロード",
    localFilesOnly: "ローカルファイルのみ。何度でも追加できます。",
    startDistillation: "バージョンを生成",
    continueWithFiles: "このファイルで続ける",
    helpUnderstand: "Hatch があなたを理解できるようにします。",
    questionOf: (current, total) => `質問 ${current} / ${total}`,
    sourceEvidence: "出典エビデンス",
    whatHatchFound: "Hatch が見つけたこと",
    yourContext: "あなたの背景",
    addContext: "背景、影響、ニュアンスを追加…",
    saveAndNext: "保存して次へ",
    finishAndReview: "完了してレビュー",
    reviewResult: "この結果はあなたの基準を満たしていますか？",
    userSituation: "ユーザーの状況",
    yourMethod: "あなたの方法",
    currentResponse: "現在の回答",
    useResult: "この結果を使う",
    correctResult: "この結果を修正",
    removeQuestion: "この質問を削除",
    fullCorpus: "完全な Corpus",
    viewProductDetails: "プロダクト詳細を見る",
    publishProduct: "プロダクトを公開",
    generateAnotherVersion: "新しいバージョンを生成",
    published: "公開済み",
    noRun: "まず「ファイル」から抽出を開始して、最初のバージョンを生成してください。",
    noQuestions: "Hatch はまだ「あなたについて」の質問を生成していません。",
    waiting: "Hatch が処理中です…",
    saved: "保存済み",
    saving: "保存中…",
    correctionSaved: "修正を保存しました。準備ができたら新しいバージョンを生成できます。",
    versionGenerated: "新しいバージョンを生成しています。",
    productPublished: "プロダクトを公開しました。",
    filesReady: (count) => `${count} ファイル準備完了`,
    product: "プロダクト",
    unnamedFile: "名前のないファイル",
    ready: "準備完了",
    fileStatus_ready: "準備完了",
    fileStatus_processing: "準備中",
    fileStatus_error: "処理できません",
    imageNative: "画像 · ネイティブ",
    markdownProjection: "Markdown 投影",
    uploadForProduct: "このプロダクト用のローカルファイルをアップロードします。",
    evaluationPassed: "評価に合格",
    evaluationFailed: "評価に不合格",
    whatProductDelivers: "プロダクトは何を届けますか？",
    saveProductPromise: "プロダクトの約束を保存",
    productPromiseSaved: "プロダクトの約束を保存しました。",
    products: "プロダクト",
    browse: "参照",
    currentVersion: "現在のバージョン",
    version: (number, status) => `バージョン ${number} · ${status}`,
    sourceNote: "PDF、DOCX、XLSX、CSV、TXT、Markdown、JSON、HTML は Markdown に変換されます。画像は Kimi K2.6 がネイティブに読み取ります。",
    whatShouldHatchHaveDone: "Hatch はどうすべきでしたか？",
    why: "理由",
    evaluationUnavailable: "評価を利用できません",
    corpusUnavailable: "Corpus を利用できません"
    ,reviewStatus_accepted: "このバージョンに採用"
    ,reviewStatus_corrected: "修正を保存しました"
    ,reviewStatus_rejected_question: "レビューから削除"
    ,reviewStatus_judge_disputed: "品質チェックに異議あり"
    ,createProduct: "プロダクトを作成"
    ,startProductTitle: "役に立つプロダクトから始めます。"
    ,startProductBody: "受け取る結果に名前を付け、方法を支える資料を追加します。"
    ,productName: "プロダクト名"
    ,productNameHint: "Studio でプロダクトを識別する名前です。"
    ,describeResult: "受け取る結果を説明してください。"
    ,filesCount: (count) => `${count} ファイル`
    ,filesAdded: (count) => `${count} ファイルをこのプロダクトに追加しました。`
    ,filesUnavailable: "ファイルを利用できません"
    ,filesAddedTitle: "ファイルを追加しました"
    ,productFiles: "プロダクトファイル"
    ,addFilesBody: "ローカルファイルは何度でも追加できます。生成時にこのプロダクトと一緒にバージョン化されます。"
    ,generateVersion: "バージョンを生成"
    ,noFilesYet: "ファイルはまだありません"
    ,firstFileForProduct: "このプロダクトに最初のファイルをアップロードします。"
    ,productCouldNotBeCreated: "プロダクトを作成できませんでした"
  }
};

export function detectCreatorLocale() {
  if (typeof navigator === "undefined") return "en";
  const language = String(navigator.language || "en").toLowerCase();
  if (language.startsWith("zh")) return "zh";
  if (language.startsWith("ja")) return "ja";
  return "en";
}

export function createCreatorTranslator(locale = "en") {
  const messages = MESSAGES[locale] ?? MESSAGES.en;
  return (key, ...args) => {
    const value = messages[key] ?? MESSAGES.en[key] ?? key;
    return typeof value === "function" ? value(...args) : value;
  };
}

export const CREATOR_LOCALES = ["en", "zh", "ja"];
