// Clicks the real Mac app with real mouse events (macOS CI, after mcp.test.mjs left a
// drawing open): the tools in the title bar row work, the Library button opens the
// library, and the empty parts of that row drag the window.
//   EXCALIDRAW_MAC_HOME=… EXCALIDRAW_APP_PATH=…/Excalidraw.app node --test test/ui-mac.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HOME = process.env.EXCALIDRAW_MAC_HOME;
const APP = process.env.EXCALIDRAW_APP_PATH;
const MOUSE = fileURLToPath(new URL("./mouse.swift", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bridge(method, params = {}) {
  return new Promise((resolve, reject) => {
    const sock = connect(join(HOME, "bridge.sock"), () => sock.write(JSON.stringify({ id: 1, method, params }) + "\n"));
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      if (!buf.includes("\n")) return;
      sock.end();
      const reply = JSON.parse(buf);
      reply.ok ? resolve(reply.result) : reject(new Error(reply.error));
    });
    sock.on("error", reject);
  });
}

const mouse = (...args) => execFileSync("swift", [MOUSE, ...args.map(String)], { stdio: "inherit" });
const osa = (script) => execFileSync("osascript", ["-e", script]).toString().trim();
const inApp = (script) => osa(`tell application "System Events" to tell process "Excalidraw"\n${script}\nend tell`);
const menuItem = (menu, item) => `menu item "${item}" of menu "${menu}" of menu bar item "${menu}" of menu bar 1`;
/** Opens a menu of the menu bar (so it's validated), reads it, closes it. */
function readMenu(menu, what) {
  inApp(`click menu bar item "${menu}" of menu bar 1`);
  try {
    return inApp(what);
  } finally {
    osa('tell application "System Events" to key code 53');
  }
}
const clickMenu = (menu, item) => inApp(`click ${menuItem(menu, item)}`);
const shot = (name) => process.env.RUNNER_TEMP && execFileSync("screencapture", ["-x", join(process.env.RUNNER_TEMP, `${name}.png`)]);
const count = async () => (await bridge("status")).elementCount;
async function waitUntil(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(100);
  }
  assert.fail(`timed out: ${what}`);
}
const centre = (win, r) => [win.x + r.x + r.width / 2, win.y + r.y + r.height / 2];

