import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_OPTIONS,
  MESSAGES,
  SUPPORTED_LANGUAGES,
  SYSTEM_LANGUAGE,
  TRANSLATIONS,
  createTranslator,
  englishMessage,
  formatDuration,
  normalizeLanguagePreference,
  resolveLanguage,
  runtimeAssistantStatusDescriptor,
  runtimeTurnStatusDescriptor
} from "./i18n.js";

describe("language metadata", () => {
  it("exposes the system preference and all supported app languages", () => {
    expect(DEFAULT_LANGUAGE).toBe("en");
    expect(SYSTEM_LANGUAGE).toBe("system");
    expect(SUPPORTED_LANGUAGES).toEqual(["en", "zh-CN", "ja"]);
    expect(LANGUAGE_OPTIONS.map((option) => option.value)).toEqual([
      "system",
      "en",
      "zh-CN",
      "ja"
    ]);
    expect(LANGUAGE_OPTIONS.find((option) => option.value === "zh-CN")?.nativeLabel).toBe("简体中文");
    expect(MESSAGES).toBe(TRANSLATIONS);
  });

  it("keeps the complete semantic catalog aligned across languages", () => {
    const englishKeys = Object.keys(TRANSLATIONS.en).sort();
    expect(Object.keys(TRANSLATIONS["zh-CN"]).sort()).toEqual(englishKeys);
    expect(Object.keys(TRANSLATIONS.ja).sort()).toEqual(englishKeys);
    for (const key of englishKeys) {
      const englishPlaceholders = placeholders(TRANSLATIONS.en[key]);
      expect(placeholders(TRANSLATIONS["zh-CN"][key]), `zh-CN placeholders for ${key}`)
        .toEqual(englishPlaceholders);
      expect(placeholders(TRANSLATIONS.ja[key]), `ja placeholders for ${key}`)
        .toEqual(englishPlaceholders);
    }
  });
});

function placeholders(message) {
  return [...String(message).matchAll(/\{([A-Za-z0-9_.-]+)\}/g)]
    .map((match) => match[1])
    .sort();
}

describe("normalizeLanguagePreference", () => {
  it.each([
    [undefined, "system"],
    [null, "system"],
    ["", "system"],
    ["  SYSTEM  ", "system"],
    ["auto", "system"],
    ["fr-FR", "system"],
    ["en", "en"],
    ["EN_us.UTF-8", "en"],
    ["zh", "zh-CN"],
    ["ZH_hans_CN", "zh-CN"],
    ["zh-TW", "zh-CN"],
    ["ja", "ja"],
    ["ja-JP", "ja"]
  ])("normalizes %j to %s", (input, expected) => {
    expect(normalizeLanguagePreference(input)).toBe(expected);
  });
});

describe("resolveLanguage", () => {
  it("honors an explicit supported preference before system locales", () => {
    expect(resolveLanguage("zh-CN", ["ja-JP", "en-US"])).toBe("zh-CN");
    expect(resolveLanguage("en-GB", ["zh-CN"])).toBe("en");
  });

  it("uses the first supported OS locale for system and empty preferences", () => {
    expect(resolveLanguage("system", ["fr-FR", "ja-JP", "zh-CN"])).toBe("ja");
    expect(resolveLanguage("", ["de-DE", "zh-Hant-TW", "ja-JP"])).toBe("zh-CN");
    expect(resolveLanguage(null, "ja-JP")).toBe("ja");
  });

  it("treats an invalid saved preference as system and safely falls back to English", () => {
    expect(resolveLanguage("not-a-language", ["zh-CN"])).toBe("zh-CN");
    expect(resolveLanguage("not-a-language", ["fr-FR", "de-DE"])).toBe("en");
    expect(resolveLanguage("system", [])).toBe("en");
  });
});

