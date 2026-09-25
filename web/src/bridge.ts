// window.excalidrawBridge: the operations the Mac app (and through it the MCP
// server) can run on the canvas. Every call takes and returns JSON strings:
//   handle("add_elements", '{"elements":[...]}') -> '{"ok":true,"result":{...}}'
//                                                 or '{"ok":false,"error":"..."}'
// Edits made here go through Excalidraw's history, so the user can ⌘Z them.

import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToBlob,
  exportToSvg,
  FONT_FAMILY,
  getCommonBounds,
  getSceneVersion,
  loadFromBlob,
  newElementWith,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { postNative } from "./native";

type Api = ExcalidrawImperativeAPI;
// Elements are handled structurally here; Excalidraw validates them on updateScene.
type El = any;
type Params = Record<string, any>;

// ---------------------------------------------------------------------------
// Document state (saved vs. dirty), shared with App.tsx

export const doc = {
  /** Scene version at the last open/save; null until the first onChange. */
  savedVersion: null as number | null,
  dirty: false,
};

export function setDirty(value: boolean) {
  if (doc.dirty !== value) {
    doc.dirty = value;
    postNative({ type: "dirty", value });
    window.dispatchEvent(new CustomEvent("dirty", { detail: value }));
  }
}

function markSaved(api: Api) {
  doc.savedVersion = getSceneVersion(api.getSceneElementsIncludingDeleted());
  setDirty(false);
}

// ---------------------------------------------------------------------------
// Autosave (the app keeps the canvas across launches, like excalidraw.com)

let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let lastAutosaveKey = "";

export function autosaveSnapshot(api: Api) {
  const appState = api.getAppState();
  return {
    scene: serializeAsJSON(api.getSceneElements(), appState, api.getFiles(), "local"),
    theme: appState.theme,
  };
}

function autosaveKey(api: Api) {
  const s = api.getAppState();
  return [
    getSceneVersion(api.getSceneElementsIncludingDeleted()),
    Object.keys(api.getFiles()).length,
    s.theme,
    s.viewBackgroundColor,
    s.gridModeEnabled,
  ].join("|");
}

export function scheduleAutosave(api: Api) {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => flushAutosave(api), 700);
}

export function flushAutosave(api: Api) {
  clearTimeout(autosaveTimer);
  const key = autosaveKey(api);
  if (key === lastAutosaveKey) return;
  lastAutosaveKey = key;
  postNative({ type: "autosave", ...autosaveSnapshot(api) });
}

// ---------------------------------------------------------------------------
// Helpers

const r1 = (n: number) => Math.round(n * 10) / 10;
const BINDABLE = new Set(["rectangle", "ellipse", "diamond", "text", "image", "frame", "magicframe", "embeddable", "iframe"]);
const ARROW_GAP = 6;

function randomId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 20; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function commit(api: Api, elements: El[]) {
  api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
}

function liveElements(api: Api): El[] {
  return api.getSceneElements() as El[];
}

function boundTextOf(el: El, byId: Map<string, El>): El | undefined {
  const ref = el.boundElements?.find((b: El) => b.type === "text");
  const t = ref && byId.get(ref.id);
  return t && !t.isDeleted ? t : undefined;
}

function center(e: El): [number, number] {
  return [e.x + e.width / 2, e.y + e.height / 2];
}

/** Point just outside `e`'s outline on the line from its centre towards (tx, ty). */
function edgePoint(e: El, tx: number, ty: number, gap: number): [number, number] {
  const [cx, cy] = center(e);
  const dx = tx - cx;
  const dy = ty - cy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const hw = Math.max(e.width / 2, 1);
  const hh = Math.max(e.height / 2, 1);
  let t: number;
  if (e.type === "ellipse") t = 1 / Math.sqrt((ux / hw) ** 2 + (uy / hh) ** 2);
  else if (e.type === "diamond") t = 1 / (Math.abs(ux) / hw + Math.abs(uy) / hh);
  else t = Math.min(ux ? hw / Math.abs(ux) : Infinity, uy ? hh / Math.abs(uy) : Infinity);
  return [cx + ux * (t + gap), cy + uy * (t + gap)];
}

/** Straight arrow geometry from the outline of `a` to the outline of `b`. */
function route(a: El, b: El) {
  const [ax, ay] = center(a);
  const [bx, by] = center(b);
  const s = edgePoint(a, bx, by, ARROW_GAP);
  const e = edgePoint(b, ax, ay, ARROW_GAP);
  const dx = e[0] - s[0];
  const dy = e[1] - s[1];
  return { x: s[0], y: s[1], points: [[0, 0], [dx, dy]], width: Math.abs(dx), height: Math.abs(dy) };
}

