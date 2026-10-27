import { json, corsHeaders } from "./_lib/proxy.js";
import { pickRegistry, encodeToken } from "./_lib/registry.js";
import { DOCKER_REGISTRIES } from "./_config/nodes.js";

const MAX_TTL = 300;

export const onRequestOptions = () =>
  new Response(null, { status: 204, headers: corsHeaders() });

/**
 * Docker Registry v2 auth realm.
 *
 * The challenge emitted by /v2/ points here so `docker pull` never contacts
 * the upstream auth service. We mint an anonymous pull token and cap its
 * lifetime before handing it to the client.
 *
 * The registry is resolved with the *same* selector /v2/ uses — a token from
 * GHCR is useless to Docker Hub, so the two endpoints must never disagree.
 */
export async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const scope = url.searchParams.get("scope") || "";

  if (!scope) {
    return json(
      {
        ok: true,
        realm: `${url.origin}/token`,
        usage: "由 /v2/ 的 WWW-Authenticate 挑战自动调用，无需手动访问。",
        registries: DOCKER_REGISTRIES.filter((r) => r.enabled).map((r) => ({
          id: r.id,
          name: r.name,
        })),
      },
      { headers: { "cache-control": "no-store" } }
    );
  }

  const { reg: preferred, failures: probeFailures } = await pickRegistry();

  // Try the selected registry first, then the rest as a fallback.
  const candidates = [
    preferred,
    ...DOCKER_REGISTRIES.filter((r) => r.enabled && r.id !== preferred.id),
  ];

  // A token tagged with a specific service is only meaningful to that
  // registry, so honour the request rather than guessing.
  const requestedService = url.searchParams.get("service") || "";
  if (requestedService) {
    const match = candidates.find((r) => r.service === requestedService);
    if (match) {
      candidates.length = 0;
      candidates.push(match);
    }
  }

  const errors = [];
  for (const reg of candidates) {
    try {
      const upstream =
        `${reg.tokenUrl}/token?service=${encodeURIComponent(reg.service)}` +
        `&scope=${encodeURIComponent(scope)}`;

      // Docker Hub rate-limits anonymous pulls per source IP, and every
      // Worker request shares Cloudflare's egress pool — so the anonymous
      // quota is effectively always exhausted. Supplying a free Docker Hub
      // account lifts the limit substantially:
      //   npx wrangler pages secret put DOCKERHUB_USER
      //   npx wrangler pages secret put DOCKERHUB_TOKEN
      const tokenHeaders = { "user-agent": "EdgeMirror/1.0" };
      const hubUser = ctx.env?.DOCKERHUB_USER;
      const hubPass = ctx.env?.DOCKERHUB_TOKEN;
      if (reg.id === "dockerhub" && hubUser && hubPass) {
        tokenHeaders.authorization =
          "Basic " + btoa(`${hubUser}:${hubPass}`);
      }

      const res = await fetch(upstream, {
        headers: tokenHeaders,
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        errors.push({ registry: reg.id, status: res.status });
        continue;
      }

      const data = await res.json();
      const token = data.token || data.access_token;
      if (!token) {
        errors.push({ registry: reg.id, status: "no_token" });
        continue;
      }

      const ttl = Math.min(Number(data.expires_in) || MAX_TTL, MAX_TTL);

      // Prefix the token with its issuing registry so the pull that follows
      // routes to the same registry. Docker treats the value as opaque, so
      // this is invisible to the client.
      const tagged = encodeToken(reg, scope, token);

      return json(
        {
          token: tagged,
          access_token: tagged,
          expires_in: ttl,
          issued_at: new Date().toISOString(),
          edge: { registry: reg.id, service: reg.service },
        },
        {
          headers: {
            "cache-control": `public, max-age=${Math.max(ttl - 30, 30)}`,
          },
        }
      );
    } catch (err) {
      errors.push({ registry: reg.id, error: String((err && err.name) || err) });
    }
  }

  return json(
    {
      ok: false,
      error: "token_unavailable",
      message: "所有上游 registry 均无法签发令牌，请稍后重试。",
      errors,
      probeFailures,
    },
    { status: 502 }
  );
}
