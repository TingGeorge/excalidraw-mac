// Debug helper: call the running app's bridge directly.
//   node test/bridge-call.mjs <socket> <method> ['{"json":"params"}']
import { connect } from "node:net";

const [socketPath, method, params = "{}"] = process.argv.slice(2);
const sock = connect(socketPath, () => {
  sock.write(JSON.stringify({ id: 1, method, params: JSON.parse(params) }) + "\n");
});
let buf = "";
sock.on("data", (d) => {
  buf += d;
  if (buf.includes("\n")) {
    console.log(JSON.stringify(JSON.parse(buf), null, 2));
    sock.end();
  }
});
setTimeout(() => {
  console.error("no reply within 30 s");
  process.exit(1);
}, 30000).unref();
