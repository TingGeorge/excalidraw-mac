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
    await waitFor(() => h.messages.some((m) => m.type === "autosave"), 6000, "autosave");
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

  await t.test("title bar row: file name, Library button, clickable areas", async () => {
    ok(await h.call("set_document_info", { name: "flow", folder: "~/Desktop" }));
    await waitFor(() => h.page.evaluate(() => document.querySelector(".mac-title .name")?.textContent === "flow"), 3000, "title");
    ok(await h.call("set_document_info", { name: "flow", folder: "~/Desktop", trafficLightsEnd: 70 }));
    await new Promise((r) => setTimeout(r, 300));
    const { rects } = ok(await h.call("diagnostics"));
    // three frosted groups: [menu button + file name] [tools] [Library + Export]
    for (const k of ["title", "toolbar", "actions"]) {
      assert.equal(rects[k].y, 8, `${k} top`);
      assert.equal(rects[k].height, 36, `${k} height`);
    }
    assert.equal(rects.title.x, 82, "12 pt after the traffic lights");
    assert.deepEqual([rects.menu.x - rects.title.x, rects.menu.y, rects.menu.width, rects.menu.height], [2, 10, 32, 32],
      "the menu button is a 32 pt button inside the group, like the tools");
    assert.ok(rects.toolbar.x - (rects.title.x + rects.title.width) >= 12, "at least 12 pt before the tools");
    const icons = await h.page.evaluate(() =>
      [".main-menu-trigger svg", ".mac-library svg", ".mac-export svg", '.App-toolbar .ToolIcon__icon svg'].map((s) => {
        const svg = document.querySelector(s);
        const r = svg.getBoundingClientRect();
        const stroke = parseFloat(getComputedStyle(svg.querySelector("path, line")).strokeWidth);
        return [r.width, Math.round((stroke * r.width / svg.viewBox.baseVal.width) * 100) / 100];
      }));
    assert.deepEqual(icons, [[16, 1], [16, 1], [16, 1], [16, 1]], "every icon in the row: 16 pt, 1 pt lines");
    assert.equal(1280 - (rects.actions.x + rects.actions.width), 16, "16 pt from the right edge");
    const holes = h.messages.filter((m) => m.type === "titlebarHoles").at(-1).rects;
    assert.ok(holes.some(([x, y, w, hgt]) => y === 8 && hgt === 36 && w > 300), "toolbar reported as clickable");
    assert.ok(holes.every(([, y]) => y < 52));
    await h.page.evaluate(() => document.querySelector(".mac-top-actions .mac-library").click());
    await waitFor(() => h.page.evaluate(() => (document.querySelector(".default-sidebar")?.innerText ?? "").includes("尚未加入")), 3000, "library content");
    await h.page.evaluate(() => document.querySelector(".mac-top-actions .mac-library").click());
    await waitFor(() => h.page.evaluate(() => !document.querySelector(".default-sidebar")), 3000, "library closed");
    ok(await h.call("set_document_info", { fullscreen: true }));
    assert.equal(await h.page.evaluate(() => document.documentElement.classList.contains("mac-fullscreen")), true);
    ok(await h.call("set_document_info", { name: "flow", folder: "~/Desktop", fullscreen: false }));
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

// The items of the UI/UX report (H1, M2, M3, M6–M8, M11, M12, L1, L3, L4, L7–L11) and the
// page side of the Edit menu (H3).
test("macOS polish", async (t) => {
  const h = await startHarness({ lang: "en" });
  t.after(() => h.close());
  const p = h.page;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = async () => {
    await p.keyboard.press("Escape");
    await wait(300);
  };
  ok(await h.call("set_document_info", { name: "uiux_test", folder: "~/Desktop", trafficLightsEnd: 70 }));
  ok(await h.call("add_elements", { elements: [
    { type: "rectangle", id: "r", x: 0, y: 0, width: 200, height: 90, label: { text: "Box 你好" } },
    { type: "ellipse", id: "e", x: 320, y: 0, width: 160, height: 90 },
    { type: "arrow", id: "a", start: { id: "r" }, end: { id: "e" } },
  ] }));
  const count = async () => ok(await h.call("get_scene")).elementCount;

  await t.test("menu: Mac shortcut symbols, an icon on every item, headings aligned (L1, L7)", async () => {
    await p.click(".main-menu-trigger");
    await wait(300);
    const menu = await p.evaluate(() => ({
      shortcuts: [...document.querySelectorAll(".dropdown-menu-item__shortcut")].map((e) => e.textContent),
      noIcon: [...document.querySelectorAll(".dropdown-menu-item")].filter((e) => !e.querySelector("svg")).map((e) => e.textContent),
      heading: document.querySelector('[data-testid="canvas-background-label"]')?.getBoundingClientRect().x
        + parseFloat(getComputedStyle(document.querySelector('[data-testid="canvas-background-label"]')).paddingLeft),
      text: document.querySelector(".dropdown-menu-item__text")?.getBoundingClientRect().x,
      icon: document.querySelector(".dropdown-menu-item__icon")?.getBoundingClientRect().x,
    }));
    assert.ok(menu.shortcuts.includes("⌘N") && menu.shortcuts.includes("⇧⌘S"), menu.shortcuts.join(" "));
    assert.ok(menu.shortcuts.every((s) => !/Ctrl|Cmd|Shift|Alt|Option|\+/.test(s)), menu.shortcuts.join(" "));
    assert.deepEqual(menu.noIcon, []);
    assert.ok(Math.abs(menu.heading - menu.icon) <= 1, `heading ${menu.heading}, icons ${menu.icon}`);
    await esc();
  });

  await t.test("command palette opens, with Mac key caps and no stray close button (H1)", async () => {
    await p.mouse.move(640, 500);
    await p.keyboard.press("ControlOrMeta+/");
    await waitFor(() => p.evaluate(() => !!document.querySelector(".command-palette-dialog")), 3000, "palette");
    await wait(300);
    const palette = await p.evaluate(() => ({
      keys: [...document.querySelectorAll(".command-palette-dialog .shortcut-key")].map((e) => e.textContent),
      close: !!document.querySelector(".Modal:has(.command-palette-dialog) .mac-dialog-close, .command-palette-dialog .mac-dialog-close"),
      items: [...document.querySelectorAll(".command-palette-dialog .command-item")].map((e) => e.textContent),
    }));
    assert.ok(palette.keys.length > 5);
    assert.ok(palette.keys.every((k) => !/^(Ctrl|Cmd|Shift|Alt)$/.test(k)), palette.keys.join(" "));
    assert.equal(palette.close, false);
    assert.ok(palette.items.some((i) => i.startsWith("Save As")), "the app's own commands are in it");
    await esc();
  });

  await t.test("dialogs: a close button, Help starts on it, room under the title bar (M3, M11, L3)", async () => {
    await p.keyboard.press("Shift+?");
    await waitFor(() => p.evaluate(() => !!document.querySelector(".HelpDialog")), 3000, "help");
    await wait(300);
    const help = await p.evaluate(() => ({
      focus: document.activeElement?.className,
      top: document.querySelector(".Modal__content").getBoundingClientRect().top,
      keys: [...document.querySelectorAll(".HelpDialog__key")].map((e) => e.textContent),
    }));
    assert.equal(help.focus, "mac-dialog-close");
    assert.ok(help.top >= 60, `dialog top ${help.top}`);
    assert.ok(help.keys.every((k) => !/^(Ctrl|Cmd|Shift|Alt|Option)$/.test(k)), help.keys.join(" "));
    await p.click(".mac-dialog-close");
    await waitFor(() => p.evaluate(() => !document.querySelector(".HelpDialog")), 3000, "help closed");
    await p.click(".mac-export");
    await waitFor(() => p.evaluate(() => !!document.querySelector(".ImageExportModal")), 3000, "export dialog");
    assert.ok(await p.evaluate(() => !!document.querySelector(".Modal__content .mac-dialog-close")));
    await p.click(".mac-dialog-close");
    await waitFor(() => p.evaluate(() => !document.querySelector(".ImageExportModal")), 3000, "export closed");
  });

  await t.test("exported files are named after the drawing (M2)", async () => {
    assert.equal(ok(await h.call("diagnostics")).exportName, "uiux_test");
  });

  await t.test("properties panel on the 16 pt edge; Align first when several are selected (M6, M8)", async () => {
    await p.mouse.click(640, 700);
    await p.keyboard.press("ControlOrMeta+a");
    await wait(400);
    const panel = await p.evaluate(() => {
      const col = document.querySelector(".App-menu__left");
      const first = [...col.querySelectorAll(".panelColumn > *")]
        .filter((e) => e.getClientRects().length)
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
      return { x: col.getBoundingClientRect().x, first: first.querySelector("legend, h3")?.textContent };
    });
    assert.equal(panel.x, 16);
    assert.equal(panel.first, "Align");
  });

  await t.test("right-click menu: 13 px text, Mac shortcuts (M12)", async () => {
    await p.mouse.click(640, 600, { button: "right" });
    await waitFor(() => p.evaluate(() => !!document.querySelector(".context-menu")), 3000, "context menu");
    const menu = await p.evaluate(() => ({
      size: getComputedStyle(document.querySelector(".context-menu-item__label")).fontSize,
      shortcuts: [...document.querySelectorAll(".context-menu-item__shortcut")].map((e) => e.textContent).filter(Boolean),
    }));
    assert.equal(menu.size, "13px");
    assert.ok(menu.shortcuts.every((s) => !/Ctrl|Cmd|Shift|Alt|Option|\+/.test(s)), menu.shortcuts.join(" "));
    await esc();
  });

  await t.test("more tools: the Generate heading lines up with the items (L8)", async () => {
    await p.click(".App-toolbar__extra-tools-trigger");
    await wait(300);
    const x = await p.evaluate(() => {
      const g = [...document.querySelectorAll(".dropdown-menu-container div")].find((d) => d.textContent === "Generate");
      const icon = document.querySelector(".dropdown-menu-container .dropdown-menu-item__icon");
      return [g.getBoundingClientRect().x + parseFloat(getComputedStyle(g).paddingLeft), icon.getBoundingClientRect().x];
    });
    assert.ok(Math.abs(x[0] - x[1]) <= 1, `heading ${x[0]}, icons ${x[1]}`);
    await esc();
  });

  await t.test("tooltips on icon buttons (M7)", async () => {
    await p.mouse.click(640, 700);
    await p.hover('.ToolIcon:has([data-testid="toolbar-rectangle"])');
    await waitFor(() => p.evaluate(() => document.querySelector(".mac-tooltip")?.style.opacity === "1"), 3000, "tooltip");
    assert.match(await p.evaluate(() => document.querySelector(".mac-tooltip").textContent), /Rectangle — R/);
    for (const sel of [".main-menu-trigger", ".mac-library", ".mac-export", ".App-toolbar__extra-tools-trigger"]) {
      assert.ok(await p.evaluate((s) => !!document.querySelector(s)?.dataset.macTip, sel), `${sel} has a tooltip`);
    }
    await p.mouse.move(640, 700);
  });

  await t.test("no-arrowhead button is not drawn as disabled (L11)", async () => {
    await p.mouse.click(640, 700);
    await p.mouse.click(660, 400); // the arrow
    await waitFor(() => p.evaluate(() => !!document.querySelector(".iconSelectList")), 3000, "arrowheads");
    const opacity = await p.evaluate(() => getComputedStyle(document.querySelector('.iconSelectList svg g[opacity="0.3"]')).opacity);
    assert.ok(Number(opacity) >= 0.8, `opacity ${opacity}`);
    await p.mouse.click(640, 700);
  });

  await t.test("the file name never runs under the tools (M1)", async () => {
    await p.setViewportSize({ width: 960, height: 600 });
    await wait(400);
    const r = await p.evaluate(() => ({
      title: document.querySelector(".mac-title").getBoundingClientRect(),
      hidden: document.querySelector(".mac-title").classList.contains("mac-hidden"),
      toolbar: document.querySelector(".App-toolbar").getBoundingClientRect(),
    }));
    assert.ok(r.hidden || r.title.right <= r.toolbar.left - 8, `title ends ${r.title.right}, tools start ${r.toolbar.left}`);
    await p.setViewportSize({ width: 1280, height: 800 });
    await wait(300);
  });

  await t.test("Edit menu on the canvas: select all, copy, paste, undo (H3)", async () => {
    await p.mouse.click(640, 700);
    const before = await count();
    ok(await h.call("edit", { action: "selectAll" }));
    await wait(200);
    await waitFor(() => h.messages.filter((m) => m.type === "editState").at(-1)?.hasSelection, 3000, "selection reported");
    const copied = ok(await h.call("edit", { action: "copy" }));
    const text = copied.clipboard["text/plain"];
    assert.match(text, /"type":\s*"excalidraw\/clipboard"/);
    await p.mouse.move(640, 600);
    ok(await h.call("edit", { action: "paste", text }));
    await waitFor(async () => (await count()) === before * 2, 3000, `pasted (${await count()} of ${before * 2})`);
    const state = h.messages.filter((m) => m.type === "editState").at(-1);
    assert.equal(state.canUndo, true);
    ok(await h.call("edit", { action: "undo" }));
    await waitFor(async () => (await count()) === before, 3000, "undone");
    ok(await h.call("edit", { action: "redo" }));
    await waitFor(async () => (await count()) === before * 2, 3000, "redone");
    ok(await h.call("edit", { action: "undo" }));
    await waitFor(async () => (await count()) === before, 3000, "undone again");
  });

  await t.test("Edit menu while typing: WebKit's own text editing (H3)", async () => {
    await p.evaluate(() => {
      const input = document.createElement("textarea");
      input.id = "probe";
      document.body.appendChild(input);
      input.focus();
    });
    assert.deepEqual(ok(await h.call("edit", { action: "copy" })), { native: true });
    await waitFor(() => h.messages.filter((m) => m.type === "editState").at(-1)?.textEditing === true, 3000, "typing reported");
    await p.evaluate(() => document.getElementById("probe").remove());
    await waitFor(() => h.messages.filter((m) => m.type === "editState").at(-1)?.textEditing === false, 3000, "typing done");
  });

  await t.test("View menu: zoom and dark mode; export follows the theme (L2, L4)", async () => {
    ok(await h.call("view", { action: "actualSize" }));
    await wait(200);
    const z0 = await p.evaluate(() => document.querySelector(".zoom-actions .reset-zoom-button")?.textContent);
    ok(await h.call("view", { action: "zoomIn" }));
    await wait(200);
    const z1 = await p.evaluate(() => document.querySelector(".zoom-actions .reset-zoom-button")?.textContent);
    assert.notEqual(z0, z1, `zoom ${z0} -> ${z1}`);
    ok(await h.call("view", { action: "actualSize" }));
    await wait(200);
    assert.equal(await p.evaluate(() => document.querySelector(".zoom-actions .reset-zoom-button")?.textContent), "100%");
    ok(await h.call("view", { action: "toggleTheme" }));
    await waitFor(() => h.messages.some((m) => m.type === "themePreference" && m.value === "dark"), 3000, "preference sent");
    const s = ok(await h.call("get_scene"));
    assert.equal(s.theme, "dark");
    await waitFor(async () => ok(await h.call("diagnostics")).exportWithDarkMode === true, 3000, "dark export");
    ok(await h.call("set_theme_preference", { preference: "light" }));
    await waitFor(async () => ok(await h.call("get_scene")).theme === "light", 3000, "light again");
  });

  await t.test("agents' hand-drawn text uses Excalifont (Chinese falls back to Xiaolai) (L10)", async () => {
    const res = ok(await h.call("add_elements", { elements: [{ type: "text", id: "zh", x: 0, y: 300, text: "你好 hello", fontFamily: 1 }] }));
    const el = JSON.parse(ok(await h.call("get_scene_json")).json).elements.find((e) => e.id === "zh");
    assert.equal(el.fontFamily, 5, JSON.stringify(res));
  });

  await t.test("offline and no page errors", () => {
    assert.deepEqual(h.external, []);
    assert.deepEqual(h.errors, []);
  });
});

// WebKit has no canvas filters: the page brings its own, so the export dialog still offers
// "Dark mode" and dark PNGs come out dark (L4).
test("dark export without canvas filters (WebKit)", async (t) => {
  const h = await startHarness({ lang: "en", init: () => delete CanvasRenderingContext2D.prototype.filter });
  t.after(() => h.close());
  const p = h.page;
  assert.equal(await p.evaluate(() => Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, "filter")?.get?.name ?? ""), "get");
  const pixel = await p.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 4;
    const ctx = canvas.getContext("2d");
    ctx.filter = "invert(93%) hue-rotate(180deg)";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 4, 4);
    const img = new Image();
    img.src = canvas.toDataURL("image/png");
    await img.decode();
    const out = document.createElement("canvas");
    out.width = out.height = 4;
    const o = out.getContext("2d");
    o.drawImage(img, 0, 0);
    return [...o.getImageData(1, 1, 1, 1).data];
  });
  assert.deepEqual(pixel.slice(0, 3).map((v) => Math.abs(v - 18) <= 1), [true, true, true], `white became ${pixel}`);
  ok(await h.call("add_elements", { elements: [{ type: "rectangle", x: 0, y: 0, width: 100, height: 60 }] }));
  ok(await h.call("set_theme_preference", { preference: "dark" }));
  ok(await h.call("open_export_dialog"));
  await waitFor(() => p.evaluate(() => !!document.querySelector(".ImageExportModal")), 3000, "export dialog");
  await new Promise((r) => setTimeout(r, 500));
  const dialog = await p.evaluate(() => ({
    text: document.querySelector(".ImageExportModal").innerText,
    preview: getComputedStyle(document.querySelector(".ImageExportModal canvas")).filter,
  }));
  assert.match(dialog.text, /Dark mode/);
  assert.match(dialog.preview, /invert/);
  assert.deepEqual(h.errors, []);
});

