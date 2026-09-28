// Trackpad pinch-to-zoom. WKWebView delivers a pinch as Safari's gesture events, and Excalidraw
// 0.18.1 zooms on those without the trick it uses for Ctrl+wheel zooming (Chrome's pinch): there
// it scales each element's cached bitmap while zooming (`shouldCacheIgnoreZoom`) and redraws the
// elements sharp once zooming stops. On gesture events it redraws every element at every new zoom,
// often several times a frame, which makes pinching stutter on drawings with much in them.
//
// So, while the fingers move: at most one zoom step per frame, drawn from the cached bitmaps.
// As soon as they rest or lift, everything is redrawn sharp at the zoom reached.

import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

/** Fingers resting this long: redraw sharp without waiting for them to lift. */
const REST_MS = 150;

type GestureEvent = Event & { scale: number };

export function installPinchZoom(api: ExcalidrawImperativeAPI) {
  /** The zoom steps we pass on to Excalidraw (it listens on the document). */
  const passed = new WeakSet<Event>();
  let latestScale: number | null = null;
  let frame = 0;
  let restTimer: ReturnType<typeof setTimeout> | undefined;
  // Kept here: Excalidraw applies updateScene with React's next render, so its app state can
  // still hold the previous value when a gesture event follows right after.
  let cached = false;

  const useCachedBitmaps = (value: boolean) => {
    if (cached === value) return;
    cached = value;
    api.updateScene({ appState: { shouldCacheIgnoreZoom: value }, captureUpdate: CaptureUpdateAction.NEVER });
  };

  /** Passes the latest zoom on; the last step of a gesture (`final`) is drawn sharp. */
  const zoomStep = (final = false) => {
    cancelAnimationFrame(frame);
    frame = 0;
    if (latestScale === null) return;
    const step = new Event("gesturechange", { cancelable: true }) as GestureEvent;
    step.scale = latestScale;
    latestScale = null;
    passed.add(step);
    if (!final) useCachedBitmaps(true);
    document.dispatchEvent(step);
    clearTimeout(restTimer);
    if (!final) restTimer = setTimeout(() => useCachedBitmaps(false), REST_MS);
  };

  // Capture on the window runs before Excalidraw's listeners on the document.
  window.addEventListener(
    "gesturestart",
    () => {
      latestScale = null;
      useCachedBitmaps(true);
    },
    true,
  );
  window.addEventListener(
    "gesturechange",
    (e) => {
      if (passed.has(e)) return;
      e.preventDefault();
      e.stopPropagation();
      latestScale = (e as GestureEvent).scale;
      if (!frame) frame = requestAnimationFrame(() => zoomStep());
    },
    true,
  );
  window.addEventListener(
    "gestureend",
    () => {
      clearTimeout(restTimer);
      useCachedBitmaps(false);
      zoomStep(true);
    },
    true,
  );
}
