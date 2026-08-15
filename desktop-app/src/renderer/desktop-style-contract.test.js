import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const brandTokens = readFileSync(new URL("../../../packages/brand/tokens.css", import.meta.url), "utf8");
const sharedStylesheet = readFileSync(new URL("../../../packages/ui/src/hatch-ui.css", import.meta.url), "utf8");

describe("desktop system appearance contract", () => {
  it("keeps the current Hatch product explicitly light-only", () => {
    expect(stylesheet).toMatch(/:root\s*\{[\s\S]*?color-scheme:\s*light;/);
    expect(stylesheet).not.toMatch(/prefers-color-scheme:\s*dark/);
    expect(stylesheet).not.toMatch(/color-scheme:\s*light dark/);
  });

  it("does not let legacy desktop resets override shared Hatch controls", () => {
    expect(stylesheet).toMatch(/:where\(button:not\(\.hui-button\)\)\s*\{/);
    expect(stylesheet).toMatch(/:where\(input:not\(\.hui-input\)\)\s*\{/);
    expect(stylesheet).not.toMatch(/(?:^|\n)button\s*\{/);
    expect(stylesheet).not.toMatch(/(?:^|\n)input\s*\{/);
  });

  it("keeps Atmospheric Paper at the shared root without dark navigation blocks", () => {
    expect(stylesheet).toMatch(/\.desktop-ui-root\s*\{[\s\S]*?height:\s*100%;/);
    expect(stylesheet).toMatch(/\.desktop-window-shell\s*\{[\s\S]*?background:\s*transparent;/);
    expect(stylesheet).not.toMatch(/\.desktop-window-shell::before/);
    expect(stylesheet).not.toMatch(/@keyframes desktop-atmosphere-warm/);
    expect(stylesheet).toMatch(/\.desktop-source-row\.selected\s*\{[\s\S]*?radial-gradient/);
    expect(stylesheet).not.toMatch(/\.desktop-source-row\.selected\s*\{[^}]*background:\s*var\(--hatch-inverse\)/);
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

  it("keeps agent avatars circular when the navigation label grows", () => {
    expect(stylesheet).toMatch(
      /\.desktop-source-row\.hui-navigation-item\s*>\s*\.creator-avatar\s*\{[\s\S]*?flex:\s*0 0 29px;[\s\S]*?height:\s*29px;[\s\S]*?min-width:\s*29px;[\s\S]*?width:\s*29px;[\s\S]*?aspect-ratio:\s*1;/
    );
  });

  it("keeps the creator label regular and lets the sidebar use the shared brand scale", () => {
    expect(stylesheet).toMatch(
      /\.desktop-source-list-label\s*\{[\s\S]*?font-family:\s*var\(--hatch-font-pill\);[\s\S]*?font-weight:\s*400;/
    );
    expect(stylesheet).not.toMatch(/\.desktop-sidebar-heading \.desktop-sidebar-brand \.hatch-brand__mark/);
    expect(stylesheet).not.toMatch(/\.desktop-sidebar-heading \.desktop-sidebar-brand \.hatch-brand__wordmark/);
    expect(sharedStylesheet).toMatch(/\.hatch-brand__mark\s*\{[^}]*width:\s*30px;[^}]*height:\s*30px;/);
    expect(sharedStylesheet).toMatch(/\.hatch-brand__wordmark\s*\{[^}]*font-size:\s*var\(--hatch-type-title\);/);
  });

  it("keeps the new task action regular in every sidebar state", () => {
    expect(stylesheet).toMatch(
      /\.sidebar-new-task\s*\{[\s\S]*?font-size:\s*var\(--hatch-type-label\);[\s\S]*?font-weight:\s*400;/
    );
    expect(stylesheet).toMatch(
      /\.desktop-agent-conversation-group \.sidebar-new-task\s*\{[\s\S]*?font-weight:\s*400;/
    );
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

  it("keeps workspace and permission controls on one shared geometry", () => {
    expect(brandTokens).toMatch(/--hatch-size-control-compact:\s*2rem/);
    expect(brandTokens).toMatch(/--hatch-space-control-compact-inline:\s*0\.625rem/);
    expect(sharedStylesheet).toMatch(
      /\.hui-control--compact\s*\{[\s\S]*?height:\s*var\(--hatch-size-control-compact\);[\s\S]*?min-height:\s*var\(--hatch-size-control-compact\);[\s\S]*?padding-block:\s*0;[\s\S]*?padding-inline:\s*var\(--hatch-space-control-compact-inline\);[\s\S]*?border-radius:\s*var\(--hatch-radius-control\);/
    );
    expect(sharedStylesheet).toMatch(
      /\.hui-control-caret,[\s\S]*?\.hui-select-trigger > \.hui-select-caret\s*\{[\s\S]*?color:\s*var\(--hui-ink-faint\);[\s\S]*?height:\s*14px;[\s\S]*?stroke-width:\s*1\.55;[\s\S]*?width:\s*14px;/
    );
    expect(sharedStylesheet).toMatch(
      /\.hui-theme-origin \.hui-control--raised,[\s\S]*?\.hui-theme-material \.hui-control--raised\s*\{[\s\S]*?border-radius:\s*var\(--hatch-radius-control\);[\s\S]*?box-shadow:/
    );
    expect(stylesheet).toMatch(
      /\.composer-control\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?gap:\s*6px;/
    );
    expect(stylesheet).toMatch(
      /\.permission-composer-control \.composer-control-select\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?min-width:\s*0;/
    );
    expect(readFileSync(new URL("./main.jsx", import.meta.url), "utf8")).toMatch(
      /className="composer-control workspace-composer-control"[\s\S]*?surface="raised"[\s\S]*?className="composer-control-select"[\s\S]*?surface="raised"/
    );
  });

  it("keeps composer actions circular and the activity divider at accordion width", () => {
    expect(stylesheet).toMatch(/\.send-button,\s*\.stop-button\s*\{[\s\S]*?align-items:\s*center;[\s\S]*?display:\s*inline-flex;[\s\S]*?justify-content:\s*center;[\s\S]*?line-height:\s*0;[\s\S]*?border-radius:\s*50%;/);
    expect(stylesheet).toMatch(/\.send-button svg\s*\{[\s\S]*?display:\s*block;[\s\S]*?margin:\s*0;/);
    expect(stylesheet).toMatch(/\.send-button\s*>\s*span\s*\{[\s\S]*?display:\s*grid;[\s\S]*?flex:\s*0 0 18px;[\s\S]*?height:\s*18px;[\s\S]*?width:\s*18px;/);
    expect(stylesheet).toMatch(/\.send-button:not\(:disabled\),\s*\.stop-button:not\(:disabled\)\s*\{[\s\S]*?color:\s*var\(--hatch-ui-on-primary\);/);
    expect(stylesheet).toMatch(/\.assistant-activity-shell\s*\{[\s\S]*?width:\s*100%;/);
    expect(stylesheet).toMatch(/\.assistant-activity-divider\s*\{[\s\S]*?width:\s*100%;/);
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
      /\.markdown-body\s*\{[\s\S]*?font-size:\s*var\(--hatch-type-reading\);[\s\S]*?line-height:\s*1\.72;/
    );
    expect(stylesheet).toMatch(
      /\.markdown-body h1\s*\{[\s\S]*?font-size:\s*var\(--hatch-type-heading\);[\s\S]*?line-height:\s*var\(--hatch-display-leading\);/
    );
    expect(stylesheet).not.toMatch(/line-height:\s*[0-9]+(?:\.[0-9]+)?px/);
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

  it("consumes the approved shared typography tokens", () => {
    expect(stylesheet).not.toMatch(/font-size:\s*[0-9]+(?:\.[0-9]+)?(?:px|rem)/);
    expect(stylesheet).not.toMatch(/font:\s*\d+\s+[0-9]+(?:\.[0-9]+)?px/);
    expect(stylesheet).toMatch(/var\(--hatch-type-(?:label|control|body|reading|title)\)/);
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

  it("keeps the welcome titlebar drag region above the login surface", () => {
    expect(stylesheet).toMatch(
      /\.welcome-titlebar-drag-region\s*\{[\s\S]*?-webkit-app-region:\s*drag;[\s\S]*?height:\s*62px;[\s\S]*?position:\s*absolute;/
    );
  });
});
