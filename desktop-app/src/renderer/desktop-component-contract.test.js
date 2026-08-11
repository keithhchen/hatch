import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./main.jsx", import.meta.url), "utf8");

describe("desktop component presentation contract", () => {
  it("uses the shared icon library instead of character carets", () => {
    expect(source).toContain('from "lucide-react"');
    expect(source).not.toMatch(/[⌄›]/);
    expect(source).toContain('<ChevronDown className="composer-control-caret"');
    expect(source).toContain('className="desktop-agent-disclosure"');
  });

  it("keeps every composer action permanently mounted", () => {
    expect(source).toContain('className="composer-control attachment-composer-control"');
    expect(source).toContain('className="composer-control workspace-composer-control"');
    expect(source).toContain('className="composer-control permission-composer-control"');
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
    expect(source).not.toContain('className="desktop-connection-copy"');
    expect(source).not.toContain('className="settings-migration-notice"');
  });
});
