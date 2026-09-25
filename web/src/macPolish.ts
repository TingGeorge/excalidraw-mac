// Small DOM touches that make Excalidraw's own UI read like a Mac app, applied as
// Excalidraw renders (a MutationObserver; no polling):
// - shortcuts written the Mac way: "Cmd+Shift+E" -> "⇧⌘E";
// - a tooltip on every icon button (WKWebView doesn't show `title` tooltips here);
// - a close button on every dialog; the Help dialog opens with focus on it;
// - small text fixes in the Mermaid dialog.

const MODIFIERS: Record<string, string> = {
  ctrl: "⌃",
  control: "⌃",
  cmd: "⌘",
  command: "⌘",
  ctrlorcmd: "⌘",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
};
const KEYS: Record<string, string> = {
  enter: "↩",
  return: "↩",
  delete: "⌫",
  backspace: "⌫",
  escape: "⎋",
  esc: "⎋",
  tab: "⇥",
  space: "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};
const ORDER = ["⌃", "⌥", "⇧", "⌘"];

/** ["Cmd", "Shift", "E"] -> ["⇧", "⌘", "E"]; null when it isn't modifiers followed by a key. */
function macKeys(parts: string[]): string[] | null {
  if (parts.length < 2 || !parts.slice(0, -1).every((p) => MODIFIERS[p.toLowerCase()])) return null;
  const mods = parts.slice(0, -1).map((p) => MODIFIERS[p.toLowerCase()]);
  const last = parts[parts.length - 1];
  const key = KEYS[last.toLowerCase()] ?? MODIFIERS[last.toLowerCase()] ?? (last.length === 1 ? last.toUpperCase() : last);
  return [...[...new Set(mods)].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)), key];
}

/** "Cmd+Shift+E" / "Shift+Option+D" / "Cmd Enter" -> "⇧⌘E" / "⌥⇧D" / "⌘↩". Other text is returned as is. */
export function macShortcut(text: string): string {
  return macKeys(text.trim().split(/\s*\+\s*|\s+/).filter(Boolean))?.join("") ?? text;
}

/** Rewrites shortcut phrases inside a longer text ("Undo — Ctrl+Z" -> "Undo — ⌘Z"). */
export function macShortcutsIn(text: string): string {
  return text.replace(
    /\b(?:Ctrl|Cmd|CtrlOrCmd|Alt|Option|Shift)(?:\s*\+\s*[^\s+,)]+)+/gi,
    (m) => macShortcut(m),
  );
}

/** A single key cap in the Help dialog ("Cmd" -> "⌘"). */
function macKeyCap(text: string): string {
  const t = text.trim().toLowerCase();
  return MODIFIERS[t] ?? KEYS[t] ?? text;
}

const SHORTCUT_SELECTORS = [
  ".dropdown-menu-item__shortcut",
  ".context-menu-item__shortcut",
  ".welcome-screen-menu-item__shortcut",
].join(",");

function polishShortcuts(root: ParentNode) {
  for (const el of root.querySelectorAll<HTMLElement>(SHORTCUT_SELECTORS)) {
    if (el.children.length) continue;
    const text = el.textContent ?? "";
    const mac = macShortcut(text);
    if (mac !== text) el.textContent = mac;
  }
  // Command palette: one key cap per key ("Cmd" "Shift" "E" -> "⇧" "⌘" "E").
  for (const el of root.querySelectorAll<HTMLElement>(".command-palette-dialog .shortcut")) {
    const caps = [...el.querySelectorAll<HTMLElement>(".shortcut-key")];
    const keys = macKeys(caps.map((c) => c.textContent ?? ""));
    if (keys?.length === caps.length) caps.forEach((c, i) => c.textContent !== keys[i] && (c.textContent = keys[i]));
    else if (caps.length === 1) {
      const cap = macKeyCap(caps[0].textContent ?? "");
      if (cap !== caps[0].textContent) caps[0].textContent = cap;
    }
  }
  for (const el of root.querySelectorAll<HTMLElement>(".HelpDialog__key, .ttd-dialog-submit-shortcut__key")) {
    if (el.children.length) continue;
    const text = el.textContent ?? "";
    const mac = macKeyCap(text);
    if (mac !== text) el.textContent = mac;
  }
}

// ---------------------------------------------------------------------------
// Tooltips

const TIP_TARGET = "[data-mac-tip]";
let tipEl: HTMLDivElement | null = null;
let tipTimer: ReturnType<typeof setTimeout> | undefined;
let tipFor: Element | null = null;

const zh = () => document.documentElement.lang.startsWith("zh");
const LABEL_TIPS: Record<string, [string, string]> = {
  arrowhead_start: ["起點箭頭", "Start arrowhead"],
  arrowhead_end: ["終點箭頭", "End arrowhead"],
};

