import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./main.jsx", import.meta.url), "utf8");
const shellSource = readFileSync(new URL("./desktop-shell.jsx", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

describe("desktop component presentation contract", () => {
  it("consumes shared components, fonts, and theme without a second brand source", () => {
    expect(packageJson.dependencies["@hatch/ui"]).toBe("file:../packages/ui");
    expect(Object.keys(packageJson.dependencies)).not.toContain("@fontsource/dm-mono");
    expect(Object.keys(packageJson.dependencies).some((dependency) => dependency.startsWith("@fontsource"))).toBe(false);
    expect(source).toContain('import "@hatch/ui/fonts"');
    expect(source).toContain('import "@hatch/ui/theme.css"');
    expect(source).toContain("HatchUIProvider");
    expect(source).toMatch(/<HatchUIProvider\s+atmosphere\s+className="desktop-ui-root"/);
    expect(source).toContain('<HatchBrand className="desktop-sidebar-brand"');
    expect(source).toContain('<HatchBrand className="desktop-auxiliary-brand"');
    expect(source).not.toMatch(/@fontsource|packages\/brand/);
  });

  it("uses shared IconButton controls for toolbar and overlay chrome", () => {
    expect(shellSource).toContain('import { IconButton } from "@hatch/ui"');
    expect(shellSource).toMatch(/<IconButton[\s\S]*className="chrome-icon-button sidebar-toggle"/);
    expect(shellSource).toMatch(/<IconButton[\s\S]*className="chrome-icon-button toolbar-overflow-toggle"/);
    expect(shellSource).toMatch(/<IconButton[\s\S]*className="chrome-icon-button inspector-toggle"/);
    expect(shellSource).not.toMatch(/<button\s+[^>]*className="chrome-icon-button"/);
    expect(source).toMatch(/<IconButton[\s\S]*className="profile-settings-button"[\s\S]*surface="raised"/);
  });

  it("uses shared navigation and button primitives for high-frequency sidebar actions", () => {
    expect(source).toContain('NavigationItem,');
    expect(source).toContain('ButtonControl,');
    expect(source).toContain('SelectControl');
    expect(source).toMatch(/<NavigationItem[\s\S]*className=\{`desktop-source-row agent/);
    expect(source).toMatch(/<NavigationItem[\s\S]*className="desktop-source-row sidebar-new-task"/);
    expect(source).toMatch(/<Button className=\{`workspace-picker/);
    expect(source).not.toMatch(/<button className=\{`workspace-picker/);
  });

  it("uses the shared icon library instead of character carets", () => {
    expect(source).toContain('from "lucide-react"');
    expect(source).not.toMatch(/[⌄›]/);
    expect(source).toContain('<ChevronDown className="hui-control-caret"');
    expect(source).toMatch(/<ButtonControl[\s\S]*?className="composer-control"/);
    expect(source).toMatch(/<SelectControl[\s\S]*?className="composer-control"/);
    expect(source).toContain('className="desktop-agent-disclosure"');
  });

  it("keeps every composer action permanently mounted", () => {
    expect(source).toContain('className="composer-control attachment-composer-control"');
    expect(source).toContain('<ButtonControl');
    expect(source).toContain('<SelectControl');
    expect(source).not.toContain('workspace-composer-control');
    expect(source).not.toContain('permission-composer-control');
    expect(source).not.toContain('composer-control-select');
    expect(source).not.toContain('className="composer-overflow"');
    expect(source).not.toContain("More composer options");
    expect(source).toMatch(/className="send-button stop-button"[\s\S]*?variant="primary"/);
    expect(source).toMatch(/<SelectControl[\s\S]*?leading=\{<ShieldIcon \/>\}/);
    expect(source).toContain("assistant-activity-divider");
  });

  it("keeps real send and stop actions accessible while presenting icons", () => {
    expect(source).toMatch(/aria-label="Send message"[\s\S]*?<ArrowUp aria-hidden="true"/);
    expect(source).toContain('<span className="send-button-icon">');
    expect(source).toMatch(/aria-label="Stop response"[\s\S]*?onClick=\{\(\) => void cancelRun\(\)\}[\s\S]*?<Square/);
    expect(source).not.toMatch(/>\s*Send\s*</);
    expect(source).not.toMatch(/>\s*Stop\s*</);
    expect(source).not.toContain("<AssistantTurnTiming />");
  });

  it("keeps title-bar context compact and removes verbose status copy", () => {
    expect(source).toContain('className="desktop-toolbar-conversation"');
    expect(source).toContain('className="desktop-toolbar-agent-name"');
    expect(source).toContain('aria-hidden="true">|</span>');
    expect(source).toContain("creatorAgentContextTitle");
    expect(source).toContain("getCurrentWindow().setTitle(title)");
    expect(source).not.toContain('className="desktop-connection-copy"');
    expect(source).not.toContain('className="settings-migration-notice"');
  });

  it("shows a real connection spinner while an individual chat is loading", () => {
    expect(source).toContain('className="empty-thread-spinner"');
    expect(source).toContain("chatLoading");
    expect(source).toContain("setChatLoading(true)");
  });

  it("keeps connection recovery quiet until bounded retries are exhausted", () => {
    expect(source).toContain("MAX_AUTOMATIC_RUNTIME_RETRIES");
    expect(source).toContain("setRuntimeRetryExhausted(true)");
    expect(source).toContain('className="chrome-icon-button desktop-connection-action desktop-connection-retry-button"');
    expect(source).toContain('aria-label="Retry connection"');
    expect(source).not.toContain("<DesktopConnectionStatus state={connectionState}");
  });

  it("exposes language selection in the native Settings window", () => {
    expect(source).toContain("function AuxiliaryLanguageSettings()");
    expect(source).toContain('settingsStoreRef.current.setApp("language", next)');
    expect(source).toContain('className="desktop-auxiliary-language"');
    expect(source).toContain('listen("hatch://language-preference"');
    expect(source).toContain("setLanguagePreference(normalizeLanguagePreference(next))");
  });

  it("keeps the login and startup surfaces draggable under the overlay title bar", () => {
    expect(source).toContain("function WelcomeTitlebarDragRegion()");
    expect(source).toContain('className="welcome-titlebar-drag-region" data-tauri-drag-region');
  });
});
