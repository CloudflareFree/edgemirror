/**
 * EdgeMirror — streaming proxy core.
 *
 * Two node modes:
 *   direct   — fetch the origin from the edge PoP
 *   upstream — prepend node.baseUrl to the original URL (gh-proxy convention)
 *
 * Rules that matter:
 *  - Never buffer a body. A 2 GB release costs the same memory as a README.
 *  - Range is forwarded verbatim so download managers can resume.
 *  - Hop-by-hop headers stripped per RFC 7230 §6.1.
 *  - Set-Cookie / CSP / XFO from upstream are dropped: this is a content
 *    proxy, not a session holder, and upstream framing rules would break
 *    the binary responses we relay.
 */

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

const DROP_RESPONSE = new Set([
  ...HOP_BY_HOP,
  "set-cookie",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
  "alt-svc",
]);

const FORWARD_REQUEST = [
  "range",
  "if-range",
  "if-none-match",
  "if-modified-since",
  "accept",
  "accept-language",
  "user-agent",
];

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS, POST",
  "access-control-allow-headers":
    "Range, If-Range, Accept, Accept-Encoding, Authorization, Content-Type",
  "access-control-expose-headers":
    "Content-Length, Content-Range, Content-Type, ETag, Last-Modified, Accept-Ranges, X-EdgeMirror-Node, X-EdgeMirror-Upstream, X-EdgeMirror-Elapsed",
  "access-control-max-age": "86400",
  "timing-allow-origin": "*",
};

export function corsHeaders() {
  return { ...CORS };
}

export function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status: init.status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...CORS,
      ...(init.headers || {}),
    },
  });
}

export function cleanResponseHeaders(headers) {
  const out = {};
  for (const [k, v] of headers) {
    const key = k.toLowerCase();
    if (DROP_RESPONSE.has(key)) continue;
    if (key.startsWith("cf-")) continue;
    if (key.startsWith("x-amz-")) continue;
    if (key.startsWith("x-goog-")) continue;
    out[key] = v;
  }
  return out;
}

export function buildUpstreamHeaders(request, extra = {}) {
  const out = new Headers();
  for (const name of FORWARD_REQUEST) {
    const v = request.headers.get(name);
    if (v) out.set(name, v);
  }
  if (!out.has("accept")) out.set("accept", "*/*");
  if (!out.has("user-agent")) {
    out.set("user-agent", "EdgeMirror/1.0 (+https://mirror.137101.xyz)");
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === null || v === undefined || v === "") out.delete(k);
    else out.set(k, v);
  }
  return out;
}

/**
 * Allow-list a destination. Without this the Worker is an open relay that
 * anyone can point at any origin — a fast way to get an abuse takedown.
 */
export function assertAllowedHost(urlString, allowedHosts) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "invalid_protocol" };
  }
  const host = url.hostname.toLowerCase();
  const allowed = allowedHosts.some((h) => host === h || host.endsWith("." + h));
  if (!allowed) return { ok: false, reason: "host_not_allowed", host };
  return { ok: true, url };
}

/** Resolve the actual fetch target for a node. */
export function resolveTarget(node, originalUrl) {
  if (node.mode === "upstream" && node.baseUrl) {
    const base = node.baseUrl.endsWith("/") ? node.baseUrl : node.baseUrl + "/";
    return base + originalUrl;
  }
  return originalUrl;
}

/**
 * Stream a response from `targetUrl` back to the caller.
 */
export async function forward(request, targetUrl, opts = {}) {
  const { node, cacheControl, extraHeaders = {}, redirect = "follow" } = opts;

  const fetchUrl = node ? resolveTarget(node, targetUrl) : targetUrl;
  const method = request.method === "HEAD" ? "HEAD" : "GET";
  const headers = buildUpstreamHeaders(request, extraHeaders);
  headers.delete("accept-encoding"); // let the runtime pick; we stream raw bytes

  const started = Date.now();
  let upstream;
  try {
    upstream = await fetch(fetchUrl, { method, headers, redirect });
  } catch (err) {
    return json(
      {
        ok: false,
        error: "upstream_unreachable",
        message: "上游节点连接失败，请尝试切换节点后重试。",
        detail: String((err && err.message) || err),
        node: node ? node.id : "direct",
      },
      { status: 502 }
    );
  }

  const outHeaders = cleanResponseHeaders(upstream.headers);
  Object.assign(outHeaders, CORS);
  outHeaders["x-edge-mirror-node"] = node ? node.id : "direct";
  try {
    outHeaders["x-edge-mirror-upstream"] = new URL(targetUrl).hostname;
  } catch {
    outHeaders["x-edge-mirror-upstream"] = "unknown";
  }
  outHeaders["x-edge-mirror-elapsed"] = String(Date.now() - started);

  if (!outHeaders["cache-control"]) {
    outHeaders["cache-control"] = cacheControl || "public, max-age=300";
  } else if (cacheControl) {
    outHeaders["cache-control"] = cacheControl;
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    const loc = upstream.headers.get("location");
    if (loc) outHeaders["location"] = loc;
  }

  const noBody =
    method === "HEAD" || upstream.status === 204 || upstream.status === 304;

  return new Response(noBody ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
}

/** Long-lived caching for content that can never change after publication. */
export function cachePolicyFor(pathname) {
  if (/\/releases\/download\//.test(pathname))
    return "public, max-age=31536000, immutable";
  if (/\/archive\/refs\/(heads|tags)\//.test(pathname))
    return "public, max-age=86400";
  if (/\/blobs\/sha256:/.test(pathname))
    return "public, max-age=31536000, immutable";
  return "public, max-age=600";
}

/**
 * Parse "/<host>/<path>" or a fully-qualified URL into a normalized URL.
 * Returns { url } or { error }.
 */
export function parseTarget(rest, allowedHosts) {
  if (!rest) return { error: "missing_target" };

  let candidate;
  if (/^https?:\/\//i.test(rest)) {
    candidate = rest;
  } else {
    const slash = rest.indexOf("/");
    const host = slash === -1 ? rest : rest.slice(0, slash);
    const tail = slash === -1 ? "" : rest.slice(slash + 1);
    if (!host.includes(".")) return { error: "invalid_url" };
    candidate = `https://${host}${tail ? "/" + tail : ""}`;
  }

  const check = assertAllowedHost(candidate, allowedHosts);
  if (!check.ok) return { error: check.reason, host: check.host };
  return { url: candidate };
}
