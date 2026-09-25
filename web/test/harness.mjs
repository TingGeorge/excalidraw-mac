// Runs the built page (dist/) in headless Chromium the way the Mac app hosts
// it: a fake `window.webkit.messageHandlers.native` records what the page
// sends, and `call()` drives `window.excalidrawBridge` like the app does.
// Any request that leaves the local server is recorded, to prove the page
// works offline.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm",
};

export async function startHarness({ session = null, lang, init } = {}) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path === "/__native__/session") {
      if (!session) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(session));
    }
    const file = normalize(join(DIST, path === "/" ? "index.html" : path));
    if (!file.startsWith(DIST)) return res.writeHead(403).end();
    try {
      await stat(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || (process.env.PLAYWRIGHT_BROWSERS_PATH ? "/opt/pw-browsers/chromium" : undefined),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const external = [];
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
    external.push(url);
    return route.abort();
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const messages = [];
  await page.exposeFunction("__recordNative", (msg) => messages.push(msg));
  await page.addInitScript((lang) => {
    if (lang) window.__NATIVE_LANG__ = lang;
    window.webkit = { messageHandlers: { native: { postMessage: (m) => window.__recordNative(m) } } };
  }, lang);
  if (init) await page.addInitScript(init);
  await page.goto(`${origin}/index.html`);
  await waitFor(() => messages.some((m) => m.type === "ready"), 20000, "page never posted ready");

  async function call(method, params = {}) {
    const raw = await page.evaluate(
      ([m, p]) => window.excalidrawBridge.handle(m, p),
      [method, JSON.stringify(params)],
    );
    return JSON.parse(raw);
  }
  async function close() {
    await browser.close();
    server.close();
  }
  return { page, call, messages, external, errors, origin, close };
}

export async function waitFor(fn, ms = 5000, what = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}
