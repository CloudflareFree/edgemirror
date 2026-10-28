/**
 * EdgeMirror — node configuration.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  THIS IS THE ONLY FILE YOU EDIT TO ROTATE OR ADD NODES.
 * ═══════════════════════════════════════════════════════════════════
 *
 * A node is an upstream that can carry traffic for this site.
 *
 *   mode: "direct"    -> fetch the origin (github.com / registry-1.docker.io)
 *                        straight from a Cloudflare edge PoP. Fastest, no
 *                        third party sees the traffic.
 *
 *   mode: "upstream"  -> forward through `baseUrl`, a mirror that speaks the
 *                        gh-proxy convention:  <baseUrl><original-url>
 *
 * So if a third-party mirror dies, set `enabled: false` on it and the UI
 * drops it from the picker; set `enabled: true` on a replacement. No code
 * changes, no redeploy of anything but this Worker.
 */

/**
 * Docker registry upstreams, tried in order until one answers.
 *
 * `tokenUrl` is the OAuth2 realm that mints pull tokens for that registry.
 * Swap the first entry if Docker Hub becomes unreachable from your region —
 * the handler walks the list and uses the first healthy one.
 */
export const DOCKER_REGISTRIES = [
  {
    id: "dockerhub",
    name: "Docker Hub",
    registry: "https://registry-1.docker.io",
    tokenUrl: "https://auth.docker.io",
    service: "registry.docker.io",
    namespace: "library",
    enabled: true,
  },
  {
    id: "ghcr",
    name: "GitHub Container Registry",
    registry: "https://ghcr.io",
    tokenUrl: "https://ghcr.io",
    service: "ghcr.io",
    namespace: "",
    enabled: true,
  },
];

export const activeRegistry = () =>
  DOCKER_REGISTRIES.find((r) => r.enabled) || DOCKER_REGISTRIES[0];

/** Enabled registries in preference order, for fail-over in the /v2 handler. */
export const enabledRegistries = () =>
  DOCKER_REGISTRIES.filter((r) => r.enabled);

export const SITE = {
  name: "EdgeMirror",
  tagline: "GitHub · Docker · SourceForge 全球加速网关",
  domain: "mirror.137101.xyz",
  origin: "https://mirror.137101.xyz",
  repo: "https://github.com/CloudflareFree/edgemirror",
  version: "1.0.0",
};

/**
 * Order matters: the first enabled primary node is the default in the UI.
 * `regions` lists which services a node can carry.
 */
export const NODES = [
  {
    id: "ghproxy",
    name: "社区镜像 · 主线路",
    region: "gh-proxy.com · 多地域",
    flag: "HK",
    kind: "primary",
    enabled: true,
    mode: "redirect",
    baseUrl: "https://gh-proxy.com/",
    services: ["github"],
    note: "302 重定向到 gh-proxy 的多地域节点，字节不经过本站。",
  },
  {
    id: "ghproxy-net",
    name: "社区镜像 · 备用",
    region: "ghproxy.net · 亚太",
    flag: "AP",
    kind: "fallback",
    enabled: true,
    mode: "redirect",
    baseUrl: "https://ghproxy.net/",
    services: ["github"],
    note: "备用重定向线路，主线路异常时可切换。",
  },
  {
    id: "ghfast",
    name: "社区镜像 · 备用 2",
    region: "ghfast.top · 全球",
    flag: "GL",
    kind: "fallback",
    enabled: true,
    mode: "redirect",
    baseUrl: "https://ghfast.top/",
    services: ["github"],
    note: "备用重定向线路。",
  },
  {
    id: "direct",
    name: "边缘直连",
    region: "Global Anycast · 300+ PoP",
    flag: "CF",
    kind: "fallback",
    enabled: true,
    mode: "direct",
    baseUrl: null,
    services: ["github", "docker", "sourceforge"],
    note: "Cloudflare 边缘直接回源。会消耗 Workers 流量，仅在镜像站不可用时使用。",
  },
];

/** Services rendered in the UI, in display order. */
export const SERVICES = [
  {
    id: "github",
    name: "GitHub 文件加速",
    short: "GitHub",
    icon: "github",
    description:
      "Releases 资产、Raw 原文、Archive 源码包、Gist 与 codeload 归档的流式转发，支持 Range 断点续传。",
    placeholder: "https://github.com/user/repo/releases/download/v1.0/app.zip",
    examples: [
      {
        label: "Release 资产包",
        url: "https://github.com/astral-sh/uv/releases/download/0.5.11/uv-x86_64-unknown-linux-gnu.tar.gz",
      },
      {
        label: "Raw 原始文件",
        url: "https://raw.githubusercontent.com/torvalds/linux/master/README",
      },
      {
        label: "仓库归档 Zip",
        url: "https://github.com/cloudflare/workers-sdk/archive/refs/heads/main.zip",
      },
    ],
  },
  {
    id: "docker",
    name: "Docker 镜像加速",
    short: "Docker",
    icon: "docker",
    description:
      "对接 Docker Hub v2 registry，自动换取匿名 Bearer token，支持 manifest 与 blob 分层下载。",
    placeholder: "nginx:latest",
    usage: "docker pull mirror.137101.xyz/{image}",
    examples: [
      { label: "nginx", url: "library/nginx:latest" },
      { label: "busybox", url: "library/busybox:latest" },
      { label: "postgres", url: "library/postgres:16" },
    ],
    configSnippet: `{
  "registry-mirrors": ["https://mirror.137101.xyz"]
}`,
  },
  {
    id: "sourceforge",
    name: "SourceForge 加速",
    short: "SourceForge",
    icon: "sourceforge",
    description:
      "SourceForge 项目文件与镜像下载，自动跟随 302 重定向到地理最近的原始镜像站。",
    placeholder:
      "https://downloads.sourceforge.net/project/sevenzip/7-Zip/24.09/7z2409-x64.exe",
    examples: [
      {
        label: "7-Zip 24.09",
        url: "https://downloads.sourceforge.net/project/sevenzip/7-Zip/24.09/7z2409-x64.exe",
      },
      {
        label: "Notepad++ 8.7",
        url: "https://downloads.sourceforge.net/project/notepad-plus/Notepad%2B%2B%20v8.7/npp.8.7.Installer.x64.exe",
      },
    ],
  },
];

export const enabledNodes = () => NODES.filter((n) => n.enabled);

export const pickNode = (requestedId, serviceId) => {
  const pool = enabledNodes().filter(
    (n) => !serviceId || n.services.includes(serviceId)
  );
  if (requestedId) {
    const exact = pool.find((n) => n.id === requestedId);
    if (exact) return exact;
  }
  return pool.find((n) => n.kind === "primary") || pool[0] || null;
};

export const getNodeConfig = () => ({
  site: SITE,
  nodes: enabledNodes(),
  services: SERVICES,
});
