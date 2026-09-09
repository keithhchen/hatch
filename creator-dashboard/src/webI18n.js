export const WEB_LOCALES = Object.freeze(["en", "zh", "ja"]);
export const WEB_LOCALE_STORAGE_KEY = "hatch.web.locale";
export const WEB_LOCALE_TAGS = Object.freeze({ en: "en-US", zh: "zh-CN", ja: "ja-JP" });

const LOCALE_LABELS = Object.freeze({
  en: "English",
  zh: "中文",
  ja: "日本語"
});

export const WEB_API_ERROR_KEYS = Object.freeze({
  unauthorized: "errors.sessionExpired",
  forbidden: "errors.accessDenied",
  not_found: "errors.notFound",
  route_not_found: "errors.routeNotFound",
  product_not_found: "errors.productNotFound",
  creator_not_found: "errors.creatorNotFound",
  checkout_not_found: "errors.checkoutNotFound",
  order_not_found: "errors.orderNotFound",
  entitlement_not_found: "errors.entitlementNotFound",
  agent_unavailable: "errors.agentUnavailable",
  product_unavailable: "errors.productUnavailable",
  candidate_incomplete: "errors.candidateIncomplete",
  candidate_report_changed: "errors.releaseChanged",
  candidate_changed: "errors.candidateChanged",
  candidate_loss_unacknowledged: "errors.candidateLoss",
  invalid_checkout: "errors.invalidCheckout",
  csrf_rejected: "errors.csrfRejected"
});

const WEB_IDENTIFIER_KEYS = Object.freeze({
  active: "buyer.available",
  available: "buyer.available",
  reserved: "buyer.inProgress",
  pending: "buyer.pending",
  processing: "buyer.settingUpStatus",
  preparing: "buyer.statusPreparing",
  consumed: "buyer.used",
  used: "buyer.used",
  expired: "buyer.expired",
  suspended: "buyer.paused",
  revoked: "buyer.accessEnded",
  none: "buyer.noAccess",
  fulfilled: "common.accessGranted",
  delivered: "buyer.statusDelivered",
  completed: "common.accessGranted",
  payment_pending: "buyer.paymentPending",
  succeeded: "buyer.paymentSucceeded",
  paid: "buyer.paymentSucceeded",
  requires_action: "buyer.actionRequired",
  not_required: "buyer.paymentNotRequired",
  failed: "buyer.failed",
  declined: "buyer.failed",
  cancelled: "buyer.cancelled",
  refunded: "buyer.refunded",
  refund_pending: "buyer.refunded",
  in_transit: "buyer.inProgress",
  not_started: "common.notRecorded",
  not_applicable: "common.notRecorded",
  ready: "buyer.available",
  published: "buyer.statusPublished",
  ready_to_publish: "buyer.statusReadyToPublish"
});

