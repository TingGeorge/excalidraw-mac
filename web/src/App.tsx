import { useEffect, useMemo, useRef, useState } from "react";
import {
  CaptureUpdateAction,
  CommandPalette,
  Excalidraw,
  MainMenu,
  WelcomeScreen,
  getSceneVersion,
  useHandleLibrary,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import {
  displayedBackground,
  doc,
  flushAutosave,
  flushPendingAutosave,
  installBridge,
  noteThemeChange,
  saveLibrary,
  scheduleAutosave,
  setDirty,
  setThemePreference,
  themeState,
  watchEditState,
  watchSystemAppearance,
} from "./bridge";
import { installMacPolish } from "./macPolish";
import { installPinchZoom } from "./pinchZoom";
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
      // The file name gets the room left of the toolbar (and hides when there is too little).
      const toolbar = document.querySelector(".App-toolbar")?.getBoundingClientRect();
      const title = document.querySelector<HTMLElement>(".mac-title");
      if (toolbar && title) {
        // The group (menu button + name) ends 12 pt before the toolbar; the name needs ~48 pt.
        const room = Math.floor(toolbar.left - title.getBoundingClientRect().left - 12);
        document.documentElement.style.setProperty("--mac-title-room", `${Math.max(36, room)}px`);
        title.classList.toggle("mac-hidden", room < 44 + 48 + 14);
      }
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

const icon = (d: string) => (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const NewFileIcon = icon("M11.5 2.5H6a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 6 17.5h8a1.5 1.5 0 0 0 1.5-1.5V6.5zM11.5 2.5v4h4M10 9v5M7.5 11.5h5");
const OpenIcon = icon("M2.5 5.5a1.5 1.5 0 0 1 1.5-1.5h3.5l1.5 1.5h7a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5z");
const SaveIcon = icon("M4 3.5h9.5l3 3V16a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5zM6.5 3.5v4h6v-4M6.5 16.5v-5h7v5");
const SaveAsIcon = icon("M4 3.5h9.5l3 3V9M9 16.5H4a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5M6.5 3.5v4h6v-4M12 16.5l.5-2 4-4 1.5 1.5-4 4z");
// The title bar row's own buttons use the toolbar's icon style: 16 pt, 20-unit grid, 1.25 stroke.
const ExportIcon = icon(
  "M9.5 3.5H5A1.5 1.5 0 0 0 3.5 5v10A1.5 1.5 0 0 0 5 16.5h10a1.5 1.5 0 0 0 1.5-1.5v-4.5M3.5 13l3.5-3.5 3.5 3.5M9.5 11.5l1.5-1.5 5.5 5.5M13 7l3.5-3.5M13 3.5h3.5V7",
);
const LibraryIcon = icon("M3.5 3.5h3v13h-3zM8.5 3.5h3v13h-3zM13.5 4.5l2.8.8-3 11.4-2.8-.8z");
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
    const themeChanged = !appearanceKey.current.startsWith(`${appState.theme}|`);
    appearanceKey.current = key;
    setTheme(appState.theme);
    // Export in the theme you're looking at (the export dialog can still switch it).
    if (themeChanged && api && api.getAppState().exportWithDarkMode !== (appState.theme === "dark")) {
      api.updateScene({
        appState: { exportWithDarkMode: appState.theme === "dark" },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
    postNative({
      type: "appearance",
      theme: appState.theme,
      background: displayedBackground(appState.viewBackgroundColor, appState.theme),
    });
  };

  const initialData = useMemo(() => {
    const scene = session.scene ?? {};
    const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    const preference = session.theme === "light" || session.theme === "dark" ? session.theme : "system";
    const theme = preference === "system" ? (systemDark ? "dark" : "light") : preference;
    themeState.preference = preference;
    themeState.applied = theme;
    return {
      elements: scene.elements ?? [],
      appState: { ...(scene.appState ?? {}), theme, exportWithDarkMode: theme === "dark" },
      files: scene.files ?? {},
      scrollToContent: true,
    };
  }, [session]);

  // Library items are kept by the app in its support folder, shared by all windows.
  useHandleLibrary({
    excalidrawAPI: api,
    adapter: {
      load: () => ({ libraryItems: session.library ?? [] }),
      save: ({ libraryItems }) => saveLibrary(libraryItems),
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
      installMacPolish();
      installPinchZoom(api);
      watchSystemAppearance(api);
      watchEditState(api);
      setThemePreference(api, themeState.preference);
      syncAppearance(api.getAppState());
      postNative({ type: "ready" });
    };
    waitForLoad();
    // Write the recovery copy now (not after the autosave delay) when the user leaves the window.
    const flush = () => flushAutosave(api);
    const flushPending = () => flushPendingAutosave(api);
    window.addEventListener("pagehide", flush);
    window.addEventListener("blur", flushPending);
    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("blur", flushPending);
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
            {LibraryIcon}
          </button>
          <button
            className="mac-export"
            aria-label={t.export}
            title={t.export}
            onClick={() => api?.updateScene({ appState: { openDialog: { name: "imageExport" } } })}
          >
            {ExportIcon}
          </button>
        </div>
      )}
      onChange={(elements, appState) => {
        if (!api || appState.isLoading) return;
        noteThemeChange(appState.theme);
        syncAppearance(appState);
        const version = getSceneVersion(elements);
        if (doc.savedVersion === null) doc.savedVersion = session.dirty ? -1 : version;
        setDirty(version !== doc.savedVersion);
        scheduleAutosave(api);
      }}
    >
      <CommandPalette
        customCommandPaletteItems={[
          { label: t.newFile, category: "App", icon: NewFileIcon, shortcut: "⌘N", keywords: ["new", "file", "新增"], perform: menu("new") },
          { label: t.open, category: "App", icon: OpenIcon, shortcut: "⌘O", keywords: ["open", "開啟"], perform: menu("open") },
          { label: t.save, category: "App", icon: SaveIcon, shortcut: "⌘S", keywords: ["save", "儲存"], perform: menu("save") },
          { label: t.saveAs, category: "App", icon: SaveAsIcon, shortcut: "⇧⌘S", keywords: ["save as", "另存"], perform: menu("saveAs") },
        ]}
      />
      <MainMenu>
        <MainMenu.Item icon={NewFileIcon} onSelect={menu("new")} shortcut="⌘N">
          {t.newFile}
        </MainMenu.Item>
        <MainMenu.Item icon={OpenIcon} onSelect={menu("open")} shortcut="⌘O">
          {t.open}
        </MainMenu.Item>
        <MainMenu.Item icon={SaveIcon} onSelect={menu("save")} shortcut="⌘S">
          {t.save}
        </MainMenu.Item>
        <MainMenu.Item icon={SaveAsIcon} onSelect={menu("saveAs")} shortcut="⇧⌘S">
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
        <WelcomeScreen.Hints.MenuHint>{t.menuHint}</WelcomeScreen.Hints.MenuHint>
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
    <div className={`mac-title${theme === "dark" ? " dark" : ""}${info.name ? "" : " empty"}`}>
      {info.name && (
        <>
          <div className="name">{info.name}</div>
          <div className="folder">
            {info.folder}
            {dirty ? ` · ${t.edited}` : ""}
          </div>
        </>
      )}
    </div>
    {agentConnected && <div className={`agent-status${theme === "dark" ? " dark" : ""}`}>{t.agent}</div>}
    </>
  );
}
