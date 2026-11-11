import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Camera, Image, Paperclip, Plus } from "lucide-react";

const TOUCH = "(pointer: coarse)";
const touchQuery = () => typeof window.matchMedia === "function" ? window.matchMedia(TOUCH) : null;
const subscribe = notify => { const query = touchQuery(); query?.addEventListener("change", notify); return () => query?.removeEventListener("change", notify); };
const isTouch = () => Boolean(touchQuery()?.matches);

/**
 * The attach control: + opens the file picker at once on a pointer device, and a small menu (camera, photos, file) on touch.
 * `accept` is what the host takes; the picker offers exactly that.
 */
export function AttachButton({ accept, disabled, onFiles, t }) {
  const touch = useSyncExternalStore(subscribe, isTouch, () => false);
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const inputs = { camera: useRef(null), photos: useRef(null), file: useRef(null) };
  const images = accept.split(",").some(type => type.trim() === "image/*");
  const documents = accept.split(",").some(type => !type.trim().startsWith("image/"));

  useEffect(() => {
    if (!open) return undefined;
    const close = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  const pick = event => { onFiles([...event.target.files]); event.target.value = ""; setOpen(false); };
  const input = (name, props) => <input ref={inputs[name]} type="file" hidden multiple={name !== "camera"} onChange={pick} {...props} />;

  if (!touch) return <label className="web-chat__attach" title={t("addImages")}><Plus aria-hidden="true" /><input type="file" accept={accept} multiple aria-label={t("addImages")} onChange={pick} disabled={disabled} /></label>;
  return <div className="web-chat__attach-menu" ref={root}>
    <button type="button" className="web-chat__attach" aria-label={t("addImages")} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(value => !value)}><Plus aria-hidden="true" /></button>
    {open ? <div className="web-chat__sheet" role="menu">
      {images ? <button type="button" role="menuitem" onClick={() => inputs.camera.current?.click()}><Camera aria-hidden="true" /><span>{t("attachCamera")}</span></button> : null}
      {images ? <button type="button" role="menuitem" onClick={() => inputs.photos.current?.click()}><Image aria-hidden="true" /><span>{t("attachPhotos")}</span></button> : null}
      {documents ? <button type="button" role="menuitem" onClick={() => inputs.file.current?.click()}><Paperclip aria-hidden="true" /><span>{t("attachFile")}</span></button> : null}
    </div> : null}
    {images ? input("camera", { accept: "image/*", capture: "environment" }) : null}
    {images ? input("photos", { accept: "image/*" }) : null}
    {documents ? input("file", { accept }) : null}
  </div>;
}
