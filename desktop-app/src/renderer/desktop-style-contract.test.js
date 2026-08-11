import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("desktop system appearance contract", () => {
  it("lets native controls follow light or dark system appearance", () => {
    expect(stylesheet).toMatch(/:root\s*\{[\s\S]*?color-scheme:\s*light dark;/);
    expect(stylesheet).toMatch(
      /@media\s*\(prefers-color-scheme:\s*dark\)[\s\S]*?:root\s*\{[\s\S]*?color-scheme:\s*dark;/
    );
    expect(stylesheet).not.toMatch(/color-scheme:\s*light\s*;/);
  });
});
