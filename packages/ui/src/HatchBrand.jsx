import React from "react";
import hatchMarkUrl from "../../brand/hatch-mark.svg";
import hatchLogoLockupUrl from "../../brand/hatch-logo-lockup.svg";
import hatchWordmarkUrl from "../../brand/hatch-wordmark.svg";

export { hatchMarkUrl, hatchLogoLockupUrl, hatchWordmarkUrl };

/**
 * The product mark is shared by the public storefront and Creator Studio.
 * Render either the complete approved lockup or its separate responsive parts.
 */
export function HatchBrand({ as: Element = "span", className = "", logoVariant = "split", children, ...props }) {
  if (logoVariant !== "split" && logoVariant !== "lockup") throw new Error(`Unknown Hatch logo variant: ${logoVariant}`);
  const classes = ["hatch-brand", className].filter(Boolean).join(" ");
  return (
    <Element className={classes} {...props}>
      {logoVariant === "lockup" ? (
        <img className="hatch-brand__lockup" src={hatchLogoLockupUrl} alt="" aria-hidden="true" />
      ) : (
        <>
          <img className="hatch-brand__mark" src={hatchMarkUrl} alt="" aria-hidden="true" />
          <span className="hatch-brand__wordmark" aria-hidden="true">
            <img className="hatch-brand__wordmark-image" src={hatchWordmarkUrl} alt="" />
          </span>
        </>
      )}
      <span className="hui-visually-hidden">Hatch.</span>
      {children}
    </Element>
  );
}
