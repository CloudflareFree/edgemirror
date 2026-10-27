import { cleanResponseHeaders, corsHeaders, json } from "../_lib/proxy.js";
import { enabledRegistries, activeRegistry } from "../_config/nodes.js";

/**
 * Docker / OCI registry mirror.
 *
 *   docker pull mirror.137101.xyz/nginx:latest
 *
 * Docker hard-codes `/v2/` for registry clients, so this route lives at the
 * site root rather than under a /docker prefix.
 *
 *   GET /v2/                          -> 401 + WWW-Authenticate -> /token
 *   GET /token?scope=...              -> relayed anonymous token
 *   GET /v2/<name>/manifests/<ref>    -> proxied, 1h cache
 *   GET /v2/<name>/blobs/<digest>     -> proxied, immutable for 1y
 *
 * IMPORTANT: the streaming fetch carries no AbortSignal. A timeout would
 * abort the body mid-stream and truncate multi-hundred-MB layer downloads.
 * Registry selection happens up front via a short HEAD probe instead.
 */

const ACCEPT_MANIFEST = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const PROBE_TIMEOUT_MS = 3500;
const PROBE_TTL_MS = 60_000;

/** Per-isolate cache: { id, at } of the last registry that answered /v2/. */
let registryCache = null;

async function pickRegistry() {
  const all = enabledRegistries();
  if (all.length === 1) return { reg: all[0], failures: [] };

  if (registryCache && Date.now() - registryCache.at < PROBE_TTL_MS) {
    const hit = all.find((r) => r.id === registryCache.id);
    if (hit) return { reg: hit, failures: [] };
  }

  const failures = [];
  for (const reg of all) {
    try {
      // GET, not HEAD: several registries answer 405 to HEAD on /v2/, which
      // says nothing about whether they can serve pulls.
      const res = await fetch(`${reg.registry}/v2/`, {
        method: "GET",
        headers: { "user-agent": "EdgeMirror/1.0" },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (res.body) await res.body.cancel();
      // Any 2xx/3xx/4xx means the endpoint answered; only 5xx or a thrown
      // error count as "unreachable".
      if (res.status < 500) {
        registryCache = { id: reg.id, at: Date.now() };
        return { reg, failures };
      }
      failures.push({ registry: reg.id, status: res.status });
    } catch (err) {
      failures.push({
        registry: reg.id,
        error: String((err && err.name) || err),
      });
    }
  }

  // Nothing answered — fall back to the configured primary so the caller
  // gets a real error from the actual upstream rather than a guess.
  return { reg: activeRegistry(), failures };
}

export const onRequestOptions = () =>
  new Response(null, { status: 204, headers: corsHeaders() });

export async function onRequestGet(ctx) {
  return handle(ctx.request);
}

export const onRequestHead = async (ctx) => handle(ctx.request);

async function handle(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/v2" || path === "/v2/") {
    const primary = activeRegistry();
    return new Response(JSON.stringify({ message: "unauthorized" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer realm="${url.origin}/token",service="${primary.service}"`,
        "docker-distribution-api-version": "registry/2.0",
        ...corsHeaders(),
      },
    });
  }

  const { reg, failures } = await pickRegistry();

  // Docker Hub wants the "library/" prefix for official images; other
  // registries address them flat. Normalise per-registry.
  let upstreamPath = path;
  if (reg.namespace) {
    const m = upstreamPath.match(/^\/v2\/([^/]+)\/(manifests|blobs)\/(.*)$/);
    if (m && !m[1].includes("/")) {
      upstreamPath = `/v2/${reg.namespace}/${m[1]}/${m[2]}/${m[3]}`;
    }
  }

  const headers = new Headers();
  for (const h of ["range", "if-none-match", "if-modified-since"]) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("accept", request.headers.get("accept") || ACCEPT_MANIFEST);
  const auth = request.headers.get("authorization");
  if (auth) headers.set("authorization", auth);
  headers.set("user-agent", "EdgeMirror/1.0");

  let res;
  try {
    res = await fetch(reg.registry + upstreamPath + url.search, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers,
      redirect: "follow",
    });
  } catch (err) {
    return json(
      {
        ok: false,
        error: "registry_unreachable",
        message: "上游镜像仓库连接失败，请稍后重试。",
        detail: String((err && err.name) || err),
        registry: reg.id,
        probeFailures: failures,
      },
      { status: 502 }
    );
  }

  const out = cleanResponseHeaders(res.headers);
  Object.assign(out, corsHeaders());
  out["x-edge-mirror-node"] = `registry:${reg.id}`;
  out["docker-distribution-api-version"] = "registry/2.0";

  // Point the client back at us when it needs to authenticate.
  if (res.status === 401) {
    const wa = res.headers.get("www-authenticate") || "";
    const scopeMatch = wa.match(/scope="([^"]+)"/);
    const scope = scopeMatch ? `,scope="${scopeMatch[1]}"` : "";
    out["www-authenticate"] =
      `Bearer realm="${url.origin}/token",service="${reg.service}"${scope}`;
  }

  if (path.includes("/blobs/sha256:")) {
    out["cache-control"] = "public, max-age=31536000, immutable";
  } else if (path.includes("/manifests/")) {
    out["cache-control"] = "public, max-age=3600";
  } else if (!out["cache-control"]) {
    out["cache-control"] = "public, max-age=300";
  }

  const noBody =
    request.method === "HEAD" || res.status === 204 || res.status === 304;
  return new Response(noBody ? null : res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: out,
  });
}
