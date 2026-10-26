import { describe, expect, it } from "vitest";
import { ChatError } from "@hatch/chat";
import { LANGUAGE_OPTIONS, SUPPORTED_LANGUAGES, TRANSLATIONS, createTranslator, errorText, normalizeLanguagePreference, resolveLanguage } from "./i18n.js";

const placeholders = message => [...String(message).matchAll(/\{([A-Za-z0-9_.-]+)\}/g)].map(match => match[1]).sort();

describe("Desktop localization", () => {
  it("ships the same keys and placeholders in every language", () => {
    const keys = Object.keys(TRANSLATIONS.en).sort();
    for (const language of SUPPORTED_LANGUAGES) {
      expect(Object.keys(TRANSLATIONS[language]).sort(), language).toEqual(keys);
      for (const key of keys) expect(placeholders(TRANSLATIONS[language][key]), `${language}:${key}`).toEqual(placeholders(TRANSLATIONS.en[key]));
    }
    expect(LANGUAGE_OPTIONS.map(option => option.value)).toEqual(["system", ...SUPPORTED_LANGUAGES]);
  });

  it("covers every key the shared chat view and activity titles use", () => {
    for (const key of ["messageAgent", "sendMessage", "stopReply", "viewEarlierMessages", "agentReplying", "syncingReply", "thinkingRunningTitle",
      "toolRunningTitle", "skillActivatedTitle", "skillInvokedTitle", "skillRunRunningTitle", "skillRunCompleteTitle", "activityDetails", "arguments", "result"]) {
      expect(TRANSLATIONS.en[key], key).toBeTruthy();
    }
  });

  it("resolves preferences against system locales", () => {
    expect(normalizeLanguagePreference("ZH_hans_CN")).toBe("zh-CN");
    expect(normalizeLanguagePreference("fr-FR")).toBe("system");
    expect(resolveLanguage("system", ["fr-FR", "ja-JP"])).toBe("ja");
    expect(resolveLanguage("system", ["fr-FR"])).toBe("en");
    expect(resolveLanguage("zh-CN", ["ja-JP"])).toBe("zh-CN");
  });

  it("interpolates, falls back to English, and localizes errors", () => {
    const t = createTranslator("zh-CN");
    expect(t("messageAgent", { agent: "A" })).toBe("给 A 发消息");
    expect(createTranslator("zh-CN", { en: { only: "Only" }, "zh-CN": {} })("only")).toBe("Only");
    expect(errorText(t, new ChatError("missingBriefField", { field: "目标" }))).toBe("请填写：目标");
    expect(errorText(t, { code: "network_error" })).toBe("Hatch 无法连接服务。");
    expect(errorText(t, new Error("raw"))).toBe("raw");
  });
});
