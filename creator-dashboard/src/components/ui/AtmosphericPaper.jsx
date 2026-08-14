import React from "react";
import { cn } from "./utils.js";

export function AtmosphericPaper({ children, className, ...props }) {
  return <div className={cn("hui-atmospheric-paper", className)} {...props}><span className="hui-atmospheric-paper__grain" aria-hidden="true" />{children}</div>;
}
