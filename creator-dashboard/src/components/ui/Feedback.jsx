import React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { AlertCircle, CheckCircle2, CircleSlash2, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import { Toaster, toast } from "sonner";
import { Button } from "./Button.jsx";
import { cn } from "./utils.js";

export function StatusTag({ tone = "neutral", children, dot = false, className }) {
  return <span className={cn("hui-status", `is-${tone}`, className)}>{dot ? <span aria-hidden="true" /> : null}{children}</span>;
}

export const Badge = StatusTag;

const alertIcons = { info: Info, success: CheckCircle2, warning: TriangleAlert, error: AlertCircle };

export function InlineAlert({ tone = "info", title, children, action, className }) {
  const Icon = alertIcons[tone] || Info;
  return <div className={cn("hui-alert", `is-${tone}`, className)} role={tone === "error" ? "alert" : "status"}><Icon aria-hidden="true" /><div>{title ? <strong>{title}</strong> : null}{children ? <p>{children}</p> : null}</div>{action}</div>;
}

export function ToastViewport(props) {
  return <Toaster className="hui-toaster" position="bottom-right" closeButton richColors={false} {...props} />;
}

export { toast };

export function Spinner({ label = "Loading", size = "medium", className }) {
  return <span className={cn("hui-spinner", `is-${size}`, className)} role="status"><LoaderCircle className="hui-spin" aria-hidden="true" /><span className="hui-visually-hidden">{label}</span></span>;
}

export function Skeleton({ className, lines = 1 }) {
  return <div className={cn("hui-skeleton-stack", className)} aria-hidden="true">{Array.from({ length: lines }, (_, index) => <span className="hui-skeleton" key={index} />)}</div>;
}

export function Progress({ value, label, className }) {
  const boundedValue = Math.max(0, Math.min(100, value || 0));
  return <div className={cn("hui-progress-group", className)}>{label ? <div><span>{label}</span><b>{Math.round(boundedValue)}%</b></div> : null}<ProgressPrimitive.Root className="hui-progress" value={boundedValue}><ProgressPrimitive.Indicator style={{ transform: `translateX(-${100 - boundedValue}%)` }} /></ProgressPrimitive.Root></div>;
}

const stateIcons = { empty: CircleSlash2, error: AlertCircle, unavailable: TriangleAlert };

export function StateMessage({ state = "empty", title, body, action, className }) {
  const Icon = stateIcons[state] || CircleSlash2;
  return <section className={cn("hui-state", `is-${state}`, className)} role={state === "error" ? "alert" : "status"}><Icon aria-hidden="true" /><h2>{title}</h2>{body ? <p>{body}</p> : null}{action ? <Button variant={state === "error" ? "secondary" : "primary"} onClick={action.onClick}>{action.label}</Button> : null}</section>;
}

export const EmptyState = (props) => <StateMessage state="empty" {...props} />;
export const ErrorState = (props) => <StateMessage state="error" {...props} />;
export const UnavailableState = (props) => <StateMessage state="unavailable" {...props} />;
