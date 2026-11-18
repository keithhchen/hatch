// Buyer / public Web copy. Keys are the English source; each entry is
// [Chinese, Japanese]. Product tone: clear, concise, neutral (see
// docs/web-visual-guidelines.md §7). Each language should read naturally on its
// own, not word-for-word. Unknown keys fall back to the English source.
const ENTRIES = {
  // Navigation and shell
  Explore: ["探索", "探す"],
  Account: ["账户", "アカウント"],
  Studio: ["Studio", "Studio"],
  "Sign in": ["登录", "ログイン"],
  "Sign out": ["退出登录", "ログアウト"],
  "Signing out…": ["正在退出…", "ログアウト中…"],
  "Account settings": ["账户设置", "アカウント設定"],
  "Buyer navigation": ["网站导航", "サイトナビゲーション"],
  "Hatch home": ["Hatch 首页", "Hatch ホーム"],
  "Change language": ["切换语言", "言語を変更"],
  Language: ["语言", "言語"],
  "Loading account": ["正在加载账户", "アカウントを読み込み中"],
  "Redirecting to sign in…": ["正在跳转到登录…", "ログイン画面に移動しています…"],
  "Go to sign in": ["前往登录", "ログインへ"],

  "Open Studio": ["打开 Studio", "Studio を開く"],
  "Browse Agents": ["浏览 Agent", "Agent を探す"],

  // Own Agents
  "Go to chat": ["去聊天", "チャットを開く"],

  // Explore and My library
  Discover: ["发现", "発見"],
  "My library": ["我的库", "マイライブラリ"],
  Saved: ["已保存", "保存済み"],
  Remove: ["移除", "削除"],
  "Sign in to see your library": ["登录后查看你的库", "ログインするとライブラリを表示できます"],
  "Your library is empty": ["库里还没有 Agent", "ライブラリにはまだ Agent がありません"],
  "Your Agent": ["你的 Agent", "自分の Agent"],
  "{count} in progress in Studio →": ["Studio 中 {count} 个制作中 →", "Studio で {count} 件作成中 →"],
  "Published by me": ["我发布的", "公開した Agent"],
  "Publish your first Agent in Studio →": ["去 Studio 发布第一个 Agent →", "Studio で最初の Agent を公開 →"],
  Settings: ["设置", "設定"],

  // Catalog
  "Loading Agents": ["正在加载", "読み込み中"],
  "Published Agents": ["已发布的 Agent", "公開中の Agent"],
  "No published Agents": ["暂无已发布的 Agent", "公開中の Agent はありません"],
  "Agents appear here once experts publish them.": ["专家发布后，Agent 将显示在此处。", "専門家が公開すると、ここに表示されます。"],
  "Publish an Agent": ["发布 Agent", "Agent を公開"],
  Expert: ["专家", "専門家"],
  "Loading expert": ["正在加载", "読み込み中"],
  "← Explore": ["← 探索", "← 探す"],
  "Agents published by this expert.": ["该专家发布的 Agent。", "この専門家が公開している Agent です。"],
  "This expert has not published any Agents.": ["该专家尚未发布 Agent。", "この専門家が公開している Agent はまだありません。"],
  Verified: ["已认证", "認証済み"],
  Free: ["免费", "無料"],
  Details: ["查看详情", "詳細"],

  // Product
  "Agent details": ["Agent 详情", "Agent の詳細"],
  "How it works": ["使用方式", "ご利用の流れ"],
  "Start a conversation": ["开始对话", "会話を開始"],
  "Pick up where you left off": ["随时接着聊", "続きからいつでも"],
  "Agents you chat with are saved to My library.": ["聊过的 Agent 会保存在我的库里。", "会話した Agent はマイライブラリに保存されます。"],
  "The expert's own judgment": ["专家本人的判断", "専門家本人の判断"],
  "Answers draw on this expert's methods and experience, in their own style — not a generic AI answer.": ["回答来自这位专家的方法和经验，带着专家自己的风格，不是通用 AI 的标准答案。", "この専門家の方法と経験にもとづき、本人らしい言葉で答えます。汎用 AI の決まりきった答えではありません。"],
  "Example questions": ["示例问题", "質問の例"],
  "Manage product": ["管理产品", "製品を管理"],
  "Start chat": ["开始对话", "会話を開始"],
  "This product is unavailable": ["该产品暂不可用", "この製品は現在利用できません"],
  "Untitled product": ["未命名产品", "名称未設定の製品"],
  "Preview offer": ["预览", "プレビュー"],
  "Product offer": ["添加方式", "追加方法"],
  "What to provide": ["需要提供", "必要なもの"],
  "What you receive": ["交付内容", "提供内容"],
  "Out of scope": ["不包含", "対象外"],
  Privacy: ["隐私", "プライバシー"],

  // Account
  "Hatch account": ["Hatch 账户", "Hatch アカウント"],
  "Signed-in account": ["已登录的账户", "ログイン中のアカウント"],
  "Account help": ["账户帮助", "アカウントヘルプ"],
  "Log in with Telegram": ["使用 Telegram 登录", "Telegram でログイン"],
  "Telegram login failed. Try again.": ["Telegram 登录失败，请重试。", "Telegram ログインに失敗しました。もう一度お試しください。"],
  "Log in with LINE": ["使用 LINE 登录", "LINE でログイン"],
  "LINE login failed. Try again.": ["LINE 登录失败，请重试。", "LINE ログインに失敗しました。もう一度お試しください。"],
  "Log in with Discord": ["使用 Discord 登录", "Discord でログイン"],
  "Discord login failed. Try again.": ["Discord 登录失败，请重试。", "Discord ログインに失敗しました。もう一度お試しください。"],
  "Edit name": ["修改姓名", "名前を変更"],
  Save: ["保存", "保存する"],
  "Enter a name.": ["请输入姓名。", "名前を入力してください。"],
  "Display name is required.": ["请输入姓名。", "名前を入力してください。"],
  "Display name must not exceed 128 characters.": ["姓名不能超过 128 个字符。", "名前は 128 文字以内で入力してください。"],
  "Signed in as {name}": ["当前登录：{name}", "ログイン中：{name}"],
  "Check your account": ["核对账户", "アカウントの確認"],
  "If My library is empty, your chats may belong to a different email. Sign out and sign in with that email.": ["如果我的库是空的，对话可能属于其他邮箱。请退出后用那个邮箱登录。", "マイライブラリが空の場合、会話は別のメールアドレスに紐づいている可能性があります。ログアウトして、そのメールアドレスでログインしてください。"],
  "Sign in with the email you used before.": ["请使用之前用过的邮箱登录。", "以前使用したメールアドレスでログインしてください。"],

  // Auth
  "Create account": ["创建账户", "アカウントを作成"],
  "Sign in with your Hatch account.": ["使用 Hatch 账户登录。", "Hatch アカウントでログインします。"],
  "Create a free account to keep your Agents and chats.": ["创建免费账户，保存你的 Agent 和对话。", "無料のアカウントを作成すると、Agent と会話を保存できます。"],
  "Sign in to an existing account": ["登录已有账户", "既存のアカウントでログイン"],
  "Sign in to continue to this Agent.": ["登录后继续查看此 Agent。", "ログインして、この Agent に進みます。"],
  "Create an account to continue to this Agent.": ["创建账户后继续查看此 Agent。", "アカウントを作成して、この Agent に進みます。"],
  "Loading Agent": ["正在加载", "読み込み中"],
  Name: ["姓名", "名前"],
  Email: ["邮箱", "メールアドレス"],
  Password: ["密码", "パスワード"],
  "At least 8 characters": ["至少 8 个字符", "8 文字以上"],
  "Email or password is incorrect.": ["邮箱或密码不正确。", "メールアドレスまたはパスワードが正しくありません。"],




  // Errors and generic states
  "Page not found": ["页面不存在", "ページが見つかりません"],
  "The link may be incorrect, or the page was removed.": ["链接可能有误，或页面已被移除。", "リンクが正しくないか、ページが削除された可能性があります。"],
  "Session expired": ["登录已过期", "セッションの有効期限切れ"],
  "Sign in again to continue. You will return to this page.": ["请重新登录以继续，登录后将返回此页面。", "続行するには再度ログインしてください。ログイン後、このページに戻ります。"],
  "No access to this page": ["无权访问此页面", "このページへのアクセス権がありません"],
  "This page may belong to another account. Check the email you are signed in with.": ["此页面可能属于其他账户，请确认当前登录的邮箱。", "別のアカウントのページである可能性があります。ログイン中のメールアドレスを確認してください。"],
  "Not found": ["未找到", "見つかりません"],
  "It may have been removed, or the link is incomplete.": ["可能已被移除，或链接不完整。", "削除されたか、リンクが不完全な可能性があります。"],
  "Details changed": ["内容已更新", "内容が更新されました"],
  Refresh: ["刷新", "更新"],
  "Could not load": ["加载失败", "読み込めませんでした"],
  "Try again": ["重试", "再試行"],
  "Loading details": ["正在加载", "読み込み中"],
  "Expert Agent": ["专家 Agent", "専門家の Agent"],
  "Untitled Agent": ["未命名 Agent", "名称未設定のAgent"],
  "An Agent built from an expert's method.": ["基于专家方法构建的 Agent。", "専門家の手法をもとに構築された Agent です。"],
  "Hatch Expert": ["Hatch 专家", "Hatch 専門家"],
  "Product detail": ["产品信息", "製品情報"],
  "Hatch is temporarily unavailable. Try again shortly.": ["Hatch 暂时不可用，请稍后重试。", "Hatch は一時的に利用できません。しばらくしてからお試しください。"],
  "Something went wrong. Try again.": ["出现错误，请重试。", "エラーが発生しました。もう一度お試しください。"],
  "This product was updated. Refresh to confirm the current version.": ["该产品已更新，请刷新后确认当前版本。", "製品が更新されました。ページを更新して現在のバージョンを確認してください。"],
  "Too many requests. Try again shortly.": ["请求过于频繁，请稍后重试。", "リクエストが多すぎます。しばらくしてからお試しください。"],
  "Hatch is temporarily unavailable. Try again shortly.": ["Hatch 暂时不可用，请稍后重试。", "Hatch は一時的に利用できません。しばらくしてからお試しください。"],


  // Profile photo (AccountAvatarSettings)
  "Profile photo": ["头像", "プロフィール写真"],
  "Choose a profile photo": ["选择头像", "プロフィール写真を選択"],
  "Upload photo": ["上传头像", "写真をアップロード"],
  "Remove photo": ["移除头像", "写真を削除"],
  "Profile photo updated.": ["头像已更新。", "プロフィール写真を更新しました。"],
  "Profile photo removed.": ["头像已移除。", "プロフィール写真を削除しました。"],
  "Crop your photo": ["裁剪头像", "写真の切り抜き"],
  "Move and zoom the image to choose a square crop.": ["拖动或缩放图片以选择正方形区域。", "画像を移動・拡大して、正方形の範囲を選択してください。"],
  Cancel: ["取消", "キャンセル"],
  "Uploading…": ["正在上传…", "アップロード中…"],
  "Crop and upload": ["裁剪并上传", "切り抜いてアップロード"],
  "This image could not be opened.": ["无法打开此图片。", "この画像を開けませんでした。"],
  Zoom: ["缩放", "ズーム"]
};

const COPY = {
  zh: Object.fromEntries(Object.entries(ENTRIES).map(([key, [zh]]) => [key, zh])),
  ja: Object.fromEntries(Object.entries(ENTRIES).map(([key, [, ja]]) => [key, ja]))
};

export function buyerT(locale, key, values = {}) {
  const template = COPY[locale]?.[key] ?? key;
  return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template);
}

export function buyerDictionary(locale) {
  return COPY[locale] || {};
}

export function buyerCopyKeys() {
  return Object.keys(ENTRIES);
}