const MESSAGES = {
  en: {
    common: {
      language: "Language",
      english: "English",
      chinese: "中文",
      japanese: "日本語",
      hatchHome: "Hatch home",
      pageSections: "Page sections",
      languageSwitcher: "Language switcher",
      buyerNavigation: "Buyer navigation",
      openNavigation: "Open navigation",
      accountSettings: "Account settings",
      loading: "Loading",
      loadingDetails: "Loading details",
      openingWorkspace: "Opening your workspace…",
      reload: "Reload",
      tryAgain: "Try again",
      retry: "Retry",
      signIn: "Sign in",
      explore: "Explore",
      library: "Library",
      orders: "Orders",
      download: "Download",
      free: "Free",
      notRecorded: "Not recorded",
      notProvided: "Not provided",
      noScheduledExpiry: "No scheduled expiry",
      product: "Product",
      order: "Order",
      access: "Access",
      accessGranted: "Access granted",
      account: "Account",
      creator: "Creator",
      hatchCreatorHome: "Hatch Creator home",
      creatorNavigation: "Creator navigation",
      creatorAccessRequired: "Creator access is required.",
      creatorAccessBody: "This account can use purchased Agents, but it cannot edit Creator products.",
      createCreatorAccount: "Create a Creator account",
      openYourLibrary: "Open your library",
      pageUnavailable: "Hatch could not open this page.",
      pageUnavailableBody: "Reload to try again. Your account and product data have not been changed.",
      authResponseIncomplete: "The authentication response is incomplete."
    },
    app: {
      title: "Hatch Creator Agents"
    },
    onepager: {
      title: "Hatch — AI products for expert creators",
      home: "Hatch home",
      sections: "Page sections",
      language: "Language switcher",
      positioning: "Product positioning",
      examples: "Example creator products"
    },
    buyer: {
      productsTitle: "Methods you can put to work.",
      productsBody: "Understand the promise and boundaries first. Add a Product to your account only when it fits the job.",
      availableProducts: "Available products",
      noProducts: "No products are public yet",
      noProductsBody: "Published products will appear here. Try again later.",
      creatorProducts: "Creator products",
      noPublicProducts: "No public products yet",
      noPublicProductsBody: "This Creator has not published a product that can be browsed.",
      exploreAllProducts: "Explore all products",
      productAccess: "Product access",
      loadingProducts: "Loading products",
      loadingProduct: "Loading Product",
      openingAccount: "Opening your account",
      agentDetails: "Agent details",
      howItWorks: "How it works",
      accessFromWork: "From access to useful work.",
      stepAddAgent: "Add the Agent",
      stepOpenDesktop: "Open Hatch Desktop",
      stepWorkAgent: "Work with the Agent",
      representativeExamples: "Representative examples",
      whatYouProvide: "What you provide",
      whatYouReceive: "What you receive",
      boundaries: "Boundaries",
      privacy: "Privacy",
      workUnderControl: "Your work stays under your control.",
      desktopRequirement: "Desktop requirement",
      permanentAccess: "Permanent access",
      unavailable: "Unavailable",
      available: "Available",
      verified: "Verified",
      inLibrary: "In your library",
      accountSettings: "Account settings",
      accountTitle: "Your Hatch account.",
      accountBody: "Use the same account on Web and Desktop. Signing out keeps your access records intact.",
      signedInAccount: "Signed-in account",
      accountHelp: "Account help",
      accountHelpTitle: "Get back to the right account.",
      accountHelpBody: "Orders and Agent access belong to the account that confirmed checkout. Use that same account in Hatch Desktop.",
      session: "Session",
      signedIn: "You are signed in.",
      signInContinue: "Sign in to continue.",
      sessionBody: "If a receipt or Product access is missing, confirm that Web and Desktop use the same account.",
      purchaseSupport: "Purchase support",
      supportReference: "Keep the support reference.",
      supportBody: "Open the order or entitlement detail and include its support reference when reporting a payment, refund, or access problem.",
      viewSettings: "View settings",
      viewOrders: "View orders",
      subscriptions: "Subscriptions",
      noSubscriptions: "No subscription products are enabled.",
      noSubscriptionsBody: "Every published Product currently grants permanent access at no charge. Paid access and subscriptions are not available.",
      productOrder: "Product order",
      orderDetails: "Order details",
      yourOrders: "Your orders",
      yourLibrary: "Your Agent library",
      yourEntitlements: "Your entitlements",
      ordersLabel: "Orders",
      created: "Created",
      validFrom: "Valid from",
      expires: "Expires",
      subtotal: "Subtotal",
      discount: "Discount",
      tax: "Tax",
      total: "Total",
      notCalculated: "Not calculated",
      returnToProduct: "Return to Product",
      viewReceipt: "View receipt",
      viewOrder: "View order",
      viewOrderStatus: "View order status",
      viewAccessDetails: "View access details",
      downloadDesktop: "Download Hatch Desktop",
      openDesktop: "Open Hatch Desktop",
      addToAccount: "Add to my account",
      addProductToAccount: "Add this Product to my account.",
      checkout: "Checkout",
      confirmOrder: "Confirm order",
      paymentNotRequired: "Not required",
      checkoutLegal: "The Product and release are resolved by the server.",
      addingToAccount: "Adding to your account…",
      accessRequestStale: "This access request is no longer current. Return to the Product and try again.",
      accessSetup: "Access setup",
      accessConfirmed: "Access confirmed",
      accessConfirmedBody: "Your access is already recorded. Hatch is finishing the receipt, so do not submit again.",
      retrySetup: "Retry setup",
      accessRemoved: "Access removed",
      accessInactive: "This access is no longer active.",
      receiptAvailable: "The receipt remains available for your records.",
      confirmingPayment: "Confirming payment",
      confirmingOrder: "We’re confirming your order…",
      doNotSubmitAgain: "Do not submit another order. This page reads the authoritative payment and access status and updates automatically.",
      paymentNotCompleted: "Payment not completed",
      paymentFailure: "Your account was not charged successfully.",
      noAccessGranted: "No access was granted. Return to the order to review the payment status and available recovery action.",
      purchaseCompleted: "Purchase completed; receipt temporarily unavailable.",
      purchaseCompletedBody: "Do not place another order. Hatch is retaining the confirmed purchase and will reload the receipt when the service recovers.",
      tryReceiptAgain: "Try receipt again",
      accessRecord: "Access record",
      accessStillPreparing: "Access is still being prepared.",
      accessUsed: "This access has been used.",
      accessExpired: "This access has expired.",
      desktopActivationUnavailable: "Desktop activation is unavailable.",
      pageNotAvailable: "This page is not available.",
      pageNotAvailableBody: "The link may be incomplete, or this public product may have been removed.",
      takingToSignIn: "Taking you to sign in…",
      continueToSignIn: "Continue to sign in",
      signOut: "Sign out",
      signingOut: "Signing out…",
      backToHatch: "Back to Hatch",
      learnAboutHatch: "Learn about Hatch",
      payment: "Payment",
      orderReference: "Order reference",
      delivery: "Delivery",
      release: "Release",
      placed: "Placed",
      receipt: "Receipt",
      manageAccess: "Manage access",
      permanentAccessPinned: "Permanent access",
      noOrders: "No orders yet",
      noOrdersBody: "Your confirmed Product orders will appear here.",
      noEntitlements: "No Agent access yet",
      noEntitlementsBody: "Products added to your account will appear here.",
      viewDetails: "View details",
      backExplore: "← Explore",
      publishedMethods: "Published methods for work in your own Workspace.",
      creatorAgentFallback: "Creator Agent",
      hatchCreatorFallback: "Hatch Creator",
      productDesktopRequirementFallback: "macOS app and a Hatch account. You select the Workspace before the Agent can work with local files.",
      productPromiseFallback: "A practical Creator method for work in your own Workspace.",
      yourPublishedStorefront: "This is your published storefront.",
      buyersSeePromise: "Buyers see the same Product promise and boundaries shown here.",
      manageProduct: "Manage product",
      accessSetupInProgress: "Access setup is in progress.",
      agentReady: "This Agent is ready.",
      returnDesktop: "Return to Hatch Desktop to continue safely.",
      openDesktopWorkspace: "Open Hatch Desktop with this account, then choose a Workspace.",
      settingUpAccess: "Setting up your access…",
      orderConfirmedBody: "Your order is confirmed. Access will appear as soon as fulfillment finishes.",
      settingUpAccessButton: "Setting up access",
      productUnavailableTitle: "This Product is unavailable.",
      creatorWithdrawn: "The Creator has withdrawn this Product. Existing receipts remain available.",
      getAccess: "Get access",
      viewInLibrary: "View in Library",
      downloadDesktopLink: "Download Desktop",
      confirmPermanentAccess: "Confirm permanent access for this Product.",
      signInDesktopWorkspace: "Sign in with the same account and choose a local Workspace.",
      workAsOften: "Use the method as often as you need in your own Workspace.",
      evidenceTitle: "Evidence, without exposing protected instructions.",
      freeAccess: "Free · Access granted",
      previewAccess: "Preview access",
      preview: "Preview",
      statusDelivered: "Delivered",
      statusRefunded: "Refunded",
      statusPaid: "Paid",
      statusPublished: "Published",
  statusReadyToPublish: "Ready to publish",
  statusPreparing: "Preparing",
  connectPayouts: "Connect payouts",
  continuePayoutSetup: "Continue setup",
  managePayouts: "Manage payouts"
    },
    download: {
      title: "Download Hatch Desktop · Hatch",
      home: "Hatch home",
      back: "Back to Hatch",
      preview: "Desktop preview",
      headline: "Hatch, on your desktop.",
      recommendedForDevice: "Recommended for your device",
      macDownloads: "Mac downloads",
      hatchForMac: "Hatch for Mac",
      chooseMac: "Choose the Mac build that matches your computer below.",
      readyForDevice: (label) => `${label} is ready for this device.`,
      appleSilicon: "Mac · Apple Silicon",
      intel: "Mac · Intel",
      macBuilds: "Mac builds",
      downloadDirectly: "Download directly",
      mac: "Mac",
      recommended: "Recommended",
      unavailable: "Downloads are temporarily unavailable.",
      unavailableBody: "Please try again shortly.",
      tryAgain: "Try again",
      windowsComingSoon: "Windows coming soon",
      macOnly: "Hatch Desktop is currently available for Mac.",
      comingSoon: "Coming soon",
      windows: "Windows",
      desktop: "Hatch Desktop",
      learn: "Learn about Hatch"
    },
    errors: {
      unexpected: "Something went wrong. Try again.",
      sessionExpired: "Your session expired. Sign in to continue.",
      accessDenied: "This account cannot view that resource.",
      notFound: "That resource is no longer available.",
      detailsChanged: "The latest details changed. Refresh and try again.",
      tooManyRequests: "Too many requests. Wait a moment, then try again.",
      unavailable: "Hatch is temporarily unavailable. Your current task has not been discarded.",
      releaseChanged: "The Product changed after this request began. Refresh and confirm the current release.",
      productNotFound: "Product was not found.",
      creatorNotFound: "Creator was not found.",
      checkoutNotFound: "Checkout session was not found.",
      orderNotFound: "Order was not found.",
      entitlementNotFound: "Access record was not found.",
      agentUnavailable: "The published Agent could not be found.",
      productUnavailable: "This Product is not available.",
      candidateIncomplete: "The candidate is not ready yet. Review the failed checks.",
      candidateChanged: "The candidate changed. Review it again before publishing.",
      candidateLoss: "Acknowledge every known non-critical loss before publishing.",
      invalidCheckout: "The checkout details are incomplete. Return to the Product and try again.",
      csrfRejected: "Refresh the page and try again.",
      unauthorized: "Sign in to continue.",
      forbidden: "You do not have access to this area.",
      routeNotFound: "That page is no longer available."
    }
  },
  zh: {
    common: {
      language: "语言", english: "English", chinese: "中文", japanese: "日本語", hatchHome: "Hatch 首页", pageSections: "页面分区", languageSwitcher: "语言切换", buyerNavigation: "用户导航", openNavigation: "打开导航", accountSettings: "账户设置", loading: "加载中", loadingDetails: "加载详情中", openingWorkspace: "正在打开工作区…", reload: "重新加载", tryAgain: "重试", retry: "重试", signIn: "登录", explore: "探索", library: "Library", orders: "订单", download: "下载", free: "免费", notRecorded: "未记录", notProvided: "未提供", noScheduledExpiry: "没有设定到期时间", product: "产品", order: "订单", access: "使用权", accessGranted: "已获得使用权", account: "账户", creator: "Creator", hatchCreatorHome: "Hatch Creator 首页", creatorNavigation: "Creator 导航", creatorAccessRequired: "需要 Creator 权限。", creatorAccessBody: "此账户可以使用已购买的 Agent，但不能编辑 Creator 产品。", createCreatorAccount: "创建 Creator 账户", openYourLibrary: "打开你的 Library", pageUnavailable: "Hatch 无法打开此页面。", pageUnavailableBody: "请重新加载。你的账户和产品数据没有被修改。", authResponseIncomplete: "认证响应不完整。"
    },
    app: { title: "Hatch Creator Agents" },
    onepager: { title: "Hatch — 为 Expert Creator 打造的 AI 产品", home: "Hatch 首页", sections: "页面分区", language: "语言切换", positioning: "产品定位", examples: "Creator 产品示例" },
      buyer: {
      productsTitle: "把方法真正用起来。", productsBody: "先了解产品承诺和边界。只有适合当前工作时，才把产品加入你的账户。", availableProducts: "可用产品", noProducts: "还没有公开产品", noProductsBody: "已发布的产品会出现在这里，请稍后再试。", creatorProducts: "Creator 产品", noPublicProducts: "还没有公开产品", noPublicProductsBody: "这个 Creator 还没有发布可浏览的产品。", exploreAllProducts: "探索全部产品", productAccess: "产品使用权", loadingProducts: "正在加载产品", loadingProduct: "正在加载产品", agentDetails: "Agent 详情", howItWorks: "使用方式", accessFromWork: "从获得使用权，到真正开始工作。", stepAddAgent: "添加 Agent", stepOpenDesktop: "打开 Hatch Desktop", stepWorkAgent: "与 Agent 一起工作", representativeExamples: "代表性示例", whatYouProvide: "你提供什么", whatYouReceive: "你会得到什么", boundaries: "边界", privacy: "隐私", workUnderControl: "你的工作始终由你掌控。", desktopRequirement: "Desktop 要求", permanentAccess: "永久使用权", unavailable: "不可用", available: "可用", verified: "已验证", inLibrary: "已在你的 Library 中", accountSettings: "账户设置", accountTitle: "你的 Hatch 账户。", accountBody: "Web 和 Desktop 使用同一个账户。退出登录不会影响你的使用权记录。", signedInAccount: "已登录账户", accountHelp: "账户帮助", accountHelpTitle: "回到正确的账户。", accountHelpBody: "订单和 Agent 使用权属于完成购买的账户。请在 Hatch Desktop 中使用同一个账户。", session: "会话", signedIn: "你已登录。", signInContinue: "请登录后继续。", sessionBody: "如果找不到收据或产品使用权，请确认 Web 和 Desktop 使用的是同一个账户。", purchaseSupport: "购买支持", supportReference: "保留支持编号。", supportBody: "报告支付、退款或使用权问题时，请打开订单或使用权详情，并附上支持编号。", viewSettings: "查看设置", viewOrders: "查看订单", subscriptions: "订阅", noSubscriptions: "没有启用订阅产品。", noSubscriptionsBody: "当前每个已发布产品都免费提供永久使用权。付费使用权和订阅暂不可用。", productOrder: "产品订单", orderDetails: "订单详情", yourOrders: "你的订单", yourLibrary: "你的 Agent Library", yourEntitlements: "你的使用权", ordersLabel: "订单", created: "创建时间", validFrom: "生效时间", expires: "到期时间", subtotal: "小计", discount: "折扣", tax: "税费", total: "总计", notCalculated: "未计算", returnToProduct: "返回产品", viewReceipt: "查看收据", viewOrder: "查看订单", viewOrderStatus: "查看订单状态", viewAccessDetails: "查看使用权详情", downloadDesktop: "下载 Hatch Desktop", openDesktop: "打开 Hatch Desktop", addToAccount: "加入我的账户", addProductToAccount: "将此产品加入我的账户。", checkout: "结账", confirmOrder: "确认订单", paymentNotRequired: "无需支付", checkoutLegal: "产品和版本由服务器确定。", addingToAccount: "正在加入你的账户…", accessRequestStale: "这个使用权请求已不是最新状态。请返回产品后重试。", accessSetup: "使用权设置", accessConfirmed: "使用权已确认", accessConfirmedBody: "你的使用权已经记录。Hatch 正在完成收据处理，请不要重复提交。", retrySetup: "重试设置", accessRemoved: "使用权已移除", accessInactive: "这个使用权已不再有效。", receiptAvailable: "收据仍会保留供你查看。", confirmingPayment: "正在确认支付", confirmingOrder: "正在确认你的订单…", doNotSubmitAgain: "请不要重复提交订单。本页面会读取权威的支付和使用权状态并自动更新。", paymentNotCompleted: "支付未完成", paymentFailure: "账户没有成功扣款。", noAccessGranted: "没有授予使用权。请返回订单查看支付状态和可用的恢复操作。", purchaseCompleted: "购买已完成，但收据暂时不可用。", purchaseCompletedBody: "请不要再次下单。Hatch 会保留已确认的购买，并在服务恢复后重新加载收据。", tryReceiptAgain: "重试收据", accessRecord: "使用权记录", accessStillPreparing: "使用权仍在准备中。", accessUsed: "这个使用权已经使用过。", accessExpired: "这个使用权已过期。", desktopActivationUnavailable: "Desktop 激活不可用。", pageNotAvailable: "此页面不可用。", pageNotAvailableBody: "链接可能不完整，或者公开产品已经被移除。", takingToSignIn: "正在前往登录…", continueToSignIn: "继续登录", signOut: "退出登录", signingOut: "正在退出…", backToHatch: "返回 Hatch", learnAboutHatch: "了解 Hatch", payment: "支付", orderReference: "订单编号", delivery: "交付", release: "版本", placed: "下单时间", receipt: "收据", manageAccess: "管理使用权", permanentAccessPinned: "永久使用权", noOrders: "还没有订单", noOrdersBody: "你确认过的产品订单会出现在这里。", noEntitlements: "还没有 Agent 使用权", noEntitlementsBody: "加入账户的产品会出现在这里。", freeAccess: "免费 · 已获得使用权"
    },
    download: {
      title: "下载 Hatch Desktop · Hatch", home: "Hatch 首页", back: "返回 Hatch", preview: "Desktop 预览", headline: "Hatch，来到你的桌面。", recommendedForDevice: "为你的设备推荐", macDownloads: "Mac 下载", hatchForMac: "Mac 版 Hatch", chooseMac: "请在下方选择与你的电脑匹配的 Mac 版本。", readyForDevice: (label) => `${label} 已适配这台设备。`, appleSilicon: "Mac · Apple Silicon", intel: "Mac · Intel", macBuilds: "Mac 版本", downloadDirectly: "直接下载", mac: "Mac", recommended: "推荐", unavailable: "下载暂时不可用。", unavailableBody: "请稍后重试。", tryAgain: "重试", windowsComingSoon: "Windows 即将推出", macOnly: "Hatch Desktop 目前支持 Mac。", comingSoon: "即将推出", windows: "Windows", desktop: "Hatch Desktop", learn: "了解 Hatch"
    },
    errors: {
      unexpected: "出了点问题，请重试。", sessionExpired: "登录已过期，请重新登录。", accessDenied: "此账户无法查看该资源。", notFound: "该资源已不可用。", detailsChanged: "最新详情已变化，请刷新后重试。", tooManyRequests: "请求过多，请稍等片刻后重试。", unavailable: "Hatch 暂时不可用，当前任务没有丢失。", releaseChanged: "请求开始后产品发生了变化，请刷新并确认当前版本。", productNotFound: "找不到产品。", creatorNotFound: "找不到 Creator。", checkoutNotFound: "找不到结账会话。", orderNotFound: "找不到订单。", entitlementNotFound: "找不到使用权记录。", agentUnavailable: "找不到已发布的 Agent。", productUnavailable: "该产品暂不可用。", candidateIncomplete: "候选版本还没有准备好，请检查失败的项目。", candidateChanged: "候选版本已变化，请重新审核后再发布。", candidateLoss: "请确认所有已知的非关键损失后再发布。", invalidCheckout: "结账信息不完整，请返回产品后重试。", csrfRejected: "请刷新页面后重试。", unauthorized: "请登录后继续。", forbidden: "你没有访问此区域的权限。", routeNotFound: "该页面已不可用。"
    }
  },
  ja: {
    common: {
      language: "言語", english: "English", chinese: "中文", japanese: "日本語", hatchHome: "Hatch ホーム", pageSections: "ページ内セクション", languageSwitcher: "言語切り替え", buyerNavigation: "購入者ナビゲーション", openNavigation: "ナビゲーションを開く", accountSettings: "アカウント設定", loading: "読み込み中", loadingDetails: "詳細を読み込み中", openingWorkspace: "ワークスペースを開いています…", reload: "再読み込み", tryAgain: "再試行", retry: "再試行", signIn: "サインイン", explore: "探索", library: "ライブラリ", orders: "注文", download: "ダウンロード", free: "無料", notRecorded: "記録なし", notProvided: "未提供", noScheduledExpiry: "有効期限なし", product: "プロダクト", order: "注文", access: "アクセス", accessGranted: "アクセス済み", account: "アカウント", creator: "Creator", hatchCreatorHome: "Hatch Creator ホーム", creatorNavigation: "Creator ナビゲーション", creatorAccessRequired: "Creator 権限が必要です。", creatorAccessBody: "このアカウントは購入済み Agent を使えますが、Creator プロダクトは編集できません。", createCreatorAccount: "Creator アカウントを作成", openYourLibrary: "ライブラリを開く", pageUnavailable: "Hatch はこのページを開けませんでした。", pageUnavailableBody: "再読み込みしてください。アカウントとプロダクトデータは変更されていません。", authResponseIncomplete: "認証レスポンスが不完全です。"
    },
    app: { title: "Hatch Creator Agents" },
    onepager: { title: "Hatch — Expert Creator のための AI プロダクト", home: "Hatch ホーム", sections: "ページ内セクション", language: "言語切り替え", positioning: "プロダクトの位置づけ", examples: "Creator プロダクトの例" },
    buyer: {
      productsTitle: "使える方法を手に入れる。", productsBody: "まず約束と境界を確認してください。仕事に合う場合だけプロダクトをアカウントに追加します。", availableProducts: "利用可能なプロダクト", noProducts: "公開中のプロダクトはまだありません", noProductsBody: "公開されたプロダクトがここに表示されます。しばらくしてから再試行してください。", creatorProducts: "Creator プロダクト", noPublicProducts: "公開中のプロダクトはありません", noPublicProductsBody: "この Creator はまだ閲覧可能なプロダクトを公開していません。", exploreAllProducts: "すべてのプロダクトを見る", productAccess: "プロダクトへのアクセス", loadingProducts: "プロダクトを読み込み中", loadingProduct: "プロダクトを読み込み中", agentDetails: "Agent の詳細", howItWorks: "使い方", accessFromWork: "アクセスから、実際の仕事へ。", stepAddAgent: "Agent を追加", stepOpenDesktop: "Hatch Desktop を開く", stepWorkAgent: "Agent と作業する", representativeExamples: "代表的な例", whatYouProvide: "提供するもの", whatYouReceive: "受け取るもの", boundaries: "境界", privacy: "プライバシー", workUnderControl: "あなたの仕事はあなたの管理下にあります。", desktopRequirement: "Desktop の要件", permanentAccess: "永久アクセス", unavailable: "利用不可", available: "利用可能", verified: "確認済み", inLibrary: "ライブラリに追加済み", accountSettings: "アカウント設定", accountTitle: "Hatch アカウント。", accountBody: "Web と Desktop では同じアカウントを使います。サインアウトしてもアクセス記録は保持されます。", signedInAccount: "サインイン中のアカウント", accountHelp: "アカウントヘルプ", accountHelpTitle: "正しいアカウントに戻る。", accountHelpBody: "注文と Agent のアクセスは、購入を確定したアカウントに属します。Hatch Desktop でも同じアカウントを使ってください。", session: "セッション", signedIn: "サインインしています。", signInContinue: "続行するにはサインインしてください。", sessionBody: "レシートやプロダクトへのアクセスが見つからない場合は、Web と Desktop が同じアカウントを使っているか確認してください。", purchaseSupport: "購入サポート", supportReference: "サポート参照番号を保管してください。", supportBody: "支払いや返金、アクセスの問題を報告するときは、注文またはアクセスの詳細を開き、サポート参照番号を添えてください。", viewSettings: "設定を見る", viewOrders: "注文を見る", subscriptions: "サブスクリプション", noSubscriptions: "サブスクリプション商品は有効になっていません。", noSubscriptionsBody: "現在、公開済みのすべてのプロダクトは無料で永久アクセスを付与します。有料アクセスとサブスクリプションは利用できません。", productOrder: "プロダクト注文", orderDetails: "注文の詳細", yourOrders: "あなたの注文", yourLibrary: "あなたの Agent ライブラリ", yourEntitlements: "あなたのアクセス", ordersLabel: "注文", created: "作成日時", validFrom: "有効開始", expires: "有効期限", subtotal: "小計", discount: "割引", tax: "税", total: "合計", notCalculated: "未計算", returnToProduct: "プロダクトに戻る", viewReceipt: "レシートを見る", viewOrder: "注文を見る", viewOrderStatus: "注文状況を見る", viewAccessDetails: "アクセスの詳細を見る", downloadDesktop: "Hatch Desktop をダウンロード", openDesktop: "Hatch Desktop を開く", addToAccount: "アカウントに追加", addProductToAccount: "このプロダクトをアカウントに追加する。", checkout: "チェックアウト", confirmOrder: "注文を確認", paymentNotRequired: "支払い不要", checkoutLegal: "プロダクトとリリースはサーバーで確定されます。", addingToAccount: "アカウントに追加中…", accessRequestStale: "このアクセスリクエストは最新ではありません。プロダクトに戻って再試行してください。", accessSetup: "アクセス設定", accessConfirmed: "アクセスが確認されました", accessConfirmedBody: "アクセスはすでに記録されています。Hatch がレシートを完了中なので、再送信しないでください。", retrySetup: "設定を再試行", accessRemoved: "アクセスを削除しました", accessInactive: "このアクセスは有効ではありません。", receiptAvailable: "レシートは記録として引き続き利用できます。", confirmingPayment: "支払いを確認中", confirmingOrder: "注文を確認しています…", doNotSubmitAgain: "注文を再送信しないでください。このページは正式な支払いとアクセスの状態を読み取り、自動的に更新します。", paymentNotCompleted: "支払いが完了していません", paymentFailure: "アカウントへの請求を完了できませんでした。", noAccessGranted: "アクセスは付与されていません。注文に戻り、支払い状況と復旧方法を確認してください。", purchaseCompleted: "購入は完了しましたが、レシートは一時的に利用できません。", purchaseCompletedBody: "注文を再度行わないでください。Hatch は確定済みの購入を保持し、サービス復旧後にレシートを再読み込みします。", tryReceiptAgain: "レシートを再試行", accessRecord: "アクセス記録", accessStillPreparing: "アクセスを準備中です。", accessUsed: "このアクセスは使用済みです。", accessExpired: "このアクセスは期限切れです。", desktopActivationUnavailable: "Desktop の有効化を利用できません。", pageNotAvailable: "このページは利用できません。", pageNotAvailableBody: "リンクが不完全か、公開プロダクトが削除された可能性があります。", takingToSignIn: "サインインへ移動中…", continueToSignIn: "サインインを続ける", signOut: "サインアウト", signingOut: "サインアウト中…", backToHatch: "Hatch に戻る", learnAboutHatch: "Hatch について", payment: "支払い", orderReference: "注文番号", delivery: "配送", release: "リリース", placed: "注文日時", receipt: "レシート", manageAccess: "アクセスを管理", permanentAccessPinned: "永久アクセス", noOrders: "注文はまだありません", noOrdersBody: "確定したプロダクト注文がここに表示されます。", noEntitlements: "Agent へのアクセスはまだありません", noEntitlementsBody: "アカウントに追加したプロダクトがここに表示されます。", freeAccess: "無料 · アクセス済み"
    },
    download: {
      title: "Hatch Desktop をダウンロード · Hatch", home: "Hatch ホーム", back: "Hatch に戻る", preview: "Desktop プレビュー", headline: "Hatch をデスクトップで。", recommendedForDevice: "お使いのデバイスにおすすめ", macDownloads: "Mac ダウンロード", hatchForMac: "Mac 版 Hatch", chooseMac: "お使いのコンピューターに合う Mac ビルドを下から選択してください。", readyForDevice: (label) => `${label} はこのデバイスで利用できます。`, appleSilicon: "Mac · Apple Silicon", intel: "Mac · Intel", macBuilds: "Mac ビルド", downloadDirectly: "直接ダウンロード", mac: "Mac", recommended: "おすすめ", unavailable: "ダウンロードは一時的に利用できません。", unavailableBody: "しばらくしてから再試行してください。", tryAgain: "再試行", windowsComingSoon: "Windows は近日公開", macOnly: "Hatch Desktop は現在 Mac で利用できます。", comingSoon: "近日公開", windows: "Windows", desktop: "Hatch Desktop", learn: "Hatch について"
    },
    errors: {
      unexpected: "問題が発生しました。再試行してください。", sessionExpired: "セッションの有効期限が切れました。サインインしてください。", accessDenied: "このアカウントはそのリソースを表示できません。", notFound: "そのリソースは利用できなくなりました。", detailsChanged: "最新の詳細が変更されました。更新して再試行してください。", tooManyRequests: "リクエストが多すぎます。少し待ってから再試行してください。", unavailable: "Hatch は一時的に利用できません。現在の作業は破棄されていません。", releaseChanged: "リクエスト開始後にプロダクトが変更されました。更新して現在のリリースを確認してください。", productNotFound: "プロダクトが見つかりません。", creatorNotFound: "Creator が見つかりません。", checkoutNotFound: "チェックアウトセッションが見つかりません。", orderNotFound: "注文が見つかりません。", entitlementNotFound: "アクセス記録が見つかりません。", agentUnavailable: "公開済み Agent が見つかりません。", productUnavailable: "このプロダクトは利用できません。", candidateIncomplete: "候補はまだ準備できていません。失敗した確認項目を見直してください。", candidateChanged: "候補が変更されました。公開前にもう一度レビューしてください。", candidateLoss: "公開前に既知の非クリティカルな損失をすべて確認してください。", invalidCheckout: "チェックアウト情報が不完全です。プロダクトに戻って再試行してください。", csrfRejected: "ページを更新して再試行してください。", unauthorized: "続行するにはサインインしてください。", forbidden: "このエリアへのアクセス権がありません。", routeNotFound: "そのページは利用できなくなりました。"
    }
  }
};

