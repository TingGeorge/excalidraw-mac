// End-to-end test of the excalidraw-mcp binary with the official MCP client SDK.
//
//   Linux (no Mac app): MCP_BIN=path/to/excalidraw-mcp node --test test/mcp.test.mjs
//     -> a fake app (test/fake-app.mjs) serves the bridge socket with the real page.
//   macOS CI:           MCP_BIN=… EXCALIDRAW_APP_PATH=…/Excalidraw.app REAL_APP=1 node --test …
//     -> the MCP server starts the real app itself, exactly as it would for an agent.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MCP_BIN = process.env.MCP_BIN && resolve(process.env.MCP_BIN);
const REAL_APP = process.env.REAL_APP === "1";

const textOf = (res) => res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const jsonOf = (res) => {
  assert.ok(!res.isError, `tool error: ${textOf(res)}`);
  return JSON.parse(textOf(res));
};

test("excalidraw-mcp end to end", { skip: !MCP_BIN && "set MCP_BIN" }, async (t) => {
  // Keep the socket path short: macOS limits Unix socket paths to 104 bytes.
  const home = process.env.EXCALIDRAW_MAC_HOME || mkdtempSync(join(REAL_APP ? "/tmp" : tmpdir(), "exm-"));
  const work = mkdtempSync(join(tmpdir(), "exm-work-"));
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

  await t.test("handshake and tool list", async () => {
    assert.equal(client.getServerVersion().name, "excalidraw-mac");
    assert.match(client.getInstructions(), /get_scene/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((x) => x.name).sort(), [
      "add_elements", "add_mermaid", "clear_canvas", "delete_elements", "export_image",
      "get_scene", "open_file", "save_file", "update_elements", "zoom_to_fit",
    ]);
    for (const tool of tools) assert.equal(tool.inputSchema.type, "object");
  });

  await t.test("empty canvas (starts the app if needed)", async () => {
    const scene = jsonOf(await call("get_scene"));
    assert.equal(scene.elementCount, 0);
    assert.equal(scene.file, null);
  });

  await t.test("draw with mermaid and elements", async () => {
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
    const scene = jsonOf(await call("get_scene"));
    const q = scene.elements.find((e) => e.id === "q");
    assert.equal(q.start, "api");
    assert.equal(q.end, "db");
    assert.equal(scene.dirty, true);
  });

  await t.test("edit and errors are reported to the agent", async () => {
    jsonOf(await call("update_elements", { updates: [{ id: "db", text: "Postgres", y: 420 }] }));
    const db = jsonOf(await call("get_scene")).elements.find((e) => e.id === "db");
    assert.equal(db.label, "Postgres");
    assert.equal(db.y, 420);
    const bad = await call("update_elements", { updates: [{ id: "missing", x: 1 }] });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /no element with id "missing"/);
    const unknown = await call("no_such_tool");
    assert.equal(unknown.isError, true);
  });

  await t.test("export: image back to the agent, and files", async () => {
    const res = await call("export_image");
    assert.ok(!res.isError, textOf(res));
    const img = res.content.find((c) => c.type === "image");
    assert.equal(img.mimeType, "image/png");
    assert.equal(Buffer.from(img.data, "base64").subarray(1, 4).toString(), "PNG");

    const png = await call("export_image", { path: "out/diagram.png" });
    assert.ok(!png.isError, textOf(png));
    assert.equal(png.content.some((c) => c.type === "image"), false);
    const bytes = readFileSync(join(work, "out/diagram.png"));
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    assert.ok(bytes.readUInt32BE(16) > 400, "scale 2 by default for files");

    const svg = await call("export_image", { format: "svg", path: join(work, "out/diagram.svg"), element_ids: ["api"] });
    assert.ok(!svg.isError, textOf(svg));
    assert.match(readFileSync(join(work, "out/diagram.svg"), "utf8"), /<svg[\s\S]*API/);
  });

  await t.test("save, then open with unsaved-changes protection", async () => {
    const saved = await call("save_file", { path: "saved/flow" });
    assert.ok(!saved.isError, textOf(saved));
    const file = join(work, "saved/flow.excalidraw");
    assert.ok(existsSync(file));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).type, "excalidraw");
    let scene = jsonOf(await call("get_scene"));
    assert.equal(scene.file, file);
    assert.equal(scene.dirty, false);
    const count = scene.elementCount;

    jsonOf(await call("clear_canvas"));
    assert.equal(jsonOf(await call("get_scene")).elementCount, 0);
    const refused = await call("open_file", { path: file });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /unsaved changes/);
    jsonOf(await call("open_file", { path: file, discard_changes: true }));
    scene = jsonOf(await call("get_scene"));
    assert.equal(scene.elementCount, count);
    assert.equal(scene.dirty, false);

    const missing = await call("open_file", { path: "nope.excalidraw" });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /no such file/);
  });

  await t.test("zoom_to_fit", async () => {
    jsonOf(await call("zoom_to_fit", { element_ids: ["api"] }));
  });

  await t.test("the canvas survives quitting the app", { skip: !REAL_APP && "needs the Mac app" }, async () => {
    jsonOf(await call("add_elements", { elements: [{ type: "text", id: "persist", x: 0, y: -120, text: "Still here after a restart" }] }));
    const before = jsonOf(await call("get_scene"));
    assert.equal(before.dirty, true);
    execFileSync("pkill", ["-TERM", "-x", "Excalidraw"]);
    const socket = join(home, "bridge.sock");
    for (let i = 0; i < 100 && existsSync(socket); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(existsSync(socket), false, "app removed its socket on quit");
    const autosave = JSON.parse(readFileSync(join(home, "autosave.excalidraw"), "utf8"));
    assert.ok(autosave.elements.some((e) => e.id === "persist"), "autosaved on quit");

    // The next call starts the app again, which restores the canvas, file and unsaved state.
    const after = jsonOf(await call("get_scene"));
    assert.equal(after.elementCount, before.elementCount);
    assert.ok(after.elements.some((e) => e.id === "persist" && e.text === "Still here after a restart"));
    assert.equal(after.file, before.file);
    assert.equal(after.dirty, true);
  });
});
