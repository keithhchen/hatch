import React, { useEffect, useMemo, useState } from "react";
import { ArrowDown, RotateCcw } from "lucide-react";
import { HatchBrand } from "@hatch/ui";
import { DESKTOP_DOWNLOAD_BASE_URL, DESKTOP_DOWNLOAD_TARGETS, DESKTOP_DOWNLOAD_TARGET_ORDER, desktopDownloadUrl, detectDownloadTargetAsync } from "./downloadPresentation.js";
import { downloadCopy } from "./downloadI18n.js";
import { useLocale } from "./locale.jsx";
import { LanguageSwitcher } from "./LanguageSwitcher.jsx";
import "./downloadPage.css";

export function DownloadPage() {
  const { locale } = useLocale();
  const copy = downloadCopy(locale);
  const [detectedTarget, setDetectedTarget] = useState("unknown");
  const [detectionReady, setDetectionReady] = useState(false);

  useEffect(() => {
    let active = true;
    const previousTitle = document.title;
    document.title = copy.documentTitle;
    detectDownloadTargetAsync().then((target) => {
      if (!active) return;
      setDetectedTarget(target);
      setDetectionReady(true);
    }).catch(() => {
      if (active) setDetectionReady(true);
    });
    return () => { active = false; document.title = previousTitle; };
  }, [copy.documentTitle]);

  const targets = useMemo(() => DESKTOP_DOWNLOAD_TARGET_ORDER.map((key) => ({ ...DESKTOP_DOWNLOAD_TARGETS[key], url: desktopDownloadUrl(key) })), []);
  const hasDownloads = Boolean(DESKTOP_DOWNLOAD_BASE_URL) && targets.every((target) => target.url);

  return (
    <div className="download-page">
      <header className="download-page__header">
        <HatchBrand as="a" className="download-page__brand" href="/explore" aria-label={copy.homeLabel} />
        <LanguageSwitcher className="download-page__language" />
      </header>
      <main className="download-page__main">
        <h1>{copy.title}</h1>
        <p className="download-page__device" role="status">{deviceMessage(copy, detectedTarget, detectionReady)}</p>
        {!hasDownloads ? <UnavailableDownloadState copy={copy} /> : (
          <div className="download-page__list" aria-label={copy.downloadsLabel}>
            {orderedTargets(targets, detectedTarget).map((target) => (
              <DownloadRow key={target.key} target={target} copy={copy} recommended={target.key === detectedTarget} />
            ))}
            <div className="download-page__row download-page__row--disabled">
              <span>{copy.windows}</span><span className="download-page__availability">{copy.comingSoon}</span>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function orderedTargets(targets, detectedTarget) {
  if (!DESKTOP_DOWNLOAD_TARGETS[detectedTarget]) return targets;
  return [...targets].sort((target) => target.key === detectedTarget ? -1 : 1);
}

function deviceMessage(copy, detectedTarget, ready) {
  if (!ready) return copy.detecting;
  if (detectedTarget === "macos-apple-silicon") return copy.recommended(copy.appleSilicon);
  if (detectedTarget === "macos-intel") return copy.recommended(copy.intel);
  if (detectedTarget === "unsupported") return copy.windowsNotice;
  return copy.chooseMac;
}

function DownloadRow({ target, copy, recommended }) {
  const architecture = target.key === "macos-apple-silicon" ? copy.appleSilicon : copy.intel;
  return (
    <a className={`download-page__row${recommended ? " is-recommended" : ""}`} href={target.url}>
      <span>{copy.mac(architecture)}{recommended ? <small>{copy.recommendedLabel}</small> : null}</span>
      <ArrowDown aria-hidden="true" />
    </a>
  );
}

function UnavailableDownloadState({ copy }) {
  return (
    <div className="download-page__unavailable" role="status">
      <span>{copy.unavailable}</span>
      <button type="button" onClick={() => window.location.reload()}><RotateCcw aria-hidden="true" /> {copy.tryAgain}</button>
    </div>
  );
}
