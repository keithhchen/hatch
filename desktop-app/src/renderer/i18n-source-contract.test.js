import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Desktop UI localization source contract", () => {
  it("keeps visible JSX copy and accessibility labels behind translation keys", async () => {
    const source = await readFile(new URL("./main.jsx", import.meta.url), "utf8");
    const rawTextNodes = [...source.matchAll(
      />\s*([A-Za-z][A-Za-z0-9 ,.'’!?+:—–-]*?)\s*<\/[A-Za-z]/g
    )]
      .map((match) => match[1].trim());
    const rawAccessibilityCopy = [...source.matchAll(
      /\b(?:aria-label|placeholder|title)=(?:"[A-Za-z][^"]*"|'[A-Za-z][^']*')/g
    )].map((match) => match[0]);
    const rawStatusCopy = [...source.matchAll(/\bsetStatus\(\s*["'`][A-Za-z]/g)]
      .map((match) => match[0]);

    expect(rawTextNodes).toEqual([]);
    expect(rawAccessibilityCopy).toEqual([]);
    expect(rawStatusCopy).toEqual([]);
  });

  it("bundles localized macOS folder-permission copy for every app language", async () => {
    const config = JSON.parse(await readFile(
      new URL("../../src-tauri/tauri.conf.json", import.meta.url),
      "utf8"
    ));
    const localizedResources = {
      "locales/en.lproj/InfoPlist.strings": "en.lproj/InfoPlist.strings",
      "locales/zh-Hans.lproj/InfoPlist.strings": "zh-Hans.lproj/InfoPlist.strings",
      "locales/ja.lproj/InfoPlist.strings": "ja.lproj/InfoPlist.strings"
    };
    expect(config.bundle.resources).toEqual(localizedResources);

    const permissionKeys = [
      "NSDocumentsFolderUsageDescription",
      "NSDesktopFolderUsageDescription",
      "NSDownloadsFolderUsageDescription"
    ];
    for (const sourcePath of Object.keys(localizedResources)) {
      const strings = await readFile(new URL(`../../src-tauri/${sourcePath}`, import.meta.url), "utf8");
      for (const key of permissionKeys) {
        expect(strings).toContain(`\"${key}\" = `);
      }
    }
  });
});
