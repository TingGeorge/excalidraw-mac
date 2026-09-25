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

export function App({ session, langCode }: { session: Session; langCode: string }) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [agentConnected, setAgentConnected] = useState(false);
  const [theme, setTheme] = useState("light");
  const appearanceKey = useRef("");
  const t = uiStrings(langCode);

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
    {agentConnected && <div className={`agent-status${theme === "dark" ? " dark" : ""}`}>{t.agent}</div>}
    </>
  );
}
