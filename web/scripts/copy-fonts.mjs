// Excalidraw loads its fonts at runtime from EXCALIDRAW_ASSET_PATH + "fonts/…".
// Copy them next to index.html so drawing, exporting and SVG font embedding
// all work offline.
import { cpSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
// resolves to …/@excalidraw/excalidraw/dist/prod/index.js
const src = join(dirname(require.resolve("@excalidraw/excalidraw")), "fonts");
const dest = new URL("../dist/fonts", import.meta.url).pathname;
if (!existsSync(src)) throw new Error(`fonts not found at ${src}`);
cpSync(src, dest, { recursive: true });
console.log(`copied fonts -> ${dest}`);
