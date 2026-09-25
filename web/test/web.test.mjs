// End-to-end tests of the bridge operations in the real built page.
// Run: npm run build && npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { startHarness, waitFor } from "./harness.mjs";

const ok = (res) => {
  assert.equal(res.ok, true, `bridge error: ${res.error}`);
  return res.result;
};

test("bridge operations", async (t) => {
  const h = await startHarness({ lang: "zh-Hant-TW" });
  t.after(() => h.close());

  await t.test("ready and empty", async () => {
    const scene = ok(await h.call("get_scene"));
    assert.equal(scene.elementCount, 0);
    assert.equal(scene.bounds, null);
  });

  await t.test("uses the system language", async () => {
    assert.equal(await h.page.evaluate(() => document.documentElement.lang), "zh-TW");
  });

  await t.test("add shapes, labels and arrows by id", async () => {
    const res = ok(
      await h.call("add_elements", {
        elements: [
          { type: "rectangle", id: "a", x: 0, y: 0, width: 200, height: 80, label: { text: "Start" }, backgroundColor: "#a5d8ff" },
          { type: "ellipse", id: "b", x: 400, y: 0, width: 160, height: 100, label: { text: "End" } },
          { type: "arrow", id: "ab", start: { id: "a" }, end: { id: "b" }, label: { text: "go" } },
          { type: "text", id: "note", x: 0, y: 200, text: "hello 你好" },
        ],
      }),
    );
    assert.deepEqual(res.created.map((e) => e.id).sort(), ["a", "ab", "b", "note"]);
    const scene = ok(await h.call("get_scene"));
    const byId = Object.fromEntries(scene.elements.map((e) => [e.id, e]));
    assert.equal(byId.a.label, "Start");
    assert.equal(byId.b.label, "End");
    assert.equal(byId.ab.label, "go");
    assert.equal(byId.ab.start, "a");
    assert.equal(byId.ab.end, "b");
    assert.deepEqual(byId.a.arrowIds, ["ab"]);
    assert.deepEqual(byId.b.arrowIds, ["ab"]);
    // routed from the right edge of a to the left edge of b
    assert.ok(byId.ab.x > 200 && byId.ab.x < 215, `arrow starts at ${byId.ab.x}`);
    assert.ok(byId.ab.x + byId.ab.points[1][0] < 400, "arrow ends before b");
    assert.equal(byId.note.text, "hello 你好");
    assert.equal(scene.elementCount, 4); // bound labels are folded into their containers
  });

  await t.test("arrow to an element from an earlier call", async () => {
    ok(
      await h.call("add_elements", {
        elements: [
          { type: "diamond", id: "c", x: 400, y: 250, width: 160, height: 120, label: { text: "Check?" } },
          { type: "arrow", id: "bc", start: { id: "b" }, end: { id: "c" } },
        ],
      }),
    );
    const byId = Object.fromEntries(ok(await h.call("get_scene")).elements.map((e) => [e.id, e]));
    assert.equal(byId.bc.start, "b");
    assert.deepEqual(byId.b.arrowIds.sort(), ["ab", "bc"]);
  });

  await t.test("rejects bad input", async () => {
    const dup = await h.call("add_elements", { elements: [{ type: "rectangle", id: "a", x: 0, y: 0 }] });
    assert.equal(dup.ok, false);
    assert.match(dup.error, /already used/);
    const missing = await h.call("add_elements", { elements: [{ type: "arrow", start: { id: "nope" }, end: { id: "a" } }] });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /unknown element "nope"/);
    const unknown = await h.call("does_not_exist");
    assert.match(unknown.error, /unknown method/);
    assert.equal(ok(await h.call("get_scene")).elementCount, 6, "failed calls change nothing");
  });

  await t.test("update: move a shape, arrows and label follow; change label text", async () => {
    const before = Object.fromEntries(ok(await h.call("get_scene")).elements.map((e) => [e.id, e]));
    ok(await h.call("update_elements", { updates: [{ id: "a", x: 0, y: 300 }, { id: "b", label: "Finish line", backgroundColor: "#ffc9c9" }] }));
    const after = Object.fromEntries(ok(await h.call("get_scene")).elements.map((e) => [e.id, e]));
    assert.equal(after.a.y, 300);
    assert.notDeepEqual(after.ab.points, before.ab.points, "arrow re-routed");
    assert.ok(after.ab.y > before.ab.y, "arrow start moved down with a");
    assert.equal(after.b.label, "Finish line");
    assert.equal(after.b.backgroundColor, "#ffc9c9");
    const json = JSON.parse(ok(await h.call("get_scene_json")).json);
    const rect = json.elements.find((e) => e.id === "a");
    const text = json.elements.find((e) => e.containerId === "a");
    assert.ok(text.y > rect.y && text.y + text.height < rect.y + rect.height, "label is inside the moved rectangle");
    const bLabel = json.elements.find((e) => e.containerId === "b");
    assert.equal(bLabel.originalText, "Finish line");
  });

  await t.test("mermaid", async () => {
    const before = ok(await h.call("get_scene"));
    const res = ok(
      await h.call("add_mermaid", {
        definition: "flowchart LR\n  A[Plan] --> B{Works?}\n  B -->|yes| C[Ship]\n  B -->|no| A",
      }),
    );
    assert.ok(res.created.length >= 5, `created ${res.created.length}`);
    assert.ok(res.bounds.x > before.bounds.x + before.bounds.width, "placed right of existing content");
    const labels = ok(await h.call("get_scene")).elements.map((e) => e.label).filter(Boolean);
    for (const l of ["Plan", "Works?", "Ship"]) assert.ok(labels.includes(l), `missing ${l}`);
    const bad = await h.call("add_mermaid", { definition: "flowchart LR\n A --> " });
    assert.equal(bad.ok, false);
  });

  await t.test("export png and svg", async () => {
    const png = ok(await h.call("export_image", { format: "png", scale: 2 }));
    assert.equal(png.mimeType, "image/png");
    const bytes = Buffer.from(png.base64, "base64");
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    assert.equal(bytes.readUInt32BE(16), png.width);
    assert.ok(png.width > 500, `width ${png.width}`);
    const svg = ok(await h.call("export_image", { format: "svg", element_ids: ["a"] }));
    assert.match(svg.text, /^<svg/);
    assert.match(svg.text, /Start/);
    assert.match(svg.text, /@font-face/, "fonts are embedded in the SVG");
    const empty = await h.call("export_image", { element_ids: ["zzz"] });
    assert.equal(empty.ok, false);
  });

  await t.test("delete unbinds arrows", async () => {
    ok(await h.call("delete_elements", { ids: ["c"] }));
    const byId = Object.fromEntries(ok(await h.call("get_scene")).elements.map((e) => [e.id, e]));
    assert.equal(byId.c, undefined);
    assert.equal(byId.bc.end, undefined);
    assert.equal(byId.bc.start, "b");
  });

  await t.test("dirty tracking and save/load round trip", async () => {
    await waitFor(() => h.messages.some((m) => m.type === "dirty" && m.value === true), 3000, "dirty=true");
    ok(await h.call("mark_saved"));
    assert.equal(h.messages.filter((m) => m.type === "dirty").at(-1).value, false);
    const json = ok(await h.call("get_scene_json")).json;
    const count = ok(await h.call("get_scene")).elementCount;
    ok(await h.call("clear_canvas"));
    assert.equal(ok(await h.call("get_scene")).elementCount, 0);
    await waitFor(() => h.messages.filter((m) => m.type === "dirty").at(-1).value === true, 3000, "dirty after clear");
    ok(await h.call("load_scene_json", { json }));
    assert.equal(ok(await h.call("get_scene")).elementCount, count);
    assert.equal(h.messages.filter((m) => m.type === "dirty").at(-1).value, false);
    assert.equal(ok(await h.call("status")).dirty, false);
  });

  await t.test("autosave", async () => {
    await waitFor(() => h.messages.some((m) => m.type === "autosave"), 3000, "autosave");
    const last = h.messages.filter((m) => m.type === "autosave").at(-1);
    assert.equal(JSON.parse(last.scene).type, "excalidraw");
    assert.ok(["light", "dark"].includes(last.theme));
  });

  await t.test("fonts load locally", async () => {
    const d = ok(await h.call("diagnostics"));
    assert.ok(d.loadedFonts.includes("Excalifont"), `loaded: ${d.loadedFonts}`);
    assert.ok(d.loadedFonts.includes("Xiaolai"), "CJK handwriting font for 你好");
  });

  await t.test("window appearance, library toggle, agent indicator", async () => {
    const appearance = h.messages.filter((m) => m.type === "appearance").at(-1);
    assert.deepEqual(appearance, { type: "appearance", theme: "light", background: "#ffffff" });
    ok(await h.call("toggle_library"));
    await waitFor(() => h.page.evaluate(() => !!document.querySelector(".default-sidebar")), 3000, "library sidebar");
    ok(await h.call("toggle_library"));
    ok(await h.call("set_agent_status", { connected: true }));
    await waitFor(() => h.page.evaluate(() => document.querySelector(".agent-status")?.textContent === "AI Agent 已連線"), 3000, "agent pill");
    ok(await h.call("set_agent_status", { connected: false }));
    await waitFor(() => h.page.evaluate(() => !document.querySelector(".agent-status")), 3000, "agent pill hidden");
    // no number badges or hint line in the macOS look
    assert.equal(await h.page.evaluate(() => getComputedStyle(document.querySelector(".ToolIcon__keybinding")).display), "none");
  });

  await t.test("thumbnail export respects max_size", async () => {
    const png = ok(await h.call("export_image", { format: "png", max_size: 200 }));
    assert.ok(Math.max(png.width, png.height) <= 200, `${png.width}x${png.height}`);
  });

  await t.test("offline: nothing was fetched from the internet", () => {
    assert.deepEqual(h.external, []);
    assert.deepEqual(h.errors, []);
  });
});

