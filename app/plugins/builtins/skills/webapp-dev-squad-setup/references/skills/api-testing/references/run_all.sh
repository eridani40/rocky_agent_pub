#!/usr/bin/env bash
# run_all.sh — API 测试串联脚本（全自动 / executor 无脑执行）
# 参考: .rocky/skills/api-testing/SKILL.md「串联脚本 run_all.sh」「测试耗时与并发」
#
# 设计理念:
#   - 零参数。executor: `bash tests/api/lib/run_all.sh`，结束。
#   - orchestrator 可选设: VERSION=v0.0.33.1（定位版本目录，缺省自动 latest）
#     + MODULE=squad（限定 module，缺省全量回归）
#     + PARALLEL（lane 数，默认 4）/ SLOW_THRESHOLD（慢 case 阈值秒，默认 60）
#   - 结果隔离：每跑一次写到 states/<ver>/verify/api-test/round-N/（N 自动递增），不覆盖历史轮次
#   - designer 只按标准写 case，**不改本脚本**；executor 无 Edit/Write 权限
#
# 并发模型（v0.0.33.2）: N 条并行 lane，每 lane 内串行（依赖决定分组）。
#   case 可在 checkpoint.json 声明 depends_on / lane；有依赖进同 lane 串行，无依赖轮询分 lane。
#   默认（无声明）case 自包含 → 轮询分 N lane（designer 保证可并行）。
#
# 耗时记录: 写 run_all_result.json.timing（flow_start/end + lanes[] + cases[] + slow_cases[]）。
#
# JSON 并发锁审计: 每 case 只写自己 dir（last_run.json/checkpoint.json）+ 每 lane 独立
#   _timing_lane_${i}.jsonl + 每 case 独立 _run_*.log → 跨 lane 无共享写竞争，天然无锁。
#   run_all_result.json 在 wait(barrier) 后单写。无 flock 需求（防御性已确认）。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$SCRIPT_DIR"
while [ "$ROOT_DIR" != "/" ]; do
  [ -f "$ROOT_DIR/package.json" ] && break
  ROOT_DIR="$(dirname "$ROOT_DIR")"
done
cd "$ROOT_DIR"
[ -f ./test.env ] && { set -a; source ./test.env; set +a; }
export MODULE="${MODULE:-}" VERSION="${VERSION:-}"
export PARALLEL="${PARALLEL:-4}"
export SLOW_THRESHOLD="${SLOW_THRESHOLD:-60}"

