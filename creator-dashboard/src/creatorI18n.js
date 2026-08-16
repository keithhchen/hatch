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
    removeQuestionHelp: "You do not agree with this question design. Remove it from the review set.",
    confirmRemoveQuestion: "Remove question",
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
    ,versionNeedsAttention: "Needs attention"
    ,versionGenerationPaused: "This version could not be completed."
    ,failureDetailsUnavailable: "Hatch did not return failure details for this version."
    ,retryFailedStage: "Retry this step"
    ,retryStarted: "Hatch is retrying the failed step."
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
    removeQuestionHelp: "你不认可这个问题的设计。移除后，它不会再用于审核这个产品。",
    confirmRemoveQuestion: "移除问题",
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
    ,versionNeedsAttention: "需要处理"
    ,versionGenerationPaused: "这个版本未能完成。"
    ,failureDetailsUnavailable: "Hatch 没有返回这个版本的失败详情。"
    ,retryFailedStage: "重试这一步"
    ,retryStarted: "Hatch 正在重试失败的步骤。"
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
    removeQuestionHelp: "この質問の設計に同意しません。レビュー対象から削除します。",
    confirmRemoveQuestion: "質問を削除",
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
    ,versionNeedsAttention: "対応が必要"
    ,versionGenerationPaused: "このバージョンを完了できませんでした。"
    ,failureDetailsUnavailable: "Hatch はこのバージョンの失敗詳細を返しませんでした。"
    ,retryFailedStage: "このステップを再試行"
    ,retryStarted: "Hatch が失敗したステップを再試行しています。"
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

