#!/bin/bash
# langfuse-verification 最小样例：建 session → 发 query → 等 flush → 查 trace → 断言。
#
# 演示本 skill 的标准流程。真实用例（langfuse_session_content_tc1 等）结构相同，
# 只是断言更细（工具结果保真 / 多轮 generation）。
#
# 前置：test.env 含 LANGFUSE_*；test 数据目录含真 provider；ROCKY_TEST_MOCK_LLM=0。
# 退出码：0=通过或 SKIP（observability 可选）/ 1=失败
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$SCRIPT_DIR"
# 从 .rocky/skills/langfuse-verification/references/ 向上找 package.json
while [ "$ROOT_DIR" != "/" ]; do
  [ -f "$ROOT_DIR/package.json" ] && break
  ROOT_DIR="$(dirname "$ROOT_DIR")"
done
cd "$ROOT_DIR"

# ── 1. source test.env + 校验 langfuse 凭证（缺 → clean SKIP） ──
if [ -f ./test.env ]; then set -a; source ./test.env; set +a; fi
LANGFUSE_BASE_URL="${LANGFUSE_BASE_URL:-}"
LANGFUSE_PUBLIC_KEY="${LANGFUSE_PUBLIC_KEY:-}"
LANGFUSE_SECRET_KEY="${LANGFUSE_SECRET_KEY:-}"
if [ -z "$LANGFUSE_BASE_URL" ] || [ -z "$LANGFUSE_PUBLIC_KEY" ] || [ -z "$LANGFUSE_SECRET_KEY" ]; then
  echo "SKIP: langfuse not configured (observability optional) — missing LANGFUSE_*"
  exit 0
fi

# 探活（不可达也 SKIP，observability 可选）
if ! curl -sf -o /dev/null -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
     "$LANGFUSE_BASE_URL/api/public/health" 2>/dev/null; then
  echo "SKIP: langfuse instance not reachable at $LANGFUSE_BASE_URL"
  exit 0
fi

# ── 2. 真 provider/model（示例写死 MiniMax；真实用例可自动探测首个非 mock） ──
PROVIDER_ID="${MINIMAX_PROVIDER_ID:-01KVJMPG2FA9ZSWDND60HV56N2}"
MODEL_ID="${MINIMAX_MODEL_ID:-MiniMax-M3}"

