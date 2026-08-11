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

  it("keeps desktop layout state in the shell and localizes structured overflow", () => {
    expect(stylesheet).toMatch(
      /\.desktop-window-shell\s*\{[\s\S]*?overflow:\s*hidden;[\s\S]*?min-width:\s*0;/
    );
    expect(stylesheet).toMatch(
      /\.desktop-main\s*\{[\s\S]*?container-type:\s*inline-size;/
    );
    expect(stylesheet).toMatch(
      /\.markdown-table-scroll\s*\{[\s\S]*?max-inline-size:\s*100%;[\s\S]*?overflow-x:\s*auto;/
    );
    expect(stylesheet).toMatch(
      /\.markdown-body \.markdown-table-scroll table\s*\{[\s\S]*?display:\s*table;[\s\S]*?min-inline-size:\s*100%;/
    );
    expect(stylesheet).not.toMatch(/overflow-wrap:\s*anywhere/);
    expect(stylesheet).not.toMatch(/\.markdown-body\s+table[^\{]*\{[^\}]*display:\s*block/);
    expect(stylesheet).not.toMatch(/@media\s*\([^)]*width\s*:/);
  });

  it("keeps accessibility appearance and motion preferences in the stylesheet contract", () => {
    expect(stylesheet).toMatch(/\.desktop-window-shell\s+select\s*\{[^}]*accent-color:\s*var\(--hatch-accent\)/);
    expect(stylesheet).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?transition-duration:\s*0\.01ms\s*!important/);
    expect(stylesheet).toMatch(/@media\s*\(prefers-contrast:\s*more\)[\s\S]*?border-separator/);
    expect(stylesheet).toMatch(/\.desktop-window-shell\s+:focus-visible\s*\{[\s\S]*?outline:\s*2px\s+solid\s+var\(--focus-ring\)/);
  });

  it("keeps every composer control visible at every desktop window tier", () => {
    expect(stylesheet).toMatch(/\.composer-controls\s*\{[\s\S]*?flex:\s*1\s+1\s+auto;/);
    expect(stylesheet).toMatch(/\.composer-settings\s*\{[\s\S]*?overflow:\s*visible;/);
    expect(stylesheet).not.toMatch(/\.composer-overflow/);
    expect(stylesheet).not.toMatch(/\.attachment-composer-control\s*\{[^}]*display:\s*none/);
    expect(stylesheet).not.toMatch(/\.composer-settings\s*\{[^}]*display:\s*none/);
  });

  it("uses only the insertion caret for composer text focus", () => {
    expect(stylesheet).not.toMatch(/\.composer:focus-within\s*\{/);
    expect(stylesheet).toMatch(/\.desktop-window-shell \.composer-input:focus-visible\s*\{\s*outline:\s*none;\s*\}/);
  });
});