// Smooth and light on the Mac: an idle page that sleeps, trackpad pinch (Safari's gesture
// events) that draws from cached bitmaps, a recovery copy that isn't rewritten on every pause.
test("smooth and light", async (t) => {
  const h = await startHarness({ lang: "en" });
  t.after(() => h.close());
  const p = h.page;
  ok(await h.call("add_elements", { elements: [{ type: "rectangle", x: 0, y: 0, width: 200, height: 80, label: { text: "流程" } }] }));
  /** requestAnimationFrame calls during `ms`: 0 means the page lets the Mac idle. */
  const frameRequests = (ms) =>
    p.evaluate((ms) => new Promise((resolve) => {
      const raf = window.requestAnimationFrame;
      let n = 0;
      window.requestAnimationFrame = (cb) => (n++, raf(cb));
      setTimeout(() => {
        window.requestAnimationFrame = raf;
        resolve(n);
      }, ms);
    }), ms);

  await t.test("the page sleeps when nothing moves", async () => {
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(await frameRequests(1000), 0);
  });

  await t.test("the laser pointer still draws its trail, then the page sleeps again", async () => {
    await p.mouse.click(640, 600);
    await p.keyboard.press("k");
    await p.mouse.move(500, 500);
    await p.mouse.down();
    for (let i = 1; i <= 10; i++) await p.mouse.move(500 + i * 20, 500 + i * 5);
    const trail = await p.evaluate(() => [...document.querySelectorAll(".excalidraw svg path")].some((e) => (e.getAttribute("d") ?? "").length > 20));
    await p.mouse.up();
    assert.ok(trail, "laser trail drawn");
    await p.keyboard.press("Escape");
    await p.keyboard.press("v");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await frameRequests(1000), 0);
  });

  await t.test("pinch: one zoom step per frame, sharp again when the fingers rest or lift", async () => {
    await p.mouse.move(640, 400);
    const r = await p.evaluate(async () => {
      const diag = async () => JSON.parse(await window.excalidrawBridge.handle("diagnostics", "")).result;
      const frame = () => new Promise((f) => requestAnimationFrame(() => requestAnimationFrame(f)));
      const canvas = document.querySelector("canvas.interactive");
      let steps = 0;
      document.addEventListener("gesturechange", () => steps++);
      const fire = (type, scale) => {
        const e = new Event(type, { bubbles: true, cancelable: true });
        e.scale = scale;
        canvas.dispatchEvent(e);
      };
      const start = (await diag()).zoom;
      fire("gesturestart", 1);
      for (const scale of [1.1, 1.2, 1.3, 1.4, 1.5]) fire("gesturechange", scale); // one frame's worth
      const sameFrame = steps;
      await frame();
      const moving = await diag();
      const stepsAfterFrame = steps;
      await new Promise((f) => setTimeout(f, 300));
      const resting = await diag();
      fire("gesturechange", 1.6);
      fire("gestureend", 1.6); // lifted before the next frame: the last step still counts
      await frame();
      const lifted = await diag();
      return { start, sameFrame, stepsAfterFrame, moving, resting, lifted };
    });
    assert.equal(r.sameFrame, 0, "no zoom step before the frame");
    assert.equal(r.stepsAfterFrame, 1, "one zoom step for the frame");
    assert.ok(Math.abs(r.moving.zoom - r.start * 1.5) < 0.01, `zoom ${r.moving.zoom} from ${r.start}`);
    assert.equal(r.moving.zoomFromCache, true, "cached bitmaps while moving");
    assert.equal(r.resting.zoomFromCache, false, "sharp when the fingers rest");
    assert.ok(Math.abs(r.lifted.zoom - r.start * 1.6) < 0.01, `zoom ${r.lifted.zoom} from ${r.start}`);
    assert.equal(r.lifted.zoomFromCache, false, "sharp when the fingers lift");
  });

  await t.test("recovery copy: after a pause of a few seconds, or right away when the window loses focus", async () => {
    await new Promise((r) => setTimeout(r, 3500)); // let earlier changes be written
    const count = () => h.messages.filter((m) => m.type === "autosave").length;
    const before = count();
    ok(await h.call("add_elements", { elements: [{ type: "ellipse", x: 300, y: 0, width: 100, height: 100 }] }));
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(count(), before, "not written during a short pause");
    await p.evaluate(() => window.dispatchEvent(new Event("blur")));
    await waitFor(() => count() === before + 1, 1000, "autosave on blur");
    await p.evaluate(() => window.dispatchEvent(new Event("blur")));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(count(), before + 1, "nothing new to write");
  });

  assert.deepEqual(h.errors, []);
});

