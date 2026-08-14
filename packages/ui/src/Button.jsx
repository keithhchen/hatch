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
  const classes = cn("hui-button", `hui-button--${variant}`, `hui-button--${size}`, className);
  if (asChild) {
    const child = React.Children.only(children);
    const content = React.cloneElement(child, undefined,
      <>
        {loading ? <LoaderCircle className="hui-spin" aria-hidden="true" /> : leading}
        <span>{child.props.children}</span>
        {trailing}
      </>
    );
    return <Slot className={classes} aria-busy={Boolean(loading)} aria-disabled={disabled || loading || undefined} {...props}>{content}</Slot>;
  }
  return (
    <button
      className={classes}
      disabled={disabled || loading}
      aria-busy={Boolean(loading)}
      {...props}
    >
      {loading ? <LoaderCircle className="hui-spin" aria-hidden="true" /> : leading}
      <span>{children}</span>
      {trailing}
    </button>
  );
}
export function IconButton({ label, size = "medium", variant = "ghost", className, children, ...props }) {
  return (
    <Button className={cn("hui-icon-button", className)} size={size} variant={variant} aria-label={label} {...props}>
      {children}
    </Button>
  );
}
