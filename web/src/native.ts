// Messages between the page and the Swift shell.
//
// Page -> Swift: window.webkit.messageHandlers.native.postMessage(msg)
// Swift -> page: webView.callAsyncJavaScript("window.excalidrawBridge.handle(m, p)")
// Startup data:  GET __native__/session (served by the app's URL scheme handler)

export type NativeMessage =
  | { type: "ready" }
  | { type: "dirty"; value: boolean }
  | { type: "autosave"; scene: string; theme: string }
  | { type: "library"; items: string }
  /** The canvas colour as displayed, so the window's title bar can match it. */
  | { type: "appearance"; theme: string; background: string }
  | { type: "menu"; action: "new" | "open" | "save" | "saveAs" }
  /** Places in the title bar row that are buttons (everything else drags the window). */
  | { type: "titlebarHoles"; rects: number[][] }
  /** Show the Export menu under this point. */
  | { type: "exportMenu"; x: number; y: number };

export type Session = {
  /** Parsed .excalidraw JSON of the last autosave, or null. */
  scene: any | null;
  theme: "light" | "dark" | null;
  /** True when the restored scene has changes not yet saved to its file. */
  dirty: boolean;
  /** Library items (parsed), or null. */
  library: any[] | null;
};

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        native?: { postMessage: (msg: unknown) => void };
      };
    };
    excalidrawBridge?: {
      handle: (method: string, params: string) => Promise<string>;
    };
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

export const isNative = () => !!window.webkit?.messageHandlers?.native;

export function postNative(msg: NativeMessage) {
  window.webkit?.messageHandlers?.native?.postMessage(msg);
}

export async function loadSession(): Promise<Session> {
  const empty: Session = { scene: null, theme: null, dirty: false, library: null };
  try {
    const res = await fetch(new URL("__native__/session", location.href), {
      cache: "no-store",
    });
    if (!res.ok) return empty;
    return { ...empty, ...(await res.json()) };
  } catch {
    return empty;
  }
}
