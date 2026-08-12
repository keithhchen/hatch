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
    expect(stylesheet).toMatch(/\.activity-spinner\s*\{[\s\S]*?animation:\s*connection-spin 1s linear infinite;/);
    expect(stylesheet).toMatch(/prefers-reduced-motion[\s\S]*?\.activity-spinner\s*\{\s*animation:\s*none;/);
    expect(stylesheet).toMatch(/\.status-text-shimmer\s*\{[\s\S]*?animation:\s*status-text-shimmer 3s/);
    expect(stylesheet).toMatch(/prefers-reduced-motion[\s\S]*?\.status-text-shimmer\s*\{\s*animation:\s*none;/);
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

  it("keeps the workspace control left aligned without clipping its label", () => {
    expect(stylesheet).toMatch(
      /\.workspace-composer-control\s*\{[\s\S]*?justify-content:\s*flex-start;[\s\S]*?min-width:\s*0;/
    );
    expect(stylesheet).toMatch(
      /\.workspace-composer-control \.composer-control-label\s*\{[\s\S]*?overflow:\s*visible;[\s\S]*?text-overflow:\s*clip;/
    );
  });

  it("uses only the insertion caret for composer text focus", () => {
    expect(stylesheet).not.toMatch(/\.composer:focus-within\s*\{/);
    expect(stylesheet).toMatch(/\.desktop-window-shell \.composer-input:focus-visible\s*\{\s*outline:\s*none;\s*\}/);
  });

  it("keeps long-form Markdown on the measured reading rhythm", () => {
    expect(stylesheet).toMatch(
      /\.markdown-body\s*\{[\s\S]*?font-size:\s*16px;[\s\S]*?line-height:\s*26px;/
    );
    expect(stylesheet).toMatch(
      /\.markdown-body h1\s*\{[\s\S]*?font-size:\s*24px;[\s\S]*?line-height:\s*32px;/
    );
    expect(stylesheet).toMatch(
      /\.markdown-body h1,\s*\.markdown-body h2\s*\{[\s\S]*?font-family:\s*var\(--hatch-font-display\);[\s\S]*?font-weight:\s*400;/
    );
    expect(stylesheet).toMatch(
      /\.markdown-body blockquote::before\s*\{[\s\S]*?width:\s*3px;/
    );
    expect(stylesheet).toMatch(
      /\.markdown-body th,\s*\.markdown-body td\s*\{[\s\S]*?border-bottom:\s*1px solid[^;]*;[\s\S]*?padding:\s*10px 24px 10px 0;/
    );
    expect(stylesheet).toMatch(
      /\.markdown-body hr\s*\{[\s\S]*?border-top:\s*1px solid[^;]*15%[^;]*;[\s\S]*?margin:\s*28px 0;/
    );
    expect(stylesheet).not.toMatch(/\.markdown-table-scroll\s*\{[^}]*border:\s*1px/);
  });

  it("softens only newly mounted streaming Markdown blocks", () => {
    const blockReveal = stylesheet.match(/@keyframes markdown-block-reveal\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(stylesheet).toMatch(
      /\.message-surface\.assistant\.streaming \.markdown-body > :where\([\s\S]*?\.markdown-table-scroll[\s\S]*?animation:\s*markdown-block-reveal 700ms cubic-bezier\(0\.22, 1, 0\.36, 1\) both;/
    );
    expect(blockReveal).toMatch(/opacity:\s*0\.15;[\s\S]*?opacity:\s*1;/);
    expect(blockReveal).not.toMatch(/transform:/);
    expect(stylesheet).not.toMatch(/\.message-surface\.assistant\.streaming\s*\{[^}]*animation:/);
    expect(stylesheet).toMatch(
      /prefers-reduced-motion[\s\S]*?\.message-surface\.assistant\.streaming \.markdown-body > :where\([\s\S]*?animation:\s*none;/
    );
  });

  it("keeps tool approvals inline instead of duplicating them above the composer", () => {
    expect(stylesheet).toMatch(/\.approval-gate\s*\{/);
    expect(stylesheet).not.toMatch(/\.composer-approval-banner\s*\{/);
  });

  it("keeps the manual connection retry compact and visible", () => {
    expect(stylesheet).toMatch(
      /\.desktop-connection-retry-button\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?width:\s*auto;/
    );
  });
});
