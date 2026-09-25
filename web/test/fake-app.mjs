// Stands in for the Mac app on Linux: listens on the bridge socket like the
// Swift app does, applies the same rules (agents only work on an open drawing
// and can't open or save files), and forwards canvas operations to the real
// page running in headless Chromium. openFile() and save() play the user's
// part (File > Open, ⌘S).
import { createServer } from "node:net";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { startHarness } from "./harness.mjs";

const ANYTIME = new Set(["ping", "diagnostics", "status"]);
const FORWARDED = new Set([
  ...ANYTIME, "get_scene", "add_elements", "add_mermaid", "update_elements",
  "delete_elements", "clear_canvas", "export_image", "zoom_to_fit",
]);

export async function startFakeApp(home) {
  const h = await startHarness();
  const doc = { file: null };
  const dirty = () => h.messages.filter((m) => m.type === "dirty").at(-1)?.value ?? false;

  async function handle(method, params) {
    if (!FORWARDED.has(method)) throw new Error(`unknown method "${method}"`);
    if (!ANYTIME.has(method) && !doc.file) {
      throw new Error("No drawing is open in Excalidraw. Ask the user to create a new file (File > New File…) or open one in the app, then try again.");
    }
    const res = await h.call(method, params);
    if (!res.ok) throw new Error(res.error);
    if (method === "get_scene") return { ...res.result, file: doc.file, dirty: dirty() };
    return res.result;
  }

  const socketPath = join(home, "bridge.sock");
  await rm(socketPath, { force: true });
  const server = createServer((sock) => {
    let buf = "";
    sock.on("data", async (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const { id, method, params } = JSON.parse(line);
        try {
          sock.write(JSON.stringify({ id, ok: true, result: await handle(method, params ?? {}) }) + "\n");
        } catch (e) {
          sock.write(JSON.stringify({ id, ok: false, error: e.message }) + "\n");
        }
      }
    });
  });
  await new Promise((r) => server.listen(socketPath, r));
  return {
    harness: h,
    /** The user opens a file (File > Open…). */
    async openFile(path) {
      const res = await h.call("load_scene_json", { json: await readFile(path, "utf8") });
      if (!res.ok) throw new Error(res.error);
      doc.file = path;
    },
    /** The user presses ⌘S. */
    async save() {
      const res = await h.call("get_scene_json");
      await writeFile(doc.file, res.result.json);
      await h.call("mark_saved");
    },
    async close() {
      server.close();
      await h.close();
    },
  };
}
