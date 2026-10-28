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
 * 302 the client straight to a mirror.
 *
 * This is the cheap path by design: the Worker emits one redirect and never
 * touches the bytes, so a 15 GB release costs nothing in Workers egress. The
 * mirror serves the payload from its own infrastructure.
 */
export function redirectTo(node, originalUrl, request) {
  const base = node.baseUrl.endsWith("/") ? node.baseUrl : node.baseUrl + "/";
  const location = base + originalUrl;

  // Preserve Range semantics: the browser/downloader follows the redirect
  // and sends Range to the mirror itself, so no header rewriting is needed.
  const headers = {
    location,
    ...CORS,
    "cache-control": "public, max-age=300",
    "x-edge-mirror-node": node.id,
    "x-edge-mirror-mode": "redirect",
  };

  if (request && request.method === "HEAD") {
    return new Response(null, { status: 302, headers });
  }
  return new Response(null, { status: 302, headers });
}

/**
 * Stream a response from `targetUrl` back to the caller.
 */
export async function forward(request, targetUrl, opts = {}) {
  const { node, cacheControl, extraHeaders = {}, redirect = "follow" } = opts;

  const fetchUrl = node ? resolveTarget(node, targetUrl) : targetUrl;
  const method = request.method === "HEAD" ? "HEAD" : "GET";
  const headers = buildUpstreamHeaders(request, extraHeaders);

  // A ranged response must never be content-encoded: the byte offsets in
  // Content-Range refer to the *uncompressed* resource, so letting the
  // runtime ask for gzip yields a truncated, corrupt body. Download clients
  // and aria2 rely on this being right.
  const wantsRange = Boolean(request.headers.get("range"));
  if (wantsRange) {
    headers.set("accept-encoding", "identity");
  } else if (!headers.has("accept-encoding")) {
    headers.delete("accept-encoding"); // let the runtime negotiate normally
  }

  const started = Date.now();
  let upstream;
  let lastErr;
  // One retry: long-haul routes to github.com occasionally drop the initial
  // connection, and a bare failure here looks like an outage to the user.
  //
  // No AbortSignal here on purpose. A signal stays attached to the body, so a
  // timeout would kill a legitimately long download mid-stream. A failed
  // fetch rejects while connecting, which is exactly the case we retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      upstream = await fetch(fetchUrl, { method, headers, redirect });
      break;
    } catch (err) {
      lastErr = err;
    }
  }

  if (!upstream) {
    return json(
      {
        ok: false,
        error: "upstream_unreachable",
        message: "上游节点连接失败，请尝试切换节点后重试。",
        detail: String((lastErr && lastErr.message) || lastErr),
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

  // A 206 body must reach the client byte-for-byte. Cloudflare's edge
  // auto-compresses text responses that lack a Content-Encoding, which
  // silently shrinks a 100-byte range down to ~60 and breaks every
  // resumable download. `no-transform` is the standard way to forbid it.
  if (wantsRange && !/no-transform/i.test(outHeaders["cache-control"])) {
    outHeaders["cache-control"] += ", no-transform";
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    const loc = upstream.headers.get("location");
    if (loc) outHeaders["location"] = loc;
  }

  // A 3xx we chose not to follow is handed to the client as-is; forwarding
  // its body would stream the mirror's own error page through us for no gain.
  const isRedirect = upstream.status >= 300 && upstream.status < 400;
  const noBody =
    method === "HEAD" ||
    isRedirect ||
    upstream.status === 204 ||
    upstream.status === 304;

  // --- ranged responses over compressible text -----------------------------
  //
  // github.com sits behind Fastly, which computes ranges over the *gzipped*
  // representation: it reports the compressed size as the resource total and
  // ships decoded bytes with no Content-Encoding. A `bytes=0-99` request
  // returns ~63 plaintext bytes while claiming `0-99/330` for a file that is
  // really 496 bytes. Every ranged read of a compressible file is wrong,
  // and open-ended ranges (`248-`) come back short too.
  //
  // No header-level tell is reliable — content-length is present for some
  // ranges and absent for others — so for any ranged 206 whose declared
  // total is small enough to re-fetch, we discard the upstream slice and
  // serve from a full fetch we slice ourselves. Big resources (large binary
  // release assets, which Fastly handles correctly) stay on the streaming
  // path untouched.
  if (wantsRange && !noBody && upstream.status === 206) {
    const declaredTotal = totalFromContentRange(
      upstream.headers.get("content-range")
    );

    if (declaredTotal !== null && declaredTotal <= MAX_REPAIR_BYTES) {
      // Drain the rejected slice so the connection can be reused.
      if (upstream.body) await upstream.body.cancel();
      return await serveRangeFromFull(
        request,
        fetchUrl,
        headers,
        request.headers.get("range") || "",
        outHeaders,
        declaredTotal
      );
    }
  }

  return new Response(noBody ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
}

/** Upper bound for the in-memory range repair path. */
const MAX_REPAIR_BYTES = 8 * 1024 * 1024;

/** Total resource size declared in `Content-Range: bytes a-b/total`. */
function totalFromContentRange(value) {
  if (!value) return null;
  const m = /\/\s*(\d+)\s*$/.exec(value);
  return m ? Number(m[1]) : null;
}

/**
 * Fetch the whole resource and satisfy the range locally. Only reached when
 * the upstream's 206 looks like Fastly's compressed-range bug.
 */
async function serveRangeFromFull(
  request,
  fetchUrl,
  baseHeaders,
  rangeHeader,
  outHeaders,
  knownTotal
) {
  const fullHeaders = new Headers(baseHeaders);
  fullHeaders.delete("range");
  fullHeaders.delete("if-range");

  let full;
  try {
    full = await fetch(fetchUrl, { method: "GET", headers: fullHeaders });
  } catch {
    return json(
      {
        ok: false,
        error: "range_fallback_failed",
        message: "上游未能提供有效的分段响应，且回退获取失败。",
      },
      { status: 502 }
    );
  }

  if (!full.ok) {
    // Pass the upstream error straight through rather than inventing one.
    return new Response(full.body, {
      status: full.status,
      headers: { ...cleanResponseHeaders(full.headers), ...CORS },
    });
  }

  const buf = await full.arrayBuffer();
  // Prefer the real byte length; the declared total is used only to detect
  // the 206 we are replacing.
  const total = buf.byteLength || knownTotal || 0;
  if (total === 0) {
    return new Response(null, { status: 502, headers: outHeaders });
  }
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  const start = m[1] === "" ? Math.max(total - Number(m[2]), 0) : Number(m[1]);
  const end = m[1] !== "" && m[2] !== "" ? Math.min(Number(m[2]), total - 1) : total - 1;

  if (start >= total || start > end) {
    return new Response(null, {
      status: 416,
      headers: {
        ...outHeaders,
        "content-range": `bytes */${total}`,
        "cache-control": "no-store",
      },
    });
  }

  const slice = buf.slice(start, end + 1);
  return new Response(request.method === "HEAD" ? null : slice, {
    status: 206,
    headers: {
      ...outHeaders,
      "content-range": `bytes ${start}-${end}/${total}`,
      "content-length": String(slice.byteLength),
      "accept-ranges": "bytes",
    },
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
