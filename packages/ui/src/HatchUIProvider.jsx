import React, { useEffect } from "react";
import { AtmosphericPaper } from "./AtmosphericPaper.jsx";
import { ToastViewport } from "./Feedback.jsx";
import { TooltipProvider } from "./Overlays.jsx";
import { cn } from "./utils.js";

export function HatchUIProvider({
  children,
  theme = "origin",
  atmosphere = false,
  toasts = false,
  className,
  toastProps
}) {
  const themeClass = theme === "material" ? "hui-theme-material" : "hui-theme-origin";

  useEffect(() => {
    document.body.classList.add(themeClass);
    return () => document.body.classList.remove(themeClass);
  }, [themeClass]);

  const content = <>{children}{toasts ? <ToastViewport {...toastProps} /> : null}</>;
  return (
    <TooltipProvider>
      {atmosphere
        ? <AtmosphericPaper className={cn(themeClass, className)}>{content}</AtmosphericPaper>
        : content}
    </TooltipProvider>
  );
}
