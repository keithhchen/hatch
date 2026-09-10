import React from "react";
import hatchMarkUrl from "../../brand/hatch-mark.svg";
import hatchWordmarkUrl from "../../brand/hatch-wordmark.svg";
import hatchWordmarkInverseUrl from "../../brand/hatch-wordmark-inverse.svg";

export { hatchMarkUrl, hatchWordmarkUrl, hatchWordmarkInverseUrl };

/**
 * The product mark is shared by the public storefront and Creator Studio.
 * Keep the approved mark and outlined wordmark together. Both are shared
 * assets so Web and Desktop render the same logo without relying on fonts.
 */
export function HatchBrand({ as: Element = "span", className = "", children, ...props }) {
  const classes = ["hatch-brand", className].filter(Boolean).join(" ");
  return (
    <Element className={classes} {...props}>
      <img className="hatch-brand__mark" src={hatchMarkUrl} alt="" aria-hidden="true" />
      <span className="hatch-brand__wordmark" aria-hidden="true">
        <img className="hatch-brand__wordmark-image hatch-brand__wordmark-image--default" src={hatchWordmarkUrl} alt="" />
        <img className="hatch-brand__wordmark-image hatch-brand__wordmark-image--inverse" src={hatchWordmarkInverseUrl} alt="" />
      </span>
      <span className="hui-visually-hidden">Hatch.</span>
      {children}
    </Element>
  );
}
