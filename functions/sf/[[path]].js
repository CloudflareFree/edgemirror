import {
  json,
  forward,
  parseTarget,
  corsHeaders,
} from "../_lib/proxy.js";

const ALLOWED_HOSTS = [
  "downloads.sourceforge.net",
  "download.sourceforge.net",
  "sourceforge.net",
  "master.dl.sourceforge.net",
  "netix.dl.sourceforge.net",
  "cytranet.dl.sourceforge.net",
  "phoenixnap.dl.sourceforge.net",
  "versaweb.dl.sourceforge.net",
  "netcologne.dl.sourceforge.net",
  "astuteinternet.dl.sourceforge.net",
  "cfhcable.dl.sourceforge.net",
  "freefr.dl.sourceforge.net",
  "jaist.dl.sourceforge.net",
  "kumisystems.dl.sourceforge.net",
  "nchc.dl.sourceforge.net",
  "pilotfiber.dl.sourceforge.net",
  "tenet.dl.sourceforge.net",
  "ufpr.dl.sourceforge.net",
  "yer.dl.sourceforge.net",
];

const REJECT_MESSAGES = {
  missing_target: "请在链接后补充目标地址。",
  invalid_url: "链接格式无法解析，请确认是完整的 SourceForge 地址。",
  invalid_protocol: "仅支持 http / https 链接。",
  host_not_allowed: "目标域名不在 SourceForge 加速白名单内。",
};

export const onRequestOptions = () =>
  new Response(null, { status: 204, headers: corsHeaders() });

export async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const rest = url.pathname.replace(/^\/sf\/?/, "");

  if (!rest) {
    return json({
      ok: true,
      service: "sourceforge",
      usage: "/sf/<host>/<path>  或  /sf/https://原始链接",
      example:
        "/sf/downloads.sourceforge.net/project/sevenzip/7-Zip/24.09/7z2409-x64.exe",
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

  // SourceForge answers 302 -> geo-nearest dl mirror. Follow it so the user
  // receives bytes instead of a redirect to a host they may not reach.
  return forward(ctx.request, parsed.url, {
    node: null,
    redirect: "follow",
  });
}

export const onRequestHead = onRequestGet;