test("title bar row of the drawing window", { skip: !(HOME && APP) && "needs the Mac app" }, async (t) => {
  execFileSync("open", ["-a", APP]); // bring it to the front
  await sleep(1500);
  // Dismiss the "unsaved changes restored" notice the previous test leaves open.
  execFileSync("osascript", ["-e", 'tell application "System Events" to key code 36']);
  await sleep(800);
  const win = await bridge("window_info");
  const d = await bridge("diagnostics");
  assert.ok(win.visible, "drawing window is showing");
  assert.equal(win.visibleWindows, 1, "the start screen is not showing next to the drawing");
  for (const k of ["toolbar", "rectangleTool", "menu", "library"]) assert.ok(d.rects[k], `${k} is on screen`);
  console.log("window", win, "toolbar", d.rects.toolbar);

  await t.test("the title bar row is on one grid (same heights, same gaps)", () => {
    const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 1, `${what}: ${a}, expected ${b}`);
    for (const k of ["menu", "toolbar", "actions", "title"]) {
      near(d.rects[k].y, 8, `${k} top`);
      near(d.rects[k].height, 36, `${k} height`);
    }
    near(win.trafficLightsStart, 16, "traffic lights from the left edge");
    near(d.rects.menu.x - win.trafficLightsEnd, 12, "gap traffic lights → menu");
    near(d.rects.title.x - (d.rects.menu.x + d.rects.menu.width), 12, "gap menu → file name");
    near(win.width - (d.rects.actions.x + d.rects.actions.width), 16, "Library/Export from the right edge");
  });

  await t.test("clicking a tool in that row selects it", async () => {
    mouse("click", ...centre(win, d.rects.rectangleTool));
    await sleep(500);
    assert.equal((await bridge("diagnostics")).activeTool, "rectangle");
  });

  await t.test("the Library button opens the library; its × closes it", async () => {
    mouse("click", ...centre(win, d.rects.library));
    await sleep(700);
    const open = await bridge("diagnostics");
    assert.equal(open.sidebarOpen, true);
    assert.ok(open.rects.sidebarClose, "close button on screen");
    mouse("click", ...centre(win, open.rects.sidebarClose));
    await sleep(700);
    assert.equal((await bridge("diagnostics")).sidebarOpen, false);
  });

  await t.test("the empty part of the row (the file name) drags the window", async () => {
    // between the menu button and the toolbar, where the file name is
    const x = win.x + (d.rects.menu.x + d.rects.menu.width + d.rects.toolbar.x) / 2;
    const y = win.y + 26;
    mouse("drag", x, y, x + 120, y + 60);
    await sleep(700);
    const moved = await bridge("window_info");
    assert.ok(Math.abs(moved.x - win.x - 120) <= 6 && Math.abs(moved.y - win.y - 60) <= 6, `window moved to ${moved.x},${moved.y} from ${win.x},${win.y}`);
    mouse("drag", x + 120, y + 60, x, y); // put it back for the screenshot
    await sleep(500);
  });

  await t.test("Edit menu works on the canvas (H3)", async () => {
    const n = await count();
    assert.ok(n > 0, "the drawing from the MCP test is open");
    clickMenu("Edit", "Select All");
    await sleep(500);
    const enabled = readMenu("Edit", `get {name of menu item 1, enabled of menu item "Copy", enabled of menu item "Undo"} of menu "Edit" of menu bar item "Edit" of menu bar 1`);
    console.log("Edit menu (undo title, copy enabled, undo enabled):", enabled);
    assert.match(enabled, /^Undo, true, /, "the first item says just “Undo”, and Copy is enabled with a selection");
    clickMenu("Edit", "Copy");
    await sleep(500);
    assert.match(execFileSync("pbpaste").toString(), /excalidraw\/clipboard/, "Copy put the shapes on the system pasteboard");
    clickMenu("Edit", "Paste");
    await waitUntil(async () => (await count()) === 2 * n, 4000, "menu Paste added one copy");
    osa('tell application "System Events" to keystroke "v" using command down');
    await waitUntil(async () => (await count()) === 3 * n, 4000, "⌘V added one more copy");
    await sleep(800);
    assert.equal(await count(), 3 * n, "⌘V pasted exactly once");
    shot("edit-pasted");
    clickMenu("Edit", "Undo");
    await waitUntil(async () => (await count()) === 2 * n, 4000, "menu Undo removed the last paste");
    clickMenu("Edit", "Undo");
    await waitUntil(async () => (await count()) === n, 4000, "menu Undo removed the first paste");
  });

  await t.test("File > Export Image… opens the export dialog (M10, L2)", async () => {
    clickMenu("File", "Export Image…");
    await waitUntil(async () => (await bridge("diagnostics")).openDialog === "imageExport", 4000, "export dialog");
    const d = await bridge("diagnostics");
    assert.equal(d.exportName, "diagram", "exports are named after the file");
    assert.match(d.dialogText, /Dark mode/, "WebKit gets the Dark mode switch too (L4)");
    shot("export-dialog");
    osa('tell application "System Events" to key code 53');
    await waitUntil(async () => (await bridge("diagnostics")).openDialog === null, 4000, "export dialog closed");
  });

  /** The traffic lights stay centred in the 52 pt row, 16 pt from the left (H2, M5). */
  async function assertLightsInRow(what) {
    for (const delay of [0, 150, 400, 1000]) {
      await sleep(delay);
      const w = await bridge("window_info");
      assert.ok(Math.abs(w.trafficLightsStart - 16) <= 1, `${what}: lights start at ${w.trafficLightsStart}`);
      assert.ok(Math.abs(w.trafficLightsMiddle - 26) <= 1, `${what}: lights centred at ${w.trafficLightsMiddle}`);
    }
  }

  await t.test("traffic lights stay put: dark mode, light mode, resizing (H2, M5)", async () => {
    await assertLightsInRow("start");
    clickMenu("View", "Dark Mode");
    await waitUntil(async () => (await bridge("window_info")).appearance === "dark", 4000, "dark window");
    await assertLightsInRow("dark mode");
    shot("canvas-dark");
    clickMenu("View", "Dark Mode");
    await waitUntil(async () => (await bridge("window_info")).appearance === "light", 4000, "light window");
    await assertLightsInRow("light mode");
    const before = await bridge("window_info");
    inApp(`set size of front window to {1100, 720}`);
    await assertLightsInRow("resized");
    inApp(`set size of front window to {700, 400}`);
    await sleep(500);
    const small = await bridge("window_info");
    assert.ok(small.width >= 960 && small.height >= 600, `minimum size ${small.width}×${small.height} (M1)`);
    await assertLightsInRow("smallest size");
    shot("canvas-small");
    inApp(`set size of front window to {${before.width}, ${before.height}}`);
    await sleep(500);
  });

  await t.test("Settings… (⌘,) opens the settings window (L2)", async () => {
    clickMenu("Excalidraw", "Settings…");
    await sleep(800);
    assert.equal(inApp(`exists window "Settings"`), "true");
    shot("settings");
    osa('tell application "System Events" to keystroke "w" using command down');
    await sleep(500);
    assert.equal(inApp(`exists window "Settings"`), "false");
  });
});