describe("createTranslator", () => {
  it("returns production copy in English, Simplified Chinese, and Japanese", () => {
    expect(createTranslator("en")("settings.language.label")).toBe("Language");
    expect(createTranslator("zh-CN")("settings.language.label")).toBe("语言");
    expect(createTranslator("ja")("settings.language.label")).toBe("言語");

    expect(createTranslator("zh-CN")("approval.allowActionTitle")).toBe("允许此操作吗？");
    expect(createTranslator("ja")("creatorMethod.generic")).toBe("クリエイターメソッド");
  });

  it("interpolates named values without discarding unknown placeholders", () => {
    const t = createTranslator("zh-CN");
    expect(t("conversation.messageAgent", { name: "Seth" })).toBe("给 Seth 发消息");
    expect(t("permission.updatedNextTurn", { permission: "允许更改" }))
      .toBe("下一轮的权限已更新：允许更改");
    expect(t("conversation.messageAgent")).toContain("{name}");
  });

  it("selects one/other count forms for entries and matches", () => {
    const en = createTranslator("en");
    const zh = createTranslator("zh-CN");
    const ja = createTranslator("ja");

    expect(en("tool.result.entries", { count: 1 })).toBe("1 entry");
    expect(en("tool.result.entries", { count: 2 })).toBe("2 entries");
    expect(en("tool.result.matches", { count: 1 })).toBe("1 match");
    expect(en("tool.result.matches", { count: 0 })).toBe("0 matches");
    expect(zh("tool.result.entries", { count: 3 })).toBe("3 个条目");
    expect(ja("tool.result.matches", { count: 4 })).toBe("4 件一致");
  });

  it("falls back to English when a localized key is missing", () => {
    const catalogs = {
      en: { "example.greeting": "Hello, {name}!" },
      "zh-CN": {},
      ja: {}
    };
    expect(createTranslator("zh-CN", catalogs)("example.greeting", { name: "Ada" }))
      .toBe("Hello, Ada!");
    expect(createTranslator("ja", catalogs)("example.greeting", { name: "Ren" }))
      .toBe("Hello, Ren!");
  });

  it("makes a missing English key unambiguous and testable", () => {
    expect(createTranslator("en")("does.not.exist")).toBe("[missing:does.not.exist]");
    expect(createTranslator("zh-CN")("does.not.exist")).toBe("[missing:does.not.exist]");
    expect(createTranslator("en")("")).toBe("[missing:<empty>]");
  });

  it("exposes the effective language on the translator", () => {
    expect(createTranslator("zh-Hans").language).toBe("zh-CN");
    expect(createTranslator("invalid").language).toBe("en");
  });

  it("centralizes English fallback messages for non-UI modules", () => {
    expect(englishMessage("error.network.unreachable"))
      .toBe(createTranslator("en")("error.network.unreachable"));
  });
});

describe("formatDuration", () => {
  it("formats seconds and minutes in all supported languages", () => {
    expect(formatDuration(9_999, "en")).toBe("9s");
    expect(formatDuration(65_999, "en")).toBe("1m 5s");
    expect(formatDuration(65_999, "zh-CN")).toBe("1分 5秒");
    expect(formatDuration(65_999, "ja")).toBe("1分 5秒");
  });

  it("clamps invalid and negative durations to zero", () => {
    expect(formatDuration(-1, "en")).toBe("0s");
    expect(formatDuration(Number.NaN, "zh-CN")).toBe("0秒");
    expect(formatDuration(Number.POSITIVE_INFINITY, "ja")).toBe("0秒");
  });
});

describe("runtime status localization boundary", () => {
  it("maps every current runtime turn state to a semantic translation key", () => {
    expect([
      "queued",
      "running",
      "waiting_for_tool",
      "compacting",
      "completed",
      "failed",
      "cancelled",
      "interrupted"
    ].map((status) => runtimeTurnStatusDescriptor(status).key)).toEqual([
      "run.state.queued",
      "run.state.running",
      "run.state.waitingForTool",
      "run.state.compacting",
      "run.state.completed",
      "run.state.failed",
      "run.state.cancelled",
      "run.state.interrupted"
    ]);
  });

  it("maps legacy status prose and dynamic tool names without exposing raw UI copy", () => {
    expect(runtimeAssistantStatusDescriptor("Thinking through the task."))
      .toEqual({ key: "run.status.thinking", values: {} });
    expect(runtimeAssistantStatusDescriptor("Calling tool file_write."))
      .toEqual({ key: "run.status.callingTool", values: { name: "file_write" } });
    expect(runtimeAssistantStatusDescriptor("Tool shell_exec failed."))
      .toEqual({ key: "run.status.toolFailed", values: { name: "shell_exec" } });
    expect(runtimeAssistantStatusDescriptor("New server-side prose"))
      .toEqual({ key: "run.status.working", values: {} });
  });

  it("renders mapped runtime status in every supported language", () => {
    const descriptor = runtimeAssistantStatusDescriptor("Tool file_write completed.");
    expect(createTranslator("en")(descriptor.key, descriptor.values)).toBe("Tool file_write completed.");
    expect(createTranslator("zh-CN")(descriptor.key, descriptor.values)).toBe("工具 file_write 已完成。");
    expect(createTranslator("ja")(descriptor.key, descriptor.values)).toBe("ツール file_write が完了しました。");
  });
});
