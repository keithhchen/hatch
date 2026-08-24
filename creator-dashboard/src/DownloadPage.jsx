import React, { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowRight, RotateCcw } from "lucide-react";
import { Button, HatchBrand, Surface } from "@hatch/ui";
import {
  DESKTOP_DOWNLOAD_BASE_URL,
  DESKTOP_DOWNLOAD_TARGETS,
  DESKTOP_DOWNLOAD_TARGET_ORDER,
  desktopDownloadUrl,
  detectDownloadTargetAsync
} from "./downloadPresentation.js";
import "./downloadPage.css";

export function DownloadPage() {
  const [detectedTarget, setDetectedTarget] = useState("unknown");
  const [detectionReady, setDetectionReady] = useState(false);

  useEffect(() => {
    let active = true;
    const previousTitle = document.title;
    document.title = "Download Hatch Desktop · Hatch";
    detectDownloadTargetAsync().then((target) => {
      if (!active) return;
      setDetectedTarget(target);
      setDetectionReady(true);
    }).catch(() => {
      if (!active) return;
      setDetectionReady(true);
    });
    return () => {
      active = false;
      document.title = previousTitle;
    };
  }, []);

  const targets = useMemo(() => DESKTOP_DOWNLOAD_TARGET_ORDER.map((key) => ({
    ...DESKTOP_DOWNLOAD_TARGETS[key],
    url: desktopDownloadUrl(key)
  })), []);
  const recommendedTarget = targets.find((target) => target.key === detectedTarget) ?? null;
  const hasConfiguredDownloads = Boolean(DESKTOP_DOWNLOAD_BASE_URL) && targets.every((target) => target.url);

  return (
    <div className="download-page">
      <header className="download-page__header">
        <HatchBrand as="a" className="download-page__brand" href="/explore" aria-label="Hatch home" />
        <a className="download-page__back-link" href="/explore">Back to Hatch <ArrowRight aria-hidden="true" /></a>
      </header>

      <main className="download-page__main">
        <section className="download-page__intro" aria-labelledby="download-page-title">
          <span className="download-page__eyebrow">Desktop preview</span>
          <h1 id="download-page-title">Hatch, on your desktop.</h1>
          <p>A calm place for the work that needs your files. Preview builds for Mac.</p>
        </section>

        {!hasConfiguredDownloads ? <UnavailableDownloadState /> : (
          <>
            <section className="download-page__recommended" aria-labelledby="download-recommended-title">
              <div className="download-page__recommended-topline">
                <span className="download-page__status-dot" aria-hidden="true" />
                <span>{detectionReady && recommendedTarget ? "Recommended for your device" : "Mac downloads"}</span>
              </div>
              <div className="download-page__recommended-content">
                <div>
                  <h2 id="download-recommended-title">Hatch for Mac</h2>
                  <p>{recommendedTarget ? `${recommendedTarget.label} is ready for this device.` : "Choose the Mac build that matches your computer below."}</p>
                </div>
                {recommendedTarget ? (
                  <Button asChild size="large" trailing={<ArrowDown aria-hidden="true" />}>
                    <a href={recommendedTarget.url}>{recommendedTarget.primaryLabel}</a>
                  </Button>
                ) : null}
              </div>
            </section>

            <section className="download-page__other-versions" aria-labelledby="download-other-title">
              <div className="download-page__section-heading">
                <h2 id="download-other-title">Mac builds</h2>
                <span>Download directly</span>
              </div>
              <div className="download-page__platform-grid">
                {targets.map((target) => <MacDownloadCard key={target.key} target={target} recommended={target.key === detectedTarget} />)}
              </div>
            </section>
          </>
        )}

        <WindowsComingSoon />

        <footer className="download-page__footer">
          <span>Hatch Desktop</span>
          {hasConfiguredDownloads ? <a href="/explore">Learn about Hatch <ArrowRight aria-hidden="true" /></a> : null}
        </footer>
      </main>
    </div>
  );
}

function MacDownloadCard({ target, recommended }) {
  return (
    <article className={`download-page__platform-card${recommended ? " is-recommended" : ""}`}>
      <div className="download-page__platform-copy">
        <span className="download-page__platform-eyebrow">Mac</span>
        <h3>{target.label}</h3>
        {recommended ? <span className="download-page__recommended-label">Recommended</span> : null}
      </div>
      <Button asChild variant="secondary" size="small" trailing={<ArrowDown aria-hidden="true" />}>
        <a href={target.url}>{target.primaryLabel}</a>
      </Button>
    </article>
  );
}

function UnavailableDownloadState() {
  return (
    <Surface level="solid" className="download-page__unavailable" role="status">
      <span className="download-page__unavailable-mark" aria-hidden="true">—</span>
      <div>
        <h2>Downloads are temporarily unavailable.</h2>
        <p>Please try again shortly.</p>
      </div>
      <Button type="button" variant="secondary" size="small" leading={<RotateCcw aria-hidden="true" />} onClick={() => window.location.reload()}>
        Try again
      </Button>
    </Surface>
  );
}

function WindowsComingSoon() {
  return (
    <Surface level="solid" className="download-page__platform-card download-page__platform-card--unavailable" role="status">
      <div className="download-page__platform-copy">
        <span className="download-page__platform-eyebrow">Windows</span>
        <h3>Windows coming soon</h3>
        <p>Hatch Desktop is currently available for Mac.</p>
      </div>
      <span className="download-page__coming-soon-label">Coming soon</span>
    </Surface>
  );
}