Object.assign(MESSAGES.zh.buyer, {
  viewDetails: "查看详情", backExplore: "← 探索", publishedMethods: "为你自己的 Workspace 工作的已发布方法。", creatorAgentFallback: "Creator Agent", hatchCreatorFallback: "Hatch Creator", productDesktopRequirementFallback: "macOS 应用和 Hatch 账户。选择 Workspace 后，Agent 才能使用本地文件。", productPromiseFallback: "一个可以在你自己的 Workspace 中使用的 Creator 方法。", yourPublishedStorefront: "这是你已发布的 storefront。", buyersSeePromise: "用户看到的产品承诺和边界与这里相同。", manageProduct: "管理产品", accessSetupInProgress: "使用权正在设置中。", agentReady: "这个 Agent 已经准备好。", returnDesktop: "返回 Hatch Desktop 以安全继续。", openDesktopWorkspace: "用这个账户打开 Hatch Desktop，然后选择一个 Workspace。", settingUpAccess: "正在设置你的使用权…", orderConfirmedBody: "订单已确认。履约完成后，使用权会出现。", settingUpAccessButton: "正在设置使用权", productUnavailableTitle: "这个产品暂不可用。", creatorWithdrawn: "Creator 已撤回这个产品，已有收据仍然可用。", getAccess: "获得使用权", viewInLibrary: "在 Library 中查看", downloadDesktopLink: "下载 Desktop", confirmPermanentAccess: "确认这个产品的永久使用权。", signInDesktopWorkspace: "用同一个账户登录并选择本地 Workspace。", workAsOften: "在你自己的 Workspace 中按需要使用这个方法。", evidenceTitle: "展示证据，但不暴露受保护的指令。",
  previewAccess: "预览使用权",
  preview: "预览",
  statusDelivered: "已交付",
  statusRefunded: "已退款",
  statusPaid: "已支付",
  statusPublished: "已发布",
  statusReadyToPublish: "可以发布",
  statusPreparing: "准备中",
  connectPayouts: "连接收款",
  continuePayoutSetup: "继续设置",
  managePayouts: "管理收款"
});
Object.assign(MESSAGES.ja.buyer, {
  viewDetails: "詳細を見る", backExplore: "← 探索", publishedMethods: "自分の Workspace で使える公開済みの方法。", creatorAgentFallback: "Creator Agent", hatchCreatorFallback: "Hatch Creator", productDesktopRequirementFallback: "macOS アプリと Hatch アカウントが必要です。Workspace を選ぶと Agent がローカルファイルを扱えます。", productPromiseFallback: "自分の Workspace で使える Creator の実践的な方法。", yourPublishedStorefront: "これは公開済みのストアフロントです。", buyersSeePromise: "購入者にはここで示したものと同じ約束と境界が表示されます。", manageProduct: "プロダクトを管理", accessSetupInProgress: "アクセスを設定中です。", agentReady: "この Agent は準備できています。", returnDesktop: "安全に続けるには Hatch Desktop に戻ってください。", openDesktopWorkspace: "このアカウントで Hatch Desktop を開き、Workspace を選択してください。", settingUpAccess: "アクセスを設定中…", orderConfirmedBody: "注文は確認されました。履行が完了するとアクセスが表示されます。", settingUpAccessButton: "アクセスを設定中", productUnavailableTitle: "このプロダクトは利用できません。", creatorWithdrawn: "Creator がこのプロダクトを取り下げました。既存のレシートは引き続き利用できます。", getAccess: "アクセスする", viewInLibrary: "ライブラリで見る", downloadDesktopLink: "Desktop をダウンロード", confirmPermanentAccess: "このプロダクトへの永久アクセスを確認します。", signInDesktopWorkspace: "同じアカウントでサインインし、ローカル Workspace を選択してください。", workAsOften: "自分の Workspace で必要なだけこの方法を使えます。", evidenceTitle: "保護された指示を公開せずに、根拠を示します。",
  previewAccess: "プレビューアクセス",
  preview: "プレビュー",
  statusDelivered: "配達済み",
  statusRefunded: "返金済み",
  statusPaid: "支払い済み",
  statusPublished: "公開済み",
  statusReadyToPublish: "公開可能",
  statusPreparing: "準備中",
  connectPayouts: "支払いを接続",
  continuePayoutSetup: "設定を続ける",
  managePayouts: "支払いを管理"
});