function sizeFromPoints(points: number[][]) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/** Where a label sits on an arrow: its middle point / middle of its middle segment. */
function linearMidpoint(a: El): [number, number] {
  const p = a.points as number[][];
  if (p.length % 2 === 1) {
    const m = p[(p.length - 1) / 2];
    return [a.x + m[0], a.y + m[1]];
  }
  const m1 = p[p.length / 2 - 1];
  const m2 = p[p.length / 2];
  return [a.x + (m1[0] + m2[0]) / 2, a.y + (m1[1] + m2[1]) / 2];
}

/** Re-centre a label inside its (possibly moved/resized) container; grows shapes that became too small. */
function layoutBoundText(text: El, container: El): { text: El; container: El } {
  if (container.type === "arrow" || container.type === "line") {
    const [mx, my] = linearMidpoint(container);
    return { text: { ...text, x: mx - text.width / 2, y: my - text.height / 2 }, container };
  }
  const factor = container.type === "ellipse" ? Math.SQRT2 : container.type === "diamond" ? 2 : 1;
  const needed = text.height * factor + 10;
  if (container.height < needed) container = { ...container, height: needed };
  const [cx, cy] = center(container);
  return { text: { ...text, x: cx - text.width / 2, y: cy - text.height / 2 }, container };
}

function summarize(e: El, byId: Map<string, El>) {
  const s: Params = {
    id: e.id,
    type: e.type,
    x: r1(e.x),
    y: r1(e.y),
    width: r1(e.width),
    height: r1(e.height),
  };
  if (e.angle) s.angle = r1(e.angle);
  if (e.type === "text") {
    s.text = e.originalText ?? e.text;
    s.fontSize = e.fontSize;
  }
  const label = boundTextOf(e, byId);
  if (label) s.label = label.originalText ?? label.text;
  s.strokeColor = e.strokeColor;
  if (e.backgroundColor && e.backgroundColor !== "transparent") s.backgroundColor = e.backgroundColor;
  if (e.type === "arrow" || e.type === "line") {
    s.points = e.points.map((p: number[]) => [r1(p[0]), r1(p[1])]);
    if (e.startBinding) s.start = e.startBinding.elementId;
    if (e.endBinding) s.end = e.endBinding.elementId;
    if (e.type === "arrow") {
      s.startArrowhead = e.startArrowhead;
      s.endArrowhead = e.endArrowhead;
    }
  }
  const arrows = e.boundElements?.filter((b: El) => b.type === "arrow").map((b: El) => b.id);
  if (arrows?.length) s.arrowIds = arrows;
  if (e.groupIds?.length) s.groupIds = e.groupIds;
  if (e.frameId) s.frameId = e.frameId;
  if (e.type === "frame" || e.type === "magicframe") s.name = e.name;
  if (e.type === "image") s.fileId = e.fileId;
  if (e.link) s.link = e.link;
  if (e.locked) s.locked = true;
  return s;
}

function sceneBounds(elements: El[]) {
  if (!elements.length) return null;
  const [minX, minY, maxX, maxY] = getCommonBounds(elements);
  return { x: r1(minX), y: r1(minY), width: r1(maxX - minX), height: r1(maxY - minY) };
}

function createdSummary(elements: El[]) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  return elements
    .filter((e) => !(e.type === "text" && e.containerId && byId.has(e.containerId)))
    .map((e) => summarize(e, byId));
}

function zoomToFit(api: Api, target?: El[]) {
  api.scrollToContent(target && target.length ? target : undefined, { fitToContent: true, animate: false });
}

function bytesToBase64(bytes: Uint8Array) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// Operations

function getScene(api: Api, p: Params) {
  const live = liveElements(api);
  const byId = new Map(live.map((e) => [e.id, e]));
  const appState = api.getAppState();
  const elements = live
    .filter((e) => !(e.type === "text" && e.containerId && byId.has(e.containerId)))
    .map((e) => summarize(e, byId));
  return {
    elementCount: elements.length,
    bounds: sceneBounds(live),
    selectedElementIds: Object.keys(appState.selectedElementIds).filter((k) => appState.selectedElementIds[k]),
    viewBackgroundColor: appState.viewBackgroundColor,
    theme: appState.theme,
    ...(p.include_elements === false ? {} : { elements }),
  };
}

function isReference(end: any) {
  return end && typeof end === "object" && typeof end.id === "string" && end.type === undefined;
}

/** "1 = hand-drawn" means Excalifont, not the old Virgil: Excalifont falls back to a hand-drawn
 * Chinese/Japanese font (Xiaolai), Virgil falls back to the system sans-serif. */
function handDrawnFont(fontFamily: unknown) {
  return fontFamily === 1 ? FONT_FAMILY.Excalifont : fontFamily;
}

