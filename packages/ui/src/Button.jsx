import React from "react";
import { Slot } from "@radix-ui/react-slot";
import { LoaderCircle } from "lucide-react";
import { ControlContent, controlClassName } from "./ControlAppearance.jsx";
import { cn } from "./utils.js";

export function Button({
  asChild = false,
  variant = "primary",
  size = "medium",
  loading = false,
  leading,
  trailing,
  surface,
  className,
  children,
  disabled,
  ref,
  ...props
}) {
  // A surfaced button participates in the shared Control appearance contract.
  // Do not also attach the semantic variant class: its primitive-specific
  // hover/active rules would otherwise fork the closed control surface from
  // Radix Select while both controls are meant to look identical.
  const variantClass = surface ? null : `hui-button--${variant}`;
  const classes = cn(
    "hui-button",
    variantClass,
    `hui-button--${size}`,
    surface ? controlClassName({ size, surface }) : size === "compact" && "hui-control--compact",
    className
  );
  if (asChild) {
    const child = React.Children.only(children);
    const content = React.cloneElement(child, undefined,
      surface
        ? <ControlContent leading={loading ? <LoaderCircle className="hui-spin" aria-hidden="true" /> : leading} trailing={trailing}>{child.props.children}</ControlContent>
        : <>
            {loading ? <LoaderCircle className="hui-spin" aria-hidden="true" /> : leading}
            <span>{child.props.children}</span>
            {trailing}
          </>
    );
    return <Slot ref={ref} className={classes} aria-busy={Boolean(loading)} aria-disabled={disabled || loading || undefined} {...props}>{content}</Slot>;
  }
  return (
    <button
      ref={ref}
      className={classes}
      disabled={disabled || loading}
      aria-busy={Boolean(loading)}
      {...props}
    >
      {surface
        ? <ControlContent leading={loading ? <LoaderCircle className="hui-spin" aria-hidden="true" /> : leading} trailing={trailing}>{children}</ControlContent>
        : <>
            {loading ? <LoaderCircle className="hui-spin" aria-hidden="true" /> : leading}
            <span>{children}</span>
            {trailing}
          </>}
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