Object.assign(MESSAGES.en.buyer, {
  inProgress: "In progress",
  settingUpStatus: "Setting up",
  used: "Used",
  expired: "Expired",
  paused: "Paused",
  accessEnded: "Access ended",
  noAccess: "No access",
  accountEyebrow: "Account",
  signedInAccountLabel: "Signed-in account",
  hatchAccountFallback: "Hatch account",
  signedInToHatch: "Signed in to Hatch",
  continueTask: "Continue your task",
  methodMadeUseful: "Your method, made useful.",
  methodMadeUsefulBody: "Turn the way you think into an agent people can use.",
  creatorAccount: "Creator account",
  hatchAccount: "Hatch account",
  creatorSignupEyebrow: "Create your Creator account",
  accountSignupEyebrow: "Create your Hatch account",
  createYourAccount: "Create your account",
  signInToHatch: "Sign in to Hatch",
  creatorSignupBody: "Create a Creator account, then open Creator Studio to publish your work.",
  accountSignupBody: "Create an account, then return to the Product you selected.",
  creatorSigninBody: "Sign in with your Creator account to open Creator Studio.",
  signinBody: "Sign in, then continue exactly where you left off.",
  name: "Name",
  email: "Email",
  password: "Password",
  terms: "I agree to the Hatch Terms and Privacy Policy.",
  createCreator: "Create Creator account",
  createAccount: "Create account",
  alreadyAccount: "Already have an account?",
  newToCreator: "New to Creator Studio?",
  newToHatch: "New to Hatch?",
  currentApprovedRelease: "Current approved release",
  confirmProduct: "Confirm this Product.",
  accessPinnedRelease: "Your access is pinned to the Product release shown here.",
  receiptSyncing: "Receipt syncing",
  purchaseDetailsUnavailable: "Purchase completed; some access details are temporarily unavailable.",
  yourAgentReady: "Your Agent is ready",
  confirmingYourOrder: "Confirming your order",
  paymentNotCompleted: "Payment not completed",
  yourAccountNotCharged: "Your account was not charged successfully.",
  noAccessGrantedBody: "No access was granted. Return to the order to review the payment status and available recovery action.",
  whatHappensNext: "What happens next",
  signInDesktop: "Sign in to Desktop with this account.",
  chooseAgentWorkspace: "Choose this Agent and a Workspace.",
  reviewPermissions: "Review local permissions before changes.",
  viewOrderReceipt: "View order receipt →",
  viewAccessDetailsArrow: "View access details →",
  yourLibraryEyebrow: "Your library",
  agentsLinked: "Agents linked to your account.",
  libraryBody: "Access and release policy stay visible here. Zero-price purchases do not expire or run out.",
  loadingLibrary: "Loading your library",
  libraryEmpty: "Your library is empty",
  libraryEmptyBody: "Explore products and choose a method that fits your task.",
  viewAccess: "View access",
  backLibrary: "← Back to Library",
  accessDetails: "Access details",
  yourEntitlement: "Your entitlement",
  status: "Status",
  pinnedPurchaseRelease: "Pinned purchase release",
  purchasedVersion: "Purchased version",
  effectiveVersion: "Effective version",
  versionPolicy: "Version policy",
  refundCancellation: "Refund / cancellation",
  accessRevoked: "Access revoked",
  supportReferenceLabel: "Support reference",
  originatingOrder: "View originating order →",
  desktopActivation: "Desktop activation",
  continueWorkspace: "Continue in your Workspace.",
  accessHistory: "Access history",
  activityPrivate: "Activity, without your private content.",
  activityBody: "Your purchase and access status stay visible on Web. Workspace paths, source files and conversations stay private.",
  permanentAccessReady: "Open Hatch Desktop when you are ready to use this access.",
  orderHistory: "Order history",
  completeReceipts: "Your complete receipts.",
  receiptsBody: "Amounts, payment, access and refund remain separate and traceable.",
  orderStatus: "Order status",
  allOrders: "All orders",
  fulfilled: "Fulfilled",
  pending: "Pending",
  refunded: "Refunded",
  loadingOrders: "Loading orders",
  noOrdersView: "No orders in this view",
  noOrdersViewBody: "Orders appear after you add a Product.",
  viewOrderLink: "View order",
  backOrders: "← Back to Orders",
  orderActions: "Order actions",
  openActivationSteps: "Open activation steps",
  cancelPurchase: "Cancel this purchase",
  requestRefund: "Request refund",
  purchaseCancelled: "Purchase cancelled.",
  refundRequested: "Refund request received.",
  receiptLabel: "Receipt",
  creatorLabel: "Creator",
  paymentLabel: "Payment",
  accessLabel: "Access",
  releaseLabel: "Release",
  purchaseTimeRelease: "Purchase-time release",
  whatHappened: "What happened, in order.",
  loadMore: "Load more",
  pageNotFound: "Page not found",
  signInSafeBody: "Your task is safe. After signing in, you’ll return to this page.",
  returnAvailableBody: "Return to a page available to this account.",
  previousReceiptBody: "A previous receipt may still be available from your Orders.",
  refreshDetails: "Refresh details",
  taskStillHere: "Your task is still here.",
  paymentStatus: "Payment status",
  paymentPending: "Payment pending",
  paymentSucceeded: "Payment succeeded",
  actionRequired: "Action required",
  succeeded: "Succeeded",
  cancelled: "Cancelled",
  failed: "Failed",
  activity: (value) => `Activity ${value}`,
  artifactType: (value) => `Artifact type: ${value}`,
  accessUsesAvailable: (count) => `${count} access ${count === 1 ? "use" : "uses"} available`,
  permanentAccessSummary: "Permanent access. Open Hatch Desktop with this account and choose a Workspace.",
  accessUnavailable: "Access is unavailable. Review the recovery details.",
  returnPublicProduct: "Return to the public Product to review available access.",
  keepReceipt: "Keep this page and order receipt; fulfillment will update without another checkout.",
  reviewOriginatingOrder: "Review the originating order for a reason and available support action.",
  productDetail: "Product detail",
  accountHelpLink: "Account help",
  exploreProducts: "Explore products",
  viewConfirmedOrder: "View confirmed order",
  returnProduct: "Return to Product"
});

