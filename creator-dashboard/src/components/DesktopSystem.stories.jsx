import React, { useState } from "react";
import { ArrowUp, Ellipsis, FolderOpen, PanelLeft, PanelRight, Paperclip, Plus, Settings, Square } from "lucide-react";
import {
  Button,
  DropdownMenu,
  FormField,
  HatchBrand,
  IconButton,
  InlineAlert,
  Input,
  Select,
  StatusTag,
  Textarea,
  Tooltip
} from "@hatch/ui";
import "./DesktopSystem.stories.css";

export default {
  title: "Hatch/Desktop visual system",
  parameters: { layout: "fullscreen", hatchTheme: "origin" },
  tags: ["autodocs"]
};

const agents = [
  { initials: "S", name: "Seth Database Alpha Lite", detail: "Seth" },
  { initials: "MM", name: "Interview Answer Rewriter", detail: "Madeline Mann" }
];

function DesktopStoryFrame({ args }) {
  const [permission, setPermission] = useState("workspace");
  const [running, setRunning] = useState(false);
  const style = {
    "--hatch-ui-primary": args.primaryColor,
    "--hatch-atmosphere-strength": args.atmosphereStrength,
    "--hatch-display-tracking": `${args.displayTracking}em`,
    "--hatch-display-leading": args.displayLeading,
    "--desktop-story-density": args.density === "compact" ? "8px" : args.density === "minimal" ? "5px" : "12px"
  };

  return (
    <div className="hui-desktop-story" data-layout={args.layout} style={style}>
      <div className="hui-desktop-story__window">
        <header className="hui-desktop-story__toolbar">
          <div className="hui-desktop-story__traffic" aria-hidden="true"><i /><i /><i /></div>
          <IconButton label="Toggle sidebar"><PanelLeft aria-hidden="true" /></IconButton>
          <div className="hui-desktop-story__context"><strong>Interview Answer Rewriter</strong><span>Madeline Mann</span></div>
          <div className="hui-desktop-story__toolbar-actions">
            <Tooltip content="Settings"><IconButton label="Settings"><Settings aria-hidden="true" /></IconButton></Tooltip>
            <IconButton label="Toggle inspector"><PanelRight aria-hidden="true" /></IconButton>
          </div>
        </header>

        <aside className="hui-desktop-story__sidebar" aria-label="Conversations">
          <HatchBrand />
          <span className="hui-desktop-story__label">YOUR AGENTS</span>
          <div className="hui-desktop-story__agent-list">
            {agents.map((agent, index) => <button className={`hui-desktop-story__agent ${index === 0 ? "is-active" : ""}`} type="button" key={agent.name}>
              <span className="hui-desktop-story__avatar">{agent.initials}</span>
              <span><strong>{agent.name}</strong><small>{agent.detail}</small></span>
              <span aria-hidden="true">›</span>
            </button>)}
          </div>
          <Button className="hui-desktop-story__new" variant="secondary" size="small"><Plus aria-hidden="true" /> New task</Button>
          <div className="hui-desktop-story__account"><span className="hui-desktop-story__avatar">K</span><strong>Keith</strong><IconButton label="Account settings" size="small"><Settings aria-hidden="true" /></IconButton></div>
        </aside>

        <main className="hui-desktop-story__main">
          <div className="hui-desktop-story__transcript">
            <div className="hui-desktop-story__activity"><StatusTag tone="success" dot>Worked for 13s</StatusTag><span>Used 3 tools</span></div>
            <h1>What should we improve?</h1>
            <p className="hui-desktop-story__lede">A calm working surface for evidence-led, creator-owned agents.</p>
            <ul className="hui-desktop-story__tool-list"><li><FolderOpen aria-hidden="true" /> Listed files <span>4 items</span></li><li><Paperclip aria-hidden="true" /> Read source material <span>3 items</span></li></ul>
            <InlineAlert tone="info" title="Source saved">The private draft is stored on the authenticated server.</InlineAlert>
          </div>
          <footer className="hui-desktop-story__composer">
            <Textarea aria-label="Message" placeholder="Send a message to Interview Answer Rewriter…" />
            <div className="hui-desktop-story__composer-actions">
              <Select value={permission} onValueChange={setPermission} options={[{ value: "workspace", label: "Documents" }, { value: "none", label: "No workspace" }]} label="Workspace" />
              <DropdownMenu trigger={<IconButton label="More composer actions"><Ellipsis aria-hidden="true" /></IconButton>} items={[{ label: "Attach files", icon: <Paperclip aria-hidden="true" /> }]} />
              <Button aria-label={running ? "Stop response" : "Send message"} onClick={() => setRunning((value) => !value)}>{running ? <Square aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}</Button>
            </div>
          </footer>
        </main>

        <aside className="hui-desktop-story__inspector" aria-label="Inspector">
          <span className="hui-desktop-story__label">WORKSPACE</span>
          <FormField label="Folder"><Input defaultValue="Documents" /></FormField>
          <span className="hui-desktop-story__label">PERMISSION</span>
          <StatusTag tone="success">Granted</StatusTag>
        </aside>
      </div>
    </div>
  );
}

export const Shell = {
  args: {
    layout: "regular",
    density: "regular",
    primaryColor: "#25221f",
    displayTracking: -0.06,
    displayLeading: 0.86,
    atmosphereStrength: 0.72
  },
  argTypes: {
    layout: { control: "inline-radio", options: ["regular", "compact", "minimal"] },
    density: { control: "inline-radio", options: ["regular", "compact", "minimal"] },
    primaryColor: { control: "color" },
    displayTracking: { control: { type: "range", min: -0.08, max: 0, step: 0.005 } },
    displayLeading: { control: { type: "range", min: 0.78, max: 1.08, step: 0.01 } },
    atmosphereStrength: { control: { type: "range", min: 0, max: 1, step: 0.05 } }
  },
  render: (args) => <DesktopStoryFrame args={args} />
};
