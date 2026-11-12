import React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

// Kept out of Overlays.jsx: HatchUIProvider needs TooltipProvider on every page, and a shared module would drag Select, Menu, cmdk and vaul into the entry chunk.
export function TooltipProvider({ children, delayDuration = 380 }) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration}>{children}</TooltipPrimitive.Provider>;
}

export function Tooltip({ children, content, side = "top" }) {
  return <TooltipPrimitive.Root><TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger><TooltipPrimitive.Portal><TooltipPrimitive.Content className="hui-tooltip" side={side} sideOffset={7}>{content}<TooltipPrimitive.Arrow className="hui-tooltip__arrow" /></TooltipPrimitive.Content></TooltipPrimitive.Portal></TooltipPrimitive.Root>;
}
