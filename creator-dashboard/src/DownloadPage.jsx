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
  const [selectedTarget, setSelectedTarget] = useState("unknown");
  const [detectionReady, setDetectionReady] = useState(false);

  useEffect(() => {
    let active = true;
    const previousTitle = document.title;
    document.title = "Download Hatch Desktop · Hatch";
    detectDownloadTargetAsync().then((target) => {
      if (!active) return;
      setDetectedTarget(target);
      setSelectedTarget(target);
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
  const selected = DESKTOP_DOWNLOAD_TARGETS[selectedTarget];
  const selectedUrl = selected ? desktopDownloadUrl(selected.key) : "";
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

        {!hasConfiguredDownloads ? (
          <UnavailableDownloadState />
        ) : detectedTarget === "unsupported" ? (
          <UnsupportedDownloadState />
        ) : (
          <>
            <section className="download-page__recommended" aria-labelledby="download-recommended-title">
              <div className="download-page__recommended-topline">
                <span className="download-page__status-dot" aria-hidden="true" />
                <span>{detectionReady && detectedTarget !== "unknown" ? "Recommended for your device" : "Choose your version"}</span>
              </div>
              {selected ? (
                <div className="download-page__recommended-content">
                  <div>
                    <h2 id="download-recommended-title">Hatch for Mac</h2>
                    <p>{selected.label}</p>
                  </div>
                  <Button asChild size="large" trailing={<ArrowDown aria-hidden="true" />}>
                    <a href={selectedUrl}>{selected.primaryLabel}</a>
                  </Button>
                </div>
              ) : (
                <div className="download-page__choose-copy">
                  <h2 id="download-recommended-title">Find the right Hatch for your computer.</h2>
                  <p>Your browser could not determine the Mac version automatically. Choose below.</p>
                </div>
              )}
            </section>

            <section className="download-page__other-versions" aria-labelledby="download-other-title">
              <div className="download-page__section-heading">
                <h2 id="download-other-title">Other versions</h2>
                <span>Choose a different Mac build</span>
              </div>
              <div className="download-page__version-list">
                {targets.map((target) => (
                  <div className={`download-page__version-row${target.key === selectedTarget ? " is-selected" : ""}`} key={target.key}>
                    <button
                      type="button"
                      className="download-page__version-choice"
                      aria-pressed={target.key === selectedTarget}
                      onClick={() => setSelectedTarget(target.key)}
                    >
                      <span>{target.label}</span>
                      {target.key === selectedTarget ? <span className="download-page__selected-label">Selected</span> : null}
                    </button>
                    <Button asChild variant="link" size="small" trailing={<ArrowRight aria-hidden="true" />}>
                      <a href={target.url}>Download</a>
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}

        <footer className="download-page__footer">
          <span>Hatch Desktop</span>
          {hasConfiguredDownloads ? <a href="/explore">Learn about Hatch <ArrowRight aria-hidden="true" /></a> : null}
        </footer>
      </main>
    </div>
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

function UnsupportedDownloadState() {
  return (
    <Surface level="solid" className="download-page__unavailable" role="status">
      <span className="download-page__unavailable-mark" aria-hidden="true">—</span>
      <div>
        <h2>Windows coming soon</h2>
        <p>Hatch Desktop is currently available for Mac.</p>
      </div>
    </Surface>
  );
}
