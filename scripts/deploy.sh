#!/usr/bin/env bash
# 一键部署编排（bash 版，与 deploy.ps1 同构；Linux/macOS 服务器用）：
#   docker 检查 → .env 配置（configure.sh 单遍 TUI；--auto 无人值守全随机）
#   → compose 校验 / 构建 / 按 profile 起栈。
# 用法：
#   ./scripts/deploy.sh                     # 交互式（profile 未指定时询问）
#   ./scripts/deploy.sh --profile minimal   # 极简栈（caddy+backend+postgres）
#   ./scripts/deploy.sh --profile full      # 完整栈（+redis+onlyoffice）
#   ./scripts/deploy.sh --auto [--profile …] # 无人值守：密钥全随机生成
# .env 语义：
#   - 缺失 → 打开 configure.sh（一次展示全部配置项，选择修改/其余自动生成）；
#   - 已存在且有效 → 直接用（绝不改动既有密钥）；
#   - 残留密钥占位符 → 非交互自动补齐（configure.sh --auto，不会重复问答）；
#     SMTP_PASS/域名类占位不算错误，只在摘要中提示。
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

run() {
  echo "+ $*"
  "$@"
}

command -v docker >/dev/null 2>&1 || { echo '未检测到 docker，请先安装并启动 Docker。' >&2; exit 1; }
run docker compose version >/dev/null

# ---------- profile 选择 ----------
if [[ -z "$PROFILE" ]]; then
  PROFILE='minimal'
  if [[ $AUTO -eq 0 && -t 0 ]]; then
    echo ''
    read -r -p '部署形态：回车 = minimal（极简）/ f = full（含 OnlyOffice/Redis）：' pick || true
    [[ "$pick" == "f" || "$pick" == "full" ]] && PROFILE='full'
  fi
fi
[[ "$PROFILE" == 'minimal' || "$PROFILE" == 'full' ]] || { echo "--profile 仅支持 minimal|full（收到：$PROFILE）" >&2; exit 1; }

# ---------- .env：配置（单遍）/ 自动补齐 ----------
CONFIGURE='scripts/configure.sh'
secret_placeholder_keys() { # 密钥类占位键（排除 SMTP/域名/地址类——生成无意义）
  grep -E '^[A-Z0-9_]+=.*(CHANGE_ME|change-this-password|replace-with-at-least-32-random-bytes)' .env \
    | cut -d= -f1 | grep -vE '(DOMAIN|URL|HOST|ADDR|PORT|EMAIL|USERNAME|(^|_)USER$|NAME$|^SMTP_)' || true
}

if [[ ! -f .env ]]; then
  if [[ $AUTO -eq 1 ]]; then
    run bash "$CONFIGURE" --auto
  else
    run bash "$CONFIGURE" # 单遍 TUI：一次展示全部配置项，自选修改，其余自动生成
  fi
elif [[ -n "$(secret_placeholder_keys)" ]]; then
  # 既有 .env 残留密钥占位：非交互自动补齐（现值全保留，只补占位密钥；
  # 绝不重复问答——这正是旧版「两轮问答」的病灶）。
  echo '检测到 .env 残留密钥占位符，自动补齐（其余配置原样保留）：'
  run bash "$CONFIGURE" --auto
  left="$(secret_placeholder_keys)"
  [[ -n "$left" ]] && { echo "自动补齐后仍有密钥占位残留：$left——请手动检查 .env。" >&2; exit 1; }
fi

# ---------- 管理员密码策略兜底（存量 .env 复用路径的最后一道闸） ----------
# configure.sh 已在输入侧校验（同款策略：≥12 位且含大写/小写/数字 ==
# auth.ValidatePasswordStrength）；此处拦截“旧版脚本时期写入/手工编辑”
# 的弱密码——否则会一路裸奔到 seed 容器才 fatal（compose 阻断 backend）。
seed_pw_ok() {
  local p; p="$(grep -E '^SEED_ADMIN_PASSWORD=' .env | head -1 | cut -d= -f2-)"
  [[ ${#p} -ge 12 && "$p" =~ [A-Z] && "$p" =~ [a-z] && "$p" =~ [0-9] ]]
}
if ! seed_pw_ok; then
  fixpw=1
  if [[ $AUTO -eq 1 || ! -t 0 ]]; then
    fixpw=2 # 无人值守/非交互（管道/CI）：自动换合规随机密码，与 configure --auto 同语义
  else
    echo ''
    echo '错误：.env 的 SEED_ADMIN_PASSWORD 不满足策略（≥12 位且含大写、小写与数字），'
    echo 'seed 容器会因此失败并阻断 backend/caddy 启动。'
    read -r -p '回车 = 进配置器重新设置（列表选改）/ a = 自动换合规随机密码 / q = 退出：' ans || true
    case "$ans" in
      q) echo '已退出。'; exit 1 ;;
      a) fixpw=2 ;;
      *) run bash "$CONFIGURE" ;;
    esac
  fi
  if [[ $fixpw -eq 2 ]]; then
    NEWPW="Docdyne-$(openssl rand -hex 6)"
    sed -i "s|^SEED_ADMIN_PASSWORD=.*|SEED_ADMIN_PASSWORD=$NEWPW|" .env
    echo "★ 已自动更换管理员密码：$NEWPW（请立即记录，登录用）"
  fi
  seed_pw_ok || { echo '密码仍不合规——请手动修改 .env 后重试。' >&2; exit 1; }
