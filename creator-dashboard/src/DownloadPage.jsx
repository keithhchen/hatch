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
import { WebLanguagePicker, useWebLocale } from "./WebLocaleProvider.jsx";
import { translateWeb, webT } from "./webI18n.js";
import "./downloadPage.css";

export function DownloadPage() {
  const { locale } = useWebLocale();
  const [detectedTarget, setDetectedTarget] = useState("unknown");
  const [detectionReady, setDetectionReady] = useState(false);

  useEffect(() => {
    let active = true;
    const previousTitle = document.title;
    document.title = webT("download.title");
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
  }, [locale]);

  const targets = useMemo(() => DESKTOP_DOWNLOAD_TARGET_ORDER.map((key) => ({
    ...DESKTOP_DOWNLOAD_TARGETS[key],
    label: translateWeb(locale, DESKTOP_DOWNLOAD_TARGETS[key].labelKey),
    url: desktopDownloadUrl(key)
  })), [locale]);
  const recommendedTarget = targets.find((target) => target.key === detectedTarget) ?? null;
  const hasConfiguredDownloads = Boolean(DESKTOP_DOWNLOAD_BASE_URL) && targets.every((target) => target.url);

  return (
    <div className="download-page">
      <header className="download-page__header">
        <HatchBrand as="a" className="download-page__brand" href="/explore" aria-label={webT("download.home")} />
        <div className="download-page__header-actions">
          <WebLanguagePicker className="download-page__language-picker" />
          <a className="download-page__back-link" href="/explore">{webT("download.back")} <ArrowRight aria-hidden="true" /></a>
        </div>
      </header>

      <main className="download-page__main">
        <section className="download-page__intro" aria-labelledby="download-page-title">
          <span className="download-page__eyebrow">{webT("download.preview")}</span>
          <h1 id="download-page-title">{webT("download.headline")}</h1>
        </section>

        {!hasConfiguredDownloads ? <UnavailableDownloadState /> : (
          <>
            <section className="download-page__recommended" aria-labelledby="download-recommended-title">
              <div className="download-page__recommended-topline">
                <span className="download-page__status-dot" aria-hidden="true" />
                <span>{detectionReady && recommendedTarget ? webT("download.recommendedForDevice") : webT("download.macDownloads")}</span>
              </div>
              <div className="download-page__recommended-content">
                <div>
                  <h2 id="download-recommended-title">{webT("download.hatchForMac")}</h2>
                  <p>{recommendedTarget ? webT("download.readyForDevice", recommendedTarget.label) : webT("download.chooseMac")}</p>
                </div>
                {recommendedTarget ? (
                  <Button asChild size="large" trailing={<ArrowDown aria-hidden="true" />}>
                    <a href={recommendedTarget.url}>{webT("common.download")}</a>
                  </Button>
                ) : null}
              </div>
            </section>

            <section className="download-page__other-versions" aria-labelledby="download-other-title">
              <div className="download-page__section-heading">
                <h2 id="download-other-title">{webT("download.macBuilds")}</h2>
                <span>{webT("download.downloadDirectly")}</span>
              </div>
              <div className="download-page__platform-grid">
                {targets.map((target) => <MacDownloadCard key={target.key} target={target} recommended={target.key === detectedTarget} />)}
              </div>
            </section>
          </>
        )}

        <WindowsComingSoon />

        <footer className="download-page__footer">
          <span>{webT("download.desktop")}</span>
          {hasConfiguredDownloads ? <a href="/explore">{webT("download.learn")} <ArrowRight aria-hidden="true" /></a> : null}
        </footer>
      </main>
    </div>
  );
}

function MacDownloadCard({ target, recommended }) {
  return (
    <article className={`download-page__platform-card${recommended ? " is-recommended" : ""}`}>
      <div className="download-page__platform-copy">
        <span className="download-page__platform-eyebrow">{webT("download.mac")}</span>
        <h3>{target.label}</h3>
        {recommended ? <span className="download-page__recommended-label">{webT("download.recommended")}</span> : null}
      </div>
      <Button asChild variant="secondary" size="small" trailing={<ArrowDown aria-hidden="true" />}>
        <a href={target.url}>{webT("common.download")}</a>
      </Button>
    </article>
  );
}

function UnavailableDownloadState() {
  return (
    <Surface level="solid" className="download-page__unavailable" role="status">
      <span className="download-page__unavailable-mark" aria-hidden="true">—</span>
      <div>
        <h2>{webT("download.unavailable")}</h2>
        <p>{webT("download.unavailableBody")}</p>
      </div>
      <Button type="button" variant="secondary" size="small" leading={<RotateCcw aria-hidden="true" />} onClick={() => window.location.reload()}>
        {webT("download.tryAgain")}
      </Button>
    </Surface>
  );
}

function WindowsComingSoon() {
  return (
    <Surface level="solid" className="download-page__platform-card download-page__platform-card--unavailable" role="status">
      <div className="download-page__platform-copy">
        <span className="download-page__platform-eyebrow">{webT("download.windows")}</span>
        <h3>{webT("download.windowsComingSoon")}</h3>
        <p>{webT("download.macOnly")}</p>
      </div>
      <span className="download-page__coming-soon-label">{webT("download.comingSoon")}</span>
    </Surface>
  );
}
