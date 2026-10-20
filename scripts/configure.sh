#!/usr/bin/env bash
# configure.sh —— 部署配置器（单遍 TUI）：先选 HTTPS 模式（默认=域名自动
# 签发并要求输入域名；可选自签证书 / 关闭 HTTPS），再一次展示全部配置项，
# 选择修改、其余自动生成/默认；一次确认落盘。
#
# 形态：
#   - 有 whiptail（Debian/Ubuntu 服务器自带）：菜单 TUI——↑↓ 选择条目回车
#     编辑，「✅ 完成」「↻ 重新生成全部随机密钥」直达，Esc 取消；
#   - 无 whiptail / 无交互终端：编号列表循环（编号修改 / r 重生成 / 回车完成）。
#
# 用法：
#   ./scripts/configure.sh                    # 交互式（首屏选 HTTPS 模式）
#   ./scripts/configure.sh --auto             # 无人值守：无既有域名则按 HTTP 部署
#   ./scripts/configure.sh --auto --domain docdyne.example.com   # 无人值守 HTTPS
#   ./scripts/configure.sh --template deploy/env/.env.cluster.example
# HTTPS 模式（写入 CADDY_TLS_INIT_MODE + APP_DOMAIN；backend 出厂态播种，
# 管理页 TLS 切换始终优先）：
#   auto     域名 + ACME 自动签发（需公网 DNS 指向本机、80/443 可达）
#   internal 自签证书（Caddy 内置 CA，域名/内网 IP 均可）
#   http     关闭 HTTPS（纯 HTTP，IP/内网访问）
# 其他语义：既有 .env 有效密钥绝不静默轮换；SMTP_PASS/域名类键不随机生成。
set -euo pipefail
cd "$(dirname "$0")/.."

AUTO=0
NOTUI=0
TEMPLATE=''
FORCE_DOMAIN=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --auto) AUTO=1 ;;
    --no-tui) NOTUI=1 ;;
    --domain) FORCE_DOMAIN="${2:?--domain 需要域名}"; shift ;;
    --template) TEMPLATE="${2:?--template 需要路径}"; shift ;;
    *) echo "未知参数：$1（支持 --auto / --no-tui / --domain <域名> / --template <path>）" >&2; exit 1 ;;
  esac
  shift
done

# whiptail/newt 在 POSIX(C) locale 下无法渲染非 ASCII（中文全乱码）：
# 当前 locale 非 UTF-8 且系统有 C.UTF-8（glibc ≥2.35 恒有）时统一切换。
# 极端环境仍乱码或无 whiptail 时可用 --no-tui 退到编号列表模式。
if [[ "${LC_ALL:-${LANG:-C}}" != *UTF-8* && "${LC_ALL:-${LANG:-C}}" != *utf8* ]]; then
  if command -v locale >/dev/null 2>&1 && locale -a 2>/dev/null | grep -qiE '^C\.(UTF-8|utf8)$'; then
    export LC_ALL=C.UTF-8 LANG=C.UTF-8
  fi
fi