// WebKit stretches a colour emoji's bitmap when the canvas is scaled (blurry when zoomed in), so
// text with an emoji is drawn at its on-screen size with the scale taken out (canvasEmoji.ts).
test("emoji drawn at their on-screen size", async (t) => {
  const h = await startHarness({ lang: "en" });
  t.after(() => h.close());
  const r = await h.page.evaluate(() => {
    const canvas = (w, h) => Object.assign(document.createElement("canvas"), { width: w, height: h }).getContext("2d");
    const pixels = (ctx) => ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data.join();
    // Excalidraw's way: element font size, canvas scaled by zoom × pixel ratio, rotated too
    const a = canvas(400, 200);
    a.translate(20, 10);
    a.rotate(0.1);
    a.scale(5, 5);
    a.font = "20px sans-serif";
    a.fillStyle = "#1e1e1e";
    a.textBaseline = "top";
    const before = { font: a.font, t: a.getTransform().toString() };
    a.fillText("🔒 repo", 2, 3);
    const after = { font: a.font, t: a.getTransform().toString() };
    // by hand: 100 px font, no scale in the transform, the position scaled
    const b = canvas(400, 200);
    b.translate(20, 10);
    b.rotate(0.1);
    b.font = "100px sans-serif";
    b.fillStyle = "#1e1e1e";
    b.textBaseline = "top";
    b.fillText("🔒 repo", 10, 15);
    // without an emoji nothing changes (this build's Chromium draws both the same anyway)
    const c = canvas(400, 200);
    c.scale(5, 5);
    c.font = "20px sans-serif";
    c.fillText("repo", 2, 3);
    return { same: pixels(a) === pixels(b), drawn: pixels(a) !== pixels(canvas(400, 200)), before, after, plain: pixels(c) !== pixels(canvas(400, 200)) };
  });
  assert.ok(r.drawn, "something was drawn");
  assert.ok(r.same, "same pixels as drawing at 100 px without the scale");
  assert.deepEqual(r.after, r.before, "font and transform restored");
  assert.ok(r.plain, "text without emoji still drawn");
  assert.deepEqual(h.errors, []);
});