# ── 0. 定位版本 + round 隔离 ──
OUT_DIR=$(python3 -c "
import os,re
version=os.environ.get('VERSION')
if not version:
    vers=[d for d in os.listdir('states') if re.match(r'^v',d)] if os.path.isdir('states') else []
    if not vers: raise SystemExit(1)
    key=lambda v: tuple(int(x) for x in re.findall(r'\d+',v))
    version=max(vers,key=key)
base=os.path.join('states',version,'verify','api-test')
rounds=[int(d.replace('round-','')) for d in os.listdir(base) if d.startswith('round-')] if os.path.isdir(base) else []
n=(max(rounds)+1) if rounds else 1
print(os.path.join(base,f'round-{n}'))
" 2>/dev/null) || { echo "[run_all] ERROR: no states/v* found"; exit 2; }
mkdir -p "$OUT_DIR"

# ── 1. 启 env（先清残留端口）──
PORT="${API_PORT:-3700}"
curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && bash tests/api/env_shutdown.sh >/dev/null 2>&1
if ! bash tests/api/env_start.sh >"$OUT_DIR/_env_start.log" 2>&1; then
  python3 -c "import json;json.dump({'overall':'error','reason':'env_start failed (see _env_start.log)','cases':{}},open('$OUT_DIR/run_all_result.json','w'),ensure_ascii=False,indent=2)"
  cat "$OUT_DIR/run_all_result.json"; exit 2
fi
GLOB_PATTERN="${MODULE:+tests/api/$MODULE/*/run.sh}"
GLOB_PATTERN="${GLOB_PATTERN:-tests/api/*/*/run.sh}"
echo "[run_all] OUT_DIR=$OUT_DIR VERSION=${VERSION:-auto} MODULE=${MODULE:-all} PARALLEL=$PARALLEL"

# ── 2. 扫 case + 按 depends_on/lane 分组到 N 条 lane（barrier 前单写）──
LANE_FILE="$OUT_DIR/_lanes.json"
python3 - "$GLOB_PATTERN" > "$LANE_FILE" <<'PY'
import json, os, sys, glob
from collections import defaultdict
# lane 分配策略: depends_on 关联的 case 进同 lane 串行; 无依赖轮询分 lane (min-load)
pattern = sys.argv[1]
N = max(1, int(os.environ.get("PARALLEL") or "4"))
cases = []
for run_sh in sorted(glob.glob(pattern)):
    case_dir = os.path.dirname(run_sh); case_id = os.path.basename(case_dir)
    module = os.path.basename(os.path.dirname(case_dir))
    cp = os.path.join(case_dir, "checkpoint.json")
    deps, lane_explicit = [], None
    if os.path.isfile(cp):
        try:
            d = json.load(open(cp)); deps = d.get("depends_on",[]) or []; lane_explicit = d.get("lane")
        except Exception: pass
    cases.append({"module":module,"case_id":case_id,"run_sh":run_sh,"depends_on":deps,"lane":lane_explicit})
# Union-Find: depends_on 关联的 case 进同一 lane
parent = {c["case_id"]: c["case_id"] for c in cases}
def find(x):
    parent.setdefault(x, x)
    while parent[x] != x: parent[x] = parent[parent[x]]; x = parent[x]
    return x
def union(a, b):
    ra, rb = find(a), find(b)
    if ra != rb: parent[ra] = rb
for c in cases:
    for dep in c["depends_on"]: union(c["case_id"], dep)
groups = defaultdict(list)
for c in cases: groups[find(c["case_id"])].append(c)
# 组内拓扑排序: 依赖在前
def topo(cs):
    placed, ids, rem = [], set(), list(cs)
    while rem:
        prog = False
        for c in list(rem):
            if all(d in ids or d not in [x["case_id"] for x in cs] for d in c["depends_on"]):
                placed.append(c); ids.add(c["case_id"]); rem.remove(c); prog = True
        if not prog: placed.extend(rem); break
    return placed
lanes = [[] for _ in range(N)]
gl = [topo(groups[k]) for k in sorted(groups.keys())]
unassigned = []
for g in gl:
    ex = next((c["lane"] for c in g if c["lane"] is not None), None)
    if ex is not None: lanes[ex % N].extend(g)
    else: unassigned.append(g)
for g in unassigned:
    t = min(range(N), key=lambda i: len(lanes[i])); lanes[t].extend(g)
lanes = [l for l in lanes if l]  # 裁掉空 lane
print(json.dumps({"lanes":lanes,"num_lanes":len(lanes),"total":len(cases)}, ensure_ascii=False))
PY
NUM_LANES=$(python3 -c "import json;print(json.load(open('$LANE_FILE'))['num_lanes'])")
echo "[run_all] assigned $(python3 -c "import json;print(json.load(open('$LANE_FILE'))['total'])") cases to $NUM_LANES lane(s)"

# ── 3. 并行跑 lane（每 lane 内串行，失败不中断）+ per-lane JSONL 耗时 ──
export OUT_DIR LANE_FILE
run_lane() {
  local lane_idx="$1"
  local lane_start; lane_start=$(date +%s)
  local lane_file="$OUT_DIR/_timing_lane_${lane_idx}.jsonl"
  : > "$lane_file"  # 本 lane 独占写，跨 lane 无共享
  local n; n=$(python3 -c "import json;print(len(json.load(open('$LANE_FILE'))['lanes'][$lane_idx]))")
  for ((i=0; i<n; i++)); do
    local module case_id run_sh
    read -r module case_id run_sh <<< "$(python3 -c "
import json
c=json.load(open('$LANE_FILE'))['lanes'][$lane_idx][$i]
print(c['module'], c['case_id'], c['run_sh'])
")"
    local case_start; case_start=$(date +%s)
    if bash "$run_sh" >>"$OUT_DIR/_run_${module}_${case_id}.log" 2>&1; then
      echo "[lane $lane_idx] $module/$case_id: pass"
    else
      echo "[lane $lane_idx] $module/$case_id: fail"
    fi
    local case_end; case_end=$(date +%s)
    printf '{"module":"%s","case_id":"%s","start":%s,"end":%s,"duration_s":%s}\n' \
      "$module" "$case_id" "$case_start" "$case_end" "$((case_end-case_start))" >> "$lane_file"
  done
  local lane_end; lane_end=$(date +%s)
  printf '{"lane_event":"end","lane":%s,"start":%s,"end":%s,"duration_s":%s}\n' \
    "$lane_idx" "$lane_start" "$lane_end" "$((lane_end-lane_start))" >> "$lane_file"
}

FLOW_START=$(date +%s)
if [ "$NUM_LANES" -le 1 ]; then
  run_lane 0
else
  for ((i=0; i<NUM_LANES; i++)); do run_lane "$i" & done
  wait
fi
FLOW_END=$(date +%s)
export FLOW_START FLOW_END

# ── 4. 关 env ──
bash tests/api/env_shutdown.sh >"$OUT_DIR/_env_shutdown.log" 2>&1 || true

# ── 5. 聚合（按 module 分组 + timing 附加字段；wait 后单写无并发）──
python3 - "$OUT_DIR" <<'PY'
import json, os, sys, glob, datetime
out_dir = sys.argv[1]; module = os.environ.get("MODULE")
slow_threshold = int(os.environ.get("SLOW_THRESHOLD") or "60")
# case 结果聚合（按 module）
pattern = f"tests/api/{module}/*/last_run.json" if module else "tests/api/*/*/last_run.json"
by_module = {}
for lr in sorted(glob.glob(pattern)):
    parts = lr.split(os.sep); m, cid = parts[-3], parts[-2]
    try:
        data = json.load(open(lr)); rec = {"result": data.get("result","unknown"), "desc": str(data.get("desc",""))[:300]}
    except Exception as e: rec = {"result": "error", "desc": str(e)}
    by_module.setdefault(m, {})[cid] = rec
total = sum(len(v) for v in by_module.values())
passed = sum(1 for v in by_module.values() for r in v.values() if r["result"]=="pass")
# timing 聚合: 读 per-lane JSONL（每 lane 独立文件 → 无并发写）
cases_t, lanes_t = [], []
for f in sorted(glob.glob(os.path.join(out_dir, "_timing_lane_*.jsonl"))):
    for line in open(f):
        line = line.strip()
        if not line: continue
        rec = json.loads(line)
        if rec.get("lane_event")=="end": lanes_t.append({"lane": rec["lane"], "duration_s": rec["duration_s"]})
        else:
            rec["slow"] = rec["duration_s"] > slow_threshold; cases_t.append(rec)
flow_start = int(os.environ.get("FLOW_START","0")); flow_end = int(os.environ.get("FLOW_END","0"))
def iso(e): return datetime.datetime.fromtimestamp(e).isoformat() if e else None
timing = {"flow_start": iso(flow_start), "flow_start_epoch": flow_start,
          "flow_end": iso(flow_end), "flow_end_epoch": flow_end,
          "flow_duration_s": (flow_end-flow_start) if flow_start and flow_end else None,
          "lanes": lanes_t, "cases": cases_t,
          "slow_cases": [c for c in cases_t if c.get("slow")]}
out = {"overall": "pass" if passed==total and total else "fail",
       "total": total, "passed": passed, "failed": total-passed, "by_module": by_module,
       "timing": timing}
json.dump(out, open(os.path.join(out_dir,"run_all_result.json"),"w"), ensure_ascii=False, indent=2)
print(json.dumps(out, ensure_ascii=False, indent=2))
PY

[ "$(python3 -c "import json;print(json.load(open('$OUT_DIR/run_all_result.json'))['overall'])")" = "pass" ]
