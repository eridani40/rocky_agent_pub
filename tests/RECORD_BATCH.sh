#!/usr/bin/env bash
# RECORD_BATCH.sh — 分波串行录制驱动（§10 追加裁决 1：全量录制）。
#
# 按 module/lane 切批，串行录制（避 rate-limit），汇总落盘结果，失败 case 单列重试清单。
# 仅本版本全量录制用（录制是一次性工作，不进常规 CI）。
#
# 用法：
#   WAVE=0 bash tests/RECORD_BATCH.sh                         # 波次 0：代表 case 验证基建
#   WAVE=1 MODULES="chat,config,channel" bash tests/RECORD_BATCH.sh  # 波次 1：指定模块
#   WAVE=1 KIND=e2e bash tests/RECORD_BATCH.sh                # ET 录制
#   CASES=chat_basic_reply_tc1,chat_tool_tc1 bash tests/RECORD_BATCH.sh  # 指定 case 录制
#
# 环境变量：
#   WAVE=N         波次编号（0/1/2，仅影响日志标记，不影响运行逻辑）
#   KIND=api|e2e   录制 AT 还是 ET（默认 api）
#   MODULES=a,b,c  按模块过滤（逗号分隔；空=全库）
#   CASES=x,y,z    指定 case_id 白名单（覆盖 MODULES）
#   USE_FALLBACK=1 录制失败时切备选 provider/model 重试
#   SKIP_ENV=1     env 外部管理（不自动 start/shutdown）
#   DRY_RUN=1      只打印计划，不实际录制
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WAVE="${WAVE:-}"
KIND="${KIND:-api}"
MODULES="${MODULES:-}"
CASES="${CASES:-}"
USE_FALLBACK="${USE_FALLBACK:-0}"
SKIP_ENV="${SKIP_ENV:-0}"
DRY_RUN="${DRY_RUN:-0}"

echo "=== RECORD_BATCH wave=${WAVE:-all} kind=$KIND modules=${MODULES:-all} ==="
[ "$DRY_RUN" = "1" ] && echo "[RECORD_BATCH] DRY_RUN=1 — 只打印计划，不实际录制"

# 找到 run_all.sh 路径
if [ "$KIND" = "e2e" ]; then
  RUN_ALL="$SCRIPT_DIR/e2e/lib/run_all.sh"
else
  RUN_ALL="$SCRIPT_DIR/api/lib/run_all.sh"
fi
[ -f "$RUN_ALL" ] || { echo "[RECORD_BATCH] ERROR: run_all.sh not found: $RUN_ALL"; exit 2; }

# 发现待录制 case（需有 recordings/ 尚未存在，或 RECORD=1 全量重录）
discover_cases() {
  local base="$SCRIPT_DIR/$KIND"
  python3 - "$base" "$MODULES" "$CASES" <<'PY'
import json, os, sys, glob
base, modules_str, cases_str = sys.argv[1:4]
mod_flt = set(filter(None, modules_str.split(',')))
case_flt = set(filter(None, cases_str.split(',')))
results = []
for cp in sorted(glob.glob(os.path.join(base, '*', '*', 'checkpoint.json'))):
    try:
        d = json.load(open(cp))
    except Exception:
        continue
    cid = d.get('case_id', '')
    if not cid:
        continue
    cdir = os.path.dirname(cp)
    mod = os.path.basename(os.path.dirname(cdir))
    # llm:off → 不录制（off 白名单豁免）
    if d.get('llm', 'replay') == 'off':
        continue
    # llm:mock → 不录制（legacy mock 路径）
    if d.get('llm', 'replay') == 'mock':
        continue
    if mod_flt and mod not in mod_flt:
        continue
    if case_flt and cid not in case_flt:
        continue
    results.append(cid)
print(','.join(results))
PY
}

CASE_LIST="$(discover_cases)"
if [ -z "$CASE_LIST" ]; then
  echo "[RECORD_BATCH] no cases to record (all off/mock or filtered out)"
  exit 0
fi

echo "[RECORD_BATCH] cases to record: $(echo "$CASE_LIST" | tr ',' '\n' | wc -l | tr -d ' ')"
if [ "$DRY_RUN" = "1" ]; then
  echo "$CASE_LIST" | tr ',' '\n' | sed 's/^/  /'
  exit 0
fi

# 分批串行录制（每批 BATCH_SIZE 个 case，避一次性起太多真 LLM 请求）
BATCH_SIZE="${BATCH_SIZE:-8}"
FAILED_CASES=""
PASS_COUNT=0
FAIL_COUNT=0

# 把逗号分隔 case list 转数组
IFS=',' read -ra ALL_CASES <<< "$CASE_LIST"
TOTAL="${#ALL_CASES[@]}"
echo "[RECORD_BATCH] total $TOTAL cases，batch_size=$BATCH_SIZE"

batch_start=0
batch_num=0
while [ "$batch_start" -lt "$TOTAL" ]; do
  # 取本批 case_id
  batch_cases=()
  i=0
  while [ "$i" -lt "$BATCH_SIZE" ] && [ "$((batch_start + i))" -lt "$TOTAL" ]; do
    batch_cases+=("${ALL_CASES[$((batch_start + i))]}")
    i=$((i + 1))
  done
  batch_str="$(IFS=','; echo "${batch_cases[*]}")"
  batch_num=$((batch_num + 1))
  batch_start=$((batch_start + BATCH_SIZE))

  echo ""
  echo "=== 批次 $batch_num: ${#batch_cases[@]} cases ==="
  echo "    $batch_str"

  # 录制（RECORD=1 强制覆写）
  RECORD=1 CASES="$batch_str" SKIP_ENV="$SKIP_ENV" USE_FALLBACK="$USE_FALLBACK" \
    bash "$RUN_ALL" 2>&1
  RC=$?

  # 读本批结果（判 pass/fail）
  # 注意：run_all.sh 写结果到 states/<ver>/verify/ 目录；此处从 run_all 输出判断
  if [ "$RC" = "0" ]; then
    PASS_COUNT=$((PASS_COUNT + ${#batch_cases[@]}))
    echo "[RECORD_BATCH] 批次 $batch_num: all pass"
  else
    # 找本批 fail case
    for c in "${batch_cases[@]}"; do
      FAILED_CASES="${FAILED_CASES:+$FAILED_CASES,}$c"
    done
    FAIL_COUNT=$((FAIL_COUNT + ${#batch_cases[@]}))
    echo "[RECORD_BATCH] 批次 $batch_num: some failed"
  fi
done

echo ""
echo "=== RECORD_BATCH 汇总 wave=${WAVE:-all} ==="
echo "    total=$TOTAL  pass=$PASS_COUNT  fail=$FAIL_COUNT"
if [ -n "$FAILED_CASES" ]; then
  echo "    失败 case（需重录/调查）:"
  echo "$FAILED_CASES" | tr ',' '\n' | sed 's/^/    /'
  echo ""
  echo "  重录失败 case：CASES=$FAILED_CASES USE_FALLBACK=1 RECORD=1 bash $RUN_ALL"
fi
[ "$FAIL_COUNT" = "0" ] && exit 0 || exit 1