test("restores the saved session", async (t) => {
  const scene = {
    type: "excalidraw",
    version: 2,
    elements: [
      { id: "r1", type: "rectangle", x: 10, y: 10, width: 100, height: 50, angle: 0, strokeColor: "#1e1e1e",
        backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1,
        opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 3, versionNonce: 1,
        isDeleted: false, boundElements: null, updated: 1, link: null, locked: false },
    ],
    appState: { viewBackgroundColor: "#fff9db" },
    files: {},
  };
  const h = await startHarness({ session: { scene, theme: "dark", dirty: true, library: null } });
  t.after(() => h.close());
  const s = ok(await h.call("get_scene"));
  assert.equal(s.elementCount, 1);
  assert.equal(s.elements[0].id, "r1");
  assert.equal(s.theme, "dark");
  const appearance = h.messages.filter((m) => m.type === "appearance").at(-1);
  assert.equal(appearance.background, "#1e1900", "matches the pixel Excalidraw draws for #fff9db in dark mode");
  assert.equal(s.viewBackgroundColor, "#fff9db");
  assert.equal(await h.page.evaluate(() => document.documentElement.lang), "en");
  // dirty: true from the session survives until the next save
  ok(await h.call("add_elements", { elements: [{ type: "text", x: 0, y: 100, text: "x" }] }));
  await waitFor(() => h.messages.some((m) => m.type === "dirty" && m.value === true), 3000, "dirty");
  assert.deepEqual(h.external, []);
});
