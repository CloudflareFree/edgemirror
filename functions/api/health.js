import { getNodeConfig } from "../_config/nodes.js";
import { json, corsHeaders } from "../_lib/proxy.js";

export const onRequestOptions = () =>
  new Response(null, { status: 204, headers: corsHeaders() });

/**
 * Live node health.
 *
 *   GET /api/health           probe all enabled nodes in parallel
 *   GET /api/health?node=id   probe one
 *
 * A node is up when a 1-byte Range request against a permanently-hosted
 * asset returns 200/206 inside the timeout. Probing our own /gh route means
 * we test the real user path, not just DNS reachability.
 */
export async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const only = url.searchParams.get("node");
  const { nodes } = getNodeConfig();

  const targets = only ? nodes.filter((n) => n.id === only) : nodes;
  if (only && targets.length === 0) {
    return json(
      { ok: false, error: "unknown_node", node: only },
      { status: 404 }
    );
  }

  const TIMEOUT_MS = 4500;
  // Probe a tiny raw file: every gh-proxy-style mirror supports raw
  // downloads, whereas things like favicon.ico are commonly blocked.
  const PROBE_PATH =
    "/gh/raw.githubusercontent.com/torvalds/linux/master/README";

  const results = await Promise.all(
    targets.map(async (node) => {
      const started = Date.now();
      const probe = new URL(PROBE_PATH, url.origin);
      probe.searchParams.set("node", node.id);
      probe.searchParams.set("_h", String(started));

      try {
        const res = await fetch(probe.toString(), {
          headers: { range: "bytes=0-0", "user-agent": "EdgeMirror-Health/1.0" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const ms = Date.now() - started;
        const up = res.status === 200 || res.status === 206;
        // Drain so the runtime can reuse the connection.
        if (res.body) await res.body.cancel();
        return {
          id: node.id,
          name: node.name,
          region: node.region,
          flag: node.flag,
          kind: node.kind,
          status: up ? "up" : "degraded",
          latencyMs: ms,
          httpStatus: res.status,
        };
      } catch (err) {
        return {
          id: node.id,
          name: node.name,
          region: node.region,
          flag: node.flag,
          kind: node.kind,
          status: "down",
          latencyMs: Date.now() - started,
          error: String((err && err.name) || err),
        };
      }
    })
  );

  const up = results.filter((r) => r.status === "up").length;
  return json(
    {
      ok: true,
      checkedAt: new Date().toISOString(),
      summary: { total: results.length, up, down: results.length - up },
      nodes: results.sort((a, b) => a.latencyMs - b.latencyMs),
    },
    { headers: { "cache-control": "no-store" } }
  );
}
