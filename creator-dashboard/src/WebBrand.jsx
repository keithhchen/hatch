import React from "react";

const LOCKUP = "/assets/web/hatch-lockup.svg";

/**
 * Web logo: the combined egg + wordmark lockup. Same props as @hatch/ui
 * HatchBrand (as, className, children) so Web surfaces swap in place;
 * Desktop keeps HatchBrand and its own mark.
 */
export function WebBrand({ as: Element = "span", className = "", logoVariant: _logoVariant, children, ...props }) {
  return (
    <Element className={["hatch-brand", className].filter(Boolean).join(" ")} {...props}>
      <img className="hatch-brand__lockup" src={LOCKUP} alt="" aria-hidden="true" />
      <span className="hui-visually-hidden">Hatch.</span>
      {children}
    </Element>
  );
}