function addElements(api: Api, p: Params) {
  const skeletons: El[] = p.elements;
  if (!Array.isArray(skeletons) || skeletons.length === 0) {
    throw new Error("`elements` must be a non-empty array");
  }
  const sceneAll = api.getSceneElementsIncludingDeleted() as El[];
  const live = new Map(liveElements(api).map((e) => [e.id, e]));
  const usedIds = new Set(sceneAll.map((e) => e.id));
  for (const s of skeletons) {
    if (!s || typeof s !== "object" || typeof s.type !== "string") {
      throw new Error("every element needs a string `type` (rectangle, ellipse, diamond, text, arrow, line, frame)");
    }
    if (s.id !== undefined) {
      if (typeof s.id !== "string" || !s.id) throw new Error("`id` must be a non-empty string");
      if (usedIds.has(s.id)) throw new Error(`id "${s.id}" is already used on the canvas or in this batch`);
      usedIds.add(s.id);
    }
    if (s.type === "text" && typeof s.text !== "string") throw new Error("text elements need `text`");
    s.fontFamily = handDrawnFont(s.fontFamily);
    if (s.label && typeof s.label === "object") s.label.fontFamily = handDrawnFont(s.label.fontFamily);
  }

  // Arrows that point at elements by id are laid out after the shapes exist,
  // so they can be routed edge-to-edge (and can target existing elements).
  const deferred = skeletons.filter((s) => s.type === "arrow" && (isReference(s.start) || isReference(s.end)));
  const first = skeletons.filter((s) => !deferred.includes(s));
  const firstEls: El[] = first.length ? convertToExcalidrawElements(first, { regenerateIds: false }) : [];
  const firstById = new Map(firstEls.map((e) => [e.id, e]));
  const resolve = (id: string) => firstById.get(id) ?? live.get(id);

  const pending: { id: string; startId?: string; endId?: string }[] = [];
  const second: El[] = [];
  for (const s of deferred) {
    const startId = isReference(s.start) ? s.start.id : undefined;
    const endId = isReference(s.end) ? s.end.id : undefined;
    if ((s.start && !startId) || (s.end && !endId)) {
      throw new Error("an arrow can't mix a reference ({id}) with an inline shape ({type}); add the shape first and reference it by id");
    }
    for (const id of [startId, endId]) {
      if (!id) continue;
      const target = resolve(id);
      if (!target) throw new Error(`arrow ${s.id ? `"${s.id}" ` : ""}references unknown element "${id}"`);
      if (!BINDABLE.has(target.type)) throw new Error(`arrows can't attach to a ${target.type} ("${id}")`);
    }
    const { start, end, ...rest } = s;
    const id = s.id ?? randomId();
    let geometry: Params = {};
    const explicit = typeof s.x === "number" && typeof s.y === "number" && Array.isArray(s.points);
    if (!explicit) {
      if (!startId || !endId) throw new Error("an arrow bound at only one end needs explicit x, y and points");
      if (startId === endId) throw new Error("an arrow from an element to itself needs explicit x, y and points");
      geometry = route(resolve(startId), resolve(endId));
    }
    second.push({ ...rest, ...geometry, id, type: "arrow" });
    pending.push({ id, startId, endId });
  }
  const secondEls: El[] = second.length ? convertToExcalidrawElements(second, { regenerateIds: false }) : [];

  const created = new Map<string, El>([...firstEls, ...secondEls].map((e) => [e.id, e]));
  const extraBound = new Map<string, El[]>();
  for (const b of pending) {
    let arrow = created.get(b.id);
    for (const [end, targetId] of [["startBinding", b.startId], ["endBinding", b.endId]] as const) {
      if (!targetId) continue;
      arrow = { ...arrow, [end]: { elementId: targetId, focus: 0, gap: ARROW_GAP } };
      const ref = { id: b.id, type: "arrow" };
      const target = created.get(targetId);
      if (target) created.set(targetId, { ...target, boundElements: [...(target.boundElements ?? []), ref] });
      else extraBound.set(targetId, [...(extraBound.get(targetId) ?? []), ref]);
    }
    created.set(b.id, arrow);
  }

  const existing = sceneAll.map((e) =>
    extraBound.has(e.id) ? newElementWith(e, { boundElements: [...(e.boundElements ?? []), ...extraBound.get(e.id)!] }) : e,
  );
  const newEls = [...created.values()];
  commit(api, [...existing, ...newEls]);
  if (p.zoom_to_fit !== false) zoomToFit(api);
  return { created: createdSummary(newEls) };
}

