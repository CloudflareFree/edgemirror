import { pickNode } from "../_config/nodes.js";
import {
  json,
  forward,
  parseTarget,
  cachePolicyFor,
  corsHeaders,
} from "../_lib/proxy.js";

const ALLOWED_HOSTS = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
  "gist.githubusercontent.com",
  "gist.github.com",
  "api.github.com",
  "avatars.githubusercontent.com",
];

const REJECT_MESSAGES = {
  missing_target: "请在链接后补充目标地址。",
  invalid_url: "链接格式无法解析，请确认是完整的 GitHub 地址。",
  invalid_protocol: "仅支持 http / https 链接。",
  host_not_allowed: "目标域名不在 GitHub 加速白名单内。",
};

export const onRequestOptions = () =>
  new Response(null, { status: 204, headers: corsHeaders() });

export async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const rest = url.pathname.replace(/^\/gh\/?/, "");

  if (!rest) {
    return json({
      ok: true,
      service: "github",
      usage: "/gh/<host>/<path>  或  /gh/https://原始链接",
      example:
        "/gh/github.com/astral-sh/uv/releases/download/0.5.11/uv-x86_64-unknown-linux-gnu.tar.gz",
    });
  }

  const parsed = parseTarget(rest, ALLOWED_HOSTS);
  if (parsed.error) {
    return json(
      {
        ok: false,
        error: parsed.error,
        message: REJECT_MESSAGES[parsed.error] || "请求被拒绝。",
        ...(parsed.host ? { host: parsed.host } : {}),
        allowedHosts: ALLOWED_HOSTS,
      },
      { status: 400 }
    );
  }

  // Preserve the caller's query string when the target did not carry one.
  const target = new URL(parsed.url);
  if (url.search && !target.search) target.search = url.search;

  const node = pickNode(url.searchParams.get("node"), "github");
  if (!node) {
    return json(
      { ok: false, error: "no_node_available", message: "当前没有可用节点。" },
      { status: 503 }
    );
  }

  return forward(ctx.request, target.toString(), {
    node,
    cacheControl: cachePolicyFor(url.pathname),
  });
}

export const onRequestHead = onRequestGet;
