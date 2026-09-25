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
});