/** Moves `title` (the native tooltip WKWebView doesn't show) into our own tooltip. */
function adoptTitles(root: ParentNode) {
  // Excalidraw's ☰ button has no label at all.
  const menu = root.querySelector<HTMLElement>(".main-menu-trigger:not([data-mac-tip])");
  if (menu) {
    menu.dataset.macTip = zh() ? "選單" : "Menu";
    if (!menu.hasAttribute("aria-label")) menu.setAttribute("aria-label", menu.dataset.macTip);
  }
  const els = root.querySelectorAll<HTMLElement>(
    ".excalidraw [title], .mac-top-actions [title], .excalidraw button[aria-label]:not([data-mac-tip])",
  );
  for (const el of els) {
    if (el.closest(".excalidraw-textEditorContainer, input, textarea")) continue;
    const title = el.getAttribute("title");
    if (title) {
      el.dataset.macTip = macShortcutsIn(title);
      el.removeAttribute("title");
    } else if (!el.dataset.macTip && el.matches("button[aria-label]") && !el.textContent?.trim()) {
      const label = el.getAttribute("aria-label") ?? "";
      const tip = LABEL_TIPS[label]?.[zh() ? 0 : 1] ?? label;
      // Some of Excalidraw's labels are internal names ("arrowhead_start"): no tooltip then.
      if (!/^[a-z]+(_[a-z]+)+$/.test(tip)) el.dataset.macTip = tip;
    }
  }
}

function hideTip() {
  clearTimeout(tipTimer);
  tipFor = null;
  if (tipEl) tipEl.style.opacity = "0";
}

function showTip(target: HTMLElement) {
  const text = target.dataset.macTip;
  if (!text) return;
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "mac-tooltip";
    tipEl.setAttribute("role", "tooltip");
    document.body.appendChild(tipEl);
  }
  tipEl.textContent = text;
  tipEl.classList.toggle("dark", !!document.querySelector(".excalidraw.theme--dark"));
  const r = target.getBoundingClientRect();
  const tip = tipEl.getBoundingClientRect();
  const below = r.bottom + 8 + tip.height < window.innerHeight;
  const top = below ? r.bottom + 8 : r.top - 8 - tip.height;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - tip.width / 2), window.innerWidth - tip.width - 8);
  tipEl.style.top = `${Math.round(top)}px`;
  tipEl.style.left = `${Math.round(left)}px`;
  tipEl.style.opacity = "1";
}

function onPointerOver(e: PointerEvent) {
  const target = (e.target as Element | null)?.closest?.(TIP_TARGET) as HTMLElement | null;
  if (target === tipFor) return;
  hideTip();
  if (!target || e.buttons) return;
  tipFor = target;
  tipTimer = setTimeout(() => showTip(target), 500);
}

// ---------------------------------------------------------------------------
// Dialogs

const CLOSE_ICON =
  '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

function polishDialogs(root: ParentNode) {
  for (const content of root.querySelectorAll<HTMLElement>(".Modal__content")) {
    // The command palette closes with Esc (it says so at its top) and its search field sits where a × would go.
    if (content.querySelector(":scope > .mac-dialog-close") || content.closest(".command-palette-dialog") || content.querySelector(".command-palette-dialog")) continue;
    const modal = content.closest(".Modal");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mac-dialog-close";
    button.setAttribute("aria-label", zh() ? "關閉" : "Close");
    button.innerHTML = CLOSE_ICON;
    button.addEventListener("click", () => {
      modal?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    });
    content.prepend(button);
    // Help opens on a list of links and Excalidraw focuses the second one ("Read our blog"):
    // start on the close button instead, once Excalidraw's own focusing (a timeout) has run.
    if (content.querySelector(".HelpDialog__header") || modal?.classList.contains("HelpDialog")) {
      setTimeout(() => button.focus({ preventScroll: true }), 50);
    }
  }
  // Mermaid dialog: keep the commas out of the links ("Flowchart, Sequence, Class").
  for (const a of root.querySelectorAll<HTMLAnchorElement>(".ttd-dialog-desc a")) {
    const text = a.textContent ?? "";
    if (text.endsWith(",")) {
      a.textContent = text.slice(0, -1);
      a.after(document.createTextNode(","));
    }
  }
}

export function installMacPolish() {
  const run = () => {
    polishShortcuts(document);
    adoptTitles(document);
    polishDialogs(document);
  };
  // Mutation observer callbacks run before the next paint: menus and dialogs never show up
  // unpolished, not even for a frame. (Our own changes call it once more; that finds nothing.)
  new MutationObserver(run).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["title"],
  });
  document.addEventListener("pointerover", onPointerOver, true);
  document.addEventListener("pointerdown", hideTip, true);
  document.addEventListener("keydown", hideTip, true);
  window.addEventListener("blur", hideTip);
  run();
}
