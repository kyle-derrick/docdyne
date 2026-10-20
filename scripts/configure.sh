#!/usr/bin/env bash
# configure.sh —— 部署配置器（纯终端交互，无 TUI 依赖）：
#   1) 选场景模板（回车 = 单机生产）；
#   2) 选 HTTPS 模式（默认=自动签发并要求输入域名；可选自签 / 关闭）；
#   3) 展示全部配置项编号列表——输入编号改你要改的，r 重新生成密钥，
#      回车完成；未修改的密钥自动随机生成、值字段用默认值。
#
# 用法：
#   ./scripts/configure.sh                    # 交互式（需终端 stdin）
#   ./scripts/configure.sh --auto             # 无人值守：无域名来源按 HTTP
#   ./scripts/configure.sh --auto --domain docdyne.example.com   # 无人值守 HTTPS
#   ./scripts/configure.sh --stdin            # 强制交互（stdin 非 tty 时用，
#                                             #   测试/管道喂答案场景）
#   ./scripts/configure.sh --template deploy/env/.env.cluster.example
# HTTPS 模式（写入 CADDY_TLS_INIT_MODE + APP_DOMAIN；backend 出厂态播种，
# 管理页 TLS 切换始终优先）：
#   auto     域名 + ACME 自动签发（需公网 DNS 指向本机、80/443 可达）
#   internal 自签证书（域名/内网 IP 均可）
#   http     关闭 HTTPS（纯 HTTP）
# 其他语义：既有 .env 有效密钥绝不静默轮换；SMTP_PASS/域名类键不随机生成。
set -euo pipefail
cd "$(dirname "$0")/.."

AUTO=0
FORCE_STDIN=0
TEMPLATE=''
FORCE_DOMAIN=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --auto) AUTO=1 ;;
    --stdin) FORCE_STDIN=1 ;;
    --domain) FORCE_DOMAIN="${2:?--domain 需要域名}"; shift ;;
    --template) TEMPLATE="${2:?--template 需要路径}"; shift ;;
    *) echo "未知参数：$1（支持 --auto / --stdin / --domain <域名> / --template <path>）" >&2; exit 1 ;;
  esac
  shift
done

gen_password() { LC_ALL=C tr -dc 'A-HJ-NP-Za-km-z2-9' </dev/urandom | head -c 20 || true; }
gen_secret32() { openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'; }
gen_for() { if [[ "$1" == 'POSTGRES_PASSWORD' ]]; then gen_password; else gen_secret32; fi; }
ask() { read -r -p "$1" "$2" || true; } # EOF 安全读（管道断流按空值处理）

interactive() { [[ $FORCE_STDIN -eq 1 || -t 0 ]] && [[ $AUTO -eq 0 ]]; }

SCENARIOS=(
  'single-node|deploy/env/.env.single-node.example|单机生产（compose 单域名 + 自动 HTTPS）'
  'dev|.env.example|本地开发（make run/dev 直连本机 PostgreSQL）'
  'cluster|deploy/env/.env.cluster.example|多节点集群（外部 PG/Redis/存储 + 多服务实例）'
  'verify|deploy/env/.env.local-verify.example|本地验证栈（compose 全组件弱密钥，自测）'
)

# ---------- 选定基底 ----------
BASE=''
if [[ -f .env && -z "$TEMPLATE" ]]; then
  BASE='.env'
elif [[ -n "$TEMPLATE" ]]; then
  BASE="$TEMPLATE"
elif ! interactive; then
  BASE="$(printf '%s' "${SCENARIOS[0]}" | cut -d'|' -f2)"
else
  echo ''
  echo '选择场景模板：'
  i=1
  for s in "${SCENARIOS[@]}"; do
    key="${s%%|*}"; rest="${s#*|}"; desc="${rest#*|}"
    printf '  [%d] %-12s %s\n' "$i" "$key" "$desc"
    i=$((i + 1))
  done
  pick='1'; ask '输入编号（回车 = 1 单机生产）：' pick
  case "$pick" in
    2|3|4) BASE="$(printf '%s' "${SCENARIOS[pick - 1]}" | cut -d'|' -f2)" ;;
    *) BASE="$(printf '%s' "${SCENARIOS[0]}" | cut -d'|' -f2)" ;;
  esac
  echo "模板：$BASE"
fi
[[ -f "$BASE" ]] || { echo "模板不存在：$BASE" >&2; exit 1; }
TEXT="$(cat "$BASE")"

