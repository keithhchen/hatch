import React from "react";
import { STUDIO_PATH } from "./studioPath.js";

/** The five-step path as plain cards, named rather than numbered; used on the empty home and the new Agent page. */
export function StudioPathCards({ t, compact = false }) {
  return <ol className={`cpv2-path-cards${compact ? " cpv2-path-cards--compact" : ""}`}>
    {STUDIO_PATH.map((step) => <li key={step.id} className="web-card">
      <div><h3>{t(step.title)}</h3><p>{t(step.body)}</p></div>
    </li>)}
  </ol>;
}
