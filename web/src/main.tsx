// First: Excalidraw checks for canvas filters when it loads.
import "./canvasFilter";
// import "./canvasEmoji"; // off for one CI run: a before screenshot
import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import "./mac.css";
import { App } from "./App";
import { pickLangCode, systemLanguages } from "./i18n";
import { loadSession } from "./native";

const session = await loadSession();
createRoot(document.getElementById("root")!).render(
  <App session={session} langCode={pickLangCode(systemLanguages())} />,
);
