#!/usr/bin/env bash
# EdgeMirror — one-shot deploy to Cloudflare Pages + custom domain.
#
# Prerequisites:
#   gh   authenticated with access to the CloudflareFree org
#   cf   authenticated (cf auth login)
#
# Usage: ./deploy.sh [--skip-repo] [--skip-domain]
set -euo pipefail

PROJECT="edgemirror"
DOMAIN="mirror.137101.xyz"
ZONE="137101.xyz"
ORG="CloudflareFree"
REPO="edgemirror"
BRANCH="main"

skip_repo=0
skip_domain=0
for arg in "$@"; do
  case "$arg" in
    --skip-repo) skip_repo=1 ;;
    --skip-domain) skip_domain=1 ;;
  esac
done

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- 1. repo
if [ "$skip_repo" -eq 0 ]; then
  say "GitHub 仓库 ${ORG}/${REPO}"
  if gh repo view "${ORG}/${REPO}" >/dev/null 2>&1; then
    ok "仓库已存在，跳过创建"
  else
    gh repo create "${ORG}/${REPO}" \
      --public \
      --description "GitHub / Docker / SourceForge 加速网关 · 部署于 Cloudflare 边缘网络" \
      --disable-wiki
    ok "仓库已创建"
  fi

  if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "https://github.com/${ORG}/${REPO}.git"
  else
    git remote add origin "https://github.com/${ORG}/${REPO}.git"
  fi
  ok "remote origin -> ${ORG}/${REPO}"
fi

# --------------------------------------------------------------- 2. pages
say "Cloudflare Pages 项目 ${PROJECT}"
if cf pages projects get "$PROJECT" >/dev/null 2>&1; then
  ok "项目已存在"
else
  cf pages projects create "$PROJECT" --production-branch "$BRANCH" >/dev/null
  ok "项目已创建"
fi

say "上传静态资源与函数"
npx wrangler pages deploy public --project-name="$PROJECT" --branch="$BRANCH" \
  --commit-dirty=true
ok "部署完成"

# -------------------------------------------------------------- 3. domain
if [ "$skip_domain" -eq 0 ]; then
  say "绑定自定义域名 ${DOMAIN}"
  if cf pages projects domains list "$PROJECT" 2>/dev/null | grep -q "$DOMAIN"; then
    ok "域名已绑定"
  else
    cf pages projects domains create "$PROJECT" --name "$DOMAIN" >/dev/null 2>&1 \
      || cf pages projects domains create "$PROJECT" "$DOMAIN" >/dev/null
    ok "域名已添加"
  fi

  if ! cf dns records list --zone "$ZONE" 2>/dev/null | grep -q "$DOMAIN"; then
    say "创建 DNS 记录"
    cf dns records create --zone "$ZONE" \
      --type CNAME --name "mirror" --content "$PROJECT.pages.dev" --proxied \
      >/dev/null 2>&1 || true
    ok "CNAME mirror -> ${PROJECT}.pages.dev"
  else
    ok "DNS 记录已存在"
  fi
fi

say "验证"
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://${DOMAIN}/" || echo 000)
  if [ "$code" = "200" ]; then
    ok "https://${DOMAIN}/ -> 200"
    break
  fi
  printf '  等待 DNS/证书生效… (%s/20) %s\n' "$i" "$code"
  sleep 10
done

curl -s "https://${DOMAIN}/api/health" | head -20 || true
printf '\n\033[1;32m完成\033[0m  https://%s\n' "$DOMAIN"
