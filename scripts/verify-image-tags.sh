#!/usr/bin/env bash
# verify-image-tags.sh —— 核验 docker-compose.yml 引用的全部外部镜像 tag
# 在目标 registry 上真实存在（拦截 clamav:1.4.1 这类「tag 不存在」的坑）。
# 用法：bash scripts/verify-image-tags.sh（CI 与本地均可用）。
# 原理：对每个镜像做 registry v2 manifest HEAD/GET——docker.io 走匿名
# token 握手，quay.io 走 Bearer challenge；非 2xx 即报错。
set -euo pipefail
cd "$(dirname "$0")/.."

# 从 compose 提取外部镜像（排除 docdyne/ 前缀的自建镜像）
mapfile -t images < <(
  grep -E '^\s+image:' docker-compose.yml \
    | sed 's/.*image:\s*//' \
    | sed 's/\${[^}]*:-\(.*\)}/\1/' \
    | grep -v '^docdyne/' \
    | sort -u
)

if [[ ${#images[@]} -eq 0 ]]; then
  echo "（compose 无外部镜像引用）"; exit 0
fi

echo "核验 ${#images[@]} 个外部镜像 tag……"

fail=0
for img in "${images[@]}"; do
  # 拆 registry / repo / tag
  registry="registry-1.docker.io"
  rest="$img"
  if [[ "$img" == */* ]]; then
    # 含斜杠：判定是否自定义 registry（有域名前缀且非 docker.io 命名空间）
    first="${img%%/*}"
    if [[ "$first" == *.* || "$first" == localhost* ]]; then
      registry="$first"
      rest="${img#*/}"
    fi
  fi
  repo="$rest"
  tag="latest"
  if [[ "$rest" == *:* ]]; then
    repo="${rest%:*}"
    tag="${rest##*:}"
  fi
  # docker.io 官方库无命名空间前缀时补 library/
  if [[ "$registry" == "registry-1.docker.io" && "$repo" != */* ]]; then
    repo="library/$repo"
  fi

  # scheme
  proto="https"
  [[ "$registry" == localhost* ]] && proto="http"

  # 获取 manifest（跟 token challenge）
  url="$proto://$registry/v2/$repo/manifests/$tag"
  www=$(curl -sS -o /dev/null -D - --max-time 15 "$url" \
    -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.index.v1+json" 2>/dev/null | tr -d '\r')
  code=$(echo "$www" | head -1 | awk '{print $2}')

  if [[ "$code" == "401" ]]; then
    # token 握手
    realm=$(echo "$www" | grep -i '^www-authenticate:' | grep -oE 'realm="[^"]+"' | head -1 | cut -d'"' -f2)
    service=$(echo "$www" | grep -i '^www-authenticate:' | grep -oE 'service="[^"]+"' | head -1 | cut -d'"' -f2)
    if [[ -n "$realm" ]]; then
      tok_url="$realm?service=$service&scope=repository:$repo:pull"
      tok=$(curl -sS --max-time 15 "$tok_url" 2>/dev/null | grep -oE '"token":"[^"]+"' | head -1 | cut -d'"' -f4)
      if [[ -n "$tok" ]]; then
        code=$(curl -sS -o /dev/null --max-time 15 -w '%{http_code}' "$url" \
          -H "Authorization: Bearer $tok" \
          -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.index.v1+json" 2>/dev/null)
      fi
    fi
  fi

  if [[ "$code" =~ ^2 ]]; then
    echo "  ✓ $img"
  elif docker manifest inspect "$img" > /dev/null 2>&1; then
    # quay.io 等非标 auth flow：curl 握手可能不兼容，docker 自带客户端兜底
    echo "  ✓ $img (via docker)"
  else
    echo "  ✗ $img  (HTTP $code)" >&2
    fail=$((fail + 1))
  fi
done

if [[ $fail -gt 0 ]]; then
  echo "::error::$fail 个镜像 tag 不存在或不可达，部署会失败。" >&2
  exit 1
fi
echo "全部镜像 tag 有效。"
