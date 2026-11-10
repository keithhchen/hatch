import React, { useCallback, useEffect, useRef, useState } from "react";

/** The longest recording a voice message may be; the server refuses more. */
export const MAX_RECORDING_SECONDS = 300;
/** Whether this browser can record at all; where it cannot, there is no microphone to show. */
export const canRecord = () => typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
const DENIED = new Set(["NotAllowedError", "SecurityError", "NotFoundError", "PermissionDeniedError"]);

/**
 * Record from the microphone, then hand the recording to `dictate` (blob => text) and give the text to `onText`.
 * Phases: idle, recording, transcribing, denied. Cancel discards; nothing here ever sends a message.
 */
export function useVoiceInput({ dictate, onText, onError }) {
  const [phase, setPhase] = useState("idle");
  const [analyser, setAnalyser] = useState(null);
  const session = useRef(null);
  const latest = useRef({});
  latest.current = { dictate, onText, onError };

  const release = useCallback(() => {
    const current = session.current;
    session.current = null;
    if (!current) return;
    clearTimeout(current.limit);
    current.stream.getTracks().forEach(track => track.stop());
    current.context.close().catch(() => {});
    setAnalyser(null);
  }, []);

  const stop = useCallback(keep => {
    const current = session.current;
    if (!current || current.recorder.state === "inactive") return;
    current.keep = keep;
    current.recorder.stop();
  }, []);

  const start = useCallback(async () => {
    if (session.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const context = new AudioContext();
      const node = context.createAnalyser();
      node.fftSize = 512;
      context.createMediaStreamSource(stream).connect(node);
      const chunks = [];
      const current = { stream, recorder, context, keep: false, limit: setTimeout(() => stop(true), MAX_RECORDING_SECONDS * 1000) };
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = async () => {
        release();
        if (!current.keep || !chunks.length) { setPhase("idle"); return; }
        setPhase("transcribing");
        try { latest.current.onText(await latest.current.dictate(new Blob(chunks, { type: recorder.mimeType }))); }
        catch (error) { latest.current.onError?.(error); }
        finally { setPhase("idle"); }
      };
      session.current = current;
      recorder.start();
      setAnalyser(node);
      setPhase("recording");
    } catch (error) {
      release();
      if (DENIED.has(error?.name)) setPhase("denied");
      else { setPhase("idle"); latest.current.onError?.(error); }
    }
  }, [release, stop]);

  useEffect(() => () => {
    const current = session.current;
    if (current) { current.keep = false; if (current.recorder.state !== "inactive") current.recorder.stop(); else release(); }
  }, [release]);

  return { phase, analyser, start, confirm: () => stop(true), cancel: () => stop(false) };
}

/** The live level of the microphone as a rolling strip of bars. */
export function Waveform({ analyser }) {
  const canvas = useRef(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element || !analyser) return undefined;
    const context = element.getContext("2d");
    const samples = new Uint8Array(analyser.fftSize);
    const levels = [];
    let frame = 0;
    let tick = 0;
    const draw = () => {
      const ratio = window.devicePixelRatio || 1;
      const { width, height } = element.getBoundingClientRect();
      if (element.width !== Math.round(width * ratio)) { element.width = Math.round(width * ratio); element.height = Math.round(height * ratio); }
      analyser.getByteTimeDomainData(samples);
      if (tick++ % 3 === 0) levels.push(Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length));
      const step = 5 * ratio;
      levels.splice(0, Math.max(0, levels.length - Math.ceil(element.width / step)));
      context.clearRect(0, 0, element.width, element.height);
      context.fillStyle = getComputedStyle(element).color;
      levels.forEach((level, index) => {
        const bar = Math.max(3 * ratio, Math.min(1, level * 4) * element.height);
        context.fillRect(element.width - (levels.length - index) * step, (element.height - bar) / 2, 3 * ratio, bar);
      });
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [analyser]);
  return <canvas ref={canvas} className="web-chat__waveform" aria-hidden="true" />;
}
