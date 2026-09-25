// Stands in for the Mac app on Linux: listens on the bridge socket like the
// Swift app does, handles the same native methods (open_file, save_file and
// the get_scene extras), and forwards everything else to the real page
// running in headless Chromium.
import { createServer } from "node:net";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { startHarness } from "./harness.mjs";

const FORWARDED = new Set([
  "ping", "diagnostics", "get_scene", "add_elements", "add_mermaid", "update_elements",
  "delete_elements", "clear_canvas", "export_image", "zoom_to_fit", "status",
]);

export async function startFakeApp(home) {
  const h = await startHarness();
  const doc = { file: null };
  const dirty = () => h.messages.filter((m) => m.type === "dirty").at(-1)?.value ?? false;

  async function handle(method, params) {
    if (method === "open_file") {
      if (dirty() && !params.discard_changes) {
        throw new Error("The canvas has unsaved changes. Save them with save_file first, or pass discard_changes: true.");
      }
      const json = await readFile(params.path, "utf8");
      const res = await h.call("load_scene_json", { json });
      if (!res.ok) throw new Error(res.error);
      doc.file = params.path;
      return { path: params.path, elementCount: res.result.elementCount };
    }
    if (method === "save_file") {
      const path = params.path ?? doc.file;
      if (!path) throw new Error("This drawing has never been saved: pass a path.");
      const res = await h.call("get_scene_json");
      await writeFile(path, res.result.json);
      await h.call("mark_saved");
      doc.file = path;
      return { path };
    }
    if (!FORWARDED.has(method)) throw new Error(`unknown method "${method}"`);
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
    async close() {
      server.close();
      await h.close();
    },
  };
}
