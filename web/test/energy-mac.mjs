// What the real app costs while nobody touches it (macOS CI, after ui-mac.test.mjs left a
// drawing open): CPU time and wakeups of the app and its WebKit processes, and whether the
// app keeps putting the traffic lights back. Prints a report; it doesn't fail the build.
//   EXCALIDRAW_MAC_HOME=… node test/energy-mac.mjs
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";

const HOME = process.env.EXCALIDRAW_MAC_HOME;
const SECONDS = Number(process.env.IDLE_SECONDS ?? 15);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args) => execFileSync(cmd, args).toString();

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

/** CPU seconds so far of the app and every WebKit helper process, by pid. */
function cpuTimes() {
  const out = {};
  for (const line of sh("ps", ["-A", "-o", "pid=,time=,comm="]).split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!m || !/Excalidraw|WebKit/.test(m[3])) continue;
    const [min, sec] = m[2].split(":");
    out[m[1]] = { name: m[3].split("/").pop(), cpu: Number(min) * 60 + Number(sec) };
  }
  return out;
}

async function measure(label) {
  // Idle the way a user leaves it: nothing moves, nothing was clicked for a moment.
  await sleep(3000);
  const win0 = await bridge("window_info");
  const t0 = cpuTimes();
  // top's second sample covers the interval: %CPU, idle wakeups and Energy Impact per process.
  const top = sh("top", ["-l", "2", "-s", String(SECONDS), "-o", "power", "-n", "12", "-stats", "pid,command,cpu,idlew,power"]);
  const t1 = cpuTimes();
  const win1 = await bridge("window_info");
  console.log(`\n=== ${label} (${SECONDS} s)`);
  for (const [pid, p] of Object.entries(t1)) {
    const used = p.cpu - (t0[pid]?.cpu ?? p.cpu);
    console.log(`  ${p.name.padEnd(40)} pid ${pid.padEnd(6)} ${(used * 1000).toFixed(0).padStart(6)} ms CPU (${((used / SECONDS) * 100).toFixed(2)}%)`);
  }
  console.log(
    `  traffic lights: ${win1.trafficLightPasses - win0.trafficLightPasses} passes, ` +
      `${win1.trafficLightMoves - win0.trafficLightMoves} moves (window ${win1.visible ? "visible" : "hidden"})`,
  );
  const samples = top.split(/^Processes:/m);
  console.log("  top, second sample (sorted by Energy Impact):");
  console.log(
    samples
      .at(-1)
      .split("\n")
      .filter((l) => /^\s*PID|^\s*\d+\s/.test(l))
      .map((l) => "    " + l)
      .join("\n"),
  );
}

const osa = (script) => execFileSync("osascript", ["-e", script]).toString().trim();

console.log("diagnostics", JSON.stringify(await bridge("diagnostics")).slice(0, 400));
osa('tell application "Excalidraw" to activate');
await measure("drawing window in front, idle");
osa('tell application "Finder" to activate');
await measure("drawing window behind Finder, idle");
osa('tell application "System Events" to tell process "Excalidraw" to set value of attribute "AXMinimized" of window 1 to true');
await measure("drawing window minimised, idle");
osa('tell application "System Events" to tell process "Excalidraw" to set value of attribute "AXMinimized" of window 1 to false');
osa('tell application "Excalidraw" to activate');
await sleep(1000);
