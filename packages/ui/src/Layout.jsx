import React from "react";
import { cn } from "./utils.js";

export function Surface({ as: Element = "section", level = "resting", className, children, ...props }) {
  return <Element className={cn("hui-surface", `is-${level}`, className)} {...props}>{children}</Element>;
}

export function SemanticLabel({ as: Element = "span", tone = "neutral", className, children, ...props }) {
  return <Element className={cn("hui-semantic-label", `is-${tone}`, className)} {...props}>{children}</Element>;
}

export function PageHeader({ label, title, body, actions, className, titleRef, ...props }) {
  return (
    <header className={cn("hui-page-header", className)} {...props}>
      <div className="hui-page-header__copy">
        {label ? <SemanticLabel>{label}</SemanticLabel> : null}
        <h1 ref={titleRef} tabIndex={titleRef ? -1 : undefined}>{title}</h1>
        {body ? <p>{body}</p> : null}
      </div>
      {actions ? <div className="hui-action-group">{actions}</div> : null}
    </header>
  );
}

export function SectionHeader({ label, title, body, actions, className, ...props }) {
  return (
    <header className={cn("hui-section-header", className)} {...props}>
      <div>
        {label ? <SemanticLabel>{label}</SemanticLabel> : null}
        <h2>{title}</h2>
        {body ? <p>{body}</p> : null}
      </div>
      {actions ? <div className="hui-action-group">{actions}</div> : null}
    </header>
  );
}

export function ActionGroup({ className, children, ...props }) {
  return <div className={cn("hui-action-group", className)} {...props}>{children}</div>;
}