# ── 3. 起 server（注入 langfuse env + mock 关） ──
API_PORT="${API_PORT:-3700}"
BASE_URL="http://127.0.0.1:$API_PORT"
PIDFILE="/tmp/langfuse-example.pid"
LOGFILE="/tmp/langfuse-example.log"
cleanup() { [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; }
trap cleanup EXIT
lsof -ti:$API_PORT 2>/dev/null | xargs kill 2>/dev/null || true
sleep 0.5
APP_NAME="${APP_NAME:-rocky_agent}" APP_ENV="${APP_ENV:-test}" \
  DATA_DIR="${DATA_DIR:-$HOME/.${APP_NAME}_${APP_ENV}}" \
  LANGFUSE_BASE_URL="$LANGFUSE_BASE_URL" \
  LANGFUSE_PUBLIC_KEY="$LANGFUSE_PUBLIC_KEY" \
  LANGFUSE_SECRET_KEY="$LANGFUSE_SECRET_KEY" \
  ROCKY_TEST_MOCK_LLM=0 \
  bun run app/server/src/index.ts > "$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"
for i in $(seq 1 40); do curl -sf "$BASE_URL/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "$BASE_URL/health" >/dev/null 2>&1 || { echo "[FAIL] server not ready"; tail -20 "$LOGFILE"; exit 1; }

# ── 4. session + subscribe + SSE listener ──
SID=$(curl -sS -X POST "$BASE_URL/session" -H 'content-type: application/json' -d '{}' \
      | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")
[ -n "$SID" ] || { echo "[FAIL] no session id"; exit 1; }
curl -sS -X POST "$BASE_URL/sse/subscribe" -H 'content-type: application/json' \
  -d "{\"topic\":\"agent_loop\",\"group\":\"session_id:$SID\"}" >/dev/null
SSEFILE="$SCRIPT_DIR/example_sse.txt"; rm -f "$SSEFILE"
( curl -sS -N -m 60 "$BASE_URL/sse" -H "Accept: text/event-stream" > "$SSEFILE" 2>/dev/null ) &
SSE_PID=$!
sleep 1

# ── 5. POST messages → 取 runId（触发词 oracle-proof） ──
TRIGGER="oracle-proof-token-xyz"
QUERY="Reply with exactly this token and nothing else: $TRIGGER"
MSG=$(curl -sS -X POST "$BASE_URL/session/$SID/messages" -H 'content-type: application/json' \
      -d "{\"content\":\"$QUERY\",\"providerId\":\"$PROVIDER_ID\",\"modelId\":\"$MODEL_ID\"}")
RUN_ID=$(echo "$MSG" | python3 -c "import json,sys;print(json.load(sys.stdin).get('runId',''))")
[ -n "$RUN_ID" ] || { echo "[FAIL] no runId: $MSG"; exit 1; }

# ── 6. 等 SSE run_end + langfuse SDK flush（≥12-18s 硬要求） ──
for i in $(seq 1 30); do
  grep -q '"type":"run_end"\|"type": "run_end"' "$SSEFILE" 2>/dev/null && break
  sleep 1
done
sleep 18   # endTrace batch 上报留足时间
kill "$SSE_PID" 2>/dev/null || true

# ── 7. 查 langfuse trace + observations（runId 即 trace.id） ──
AUTH="$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY"
TRACE_HTTP=$(curl -s -o "$SCRIPT_DIR/example_trace.json" -w "%{http_code}" \
  -u "$AUTH" "$LANGFUSE_BASE_URL/api/public/traces/$RUN_ID")
curl -s -o "$SCRIPT_DIR/example_observations.json" \
  -u "$AUTH" "$LANGFUSE_BASE_URL/api/public/observations?traceId=$RUN_ID&limit=100"

# ── 8. 断言（用复用库 langfuse_verify.py；库未落盘则内联等价检查） ──
if [ -f "$ROOT_DIR/tests/api/lib/langfuse_verify.py" ]; then
  python3 - "$SCRIPT_DIR" "$ROOT_DIR" "$RUN_ID" "$TRIGGER" "$TRACE_HTTP" <<'PY'
import json, sys, os
script_dir, root_dir, run_id, trigger, trace_http = sys.argv[1:6]
sys.path.insert(0, os.path.join(root_dir, "tests", "api", "lib"))
from langfuse_verify import (
    check_trace_id, check_input_contains, check_output_contains,
)
trace = json.load(open(f"{script_dir}/example_trace.json")) if trace_http == "200" else {}
ok_id = check_trace_id(trace, run_id)
ok_in = check_input_contains(trace, "proof")
# output 非空 = trace_output_text 提取后非空（与 lib trace_output_text 对齐）
ok_out = bool(trace) and __import__("langfuse_verify").trace_output_text(trace).strip() != ""
print(json.dumps({"trace_id_match": ok_id, "input_has_trigger": ok_in,
                  "output_nonempty": ok_out, "trace_http": trace_http},
                 ensure_ascii=False))
PY
else
  # 库未落盘时内联等价检查（API 已固定，逻辑同 lib 的 check_*）
  python3 - "$SCRIPT_DIR" "$RUN_ID" "$TRIGGER" "$TRACE_HTTP" <<'PY'
import json, sys
script_dir, run_id, trigger, trace_http = sys.argv[1:5]
trace=json.load(open(f"{script_dir}/example_trace.json")) if trace_http=="200" else {}
def _msg_text(m):
    if isinstance(m,str): return m
    if not isinstance(m,dict): return ""
    blocks=m.get("content") or m.get("blocks") or []
    return " ".join(str((b.get("text") or b.get("content")) if isinstance(b,dict) else b) for b in blocks)
ti=trace.get("input") or []; to=trace.get("output") or []
in_text=" ".join(_msg_text(m) for m in (ti if isinstance(ti,list) else []))
out_text=" ".join(_msg_text(m) for m in (to if isinstance(to,list) else []))
ok_id=trace.get("id")==run_id
ok_in="proof" in in_text.lower()
ok_out=out_text.strip()!=""
print(json.dumps({"trace_id_match":ok_id,"input_has_trigger":ok_in,"output_nonempty":ok_out,
                  "trace_http":trace_http,"trace_input_preview":in_text[:200],
                  "trace_output_preview":out_text[:200]},ensure_ascii=False))
PY
fi
