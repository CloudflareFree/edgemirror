/**
 * Browser E2E — drives the real page in headless Chrome over CDP.
 * Verifies conversion logic, node switching, tabs, and copy behaviour.
 *
 *   node test/e2e.mjs [baseUrl]
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] || "http://127.0.0.1:8891";
const CHROME =
  process.env.CHROME_BIN ||
  "/root/.cache/ms-playwright/chromium-1148/chrome-linux/chrome";

let pass = 0;
let fail = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` \x1b[2m${detail}\x1b[0m` : ""}`);
  } else {
    fail++;
    failures.push(`${name} ${detail}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name} \x1b[31m${detail}\x1b[0m`);
  }
};

const profile = mkdtempSync(join(tmpdir(), "e2e-"));
const port = 9700 + Math.floor(Math.random() * 250);
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--window-size=1440,1000",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPort() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error("chrome did not start");
}

const ws = new WebSocket(await waitForPort());
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
const send = (method, params = {}, sessionId) => {
  const msgId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
  });
};

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);

await S("Page.enable");
await S("Runtime.enable");
await S("Log.enable");

const consoleErrors = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
    consoleErrors.push(m.params.entry.text);
  }
  if (m.method === "Runtime.exceptionThrown") {
    consoleErrors.push(
      m.params.exceptionDetails?.exception?.description || "exception"
    );
  }
});

const evaluate = async (expression, awaitPromise = true) => {
  const r = await S("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      r.exceptionDetails.exception?.description || "eval failed"
    );
  }
  return r.result.value;
};

console.log("\x1b[1m\x1b[36mEdgeMirror — browser E2E\x1b[0m");
console.log(`\x1b[2m${BASE}\x1b[0m\n`);

await S("Page.navigate", { url: BASE });
await sleep(4000);

// ---------------------------------------------------------------- boot state
console.log("\x1b[1m启动与配置 / Boot\x1b[0m");
ok("page has title", (await evaluate("document.title")).includes("EdgeMirror"));
ok(
  "nodes loaded into chips",
  (await evaluate("document.querySelectorAll('#node-chips .chip').length")) >= 1,
  `${await evaluate("document.querySelectorAll('#node-chips .chip').length")} chips`
);
ok(
  "node table populated",
  (await evaluate("document.querySelectorAll('#node-table .node-row').length")) >= 1
);
ok(
  "status pill shows counts",
  /节点在线|检测中|节点异常/.test(
    await evaluate("document.querySelector('#nav-status-text').textContent")
  )
);

// ------------------------------------------------------------------- convert
console.log("\n\x1b[1m链接转换 / Conversion\x1b[0m");

const convert = async (input) => {
  await evaluate(`(() => {
    const i = document.querySelector('#url-input');
    i.value = ${JSON.stringify(input)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#proxy-form').requestSubmit();
    return true;
  })()`);
  await sleep(350);
  return evaluate(`(() => {
    const out = document.querySelector('#output');
    return {
      hidden: out.hidden,
      url: document.querySelector('#output-url').textContent,
      href: document.querySelector('#output-url').getAttribute('href'),
      node: document.querySelector('#meta-node').textContent,
      kind: document.querySelector('#meta-kind').textContent,
      cache: document.querySelector('#meta-cache').textContent,
    };
  })()`);
};

const gh = await convert(
  "https://github.com/astral-sh/uv/releases/download/0.5.11/uv.tar.gz"
);
ok("github URL converts", !gh.hidden, gh.url);
ok(
  "github URL points straight at the mirror, not at us",
  /^https:\/\/(gh-proxy\.com|ghproxy\.net|ghfast\.top)\//.test(gh.url),
  gh.url
);
ok(
  "mirror URL keeps the original github URL intact",
  gh.url.endsWith(
    "https://github.com/astral-sh/uv/releases/download/0.5.11/uv.tar.gz"
  ),
  gh.url
);
ok("mirror conversion is labelled", gh.cache.includes("镜像站"), gh.cache);

const raw = await convert(
  "https://raw.githubusercontent.com/torvalds/linux/master/README"
);
ok(
  "raw URL also goes straight to the mirror",
  /^https:\/\/(gh-proxy\.com|ghproxy\.net|ghfast\.top)\//.test(raw.url),
  raw.url
);

// Docker tab
await evaluate(`document.querySelector('#tab-docker').click()`);
await sleep(400);
ok(
  "docker tab active",
  (await evaluate(`document.querySelector('#tab-docker').getAttribute('aria-selected')`)) === "true"
);
ok(
  "node chips hidden on docker",
  (await evaluate(`document.querySelector('.nodes-row').style.display`)) === "none"
);

const docker = await convert("nginx:latest");
ok("docker image converts", !docker.hidden, docker.url);
ok("docker url is registry path", /\/nginx:latest$/.test(docker.url), docker.url);
ok("docker meta kind", docker.kind === "Docker Image", docker.kind);

// SourceForge tab
await evaluate(`document.querySelector('#tab-sourceforge').click()`);
await sleep(400);
const sf = await convert(
  "https://downloads.sourceforge.net/project/sevenzip/7-Zip/24.09/7z2409-x64.exe"
);
ok("sourceforge converts", !sf.hidden, sf.url);
ok("sf path = /sf/<host>/<path>", sf.url.includes("/sf/downloads.sourceforge.net/"), sf.url);

// Invalid input handling
await evaluate(`document.querySelector('#tab-github').click()`);
await sleep(300);
const bad = await evaluate(`(() => {
  const i = document.querySelector('#url-input');
  i.value = 'not a url at all';
  document.querySelector('#proxy-form').requestSubmit();
  return { hidden: document.querySelector('#output').hidden,
           toast: document.querySelector('#toast-text').textContent };
})()`);
ok("invalid input shows error toast", /无法识别/.test(bad.toast), bad.toast);

// ------------------------------------------------------------- node switching
console.log("\n\x1b[1m节点切换 / Node switching\x1b[0m");
const chips = await evaluate(
  `[...document.querySelectorAll('#node-chips .chip')].map(c => c.dataset.node)`
);
ok("multiple nodes offered", chips.length >= 2, chips.join(","));

if (chips.length >= 2) {
  await evaluate(`document.querySelector('[data-node="${chips[1]}"]').click()`);
  await sleep(400);
  ok(
    "clicking a chip marks it pressed",
    (await evaluate(
      `document.querySelector('[data-node="${chips[1]}"]').getAttribute('aria-pressed')`
    )) === "true"
  );
  const after = await convert("https://github.com/a/b/archive/refs/heads/main.zip");
  ok("re-convert keeps working after switch", !after.hidden, after.node);
}

// ---------------------------------------------------------------- a11y / misc
console.log("\n\x1b[1m可访问性 / A11y\x1b[0m");
ok(
  "tabs use aria-selected",
  (await evaluate("document.querySelectorAll('[role=tab][aria-selected]').length")) === 3
);
ok(
  "input has accessible label",
  Boolean(await evaluate("document.querySelector('#url-label')?.textContent?.length"))
);
ok(
  "tabs keyboard-navigable",
  (await evaluate(`(() => {
    const t = document.querySelector('#tab-github');
    t.focus();
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    return document.activeElement?.dataset?.service;
  })()`)) === "docker"
);

// FAQ accordion
console.log("\n\x1b[1m内容 / Content\x1b[0m");
ok(
  "FAQ has 6 entries",
  (await evaluate("document.querySelectorAll('.faq details').length")) === 6
);
await evaluate(`document.querySelector('.faq details').open = true`);
ok(
  "FAQ expands",
  await evaluate(`document.querySelector('.faq summary').getBoundingClientRect().height > 0`)
);
ok(
  "hero h1 is single",
  (await evaluate("document.querySelectorAll('h1').length")) === 1
);
ok(
  "no console errors",
  consoleErrors.length === 0,
  consoleErrors.slice(0, 2).join(" | ")
);

// ------------------------------------------------------------ responsive check
console.log("\n\x1b[1m响应式 / Responsive\x1b[0m");
for (const [w, h, label] of [[375, 812, "iPhone"], [768, 1024, "iPad"], [1440, 900, "Desktop"]]) {
  await S("Emulation.setDeviceMetricsOverride", {
    width: w,
    height: h,
    deviceScaleFactor: 1,
    mobile: w < 500,
  });
  await sleep(600);
  const overflow = await evaluate(
    "document.documentElement.scrollWidth > document.documentElement.clientWidth + 1"
  );
  ok(`${label} ${w}px — no horizontal scroll`, !overflow);
}

console.log(
  `\n\x1b[1m${fail === 0 ? "\x1b[32mPASS" : "\x1b[31mFAIL"}\x1b[0m  ${pass} passed, ${fail} failed\n`
);
if (fail) {
  for (const f of failures) console.log(`  · ${f}`);
  process.exitCode = 1;
}

ws.close();
chrome.kill("SIGKILL");
await sleep(200);
process.exit(fail ? 1 : 0);
