import React from "react";
import hatchMarkUrl from "../../brand/hatch-mark.svg";

export { hatchMarkUrl };

/**
 * The product mark is shared by the public storefront and Creator Studio.
 * Keep the mark as the approved SVG asset; the orange period is part of the
 * Hatch wordmark and must not be replaced by a placeholder glyph.
 */
export function HatchBrand({ as: Element = "span", className = "", children, ...props }) {
  const classes = ["hatch-brand", className].filter(Boolean).join(" ");
  return (
    <Element className={classes} {...props}>
      <img className="hatch-brand__mark" src={hatchMarkUrl} alt="" aria-hidden="true" />
      <span className="hatch-brand__wordmark">Hatch<span className="hatch-brand__period" aria-hidden="true">.</span></span>
      {children}
    </Element>
  );
}
