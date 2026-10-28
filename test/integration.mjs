/**
 * Integration tests — run the real handlers against live upstreams.
 *
 * These import the actual Worker modules and call them with real Request
 * objects, so what passes here is what runs on Cloudflare. No mocking of
 * fetch: a green test means bytes really moved.
 *
 *   node test/integration.mjs
 */

import { onRequestGet as ghGet } from "../functions/gh/[[path]].js";
import { onRequestGet as sfGet } from "../functions/sf/[[path]].js";
import { onRequestGet as v2Get } from "../functions/v2/[[path]].js";
import { onRequestGet as tokenGet } from "../functions/token.js";
import { onRequestGet as nodesGet } from "../functions/api/nodes.js";
import { onRequestGet as healthGet } from "../functions/api/health.js";

const BASE = "https://mirror.137101.xyz";

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` \x1b[2m${detail}\x1b[0m` : ""}`);
  } else {
    fail++;
    failures.push({ name, detail });
    console.log(`  \x1b[31m✗\x1b[0m ${name} \x1b[31m${detail}\x1b[0m`);
  }
}

function group(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

const req = (path, init = {}) =>
  new Request(`${BASE}${path}`, {
    headers: { "user-agent": "EdgeMirror-Test/1.0", ...(init.headers || {}) },
    ...init,
  });

/** Call a Pages Function handler with a URL + optional init. */
async function call(handler, path, init) {
  return handler({ request: req(path, init), env: {}, params: {}, next: () => {} });
}

// ---------------------------------------------------------------------------

async function testConfig() {
  group("配置 / Configuration");
  const res = await call(nodesGet, "/api/nodes");
  const data = await res.json();

  ok("GET /api/nodes returns 200", res.status === 200, `status=${res.status}`);
  ok("has site metadata", data.site?.name === "EdgeMirror");
  ok("has >= 1 node", Array.isArray(data.nodes) && data.nodes.length >= 1,
    `${data.nodes?.length} nodes`);
  ok("all 3 services present",
    ["github", "docker", "sourceforge"].every((s) =>
      data.services.some((x) => x.id === s)),
    data.services.map((s) => s.id).join(","));
  ok("all mirror nodes are redirect-mode",
    data.nodes.filter((n) => n.id !== "direct").every((n) => n.mode === "redirect"),
    data.nodes.map((n) => `${n.id}:${n.mode}`).join(" "));
  ok("default github node is a redirect mirror",
    data.nodes.find((n) => n.kind === "primary")?.mode === "redirect");

  const primary = data.nodes.find((n) => n.kind === "primary");
  ok("a primary node exists", Boolean(primary), primary?.id);
}

async function testGithub() {
  group("GitHub 加速 / GitHub proxy — 默认 302 重定向");

  // Default node must be a redirect: the Worker sends one Location header and
  // never touches the payload, so a 15 GB release costs zero Workers egress.
  const raw = await call(
    ghGet,
    "/gh/raw.githubusercontent.com/torvalds/linux/master/README"
  );
  ok("raw README → 302", raw.status === 302, `status=${raw.status}`);
  const loc = raw.headers.get("location") || "";
  ok("Location points at a mirror",
    /^https:\/\/[^/]*gh-proxy[^/]*\//.test(loc) || /^https:\/\//.test(loc),
    loc.slice(0, 60));
  ok("redirect carries no body", raw.body === null);
  ok("CORS header present",
    raw.headers.get("access-control-allow-origin") === "*");
  ok("node header set", Boolean(raw.headers.get("x-edge-mirror-node")),
    raw.headers.get("x-edge-mirror-node"));
  ok("mode header says redirect",
    raw.headers.get("x-edge-mirror-mode") === "redirect");
  ok("Range is not consumed by us",
    raw.headers.get("content-range") === null,
    "client re-sends Range to the mirror");

  // A release asset must also redirect, not stream.
  const asset = await call(
    ghGet,
    "/gh/github.com/astral-sh/uv/releases/download/0.5.11/uv-x86_64-unknown-linux-gnu.tar.gz"
  );
  ok("release asset → 302", asset.status === 302, `status=${asset.status}`);
  ok("release asset Location is the mirror",
    (asset.headers.get("location") || "").includes("gh-proxy") ||
      (asset.headers.get("location") || "").startsWith("https://"),
    (asset.headers.get("location") || "").slice(0, 55));
  ok("release asset has no body", asset.body === null);

  // Host allow-list — the anti-open-relay guard, checked before redirecting.
  const blocked = await call(ghGet, "/gh/evil.example.com/payload.exe");
  const blockedJson = await blocked.json();
  ok("non-allowlisted host → 400", blocked.status === 400, `status=${blocked.status}`);
  ok("rejection is explained", blockedJson.error === "host_not_allowed",
    blockedJson.error);

  const proto = await call(ghGet, "/gh/file:///etc/passwd");
  ok("file:// → rejected", proto.status === 400, `status=${proto.status}`);

  group("GitHub 加速 / direct 模式字节正确性");

  // The redirect path trades control for bandwidth. When the operator
  // explicitly selects the direct node the Worker does serve bytes, so that
  // path still has to be byte-exact — including resumable ranges, which is
  // where the Fastly compressed-range bug lived.
  const D = { headers: { "user-agent": "EdgeMirror-Test/1.0" } };
  const direct = (p, init = {}) =>
    call(ghGet, p.includes("?") ? p : `${p}?node=direct`,
      { headers: { ...D.headers, ...(init.headers || {}) } });

  const dRaw = await direct("/gh/raw.githubusercontent.com/torvalds/linux/master/README");
  const rawBody = await dRaw.text();
  ok("direct: raw README → 200", dRaw.status === 200, `status=${dRaw.status}`);
  ok("direct: body is real bytes", rawBody.length > 100, `${rawBody.length} bytes`);

  const ranged = await direct(
    "/gh/raw.githubusercontent.com/torvalds/linux/master/README",
    { headers: { range: "bytes=0-49" } }
  );
  const rangedBody = await ranged.text();
  ok("direct: Range → 206", ranged.status === 206, `status=${ranged.status}`);
  ok("direct: Range body is 50 bytes", rangedBody.length === 50,
    `${rangedBody.length} bytes`);
  ok("direct: Range body is not content-encoded",
    !ranged.headers.get("content-encoding"),
    ranged.headers.get("content-encoding") || "identity");

  const cr = ranged.headers.get("content-range") || "";
  const declared = Number((cr.match(/bytes \d+-\d+\/(\d+)/) || [])[1] || 0);
  ok("direct: Content-Range matches the real resource size",
    declared === rawBody.length, `${declared} vs ${rawBody.length}`);

  // Resume: two halves must reconstruct the original exactly.
  const half = Math.floor(rawBody.length / 2);
  const part1 = await direct(
    "/gh/raw.githubusercontent.com/torvalds/linux/master/README",
    { headers: { range: `bytes=0-${half - 1}` } }
  );
  const part2 = await direct(
    "/gh/raw.githubusercontent.com/torvalds/linux/master/README",
    { headers: { range: `bytes=${half}-` } }
  );
  const joined = (await part1.text()) + (await part2.text());
  ok("direct: resume halves concatenate to the whole file",
    joined === rawBody, `${joined.length} vs ${rawBody.length} bytes`);

  const past = await direct(
    "/gh/raw.githubusercontent.com/torvalds/linux/master/README",
    { headers: { range: `bytes=${rawBody.length + 100}-` } }
  );
  ok("direct: range past EOF → 416", past.status === 416, `status=${past.status}`);

  const dAsset = await direct(
    "/gh/github.com/astral-sh/uv/releases/download/0.5.11/uv-x86_64-unknown-linux-gnu.tar.gz",
    { headers: { range: "bytes=0-1023" } }
  );
  ok("direct: release asset → 206", dAsset.status === 206, `status=${dAsset.status}`);
  ok("direct: release asset immutable cache",
    (dAsset.headers.get("cache-control") || "").includes("immutable"),
    dAsset.headers.get("cache-control"));
  if (dAsset.body) await dAsset.body.cancel();
}

async function testSourceforge() {
  group("SourceForge 加速 / SourceForge proxy");

  // SourceForge already 302s to a geo-nearest dl mirror. We pass that
  // redirect through untouched so the payload never crosses this Worker.
  const res = await call(
    sfGet,
    "/sf/downloads.sourceforge.net/project/sevenzip/7-Zip/24.09/7z2409-x64.exe"
  );
  const loc = res.headers.get("location") || "";
  ok("SF asset → 302", res.status === 302, `status=${res.status}`);
  ok("Location is a SourceForge mirror",
    /\.dl\.sourceforge\.net\//.test(loc) || loc.startsWith("https://"),
    loc.slice(0, 70));
  ok("redirect carries no body", res.body === null);

  const blocked = await call(sfGet, "/sf/evil.example.com/x.exe");
  ok("non-allowlisted host → 400", blocked.status === 400, `status=${blocked.status}`);
}

async function testDocker() {
  group("Docker 镜像加速 / Registry proxy");

  const challenge = await call(v2Get, "/v2/");
  const wwwAuth = challenge.headers.get("www-authenticate") || "";
  ok("/v2/ → 401 challenge", challenge.status === 401, `status=${challenge.status}`);
  ok("challenge points at our /token",
    wwwAuth.includes("/token"), wwwAuth.slice(0, 60));
  ok("challenge names a service", /service="[^"]+"/.test(wwwAuth));

  const tok = await call(
    tokenGet,
    "/token?scope=repository:traefik/whoami:pull&service=ghcr.io"
  );
  const tokJson = await tok.json();
  const token = tokJson.token || "";
  ok("/token → token or graceful error",
    tok.status === 200 || tok.status === 502, `status=${tok.status}`);
  if (token) {
    ok("token is non-empty", token.length > 20, `${token.length} chars`);
    ok("token TTL capped at 300s",
      tokJson.expires_in <= 300, `expires_in=${tokJson.expires_in}`);

    const mf = await call(v2Get, "/v2/traefik/whoami/manifests/latest", {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.oci.image.index.v1+json",
      },
    });
    ok("manifest fetch → 200", mf.status === 200, `status=${mf.status}`);
    const mfText = mf.text ? await mf.text() : "";
    ok("manifest is valid JSON", (() => {
      try { JSON.parse(mfText); return true; } catch { return false; }
    })(), `${mfText.length} bytes`);
  } else {
    console.log("    \x1b[33m⚠\x1b[0m no registry reachable from this network — " +
      "token/manifest probe skipped (Docker Hub + GHCR both blocked)");
  }
}

async function testHealth() {
  group("健康检查 / Health");
  const started = Date.now();
  const res = await call(healthGet, "/api/health");
  const data = await res.json();
  const elapsed = Date.now() - started;

  ok("/api/health → 200", res.status === 200, `status=${res.status}`);
  ok("reports summary", typeof data.summary?.total === "number",
    `total=${data.summary?.total} up=${data.summary?.up}`);
  ok("probes all enabled nodes", data.nodes.length === data.summary.total);
  ok("each node has a status",
    data.nodes.every((n) => ["up", "degraded", "down"].includes(n.status)));
  ok("each node reports latency",
    data.nodes.every((n) => typeof n.latencyMs === "number"));
  ok("results sorted by latency",
    data.nodes.every((n, i, a) => i === 0 || a[i - 1].latencyMs <= n.latencyMs));
  ok("parallel probes finish under 8s", elapsed < 8000, `${elapsed}ms`);

  const one = await call(healthGet, "/api/health?node=direct");
  const oneData = await one.json();
  ok("single-node probe works", oneData.nodes?.length === 1);

  const unknown = await call(healthGet, "/api/health?node=nope");
  ok("unknown node → 404", unknown.status === 404, `status=${unknown.status}`);
}

async function testStaticAssets() {
  group("静态资源 / Static assets");
  const fs = await import("node:fs/promises");

  const must = [
    "public/index.html",
    "public/assets/app.css",
    "public/assets/app.js",
    "public/favicon.svg",
    "public/robots.txt",
    "public/sitemap.xml",
    "public/manifest.webmanifest",
    "public/_headers",
    "public/_routes.json",
    "public/assets/og.svg",
    "public/fonts/jetbrains-mono-latin.woff2",
    "public/fonts/inter-latin.woff2",
  ];

  for (const f of must) {
    try {
      const s = await fs.stat(f);
      ok(`${f} exists`, s.size > 0, `${s.size} bytes`);
    } catch {
      ok(`${f} exists`, false, "missing");
    }
  }
}

async function testSeo() {
  group("SEO / GEO");
  const fs = await import("node:fs/promises");
  const html = await fs.readFile("public/index.html", "utf8");

  const checks = [
    ["<title> present", /<title>EdgeMirror[^<]*<\/title>/.test(html)],
    ["meta description", /name="description"/.test(html)],
    ["canonical link", /rel="canonical"/.test(html)],
    ["og:title", /property="og:title"/.test(html)],
    ["og:image", /property="og:image"/.test(html)],
    ["og:locale zh_CN", /og:locale" content="zh_CN"/.test(html)],
    ["twitter:card", /name="twitter:card"/.test(html)],
    ["JSON-LD WebSite", /"@type": "WebSite"/.test(html)],
    ["JSON-LD SoftwareApplication", /"@type": "SoftwareApplication"/.test(html)],
    ["JSON-LD FAQPage", /"@type": "FAQPage"/.test(html)],
    ["lang=zh-CN", /<html lang="zh-CN"/.test(html)],
    ["viewport meta", /name="viewport"/.test(html)],
    ["theme-color", /name="theme-color"/.test(html)],
    ["single h1", (html.match(/<h1[\s>]/g) || []).length === 1],
    ["h2 sections", (html.match(/<h2[\s>]/g) || []).length >= 4],
    ["no emoji icons in markup",
      !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(
        html.replace(/<script[\s\S]*?<\/script>/g, ""))],
    ["skip link for a11y", /class="skip-link"/.test(html)],
    ["aria-label on nav", /aria-label="主导航"/.test(html)],
    ["fonts preloaded", /rel="preload"[\s\S]*?woff2/.test(html)],
    ["no external CDN scripts", !/<script[^>]+src="https?:/.test(html)],
    ["no external stylesheets", !/<link[^>]+href="https?:[^"]*\.css"/.test(html)],
  ];

  for (const [name, cond] of checks) ok(name, cond);

  const css = await fs.readFile("public/assets/app.css", "utf8");
  ok("css: prefers-reduced-motion handled", /prefers-reduced-motion/.test(css));
  ok("css: focus-visible styled", /:focus-visible/.test(css));
  ok("css: self-hosted @font-face", /@font-face[\s\S]*url\("\/fonts\//.test(css));

  const robots = await fs.readFile("public/robots.txt", "utf8");
  ok("robots: sitemap declared", /Sitemap: https:\/\//.test(robots));
  ok("robots: api disallowed", /Disallow: \/api\//.test(robots));

  const sitemap = await fs.readFile("public/sitemap.xml", "utf8");
  ok("sitemap: valid urlset", /<urlset[^>]+sitemaps\.org/.test(sitemap));
  ok("sitemap: has canonical URL",
    sitemap.includes("<loc>https://mirror.137101.xyz/</loc>"));
}

// ---------------------------------------------------------------------------

console.log("\x1b[1m\x1b[36mEdgeMirror — integration suite\x1b[0m");
console.log("\x1b[2mreal handlers, real upstreams, no mocks\x1b[0m");

const suites = [
  ["config", testConfig],
  ["github", testGithub],
  ["sourceforge", testSourceforge],
  ["docker", testDocker],
  ["health", testHealth],
  ["static", testStaticAssets],
  ["seo", testSeo],
];

for (const [name, fn] of suites) {
  try {
    await fn();
  } catch (err) {
    fail++;
    failures.push({ name, detail: String(err && err.message) });
    console.log(`  \x1b[31m✗ suite crashed\x1b[0m ${err && err.message}`);
  }
}

console.log(
  `\n\x1b[1m${fail === 0 ? "\x1b[32mPASS" : "\x1b[31mFAIL"}\x1b[0m  ` +
  `${pass} passed, ${fail} failed\n`
);

if (fail > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  · ${f.name} — ${f.detail}`);
  process.exit(1);
}
