import { useEffect, useMemo, useState } from "react";
import {
  Excalidraw,
  MainMenu,
  WelcomeScreen,
  getSceneVersion,
  useHandleLibrary,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { doc, flushAutosave, installBridge, scheduleAutosave, setDirty } from "./bridge";
import { uiStrings } from "./i18n";
import { postNative, type Session } from "./native";

const menu = (action: "new" | "open" | "save" | "saveAs") => () => postNative({ type: "menu", action });

export function App({ session, langCode }: { session: Session; langCode: string }) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const t = uiStrings(langCode);

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
    <Excalidraw
      excalidrawAPI={setApi}
      initialData={initialData as any}
      langCode={langCode}
      aiEnabled={false}
      UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false } }}
      onChange={(elements) => {
        if (!api || api.getAppState().isLoading) return;
        const version = getSceneVersion(elements);
        if (doc.savedVersion === null) doc.savedVersion = session.dirty ? -1 : version;
        setDirty(version !== doc.savedVersion);
        scheduleAutosave(api);
      }}
    >
      <MainMenu>
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
            <WelcomeScreen.Center.MenuItem onSelect={menu("open")} shortcut="⌘O">
              {t.open}
            </WelcomeScreen.Center.MenuItem>
            <WelcomeScreen.Center.MenuItemHelp />
          </WelcomeScreen.Center.Menu>
        </WelcomeScreen.Center>
      </WelcomeScreen>
    </Excalidraw>
  );
}
