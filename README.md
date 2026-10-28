# EdgeMirror

GitHub / Docker / SourceForge 全球加速网关，部署于 Cloudflare Workers + Pages 边缘网络。

线上地址：<https://mirror.137101.xyz>

## 功能

| 服务 | 路径 | 说明 |
|---|---|---|
| GitHub 文件加速 | `/gh/<host>/<path>` | Releases 资产、Raw 原文、Archive 归档、Gist、codeload。流式转发，支持 Range 断点续传 |
| Docker 镜像加速 | `/v2/…` | Docker Hub / GHCR registry 镜像，自动换取匿名 Bearer token |
| SourceForge 加速 | `/sf/<host>/<path>` | 自动跟随 302 到地理最近的镜像站 |

两种写法都支持：

```
/gh/github.com/user/repo/releases/download/v1.0/app.zip
/gh/https://github.com/user/repo/releases/download/v1.0/app.zip
```

## 节点配置（核心）

**所有节点都在 `functions/_config/nodes.js` 里，改完重新部署即可，不用碰其他代码。**

```js
export const NODES = [
  {
    id: "direct",          // 唯一 id
    name: "边缘直连",       // 界面上显示的名字
    region: "Global Anycast · 300+ PoP",
    flag: "CF",            // 图标角标（2 个字母）
    kind: "primary",       // primary = 默认节点，fallback = 备用
    enabled: true,         // ← 节点挂了就改成 false
    mode: "redirect",      // redirect = 302 到镜像站，字节不经过本站（推荐）
                           // direct   = 边缘直接回源，消耗 Workers 流量
                           // upstream = 本站转发镜像站内容，也消耗流量
    baseUrl: "https://gh-proxy.com/",  // redirect/upstream 模式下填镜像地址
    services: ["github", "docker", "sourceforge"],  // 这个节点能承载哪些服务
  },
  {
    id: "ghproxy",
    name: "社区镜像 A",
    kind: "fallback",
    enabled: true,
    mode: "upstream",
    baseUrl: "https://gh-proxy.com/",   // ← 换节点只改这一行
    services: ["github"],
  },
];
```

### 节点挂了怎么换

1. 把挂掉的节点 `enabled` 改成 `false`（保留配置便于恢复）
2. 新增一个节点对象，填 `id` / `name` / `baseUrl`
3. `git commit && git push`，Cloudflare Pages 自动重新部署

前端节点列表、切换按钮、状态表格全部由这份配置驱动，**不需要改任何前端代码**。

### Docker registry 也可以换

`DOCKER_REGISTRIES` 同样在 `functions/_config/nodes.js`。默认优先 Docker Hub，
连不上时自动回落到 GHCR——这就是本机 Docker Hub 被墙时站点仍能正常服务的原因。

### Docker Hub 匿名限流（重要）

Docker Hub 对**每个源 IP** 的匿名拉取有配额，而 Cloudflare Workers 的所有请求
共用一组出口 IP —— 匿名配额基本永远是耗尽状态，会返回 `429 TOOMANYREQUESTS`。

免费缓解办法：用任意免费 Docker Hub 账号提额。

```bash
npx wrangler pages secret put DOCKERHUB_USER   --project-name=edgemirror
npx wrangler pages secret put DOCKERHUB_TOKEN  --project-name=edgemirror
```

`DOCKERHUB_TOKEN` 是 Docker Hub → Account Settings → Security → New Access Token
生成的 Personal Access Token，不是登录密码。

配置后 `/token` 会用该账号申请令牌，配额大幅提升。未配置时 GHCR 上的镜像
（如 `ghcr.io/...`）仍然正常，只是 Docker Hub 官方镜像会受限。

## 本地开发

```bash
npm install
npx wrangler pages dev public
# http://127.0.0.1:8788
```

## 测试

```bash
node test/integration.mjs   # 80 项：真实 handler + 真实上游，无 mock
node test/e2e.mjs           # 29 项：真实浏览器驱动
```

集成测试直接 `import` Worker 模块并用真实 `Request` 调用，所以本地通过就等于线上行为一致。
E2E 用 CDP 驱动 headless Chrome，覆盖转换逻辑、节点切换、键盘导航、响应式。

## 部署

项目连到 Cloudflare Pages，构建输出目录 `public`，函数目录 `functions`。
每次 push 到 `main` 自动部署。

手动部署：

```bash
npx wrangler pages deploy public --project-name=edgemirror
```

## 项目结构

```
functions/
  _config/nodes.js     ← 节点与 registry 配置（唯一需要改的文件）
  _lib/proxy.js        流式转发核心、白名单、缓存策略
  gh/[[path]].js       GitHub 加速
  sf/[[path]].js       SourceForge 加速
  v2/[[path]].js       Docker registry 镜像
  token.js             Docker token 中继
  api/nodes.js         节点配置 API
  api/health.js        节点健康探测 API
public/
  index.html           单页
  assets/app.css       设计系统
  assets/app.js        前端控制器（无框架）
  fonts/               自托管字体（Google Fonts 在国内不可达）
test/
  integration.mjs      集成测试
  e2e.mjs              浏览器 E2E
  shot.mjs             截图工具
```

## 安全边界

- 只允许白名单域名被代理，防止被当作开放代理滥用
- 纯流式转发，不落盘、不记录内容
- 上行 `Set-Cookie` / `CSP` / `X-Frame-Options` 一律剥离
- Docker token 有效期上限 300 秒

## License

MIT
