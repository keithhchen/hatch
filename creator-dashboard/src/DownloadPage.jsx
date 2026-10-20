import React, { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowRight, RotateCcw } from "lucide-react";
import { WebBrand } from "./WebBrand.jsx";
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
        <WebBrand className="download-page__brand" href="/explore" aria-label={copy.homeLabel} />
        <LanguageSwitcher className="download-page__language" />
      </header>
      <main className="download-page__main">
        <section className="download-page__copy">
          <span className="web-pill">{copy.pill}</span>
          <h1>{copy.title}</h1>
          <p className="download-page__lead">{copy.lead}</p>
          <div className="download-page__card web-card">
            {hasDownloads ? <p className="download-page__device" role="status">{deviceMessage(copy, detectedTarget, detectionReady)}</p> : null}
            {!hasDownloads ? <UnavailableDownloadState copy={copy} /> : (
              <div className="download-page__list" aria-label={copy.downloadsLabel}>
                {orderedTargets(targets, detectedTarget).map((target) => (
                  <DownloadRow key={target.key} target={target} copy={copy} recommended={target.key === detectedTarget} />
                ))}
              </div>
            )}
          </div>
          <a className="download-page__web" href="/library">
            <span><strong>{copy.webTitle}</strong><small>{copy.webBody}</small></span>
            <em>{copy.webAction}<ArrowRight aria-hidden="true" /></em>
          </a>
        </section>
        <figure className="download-page__visual">
          <img src="/assets/web/photos/trust.jpg" alt="" />
          <figcaption>{copy.caption}</figcaption>
        </figure>
      </main>
    </div>
  );
}

function orderedTargets(targets, detectedTarget) {
  if (!DESKTOP_DOWNLOAD_TARGETS[detectedTarget]) return targets;
  return [...targets].sort((left, right) =>
    Number(right.key === detectedTarget) - Number(left.key === detectedTarget)
  );
}

function deviceMessage(copy, detectedTarget, ready) {
  if (!ready) return copy.detecting;
  if (detectedTarget === "macos-apple-silicon") return copy.recommended(copy.appleSilicon);
  if (detectedTarget === "macos-intel") return copy.recommended(copy.intel);
  if (detectedTarget === "windows-x64") return copy.recommended(copy.windows);
  return copy.chooseDevice;
}

function DownloadRow({ target, copy, recommended }) {
  const label = target.platform === "windows"
    ? copy.windows
    : copy.mac(target.key === "macos-apple-silicon" ? copy.appleSilicon : copy.intel);
  return (
    <a className={`download-page__row${recommended ? " is-recommended" : ""}`} href={target.url}>
      <span>{label}{recommended ? <small>{copy.recommendedLabel}</small> : null}</span>
      <ArrowDown aria-hidden="true" />
    </a>
  );
}

function UnavailableDownloadState({ copy }) {
  return (
    <div className="download-page__unavailable" role="status">
      <div>
        <strong>{copy.unavailable}</strong>
        <p>{copy.unavailableBody}</p>
      </div>
      <button type="button" onClick={() => window.location.reload()}><RotateCcw aria-hidden="true" /> {copy.tryAgain}</button>
    </div>
  );
}