gen_password() { LC_ALL=C tr -dc 'A-HJ-NP-Za-km-z2-9' </dev/urandom | head -c 20 || true; }
gen_secret32() { openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'; }
gen_for() { if [[ "$1" == 'POSTGRES_PASSWORD' ]]; then gen_password; else gen_secret32; fi; }

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
elif [[ $AUTO -eq 1 ]]; then
  BASE="$(printf '%s' "${SCENARIOS[0]}" | cut -d'|' -f2)"
elif [[ $NOTUI -eq 0 ]] && command -v whiptail >/dev/null 2>&1 && [[ -t 0 && -t 2 ]]; then
  radiolist=()
  for i in "${!SCENARIOS[@]}"; do
    s="${SCENARIOS[i]}"; key="${s%%|*}"; rest="${s#*|}"; desc="${rest#*|}"
    radiolist+=("$((i + 1))" "$key —— $desc" "$([[ $i -eq 0 ]] && echo on || echo off)")
  done
  if pick=$(whiptail --title 'DocDyne 部署配置 · 选择场景模板' --radiolist \
    '↑↓ 移动，空格勾选，回车确认（Esc 取消退出）' 14 76 5 "${radiolist[@]}" 3>&1 1>&2 2>&3); then
    BASE="$(printf '%s' "${SCENARIOS[${pick:-1} - 1]}" | cut -d'|' -f2)"
  else
    echo '已取消（未做任何变更）。' >&2; exit 1
  fi
else
  BASE="$(printf '%s' "${SCENARIOS[0]}" | cut -d'|' -f2)"
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
      echo "自动签发（ACME）无法为 IP / 内网名签发证书——请改选「自签证书」（internal）" >&2; return 1
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
# 载入：显式 CADDY_TLS_INIT_MODE > APP_DOMAIN 推断（有效域名→auto，否则 http）
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

# HTTPS 首屏选择（whiptail 输入框循环 / 终端 read 循环；http 直接通过）
choose_tls() {
  local m d
  if [[ $NOTUI -eq 0 ]] && command -v whiptail >/dev/null 2>&1; then
    m=$(whiptail --title 'HTTPS 访问模式（必选）' --radiolist \
'选择站点对外访问方式（↑↓ 移动，空格勾选，回车确认）：
 自动签发：公网域名 + Let'"'"'s Encrypt 自动证书（需 DNS 指向本机）
 自签证书：域名/内网 IP 均可（浏览器需手动信任一次）
 关闭 HTTPS：纯 HTTP（内网/IP 访问）' 16 76 3 \
      "auto" "自动签发（域名 + ACME）——推荐" "on" \
      "internal" "自签证书（域名/内网 IP）" "off" \
      "http" "关闭 HTTPS（纯 HTTP）" "off" 3>&1 1>&2 2>&3) || { echo '已取消（未做任何变更）。' >&2; exit 1; }
    m="${m:-auto}"
    if [[ "$m" != "http" ]]; then
      while :; do
        if d=$(whiptail --title '站点域名' --inputbox \
"输入 $([[ $m == auto ]] && echo '公网域名（自动签发需要 DNS 已指向本机）' || echo '域名或内网 IP（自签证书）')：" \
          10 74 "${F_APP_DOMAIN}" 3>&1 1>&2 2>&3); then
          d="${d:-${F_APP_DOMAIN}}"
          if tls_domain_ok "$m" "$d"; then break; fi
          whiptail --title '域名无效' --msgbox "原因见下一步提示；请重新输入。" 8 60 3>&1 1>&2 2>&3 || true
        else
          echo '已取消（未做任何变更）。' >&2; exit 1
        fi
      done
      F_APP_DOMAIN="$d"
    else
      F_APP_DOMAIN=''
    fi
  else
    echo ''
    echo '==== HTTPS 访问模式（必选）===='
    echo '  [1] 自动签发（域名 + ACME，需公网 DNS）——回车默认'
    echo '  [2] 自签证书（域名/内网 IP 均可）'
    echo '  [3] 关闭 HTTPS（纯 HTTP）'
    read -r -p '选择 [1-3]：' pick || true
    case "${pick:-1}" in
      2) m='internal' ;; 3) m='http' ;; *) m='auto' ;;
    esac
    if [[ "$m" != "http" ]]; then
      while :; do
        read -r -p "站点域名$([[ $m == auto ]] && echo '（公网）' || echo '（域名或内网 IP）')：" d || true
        d="${d:-${F_APP_DOMAIN}}"
        if tls_domain_ok "$m" "$d"; then break; fi
        echo '  ↳ 请重新输入（上面一行是原因）'
      done
      F_APP_DOMAIN="$d"
    else
      F_APP_DOMAIN=''
    fi
  fi
  F_TLS_MODE="$m"
}

# 交互模式首屏即选 HTTPS（.env 已带有效 auto/internal 配置时跳过，不打扰复用）
if [[ $AUTO -eq 0 && -t 0 && -t 2 ]]; then
  if [[ "$F_TLS_MODE" == "http" || -z "$F_APP_DOMAIN" ]] || ! tls_domain_ok "$F_TLS_MODE" "$F_APP_DOMAIN" 2>/dev/null; then
    choose_tls
  fi
fi
# --auto：无有效域名来源（--domain / 既有 .env）时按 HTTP 部署并提示
if [[ $AUTO -eq 1 && "$F_TLS_MODE" != "http" ]] && ! tls_domain_ok "$F_TLS_MODE" "$F_APP_DOMAIN" 2>/dev/null; then
  F_TLS_MODE='http'; F_APP_DOMAIN=''
fi

preview() {
  case "$1" in
    secret) if [[ -z "$2" ]]; then echo '待生成'; else echo "已设置 · ${2:0:4}****（${#2} 位）"; fi ;;
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

build_menu() {
  printf 'DONE\t✅ 完成 —— 保存并继续部署\n'
  printf 'REGEN\t↻ 重新生成全部随机密钥\n'
  printf 'TLS\tHTTPS 模式   [%s]\n' "$(tls_mode_label "$(fval TLS_MODE)" "$(fval APP_DOMAIN)")"
  local k
  for k in "${ALWAYS_SECRETS[@]}"; do
    printf '%s\t%s   [%s]\n' "$k" "$k" "$(preview secret "$(fval "$k")")"
  done
  for k in "${VALUE_FIELDS[@]}"; do
    printf '%s\t%s   [%s]\n' "$k" "$k" "$(preview value "$(fval "$k")")"
  done
  for k in "${MANUAL_FIELDS[@]}"; do
    printf '%s\t%s（需真实值，不自动生成）   [%s]\n' "$k" "$k" "$(preview value "$(fval "$k")")"
  done
}

