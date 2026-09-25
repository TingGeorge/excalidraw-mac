import { languages } from "@excalidraw/excalidraw";

declare global {
  interface Window {
    /** Set by the Mac app: the user's first preferred system language, e.g. "zh-Hant-TW". */
    __NATIVE_LANG__?: string;
  }
}

/** Map a BCP-47 tag such as "zh-Hant-TW" or "fr-CA" to one of Excalidraw's language codes. */
export function pickLangCode(tags: readonly string[]): string {
  const codes = languages.map((l) => l.code);
  for (const raw of tags) {
    const tag = raw.replace("_", "-");
    const lower = tag.toLowerCase();
    if (lower.startsWith("zh")) {
      if (/-(hk|mo)\b/.test(lower)) return "zh-HK";
      if (lower.includes("hant") || /-tw\b/.test(lower)) return "zh-TW";
      return "zh-CN";
    }
    const exact = codes.find((c) => c.toLowerCase() === lower);
    if (exact) return exact;
    const base = lower.split("-")[0];
    const byBase = codes.find((c) => c.toLowerCase() === base || c.toLowerCase().startsWith(`${base}-`));
    if (byBase) return byBase;
  }
  return "en";
}

export function systemLanguages(): string[] {
  return [window.__NATIVE_LANG__, ...navigator.languages].filter((x): x is string => !!x);
}

const zh = {
  open: "開啟…",
  save: "儲存",
  saveAs: "另存新檔…",
  welcome: "所有繪圖都只儲存在這台 Mac 上，離線也能用。",
};
const en: typeof zh = {
  open: "Open…",
  save: "Save",
  saveAs: "Save As…",
  welcome: "Your drawings stay on this Mac. Works offline.",
};

export function uiStrings(langCode: string) {
  return langCode.startsWith("zh") ? zh : en;
}
