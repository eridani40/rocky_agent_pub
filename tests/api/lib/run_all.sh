#!/usr/bin/env bash
# tests/api/lib/run_all.sh — AT run_all：env → 逐 case 串行 run_case.py（真实调 API）→ 聚合
#
# ⚠️  AT 与 ET 不可并发（共享 tests/lib/port_alloc.sh .env_port + DATA_DIR）
#     同时只能跑一套（AT=tests/api 或 ET=tests/e2e），不得并行。
#
# v0.0.190 起：AT 改真实调 API（不录制不回放），无 MODE 参数。
#
# 参数（全部可选）：
#   CASES=a,b                   case_id 白名单（唯一白名单变量，无 AT_CASES 等）
#   MODULE=m                    限定模块
#   ROUND=N                     结果落 round-N/api-test/（per-round 隔离）
#   LIST_ONLY=1                 dry-run：只列 case，不起 env、不跑
#   SKIP_ENV=1                  env 外部管理
#   RUN_BUDGET_SECONDS=N        总 wall-clock 预算 hard-stop（默认 900）
#
# 输出：states/<latest>/verify/api-test/run_all_result.json + progress.jsonl
# 参考：design_storage_runall.md §3；change_plan v0.0.190 D 节 run_all.sh
set -u
export RUN_BUDGET_SECONDS="${RUN_BUDGET_SECONDS:-900}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$SCRIPT_DIR"
while [ "$ROOT_DIR" != "/" ]; do
  [ -f "$ROOT_DIR/package.json" ] && break
  ROOT_DIR="$(dirname "$ROOT_DIR")"
done
cd "$ROOT_DIR"

TESTS_API_DIR="$ROOT_DIR/tests/api"
TESTS_DIR="$ROOT_DIR/tests"
[ -f "$TESTS_DIR/test.env" ] || { echo "[run_all] ERROR: $TESTS_DIR/test.env missing"; exit 2; }

# ── 防呆：错误白名单变量名 fail-loud ─────────────────────────────────────────────
for _v in AT_CASES ET_CASES API_CASES E2E_CASES; do
  _val="$(eval echo "\${${_v}:-}")"
  if [ -n "$_val" ] && [ -z "${CASES:-}" ]; then
    echo "[run_all] ERROR: wrong var detected: ${_v}=${_val}"
    echo "[run_all]        only CASES= is supported (no AT_CASES / ET_CASES)"
    exit 2
  fi
done

# source schema + secrets
set -a; source "$TESTS_DIR/test.env"; set +a
SECRETS="$HOME/.rocky_agent/test.secrets.env"
[ -f "$SECRETS" ] && { set -a; source "$SECRETS"; set +a; }

WT="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || echo "$ROOT_DIR")")"
[ -z "${DATA_DIR:-}" ] && DATA_DIR="$HOME/.rocky_agent_test/$WT"
. "$TESTS_DIR/lib/port_alloc.sh"

MODE="${MODE:-}"  # 已废弃，忽略（v0.0.190 起恒 live 真实调 API）；保留变量兼容旧调用
CASES="${CASES:-}"
MODULE="${MODULE:-}"
ROUND="${ROUND:-}"
LIST_ONLY="${LIST_ONLY:-0}"

# SKIP_ENV=1：env 外部管理
if [ "${SKIP_ENV:-0}" = "1" ]; then
  if PV="$(_port_read 2>/dev/null)" && [ -n "$PV" ]; then
    API_PORT=$(echo "$PV" | sed -nE 's/.*api_port=([0-9]+).*/\1/p')
  else
    echo "[run_all] ERROR: SKIP_ENV=1 但 worktree '$WT' 未注册 env"
    exit 2
  fi
fi
export API_PORT DATA_DIR
export SERVER_PORT="${API_PORT:-3700}"
export BASE_URL="http://127.0.0.1:${API_PORT:-3700}"
export DATA_ROOT="$DATA_DIR"

