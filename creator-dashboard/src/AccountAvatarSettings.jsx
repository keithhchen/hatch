import React, { useEffect, useRef, useState } from "react";
import { Avatar, Button, Dialog, DialogContent } from "@hatch/ui";
import Cropper from "react-easy-crop";
import { dashboardRequest } from "./data.js";
import "./accountAvatarSettings.css";
import "react-easy-crop/react-easy-crop.css";

export class BrowserAvatarCropper {
  async crop(sourceUrl, area) {
    const image = await loadImage(sourceUrl);
    const size = Math.round(Math.min(area.width, area.height));
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("avatar_crop_canvas_unavailable");
    context.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, size, size);
    const blob = await canvasToJpeg(canvas);
    return new File([blob], "avatar.jpg", { type: "image/jpeg" });
  }
}

const avatarCropper = new BrowserAvatarCropper();

export function AccountAvatarSettings({ user, onUserUpdated, t, cropper = avatarCropper }) {
  const inputRef = useRef(null);
  const cropUrlRef = useRef(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [cropSourceUrl, setCropSourceUrl] = useState(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedArea, setCroppedArea] = useState(null);

  useEffect(() => () => {
    if (cropUrlRef.current) URL.revokeObjectURL(cropUrlRef.current);
  }, []);

  function selectImage(event) {
    const image = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!image) return;
    if (cropUrlRef.current) URL.revokeObjectURL(cropUrlRef.current);
    const imageUrl = URL.createObjectURL(image);
    cropUrlRef.current = imageUrl;
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setCroppedArea(null);
    setError("");
    setCropSourceUrl(imageUrl);
  }

  function closeCropper() {
    if (status === "pending") return;
    if (cropUrlRef.current) URL.revokeObjectURL(cropUrlRef.current);
    cropUrlRef.current = null;
    setCropSourceUrl(null);
    setCroppedArea(null);
  }

  async function saveCrop() {
    if (!cropSourceUrl || !croppedArea || status === "pending") return;
    setStatus("pending");
    setError("");
    try {
      const image = await cropper.crop(cropSourceUrl, croppedArea);
      const profile = await dashboardRequest("/v1/auth/me/avatar", {
        method: "PUT",
        body: image,
        headers: { "content-type": image.type }
      });
      onUserUpdated(profile);
      setStatus("saved");
      if (cropUrlRef.current) URL.revokeObjectURL(cropUrlRef.current);
      cropUrlRef.current = null;
      setCropSourceUrl(null);
      setCroppedArea(null);
    } catch (cause) {
      setStatus("idle");
      setError(cause.message);
    }
  }

  async function remove() {
    if (!user?.avatar_url || status === "pending") return;
    setStatus("pending");
    setError("");
    try {
      const profile = await dashboardRequest("/v1/auth/me/avatar", { method: "DELETE" });
      onUserUpdated(profile);
      setStatus("removed");
    } catch (cause) {
      setStatus("idle");
      setError(cause.message);
    }
  }

  return <section className="account-avatar-settings" aria-label={t("Profile photo")}>
    <Avatar className="account-avatar-settings__image" src={user?.avatar_url} name={user?.display_name} size="large" />
    <div className="account-avatar-settings__content">
      <h3>{t("Profile photo")}</h3>
      <p>{t("Your photo appears beside your account and Agent identity.")}</p>
      <div className="account-avatar-settings__actions">
        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" aria-label={t("Choose a profile photo")} onChange={selectImage} />
        <Button type="button" variant="secondary" loading={status === "pending"} disabled={status === "pending"} onClick={() => inputRef.current?.click()}>{t("Upload photo")}</Button>
        {user?.avatar_url ? <Button type="button" variant="ghost" disabled={status === "pending"} onClick={() => void remove()}>{t("Remove photo")}</Button> : null}
      </div>
      {status === "saved" ? <p className="account-avatar-settings__status" role="status">{t("Profile photo updated.")}</p> : null}
      {status === "removed" ? <p className="account-avatar-settings__status" role="status">{t("Profile photo removed.")}</p> : null}
      {error ? <p className="account-avatar-settings__error" role="alert">{error}</p> : null}
    </div>
    <Dialog open={Boolean(cropSourceUrl)} onOpenChange={(open) => { if (!open) closeCropper(); }}>
      {cropSourceUrl ? <DialogContent
        className="account-avatar-crop-dialog"
        title={t("Crop your photo")}
        description={t("Move and zoom the image to choose a square crop.")}
        hideClose={status === "pending"}
        onEscapeKeyDown={(event) => { if (status === "pending") event.preventDefault(); }}
        onInteractOutside={(event) => { if (status === "pending") event.preventDefault(); }}
        footer={<>
          <Button type="button" variant="secondary" disabled={status === "pending"} onClick={closeCropper}>{t("Cancel")}</Button>
          <Button type="button" loading={status === "pending"} disabled={!croppedArea} onClick={() => void saveCrop()}>{status === "pending" ? t("Uploading…") : t("Crop and upload")}</Button>
        </>}
      >
        <div className="account-avatar-crop__viewport">
          <Cropper
            image={cropSourceUrl}
            crop={crop}
            zoom={zoom}
            aspect={1}
            cropShape="rect"
            showGrid
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={(_, pixels) => setCroppedArea(pixels)}
            onMediaError={() => setError(t("This image could not be opened."))}
          />
        </div>
        <label className="account-avatar-crop__zoom">
          <span>{t("Zoom")}</span>
          <input type="range" min="1" max="3" step="0.01" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} aria-label={t("Zoom")} />
        </label>
        {error ? <p className="account-avatar-settings__error" role="alert">{error}</p> : null}
      </DialogContent> : null}
    </Dialog>
  </section>;
}

function loadImage(sourceUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("avatar_crop_image_decode_failed"));
    image.src = sourceUrl;
  });
}

function canvasToJpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("avatar_crop_encoding_failed"));
        return;
      }
      resolve(blob);
    }, "image/jpeg", 0.92);
  });
}
