import React, { useState } from "react";
import { AtmosphericPaper } from "./AtmosphericPaper.jsx";
import { Button } from "./Button.jsx";
import { StatusTag } from "./Feedback.jsx";
import { Input } from "./Forms.jsx";
import { HatchBrand } from "./HatchBrand.jsx";
import { Select } from "./Overlays.jsx";

export default {
  title: "Hatch/Design System GUI",
  parameters: { layout: "fullscreen", hatchTheme: "origin", hatchCanvas: "neutral" },
  tags: ["autodocs"]
};

const statusOptions = [
  { value: "neutral", label: "Draft" },
  { value: "progress", label: "In progress" },
  { value: "success", label: "Published" },
  { value: "warning", label: "Needs attention" },
  { value: "error", label: "Failed" }
];

function ThemeLabCanvas(args) {
  const [status, setStatus] = useState("progress");
  const paused = args.motion === "paused";
  const durationScale = args.motion === "slow" ? 1.8 : 1;
  const style = {
    "--hatch-ui-primary": args.primaryColor,
    "--hatch-atmosphere-base": args.canvasColor,
    "--hatch-atmosphere-strength": args.atmosphereStrength,
    "--hatch-radius-control": `${args.radius}px`,
    "--hatch-radius-menu": `${args.radius + 3}px`,
    "--hatch-radius-dialog": `${args.radius + 10}px`,
    "--hatch-radius-surface": `${args.radius + 10}px`,
    "--hatch-display-tracking": `${args.displayTracking}em`,
    "--hatch-display-leading": args.displayLeading,
    "--hatch-atmosphere-warm-duration": `${30 * durationScale}s`,
    "--hatch-atmosphere-cool-duration": `${36 * durationScale}s`
  };
  return (
    <AtmosphericPaper className={`hui-token-lab hui-theme-origin${paused ? " is-motion-paused" : ""}`} style={style}>
      <section className="hui-token-lab__panel">
        <header><HatchBrand /><StatusTag tone={status}>{statusOptions.find((option) => option.value === status)?.label}</StatusTag></header>
        <div>
          <span className="hui-semantic-label">LIVE COMPONENT TOKENS</span>
          <h1>Change the system, not the screenshot.</h1>
          <p>Controls update the same CSS variables consumed by Web, Desktop, and Storybook.</p>
        </div>
        <div className="hui-story-row">
          <Button
            variant={args.buttonVariant}
            size={args.buttonSize}
            loading={args.buttonState === "loading"}
            disabled={args.buttonState === "disabled"}
          >
            {args.buttonLabel}
          </Button>
          <Button variant="secondary" size={args.buttonSize}>Buyer view</Button>
        </div>
        <div className="hui-token-lab__controls">
          <Input aria-label="Product name" defaultValue="A field guide to creative recovery" />
          <Select value={status} onValueChange={setStatus} options={statusOptions} label="Status preview" />
        </div>
      </section>
    </AtmosphericPaper>
  );
}

export const ThemeLab = {
  args: {
    buttonLabel: "New release",
    buttonVariant: "primary",
    buttonSize: "medium",
    buttonState: "enabled",
    primaryColor: "#25221f",
    canvasColor: "#f3efe8",
    radius: 12,
    displayTracking: -0.06,
    displayLeading: 0.86,
    atmosphereStrength: 0.72,
    motion: "normal"
  },
  argTypes: {
    buttonLabel: { control: "text" },
    buttonVariant: { control: "select", options: ["primary", "secondary", "ghost", "danger"] },
    buttonSize: { control: "inline-radio", options: ["small", "medium", "large"] },
    buttonState: { control: "inline-radio", options: ["enabled", "loading", "disabled"] },
    primaryColor: { control: "color" },
    canvasColor: { control: "color" },
    radius: { control: { type: "range", min: 6, max: 24, step: 1 } },
    displayTracking: { control: { type: "range", min: -0.08, max: 0, step: 0.005 } },
    displayLeading: { control: { type: "range", min: 0.78, max: 1.08, step: 0.01 } },
    atmosphereStrength: { control: { type: "range", min: 0, max: 1, step: 0.05 } },
    motion: { control: "inline-radio", options: ["normal", "slow", "paused"] }
  },
  render: (args) => <ThemeLabCanvas {...args} />
};
