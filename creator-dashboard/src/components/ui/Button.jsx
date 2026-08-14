import React from "react";
import { Slot } from "@radix-ui/react-slot";
import { LoaderCircle } from "lucide-react";
import { cn } from "./utils.js";

export function Button({
  asChild = false,
  variant = "primary",
  size = "medium",
  loading = false,
  leading,
  trailing,
  className,
  children,
  disabled,
  ...props
}) {
  const Component = asChild ? Slot : "button";
  return (
    <Component
      className={cn("hui-button", `hui-button--${variant}`, `hui-button--${size}`, className)}
      disabled={asChild ? undefined : disabled || loading}
      aria-busy={Boolean(loading)}
      {...props}
    >
      {loading ? <LoaderCircle className="hui-spin" aria-hidden="true" /> : leading}
      <span>{children}</span>
      {trailing}
    </Component>
  );
}
export function IconButton({ label, size = "medium", variant = "ghost", className, children, ...props }) {
  return (
    <Button className={cn("hui-icon-button", className)} size={size} variant={variant} aria-label={label} {...props}>
      {children}
    </Button>
  );
}
