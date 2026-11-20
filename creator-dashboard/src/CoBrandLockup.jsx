import React from "react";

/** MSC is another company's brand: its logo is read from the public OSS copy, never committed. */
export const MSC_LOGO = "https://hatch-downloads.oss-cn-shanghai.aliyuncs.com/brand/msc/msc-logo-black.png";

/**
 * MSC × Hatch (light): the two logos with a hairline between them. Sized by --cobrand-cap (the cap height both share), so it scales crisply;
 * MSC is drawn smaller than Hatch so the two carry equal weight, centred on one line.
 */
export default function CoBrandLockup({ cap = 18, className = "" }) {
  return <span className={`cobrand ${className}`.trim()} style={{ "--cobrand-cap": `${cap}px` }} role="img" aria-label="MSC × Hatch">
    <img className="cobrand__msc" src={MSC_LOGO} alt="" draggable="false" />
    <i className="cobrand__rule" aria-hidden />
    <img className="cobrand__hatch" src={"/assets/web/hatch-lockup.svg"} alt="" draggable="false" />
  </span>;
}
