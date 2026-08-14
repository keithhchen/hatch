import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./main.jsx", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

describe("desktop component presentation contract", () => {
  it("consumes shared components, fonts, and theme without a second brand source", () => {
    expect(packageJson.dependencies["@hatch/ui"]).toBe("file:../packages/ui");
    expect(Object.keys(packageJson.dependencies)).not.toContain("@fontsource/dm-mono");
    expect(Object.keys(packageJson.dependencies).some((dependency) => dependency.startsWith("@fontsource"))).toBe(false);
    expect(source).toContain('import "@hatch/ui/fonts"');
    expect(source).toContain('import "@hatch/ui/theme.css"');
    expect(source).toContain("HatchUIProvider");
    expect(source).not.toMatch(/@fontsource|packages\/brand/);
  });

  it("uses the shared icon library instead of character carets", () => {
    expect(source).toContain('from "lucide-react"');
    expect(source).not.toMatch(/[⌄›]/);
    expect(source).toContain('<ChevronDown className="composer-control-caret"');
    expect(source).toContain('className="desktop-agent-disclosure"');
  });

  it("keeps every composer action permanently mounted", () => {
    expect(source).toContain('className="composer-control attachment-composer-control"');
    expect(source).toContain('className="composer-control workspace-composer-control"');
    expect(source).toContain('className="permission-composer-control"');
    expect(source).toMatch(/className="permission-composer-control"[\s\S]*?<Select/);
    expect(source).not.toContain('className="composer-overflow"');
    expect(source).not.toContain("More composer options");
  });

  it("keeps real send and stop actions accessible while presenting icons", () => {
    expect(source).toMatch(/aria-label="Send message"[\s\S]*?<ArrowUp aria-hidden="true"/);
    expect(source).toMatch(/aria-label="Stop response"[\s\S]*?onClick=\{\(\) => void cancelRun\(\)\}[\s\S]*?<Square/);
    expect(source).not.toMatch(/>\s*Send\s*</);
    expect(source).not.toMatch(/>\s*Stop\s*</);
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
  });

  it("keeps the login and startup surfaces draggable under the overlay title bar", () => {
    expect(source).toContain("function WelcomeTitlebarDragRegion()");
    expect(source).toContain('className="welcome-titlebar-drag-region" data-tauri-drag-region');
  });
});
