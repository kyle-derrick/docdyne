#!/usr/bin/env bash
# configure.sh —— 部署配置器（单遍 TUI）：一次性展示全部配置项与当前/默认值，
# 用户选择修改，未修改的密钥自动随机生成、值字段用默认；一次确认落盘。
# 取代 gen-env.sh 的逐项问答流（gen-env.sh 保留用于 --auto 兼容）。
#
# 形态：
#   - 有 whiptail（Debian/Ubuntu 服务器自带）：菜单 TUI——↑↓ 选择条目回车编辑，
#     顶部「✅ 完成」「↻ 重新生成全部随机密钥」直达，Esc 取消；
#   - 无 whiptail / 无交互终端：编号列表循环（编号修改 / r 重生成 / 回车完成）。
#
# 用法：
#   ./scripts/configure.sh                 # 交互式（.env 已存在则现值为默认）
#   ./scripts/configure.sh --auto          # 全自动（随机密钥+默认值，无人值守）
#   ./scripts/configure.sh --template deploy/env/.env.cluster.example
# 语义要点：
#   - 既有 .env 的有效密钥绝不静默轮换（只补缺失/占位；↻/r 才主动重生成）；
#   - SMTP_PASS 与域名/URL/主机类键不随机生成（无意义），保留并在摘要提示；
#   - 场景模板默认 single-node（服务器部署主场景）。
set -euo pipefail
cd "$(dirname "$0")/.."

AUTO=0
TEMPLATE=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --auto) AUTO=1 ;;
    --template) TEMPLATE="${2:?--template 需要路径}"; shift ;;
    *) echo "未知参数：$1（支持 --auto / --template <path>）" >&2; exit 1 ;;
  esac
  shift
done