get_val() { grep -E "^$1=" <<<"$TEXT" | head -1 | cut -d= -f2- || true; }
set_kv() {
  if grep -qE "^$1=" <<<"$TEXT"; then TEXT="$(sed -E "s|^$1=.*$|$1=$2|" <<<"$TEXT")"
  else TEXT="$TEXT
$1=$2"; fi
}
is_placeholder() { [[ "$1" =~ (CHANGE_ME|change-this-password|replace-with-at-least-32-random-bytes) ]]; }
is_genless() { [[ "$1" =~ (DOMAIN|URL|HOST|ADDR|PORT|EMAIL|USERNAME|(^|_)USER$|NAME$|^SMTP_) ]]; }

# ---------- 字段 ----------
ALWAYS_SECRETS=(POSTGRES_PASSWORD JWT_SECRET SEED_ADMIN_PASSWORD ONLYOFFICE_JWT_SECRET)
VALUE_FIELDS=(CONTENT_DOMAIN PUBLIC_BASE_URL SEED_ADMIN_EMAIL SEED_ADMIN_USERNAME)
MANUAL_FIELDS=(SMTP_PASS)
F_STORAGE_DRIVER='' # local | s3（单机推荐 local：无外部依赖；s3 需 minio）

F_POSTGRES_PASSWORD=''; F_JWT_SECRET=''; F_SEED_ADMIN_PASSWORD=''; F_ONLYOFFICE_JWT_SECRET=''
F_CONTENT_DOMAIN=''; F_PUBLIC_BASE_URL=''
F_SEED_ADMIN_EMAIL='admin@docdyne.local'; F_SEED_ADMIN_USERNAME='admin'; F_SMTP_PASS=''
F_TLS_MODE=''; F_APP_DOMAIN=''

fresh=()
for k in "${ALWAYS_SECRETS[@]}"; do
  v="$(get_val "$k")"
  if [[ -z "$v" ]] || is_placeholder "$v"; then v="$(gen_for "$k")"; fresh+=("$k"); fi
  printf -v "F_$k" '%s' "$v"
done
for k in "${VALUE_FIELDS[@]}"; do
  v="$(get_val "$k")"
  if [[ -n "$v" ]]; then printf -v "F_$k" '%s' "$v"; fi
done
for k in "${MANUAL_FIELDS[@]}"; do
  v="$(get_val "$k")"
  is_placeholder "$v" && v=''
  printf -v "F_$k" '%s' "$v"
done

# ---------- HTTPS 模式（auto / internal / http）----------
tls_domain_ok() { # $1=mode $2=domain → 0 合法 / 1 非法（附提示到 stderr）
  local m="$1" d="$2"
  if [[ -z "$d" || "$d" == ":80" || "$d" == *example.com* ]]; then
    echo "域名不能为空/模板占位（收到：${d:-空}）" >&2; return 1
  fi
  if ! [[ "$d" =~ ^[A-Za-z0-9._-]+(:[0-9]{1,5})?$ ]]; then
    echo "域名格式须为 host[:port]，不含协议/路径（收到：$d）" >&2; return 1
  fi
  if [[ "$m" == "auto" ]]; then
    if [[ "$d" =~ ^[0-9.]+$ || "$d" == localhost || "$d" == *.local ]]; then
      echo "自动签发（ACME）无法为 IP / 内网名签发证书——请改选 [2] 自签证书" >&2; return 1
    fi
  fi
  return 0
}
tls_mode_label() {
  case "$1" in
    auto) echo "自动签发（ACME）· $2" ;;
    internal) echo "自签证书 · $2" ;;
    *) echo "关闭 HTTPS（HTTP）" ;;
  esac
}
init_mode="$(get_val CADDY_TLS_INIT_MODE)"
init_domain="$(get_val APP_DOMAIN)"
case "$init_mode" in auto|internal|http) F_TLS_MODE="$init_mode" ;; *) F_TLS_MODE='' ;; esac
if [[ -n "$FORCE_DOMAIN" ]]; then
  F_TLS_MODE='auto'; F_APP_DOMAIN="$FORCE_DOMAIN"
else
  if [[ -n "$init_domain" && "$init_domain" != ':80' && "$init_domain" != *example.com* ]]; then
    F_APP_DOMAIN="$init_domain"
    [[ -z "$F_TLS_MODE" ]] && F_TLS_MODE='auto'
  fi
  [[ -z "$F_TLS_MODE" ]] && F_TLS_MODE='http'
