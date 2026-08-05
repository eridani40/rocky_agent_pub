#!/usr/bin/env bash
# tests/e2e/snapshot-with-keys.sh — 增强 playwright-cli snapshot：注入 data-action-key
#
# 用途：解决「data-action-key 住 DOM 但 playwright snapshot=a11y tree 丢 data-*」断链。
# snapshot 后逐 ref eval 读 dataset.actionKey，有值则在 [ref=e${ref_id}] 后注入
# [action-key=X]，输出增强 snapshot。executor 主信息源（snapshot.yml）从此能直接看到
# action-key，定位优先 action-key、降级文案 name，摆脱脆弱文案依赖。
#
# 机制：playwright-cli session 复用（spike 实测确认）
#   - playwright-cli session 是 per-cwd（metadata 存 <cwd>/.playwright-cli/）
#   - 本脚本作为 executor 调起的子进程，自然继承 executor 的 cwd → 复用同一 session
#   - executor 若用命名 session（-s=<name>），通过 --session=<name> 透传给本脚本
#   - 不在同一 cwd / 不传 session → snapshot 会报 "browser not open"
#
# 参考:
#   - .claude/skills/playwright-cli/references/element-attributes.md（eval <ref> 读属性）
#   - specs/tech/version_logs/v0.0.218/change_plan.md（method 级契约）
#
# 用法:
#   bash tests/e2e/snapshot-with-keys.sh [--session=<name>] [--out=<path>] [--depth=<n>] [--timeout-eval=<secs>]
#   默认 --out=- 输出 stdout；--session 为空则用 default session（不传 -s）。

set -uo pipefail

# ── 参数解析 ──────────────────────────────────────────────────────────────────
SESSION=""
OUT="-"
DEPTH_ARG=""
EVAL_TIMEOUT=10

while [ $# -gt 0 ]; do
  case "$1" in
    --session=*)        SESSION="${1#--session=}"; shift;;
    --out=*)            OUT="${1#--out=}"; shift;;
    --depth=*)          DEPTH_ARG="--depth=${1#--depth=}"; shift;;
    --timeout-eval=*)   EVAL_TIMEOUT="${1#--timeout-eval=}"; shift;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \?//'
      exit 0;;
    *) echo "[snapshot-with-keys] 未知参数: $1" >&2; exit 2;;
  esac
done

# ── 构造 playwright-cli 调用前缀（带可选 session）──────────────────────────────
PW=(playwright-cli)
[ -n "$SESSION" ] && PW+=( -s="$SESSION" )

# ── timeout 实现（macOS 无 GNU timeout / gtimeout 时回退自实现）──────────────────
# 优先用系统 GNU coreutils（gtimeout / timeout），无则后台 + 轮询 + 超时强杀。
_timeout_cmd=""
if command -v gtimeout >/dev/null 2>&1; then _timeout_cmd="gtimeout";
elif command -v timeout  >/dev/null 2>&1; then _timeout_cmd="timeout"; fi

# _run_with_timeout <secs> <cmd...>：返回 cmd 的退出码；超时返回 124
_run_with_timeout() {
  local secs="$1"; shift
  if [ -n "$_timeout_cmd" ]; then
    "$_timeout_cmd" "$secs" "$@"
    return $?
  fi
  # bash 回退实现：后台跑 + 0.1s 步长轮询 + 超时强杀
  "$@" &
  local pid=$!
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    i=$((i+1))
    if [ "$i" -gt $((secs*10)) ]; then
      kill -9 "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 0.1
  done
  wait "$pid"
}

# ── 1) snapshot 存盘到临时文件 ─────────────────────────────────────────────────
SNAP_FILE="$(mktemp -t snap-with-keys.XXXXXX).yaml"
trap 'rm -f "$SNAP_FILE"' EXIT

if ! "${PW[@]}" snapshot --filename="$SNAP_FILE" $DEPTH_ARG > /dev/null 2>&1; then
  echo "[snapshot-with-keys] ERROR: snapshot 失败" >&2
  echo "  排查: session 未 open? cwd 与 open 时不一致? 传 --session=<name> 了吗?" >&2
  exit 1
