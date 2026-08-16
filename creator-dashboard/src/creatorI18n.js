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
    addSourceFiles: "Add source files",
    addFilesForVersion: "To make another version without corrections, add new source material first.",
    reviewBeforeComplete: "Finish reviewing this version before completing it.",
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
    ,productCreatedWithoutId: "The Product was created, but Hatch could not open it."
    ,productNameExample: "e.g. Interview Answer Rewriter"
    ,preparingFile: "Preparing"
    ,explore: "Explore"
    ,library: "Library"
    ,studio: "Studio"
    ,orders: "Orders"
    ,account: "Account"
    ,hatchCreatorHome: "Hatch Creator home"
    ,creatorNavigation: "Creator navigation"
    ,openNavigation: "Open navigation"
    ,hatchNavigation: "Hatch navigation"
    ,creator: "Creator"
    ,creatorAccount: "Creator account"
    ,signOut: "Sign out"
    ,creatorPortalUnavailable: "Creator Studio is unavailable"
    ,creatorPortalUnavailableBody: "We couldn't load this workspace."
    ,pageNotFound: "Page not found"
    ,pageNotFoundBody: "This Creator page does not exist or has moved."
    ,backToProducts: "Back to Products"
    ,workspaceLoadError: "We couldn't open your workspace"
    ,retry: "Retry"
    ,creatorHome: "Creator home"
    ,homeTitle: (name) => `${name}, here’s the next useful step.`
    ,homeBody: "Build one Product from your material, review it, and publish it when it is ready."
    ,creatorOverview: "Creator overview"
    ,permanentAccess: "Permanent access"
    ,peopleWithAccess: "People who added one of your published Products to their Hatch account."
    ,viewAccessRecords: "View access records"
    ,recentActivity: "Recent activity"
    ,ordersAndAccess: "Orders and access"
    ,viewAllOrders: "View all orders"
    ,noAccessRecords: "No access records yet"
    ,noAccessRecordsBody: "Records appear here after someone adds a published Product to their account."
    ,productsLoadError: "We couldn't load your Products"
    ,productsPageTitle: "Turn your method into a Product people can use."
    ,productsPageBody: "Each Product keeps its files, versions, review, Brief, and release together."
    ,createFirstProduct: "Create your first Product"
    ,createFirstProductBody: "Start with one focused result, add the material behind it, and generate the first version."
    ,notPublished: "Not published"
    ,untitledProduct: "Untitled Product"
    ,addProductPromise: "Add a clear customer-facing promise."
    ,openProduct: "Open Product"
    ,startHere: "Start here"
    ,createFocusedProduct: "Create one focused Product"
    ,createFocusedProductBody: "Name the result, add your material, and generate the first version."
    ,continueProductWorkflow: "Continue building this Product."
    ,continueProduct: "Continue"
    ,live: "Live"
    ,storefrontLiveBody: "Your Product is live. Share it or inspect the latest access records."
    ,viewProduct: "View Product"
    ,productAccess: "Product access"
    ,buyer: "Buyer"
    ,access: "Access"
    ,accessStatus: "Access status"
    ,viewRecord: "View record"
    ,viewAccessRecord: (reference) => `View access record ${reference}`
    ,productStatus_published: "Published"
    ,productStatus_live: "Published"
    ,productStatus_candidate_required: "Needs a version"
    ,productStatus_candidate_ready: "Ready for review"
    ,productStatus_candidate_rejected: "Needs changes"
    ,productStatus_ready_to_preview: "Ready to complete"
    ,productStatus_ready_to_publish: "Ready to publish"
    ,productStatus_ready_for_review: "Ready for review"
    ,productStatus_review_ready: "Ready for review"
    ,productStatus_preparing: "Generating version"
    ,productStatus_needs_attention: "Needs attention"
    ,productStatus_draft: "Draft"
    ,productWorkflow: "Product workflow"
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
    addSourceFiles: "添加源文件",
    addFilesForVersion: "如果没有修正内容，请先添加新的源材料，再生成新版本。",
    reviewBeforeComplete: "请先完成这个版本的审核。",
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
    ,productCreatedWithoutId: "产品已创建，但 Hatch 无法打开它。"
    ,productNameExample: "例如：面试答案改写助手"
    ,preparingFile: "准备中"
    ,explore: "探索"
    ,library: "资料库"
    ,studio: "创作中心"
    ,orders: "订单"
    ,account: "账户"
    ,hatchCreatorHome: "Hatch 创作者首页"
    ,creatorNavigation: "创作者导航"
    ,openNavigation: "打开导航"
    ,hatchNavigation: "Hatch 导航"
    ,creator: "创作者"
    ,creatorAccount: "创作者账户"
    ,signOut: "退出登录"
    ,creatorPortalUnavailable: "Creator Studio 暂不可用"
    ,creatorPortalUnavailableBody: "暂时无法加载这个工作区。"
    ,pageNotFound: "页面不存在"
    ,pageNotFoundBody: "这个创作者页面不存在或已移动。"
    ,backToProducts: "返回产品"
    ,workspaceLoadError: "无法打开你的工作区"
    ,retry: "重试"
    ,creatorHome: "创作者首页"
    ,homeTitle: (name) => `${name}，这是现在最值得做的一步。`
    ,homeBody: "用你的材料创建一个产品，审核结果，准备好后再发布。"
    ,creatorOverview: "创作者概览"
    ,permanentAccess: "永久使用权"
    ,peopleWithAccess: "已将你发布的产品添加到 Hatch 账户的人数。"
    ,viewAccessRecords: "查看使用记录"
    ,recentActivity: "最近动态"
    ,ordersAndAccess: "订单与使用记录"
    ,viewAllOrders: "查看全部订单"
    ,noAccessRecords: "还没有使用记录"
    ,noAccessRecordsBody: "有人将已发布产品添加到账户后，记录会显示在这里。"
    ,productsLoadError: "无法加载你的产品"
    ,productsPageTitle: "把你的方法变成人们可以使用的产品。"
    ,productsPageBody: "每个产品都把文件、版本、审核、Brief 与发布记录放在一起。"
    ,createFirstProduct: "创建你的第一个产品"
    ,createFirstProductBody: "从一个明确结果开始，添加支撑材料，再生成第一个版本。"
    ,notPublished: "未发布"
    ,untitledProduct: "未命名产品"
    ,addProductPromise: "添加一句清楚的用户价值承诺。"
    ,openProduct: "打开产品"
    ,startHere: "从这里开始"
    ,createFocusedProduct: "创建一个目标明确的产品"
    ,createFocusedProductBody: "先写下交付结果，添加材料，再生成第一个版本。"
    ,continueProductWorkflow: "继续完善这个产品。"
    ,continueProduct: "继续"
    ,live: "已上线"
    ,storefrontLiveBody: "你的产品已经上线，可以分享或查看最新使用记录。"
    ,viewProduct: "查看产品"
    ,productAccess: "产品使用权"
    ,buyer: "用户"
    ,access: "使用权"
    ,accessStatus: "使用状态"
    ,viewRecord: "查看记录"
    ,viewAccessRecord: (reference) => `查看使用记录 ${reference}`
    ,productStatus_published: "已发布"
    ,productStatus_live: "已发布"
    ,productStatus_candidate_required: "需要生成版本"
    ,productStatus_candidate_ready: "可以审核"
    ,productStatus_candidate_rejected: "需要修改"
    ,productStatus_ready_to_preview: "可以完成"
    ,productStatus_ready_to_publish: "可以发布"
    ,productStatus_ready_for_review: "可以审核"
    ,productStatus_review_ready: "可以审核"
    ,productStatus_preparing: "正在生成版本"
    ,productStatus_needs_attention: "需要处理"
    ,productStatus_draft: "草稿"
    ,productWorkflow: "产品流程"
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
    addSourceFiles: "ソースファイルを追加",
    addFilesForVersion: "修正がない場合は、新しいソース資料を追加してから別のバージョンを生成してください。",
    reviewBeforeComplete: "このバージョンのレビューを完了してください。",
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
    ,productCreatedWithoutId: "プロダクトは作成されましたが、Hatch で開けませんでした。"
    ,productNameExample: "例：面接回答リライター"
    ,preparingFile: "準備中"
    ,explore: "見つける"
    ,library: "ライブラリ"
    ,studio: "スタジオ"
    ,orders: "注文"
    ,account: "アカウント"
    ,hatchCreatorHome: "Hatch クリエイターホーム"
    ,creatorNavigation: "クリエイターナビゲーション"
    ,openNavigation: "ナビゲーションを開く"
    ,hatchNavigation: "Hatch ナビゲーション"
    ,creator: "クリエイター"
    ,creatorAccount: "クリエイターアカウント"
    ,signOut: "サインアウト"
    ,creatorPortalUnavailable: "Creator Studio を利用できません"
    ,creatorPortalUnavailableBody: "このワークスペースを読み込めませんでした。"
    ,pageNotFound: "ページが見つかりません"
    ,pageNotFoundBody: "このクリエイターページは存在しないか、移動しました。"
    ,backToProducts: "プロダクトに戻る"
    ,workspaceLoadError: "ワークスペースを開けませんでした"
    ,retry: "再試行"
    ,creatorHome: "クリエイターホーム"
    ,homeTitle: (name) => `${name}さん、次に進めることはこちらです。`
    ,homeBody: "資料からプロダクトを作り、結果をレビューし、準備ができたら公開します。"
    ,creatorOverview: "クリエイター概要"
    ,permanentAccess: "永久アクセス"
    ,peopleWithAccess: "公開したプロダクトを Hatch アカウントに追加した人数です。"
    ,viewAccessRecords: "アクセス記録を見る"
    ,recentActivity: "最近のアクティビティ"
    ,ordersAndAccess: "注文とアクセス"
    ,viewAllOrders: "すべての注文を見る"
    ,noAccessRecords: "アクセス記録はまだありません"
    ,noAccessRecordsBody: "公開したプロダクトがアカウントに追加されると、ここに記録されます。"
    ,productsLoadError: "プロダクトを読み込めませんでした"
    ,productsPageTitle: "あなたの方法を、人が使えるプロダクトに。"
    ,productsPageBody: "各プロダクトに、ファイル、バージョン、レビュー、Brief、公開履歴がまとまります。"
    ,createFirstProduct: "最初のプロダクトを作成"
    ,createFirstProductBody: "明確な成果から始め、資料を追加して、最初のバージョンを生成します。"
    ,notPublished: "未公開"
    ,untitledProduct: "名称未設定のプロダクト"
    ,addProductPromise: "ユーザーに伝わる価値を追加してください。"
    ,openProduct: "プロダクトを開く"
    ,startHere: "ここから開始"
    ,createFocusedProduct: "目的が明確なプロダクトを作成"
    ,createFocusedProductBody: "成果を決め、資料を追加し、最初のバージョンを生成します。"
    ,continueProductWorkflow: "このプロダクトの作成を続けます。"
    ,continueProduct: "続ける"
    ,live: "公開中"
    ,storefrontLiveBody: "プロダクトは公開中です。共有するか、最新のアクセス記録を確認できます。"
    ,viewProduct: "プロダクトを見る"
    ,productAccess: "プロダクトアクセス"
    ,buyer: "ユーザー"
    ,access: "アクセス"
    ,accessStatus: "アクセス状態"
    ,viewRecord: "記録を見る"
    ,viewAccessRecord: (reference) => `アクセス記録 ${reference} を見る`
    ,productStatus_published: "公開済み"
    ,productStatus_live: "公開済み"
    ,productStatus_candidate_required: "バージョンが必要"
    ,productStatus_candidate_ready: "レビュー可能"
    ,productStatus_candidate_rejected: "修正が必要"
    ,productStatus_ready_to_preview: "完了可能"
    ,productStatus_ready_to_publish: "公開可能"
    ,productStatus_ready_for_review: "レビュー可能"
    ,productStatus_review_ready: "レビュー可能"
    ,productStatus_preparing: "バージョンを生成中"
    ,productStatus_needs_attention: "対応が必要"
    ,productStatus_draft: "下書き"
    ,productWorkflow: "プロダクトの進行"
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