Object.assign(MESSAGES.zh.buyer, {
  inProgress: "进行中", settingUpStatus: "设置中", used: "已使用", expired: "已过期", paused: "已暂停", accessEnded: "使用权已结束", noAccess: "没有使用权",
  accountEyebrow: "账户", signedInAccountLabel: "已登录账户", hatchAccountFallback: "Hatch 账户", signedInToHatch: "已登录 Hatch", continueTask: "继续你的工作", methodMadeUseful: "让你的方法真正有用。", methodMadeUsefulBody: "把你的思考方式变成别人可以使用的 Agent。", creatorAccount: "Creator 账户", hatchAccount: "Hatch 账户", creatorSignupEyebrow: "创建你的 Creator 账户", accountSignupEyebrow: "创建你的 Hatch 账户", createYourAccount: "创建你的账户", signInToHatch: "登录 Hatch", creatorSignupBody: "创建 Creator 账户，然后打开 Creator Studio 发布你的工作。", accountSignupBody: "创建账户，然后返回你选择的产品。", creatorSigninBody: "使用 Creator 账户登录，打开 Creator Studio。", signinBody: "登录后继续你刚才的操作。", name: "姓名", email: "邮箱", password: "密码", terms: "我同意 Hatch 的服务条款和隐私政策。", createCreator: "创建 Creator 账户", createAccount: "创建账户", alreadyAccount: "已经有账户？", newToCreator: "刚开始使用 Creator Studio？", newToHatch: "刚开始使用 Hatch？", currentApprovedRelease: "当前已批准版本", confirmProduct: "确认这个产品。", accessPinnedRelease: "你的使用权固定到这里显示的产品版本。", receiptSyncing: "收据同步中", purchaseDetailsUnavailable: "购买已完成，但部分使用权详情暂时不可用。", yourAgentReady: "你的 Agent 已准备好", confirmingYourOrder: "正在确认你的订单", paymentNotCompleted: "支付未完成", yourAccountNotCharged: "账户没有成功扣款。", noAccessGrantedBody: "没有授予使用权。请返回订单查看支付状态和可用的恢复操作。", whatHappensNext: "接下来会发生什么", signInDesktop: "用这个账户登录 Desktop。", chooseAgentWorkspace: "选择这个 Agent 和一个 Workspace。", reviewPermissions: "在发生变化前检查本地权限。", viewOrderReceipt: "查看订单收据 →", viewAccessDetailsArrow: "查看使用权详情 →", yourLibraryEyebrow: "你的 Library", agentsLinked: "与你账户关联的 Agent。", libraryBody: "使用权和版本策略会显示在这里。零价格购买不会过期或耗尽。", loadingLibrary: "正在加载你的 Library", libraryEmpty: "你的 Library 还是空的", libraryEmptyBody: "探索产品，选择适合你任务的方法。", viewAccess: "查看使用权", backLibrary: "← 返回 Library", accessDetails: "使用权详情", yourEntitlement: "你的使用权", status: "状态", pinnedPurchaseRelease: "购买时固定的版本", purchasedVersion: "购买版本", effectiveVersion: "生效版本", versionPolicy: "版本策略", refundCancellation: "退款 / 取消", accessRevoked: "使用权已撤销", supportReferenceLabel: "支持编号", originatingOrder: "查看原始订单 →", desktopActivation: "Desktop 激活", continueWorkspace: "在你的 Workspace 中继续。", accessHistory: "使用权历史", activityPrivate: "活动记录，不包含你的私密内容。", activityBody: "你的购买和使用权状态会显示在 Web 上。Workspace 路径、源文件和对话保持私密。", permanentAccessReady: "准备使用时打开 Hatch Desktop。", orderHistory: "订单历史", completeReceipts: "你的完整收据。", receiptsBody: "金额、支付、使用权和退款保持独立且可追踪。", orderStatus: "订单状态", allOrders: "全部订单", fulfilled: "已履约", pending: "处理中", refunded: "已退款", loadingOrders: "正在加载订单", noOrdersView: "此视图中没有订单", noOrdersViewBody: "加入产品后，订单会出现在这里。", viewOrderLink: "查看订单", backOrders: "← 返回订单", orderActions: "订单操作", openActivationSteps: "打开激活步骤", cancelPurchase: "取消购买", requestRefund: "申请退款", purchaseCancelled: "购买已取消。", refundRequested: "已收到退款申请。", receiptLabel: "收据", creatorLabel: "Creator", paymentLabel: "支付", accessLabel: "使用权", releaseLabel: "版本", purchaseTimeRelease: "购买时的版本", whatHappened: "按顺序查看发生了什么。", loadMore: "加载更多", pageNotFound: "页面不存在", signInSafeBody: "你的任务是安全的。登录后会回到此页面。", returnAvailableBody: "返回此账户可以访问的页面。", previousReceiptBody: "之前的收据可能仍可在订单中找到。", refreshDetails: "刷新详情", taskStillHere: "你的任务还在这里。", paymentStatus: "支付状态", paymentPending: "支付处理中", paymentSucceeded: "支付成功", actionRequired: "需要操作", succeeded: "成功", cancelled: "已取消", failed: "失败", activity: (value) => `活动 ${value}`, artifactType: (value) => `产物类型：${value}`, accessUsesAvailable: (count) => `${count} 次使用权可用`, permanentAccessSummary: "永久使用权。用这个账户打开 Hatch Desktop 并选择 Workspace。", accessUnavailable: "使用权不可用，请查看恢复详情。", returnPublicProduct: "返回公开产品查看可用使用权。", keepReceipt: "保留此页面和订单收据；履约会在不重复结账的情况下更新。", reviewOriginatingOrder: "查看原始订单，了解原因和可用的支持操作。", productDetail: "产品详情", accountHelpLink: "账户帮助", exploreProducts: "探索产品", viewConfirmedOrder: "查看已确认订单", returnProduct: "返回产品"
});