async function addMermaid(api: Api, p: Params) {
  if (typeof p.definition !== "string" || !p.definition.trim()) throw new Error("`definition` is required");
  const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
  const fontSize = typeof p.font_size === "number" ? p.font_size : 16;
  let parsed;
  try {
    parsed = await parseMermaidToExcalidraw(p.definition, { themeVariables: { fontSize: `${fontSize}px` } });
  } catch (e: any) {
    throw new Error(`Mermaid parse error: ${e?.message ?? e}`);
  }
  let els: El[] = convertToExcalidrawElements(parsed.elements as any, { regenerateIds: true });
  const live = liveElements(api);
  if (live.length && els.length) {
    // Put the new diagram to the right of whatever is already on the canvas.
    const [, minY, maxX] = getCommonBounds(live);
    const [nMinX, nMinY] = getCommonBounds(els);
    const dx = maxX + 120 - nMinX;
    const dy = minY - nMinY;
    els = els.map((e) => ({ ...e, x: e.x + dx, y: e.y + dy }));
  }
  if (parsed.files) api.addFiles(Object.values(parsed.files) as any);
  commit(api, [...api.getSceneElementsIncludingDeleted(), ...els]);
  if (p.zoom_to_fit !== false) zoomToFit(api);
  return { created: createdSummary(els), bounds: sceneBounds(els) };
}

const UPDATABLE = [
  "x", "y", "width", "height", "angle", "strokeColor", "backgroundColor", "fillStyle", "strokeWidth",
  "strokeStyle", "roughness", "opacity", "roundness", "fontSize", "fontFamily", "textAlign", "verticalAlign",
  "link", "locked", "startArrowhead", "endArrowhead", "points", "name", "groupIds",
];

function updateElements(api: Api, p: Params) {
  const updates: Params[] = p.updates;
  if (!Array.isArray(updates) || updates.length === 0) throw new Error("`updates` must be a non-empty array");
  const all = api.getSceneElementsIncludingDeleted() as El[];
  const cur = new Map<string, El>(all.map((e) => [e.id, e]));
  const touched = new Set<string>();
  const put = (id: string, patch: Params) => {
    cur.set(id, { ...cur.get(id), ...patch });
    touched.add(id);
  };
  const moved = new Map<string, [number, number]>();
  const explicitlyPlaced = new Set<string>();
  const relayout = new Set<string>(); // containers whose label must be re-centred
  const refreshText = new Set<string>(); // text elements whose size must be recomputed

  for (const u of updates) {
    const el = u && typeof u.id === "string" ? cur.get(u.id) : undefined;
    if (!el || el.isDeleted) throw new Error(`no element with id "${u?.id}"`);
    const patch: Params = {};
    for (const k of UPDATABLE) if (k in u) patch[k] = u[k];
    if ("fontFamily" in patch) patch.fontFamily = handDrawnFont(patch.fontFamily);
    const isContainer = el.type !== "text" && !!boundTextOf(el, cur);
    if (isContainer && "fontSize" in patch) {
      const t = boundTextOf(el, cur)!;
      put(t.id, { fontSize: patch.fontSize });
      refreshText.add(t.id);
      relayout.add(el.id);
      delete patch.fontSize;
    }
    if ("points" in patch) Object.assign(patch, sizeFromPoints(patch.points));
    const dx = "x" in patch ? patch.x - el.x : 0;
    const dy = "y" in patch ? patch.y - el.y : 0;
    put(el.id, patch);
    if ("x" in patch || "y" in patch) explicitlyPlaced.add(el.id);
    if (dx || dy) moved.set(el.id, [dx, dy]);
    if ("width" in patch || "height" in patch || "points" in patch) relayout.add(el.id);

    const newText = "text" in u ? u.text : "label" in u ? u.label : undefined;
    if (newText !== undefined) {
      if (typeof newText !== "string") throw new Error("`text` must be a string");
      const target = el.type === "text" ? el : boundTextOf(el, cur);
      if (!target) throw new Error(`element "${el.id}" has no text or label to change`);
      put(target.id, { text: newText, originalText: newText });
      refreshText.add(target.id);
      if (target.containerId) relayout.add(target.containerId);
    }
    if (el.type === "text" && ("fontSize" in patch || "fontFamily" in patch)) refreshText.add(el.id);
  }

  // Labels follow their shapes; arrows follow the shapes they are attached to.
  const arrowShift = new Map<string, { start?: [number, number]; end?: [number, number] }>();
  for (const [id, [dx, dy]] of moved) {
    const el = cur.get(id);
    const label = boundTextOf(el, cur);
    if (label && !explicitlyPlaced.has(label.id)) relayout.add(id);
    for (const ref of el.boundElements ?? []) {
      if (ref.type !== "arrow" || explicitlyPlaced.has(ref.id)) continue;
      const a = cur.get(ref.id);
      if (!a || a.isDeleted) continue;
      const s = arrowShift.get(a.id) ?? {};
      if (a.startBinding?.elementId === id) s.start = [dx, dy];
      if (a.endBinding?.elementId === id) s.end = [dx, dy];
      arrowShift.set(a.id, s);
    }
  }
  for (const [id, s] of arrowShift) {
    const a = cur.get(id);
    const startEl = a.startBinding && cur.get(a.startBinding.elementId);
    const endEl = a.endBinding && cur.get(a.endBinding.elementId);
    if (a.points.length === 2 && startEl && endEl && startEl.id !== endEl.id) {
      put(id, route(startEl, endEl));
    } else {
      const [sdx, sdy] = s.start ?? [0, 0];
      const [edx, edy] = s.end ?? [0, 0];
      const last = a.points.length - 1;
      const points = a.points.map((pt: number[], i: number) =>
        i === 0 ? [0, 0] : i === last ? [pt[0] + edx - sdx, pt[1] + edy - sdy] : [pt[0] - sdx, pt[1] - sdy],
      );
      put(id, { x: a.x + sdx, y: a.y + sdy, points, ...sizeFromPoints(points) });
    }
    if (boundTextOf(a, cur)) relayout.add(id);
  }

  // Resize changed texts (wrapping labels to their container), then centre labels.
  if (refreshText.size) {
    const subset: El[] = [];
    for (const id of refreshText) {
      const t = cur.get(id);
      subset.push(t);
      if (t.containerId && cur.get(t.containerId)) subset.push(cur.get(t.containerId));
    }
    for (const e of restoreElements(subset, null, { refreshDimensions: true }) as El[]) {
      if (refreshText.has(e.id)) put(e.id, { text: e.text, width: e.width, height: e.height, x: e.x, y: e.y });
    }
  }
  for (const id of relayout) {
    const container = cur.get(id);
    const label = container && boundTextOf(container, cur);
    if (!label) continue;
    const res = layoutBoundText(label, container);
    put(label.id, res.text);
    if (res.container !== container) put(id, { height: res.container.height });
  }

  const strip = ({ version, versionNonce, updated, ...rest }: El) => rest;
  const next = all.map((e) => (touched.has(e.id) ? newElementWith(e, strip(cur.get(e.id))) : e));
  commit(api, next);
  const byId = new Map(next.map((e) => [e.id, e]));
  return { updated: updates.map((u) => summarize(byId.get(u.id), byId)) };
}

