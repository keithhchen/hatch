// API keys page copy, merged into the Studio shell copy (same keys in en / zh / ja).
export const API_KEYS_COPY = {
  en: {
    sxakBanner: "Hatch Studio also runs in Codex or Claude Code. Build your agent with Hatch CLI/MCP.", sxakBannerCta: "Create API Key",
    sxNavApiKeys: "API Keys", sxakDevelopers: "API Documentation",
    sxakCreate: "Create Key", sxakNameLabel: "Key name", sxakNamePlaceholder: "e.g. My laptop CLI", sxakCreating: "Creating…",
    sxakCreatedTitle: "Your New Key", sxakCreatedWarn: "Copy it now. You won't see this key again.", sxakCopy: "Copy", sxakCopied: "Copied", sxakDone: "Done",
    sxakTokenLabel: "API key",
    sxakColName: "Name", sxakColCreated: "Created", sxakColLastUsed: "Last Used", sxakColExpires: "Expires", sxakNever: "Never",
    sxakRevoke: "Revoke", sxakRevokeTitle: (name) => `Revoke "${name}"?`, sxakRevokeBody: "Anything using this key stops working right away. This can't be undone.",
    sxakEmpty: "No Keys Yet", sxakLoadError: "Could not load your API keys"
  },
  zh: {
    sxakBanner: "Hatch Studio 也能在 Codex 或 Claude Code 里使用。用 Hatch CLI/MCP 构建你的 Agent。", sxakBannerCta: "创建 API 密钥",
    sxNavApiKeys: "API 密钥", sxakDevelopers: "开发者文档",
    sxakCreate: "创建密钥", sxakNameLabel: "密钥名称", sxakNamePlaceholder: "例如：我的笔记本 CLI", sxakCreating: "创建中…",
    sxakCreatedTitle: "你的新密钥", sxakCreatedWarn: "请现在复制。之后不会再显示这个密钥。", sxakCopy: "复制", sxakCopied: "已复制", sxakDone: "完成",
    sxakTokenLabel: "API 密钥",
    sxakColName: "名称", sxakColCreated: "创建时间", sxakColLastUsed: "最近使用", sxakColExpires: "到期", sxakNever: "从未",
    sxakRevoke: "撤销", sxakRevokeTitle: (name) => `撤销“${name}”？`, sxakRevokeBody: "使用该密钥的一切会立即失效，且无法恢复。",
    sxakEmpty: "还没有密钥", sxakLoadError: "无法加载 API 密钥"
  },
  ja: {
    sxakBanner: "Hatch Studio は Codex や Claude Code でも使えます。Hatch CLI/MCP で Agent を作りましょう。", sxakBannerCta: "API キーを作成",
    sxNavApiKeys: "APIキー", sxakDevelopers: "開発者ドキュメント",
    sxakCreate: "キーを作成", sxakNameLabel: "キー名", sxakNamePlaceholder: "例：自分のノートPCのCLI", sxakCreating: "作成中…",
    sxakCreatedTitle: "新しいキー", sxakCreatedWarn: "今すぐコピーしてください。このキーは二度と表示されません。", sxakCopy: "コピー", sxakCopied: "コピーしました", sxakDone: "完了",
    sxakTokenLabel: "APIキー",
    sxakColName: "名前", sxakColCreated: "作成日", sxakColLastUsed: "最終使用", sxakColExpires: "有効期限", sxakNever: "なし",
    sxakRevoke: "無効にする", sxakRevokeTitle: (name) => `「${name}」を無効にしますか？`, sxakRevokeBody: "このキーを使っているものはすぐに動かなくなります。元に戻せません。",
    sxakEmpty: "キーはまだありません", sxakLoadError: "APIキーを読み込めませんでした"
  }
};
