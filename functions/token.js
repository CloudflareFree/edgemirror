import { json, corsHeaders } from "./_lib/proxy.js";
import { DOCKER_REGISTRIES, activeRegistry } from "./_config/nodes.js";

const MAX_TTL = 300;

export const onRequestOptions = () =>
  new Response(null, { status: 204, headers: corsHeaders() });

/**
 * Docker Registry v2 auth realm.
 *
 * The challenge emitted by /v2/ points here, so `docker pull` never contacts
 * the upstream auth service directly. We mint an anonymous pull token for
 * public images and cap its lifetime before handing it to the client.
 */
export async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const scope = url.searchParams.get("scope") || "";
  const requestedService = url.searchParams.get("service") || "";

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

  // Try each enabled registry in order; the first that mints a token wins.
  const candidates = [
    ...DOCKER_REGISTRIES.filter(
      (r) => r.enabled && (!requestedService || r.service === requestedService)
    ),
    ...DOCKER_REGISTRIES.filter(
      (r) => r.enabled && requestedService && r.service !== requestedService
    ),
  ];

  const errors = [];
  for (const reg of candidates) {
    try {
      const upstream =
        `${reg.tokenUrl}/token?service=${encodeURIComponent(reg.service)}` +
        `&scope=${encodeURIComponent(scope)}`;

      const res = await fetch(upstream, {
        headers: { "user-agent": "EdgeMirror/1.0" },
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
      return json(
        {
          token,
          access_token: token,
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
    },
    { status: 502 }
  );
}
