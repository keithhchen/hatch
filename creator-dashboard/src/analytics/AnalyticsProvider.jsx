import React, { createContext, useContext, useEffect, useRef } from "react";
import { noopAnalytics } from "./noopAnalytics.js";
import { createVideoMilestones } from "./tracking.js";
import { videoCompleted, videoPlayed, videoProgress } from "./events.js";

const AnalyticsContext = createContext(noopAnalytics);

export function AnalyticsProvider({ analytics, children }) {
  return <AnalyticsContext.Provider value={analytics}>{children}</AnalyticsContext.Provider>;
}

/** The Analytics port; the noop one when there is no provider. */
export const useAnalytics = () => useContext(AnalyticsContext);

/** Identifies the signed-in account and resets on sign-out. */
export function useAccountIdentity(accountId) {
  const analytics = useAnalytics();
  const identified = useRef(false);
  useEffect(() => {
    if (accountId) { analytics.identify(String(accountId)); identified.current = true; }
    else if (identified.current) { analytics.reset(); identified.current = false; }
  }, [analytics, accountId]);
}

/** Tracks play, 25/50/75% and ended of the <video> in `ref`. */
export function useVideoTracking(ref, videoId) {
  const analytics = useAnalytics();
  useEffect(() => {
    const video = ref.current;
    if (!video) return undefined;
    const milestones = createVideoMilestones();
    const duration = () => Math.round(video.duration) || 0;
    const onPlay = () => analytics.track(videoPlayed({ videoId, positionS: Math.round(video.currentTime), durationS: duration() }));
    const onTime = () => { if (video.duration) milestones.advance(video.currentTime / video.duration).forEach((percent) => analytics.track(videoProgress({ videoId, percent }))); };
    const onEnded = () => { analytics.track(videoCompleted({ videoId, durationS: duration() })); milestones.restart(); };
    video.addEventListener("play", onPlay);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("ended", onEnded);
    return () => { video.removeEventListener("play", onPlay); video.removeEventListener("timeupdate", onTime); video.removeEventListener("ended", onEnded); };
  }, [analytics, ref, videoId]);
}
