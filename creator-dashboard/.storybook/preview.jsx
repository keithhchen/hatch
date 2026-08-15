import React, { useEffect } from "react";
import "@hatch/ui/fonts";
import "@hatch/ui/theme.css";
import { AtmosphericPaper, ToastViewport, TooltipProvider } from "@hatch/ui";

function HatchThemeFrame({ theme, canvas, children }) {
  const themeClass = theme === "origin" ? "hui-theme-origin" : "hui-theme-material";
  const canvasClass = canvas === "neutral" ? "hui-canvas-neutral" : "";
  useEffect(() => {
    document.body.classList.add(themeClass);
    return () => document.body.classList.remove(themeClass);
  }, [themeClass]);
  return <AtmosphericPaper className={`hui-story-canvas ${themeClass} ${canvasClass}`}>{children}</AtmosphericPaper>;
}

const preview = {
  parameters: {
    controls: { expanded: true },
    layout: "fullscreen",
    a11y: { test: "todo" },
    backgrounds: { disable: true }
  },
  decorators: [
    (Story, context) => (
      <TooltipProvider>
        <HatchThemeFrame theme={context.parameters.hatchTheme} canvas={context.parameters.hatchCanvas}>
          <Story />
          <ToastViewport />
        </HatchThemeFrame>
      </TooltipProvider>
    )
  ]
};

export default preview;
