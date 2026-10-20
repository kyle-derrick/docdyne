#!/usr/bin/env bash
# verify-image-tags.sh —— 核验 docker-compose.yml 引用的全部外部镜像 tag
# 真实存在（拦截 clamav:1.4.1 这类「tag 不存在」的坑）。
# 用法：bash scripts/verify-image-tags.sh（需 Docker，CI 与本地均可用）。
# 原理：docker manifest inspect 对每个镜像做只读探测——Docker 客户端
# 自带各家 registry（docker.io/quay.io 等）的认证握手，无需手动模拟。
set -euo pipefail
cd "$(dirname "$0")/.."

# 从 compose 提取外部镜像（排除 docdyne/ 前缀的自建镜像；解析 ${VAR:-默认值}）
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
  if docker manifest inspect "$img" > /dev/null 2>&1; then
    echo "  ✓ $img"
  elif [[ "$img" == quay.io/* ]]; then
    # quay.io 对匿名 manifest 查询不可靠（部分公开仓库拒绝匿名 registry API
    # 探测，但 docker pull 实际可用且网页端显示正常——2026-10 CI + 本地双
    # 重实证）。降级为警告不阻塞；compose 的 MINIO_IMAGE 覆盖口兜底。
    echo "  ⚠ $img  (quay.io 匿名 manifest 查询受限，不影响实际拉取)" >&2
  else
    echo "  ✗ $img  (manifest 不存在或不可达)" >&2
    fail=$((fail + 1))
  fi
done

[[ $fail -gt 0 ]] && { echo "::error::$fail 个镜像 tag 不存在，部署会失败。" >&2; exit 1; }
echo "全部镜像 tag 有效（quay.io 警告不计入失败）。"
