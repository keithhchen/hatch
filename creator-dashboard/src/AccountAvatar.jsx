import React from "react";
import { Avatar } from "@hatch/ui";
import "./accountAvatar.css";

export function AccountAvatar({ src, name, size = "medium", className = "" }) {
  const fallback = String(name ?? "H").trim().charAt(0).toLocaleUpperCase() || "H";
  return <Avatar className={`hatch-account-avatar ${className}`.trim()} src={src} name={name} fallback={fallback} size={size} />;
}
