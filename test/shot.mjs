/**
 * Screenshot helper — drives headless Chrome over CDP using only Node built-ins.
 * Usage: node test/shot.mjs <url> <out.png> [--full] [--width=1440] [--height=1000] [--scroll=N]
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const url = args[0];
const out = args[1] || "shot.png";
const full = args.includes("--full");
const width = Number((args.find((a) => a.startsWith("--width=")) || "--width=1440").split("=")[1]);
const height = Number((args.find((a) => a.startsWith("--height=")) || "--height=1000").split("=")[1]);
const scroll = Number((args.find((a) => a.startsWith("--scroll=")) || "--scroll=0").split("=")[1]);
const scale = Number((args.find((a) => a.startsWith("--scale=")) || "--scale=1").split("=")[1]);
const dark = args.includes("--dark");

const CHROME =
  process.env.CHROME_BIN ||
  "/root/.cache/ms-playwright/chromium-1148/chrome-linux/chrome";

const profile = mkdtempSync(join(tmpdir(), "shot-"));
const port = 9500 + Math.floor(Math.random() * 400);

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    `--window-size=${width},${height}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPort() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error("chrome did not start");
}

const wsUrl = await waitForPort();
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};

function send(method, params = {}, sessionId) {
  const msgId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
  });
}

// Attach to a fresh page target.
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);

await S("Page.enable");
await S("Runtime.enable");
await S("Emulation.setDeviceMetricsOverride", {
  width,
  height,
  deviceScaleFactor: scale,
  mobile: false,
});
if (dark) {
  await S("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
}

await S("Page.navigate", { url });
await sleep(3500);

if (scroll > 0) {
  // html has scroll-behavior: smooth, so scrollTo animates and a screenshot
  // taken right after lands mid-flight. Jump instantly instead.
  await S("Runtime.evaluate", {
    expression: `(() => {
      const prev = document.documentElement.style.scrollBehavior;
      document.documentElement.style.scrollBehavior = 'auto';
      window.scrollTo(0, ${scroll});
      document.documentElement.style.scrollBehavior = prev;
      return window.scrollY;
    })()`,
    awaitPromise: true,
  });
  await sleep(1200);
}

let clip;
if (full) {
  const { cssContentSize } = await S("Page.getLayoutMetrics");
  clip = {
    x: 0,
    y: 0,
    width,
    height: Math.min(Math.ceil(cssContentSize.height), 12000),
    scale: 1,
  };
}

const { data } = await S("Page.captureScreenshot", {
  format: "png",
  captureBeyondViewport: full,
  ...(clip ? { clip } : {}),
});

writeFileSync(out, Buffer.from(data, "base64"));
console.log(`wrote ${out}`);
ws.close();
chrome.kill("SIGKILL");
process.exit(0);