edit_field() { # $1=key
  local k="$1" kind=secret cur nv
  for f in "${VALUE_FIELDS[@]}"; do [[ "$f" == "$k" ]] && kind=value; done
  for f in "${MANUAL_FIELDS[@]}"; do [[ "$f" == "$k" ]] && kind=manual; done
  cur="$(fval "$k")"
  if [[ $NOTUI -eq 0 ]] && command -v whiptail >/dev/null 2>&1; then
    nv=$(whiptail --title "编辑 $k" --inputbox \
      "输入新值（留空 = $([[ $kind == secret ]] && echo 随机重新生成 || echo 保持当前值))" 10 74 "$cur" 3>&1 1>&2 2>&3) || return 0
  else
    printf '  %s 当前：%s\n' "$k" "$(preview "$kind" "$cur")"
    read -r -p '  新值（回车 = 保持）：' nv || true
  fi
  if [[ -z "$nv" && "$kind" == "secret" ]]; then nv="$(gen_for "$k")"; fresh+=("$k"); fi
  [[ -n "$nv" ]] && printf -v "F_$k" '%s' "$nv"
}

tls_invalid_msg=''
tls_valid() { # DONE 前校验
  tls_invalid_msg=''
  local m d; m="$(fval TLS_MODE)"; d="$(fval APP_DOMAIN)"
  if [[ "$m" == "http" ]]; then return 0; fi
  if ! tls_domain_ok "$m" "$d" 2>/dev/null; then
    tls_invalid_msg="HTTPS 模式为 $([[ $m == auto ]] && echo 自动签发 || echo 自签) 但域名无效：$d——请在「HTTPS 模式」条目中补全"
    return 1
  fi
  return 0
}

# ---------- 交互主循环 ----------
if [[ $AUTO -eq 0 && -t 0 && -t 2 ]]; then
  if [[ $NOTUI -eq 0 ]] && command -v whiptail >/dev/null 2>&1; then
    while :; do
      menu_args=()
      while IFS=$'\t' read -r id label; do menu_args+=("$id" "$label" ''); done < <(build_menu)
      pick=$(whiptail --title "DocDyne 部署配置（基底：$BASE）" --notags --menu \
        '选择条目回车编辑；✅ 完成保存。Esc 取消退出。' 24 88 15 "${menu_args[@]}" 3>&1 1>&2 2>&3) || \
        { echo '已取消（未做任何变更）。' >&2; exit 1; }
      case "$pick" in
        DONE)
          if tls_valid; then break; fi
          whiptail --title '无法完成' --msgbox "$tls_invalid_msg" 9 68 3>&1 1>&2 2>&3 || true
          ;;
        REGEN) regen_all ;;
        TLS) choose_tls ;;
        *) edit_field "$pick" ;;
      esac
    done
  else
    while :; do
      echo ''
      echo "==== 配置项（基底：$BASE）===="
      keys=(); i=0
      while IFS=$'\t' read -r id label; do
        [[ "$id" == "DONE" || "$id" == "REGEN" ]] && continue
        i=$((i + 1)); keys+=("$id")
        printf '  [%d] %s\n' "$i" "$label"
      done < <(build_menu)
      echo '  [r] 重新生成全部随机密钥   [回车] 完成保存'
      read -r -p '选择：' act || true
      [[ -z "$act" ]] && { tls_valid && break; echo "  ↳ $tls_invalid_msg"; continue; }
      if [[ "$act" == "r" ]]; then regen_all; continue; fi
      if [[ "$act" =~ ^[0-9]+$ ]] && [[ "$act" -ge 1 && "$act" -le "${#keys[@]}" ]]; then
        k="${keys[act - 1]}"
        if [[ "$k" == "TLS" ]]; then choose_tls; else edit_field "$k"; fi
      else
        echo '输入无效（编号 / r / 回车）'
      fi
    done
  fi
fi

# ---------- 落盘 ----------
set_kv CADDY_TLS_INIT_MODE "$(fval TLS_MODE)"
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
  [[ -z "$k" ]] && continue
  if [[ "$k" == "APP_DOMAIN" ]]; then continue; fi
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
if [[ "$(fval TLS_MODE)" == "internal" ]]; then
  echo ''
  echo '提示：自签证书首次访问时浏览器会告警，需手动信任一次（Caddy 内置 CA）。'
fi
if [[ "$(fval TLS_MODE)" == "auto" ]]; then
  echo ''
  echo "提示：自动签发要求 $(fval APP_DOMAIN) 的公网 DNS 已指向本机且 80/443 可达。"
fi
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