fi

choose_tls() { # 编号三选一（默认自动签发）→ 域名输入循环校验（b 返回重选模式）
  local m d
  while :; do
    echo ''
    echo '==== HTTPS 访问模式（必选）===='
    echo '  [1] 自动签发 —— 公网域名 + Let'"'"'s Encrypt 自动证书（需 DNS 指向本机）【回车默认】'
    echo '  [2] 自签证书 —— 域名/内网 IP 均可（浏览器首次访问需手动信任）'
    echo '  [3] 关闭 HTTPS —— 纯 HTTP（内网/IP 访问）'
    pick='1'; ask '选择 [1-3]：' pick
    case "$pick" in
      2) m='internal' ;; 3) m='http' ;; *) m='auto' ;;
    esac
    if [[ "$m" == "http" ]]; then F_APP_DOMAIN=''; F_TLS_MODE="$m"; return 0; fi
    while :; do
      hint="$([[ $m == auto ]] && echo '公网域名' || echo '域名或内网 IP')"
      d="${F_APP_DOMAIN}"; ask "站点域名（$hint，b = 返回重选模式，当前：${F_APP_DOMAIN:-空}）：" d
      [[ "$d" == 'b' ]] && break
      if tls_domain_ok "$m" "$d"; then F_APP_DOMAIN="$d"; F_TLS_MODE="$m"; return 0; fi
      echo '  ↳ 请重新输入（上一行是原因）'
    done
  done
}

# 存储驱动装载（.env 已有值时保持，否则默认 local——单机零依赖）
_sd="$(get_val STORAGE_DRIVER)"
case "$_sd" in s3) F_STORAGE_DRIVER='s3' ;; *) F_STORAGE_DRIVER='local' ;; esac

choose_storage() {
  echo ''
  echo '==== 存储模式 ===='
  echo '  [1] 本地磁盘 —— 文件存 backend 数据卷，零外部依赖【回车默认·单机推荐】'
  echo '  [2] S3/MinIO —— 对象存储（独立 minio 容器，从源码构建，无外部镜像依赖）'
  pick='1'; ask '选择 [1-2]：' pick
  case "$pick" in
    2) F_STORAGE_DRIVER='s3' ;;
    *) F_STORAGE_DRIVER='local' ;;
  esac
}

# 交互首问 HTTPS（.env 已带有效 auto/internal 配置时跳过，不打扰复用）
if interactive; then
  if [[ "$F_TLS_MODE" == "http" || -z "$F_APP_DOMAIN" ]] || ! tls_domain_ok "$F_TLS_MODE" "$F_APP_DOMAIN" 2>/dev/null; then
    choose_tls
  fi
fi
# --auto：无有效域名来源（--domain / 既有 .env）时按 HTTP
if [[ $AUTO -eq 1 && "$F_TLS_MODE" != "http" ]] && ! tls_domain_ok "$F_TLS_MODE" "$F_APP_DOMAIN" 2>/dev/null; then
  F_TLS_MODE='http'; F_APP_DOMAIN=''
fi
# --auto 全新部署（无既有 .env）默认 local——单机推荐零依赖。
# 选了 s3 的既有 .env 不动（用户有意为之）。
if [[ $AUTO -eq 1 && "$BASE" != ".env" && "$F_STORAGE_DRIVER" == "s3" ]]; then
  F_STORAGE_DRIVER='local'
fi

preview() {
  case "$1" in
    secret) if [[ -z "$2" ]]; then echo '待生成'; else echo "已设置 · ****（${#2} 位）"; fi ;;
    *) if [[ "$2" == *example.com* ]]; then echo "$2 ← 模板占位，建议修改"
       elif [[ -z "$2" ]]; then echo '(空)'
       else echo "$2"; fi ;;
  esac
}
fval() { eval "printf '%s' \"\${F_$1-}\""; }

regen_all() {
  fresh=()
  for k in "${ALWAYS_SECRETS[@]}"; do
    v="$(gen_for "$k")"; printf -v "F_$k" '%s' "$v"; fresh+=("$k")
  done
}

