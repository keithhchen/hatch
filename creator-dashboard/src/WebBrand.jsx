import React from "react";

const LOCKUP = "/assets/web/hatch-lockup.svg";

/**
 * The Web logo: the combined egg + wordmark lockup SVG, optionally followed by
 * a surface label such as "Studio". Desktop keeps @hatch/ui HatchBrand.
 */
export function WebBrand({ as: Element = "a", label, className = "", ...props }) {
  return (
    <Element className={["web-brand", className].filter(Boolean).join(" ")} {...props}>
      <img src={LOCKUP} alt="Hatch" width={101} height={30} />
      {label ? <small>{label}</small> : null}
    </Element>
  );
}