# 推导版本目录
NUMVER="$(echo "$WT" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
if [ -n "$NUMVER" ]; then
  VERSION="$(ls -d "$ROOT_DIR/states/v${NUMVER}"* 2>/dev/null | head -1 | xargs basename 2>/dev/null || echo "v${NUMVER}")"
else
  # fallback：worktree 名不含版本号（如 tmp-regression-at-et 回归 worktree）→ 从 package.json
  # version 字段派生（版本号权威源）。外部显式传 VERSION= 优先。
  if [ -z "${VERSION:-}" ]; then
    PKG_VER="$(python3 -c "import json; print(json.load(open('$ROOT_DIR/package.json')).get('version',''))" 2>/dev/null || echo "")"
    [ -n "$PKG_VER" ] && VERSION="v$PKG_VER"
  fi
  VERSION="${VERSION:-unknown}"
fi
export VERSION

# 输出目录（api-test/）
if [ -n "$ROUND" ]; then
  OUT_DIR="$ROOT_DIR/states/$VERSION/verify/round-$ROUND/api-test"
else
  OUT_DIR="$ROOT_DIR/states/$VERSION/verify/api-test"
fi
mkdir -p "$OUT_DIR"

# ── LIST_ONLY dry-run ─────────────────────────────────────────────────────────
if [ "$LIST_ONLY" = "1" ]; then
  echo "[run_all] LIST_ONLY=1 — dry-run（AT，不起 env、不跑）"
  python3 "$SCRIPT_DIR/_run_all_list.py" "$TESTS_API_DIR" "$MODULE" "$CASES"
  echo "[run_all] dry-run 结束。确认范围后去掉 LIST_ONLY=1 再真跑。"
  exit 0
fi

# 发现 case（扫 case.yaml）
MAP="$(python3 "$SCRIPT_DIR/_run_all_list.py" "$TESTS_API_DIR" "$MODULE" "$CASES" --map)"

if [ -z "$MAP" ]; then
  echo "[run_all] no cases matched"
  [ "${SKIP_ENV:-0}" != "1" ] && bash "$ROOT_DIR/tests/api/env_shutdown.sh" >/dev/null 2>&1 || true
  # 复用唯一聚合权威（_run_all_exec 空 MAP 产出同 schema 的空结果），避免 schema 二次维护漂移
  python3 "$SCRIPT_DIR/_run_all_exec.py" "$OUT_DIR" "" "$SCRIPT_DIR/run_case.py"
  exit 0
fi

CASE_COUNT=$(echo "$MAP" | wc -l | tr -d ' ')
echo "[run_all] cases=$CASE_COUNT  worktree=$WT  (realcall)"
echo "[run_all] OUT_DIR=$OUT_DIR"

# env（除非外部管理）
if [ "${SKIP_ENV:-0}" != "1" ]; then
  curl -sf "${BASE_URL}${HEALTH_ENDPOINT:-/health}" >/dev/null 2>&1 && \
    bash "$ROOT_DIR/tests/api/env_shutdown.sh" >/dev/null 2>&1 || true
  bash "$ROOT_DIR/tests/api/env_start.sh" || { echo "[run_all] env_start failed"; exit 2; }
  PV="$(_port_read 2>/dev/null)"
  API_PORT=$(echo "$PV" | sed -nE 's/.*api_port=([0-9]+).*/\1/p')
  export API_PORT SERVER_PORT="$API_PORT" BASE_URL="http://127.0.0.1:$API_PORT"
fi

# 执行引擎（全串行 + 真实调 API + 5 分类聚合）
python3 "$SCRIPT_DIR/_run_all_exec.py" \
  "$OUT_DIR" "$MAP" "$SCRIPT_DIR/run_case.py"
RC=$?

# shutdown（除非外部管理）
[ "${SKIP_ENV:-0}" != "1" ] && bash "$ROOT_DIR/tests/api/env_shutdown.sh" >/dev/null 2>&1 || true

exit $RC