function deleteElements(api: Api, p: Params) {
  const ids: string[] = p.ids;
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("`ids` must be a non-empty array");
  const all = api.getSceneElementsIncludingDeleted() as El[];
  const byId = new Map(all.map((e) => [e.id, e]));
  const doomed = new Set<string>();
  for (const id of ids) {
    const el = byId.get(id);
    if (!el || el.isDeleted) throw new Error(`no element with id "${id}"`);
    doomed.add(id);
    const label = boundTextOf(el, byId);
    if (label) doomed.add(label.id);
  }
  const next = all.map((e) => {
    if (doomed.has(e.id)) return newElementWith(e, { isDeleted: true });
    const patch: Params = {};
    if (e.startBinding && doomed.has(e.startBinding.elementId)) patch.startBinding = null;
    if (e.endBinding && doomed.has(e.endBinding.elementId)) patch.endBinding = null;
    if (e.boundElements?.some((b: El) => doomed.has(b.id))) {
      patch.boundElements = e.boundElements.filter((b: El) => !doomed.has(b.id));
    }
    return Object.keys(patch).length ? newElementWith(e, patch) : e;
  });
  commit(api, next);
  return { deleted: [...doomed] };
}

function clearCanvas(api: Api) {
  const all = api.getSceneElementsIncludingDeleted() as El[];
  const count = all.filter((e) => !e.isDeleted).length;
  commit(api, all.map((e) => (e.isDeleted ? e : newElementWith(e, { isDeleted: true }))));
  return { deleted: count };
}