fi

# ---------- 部署前摘要（交互式；密钥不回显） ----------
show_summary() {
  echo ''
  echo '==== 当前部署配置（非敏感项）===='
  for k in APP_DOMAIN CONTENT_DOMAIN PUBLIC_BASE_URL STORAGE_DRIVER SEARCH_DRIVER SEED_ADMIN_EMAIL SEED_ADMIN_USERNAME AI_OUTBOUND_PROXY; do
    v="$(grep -E "^$k=" .env | head -1 | cut -d= -f2- || true)"
    [[ -n "$v" ]] && printf '  %-22s %s\n' "$k" "$v"
  done
  echo "  部署形态              $PROFILE"
  if [[ -n "$(grep -E '^SMTP_PASS=.*CHANGE_ME' .env || true)" ]]; then
    echo '  ⚠ SMTP_PASS           仍为占位（用到邮件通知时再填，不影响本次部署）'
  fi
  dom="$(grep -E '^[A-Z0-9_]*(DOMAIN|BASE_URL)[A-Z0-9_]*=.*example\.com' .env | cut -d= -f1 | tr '\n' ' ' || true)"
  [[ -n "$dom" ]] && echo "  ⚠ 域名占位            $dom（仍为 example.com，建议改为真实域名）"
  echo '================================'
}
if [[ $AUTO -eq 0 && -t 0 ]]; then
  show_summary
  read -r -p '回车 = 开始部署 / c（或 e）= 修改配置（编号选改）/ v = 编辑器打开 .env / q = 退出：' act || true
  case "$act" in
    c|e) run bash "$CONFIGURE" ;; # 编号列表选改（不再默认丢进 vim）
    v) "${EDITOR:-vi}" .env ;;
    q) echo '已退出（未做任何变更）。'; exit 0 ;;
  esac
  show_summary # 改完刷新摘要再确认一轮
  read -r -p '回车 = 开始部署 / q = 退出：' act || true
  [[ "$act" == "q" ]] && { echo '已退出。'; exit 0; }
fi

# ---------- 构建 + 起栈 ----------
# 依 .env 驱动开关联动可选 profile——服务缺位会让 backend 启动即失败
#（s3 无 minio / meili 无 meilisearch / SCAN_ENABLED 无 clamav）：
env_val() { grep -E "^$1=" .env | head -1 | cut -d= -f2- || true; }
PROFILE_ARGS=(--profile "$PROFILE")
if [[ "$(env_val SEARCH_DRIVER)" == "meili" ]]; then PROFILE_ARGS+=(--profile search); fi
if [[ "$(env_val STORAGE_DRIVER)" == "s3" ]]; then PROFILE_ARGS+=(--profile storage); fi
if [[ "$(env_val SCAN_ENABLED)" == "true" ]]; then PROFILE_ARGS+=(--profile antivirus); fi
run docker compose config --quiet
run docker compose build backend caddy migrate seed
if [[ "$PROFILE" == 'full' ]]; then
  export ONLYOFFICE_UPSTREAM='onlyoffice:80' # caddy 反代上游（服务未起时主机名不解析）
  run docker compose "${PROFILE_ARGS[@]}" up -d
  unset ONLYOFFICE_UPSTREAM
else
  run docker compose "${PROFILE_ARGS[@]}" up -d
fi

echo ''
echo "部署完成（$PROFILE profile）。migrate/seed 已由 compose 按依赖顺序执行。"
echo '访问地址：http://<服务器地址>/（配置 APP_DOMAIN 后使用对应域名/HTTPS）'
echo '默认账号：.env 中 SEED_ADMIN_EMAIL / SEED_ADMIN_USERNAME 与 SEED_ADMIN_PASSWORD；首次登录后请立即修改密码。'
