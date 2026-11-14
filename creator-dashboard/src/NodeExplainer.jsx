import React from "react";
import { Dialog, DialogContent, Button } from "@hatch/ui";
import { Play } from "lucide-react";
import { explainerFor } from "./nodeExplainers.js";

const MEDIA_BASE = import.meta.env?.VITE_HATCH_WEB_MEDIA_BASE_URL || undefined;

/** "Watch explainer" entry and modal player for one node; renders nothing for a node without a video. */
export function NodeExplainer({ node, locale, t }) {
  const [open, setOpen] = React.useState(false);
  const video = explainerFor(node, locale, MEDIA_BASE);
  if (!video) return null;
  return <>
    <Button type="button" size="small" variant="secondary" leading={<Play aria-hidden="true" />} onClick={() => setOpen(true)}>{t("explainerWatch")}</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title={t("explainerWatch")} className="node-explainer" aria-describedby={undefined}>
        <video key={video.src} className="node-explainer__video" src={video.src} poster={video.poster} controls playsInline preload="none" />
      </DialogContent>
    </Dialog>
  </>;
}