Object.assign(MESSAGES.ja.buyer, {
  inProgress: "進行中", settingUpStatus: "設定中", used: "使用済み", expired: "期限切れ", paused: "一時停止", accessEnded: "アクセス終了", noAccess: "アクセスなし",
  accountEyebrow: "アカウント", signedInAccountLabel: "サインイン中のアカウント", hatchAccountFallback: "Hatch アカウント", signedInToHatch: "Hatch にサインイン中", continueTask: "作業を続ける", methodMadeUseful: "あなたの方法を使える形に。", methodMadeUsefulBody: "考え方を、他の人が使える Agent に変えます。", creatorAccount: "Creator アカウント", hatchAccount: "Hatch アカウント", creatorSignupEyebrow: "Creator アカウントを作成", accountSignupEyebrow: "Hatch アカウントを作成", createYourAccount: "アカウントを作成", signInToHatch: "Hatch にサインイン", creatorSignupBody: "Creator アカウントを作成し、Creator Studio を開いて公開します。", accountSignupBody: "アカウントを作成し、選択したプロダクトに戻ります。", creatorSigninBody: "Creator アカウントでサインインして Creator Studio を開きます。", signinBody: "サインインして、直前の場所から続けます。", name: "名前", email: "メールアドレス", password: "パスワード", terms: "Hatch の利用規約とプライバシーポリシーに同意します。", createCreator: "Creator アカウントを作成", createAccount: "アカウントを作成", alreadyAccount: "すでにアカウントをお持ちですか？", newToCreator: "Creator Studio は初めてですか？", newToHatch: "Hatch は初めてですか？", currentApprovedRelease: "現在承認済みのリリース", confirmProduct: "このプロダクトを確認します。", accessPinnedRelease: "アクセスはここに表示されたプロダクトのリリースに固定されます。", receiptSyncing: "レシートを同期中", purchaseDetailsUnavailable: "購入は完了しましたが、一部のアクセス詳細を一時的に利用できません。", yourAgentReady: "Agent の準備ができました", confirmingYourOrder: "注文を確認中", paymentNotCompleted: "支払いが完了していません", yourAccountNotCharged: "アカウントへの請求を完了できませんでした。", noAccessGrantedBody: "アクセスは付与されていません。注文に戻り、支払い状況と復旧方法を確認してください。", whatHappensNext: "次に行うこと", signInDesktop: "このアカウントで Desktop にサインインします。", chooseAgentWorkspace: "この Agent と Workspace を選択します。", reviewPermissions: "変更前にローカル権限を確認します。", viewOrderReceipt: "注文レシートを見る →", viewAccessDetailsArrow: "アクセスの詳細を見る →", yourLibraryEyebrow: "あなたのライブラリ", agentsLinked: "アカウントに紐づいた Agent。", libraryBody: "アクセスとリリースのポリシーをここで確認できます。無料購入は期限切れになりません。", loadingLibrary: "ライブラリを読み込み中", libraryEmpty: "ライブラリは空です", libraryEmptyBody: "プロダクトを探索して、仕事に合う方法を選んでください。", viewAccess: "アクセスを見る", backLibrary: "← ライブラリに戻る", accessDetails: "アクセスの詳細", yourEntitlement: "あなたのアクセス", status: "ステータス", pinnedPurchaseRelease: "購入時のリリースに固定", purchasedVersion: "購入したバージョン", effectiveVersion: "有効なバージョン", versionPolicy: "バージョンポリシー", refundCancellation: "返金 / キャンセル", accessRevoked: "アクセスを取り消し", supportReferenceLabel: "サポート参照番号", originatingOrder: "元の注文を見る →", desktopActivation: "Desktop の有効化", continueWorkspace: "Workspace で続ける。", accessHistory: "アクセス履歴", activityPrivate: "プライベートな内容を含まないアクティビティ。", activityBody: "購入とアクセスの状態は Web に表示されます。Workspace のパス、ソースファイル、会話は非公開です。", permanentAccessReady: "このアクセスを使う準備ができたら Hatch Desktop を開きます。", orderHistory: "注文履歴", completeReceipts: "すべてのレシート。", receiptsBody: "金額、支払い、アクセス、返金を分けて追跡できます。", orderStatus: "注文ステータス", allOrders: "すべての注文", fulfilled: "履行済み", pending: "保留中", refunded: "返金済み", loadingOrders: "注文を読み込み中", noOrdersView: "この表示に注文はありません", noOrdersViewBody: "プロダクトを追加すると注文が表示されます。", viewOrderLink: "注文を見る", backOrders: "← 注文に戻る", orderActions: "注文の操作", openActivationSteps: "有効化の手順を開く", cancelPurchase: "購入をキャンセル", requestRefund: "返金を申請", purchaseCancelled: "購入をキャンセルしました。", refundRequested: "返金申請を受け付けました。", receiptLabel: "レシート", creatorLabel: "Creator", paymentLabel: "支払い", accessLabel: "アクセス", releaseLabel: "リリース", purchaseTimeRelease: "購入時のリリース", whatHappened: "何が起きたかを順に確認します。", loadMore: "さらに読み込む", pageNotFound: "ページが見つかりません", signInSafeBody: "作業は安全です。サインイン後にこのページへ戻ります。", returnAvailableBody: "このアカウントが利用できるページへ戻ります。", previousReceiptBody: "以前のレシートは注文から確認できる場合があります。", refreshDetails: "詳細を更新", taskStillHere: "作業はここに残っています。", paymentStatus: "支払い状況", paymentPending: "支払い保留中", paymentSucceeded: "支払い成功", actionRequired: "操作が必要", succeeded: "成功", cancelled: "キャンセル済み", failed: "失敗", activity: (value) => `アクティビティ ${value}`, artifactType: (value) => `成果物タイプ：${value}`, accessUsesAvailable: (count) => `${count} 回分のアクセスが利用可能`, permanentAccessSummary: "永久アクセス。このアカウントで Hatch Desktop を開き、Workspace を選択してください。", accessUnavailable: "アクセスを利用できません。復旧の詳細を確認してください。", returnPublicProduct: "公開プロダクトに戻り、利用可能なアクセスを確認してください。", keepReceipt: "このページと注文レシートを保持してください。再チェックアウトなしで履行状況が更新されます。", reviewOriginatingOrder: "元の注文で理由と利用可能なサポート操作を確認してください。", productDetail: "プロダクトの詳細", accountHelpLink: "アカウントヘルプ", exploreProducts: "プロダクトを探索", viewConfirmedOrder: "確認済みの注文を見る", returnProduct: "プロダクトに戻る"
});

