// What the real app costs (macOS CI, after ui-mac.test.mjs left a drawing open): CPU time of
// the app and its WebKit processes while nobody touches it, while the mouse just moves over
// the canvas, while panning, on a small and on a big drawing; and whether the app keeps
// putting the traffic lights back. Prints a report; it doesn't fail the build.
//   EXCALIDRAW_MAC_HOME=… node test/energy-mac.mjs
import { execFile, execFileSync } from "node:child_process";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const HOME = process.env.EXCALIDRAW_MAC_HOME;
const SECONDS = Number(process.env.SAMPLE_SECONDS ?? 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = promisify(execFile);
const osa = (script) => execFileSync("osascript", ["-e", script]).toString().trim();

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

// Compiled once, so starting it doesn't count as part of a sample.
const MOUSE = join(process.env.RUNNER_TEMP ?? tmpdir(), "mouse-bin");
execFileSync("swiftc", ["-O", fileURLToPath(new URL("./mouse.swift", import.meta.url)), "-o", MOUSE], { stdio: "inherit" });

/** CPU seconds so far of the app and every WebKit helper process, by pid. */
async function cpuTimes() {
  const out = {};
  for (const line of (await run("ps", ["-A", "-o", "pid=,time=,comm="])).stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!m || !/Excalidraw|WebKit/.test(m[3])) continue;
    const [min, sec] = m[2].split(":");
    out[m[1]] = { name: m[3].split("/").pop(), cpu: Number(min) * 60 + Number(sec) };
  }
  return out;
}

let powermetrics = true;
/** Activity Monitor's "Energy Impact" per process over the sample, when powermetrics works here. */
async function energyImpact(ms) {
  if (!powermetrics) return sleep(ms).then(() => null);
  try {
    const { stdout } = await run("sudo", ["-n", "powermetrics", "--samplers", "tasks", "--show-process-energy", "-i", String(ms), "-n", "1"], { maxBuffer: 1 << 24 });
    const lines = stdout.split("\n");
    const header = lines.find((l) => /^Name\s+ID/.test(l));
    return [header, ...lines.filter((l) => /Excalidraw|WebKit|^ALL_TASKS/.test(l))].filter(Boolean);
  } catch (e) {
    console.log("  (powermetrics not available: " + String(e.message).split("\n")[0] + ")");
    powermetrics = false;
    return null;
  }
}

async function measure(label, action) {
  const win0 = await bridge("window_info");
  const t0 = await cpuTimes();
  const [energy] = await Promise.all([energyImpact(SECONDS * 1000), action?.(SECONDS)]);
  const t1 = await cpuTimes();
  const win1 = await bridge("window_info");
  console.log(`\n=== ${label} (${SECONDS} s)`);
  let total = 0;
  for (const [pid, p] of Object.entries(t1)) {
    const used = p.cpu - (t0[pid]?.cpu ?? p.cpu);
    total += used;
    console.log(`  ${p.name.padEnd(32)} ${(used * 1000).toFixed(0).padStart(6)} ms CPU (${((used / SECONDS) * 100).toFixed(1)}% of a core)`);
  }
  console.log(`  ${"all together".padEnd(32)} ${(total * 1000).toFixed(0).padStart(6)} ms CPU (${((total / SECONDS) * 100).toFixed(1)}% of a core)`);
  console.log(
    `  traffic lights: ${win1.trafficLightPasses - win0.trafficLightPasses} passes, ` +
      `${win1.trafficLightMoves - win0.trafficLightMoves} moves`,
  );
  if (energy) console.log(energy.map((l) => "  | " + l).join("\n"));
}

const mouse = (...args) => run(MOUSE, args.map(String));

osa('tell application "Excalidraw" to activate');
await sleep(1500);
const win = await bridge("window_info");
// the middle of the canvas, below the title bar row, in screen points
const x1 = win.x + win.width * 0.3, x2 = win.x + win.width * 0.7;
const y1 = win.y + win.height * 0.35, y2 = win.y + win.height * 0.75;
const hover = (s) => mouse("hover", x1, y1, x2, y2, s);
const scroll = (s) => mouse("scroll", (x1 + x2) / 2, (y1 + y2) / 2, s);
const rest = () => mouse("click", win.x + win.width / 2, win.y + 26).then(() => sleep(3000)); // key window, nothing selected

async function scenarios(what) {
  await rest();
  await measure(`${what}: idle, mouse resting on the canvas`);
  await measure(`${what}: mouse moving over the canvas (no buttons)`, hover);
  await sleep(2000);
  await measure(`${what}: idle again after moving the mouse`);
  await measure(`${what}: panning with two fingers`, scroll);
  await sleep(2000);
  await bridge("zoom_to_fit");
  await sleep(1000);
}

console.log("elements:", (await bridge("status")).elementCount, "window", win.width, "×", win.height);
await scenarios("small drawing");

// A big drawing: 600 elements, shapes with labels, arrows and wavy lines.
const elements = [];
for (let i = 0; i < 400; i++) {
  const x = (i % 25) * 160, y = Math.floor(i / 25) * 120;
  elements.push({ type: ["rectangle", "ellipse", "diamond"][i % 3], x, y, width: 120, height: 70, label: { text: `node ${i}` } });
}
for (let i = 0; i < 150; i++) elements.push({ type: "arrow", x: (i % 25) * 160 + 120, y: Math.floor(i / 25) * 120 + 35, points: [[0, 0], [40, 0]] });
for (let i = 0; i < 50; i++) {
  const points = Array.from({ length: 40 }, (_, k) => [k * 3, Math.sin(k / 4) * 20]);
  elements.push({ type: "line", x: (i % 10) * 150, y: 2000 + Math.floor(i / 10) * 80, points });
}
elements.forEach((e, i) => (e.id = `energy-${i}`));
await bridge("add_elements", { elements });
await bridge("zoom_to_fit");
await sleep(2000);
console.log("\nelements:", (await bridge("status")).elementCount);
await scenarios("big drawing");

osa('tell application "Finder" to activate');
await sleep(2000);
await measure("big drawing: window behind Finder, idle");
await measure("big drawing: behind Finder, mouse moving over where the canvas shows", hover);
osa('tell application "Excalidraw" to activate');
// Leave the drawing as the next steps expect it.
await bridge("delete_elements", { ids: elements.map((e) => e.id) });
await bridge("zoom_to_fit");
await sleep(1000);
console.log("\nelements:", (await bridge("status")).elementCount);