gen_password() { LC_ALL=C tr -dc 'A-HJ-NP-Za-km-z2-9' </dev/urandom | head -c 20 || true; }
gen_secret32() { openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'; }
gen_for() { if [[ "$1" == 'POSTGRES_PASSWORD' ]]; then gen_password; else gen_secret32; fi; }

SCENARIOS=(
  'single-node|deploy/env/.env.single-node.example|单机生产（compose 单域名 + 自动 HTTPS）'
  'dev|.env.example|本地开发（make run/dev 直连本机 PostgreSQL）'
  'cluster|deploy/env/.env.cluster.example|多节点集群（外部 PG/Redis/存储 + 多服务实例）'
  'verify|deploy/env/.env.local-verify.example|本地验证栈（compose 全组件弱密钥，自测）'
)

# ---------- 选定基底（既有 .env 优先 → 显式模板 → 交互选择，默认单机生产） ----------
BASE=''
if [[ -f .env && -z "$TEMPLATE" ]]; then
  BASE='.env'
elif [[ -n "$TEMPLATE" ]]; then
  BASE="$TEMPLATE"
elif [[ $AUTO -eq 1 ]]; then
  BASE="$(printf '%s' "${SCENARIOS[0]}" | cut -d'|' -f2)"
elif command -v whiptail >/dev/null 2>&1 && [[ -t 0 && -t 2 ]]; then
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
VALUE_FIELDS=(APP_DOMAIN CONTENT_DOMAIN PUBLIC_BASE_URL SEED_ADMIN_EMAIL SEED_ADMIN_USERNAME)
MANUAL_FIELDS=(SMTP_PASS)

F_POSTGRES_PASSWORD=''; F_JWT_SECRET=''; F_SEED_ADMIN_PASSWORD=''; F_ONLYOFFICE_JWT_SECRET=''
F_APP_DOMAIN=''; F_CONTENT_DOMAIN=''; F_PUBLIC_BASE_URL=''
F_SEED_ADMIN_EMAIL='admin@docdyne.local'; F_SEED_ADMIN_USERNAME='admin'; F_SMTP_PASS=''

fresh=()   # 本次新生成（含 ↻ 重生成）的密钥键
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

preview() { # $1=kind $2=value
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

build_menu() { # 输出 "id<TAB>显示行"（whiptail 与编号列表共用）
  printf 'DONE\t✅ 完成 —— 保存并继续部署\n'
  printf 'REGEN\t↻ 重新生成全部随机密钥\n'
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

edit_field() { # $1=key —— 读入新值（stdin 行；whiptail 场景由调用方先取好放入 $nv）
  local k="$1" kind=secret cur nv
  for f in "${VALUE_FIELDS[@]}"; do [[ "$f" == "$k" ]] && kind=value; done
  for f in "${MANUAL_FIELDS[@]}"; do [[ "$f" == "$k" ]] && kind=manual; done
  cur="$(fval "$k")"
  if command -v whiptail >/dev/null 2>&1; then
    nv=$(whiptail --title "编辑 $k" --inputbox \
      "输入新值（留空 = $([[ $kind == secret ]] && echo 随机重新生成 || echo 保持当前值))" 10 74 "$cur" 3>&1 1>&2 2>&3) || return 0
  else
    printf '  %s 当前：%s\n' "$k" "$(preview "$kind" "$cur")"
    read -r -p "  新值（回车 = 保持）：" nv || true
  fi
  if [[ -z "$nv" && "$kind" == "secret" ]]; then nv="$(gen_for "$k")"; fresh+=("$k"); fi
  [[ -n "$nv" ]] && printf -v "F_$k" '%s' "$nv"
}

# ---------- 交互主循环 ----------
if [[ $AUTO -eq 0 && -t 0 && -t 2 ]]; then
  if command -v whiptail >/dev/null 2>&1; then
    while :; do
      menu_args=()
      while IFS=$'\t' read -r id label; do menu_args+=("$id" "$label" ''); done < <(build_menu)
      pick=$(whiptail --title "DocDyne 部署配置（基底：$BASE）" --notags --menu \
        '选择条目回车编辑；✅ 完成保存。Esc 取消退出。' 24 86 14 "${menu_args[@]}" 3>&1 1>&2 2>&3) || \
        { echo '已取消（未做任何变更）。' >&2; exit 1; }
      case "$pick" in
        DONE) break ;;
        REGEN) regen_all ;;
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
      [[ -z "$act" ]] && break
      if [[ "$act" == "r" ]]; then regen_all; continue; fi
      if [[ "$act" =~ ^[0-9]+$ ]] && [[ "$act" -ge 1 && "$act" -le "${#keys[@]}" ]]; then
        edit_field "${keys[act - 1]}"
      else
        echo '输入无效（编号 / r / 回车）'
      fi
    done
  fi
fi

# ---------- 落盘 ----------
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
  if is_genless "$k"; then warn_manual+=("$k")
  else set_kv "$k" "$(gen_password)"; made+=("$k"); fi
done < <(grep -E '^[A-Z0-9_]+=.*(CHANGE_ME|change-this-password|replace-with-at-least-32-random-bytes)' <<<"$TEXT" | cut -d= -f1 | sort -u)
while IFS= read -r k; do
  [[ -n "$k" ]] && warn_domain+=("$k")
done < <(grep -E '^[A-Z0-9_]*(DOMAIN|BASE_URL)[A-Z0-9_]*=.*example\.com' <<<"$TEXT" | cut -d= -f1 | sort -u)

printf '%s' "$TEXT" > .env

echo ''
echo "==== .env 已保存（$PWD/.env，已 gitignore，请妥善备份）===="
[[ ${#made[@]} -gt 0 ]] && echo "本次生成/写入密钥：${made[*]}"
if printf ' %s ' "${fresh[*]}" | grep -q ' SEED_ADMIN_PASSWORD '; then
  echo ''
  echo '初始管理员（请立即记录，首次登录后建议改密）：'
  echo "  邮箱/用户名：$(fval SEED_ADMIN_EMAIL) / $(fval SEED_ADMIN_USERNAME)"
  echo "  密码：$(fval SEED_ADMIN_PASSWORD)"
fi
if [[ ${#warn_manual[@]} -gt 0 ]]; then
  echo ''
  echo '提示：以下键自动生成无意义、保留原值（不影响核心部署，用到时再填）：'
  printf '  %s\n' "${warn_manual[@]}"
fi
if [[ ${#warn_domain[@]} -gt 0 ]]; then
  echo ''
  echo '提示：以下域名/地址仍为模板占位（example.com），建议改为真实值：'
  printf '  %s\n' "${warn_domain[@]}"
fi
exit 0
