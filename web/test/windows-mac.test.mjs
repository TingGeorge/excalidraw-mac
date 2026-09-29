// Several drawings at once, each in its own window (macOS CI, after ui-mac.test.mjs left a
// drawing open): opening a second file adds a window, agents work on the frontmost drawing,
// opening a file that is already open brings its window forward, ⌘W closes just that window.
//   EXCALIDRAW_MAC_HOME=… EXCALIDRAW_APP_PATH=…/Excalidraw.app node --test test/windows-mac.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

const HOME = process.env.EXCALIDRAW_MAC_HOME;
const APP = process.env.EXCALIDRAW_APP_PATH;
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

async function waitUntil(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await bridge("window_info");
    if (fn(last)) return last;
    await sleep(200);
  }
  assert.fail(`timed out: ${what} (files ${JSON.stringify(last?.files)}, ${last?.visibleWindows} windows)`);
}

const names = (win) => win.files.map((f) => basename(f));

test("one window per drawing", { skip: !(HOME && APP) && "needs the Mac app" }, async (t) => {
  const start = await bridge("window_info");
  assert.equal(start.files.length, 1, "the drawing from the earlier tests is open");
  const first = start.files[0];

  const second = join(mkdtempSync(join(tmpdir(), "exm-windows-")), "second.excalidraw");
  writeFileSync(
    second,
    JSON.stringify({
      type: "excalidraw", version: 2, source: "test", files: {}, appState: { viewBackgroundColor: "#ffffff" },
      elements: [{
        id: "only", type: "rectangle", x: 0, y: 0, width: 120, height: 80, angle: 0, strokeColor: "#1e1e1e",
        backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1,
        opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1,
        isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
      }],
    }),
  );

  await t.test("opening a second file adds a window; the first stays open", async () => {
    execFileSync("open", ["-a", APP, second]);
    const win = await waitUntil((w) => w.files.length === 2 && basename(w.files[0]) === "second.excalidraw", 20000, "second window");
    await sleep(500);
    assert.deepEqual(names(win), ["second.excalidraw", basename(first)]);
    assert.equal((await bridge("window_info")).visibleWindows, 2, "two drawing windows, no start screen");
  });

  await t.test("agents work on the frontmost drawing", async () => {
    assert.equal((await bridge("status")).elementCount, 1);
    const scene = await bridge("get_scene", { include_elements: false });
    assert.equal(basename(scene.file), "second.excalidraw");
  });

  await t.test("opening a file that is open brings its window forward", async () => {
    execFileSync("open", ["-a", APP, first]);
    const win = await waitUntil((w) => w.files[0] === first, 10000, "first window in front");
    assert.equal(win.files.length, 2, "no third window");
    assert.equal(basename((await bridge("get_scene", { include_elements: false })).file), basename(first));
  });

  await t.test("⌘W closes the front window only", async () => {
    execFileSync("open", ["-a", APP, second]);
    await waitUntil((w) => basename(w.files[0]) === "second.excalidraw", 10000, "second window in front");
    await sleep(500);
    execFileSync("osascript", ["-e", 'tell application "System Events" to keystroke "w" using command down']);
    const win = await waitUntil((w) => w.files.length === 1, 10000, "second window closed");
    assert.equal(win.files[0], first);
    await sleep(500);
    assert.equal((await bridge("window_info")).visibleWindows, 1, "the first drawing is still showing");
  });
});
