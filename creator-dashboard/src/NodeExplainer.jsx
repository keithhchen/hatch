import React from "react";
import { Dialog, DialogContent } from "@hatch/ui";
import { Play } from "lucide-react";
import { explainerFor } from "./nodeExplainers.js";

const MEDIA_BASE = import.meta.env?.VITE_HATCH_WEB_MEDIA_BASE_URL || undefined;

/** tips card (poster + label) and modal player and modal player for one node; renders nothing for a node without a video. */
export function NodeExplainer({ node, locale }) {
  const [open, setOpen] = React.useState(false);
  const video = explainerFor(node, locale, MEDIA_BASE);
  if (!video) return null;
  return <>
    <button type="button" className="node-explainer-card" onClick={() => setOpen(true)}>
      <span className="node-explainer-card__poster" style={video.poster ? { backgroundImage: `url(${video.poster})` } : undefined}><Play aria-hidden="true" /></span>
      <span className="node-explainer-card__label">{video.label}</span>
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title={video.label} className="node-explainer" aria-describedby={undefined}>
        <video key={video.src} className="node-explainer__video" src={video.src} poster={video.poster} controls playsInline preload="none" />
      </DialogContent>
    </Dialog>
  </>;
}