async function exportImage(api: Api, p: Params) {
  const format = p.format ?? "png";
  if (format !== "png" && format !== "svg") throw new Error('`format` must be "png" or "svg"');
  let elements = liveElements(api);
  if (Array.isArray(p.element_ids) && p.element_ids.length) {
    const ids = new Set<string>(p.element_ids);
    elements = elements.filter((e) => ids.has(e.id) || (e.containerId && ids.has(e.containerId)));
  }
  if (!elements.length) throw new Error("nothing to export: the canvas (or selection) is empty");
  const appState = {
    ...api.getAppState(),
    exportBackground: p.background ?? true,
    exportWithDarkMode: p.dark_mode ?? false,
    exportEmbedScene: false,
  };
  const files = api.getFiles();
  const exportPadding = typeof p.padding === "number" ? p.padding : 20;
  if (format === "svg") {
    const svg = await exportToSvg({ elements, appState, files, exportPadding });
    return {
      mimeType: "image/svg+xml",
      text: svg.outerHTML,
      width: Math.round(Number(svg.getAttribute("width"))),
      height: Math.round(Number(svg.getAttribute("height"))),
    };
  }
  const wanted = typeof p.scale === "number" && p.scale > 0 ? p.scale : 1;
  let size = { width: 0, height: 0 };
  const blob = await exportToBlob({
    elements,
    appState,
    files,
    exportPadding,
    mimeType: "image/png",
    getDimensions: (w: number, h: number) => {
      // Stay under WebKit's maximum canvas area.
      const fit = typeof p.max_size === "number" && p.max_size > 0 ? p.max_size / Math.max(w, h, 1) : Infinity;
      const scale = Math.min(wanted, fit, Math.sqrt(16_000_000 / Math.max(w * h, 1)));
      size = { width: Math.round(w * scale), height: Math.round(h * scale) };
      return { ...size, scale };
    },
  });
  return { mimeType: "image/png", base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())), ...size };
}

async function loadSceneJson(api: Api, p: Params) {
  if (typeof p.json !== "string") throw new Error("`json` is required");
  const data = await loadFromBlob(
    new Blob([p.json], { type: "application/json" }),
    api.getAppState(),
    api.getSceneElementsIncludingDeleted(),
  );
  api.updateScene({ elements: data.elements, appState: data.appState as any, captureUpdate: CaptureUpdateAction.NEVER });
  api.addFiles(Object.values(data.files));
  api.history.clear();
  zoomToFit(api);
  if (p.dirty) {
    doc.savedVersion = -1;
    setDirty(true);
  } else markSaved(api);
  return { elementCount: liveElements(api).length };
}

function newScene(api: Api) {
  api.resetScene();
  api.history.clear();
  markSaved(api);
  return {};
}

function diagnostics(api: Api) {
  const faces = [...(document.fonts as any)] as FontFace[];
  return {
    isSecureContext: window.isSecureContext,
    userAgent: navigator.userAgent,
    assetPath: window.EXCALIDRAW_ASSET_PATH,
    fontsStatus: document.fonts.status,
    loadedFonts: [...new Set(faces.filter((f) => f.status === "loaded").map((f) => f.family))],
    dirty: doc.dirty,
    sceneVersion: getSceneVersion(api.getSceneElementsIncludingDeleted()),
    activeTool: api.getAppState().activeTool.type,
    // what exported images are named after, and whether they export dark
    exportName: api.getAppState().name,
    exportWithDarkMode: api.getAppState().exportWithDarkMode,
    openDialog: api.getAppState().openDialog?.name ?? null,
    dialogText: (document.querySelector(".Modal") as HTMLElement | null)?.innerText.slice(0, 400) ?? null,
    sidebarOpen: !!document.querySelector(".default-sidebar"),
    // Where things are on screen, for UI tests that click them.
    rects: Object.fromEntries(
      Object.entries({
        toolbar: ".App-toolbar",
        rectangleTool: '.ToolIcon:has([data-testid="toolbar-rectangle"])',
        menu: ".main-menu-trigger",
        library: ".mac-top-actions .mac-library",
        sidebarClose: '[data-testid="sidebar-close"]',
        actions: ".mac-top-actions",
        title: ".mac-title",
      }).map(([k, sel]) => {
        const r = document.querySelector(sel)?.getBoundingClientRect();
        return [k, r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null];
      }),
    ),
  };
}

