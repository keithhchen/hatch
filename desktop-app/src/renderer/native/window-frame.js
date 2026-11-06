/** The Library window (`main`): a compact list of Agents. */
export const LIBRARY_WINDOW_FRAME = Object.freeze({ minWidth: 520, minHeight: 420, defaultWidth: 760, defaultHeight: 600 });

/** A Chat window (one per Agent). */
export const DESKTOP_WINDOW_FRAME = Object.freeze({
  minWidth: 640,
  minHeight: 600,
  defaultWidth: 1180,
  defaultHeight: 780
});

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

export function normalizeWindowFrame(value, constraints = DESKTOP_WINDOW_FRAME) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const width = finite(value.width);
  const height = finite(value.height);
  const x = finite(value.x);
  const y = finite(value.y);
  if (width === null || height === null || x === null || y === null) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(constraints.minWidth, Math.round(width)),
    height: Math.max(constraints.minHeight, Math.round(height))
  };
}

function monitorBounds(monitor) {
  const area = monitor?.workArea;
  const position = area?.position;
  const size = area?.size;
  const x = finite(position?.x);
  const y = finite(position?.y);
  const width = finite(size?.width);
  const height = finite(size?.height);
  if ([x, y, width, height].some((value) => value === null) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function containingMonitor(frame, monitors) {
  const centerX = frame.x + frame.width / 2;
  const centerY = frame.y + frame.height / 2;
  return monitors
    .map(monitorBounds)
    .filter(Boolean)
    .find((area) => centerX >= area.x && centerX <= area.x + area.width && centerY >= area.y && centerY <= area.y + area.height)
    || monitors.map(monitorBounds).find(Boolean)
    || null;
}

/**
 * Keeps a restored native frame visible after a monitor is disconnected or a
 * display scale changes. Coordinates are physical pixels, matching Tauri's
 * outerPosition/outerSize APIs; the caller remains responsible for wrapping
 * them in PhysicalPosition/PhysicalSize before applying them.
 */
export function clampWindowFrame(value, monitors = [], constraints = DESKTOP_WINDOW_FRAME) {
  const normalized = normalizeWindowFrame(value, constraints) || {
    x: 0,
    y: 0,
    width: constraints.defaultWidth,
    height: constraints.defaultHeight
  };
  const area = containingMonitor(normalized, Array.isArray(monitors) ? monitors : []);
  if (!area) return normalized;
  const width = Math.min(normalized.width, area.width);
  const height = Math.min(normalized.height, area.height);
  return {
    width,
    height,
    x: Math.min(area.x + area.width - width, Math.max(area.x, normalized.x)),
    y: Math.min(area.y + area.height - height, Math.max(area.y, normalized.y))
  };
}

/**
 * Restore the saved outer frame (clamped to a connected monitor) while the
 * window is still hidden, then persist moves/resizes, debounced so a live
 * resize runs no per-frame work. Returns a dispose function.
 */
export async function restoreAndTrackFrame({ invoke, savedFrame, constraints = DESKTOP_WINDOW_FRAME, appWindow, availableMonitors, PhysicalPosition, PhysicalSize }) {
  const frame = normalizeWindowFrame(savedFrame, constraints);
  if (frame) {
    try {
      const clamped = clampWindowFrame(frame, await availableMonitors(), constraints);
      await appWindow.setSize(new PhysicalSize(clamped.width, clamped.height));
      await appWindow.setPosition(new PhysicalPosition(clamped.x, clamped.y));
    } catch {
      // A first launch or an unavailable monitor API keeps the config default.
    }
  }
  let timer = null;
  const persist = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const [position, size] = await Promise.all([appWindow.outerPosition(), appWindow.outerSize()]);
        await invoke("patch_window_settings", { patch: { frame: { x: position.x, y: position.y, width: size.width, height: size.height } } });
      } catch {
        // Geometry persistence is best effort; the OS owns the live frame.
      }
    }, 300);
  };
  const stops = await Promise.all([appWindow.onResized(persist), appWindow.onMoved(persist)]);
  return () => { clearTimeout(timer); for (const stop of stops) stop(); };
}