edit_field() { # $1=key（secret 类输入不回显：read -s，屏幕无明文）
  local k="$1" kind=secret cur nv
  for f in "${VALUE_FIELDS[@]}"; do [[ "$f" == "$k" ]] && kind=value; done
  for f in "${MANUAL_FIELDS[@]}"; do [[ "$f" == "$k" ]] && kind=manual; done
  cur="$(fval "$k")"
  printf '  %s 当前：%s\n' "$k" "$(preview "$kind" "$cur")"
  if [[ "$kind" == "secret" ]]; then
    nv=''
    read -rs -p '  新值（输入不回显；回车 = 重新随机生成）：' nv || true
    printf '\n'
    if [[ -z "$nv" ]]; then
      nv="$(gen_for "$k")"; fresh+=("$k")
      printf '  ↳ 已重新随机生成\n'
    fi
  else
    nv="$cur"; ask '  新值（回车 = 保持）：' nv
    [[ -z "$nv" ]] && return 0
  fi
  printf -v "F_$k" '%s' "$nv"
}

tls_invalid_msg=''
# 管理员三项校验（cmd/seed 同款规则，internal/auth/validate.go）——
# 不合规会在部署期 seed 容器退出 1 拦住 backend/caddy，前置到配置器拦截。
pw_policy_ok() {
  local p="$1"
  [[ ${#p} -ge 12 ]] && [[ "$p" =~ [A-Z] ]] && [[ "$p" =~ [a-z] ]] && [[ "$p" =~ [0-9] ]]
}
username_ok() { # 3-32 字符，仅字母/数字/_/-
  local u="$1"
  [[ ${#u} -ge 3 && ${#u} -le 32 ]] && [[ "$u" =~ ^[a-zA-Z0-9_-]+$ ]]
}
email_ok() { # 含且仅含一个 @，不在首尾
  local e="$1"
  [[ "$e" == *@* && "$e" != @* && "$e" != *@ && "$(grep -o '@' <<<"$e" | wc -l)" == 1 ]]
}
seed_fields_valid() { # 管理员三项全检 → 0 合规 / 1 不合规（msg 写入 seed_invalid_msg）
  seed_invalid_msg=''
  local em un pw
  em="$(fval SEED_ADMIN_EMAIL)"; un="$(fval SEED_ADMIN_USERNAME)"; pw="$(fval SEED_ADMIN_PASSWORD)"
  if ! email_ok "$em"; then seed_invalid_msg="SEED_ADMIN_EMAIL 格式无效（须含且仅含一个 @，不在首尾）：$em"; return 1; fi
  if ! username_ok "$un"; then seed_invalid_msg="SEED_ADMIN_USERNAME 须 3-32 字符且仅含字母/数字/_/-（不支持点号等）：$un"; return 1; fi
  if ! pw_policy_ok "$pw"; then seed_invalid_msg="SEED_ADMIN_PASSWORD 须 ≥12 位且含大写、小写与数字"; return 1; fi
  return 0
}
ensure_admin_pw() { # 管理员三项全检：交互时回车=自动修复保存，b=回菜单手动改
  while ! seed_fields_valid; do
    echo "  ↳ 以下配置不合规，无法保存：$seed_invalid_msg"
    if interactive; then
      local resp=''
      read -r -p '  回车 = 自动修复并保存 / b = 返回菜单手动修改：' resp || true
      if [[ "$resp" == "b" ]]; then return 1; fi  # 返回菜单，用户自己改
      # 自动修复
      if ! email_ok "$(fval SEED_ADMIN_EMAIL)"; then
        printf -v F_SEED_ADMIN_EMAIL '%s' 'admin@docdyne.local'
        echo "  ↳ 邮箱已重置为 admin@docdyne.local"
      fi
      if ! username_ok "$(fval SEED_ADMIN_USERNAME)"; then
        printf -v F_SEED_ADMIN_USERNAME '%s' 'admin'
        echo "  ↳ 用户名已重置为 admin"
      fi
      if ! pw_policy_ok "$(fval SEED_ADMIN_PASSWORD)"; then
        printf -v F_SEED_ADMIN_PASSWORD '%s' "$(gen_for SEED_ADMIN_PASSWORD)"; fresh+=(SEED_ADMIN_PASSWORD)
        echo "  ↳ 密码已随机重新生成（保存后见输出）"
      fi
    else
      # 非交互（--auto/--stdin）：全部自动修复
      if ! email_ok "$(fval SEED_ADMIN_EMAIL)"; then
        printf -v F_SEED_ADMIN_EMAIL '%s' 'admin@docdyne.local'
        echo "  ↳ 邮箱已重置为 admin@docdyne.local"
      fi
      if ! username_ok "$(fval SEED_ADMIN_USERNAME)"; then
        printf -v F_SEED_ADMIN_USERNAME '%s' 'admin'
        echo "  ↳ 用户名已重置为 admin"
      fi
      if ! pw_policy_ok "$(fval SEED_ADMIN_PASSWORD)"; then
        printf -v F_SEED_ADMIN_PASSWORD '%s' "$(gen_for SEED_ADMIN_PASSWORD)"; fresh+=(SEED_ADMIN_PASSWORD)
        echo "  ↳ 密码已随机重新生成"
      fi
    fi
  done
  return 0
}
tls_valid() {
  tls_invalid_msg=''
  local m d; m="$(fval TLS_MODE)"; d="$(fval APP_DOMAIN)"
  if [[ "$m" == "http" ]]; then return 0; fi
  if ! tls_domain_ok "$m" "$d" 2>/dev/null; then
    tls_invalid_msg="HTTPS 模式为 $([[ $m == auto ]] && echo 自动签发 || echo 自签) 但域名无效：$d——请进入 [1] HTTPS 模式补全"
    return 1
  fi
  return 0
}

# ---------- 交互主循环（编号选改；按语义分组 + 序号定宽）----------
if interactive; then
  while :; do
    echo ''
    echo "==== 配置项（基底：$BASE）===="
    keys=(); i=1
    __row() { # $1=字段id $2=显示名 $3=状态列
      printf '  [%2d] %-22s %s\n' "$i" "$2" "$3"
      keys+=("$1"); i=$((i + 1))
    }
    echo '  ── 站点与访问 ──────────────────'
    __row TLS "HTTPS 模式" "$(tls_mode_label "$(fval TLS_MODE)" "$(fval APP_DOMAIN)")"
    __row CONTENT_DOMAIN "CONTENT_DOMAIN" "$(preview value "$(fval CONTENT_DOMAIN)")"
    __row PUBLIC_BASE_URL "PUBLIC_BASE_URL" "$(preview value "$(fval PUBLIC_BASE_URL)")"
    __row STORAGE "存储模式" "$(fval STORAGE_DRIVER)"
    echo '  ── 管理员账号（首次登录）───────'
    __row SEED_ADMIN_EMAIL "SEED_ADMIN_EMAIL" "$(preview value "$(fval SEED_ADMIN_EMAIL)")"
    __row SEED_ADMIN_USERNAME "SEED_ADMIN_USERNAME" "$(preview value "$(fval SEED_ADMIN_USERNAME)")"
    __row SEED_ADMIN_PASSWORD "SEED_ADMIN_PASSWORD" "$(preview secret "$(fval SEED_ADMIN_PASSWORD)")"
    echo '  ── 服务密钥（已自动生成）───────'
    __row POSTGRES_PASSWORD "POSTGRES_PASSWORD" "$(preview secret "$(fval POSTGRES_PASSWORD)")"
    __row JWT_SECRET "JWT_SECRET" "$(preview secret "$(fval JWT_SECRET)")"
    __row ONLYOFFICE_JWT_SECRET "ONLYOFFICE_JWT_SECRET" "$(preview secret "$(fval ONLYOFFICE_JWT_SECRET)")"
    echo '  ── 邮件（可选，用到再填）───────'
    __row SMTP_PASS "SMTP_PASS（授权码）" "$(preview value "$(fval SMTP_PASS)")（需真实值，不自动生成）"
    echo ''
    echo '  [r] 重新生成全部随机密钥      [回车] 完成保存'
    act=''; ask '选择编号修改：' act
    [[ -z "$act" ]] && {
      tls_valid || { echo "  ↳ $tls_invalid_msg"; continue; }
      ensure_admin_pw || continue  # 用户选 b 返回菜单 / 自动修复后仍未过
      break
    }
    if [[ "$act" == "r" ]]; then regen_all; continue; fi
    if [[ "$act" =~ ^[0-9]+$ ]] && [[ "$act" -ge 1 && "$act" -le "${#keys[@]}" ]]; then
      k="${keys[act - 1]}"
      if [[ "$k" == "TLS" ]]; then choose_tls
      elif [[ "$k" == "STORAGE" ]]; then choose_storage
      else edit_field "$k"; fi
    else
      echo '输入无效（编号 / r / 回车）'
    fi
  done
fi

# ---------- 落盘（管理员密码策略兜底：覆盖 --auto 与既有 .env 弱密码） ----------
ensure_admin_pw
# MEILI_API_KEY 与 MEILI_MASTER_KEY 必须同值（一个是后端发的，一个是
# MeiliSearch 校验的）；自动生成残留占位时联动写同一个随机值。
if grep -qE '^MEILI_API_KEY=.*CHANGE_ME' <<<"$TEXT" || grep -qE '^MEILI_MASTER_KEY=.*CHANGE_ME' <<<"$TEXT"; then
  _mk="$(gen_password)"
  set_kv MEILI_MASTER_KEY "$_mk"
  set_kv MEILI_API_KEY "$_mk"
fi
set_kv CADDY_TLS_INIT_MODE "$(fval TLS_MODE)"
# 存储模式：local=零依赖；s3=从源码构建 minio（deploy/minio/Dockerfile）
set_kv STORAGE_DRIVER "$(fval STORAGE_DRIVER)"
set_kv APP_DOMAIN "$(fval APP_DOMAIN)"
set_kv POSTGRES_PASSWORD "$(fval POSTGRES_PASSWORD)"
set_kv DATABASE_URL "postgres://docdyne:$(fval POSTGRES_PASSWORD)@postgres:5432/docdyne?sslmode=disable"
set_kv JWT_SECRET "$(fval JWT_SECRET)"
set_kv SEED_ADMIN_EMAIL "$(fval SEED_ADMIN_EMAIL)"
set_kv SEED_ADMIN_USERNAME "$(fval SEED_ADMIN_USERNAME)"
set_kv SEED_ADMIN_PASSWORD "$(fval SEED_ADMIN_PASSWORD)"
set_kv ONLYOFFICE_JWT_SECRET "$(fval ONLYOFFICE_JWT_SECRET)"
for k in "${VALUE_FIELDS[@]}" "${MANUAL_FIELDS[@]}"; do set_kv "$k" "$(fval "$k")"; done

made=("${fresh[@]}")
warn_manual=(); warn_domain=()
while IFS= read -r k; do
  [[ -z "$k" || "$k" == "APP_DOMAIN" ]] && continue
  if is_genless "$k"; then warn_manual+=("$k")
  else set_kv "$k" "$(gen_password)"; made+=("$k"); fi
done < <(grep -E '^[A-Z0-9_]+=.*(CHANGE_ME|change-this-password|replace-with-at-least-32-random-bytes)' <<<"$TEXT" | cut -d= -f1 | sort -u)
while IFS= read -r k; do
  [[ -n "$k" && "$k" != "APP_DOMAIN" ]] && warn_domain+=("$k")
done < <(grep -E '^[A-Z0-9_]*(DOMAIN|BASE_URL)[A-Z0-9_]*=.*example\.com' <<<"$TEXT" | cut -d= -f1 | sort -u)

printf '%s' "$TEXT" > .env

echo ''
echo "==== .env 已保存（$PWD/.env，已 gitignore，请妥善备份）===="
echo "HTTPS 模式：$(tls_mode_label "$(fval TLS_MODE)" "$(fval APP_DOMAIN)")"
[[ ${#made[@]} -gt 0 ]] && echo "本次生成/写入密钥：${made[*]}"
if printf ' %s ' "${fresh[*]}" | grep -q ' SEED_ADMIN_PASSWORD '; then
  echo ''
  echo '初始管理员（请立即记录，首次登录后建议改密）：'
  echo "  邮箱/用户名：$(fval SEED_ADMIN_EMAIL) / $(fval SEED_ADMIN_USERNAME)"
  echo "  密码：$(fval SEED_ADMIN_PASSWORD)"
fi
case "$(fval TLS_MODE)" in
  internal) echo ''; echo '提示：自签证书首次访问时浏览器会告警，需手动信任一次（Caddy 内置 CA）。' ;;
  auto) echo ''; echo "提示：自动签发要求 $(fval APP_DOMAIN) 的公网 DNS 已指向本机且 80/443 可达。" ;;
esac
if [[ ${#warn_manual[@]} -gt 0 ]]; then
  echo ''
  echo '提示：以下键自动生成无意义、保留原值（不影响核心部署，用到时再填）：'
  printf '  %s\n' "${warn_manual[@]}"
fi
if [[ ${#warn_domain[@]} -gt 0 ]]; then
  echo ''
  echo '提示：以下域名/地址仍为模板占位（example.com），建议按需修改：'
  printf '  %s\n' "${warn_domain[@]}"
fi
exit 0