Object.assign(MESSAGES.zh.buyer, { openingAccount: "正在打开你的账户" });
Object.assign(MESSAGES.ja.buyer, { openingAccount: "アカウントを開いています" });

let activeLocale = "";

export function matchWebLocale(value) {
  const language = String(value ?? "").split(";", 1)[0].trim().toLowerCase();
  if (language === "zh" || language.startsWith("zh-")) return "zh";
  if (language === "ja" || language.startsWith("ja-")) return "ja";
  if (language === "en" || language.startsWith("en-")) return "en";
  return "";
}

export function normalizeWebLocale(value) {
  return matchWebLocale(value) || "en";
}

export function detectWebLocale(languages) {
  const candidates = Array.isArray(languages) && languages.length
    ? languages
    : typeof navigator !== "undefined"
      ? [navigator.language, ...(Array.isArray(navigator.languages) ? navigator.languages : [])]
      : [];
  for (const language of candidates) {
    const matched = matchWebLocale(language);
    if (matched) return matched;
  }
  return "en";
}

export function readStoredWebLocale() {
  if (typeof window === "undefined") return "";
  try {
    const stored = window.localStorage.getItem(WEB_LOCALE_STORAGE_KEY);
    return stored ? normalizeWebLocale(stored) : "";
  } catch { return ""; }
}

