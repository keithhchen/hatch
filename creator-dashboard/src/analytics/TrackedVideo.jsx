import React, { useRef } from "react";
import { useVideoTracking } from "./AnalyticsProvider.jsx";

const slugOf = (src) => String(src).split(/[?#]/)[0].split("/").pop().replace(/\.[^.]+$/, "");

/** A <video> that reports play, progress and completion; video_id is the file name of its src. */
export function TrackedVideo(props) {
  const ref = useRef(null);
  useVideoTracking(ref, slugOf(props.src));
  return <video ref={ref} {...props} />;
}
