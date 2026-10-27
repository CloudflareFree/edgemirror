/**
 * Shared registry selection.
 *
 * `/v2/...` and `/token` MUST agree on which upstream registry is in play:
 * a token minted by GHCR is meaningless to Docker Hub, and vice versa. Both
 * handlers import from here so the choice is made once per isolate and
 * reused.
 *
 * Selection is a short GET probe against each enabled registry's /v2/
 * endpoint. Any HTTP answer below 500 proves the host is reachable — a 401
 * is the normal "needs a token" reply, not a failure.
 */

import { DOCKER_REGISTRIES, enabledRegistries, activeRegistry } from "../_config/nodes.js";

const PROBE_TIMEOUT_MS = 3500;
const PROBE_TTL_MS = 60_000;

/** { id, at } of the last registry that answered. Per-isolate. */
let cached = null;

export async function pickRegistry() {
  const all = enabledRegistries();
  if (all.length === 1) return { reg: all[0], failures: [] };

  if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
    const hit = all.find((r) => r.id === cached.id);
    if (hit) return { reg: hit, failures: [] };
  }

  const failures = [];
  for (const reg of all) {
    // A registry that just returned 429 is reachable but useless right now;
    // skip it so we can serve from an alternative instead of failing.
    if (isRateLimited(reg.id)) {
      failures.push({ registry: reg.id, skipped: "rate_limited" });
      continue;
    }
    try {
      // GET, not HEAD: several registries answer 405 to HEAD on /v2/.
      const res = await fetch(`${reg.registry}/v2/`, {
        method: "GET",
        headers: { "user-agent": "EdgeMirror/1.0" },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (res.body) await res.body.cancel();
      if (res.status < 500) {
        cached = { id: reg.id, at: Date.now() };
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

  // Nothing answered: let the caller fail against the configured primary so
  // the error names a real upstream instead of a guess.
  return { reg: activeRegistry(), failures };
}

/** Registries worth trying for a token, best first. */
export function tokenCandidates() {
  return DOCKER_REGISTRIES.filter((r) => r.enabled);
}

/**
 * Mark a registry as rate-limited so the next request skips it.
 *
 * Docker Hub throttles anonymous pulls per source IP, and on Workers every
 * request shares Cloudflare's egress pool — so a 429 here is routine, not an
 * error. Skipping the throttled registry for a minute keeps pulls working
 * for images that exist elsewhere (GHCR) instead of failing every request.
 */
export function noteRateLimited(regId, ms = 60_000) {
  if (!cached || cached.id !== regId) {
    // Nothing selected yet: force a re-probe on the next call.
    cached = null;
  }
  rateLimited.set(regId, Date.now() + ms);
}

const rateLimited = new Map();

export function isRateLimited(regId) {
  const until = rateLimited.get(regId);
  if (!until) return false;
  if (Date.now() > until) {
    rateLimited.delete(regId);
    return false;
  }
  return true;
}

/**
 * Which registry owns a token.
 *
 * We mint tokens with a `v1:<scope>:<registry-id>` prefix so the pull that
 * follows can route to the registry that issued it. The client treats the
 * token as opaque, so this is invisible to Docker — but it means a token
 * minted by GHCR is never sent to Docker Hub, and a Docker Hub outage can
 * fall through to another registry without a 403.
 */
const TOKEN_PREFIX = "v1";

export function encodeToken(reg, scope, token) {
  return `${TOKEN_PREFIX}.${reg.id}.${token}`;
}

export function decodeToken(authorization) {
  if (!authorization) return null;
  const m = /^Bearer\s+v1\.([a-z0-9-]+)\.(.+)$/i.exec(authorization);
  if (!m) return null;
  return { registryId: m[1], token: m[2] };
}
