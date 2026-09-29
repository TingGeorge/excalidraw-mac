// Emoji on the canvas stay sharp when zoomed in (macOS CI, real app with a drawing open).
// WebKit draws a colour emoji from the bitmap that fits the font size before the canvas is
// scaled, so a zoomed-in emoji came out blurry while the letters next to it were sharp.
// Zooms onto a text with an emoji and takes a screenshot (emoji-zoom.png) for the log.
//   EXCALIDRAW_MAC_HOME=… node test/emoji-mac.mjs
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";

const HOME = process.env.EXCALIDRAW_MAC_HOME;
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

execFileSync("osascript", ["-e", 'tell application "Excalidraw" to activate']);
await sleep(1000);
await bridge("add_elements", {
  elements: [{ type: "text", id: "emoji-check", x: -3000, y: -3000, text: "🔒 private repo 🙂", fontSize: 20 }],
});
await bridge("zoom_to_fit", { element_ids: ["emoji-check"] }); // centred, at 100% at most
// ⌘= (View › Zoom In) until the canvas is scaled 4× or more, like the 268% that showed it
for (let i = 0; i < 40 && (await bridge("diagnostics")).zoom < 4; i++) {
  execFileSync("osascript", ["-e", 'tell application "System Events" to keystroke "=" using command down']);
  await sleep(150);
}
await sleep(1500);
console.log("zoom", (await bridge("diagnostics")).zoom);
if (process.env.RUNNER_TEMP) execFileSync("screencapture", ["-x", join(process.env.RUNNER_TEMP, "emoji-zoom.png")]);
await bridge("delete_elements", { ids: ["emoji-check"] });
await bridge("zoom_to_fit");
await sleep(500);
