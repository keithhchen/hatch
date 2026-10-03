import React, { useState } from "react";
import { Dialog, DialogContent } from "@hatch/ui";
import { X } from "lucide-react";

export function WebChatImageViewer({ src, alt, title, closeLabel, viewLabel, children }) {
  const [open, setOpen] = useState(false);

  return <>
    <button type="button" className="web-chat__image-trigger" aria-label={viewLabel} onClick={() => setOpen(true)}>
      {children}
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title={title} hideClose className="web-chat-image-viewer">
        <button type="button" className="web-chat-image-viewer__close" aria-label={closeLabel} onClick={() => setOpen(false)}>
          <X aria-hidden="true" />
        </button>
        <img src={src} alt={alt} />
      </DialogContent>
    </Dialog>
  </>;
}
