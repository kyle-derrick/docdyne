#!/usr/bin/env bash
# 一键部署编排（bash 版，与 deploy.ps1 同构；Linux 服务器用）：
#   docker 检查 → .env 初始化（缺省交互式；--auto 全随机无人值守）→
#   占位符补齐 → compose 校验 / 构建 / 按_profile 起栈。
# 用法：
#   ./scripts/deploy.sh                     # 交互式（profile 未指定时询问）
#   ./scripts/deploy.sh --profile minimal   # 极简栈（caddy+backend+postgres）
#   ./scripts/deploy.sh --profile full      # 完整栈（+redis+onlyoffice）
#   ./scripts/deploy.sh --auto [--profile f…]  # 无人值守：密钥全随机生成
# 交互说明：.env 缺失时逐项「回车 = 随机生成 / m = 手动输入 / s = 跳过」
#（见 gen-env.sh）；已存在时部署前展示非敏感配置摘要，可回车直接部署、
# e = 打开编辑器改 .env、q = 退出。
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE=''
AUTO=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="${2:?--profile 需要参数 minimal|full}"; shift ;;
    --auto) AUTO=1 ;;
    *) echo "未知参数：$1（支持 --profile minimal|full / --auto）" >&2; exit 1 ;;
  esac
  shift
done

run() { # 回显并执行；失败即停（set -e 语义下显式报错更友好）
  echo "+ $*"
  "$@"
}

# ---------- 前置检查 ----------
command -v docker >/dev/null 2>&1 || { echo '未检测到 docker，请先安装并启动 Docker。' >&2; exit 1; }
run docker compose version >/dev/null

# ---------- profile 选择（未指定且交互式时询问） ----------
if [[ -z "$PROFILE" ]]; then
  PROFILE='minimal'
  if [[ $AUTO -eq 0 && -t 0 ]]; then
    echo ''
    read -r -p '部署形态：回车 = minimal（极简）/ f = full（含 OnlyOffice/Redis）：' pick || true
    [[ "$pick" == "f" || "$pick" == "full" ]] && PROFILE='full'
  fi
fi
[[ "$PROFILE" == 'minimal' || "$PROFILE" == 'full' ]] || { echo "--profile 仅支持 minimal|full（收到：$PROFILE）" >&2; exit 1; }

# ---------- .env 初始化 / 占位符补齐 ----------
placeholders=('replace-with-at-least-32-random-bytes' 'change-this-password' 'CHANGE_ME' 'CHANGE_ME_')
gen_env='scripts/gen-env.sh'
if [[ ! -f .env ]]; then
  if [[ $AUTO -eq 1 ]]; then
    run bash "$gen_env" --auto
  else
    run bash "$gen_env" # 交互式：每项随机/手动/跳过
  fi
fi
env_text="$(cat .env)"
missing=()
for p in "${placeholders[@]}"; do
  grep -qF "$p" <<<"$env_text" && missing+=("$p")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  patch=1
  if [[ $AUTO -eq 0 && -t 0 ]]; then
    echo ''
    echo "警告：.env 仍含模板密钥占位符（${missing[*]}）。"
    read -r -p '回车 = 自动生成并替换全部占位密钥 / m = 我自己改完后重试：' ans || true
    patch=$([[ "$ans" == "m" ]] && echo 0 || echo 1)
  fi
  if [[ $patch -eq 1 ]]; then
    # --patch 会重写 PG 密码/JWT/管理员等全部键——仅用于占位符未清的
    # 新装/半装环境；已正常运行的环境不应走到这里（占位符已清）。
    run bash "$gen_env" --patch $([[ $AUTO -eq 1 ]] && echo --auto)
    env_text="$(cat .env)"
    left=()
    for p in "${placeholders[@]}"; do
      grep -qF "$p" <<<"$env_text" && left+=("$p")
    done
    [[ ${#left[@]} -gt 0 ]] && { echo "替换后仍有占位符残留：${left[*]}，请手动检查 .env。" >&2; exit 1; }
  else
    echo '请设置 JWT_SECRET、SEED_ADMIN_PASSWORD、POSTGRES_PASSWORD 等密钥后重试（已有 .env 不会被覆盖）。' >&2
    exit 1
  fi
fi

# ---------- 部署前摘要（交互式；密钥不回显） ----------
if [[ $AUTO -eq 0 && -t 0 ]]; then
  echo ''
  echo '==== 当前部署配置（非敏感项）===='
  for k in APP_DOMAIN PUBLIC_BASE_URL STORAGE_DRIVER SEARCH_DRIVER SEED_ADMIN_EMAIL SEED_ADMIN_USERNAME AI_OUTBOUND_PROXY; do
    v="$(grep -E "^$k=" .env | head -1 | cut -d= -f2- || true)"
    [[ -n "$v" ]] && printf '  %-22s %s\n' "$k" "$v"
  done
  echo "  部署形态              $PROFILE"
  echo '================================'
  read -r -p '回车 = 开始部署 / e = 先编辑 .env / q = 退出：' act || true
  case "$act" in
    e) "${EDITOR:-vi}" .env ;;
    q) echo '已退出（未做任何变更）。'; exit 0 ;;
  esac
fi

# ---------- 构建 + 起栈 ----------
run docker compose config --quiet
run docker compose build backend caddy migrate seed
if [[ "$PROFILE" == 'full' ]]; then
  export ONLYOFFICE_UPSTREAM='onlyoffice:80' # caddy 反代上游（服务未起时主机名不解析）
  run docker compose --profile full up -d
  unset ONLYOFFICE_UPSTREAM
else
  run docker compose --profile minimal up -d
fi

echo ''
echo "部署完成（$PROFILE profile）。migrate/seed 已由 compose 按依赖顺序执行。"
echo '访问地址：http://<服务器地址>/（配置 APP_DOMAIN 后使用对应域名/HTTPS）'
echo '默认账号：.env 中 SEED_ADMIN_EMAIL / SEED_ADMIN_USERNAME 与 SEED_ADMIN_PASSWORD；首次登录后请立即修改密码。'
