#!/usr/bin/env bash
# tests/e2e/run.sh — ET 编排入口
#
# 职责：**只管 env 生命周期 + case 调度**，不跑 playwright。
# 顺序遍历 tests/e2e/playground-*/case.md（或命令行 case_id 列表），
# 每 case：env.sh start → 提示 orchestrator 委派 executor 跑 case.md → env.sh stop。
# 参考: reqs/[working] v0.0.188.et-playwright-agent/req.md（case 顺序跑 + agent 玩 app 范式）
#       change_plan §2.1 run.sh 行（MUST NOT 直接跑 playwright）
#
# 用法:
#   tests/e2e/run.sh                       # 顺序跑所有 playground-*/case.md
#   tests/e2e/run.sh playground-send-message playground-tool-call   # 跑指定 case
#   tests/e2e/run.sh list                  # 列出所有可用 case_id
#   tests/e2e/run.sh --mode=electron ...   # 切 electron 模式（默认 headless）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_SH="$SCRIPT_DIR/env.sh"
DEFAULT_MODE="headless"
MODE="$DEFAULT_MODE"

# ── 列出所有 case_id（扫 playground-*/case.md 目录名）───────────────────────────
list_cases() {
  local d
  for d in "$SCRIPT_DIR"/playground-*/; do
    [ -d "$d" ] || continue
    [ -f "$d/case.md" ] || continue
    basename "$d"
  done
}

# ── 单 case 生命周期：start → 提示 → stop ────────────────────────────────────
# 不直接跑 playwright（executor agent 才是玩家，本脚本只调度 env）
run_one_case() {
  local cid="$1" mode="$2"
  local case_file="$SCRIPT_DIR/$cid/case.md"
  if [ ! -f "$case_file" ]; then
    echo "[run.sh] ERROR: case 文件不存在: $case_file" >&2
    return 1
  fi

  echo "========================================================"
  echo "[run.sh] case=$cid mode=$mode"
  echo "[run.sh] env starting..."
  bash "$ENV_SH" start "$cid" --mode="$mode"

  # 提示 orchestrator 委派 executor（executor 读 case.md + app-guide 玩 app）
  # 打印 case.md 头几行让 orchestrator 一眼看清意图
  echo "--------------------------------------------------------"
  echo "[run.sh] case.md 预览（${cid}）:"
  head -10 "$case_file" | sed 's/^/    /'
  echo "--------------------------------------------------------"
  echo "[run.sh] 请委派 e2e-test-executor 跑 case（env 已起）"
  echo "[run.sh] executor 流程: 读 case.md → 照 app-guide 用 playwright-cli 操作 → 每步留证 → 自由心证 blocking/small"
  echo "[run.sh] env stopping..."
  bash "$ENV_SH" stop "$cid"
  echo "[run.sh] case=$cid 完成"
  echo "========================================================"
}

# ── 解析参数 ─────────────────────────────────────────────────────────────────
[ -x "$ENV_SH" ] || { echo "[run.sh] ERROR: $ENV_SH 不存在或不可执行" >&2; exit 2; }

ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --mode=*) MODE="${1#--mode=}"; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# //; s/^#//'; exit 0 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

case "$MODE" in
  headless|electron) ;;
  *) echo "[run.sh] ERROR: --mode 仅支持 headless|electron（got: ${MODE}）" >&2; exit 2 ;;
esac

# ── list 子命令 / 默认全跑 / 指定 case_id 列表 ─────────────────────────────────
if [ "${ARGS[0]:-}" = "list" ]; then
  list_cases
  exit 0
fi

# 决定要跑的 case 列表
CASES=()
if [ ${#ARGS[@]} -gt 0 ]; then
  # 命令行指定 case_id
  for cid in "${ARGS[@]}"; do
    CASES+=("$cid")
  done
else
  # 默认全扫 playground-*/case.md
  while IFS= read -r line; do
    [ -n "$line" ] && CASES+=("$line")
  done < <(list_cases)
fi

if [ ${#CASES[@]} -eq 0 ]; then
  echo "[run.sh] WARN: 没有可跑的 case（tests/e2e/playground-*/case.md 不存在）"
  echo "[run.sh] 提示: case.md 由 T2 创建（playground-send-message / playground-tool-call 等）"
  exit 0
fi

echo "[run.sh] 待跑 case（${#CASES[@]} 个，顺序执行，mode=${MODE}）:"
printf '  - %s\n' "${CASES[@]}"

# ── 顺序遍历（req 决策：case 顺序跑，不并行）─────────────────────────────────
FAIL=0
FAILED_CASES=()
for cid in "${CASES[@]}"; do
  if ! run_one_case "$cid" "$MODE"; then
    FAIL=$((FAIL+1))
    FAILED_CASES+=("$cid")
    echo "[run.sh] WARN: case=$cid env 启停失败，继续下一个（顺序不阻断）"
  fi
done

echo "[run.sh] DONE: total=${#CASES[@]} fail_env=$FAIL"
[ $FAIL -eq 0 ] || {
  echo "[run.sh] env 启停失败的 case: ${FAILED_CASES[*]}" >&2
  exit 1
}