// Copy for the legacy Product overview/test/examples/versions/data-controls
// surfaces and the release/order routes that still render from CreatorPortalV2.
// Keeping these keys here (rather than in a component) makes every reachable
// Creator Studio surface use the same locale contract.
const PORTAL_MESSAGES = {
  en: {
    overview: "Overview",
    testImprove: "Test & improve",
    examples: "Examples",
    versions: "Versions",
    dataControls: "Data controls",
    productSections: "Product sections",
    productLoadError: "We couldn't load this Product",
    defineProductPromise: "Define the Product promise and boundaries before publishing.",
    previewStorefront: "Preview storefront",
    continueInFactory: "Continue in Factory",
    reviewCandidate: "Review candidate",
    publishingWorkflow: "Publishing workflow",
    deliberateGate: "One deliberate gate at a time.",
    openFiles: "Open files",
    versionCandidate: "Version candidate",
    candidateApproval: "Candidate approval",
    storefrontPreview: "Storefront preview",
    preview: "Preview",
    viewStorefront: "View storefront",
    completePreviousStep: "Complete the previous step",
    cancel: "Cancel",
    gateNumber: (number) => `Gate ${number}`,
    corpusDigest: "Corpus digest",
    currentProduct: "Current Product",
    releaseId: "Release ID",
    publishedAt: "Published",
    status: "Status",
    materialization: "Materialization",
    rollback: "Rollback",
    ordersLoadError: "We couldn't load orders",
    revocation: "Revocation",
    accessMode: "Access mode",
    reason: "Reason",
    factoryRun: "Factory run",
    creatorFactory: "Creator Factory",
    creatorDashboard: "Creator dashboard",
    candidate: "Candidate",
    notReady: "Not ready",
    freePermanentAccess: "Free · Permanent access",
    release: "Release",
    publicUrl: "Public URL",
    notPublic: "Not public",
    productLifecycle: "Product lifecycle",
    withdrawProduct: "Withdraw this Product",
    withdrawalStopsNewAccess: "Withdrawal stops new access. It does not erase immutable releases, receipts, or existing access.",
    auditReason: "Audit reason",
    withdrawReasonPlaceholder: "Why should new access stop?",
    withdrawPublicProduct: "Withdraw the public Product?",
    existingAccessKeepRecords: "People with existing access keep their records.",
    confirmWithdrawal: "Confirm withdrawal",
    reviewWithdrawal: "Review withdrawal",
    withdrawSuccess: "The Product was withdrawn. Existing receipts and access remain available.",
    evaluation: "Evaluation",
    behaviorEvidence: "Behavior evidence",
    failed: "Failed",
    passed: "Passed",
    deterministicEvaluationGate: "Deterministic evaluation gate",
    noEvaluationReport: "No evaluation report is available yet.",
    openCandidateReport: "Open candidate report",
    buyerProof: "Buyer proof",
    representativeExamples: "Representative examples",
    example: (number) => `Example ${number}`,
    clientSafeExamples: "Add client-safe examples before publishing.",
    protectedInstructionsNeverAppear: "Protected instructions never appear here.",
    candidateApprovalCurrent: "Candidate approval is current",
    candidateLoadError: "We couldn't load this candidate",
    candidateDigest: "Candidate digest",
    criticalGate: "Critical gate",
    evaluationGate: "Evaluation gate",
    noBlindedComparison: "No blinded comparison was included in this report.",
    boundCandidateDigest: "Bound to this candidate digest",
    approveCandidateFirst: "Approve the candidate first",
    permanentAccessConfigured: "Permanent access is configured",
    noCharge: "No charge",
    registryMaterialization: "Registry materialization",
    readyToMaterialize: "Ready to materialize on publish",
    completeRequiredChecks: "Complete the required checks",
    publicCopyBoundaries: "Public copy and boundaries",
    buyerFacingCopyPresent: "Buyer-facing copy present",
    materializationFailed: "Materialization failed",
    immutableHistory: "Immutable history",
    candidatesAndReleases: "Candidates and releases",
    candidateVersion: (version) => `Candidate v${version}`,
    current: "Current",
    previous: "Previous",
    noCandidateRelease: "No candidate or release exists yet.",
    productBoundaries: "Product boundaries",
    willNotDo: "What this Product will not do",
    addExplicitBoundaries: "Add explicit boundaries before publishing.",
    privacy: "Privacy",
    buyerWorkPrivate: "Buyer work stays private",
    accessRecordsNeverInclude: "Access records never include Workspace paths, conversations, tool arguments, file content, or artifacts.",
    versionPolicy: "Version policy",
    pinnedPurchasedRelease: "Pinned to purchased release",
    candidateReview: "Candidate review",
    candidateReviewTitle: (version) => `Candidate v${version}`,
    candidateReviewBody: "Approval binds this exact Corpus digest and evaluation report. It does not publish the Product.",
    provenance: "Provenance",
    whatWasEvaluated: "What was evaluated",
    notProvided: "Not provided",
    baseRelease: "Base release",
    datasetEvalSet: "Dataset / eval set",
    regressionDigest: "Regression digest",
    heldOutDigest: "Held-out digest",
    heldOutSamples: "Held-out samples",
    criticalGates: "Critical gates",
    failedCriticalCases: "Failed critical cases",
    built: "Built",
    factoryVersion: "Factory version",
    providerModel: "Provider / model",
    reportDigest: "Report digest",
    decision: "Decision",
    criticalGatesBlockApproval: "Critical gates block approval",
    candidateCanBeApproved: "Candidate can be approved",
    resolveFailedCriticalCases: "Resolve every failed critical case in a new Factory candidate.",
    acknowledgeKnownLosses: "Acknowledge each known non-critical loss before approval.",
    allRequiredGatesPassed: "All required gates passed. Approval remains separate from publishing.",
    blocked: "Blocked",
    readyForDecision: "Ready for decision",
    deterministicGates: "Deterministic gates",
    evaluationReport: "Evaluation report",
    noIndividualGateRows: "The report has no individual gate rows.",
    blindedComparison: "Blinded current / candidate comparison",
    currentValue: (value) => `Current: ${value}`,
    candidateValue: (value) => `Candidate: ${value}`,
    blindedResult: "Blinded result",
    caseNumber: (number) => `Case ${number}`,
    materialBehaviorChanges: "Material behavior changes",
    noMaterialBehaviorChanges: "No material behavior changes were reported.",
    noProductBoundaries: "No Product boundaries were included in this report.",
    knownNonCriticalLosses: "Known non-critical losses",
    loss: (number) => `Loss ${number}`,
    approvalImmutable: "Approval is immutable for this digest.",
    candidateChangeInvalidates: "Any candidate or report change invalidates it.",
    archiveCandidate: "Archive this candidate?",
    yesReject: "Yes, reject",
    rejectCandidate: "Reject candidate",
    approveCandidate: "Approve candidate",
    approved: "Approved",
    previewLoadError: "We couldn't build the storefront preview",
    copyFailed: "Copy failed. Select the link and copy it manually.",
    yourProductLive: "Your Product is live",
    publishedPermanentBody: "People can now purchase this immutable release at no charge and keep permanent access.",
    publicationCompleted: "Publication completed",
    shareLink: "Share link",
    copied: "Copied",
    copyLink: "Copy link",
    backToProduct: "Back to Product",
    seeExactly: "See exactly what people will see.",
    previewBody: "This preview is pinned to the approved candidate. Access is free and permanent after you publish.",
    previewViewport: "Preview viewport",
    desktop: "Desktop",
    mobile: "Mobile",
    getAccess: "Get access",
    publishReadiness: "Publish readiness",
    finalChecks: "Final checks",
    publishCandidateConfirm: "Publish this immutable candidate?",
    publicPointerAfterMaterialization: "The public current pointer changes only after materialization succeeds.",
    assignedAfterPublish: "Assigned after publish",
    publishingCreates: "Publishing creates an immutable release. Future changes require another release or an audited rollback.",
    confirmPublish: "Confirm publish",
    publish: "Publish",
    releaseLoadError: "We couldn't load this release",
    releaseNotFound: "Release not found",
    releaseHistoryMissing: "This release is not present in the Product history.",
    backToVersions: "Back to versions",
    immutableRelease: "Immutable release",
    existingAccessPinned: "Existing access remains pinned to the release it received.",
    currentReleaseUpdated: "Current release updated. Existing access was not changed.",
    alreadyCurrentRelease: "This is already the public current release.",
    makeExactReleaseCurrent: "Make this exact release current",
    releaseFixedByPage: "The release is fixed by this page. Existing access stays pinned to its original release.",
    whyReleaseCurrent: "Why should this release become current?",
    rollbackPreview: "Rollback preview · Not public",
    exactReleaseConfirm: "Make this exact release current?",
    rollbackAudit: "This writes an authenticated rollback audit. Existing access keeps its original release.",
    confirmRollback: "Confirm rollback",
    reviewRollback: "Review rollback",
    accessRecords: "Access records",
    accessRecordsTitle: "See who can use each Product.",
    accessRecordsBody: "Follow access without exposing anyone's private Workspace content.",
    orderStatus: "Order status",
    all: "All",
    fulfilled: "Fulfilled",
    refundPending: "Refund pending",
    refunded: "Refunded",
    failedOrder: "Failed",
    productId: "Product ID",
    allProducts: "All Products",
    fromDate: "From date",
    toDate: "To date",
    rowsPerPage: "Rows per page",
    clearFilters: "Clear filters",
    noMatchingOrders: "No matching orders",
    noOrdersBody: "Try a different filter, or share a published storefront to reach your first Buyer.",
    loadedOrders: (count, plural, suffix) => `Loaded ${count} order${plural ? "s" : ""}${suffix}`,
    moreAvailable: "; more are available",
    endResults: "; end of results",
    loadNextPage: "Load next page",
    orderLoadError: "We couldn't load this order",
    orderDetail: "Order detail",
    accessRecord: "Access record",
    whatBuyerReceived: "What the Buyer received",
    accessMetadata: "Access metadata",
    privateByDesign: "Private by design",
    workspacePathsPrivate: "Workspace paths, conversations, file content, tool arguments, and artifacts are never shown here.",
    timeline: "Timeline",
    accessHistory: "Access history",
    orderAction: "Order action",
    revokeAccess: "Revoke access",
    reasonRequired: "A reason is required for the audit record.",
    revokeReasonPlaceholder: "Reason for revoking this access",
    revokeConfirm: "Revoke this access?",
    entitlementNotUsable: "The entitlement will no longer be usable in Hatch Desktop.",
    confirmRevoke: "Confirm revoke",
    reviewRevoke: "Review revoke",
    noRevokeAvailable: "No revoke action is available for this order state.",
    refundRecorded: "The refund request was recorded. Refreshing the authoritative order state.",
    permanent: "Permanent",
    metered: "Metered",
    statusActive: "Active",
    statusCompleted: "Completed",
    statusNone: "None",
    statusReady: "Ready",
    statusPreparing: "Preparing",
    statusRetired: "Retired",
    loadingCreatorPage: "Loading Creator page",
    unexpectedError: "An unexpected error occurred.",
    sessionExpired: "Your session expired. Sign in again to continue.",
    creatorForbidden: "This Creator account cannot access that resource.",
    requestedResourceMissing: "The requested resource no longer exists.",
    pageChanged: "This page changed in another tab. Refresh the latest version before trying again.",
    tooManyRequests: "Too many requests. Your work is preserved; try again shortly.",
    serviceUnavailable: "The service is temporarily unavailable. Try again.",
    orderCreated: "Order created",
    purchaseRecorded: "Purchase recorded",
    accessEvent: (status) => `Access ${status}`,
    refundEvent: (status) => `Refund ${status}`,
    statusApproved: "Approved",
    statusPublished: "Published",
    statusRefunded: "Refunded",
    statusPending: "Pending",
    statusFailed: "Failed",
    statusFulfilled: "Fulfilled",
    statusRefundPending: "Refund pending",
    statusReversed: "Reversed",
    statusAvailable: "Available",
    statusProcessing: "Processing",
    statusReserved: "Reserved",
    statusInTransit: "In transit",
    statusBlocked: "Blocked",
  },
  zh: {
    overview: "概览",
    testImprove: "测试与改进",
    examples: "示例",
    versions: "版本",
    dataControls: "数据控制",
    productSections: "产品分区",
    productLoadError: "无法加载这个产品",
    defineProductPromise: "发布前先定义产品承诺与边界。",
    previewStorefront: "预览 storefront",
    continueInFactory: "在 Factory 中继续",
    reviewCandidate: "审核候选版本",
    publishingWorkflow: "发布流程",
    deliberateGate: "一次只通过一个明确的关卡。",
    openFiles: "打开文件",
    versionCandidate: "版本候选",
    candidateApproval: "候选版本批准",
    storefrontPreview: "Storefront 预览",
    preview: "预览",
    viewStorefront: "查看 storefront",
    completePreviousStep: "请先完成上一步",
    cancel: "取消",
    gateNumber: (number) => `关卡 ${number}`,
    corpusDigest: "Corpus 摘要",
    currentProduct: "当前产品",
    releaseId: "发布版本 ID",
    publishedAt: "发布时间",
    status: "状态",
    materialization: "物化状态",
    rollback: "回滚",
    ordersLoadError: "无法加载订单",
    revocation: "撤销状态",
    accessMode: "使用权模式",
    reason: "原因",
    factoryRun: "Factory 运行",
    creatorFactory: "创作者 Factory",
    creatorDashboard: "创作者控制台",
    candidate: "候选版本",
    notReady: "尚未准备好",
    freePermanentAccess: "免费 · 永久使用权",
    release: "发布版本",
    publicUrl: "公开 URL",
    notPublic: "尚未公开",
    productLifecycle: "产品生命周期",
    withdrawProduct: "撤回这个产品",
    withdrawalStopsNewAccess: "撤回会停止新的使用权，不会删除不可变发布版本、凭据或已有使用权。",
    auditReason: "审计原因",
    withdrawReasonPlaceholder: "为什么要停止新的使用权？",
    withdrawPublicProduct: "撤回公开产品？",
    existingAccessKeepRecords: "已有使用权的人仍可保留记录。",
    confirmWithdrawal: "确认撤回",
    reviewWithdrawal: "检查撤回",
    withdrawSuccess: "产品已撤回。已有凭据与使用权仍然可用。",
    evaluation: "评估",
    behaviorEvidence: "行为证据",
    failed: "未通过",
    passed: "已通过",
    deterministicEvaluationGate: "确定性评估关卡",
    noEvaluationReport: "暂时没有评估报告。",
    openCandidateReport: "打开候选版本报告",
    buyerProof: "用户侧证明",
    representativeExamples: "代表性示例",
    example: (number) => `示例 ${number}`,
    clientSafeExamples: "发布前添加可向用户展示的示例。",
    protectedInstructionsNeverAppear: "受保护的指令不会出现在这里。",
    candidateApprovalCurrent: "候选版本批准仍然有效",
    candidateLoadError: "无法加载这个候选版本",
    candidateDigest: "候选版本摘要",
    criticalGate: "关键关卡",
    evaluationGate: "评估关卡",
    noBlindedComparison: "报告没有包含盲测对比。",
    boundCandidateDigest: "已绑定此候选版本摘要",
    approveCandidateFirst: "请先批准候选版本",
    permanentAccessConfigured: "永久使用权已配置",
    noCharge: "不收费",
    registryMaterialization: "注册表物化",
    readyToMaterialize: "发布时可以物化",
    completeRequiredChecks: "完成必需检查",
    publicCopyBoundaries: "公开文案与边界",
    buyerFacingCopyPresent: "已有面向用户的文案",
    materializationFailed: "物化失败",
    immutableHistory: "不可变历史",
    candidatesAndReleases: "候选版本与发布版本",
    candidateVersion: (version) => `候选版本 v${version}`,
    current: "当前",
    previous: "之前",
    noCandidateRelease: "还没有候选版本或发布版本。",
    productBoundaries: "产品边界",
    willNotDo: "这个产品不会做什么",
    addExplicitBoundaries: "发布前添加明确的边界。",
    privacy: "隐私",
    buyerWorkPrivate: "用户工作内容保持私密",
    accessRecordsNeverInclude: "使用记录不会包含 Workspace 路径、对话、工具参数、文件内容或产物。",
    versionPolicy: "版本策略",
    pinnedPurchasedRelease: "固定到购买时的发布版本",
    candidateReview: "候选版本审核",
    candidateReviewTitle: (version) => `候选版本 v${version}`,
    candidateReviewBody: "批准会绑定这份 Corpus 摘要与评估报告，不会发布产品。",
    provenance: "来源证明",
    whatWasEvaluated: "评估了什么",
    notProvided: "未提供",
    baseRelease: "基础发布版本",
    datasetEvalSet: "数据集 / 评估集",
    regressionDigest: "回归摘要",
    heldOutDigest: "留出摘要",
    heldOutSamples: "留出样本",
    criticalGates: "关键关卡",
    failedCriticalCases: "失败的关键案例",
    built: "构建时间",
    factoryVersion: "Factory 版本",
    providerModel: "Provider / model",
    reportDigest: "报告摘要",
    decision: "决定",
    criticalGatesBlockApproval: "关键关卡阻止批准",
    candidateCanBeApproved: "候选版本可以批准",
    resolveFailedCriticalCases: "请在新的 Factory 候选版本中解决所有失败的关键案例。",
    acknowledgeKnownLosses: "批准前请确认每个已知的非关键损失。",
    allRequiredGatesPassed: "所有必需关卡都已通过。批准仍独立于发布。",
    blocked: "已阻止",
    readyForDecision: "可以决定",
    deterministicGates: "确定性关卡",
    evaluationReport: "评估报告",
    noIndividualGateRows: "报告没有单独的关卡行。",
    blindedComparison: "盲测当前版本 / 候选版本对比",
    currentValue: (value) => `当前：${value}`,
    candidateValue: (value) => `候选：${value}`,
    blindedResult: "盲测结果",
    caseNumber: (number) => `案例 ${number}`,
    materialBehaviorChanges: "重要行为变化",
    noMaterialBehaviorChanges: "没有报告重要行为变化。",
    noProductBoundaries: "报告没有包含产品边界。",
    knownNonCriticalLosses: "已知的非关键损失",
    loss: (number) => `损失 ${number}`,
    approvalImmutable: "这份摘要的批准不可变。",
    candidateChangeInvalidates: "候选版本或报告有任何变化都会使批准失效。",
    archiveCandidate: "归档这个候选版本？",
    yesReject: "确认拒绝",
    rejectCandidate: "拒绝候选版本",
    approveCandidate: "批准候选版本",
    approved: "已批准",
    previewLoadError: "无法构建 storefront 预览",
    copyFailed: "复制失败。请选择链接后手动复制。",
    yourProductLive: "你的产品已上线",
    publishedPermanentBody: "用户现在可以免费购买这个不可变发布版本，并永久使用。",
    publicationCompleted: "发布已完成",
    shareLink: "分享链接",
    copied: "已复制",
    copyLink: "复制链接",
    backToProduct: "返回产品",
    seeExactly: "准确查看用户将看到的内容。",
    previewBody: "预览固定到已批准的候选版本。发布后使用权免费且永久。",
    previewViewport: "预览视口",
    desktop: "桌面端",
    mobile: "移动端",
    getAccess: "获取使用权",
    publishReadiness: "发布准备度",
    finalChecks: "最终检查",
    publishCandidateConfirm: "发布这个不可变候选版本？",
    publicPointerAfterMaterialization: "只有物化成功后，公开的当前指针才会更新。",
    assignedAfterPublish: "发布后分配",
    publishingCreates: "发布会创建不可变版本。未来变更需要新的发布版本或经过审计的回滚。",
    confirmPublish: "确认发布",
    publish: "发布",
    releaseLoadError: "无法加载这个发布版本",
    releaseNotFound: "找不到发布版本",
    releaseHistoryMissing: "这个发布版本不在产品历史中。",
    backToVersions: "返回版本",
    immutableRelease: "不可变发布版本",
    existingAccessPinned: "已有使用权仍固定到用户获得的版本。",
    currentReleaseUpdated: "当前发布版本已更新，已有使用权没有改变。",
    alreadyCurrentRelease: "这已经是公开的当前发布版本。",
    makeExactReleaseCurrent: "将这个准确版本设为当前版本",
    releaseFixedByPage: "此页面固定了发布版本。已有使用权仍固定到原始版本。",
    whyReleaseCurrent: "为什么要将这个版本设为当前版本？",
    rollbackPreview: "回滚预览 · 尚未公开",
    exactReleaseConfirm: "将这个准确版本设为当前版本？",
    rollbackAudit: "这会写入经过身份验证的回滚审计。已有使用权仍保留原始版本。",
    confirmRollback: "确认回滚",
    reviewRollback: "检查回滚",
    accessRecords: "使用记录",
    accessRecordsTitle: "查看每个产品谁可以使用。",
    accessRecordsBody: "跟踪使用权，不暴露任何人的私密 Workspace 内容。",
    orderStatus: "订单状态",
    all: "全部",
    fulfilled: "已履约",
    refundPending: "退款处理中",
    refunded: "已退款",
    failedOrder: "失败",
    productId: "产品 ID",
    allProducts: "全部产品",
    fromDate: "开始日期",
    toDate: "结束日期",
    rowsPerPage: "每页行数",
    clearFilters: "清除筛选",
    noMatchingOrders: "没有匹配的订单",
    noOrdersBody: "试试其他筛选条件，或分享已发布的 storefront 来获得第一个用户。",
    loadedOrders: (count, plural, suffix) => `已加载 ${count} 个订单${suffix}`,
    moreAvailable: "；还有更多",
    endResults: "；已到结果末尾",
    loadNextPage: "加载下一页",
    orderLoadError: "无法加载这个订单",
    orderDetail: "订单详情",
    accessRecord: "使用记录",
    whatBuyerReceived: "用户获得了什么",
    accessMetadata: "使用权元数据",
    privateByDesign: "默认保持私密",
    workspacePathsPrivate: "这里不会显示 Workspace 路径、对话、文件内容、工具参数或产物。",
    timeline: "时间线",
    accessHistory: "使用历史",
    orderAction: "订单操作",
    revokeAccess: "撤销使用权",
    reasonRequired: "审计记录需要填写原因。",
    revokeReasonPlaceholder: "撤销这项使用权的原因",
    revokeConfirm: "撤销这项使用权？",
    entitlementNotUsable: "该使用权将无法继续在 Hatch Desktop 中使用。",
    confirmRevoke: "确认撤销",
    reviewRevoke: "检查撤销",
    noRevokeAvailable: "当前订单状态不支持撤销使用权。",
    refundRecorded: "退款申请已记录，正在刷新权威订单状态。",
    permanent: "永久",
    metered: "按量",
    statusActive: "有效",
    statusCompleted: "已完成",
    statusNone: "无",
    statusReady: "已准备好",
    statusPreparing: "准备中",
    statusRetired: "已停用",
    loadingCreatorPage: "正在加载创作者页面",
    unexpectedError: "发生意外错误。",
    sessionExpired: "登录状态已过期，请重新登录后继续。",
    creatorForbidden: "这个创作者账户无权访问该资源。",
    requestedResourceMissing: "请求的资源已不存在。",
    pageChanged: "此页面已在另一个标签页中变化，请刷新最新版本后再试。",
    tooManyRequests: "请求过于频繁。你的工作已保留，请稍后再试。",
    serviceUnavailable: "服务暂时不可用，请稍后再试。",
    orderCreated: "订单已创建",
    purchaseRecorded: "购买已记录",
    accessEvent: (status) => `使用权${status}`,
    refundEvent: (status) => `退款${status}`,
    statusApproved: "已批准",
    statusPublished: "已发布",
    statusRefunded: "已退款",
    statusPending: "处理中",
    statusFailed: "失败",
    statusFulfilled: "已履约",
    statusRefundPending: "退款处理中",
    statusReversed: "已冲正",
    statusAvailable: "可用",
    statusProcessing: "处理中",
    statusReserved: "已预留",
    statusInTransit: "运输中",
    statusBlocked: "已阻止",
  },
  ja: {
    overview: "概要",
    testImprove: "テストと改善",
    examples: "例",
    versions: "バージョン",
    dataControls: "データ管理",
    productSections: "プロダクトのセクション",
    productLoadError: "プロダクトを読み込めませんでした",
    defineProductPromise: "公開前にプロダクトの約束と境界を定義します。",
    previewStorefront: "ストアフロントをプレビュー",
    continueInFactory: "Factory で続ける",
    reviewCandidate: "候補をレビュー",
    publishingWorkflow: "公開の流れ",
    deliberateGate: "一つずつ明確なゲートを通します。",
    openFiles: "ファイルを開く",
    versionCandidate: "バージョン候補",
    candidateApproval: "候補の承認",
    storefrontPreview: "ストアフロントのプレビュー",
    preview: "プレビュー",
    viewStorefront: "ストアフロントを見る",
    completePreviousStep: "前のステップを完了してください",
    cancel: "キャンセル",
    gateNumber: (number) => `ゲート ${number}`,
    corpusDigest: "Corpus ダイジェスト",
    currentProduct: "現在のプロダクト",
    releaseId: "リリース ID",
    publishedAt: "公開日時",
    status: "ステータス",
    materialization: "マテリアライズ状態",
    rollback: "ロールバック",
    ordersLoadError: "注文を読み込めませんでした",
    revocation: "取り消し状態",
    accessMode: "アクセスモード",
    reason: "理由",
    factoryRun: "Factory 実行",
    creatorFactory: "クリエイター Factory",
    creatorDashboard: "クリエイターダッシュボード",
    candidate: "候補",
    notReady: "準備未完了",
    freePermanentAccess: "無料 · 永久アクセス",
    release: "リリース",
    publicUrl: "公開 URL",
    notPublic: "非公開",
    productLifecycle: "プロダクトのライフサイクル",
    withdrawProduct: "このプロダクトを取り下げる",
    withdrawalStopsNewAccess: "取り下げると新しいアクセスを停止します。イミュータブルなリリース、レシート、既存アクセスは削除しません。",
    auditReason: "監査理由",
    withdrawReasonPlaceholder: "新しいアクセスを停止する理由",
    withdrawPublicProduct: "公開中のプロダクトを取り下げますか？",
    existingAccessKeepRecords: "既存アクセスの記録は保持されます。",
    confirmWithdrawal: "取り下げを確定",
    reviewWithdrawal: "取り下げを確認",
    withdrawSuccess: "プロダクトを取り下げました。既存のレシートとアクセスは引き続き利用できます。",
    evaluation: "評価",
    behaviorEvidence: "動作の証拠",
    failed: "不合格",
    passed: "合格",
    deterministicEvaluationGate: "決定論的な評価ゲート",
    noEvaluationReport: "評価レポートはまだありません。",
    openCandidateReport: "候補レポートを開く",
    buyerProof: "購入者向けの証拠",
    representativeExamples: "代表例",
    example: (number) => `例 ${number}`,
    clientSafeExamples: "公開前に購入者向けの安全な例を追加してください。",
    protectedInstructionsNeverAppear: "保護された指示はここに表示されません。",
    candidateApprovalCurrent: "候補の承認は最新です",
    candidateLoadError: "この候補を読み込めませんでした",
    candidateDigest: "候補ダイジェスト",
    criticalGate: "重要ゲート",
    evaluationGate: "評価ゲート",
    noBlindedComparison: "このレポートにブラインド比較は含まれていません。",
    boundCandidateDigest: "この候補ダイジェストに固定",
    approveCandidateFirst: "まず候補を承認してください",
    permanentAccessConfigured: "永久アクセスを設定済み",
    noCharge: "無料",
    registryMaterialization: "レジストリのマテリアライズ",
    readyToMaterialize: "公開時にマテリアライズ可能",
    completeRequiredChecks: "必要なチェックを完了してください",
    publicCopyBoundaries: "公開コピーと境界",
    buyerFacingCopyPresent: "購入者向けコピーあり",
    materializationFailed: "マテリアライズに失敗",
    immutableHistory: "イミュータブルな履歴",
    candidatesAndReleases: "候補とリリース",
    candidateVersion: (version) => `候補 v${version}`,
    current: "現在",
    previous: "以前",
    noCandidateRelease: "候補またはリリースはまだありません。",
    productBoundaries: "プロダクトの境界",
    willNotDo: "このプロダクトが行わないこと",
    addExplicitBoundaries: "公開前に明確な境界を追加してください。",
    privacy: "プライバシー",
    buyerWorkPrivate: "購入者の作業は非公開",
    accessRecordsNeverInclude: "アクセス記録に Workspace のパス、会話、ツール引数、ファイル内容、成果物は含まれません。",
    versionPolicy: "バージョンポリシー",
    pinnedPurchasedRelease: "購入したリリースに固定",
    candidateReview: "候補レビュー",
    candidateReviewTitle: (version) => `候補 v${version}`,
    candidateReviewBody: "承認はこの Corpus ダイジェストと評価レポートに固定されます。プロダクトは公開されません。",
    provenance: "プロヴェナンス",
    whatWasEvaluated: "評価対象",
    notProvided: "未提供",
    baseRelease: "ベースリリース",
    datasetEvalSet: "データセット / 評価セット",
    regressionDigest: "回帰ダイジェスト",
    heldOutDigest: "ホールドアウトダイジェスト",
    heldOutSamples: "ホールドアウトサンプル",
    criticalGates: "重要ゲート",
    failedCriticalCases: "失敗した重要ケース",
    built: "ビルド日時",
    factoryVersion: "Factory バージョン",
    providerModel: "Provider / model",
    reportDigest: "レポートダイジェスト",
    decision: "判断",
    criticalGatesBlockApproval: "重要ゲートが承認を阻止しています",
    candidateCanBeApproved: "候補を承認できます",
    resolveFailedCriticalCases: "新しい Factory 候補で失敗した重要ケースをすべて解決してください。",
    acknowledgeKnownLosses: "承認前に既知の非重要な損失を確認してください。",
    allRequiredGatesPassed: "必須ゲートはすべて合格しました。承認は公開とは別です。",
    blocked: "ブロック中",
    readyForDecision: "判断可能",
    deterministicGates: "決定論的ゲート",
    evaluationReport: "評価レポート",
    noIndividualGateRows: "レポートに個別のゲート行はありません。",
    blindedComparison: "現在と候補のブラインド比較",
    currentValue: (value) => `現在: ${value}`,
    candidateValue: (value) => `候補: ${value}`,
    blindedResult: "ブラインド結果",
    caseNumber: (number) => `ケース ${number}`,
    materialBehaviorChanges: "重要な動作の変更",
    noMaterialBehaviorChanges: "重要な動作の変更は報告されていません。",
    noProductBoundaries: "このレポートにプロダクトの境界は含まれていません。",
    knownNonCriticalLosses: "既知の非重要な損失",
    loss: (number) => `損失 ${number}`,
    approvalImmutable: "このダイジェストの承認は変更できません。",
    candidateChangeInvalidates: "候補またはレポートが変わると承認は無効になります。",
    archiveCandidate: "この候補をアーカイブしますか？",
    yesReject: "拒否する",
    rejectCandidate: "候補を拒否",
    approveCandidate: "候補を承認",
    approved: "承認済み",
    previewLoadError: "ストアフロントのプレビューを作成できませんでした",
    copyFailed: "コピーに失敗しました。リンクを選択して手動でコピーしてください。",
    yourProductLive: "プロダクトが公開中です",
    publishedPermanentBody: "このイミュータブルなリリースを無料で購入でき、永久にアクセスできます。",
    publicationCompleted: "公開完了",
    shareLink: "共有リンク",
    copied: "コピー済み",
    copyLink: "リンクをコピー",
    backToProduct: "プロダクトに戻る",
    seeExactly: "購入者に表示される内容を正確に確認します。",
    previewBody: "このプレビューは承認済み候補に固定されています。公開後のアクセスは無料かつ永久です。",
    previewViewport: "プレビュー表示",
    desktop: "デスクトップ",
    mobile: "モバイル",
    getAccess: "アクセスする",
    publishReadiness: "公開準備",
    finalChecks: "最終チェック",
    publishCandidateConfirm: "このイミュータブルな候補を公開しますか？",
    publicPointerAfterMaterialization: "マテリアライズが成功した後だけ公開中のポインターが変わります。",
    assignedAfterPublish: "公開後に割り当て",
    publishingCreates: "公開するとイミュータブルなリリースが作成されます。今後の変更には別リリースまたは監査済みロールバックが必要です。",
    confirmPublish: "公開を確定",
    publish: "公開",
    releaseLoadError: "このリリースを読み込めませんでした",
    releaseNotFound: "リリースが見つかりません",
    releaseHistoryMissing: "このリリースはプロダクト履歴にありません。",
    backToVersions: "バージョンに戻る",
    immutableRelease: "イミュータブルなリリース",
    existingAccessPinned: "既存アクセスは受け取ったリリースに固定されています。",
    currentReleaseUpdated: "現在のリリースを更新しました。既存アクセスは変更されていません。",
    alreadyCurrentRelease: "これはすでに公開中の現在リリースです。",
    makeExactReleaseCurrent: "このリリースを現在にする",
    releaseFixedByPage: "このページでリリースが固定されています。既存アクセスは元のリリースに固定されたままです。",
    whyReleaseCurrent: "このリリースを現在にする理由",
    rollbackPreview: "ロールバックプレビュー · 非公開",
    exactReleaseConfirm: "このリリースを現在にしますか？",
    rollbackAudit: "認証済みロールバック監査を書き込みます。既存アクセスは元のリリースを保持します。",
    confirmRollback: "ロールバックを確定",
    reviewRollback: "ロールバックを確認",
    accessRecords: "アクセス記録",
    accessRecordsTitle: "各プロダクトを使える人を確認します。",
    accessRecordsBody: "誰の非公開 Workspace コンテンツも公開せずにアクセスを追跡します。",
    orderStatus: "注文ステータス",
    all: "すべて",
    fulfilled: "履行済み",
    refundPending: "返金保留",
    refunded: "返金済み",
    failedOrder: "失敗",
    productId: "プロダクト ID",
    allProducts: "すべてのプロダクト",
    fromDate: "開始日",
    toDate: "終了日",
    rowsPerPage: "1ページの行数",
    clearFilters: "フィルターをクリア",
    noMatchingOrders: "一致する注文はありません",
    noOrdersBody: "別のフィルターを試すか、公開済みストアフロントを共有して最初の購入者を迎えましょう。",
    loadedOrders: (count, plural, suffix) => `${count}件の注文を読み込み${suffix}`,
    moreAvailable: "（さらにあります）",
    endResults: "（結果は以上です）",
    loadNextPage: "次のページを読み込む",
    orderLoadError: "この注文を読み込めませんでした",
    orderDetail: "注文の詳細",
    accessRecord: "アクセス記録",
    whatBuyerReceived: "購入者が受け取ったもの",
    accessMetadata: "アクセスメタデータ",
    privateByDesign: "設計上非公開",
    workspacePathsPrivate: "Workspace のパス、会話、ファイル内容、ツール引数、成果物はここに表示されません。",
    timeline: "タイムライン",
    accessHistory: "アクセス履歴",
    orderAction: "注文操作",
    revokeAccess: "アクセスを取り消す",
    reasonRequired: "監査記録の理由が必要です。",
    revokeReasonPlaceholder: "このアクセスを取り消す理由",
    revokeConfirm: "このアクセスを取り消しますか？",
    entitlementNotUsable: "このエンタイトルメントは Hatch Desktop で利用できなくなります。",
    confirmRevoke: "取り消しを確定",
    reviewRevoke: "取り消しを確認",
    noRevokeAvailable: "この注文状態では取り消し操作を利用できません。",
    refundRecorded: "返金リクエストを記録しました。正規の注文状態を更新しています。",
    permanent: "永久",
    metered: "メータリング",
    statusActive: "有効",
    statusCompleted: "完了",
    statusNone: "なし",
    statusReady: "準備完了",
    statusPreparing: "準備中",
    statusRetired: "終了",
    loadingCreatorPage: "クリエイターページを読み込み中",
    unexpectedError: "予期しないエラーが発生しました。",
    sessionExpired: "セッションの有効期限が切れました。再度サインインしてください。",
    creatorForbidden: "このクリエイターアカウントはそのリソースにアクセスできません。",
    requestedResourceMissing: "要求されたリソースは存在しません。",
    pageChanged: "別のタブでページが変更されました。最新バージョンを更新してから再試行してください。",
    tooManyRequests: "リクエストが多すぎます。作業は保存されています。しばらくしてから再試行してください。",
    serviceUnavailable: "サービスは一時的に利用できません。後でもう一度お試しください。",
    orderCreated: "注文を作成",
    purchaseRecorded: "購入を記録",
    accessEvent: (status) => `アクセス ${status}`,
    refundEvent: (status) => `返金 ${status}`,
    statusApproved: "承認済み",
    statusPublished: "公開済み",
    statusRefunded: "返金済み",
    statusPending: "保留中",
    statusFailed: "失敗",
    statusFulfilled: "履行済み",
    statusRefundPending: "返金保留",
    statusReversed: "取り消し済み",
    statusAvailable: "利用可能",
    statusProcessing: "処理中",
    statusReserved: "予約済み",
    statusInTransit: "輸送中",
    statusBlocked: "ブロック中",
  }
};

export function createCreatorTranslator(locale = "en") {
  const messages = {
    ...MESSAGES.en,
    ...PORTAL_MESSAGES.en,
    ...(MESSAGES[locale] ?? {}),
    ...(PORTAL_MESSAGES[locale] ?? {})
  };
  return (key, ...args) => {
    const value = messages[key] ?? MESSAGES.en[key] ?? key;
    return typeof value === "function" ? value(...args) : value;
  };
}

export const CREATOR_LOCALES = ["en", "zh", "ja"];
export const CREATOR_PORTAL_KEYS = Object.keys(PORTAL_MESSAGES.en);
