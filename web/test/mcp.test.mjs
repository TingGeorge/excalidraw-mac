// End-to-end test of the excalidraw-mcp binary with the official MCP client SDK.
//
//   Linux (no Mac app): MCP_BIN=path/to/excalidraw-mcp node --test test/mcp.test.mjs
//     -> a fake app (test/fake-app.mjs) serves the bridge socket with the real page.
//   macOS CI:           MCP_BIN=… EXCALIDRAW_APP_PATH=…/Excalidraw.app REAL_APP=1 node --test …
//     -> the MCP server starts the real app itself, exactly as it would for an agent.
//
// The flow is the one the app is built for: the user opens (or creates) a file, the agent
// draws in it, and only the user saves it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MCP_BIN = process.env.MCP_BIN && resolve(process.env.MCP_BIN);
const REAL_APP = process.env.REAL_APP === "1";
const APP = process.env.EXCALIDRAW_APP_PATH;

const EMPTY_SCENE =
  '{"type":"excalidraw","version":2,"source":"Excalidraw for Mac","elements":[],"appState":{"gridSize":20,"viewBackgroundColor":"#ffffff"},"files":{}}';

const textOf = (res) => res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const jsonOf = (res) => {
  assert.ok(!res.isError, `tool error: ${textOf(res)}`);
  return JSON.parse(textOf(res));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("excalidraw-mcp end to end", { skip: !MCP_BIN && "set MCP_BIN" }, async (t) => {
  // Keep the socket path short: macOS limits Unix socket paths to 104 bytes.
  const home = process.env.EXCALIDRAW_MAC_HOME || mkdtempSync(join(REAL_APP ? "/tmp" : tmpdir(), "exm-"));
  // realpath: on macOS the temp folder is a symlink (/var -> /private/var).
  const work = realpathSync(mkdtempSync(join(tmpdir(), "exm-work-")));
  const file = join(work, "diagram.excalidraw");
  writeFileSync(file, EMPTY_SCENE); // what File > New File… creates

  let fake;
  if (!REAL_APP) {
    const { startFakeApp } = await import("./fake-app.mjs");
    fake = await startFakeApp(home);
  }
  const client = new Client({ name: "e2e-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    await fake?.close();
  });
  await client.connect(
    new StdioClientTransport({
      command: MCP_BIN,
      cwd: work,
      env: { ...process.env, EXCALIDRAW_MAC_HOME: home },
      stderr: "inherit",
    }),
  );
  const call = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });

  /** The user opens the file in the app (Finder double-click / File > Open). */
  async function userOpens(path) {
    if (!REAL_APP) return fake.openFile(path);
    execFileSync("open", ["-g", "-a", APP, "--env", `EXCALIDRAW_MAC_HOME=${home}`, path]);
    for (let i = 0; i < 100; i++) {
      const res = await call("get_scene", { include_elements: false });
      if (!res.isError && JSON.parse(textOf(res)).file === path) return;
      await sleep(200);
    }
    assert.fail(`the app did not open ${path}`);
  }

  await t.test("handshake and tool list", async () => {
    assert.equal(client.getServerVersion().name, "excalidraw-mac");
    assert.match(client.getInstructions(), /⌘S/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((x) => x.name).sort(), [
      "add_elements", "add_mermaid", "clear_canvas", "delete_elements", "get_scene",
      "render_image", "update_elements", "zoom_to_fit",
    ]);
    for (const tool of tools) assert.equal(tool.inputSchema.type, "object");
    const render = tools.find((x) => x.name === "render_image");
    assert.equal(render.inputSchema.properties.path, undefined, "agents can't write image files");
  });

  await t.test("nothing open yet: the agent is told to ask the user (starts the app if needed)", async () => {
    const res = await call("get_scene");
    assert.equal(res.isError, true);
    assert.match(textOf(res), /No drawing is open/);
  });

  await t.test("the user opens a file, the agent draws in it", async () => {
    await userOpens(file);
    let scene = jsonOf(await call("get_scene"));
    assert.equal(scene.elementCount, 0);
    assert.equal(scene.file, file);
    assert.equal(scene.dirty, false);

    const m = jsonOf(await call("add_mermaid", { definition: "flowchart LR\n  A[Plan] --> B[Build] --> C[Ship]" }));
    assert.ok(m.created.length >= 5);
    const res = jsonOf(
      await call("add_elements", {
        elements: [
          { type: "rectangle", id: "api", x: 0, y: 300, width: 180, height: 70, label: { text: "API" }, backgroundColor: "#a5d8ff", fillStyle: "solid" },
          { type: "rectangle", id: "db", x: 320, y: 300, width: 180, height: 70, label: { text: "Database" } },
          { type: "arrow", id: "q", start: { id: "api" }, end: { id: "db" }, label: { text: "SQL" } },
        ],
      }),
    );
    assert.deepEqual(res.created.map((e) => e.id).sort(), ["api", "db", "q"]);
    scene = jsonOf(await call("get_scene"));
    const q = scene.elements.find((e) => e.id === "q");
    assert.equal(q.start, "api");
    assert.equal(q.end, "db");
    assert.equal(scene.dirty, true, "unsaved changes");
    assert.equal(readFileSync(file, "utf8"), EMPTY_SCENE, "the agent's edits are not written to the file");
  });

  await t.test("edit, and errors are reported to the agent", async () => {
    jsonOf(await call("update_elements", { updates: [{ id: "db", text: "Postgres", y: 420 }] }));
    const db = jsonOf(await call("get_scene")).elements.find((e) => e.id === "db");
    assert.equal(db.label, "Postgres");
    assert.equal(db.y, 420);
    const bad = await call("update_elements", { updates: [{ id: "missing", x: 1 }] });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /no element with id "missing"/);
    for (const name of ["save_file", "open_file", "export_image", "no_such_tool"]) {
      const res = await call(name, { path: join(work, "x.excalidraw") });
      assert.equal(res.isError, true, `${name} must not exist`);
    }
  });

  await t.test("render_image shows the drawing to the agent without writing files", async () => {
    const res = await call("render_image");
    assert.ok(!res.isError, textOf(res));
    const img = res.content.find((c) => c.type === "image");
    assert.equal(img.mimeType, "image/png");
    const png = Buffer.from(img.data, "base64");
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.ok(png.readUInt32BE(16) > 300);
    const part = await call("render_image", { element_ids: ["api"], scale: 2 });
    assert.ok(!part.isError, textOf(part));
    assert.deepEqual(readdirSync(work), ["diagram.excalidraw"]);
  });

  await t.test("zoom_to_fit", async () => {
    jsonOf(await call("zoom_to_fit", { element_ids: ["api"] }));
  });

  await t.test("the user saves with ⌘S", async (t) => {
    if (REAL_APP) {
      execFileSync("open", ["-a", APP]); // bring the app to the front
      await sleep(1000);
      try {
        execFileSync("osascript", ["-e", 'tell application "System Events" to keystroke "s" using command down']);
      } catch (e) {
        return t.skip(`can't send keystrokes on this machine: ${e.stderr ?? e.message}`);
      }
    } else {
      await fake.save();
    }
    for (let i = 0; i < 50 && !readFileSync(file, "utf8").includes("Postgres"); i++) await sleep(200);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.type, "excalidraw");
    assert.ok(saved.elements.some((e) => e.originalText === "Postgres"), "the drawing was saved to the user's file");
    assert.equal(jsonOf(await call("get_scene", { include_elements: false })).dirty, false);
  });

  await t.test("unsaved changes survive the app being killed", { skip: !REAL_APP && "needs the Mac app" }, async () => {
    jsonOf(await call("add_elements", { elements: [{ type: "text", id: "persist", x: 0, y: -120, text: "Still here after a restart" }] }));
    const before = jsonOf(await call("get_scene"));
    assert.equal(before.dirty, true);
    const onDisk = readFileSync(file, "utf8");
    execFileSync("pkill", ["-TERM", "-x", "Excalidraw"]);
    const socket = join(home, "bridge.sock");
    for (let i = 0; i < 100 && existsSync(socket); i++) await sleep(100);
    assert.equal(existsSync(socket), false, "app removed its socket on quit");
    assert.equal(readFileSync(file, "utf8"), onDisk, "quitting never writes to the user's file");

    // Opening the same file again brings the unsaved changes back (still unsaved).
    await userOpens(file);
    const after = jsonOf(await call("get_scene"));
    assert.equal(after.elementCount, before.elementCount);
    assert.ok(after.elements.some((e) => e.id === "persist" && e.text === "Still here after a restart"));
    assert.equal(after.file, file);
    assert.equal(after.dirty, true);
  });
});
