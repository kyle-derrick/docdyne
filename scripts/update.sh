#!/usr/bin/env bash
# update.sh —— 一键更新已部署环境（make update）：
#   1) 守卫：工作区有未提交改动即中止（避免 pull 意外合并）；
#   2) git pull --ff-only（仅快进，出现分叉时提示手动处理）；
#   3) 探测当前运行 profile：onlyoffice 容器在跑 = full，否则 minimal；
#   4) 复用 deploy.sh 重建部署（.env 有效则零配置问答，仅部署前摘要
#      回车确认；增量 SQL 迁移幂等重跑，数据卷不动）。
# 只改了前端想要秒级生效可另用 make sync-frontend（不重建镜像）。
set -euo pipefail
cd "$(dirname "$0")/.."

command -v git >/dev/null 2>&1 || { echo '未检测到 git。' >&2; exit 1; }

if ! git diff --quiet HEAD || ! git diff --cached --quiet; then
  echo '工作区有未提交改动——先提交或 stash 后再 make update。' >&2
  git status --short | head -10 >&2
  exit 1
fi

echo '+ git pull --ff-only'
if ! git pull --ff-only; then
  echo 'git pull 未快进成功（本地分叉/网络问题）——请手动处理后重试。' >&2
  exit 1
fi

PROFILE='minimal'
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q -- '-onlyoffice-'; then
  PROFILE='full'
fi
echo "检测到当前部署形态：$PROFILE（按 onlyoffice 容器运行判定）"

exec bash scripts/deploy.sh --profile "$PROFILE"