const ops: Record<string, (api: Api, p: Params) => unknown> = {
  ping: () => ({ ready: true }),
  diagnostics,
  get_scene: getScene,
  add_elements: addElements,
  add_mermaid: addMermaid,
  update_elements: updateElements,
  delete_elements: deleteElements,
  clear_canvas: clearCanvas,
  export_image: exportImage,
  zoom_to_fit: (api, p) => {
    const ids = Array.isArray(p.element_ids) ? new Set(p.element_ids) : null;
    zoomToFit(api, ids ? liveElements(api).filter((e) => ids.has(e.id)) : undefined);
    return {};
  },
  // Used by the Mac app itself:
  get_scene_json: (api) => ({ json: serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), "local") }),
  get_autosave: (api) => autosaveSnapshot(api),
  load_scene_json: loadSceneJson,
  new_scene: newScene,
  mark_saved: (api) => {
    markSaved(api);
    return {};
  },
  status: (api) => ({ dirty: doc.dirty, elementCount: liveElements(api).length }),
  edit: editCommand,
  view: viewCommand,
  open_export_dialog: (api) => {
    api.updateScene({ appState: { openDialog: { name: "imageExport" } } });
    return {};
  },
  set_theme_preference: (api, p) => {
    setThemePreference(api, p.preference);
    return {};
  },
  toggle_library: (api) => {
    api.toggleSidebar({ name: "default", tab: "library" });
    return {};
  },
  set_document_info: (api, p) => {
    document.documentElement.classList.toggle("mac-fullscreen", !!p.fullscreen);
    // Excalidraw names exported images after the drawing ("uiux_test.png").
    if (typeof p.name === "string" && api.getAppState().name !== p.name) {
      api.updateScene({ appState: { name: p.name }, captureUpdate: CaptureUpdateAction.NEVER });
    }
    if (typeof p.trafficLightsEnd === "number") {
      document.documentElement.style.setProperty("--mac-traffic-lights-end", `${p.trafficLightsEnd}px`);
    }
    window.dispatchEvent(new CustomEvent("document-info", { detail: p }));
    return {};
  },
  set_agent_status: (_api, p) => {
    window.dispatchEvent(new CustomEvent("agent-status", { detail: !!p.connected }));
    return {};
  },
};

// ---------------------------------------------------------------------------
// Edit and View menu commands (the app's menu bar drives the canvas through these)

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/** Presses a key combination on the canvas, exactly as Excalidraw's shortcuts expect. */
function pressKey(key: string, code: string, mods: { cmd?: boolean; shift?: boolean; alt?: boolean } = {}) {
  const target = document.querySelector(".excalidraw-container") ?? document;
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code,
      metaKey: !!mods.cmd && isMac,
      ctrlKey: !!mods.cmd && !isMac,
      shiftKey: !!mods.shift,
      altKey: !!mods.alt,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/** A text field (Excalidraw's text editor, a search box…) has the keyboard. */
function isEditingText() {
  const a = document.activeElement as HTMLElement | null;
  if (!a) return false;
  if (a.isContentEditable || a.tagName === "TEXTAREA") return true;
  return a.tagName === "INPUT" && !["checkbox", "radio", "range", "button", "submit"].includes((a as HTMLInputElement).type);
}

let lastPointer: [number, number] = [-1, -1];
document.addEventListener("pointermove", (e) => (lastPointer = [e.clientX, e.clientY]), { capture: true, passive: true });

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/**
 * Undo / Redo / Cut / Copy / Paste / Select All from the menu bar. While a text field has
 * the keyboard, the app lets WebKit do it (`native: true`); otherwise the canvas does it.
 * Copy and Cut return what Excalidraw put on the clipboard for the app to place on the
 * system pasteboard; Paste gets the pasteboard's text / image from the app.
 */
async function editCommand(_api: Api, p: Params) {
  if (isEditingText()) return { native: true };
  // Excalidraw only takes clipboard events while it has the focus…
  const container = document.querySelector<HTMLElement>(".excalidraw-container");
  if (container && !container.contains(document.activeElement)) container.focus({ preventScroll: true });
  switch (p.action) {
    case "undo":
      pressKey("z", "KeyZ", { cmd: true });
      return {};
    case "redo":
      pressKey("z", "KeyZ", { cmd: true, shift: true });
      return {};
    case "selectAll":
      pressKey("a", "KeyA", { cmd: true });
      return {};
    case "copy":
    case "cut": {
      // Excalidraw writes with navigator.clipboard.writeText when it can, else into the event's
      // clipboardData; catch both and hand the text to the app (the page can't reach the
      // system pasteboard without a click in it).
      const data = new DataTransfer();
      const clipboard = navigator.clipboard as (Clipboard & { writeText: Clipboard["writeText"] }) | undefined;
      if (clipboard) {
        Object.defineProperty(clipboard, "writeText", {
          configurable: true,
          value: async (text: string) => data.setData("text/plain", text),
        });
      }
      try {
        document.dispatchEvent(new ClipboardEvent(p.action, { clipboardData: data, bubbles: true, cancelable: true }));
        await tick(60); // Excalidraw fills the clipboard asynchronously
      } finally {
        if (clipboard) delete (clipboard as any).writeText;
      }
      return { clipboard: Object.fromEntries(data.types.map((t) => [t, data.getData(t)])) };
    }
    case "paste": {
      // …and pastes where the pointer is, if that's over the canvas; else in the middle of the view.
      const [x, y] = lastPointer;
      if (!(document.elementFromPoint(x, y) instanceof HTMLCanvasElement)) {
        document.dispatchEvent(
          new PointerEvent("pointermove", { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 }),
        );
      }
      const data = new DataTransfer();
      if (typeof p.text === "string") data.setData("text/plain", p.text);
      if (typeof p.image === "string") {
        const bytes = Uint8Array.from(atob(p.image), (c) => c.charCodeAt(0));
        data.items.add(new File([bytes], "image.png", { type: "image/png" }));
      }
      document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      await tick(60);
      return {};
    }
    default:
      throw new Error(`unknown edit action "${p.action}"`);
  }
}

/**
 * Tells the app what the Edit menu can do: Undo / Redo follow Excalidraw's own buttons, Cut /
 * Copy need a selection, and while a text field has the keyboard WebKit's own text editing
 * commands take over.
 */
export function watchEditState(api: Api) {
  let last = "";
  const send = () => {
    const disabled = (id: string) => !!document.querySelector(`[data-testid="${id}"]`)?.hasAttribute("disabled");
    const state = {
      textEditing: isEditingText(),
      canUndo: !disabled("button-undo"),
      canRedo: !disabled("button-redo"),
      hasSelection: Object.values(api.getAppState().selectedElementIds ?? {}).some(Boolean),
    };
    const text = JSON.stringify(state);
    if (text !== last) {
      last = text;
      postNative({ type: "editState", ...state });
    }
  };
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      send();
    });
  };
  document.addEventListener("focusin", schedule);
  document.addEventListener("focusout", () => setTimeout(send));
  api.onChange(schedule);
  new MutationObserver(schedule).observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled"],
  });
  send();
}

