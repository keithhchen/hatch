// Usage section copy, merged into the Studio shell copy (same keys in en / zh / ja).
export const USAGE_COPY = {
  en: { sxuCapReached: "Monthly usage limit reached. Your work is preserved; it resumes when the limit resets next month.", sxUsage: "Usage", sxuMonth: "Tokens this month", sxuStudio: "Studio", sxuChatApi: "Chat API", sxuChatWeb: "Chat web", sxuDaily: "Daily tokens, last 30 days", sxuCap: "Monthly limit", sxuCapOf: (used, limit) => `${used} of ${limit}`, sxuEmpty: "No Usage Yet" },
  zh: { sxuCapReached: "本月使用额度已用完。你的工作已保留，下月额度重置后可继续。", sxUsage: "用量", sxuMonth: "本月 Token", sxuStudio: "Studio", sxuChatApi: "Chat API", sxuChatWeb: "网页聊天", sxuDaily: "近 30 天每日 Token", sxuCap: "月度上限", sxuCapOf: (used, limit) => `${used} / ${limit}`, sxuEmpty: "还没有用量" },
  ja: { sxuCapReached: "今月の利用上限に達しました。作業は保存されています。来月、上限がリセットされると再開できます。", sxUsage: "使用量", sxuMonth: "今月のトークン", sxuStudio: "Studio", sxuChatApi: "Chat API", sxuChatWeb: "Webチャット", sxuDaily: "過去30日の日別トークン", sxuCap: "月間上限", sxuCapOf: (used, limit) => `${used} / ${limit}`, sxuEmpty: "使用量はまだありません" }
};
