/** Ad-hoc page probe. node test/probe.mjs <url> <js-expression-file> */
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] || "http://127.0.0.1:8891/";
const expr = readFileSync(process.argv[3], "utf8");
const CHROME =
  process.env.CHROME_BIN ||
  "/root/.cache/ms-playwright/chromium-1148/chrome-linux/chrome";

const profile = mkdtempSync(join(tmpdir(), "probe-"));
const port = 9900 + Math.floor(Math.random() * 90);
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--window-size=1440,900",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" }
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let wsUrl;
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (r.ok) {
      wsUrl = (await r.json()).webSocketDebuggerUrl;
      break;
    }
  } catch {}
  await sleep(250);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  });

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", {
  targetId,
  flatten: true,
});
const S = (m, p) => send(m, p, sessionId);
await S("Page.enable");
await S("Runtime.enable");
const width = Number(process.env.W || 1440);
await S("Emulation.setDeviceMetricsOverride", {
  width,
  height: 900,
  deviceScaleFactor: 1,
  mobile: width < 500,
});
await S("Page.navigate", { url: BASE });
await sleep(4500);

const r = await S("Runtime.evaluate", {
  expression: expr,
  returnByValue: true,
  awaitPromise: true,
});
if (r.exceptionDetails) {
  console.log("EXCEPTION:", r.exceptionDetails.exception?.description);
} else {
  console.log(
    typeof r.result.value === "string"
      ? r.result.value
      : JSON.stringify(r.result.value, null, 2)
  );
}
ws.close();
chrome.kill("SIGKILL");
await sleep(200);
process.exit(0);