fi

# ── 2) 交互节点过滤（只对可能挂 action-key 的节点 eval，性能优化）──────────────
# action-key 规范（_conventions.md §12）针对交互元素；纯文本 generic 节点跳过。
# 列表覆盖常见 ARIA 交互 role；发现遗漏可扩展。
INTERACTIVE_RE='^[[:space:]]*- (button|link|menuitem|menuitemcheckbox|menuitemradio|tab|option|checkbox|radio|switch|textbox|searchbox|combobox|slider|spinbutton|treeitem)([[:space:]"]|\[)'

# ── 3) 逐行处理：提 ref → eval data-action-key → 注入 [action-key=X] ──────────
# eval 读 dataset.actionKey（DOM dataset API 自动驼峰 data-action-key → actionKey）。
# playwright-cli --raw eval 的输出形态：
#   - 正常有值:  "framework.nav.open-playground"  （单行、JSON 字符串字面量）
#   - 无值（|| '' 兜底）: ""
#   - ref 不存在等错误: 把 "### Error\n..." 写到 stdout 且 exit=0 （不能靠退出码判！）
# 所以必须严格校验输出形态：单行 + ^"..."+ 符合 action-key 命名规范，否则透传原行。
enhance_line() {
  local line="$1"
  # 非交互节点直接透传（不 eval 省时）
  if ! echo "$line" | grep -qE "$INTERACTIVE_RE"; then
    echo "$line"; return
  fi
  # 提取 ref 号（snapshot 格式 [ref=e<N>]；每行至多一个）
  local ref_id
  ref_id=$(echo "$line" | grep -oE '\[ref=e[0-9]+\]' | head -1 | grep -oE '[0-9]+')
  if [ -z "$ref_id" ]; then
    echo "$line"; return
  fi
  # eval 读 data-action-key；超时强杀（_run_with_timeout 内部处理）
  local raw
  raw=$(_run_with_timeout "$EVAL_TIMEOUT" "${PW[@]}" --raw eval "el => el.dataset.actionKey || ''" "e$ref_id" 2>/dev/null)
  # 校验 1：单行（拒绝多行 error 文本；直接测含 \n，wc -l 数换行符对无尾换行的单行误判）
  case "$raw" in
    *$'\n'*) echo "$line"; return;;
  esac
  # 校验 2：JSON 字符串字面量 ^"..."（拒绝 error 文本 / undefined / null）
  if ! printf '%s' "$raw" | grep -qE '^".*"$'; then
    echo "$line"; return
  fi
  # 去外层引号
  local key
  key=$(printf '%s' "$raw" | sed -e 's/^"//' -e 's/"$//')
  # 校验 3：符合 action-key 命名规范 [a-z0-9.-]+（_conventions.md §12，防异常值污染）
  if [ -z "$key" ] || ! printf '%s' "$key" | grep -qE '^[a-z0-9][a-z0-9.-]*$'; then
    echo "$line"; return
  fi
  # 在 [ref=e<N>] 后注入 [action-key=X]（BSD sed BRE：用 | 分隔，action-key 不含 | &）
  echo "$line" | sed "s|\[ref=e${ref_id}\]|[ref=e${ref_id}] [action-key=${key}]|"
}

# ── 4) 输出 ────────────────────────────────────────────────────────────────────
if [ "$OUT" = "-" ]; then
  while IFS= read -r line || [ -n "$line" ]; do enhance_line "$line"; done < "$SNAP_FILE"
else
  : > "$OUT"
  # 重定向提到循环外（一次性打开 fd，避免逐行 open/close）
  while IFS= read -r line || [ -n "$line" ]; do enhance_line "$line"; done < "$SNAP_FILE" >> "$OUT"
  echo "[snapshot-with-keys] 增强 snapshot 已写入 $OUT" >&2
fi
