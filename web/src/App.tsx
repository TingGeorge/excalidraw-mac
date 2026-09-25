import { useEffect, useMemo, useRef, useState } from "react";
import {
  Excalidraw,
  MainMenu,
  WelcomeScreen,
  getSceneVersion,
  useHandleLibrary,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { displayedBackground, doc, flushAutosave, installBridge, scheduleAutosave, setDirty } from "./bridge";
import { uiStrings } from "./i18n";
import { postNative, type Session } from "./native";

const menu = (action: "new" | "open" | "save" | "saveAs") => () => postNative({ type: "menu", action });

/** Height of the macOS title bar row the top of the canvas shares. */
const TITLEBAR_HEIGHT = 52;
/** What in that row is clickable; the rest of the row drags the window. */
const TITLEBAR_BUTTONS =
  ".main-menu-trigger, .App-toolbar, .mac-top-actions button, .sidebar, .dropdown-menu, .Modal, .popover, .context-menu";

/** Keeps the app told where the buttons in the title bar row are (event-driven, no polling). */
function useTitlebarHoles() {
  useEffect(() => {
    let last = "";
    let pending = false;
    const send = () => {
      pending = false;
      const rects = [...document.querySelectorAll(TITLEBAR_BUTTONS)]
        .map((e) => e.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0 && r.top < TITLEBAR_HEIGHT)
        .map((r) => [r.x, r.y, r.width, r.height].map(Math.round));
      const key = JSON.stringify(rects);
      if (key !== last) {
        last = key;
        postNative({ type: "titlebarHoles", rects });
      }
    };
    const schedule = () => {
      if (!pending) {
        pending = true;
        requestAnimationFrame(send);
      }
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, []);
}

const LibraryIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 4h4v16H4zM10 4h4v16h-4z" />
    <path d="M16.5 5.5l3.5 1-3.8 13.5-3.4-1" />
  </svg>
);
const ShareIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v12M7.5 7.5L12 3l4.5 4.5" />
    <path d="M8 11H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-2" />
  </svg>
);

type DocumentInfo = { name?: string; folder?: string; fullscreen?: boolean };

export function App({ session, langCode }: { session: Session; langCode: string }) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [agentConnected, setAgentConnected] = useState(false);
  const [theme, setTheme] = useState("light");
  const appearanceKey = useRef("");
  const [info, setInfo] = useState<DocumentInfo>({});
  const [dirty, setDirtyState] = useState(false);
  const t = uiStrings(langCode);
  useTitlebarHoles();

  useEffect(() => {
    const onInfo = (e: Event) => setInfo((e as CustomEvent<DocumentInfo>).detail);
    const onDirty = (e: Event) => setDirtyState((e as CustomEvent<boolean>).detail);
    window.addEventListener("document-info", onInfo);
    window.addEventListener("dirty", onDirty);
    return () => {
      window.removeEventListener("document-info", onInfo);
      window.removeEventListener("dirty", onDirty);
    };
  }, []);

  useEffect(() => {
    const onStatus = (e: Event) => setAgentConnected((e as CustomEvent<boolean>).detail);
    window.addEventListener("agent-status", onStatus);
    return () => window.removeEventListener("agent-status", onStatus);
  }, []);

  /** Tell the app how the canvas looks, so the title bar can blend in. */
  const syncAppearance = (appState: { theme: string; viewBackgroundColor: string }) => {
    const key = `${appState.theme}|${appState.viewBackgroundColor}`;
    if (key === appearanceKey.current) return;
    appearanceKey.current = key;
    setTheme(appState.theme);
    postNative({
      type: "appearance",
      theme: appState.theme,
      background: displayedBackground(appState.viewBackgroundColor, appState.theme),
    });
  };

  const initialData = useMemo(() => {
    const scene = session.scene ?? {};
    const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    return {
      elements: scene.elements ?? [],
      appState: { ...(scene.appState ?? {}), theme: session.theme ?? (systemDark ? "dark" : "light") },
      files: scene.files ?? {},
      scrollToContent: true,
    };
  }, [session]);

  // Library items are kept by the app in its support folder.
  useHandleLibrary({
    excalidrawAPI: api,
    adapter: {
      load: () => ({ libraryItems: session.library ?? [] }),
      save: ({ libraryItems }) => postNative({ type: "library", items: JSON.stringify(libraryItems) }),
    },
  });

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    // Wait until Excalidraw has applied initialData before accepting commands,
    // otherwise the restored scene could overwrite them.
    const waitForLoad = () => {
      if (cancelled) return;
      if (api.getAppState().isLoading) {
        setTimeout(waitForLoad, 30);
        return;
      }
      installBridge(api);
      syncAppearance(api.getAppState());
      postNative({ type: "ready" });
    };
    waitForLoad();
    const flush = () => flushAutosave(api);
    window.addEventListener("pagehide", flush);
    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", flush);
    };
  }, [api]);

  return (
    <>
    <Excalidraw
      excalidrawAPI={setApi}
      initialData={initialData as any}
      langCode={langCode}
      aiEnabled={false}
      UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false } }}
      renderTopRightUI={() => (
        <div className="mac-top-actions">
          <button
            className="mac-library"
            aria-label={t.library}
            title={t.library}
            onClick={() => api?.toggleSidebar({ name: "default", tab: "library" })}
          >
            <LibraryIcon />
          </button>
          <button
            aria-label={t.export}
            title={t.export}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              postNative({ type: "exportMenu", x: r.left, y: r.bottom + 4 });
            }}
          >
            <ShareIcon />
          </button>
        </div>
      )}
      onChange={(elements, appState) => {
        if (!api || appState.isLoading) return;
        syncAppearance(appState);
        const version = getSceneVersion(elements);
        if (doc.savedVersion === null) doc.savedVersion = session.dirty ? -1 : version;
        setDirty(version !== doc.savedVersion);
        scheduleAutosave(api);
      }}
    >
      <MainMenu>
        <MainMenu.Item onSelect={menu("new")} shortcut="⌘N">
          {t.newFile}
        </MainMenu.Item>
        <MainMenu.Item onSelect={menu("open")} shortcut="⌘O">
          {t.open}
        </MainMenu.Item>
        <MainMenu.Item onSelect={menu("save")} shortcut="⌘S">
          {t.save}
        </MainMenu.Item>
        <MainMenu.Item onSelect={menu("saveAs")} shortcut="⇧⌘S">
          {t.saveAs}
        </MainMenu.Item>
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.CommandPalette />
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.Help />
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.ToggleTheme />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
      </MainMenu>
      <WelcomeScreen>
        <WelcomeScreen.Hints.MenuHint />
        <WelcomeScreen.Hints.ToolbarHint />
        <WelcomeScreen.Hints.HelpHint />
        <WelcomeScreen.Center>
          <WelcomeScreen.Center.Logo />
          <WelcomeScreen.Center.Heading>{t.welcome}</WelcomeScreen.Center.Heading>
          <WelcomeScreen.Center.Menu>
            <WelcomeScreen.Center.MenuItemHelp />
          </WelcomeScreen.Center.Menu>
        </WelcomeScreen.Center>
      </WelcomeScreen>
    </Excalidraw>
    {info.name && (
      <div className={`mac-title${theme === "dark" ? " dark" : ""}`}>
        <div className="name">{info.name}</div>
        <div className="folder">
          {info.folder}
          {dirty ? ` · ${t.edited}` : ""}
        </div>
      </div>
    )}
    {agentConnected && <div className={`agent-status${theme === "dark" ? " dark" : ""}`}>{t.agent}</div>}
    </>
  );
}