/** View menu: the same actions as Excalidraw's own shortcuts. */
function viewCommand(api: Api, p: Params) {
  switch (p.action) {
    case "zoomIn":
      pressKey("=", "Equal", { cmd: true });
      break;
    case "zoomOut":
      pressKey("-", "Minus", { cmd: true });
      break;
    case "actualSize":
      pressKey("0", "Digit0", { cmd: true });
      break;
    case "zoomToFit":
      pressKey("!", "Digit1", { shift: true });
      break;
    case "toggleTheme": {
      const theme = api.getAppState().theme === "dark" ? "light" : "dark";
      setThemePreference(api, theme);
      postNative({ type: "themePreference", value: theme });
      break;
    }
    case "toggleLibrary":
      api.toggleSidebar({ name: "default", tab: "library" });
      break;
    default:
      throw new Error(`unknown view action "${p.action}"`);
  }
  return {};
}

// ---------------------------------------------------------------------------
// Appearance: follow the system, or always light / dark (Settings, View menu, Excalidraw's menu)

const systemDark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
export const themeState = { preference: "system" as string, applied: "" };

export function setThemePreference(api: Api, preference: string) {
  themeState.preference = preference === "light" || preference === "dark" ? preference : "system";
  const theme = themeState.preference === "system" ? (systemDark() ? "dark" : "light") : themeState.preference;
  themeState.applied = theme;
  if (api.getAppState().theme !== theme) {
    api.updateScene({ appState: { theme: theme as "light" | "dark" }, captureUpdate: CaptureUpdateAction.NEVER });
  }
}

/** Excalidraw's own "Dark mode" item picks an explicit theme; remember it as the preference. */
export function noteThemeChange(theme: string) {
  if (themeState.applied && theme !== themeState.applied) {
    themeState.applied = theme;
    themeState.preference = theme;
    postNative({ type: "themePreference", value: theme });
  }
}

export function watchSystemAppearance(api: Api) {
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (themeState.preference === "system") setThemePreference(api, "system");
  });
}

/** How the canvas background looks on screen (dark theme inverts it like Excalidraw's CSS filter). */
export function displayedBackground(hex: string, theme: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return theme === "dark" ? "#121212" : "#ffffff";
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  if (theme === "dark") {
    // invert(93%) then hue-rotate(180deg), as in Excalidraw's --theme-filter
    [r, g, b] = [r, g, b].map((c) => 0.93 * (1 - c) + 0.07 * c);
    [r, g, b] = [
      -0.574 * r + 1.43 * g + 0.144 * b,
      0.426 * r + 0.43 * g + 0.144 * b,
      0.426 * r + 1.43 * g - 0.856 * b,
    ];
  }
  const hex2 = (c: number) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0");
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

export function installBridge(api: Api) {
  window.excalidrawBridge = {
    async handle(method: string, params: string) {
      try {
        const op = ops[method];
        if (!op) throw new Error(`unknown method "${method}"`);
        const result = await op(api, params ? JSON.parse(params) : {});
        return JSON.stringify({ ok: true, result: result ?? {} });
      } catch (e: any) {
        return JSON.stringify({ ok: false, error: String(e?.message ?? e) });
      }
    },
  };
}