export function getWebLocale() {
  return activeLocale || readStoredWebLocale() || detectWebLocale();
}

export function resolveWebLocale() {
  return readStoredWebLocale() || detectWebLocale();
}

export function setWebLocale(value) {
  const locale = normalizeWebLocale(value);
  activeLocale = locale;
  if (typeof window !== "undefined") {
    try { window.localStorage.setItem(WEB_LOCALE_STORAGE_KEY, locale); } catch { /* storage may be unavailable */ }
  }
  return locale;
}

export function localeTag(locale = getWebLocale()) {
  return WEB_LOCALE_TAGS[normalizeWebLocale(locale)] ?? WEB_LOCALE_TAGS.en;
}

export function localeLabel(locale) {
  return LOCALE_LABELS[normalizeWebLocale(locale)] ?? LOCALE_LABELS.en;
}

export function setDocumentLocale(locale) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = localeTag(locale);
  document.documentElement.dir = "ltr";
}

function resolveMessage(messages, key) {
  return String(key).split(".").reduce((value, part) => value?.[part], messages);
}

export function translateWeb(locale, key, ...args) {
  const requested = MESSAGES[normalizeWebLocale(locale)] ?? MESSAGES.en;
  const value = resolveMessage(requested, key) ?? resolveMessage(MESSAGES.en, key) ?? key;
  return typeof value === "function" ? value(...args) : value;
}

export function localizeWebIdentifier(value, locale = getWebLocale()) {
  const text = String(value ?? "").trim();
  if (!text) return translateWeb(locale, "common.notProvided");
  const key = WEB_IDENTIFIER_KEYS[text.toLowerCase()];
  if (key) return translateWeb(locale, key);
  return text.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function localizeWebApiError(body, locale = getWebLocale()) {
  const error = body?.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return body;
  const key = WEB_API_ERROR_KEYS[error.code];
  if (!key) return body;
  return {
    ...body,
    error: {
      ...error,
      message: translateWeb(locale, key)
    }
  };
}

export function webT(key, ...args) {
  return translateWeb(getWebLocale(), key, ...args);
}

export function formatUsd(minor) {
  const amount = Number(minor);
  if (!Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount / 100);
}

export function formatWebDate(value, locale = getWebLocale(), dateOnly = false) {
  if (!value) return translateWeb(locale, "common.notRecorded");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(localeTag(locale), dateOnly
    ? { dateStyle: "medium" }
    : { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function webErrorMessage(error, locale = getWebLocale()) {
  const t = (key, ...args) => translateWeb(locale, key, ...args);
  if (!error) return t("errors.unexpected");
  if (error.code === "release_changed" || error.code === "candidate_report_changed") return t("errors.releaseChanged");
  if (WEB_API_ERROR_KEYS[error.code]) return t(WEB_API_ERROR_KEYS[error.code]);
  if (error.status === 401 || error.code === "unauthorized") return t("errors.sessionExpired");
  if (error.status === 403 || error.code === "forbidden") return t("errors.accessDenied");
  if (error.status === 404) return t("errors.notFound");
  if (error.status === 409) return t("errors.detailsChanged");
  if (error.status === 429) return t("errors.tooManyRequests");
  if (error.status >= 500) return t("errors.unavailable");
  return t("errors.unexpected");
}

export function getWebMessages() {
  return MESSAGES;
}
