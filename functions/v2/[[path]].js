import { cleanResponseHeaders, corsHeaders, json } from "../_lib/proxy.js";
import {
  pickRegistry,
  noteRateLimited,
  decodeToken,
} from "../_lib/registry.js";
import { activeRegistry, DOCKER_REGISTRIES } from "../_config/nodes.js";

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

  const { reg: preferred, failures } = await pickRegistry();

  const headers = new Headers();
  for (const h of ["range", "if-none-match", "if-modified-since"]) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("accept", request.headers.get("accept") || ACCEPT_MANIFEST);
  headers.set("user-agent", "EdgeMirror/1.0");

  // A token is only valid for the registry that minted it, so route by the
  // tag we embedded in it. Untagged (client-supplied) credentials follow the
  // normal path unchanged.
  const decoded = decodeToken(request.headers.get("authorization"));
  const candidates = [];

  if (decoded) {
    // A tagged token is valid only at the registry that minted it. Sending
    // it elsewhere yields 403, so there is nothing to fall through to: the
    // client must re-request a token if this registry is throttled.
    const owner = DOCKER_REGISTRIES.find(
      (r) => r.id === decoded.registryId && r.enabled
    );
    if (owner) candidates.push(owner);
    headers.set("authorization", `Bearer ${decoded.token}`);
  } else {
    const auth = request.headers.get("authorization");
    if (auth) headers.set("authorization", auth);

    // No tagged token: the client is anonymous or brought its own
    // credentials, so any enabled registry can serve it. Docker Hub throttles
    // anonymous pulls by source IP and Workers share Cloudflare's egress
    // pool, so a 429 there is expected — falling through keeps pulls alive
    // for images present in more than one registry.
    for (const reg of [preferred, ...DOCKER_REGISTRIES.filter((r) => r.enabled)]) {
      if (reg && !candidates.some((c) => c.id === reg.id)) candidates.push(reg);
    }
  }

  let res = null;
  let reg = preferred;
  const attemptErrors = [];

  for (const candidate of candidates) {
    // Docker Hub wants the "library/" prefix for official images; other
    // registries address them flat. Normalise per-registry.
    let upstreamPath = path;
    if (candidate.namespace) {
      const m = upstreamPath.match(/^\/v2\/([^/]+)\/(manifests|blobs)\/(.*)$/);
      if (m && !m[1].includes("/")) {
        upstreamPath = `/v2/${candidate.namespace}/${m[1]}/${m[2]}/${m[3]}`;
      }
    }

    try {
      const attempt = await fetch(candidate.registry + upstreamPath + url.search, {
        method: request.method === "HEAD" ? "HEAD" : "GET",
        headers,
        redirect: "follow",
      });

      if (attempt.status === 429) {
        noteRateLimited(candidate.id);
        attemptErrors.push({ registry: candidate.id, status: 429 });
        if (attempt.body) await attempt.body.cancel();

        // A tagged token cannot be replayed at another registry, so there is
        // no useful fallback — surface the throttle honestly, with a hint
        // that logged-in pulls are not affected.
        if (decoded && candidates.length === 1) {
          return new Response(
            JSON.stringify({
              errors: [
                {
                  code: "TOOMANYREQUESTS",
                  message:
                    "Docker Hub 匿名拉取限流（Cloudflare 出口 IP 共享）。" +
                    "请稍后重试，或 docker login 后使用个人额度。",
                },
              ],
            }),
            {
              status: 429,
              headers: {
                "content-type": "application/json",
                "retry-after": "60",
                "x-edge-mirror-node": `registry:${candidate.id}`,
                ...corsHeaders(),
              },
            }
          );
        }
        continue;
      }

      res = attempt;
      reg = candidate;
      break;
    } catch (err) {
      attemptErrors.push({
        registry: candidate.id,
        error: String((err && err.name) || err),
      });
    }
  }

  if (!res) {
    return json(
      {
        ok: false,
        error: "registry_unavailable",
        message:
          "上游镜像仓库暂时不可用（可能触发匿名拉取限流），请稍后重试，" +
          "或在 Docker 中登录后使用官方源。",
        attempts: attemptErrors,
        probeFailures: failures,
      },
      { status: 503 }
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
