---
name: debug-agent-state-issue
description: 给定 session id，诊断 agent 状态问题（hang / 卡「思考中」/ 停止原因不明 / inbox 堆积 / 孤儿进程）。数据源=DATA_DIR 下 session 快照 + runs + transcript + logs/{agent,event,error}.log；含 dangling tool_call 检测、hang 时间空洞检测、reconcile 收尸签名等已验证配方。全程只读。当用户报「agent 卡住/一直思考中/不动了/停在半路/消息没反应」时使用。
---

# Debug Agent State Issue（agent 状态问题诊断）

**输入**：session id（ULID，如 `01KXCJY0XBJ39QHGY5FK0WV3EM`）。
**输出**：状态结论 + 故障签名归类 + 证据链（文件路径 + 关键行）。
**纪律（MANDATORY）**：全程只读；不重启 server、不杀进程（除非用户明确批准）；只看结构（id/类型/计数/时间戳），**不看消息内容**。

```bash
DATA=~/.rocky_agent_dev        # dev 数据目录；packaged app 的 DATA_DIR 不同，先向用户确认
SID=<session_id>
```

## 1. 数据源地图

| 数据源 | 路径 | 关键字段（以实测为准） |
|---|---|---|
| session 快照 | `$DATA/session/$SID.json` | `state`(idle\|running\|interrupting\|interrupted\|error\|suspended) `running` `currentRunId` `pendingToolCalls` `updatedAt` |
| run 记录 | `$DATA/sessions/$SID/runs/*.json` | `status`(running\|completed\|failed\|paused\|interrupted) `stopReason` `createdAt`(=run 开始，**无 startedAt 字段**) `endedAt` `contextWindowUsage` |
| transcript | `$DATA/sessions/$SID/transcript/*.jsonl` | 每行一条 message：`role`(user\|assistant\|tool) `content[]`；block：`tool_call{id,name,arguments}` / `tool_result{toolCallId,isError}` / `text` |
| agent.log | `$DATA/logs/agent.log` | **须开关**（见 §2）。loop_enter/loop_step/loop_tools_begin/loop_tools_end/loop_exit/state_change/inbox_* |
| event.log | `$DATA/logs/event.log` | 每行 `{ts,topic,group,event:{type,sessionId,...}}`——**唯一可按 sessionId grep 的 SSE 序列** |
| error.log | `$DATA/logs/error.log` | `{ts,sessionId,runId,category,message,displayReason}`（run 失败即写，含 LLM 错误分类） |
| llm.log / tool.log | `$DATA/logs/{llm,tool}.log` | **不含 sessionId**，只能按 ts 关联。llm:`{ts,model,provider,request,response|error}`；tool:`{ts,tool,input,output,isError}` |

`stopReason` 取值（run-react-loop.ts）：`no_tool_call`（正常收尾）/ `max_iterations` / `doom_loop` / `tool_pending`（HITL 悬挂）/ `no_new_messages` / `error` / `interrupted`（此时 run 记录里常为 `null`，status=interrupted）。

## 2. agent.log 开关 + 不存在时的替代证据链

agent.log 由 **app config `logs` 组的 `enableAgentLog` 键**控制（`log-writer.ts` TYPE_TO_KEY；UI 设置页可改，改后即时生效无需重启）。落盘检查：

```bash
grep -A3 '"enableAgentLog"' $DATA/app_config/logs/app_config/*.json 2>/dev/null || echo "键不存在=默认关"
ls -la $DATA/logs/agent.log 2>/dev/null || echo "无 agent.log"
```

**键不存在或 data=false → 无 agent.log（实测 dev 环境即如此）**。替代证据链：
- loop 时间线 → 用 **event.log SSE 序列**（§3-⑤）+ **时间空洞检测**（§3-⑤b）
- 卡在哪个 tool → transcript 尾部 dangling tool_call 的 `name`（§3-③）+ event.log `tool_call_end` 后无 `tool_result_start`
- 停止原因 → run 记录 `stopReason`（§3-②）+ error.log 按 sessionId grep（§3-②b）
- inbox 堆积 → event.log `message_enqueued` 连发而无 `message_start` 跟进（§3-⑤b 实测签名）

建议顺手让用户开 `enableAgentLog`，下次复现即有 loop 级证据。

## 3. 标准诊断流程（5 步）

### ① session 状态快照

```bash
python3 -c "
import json; d=json.load(open('$HOME/.rocky_agent_dev/session/$SID.json'))
print({k:d.get(k) for k in ['state','running','currentRunId','pendingToolCalls','updatedAt']})"
```

判读：`state=running + updatedAt 久未更新` → 疑似 hang（进 ③⑤）；`suspended + pendingToolCalls 非空` → HITL 等人回填（正常态）；`error` → 进 ②b 看 error.log；`interrupting` 久滞 → abort 卡住。

### ② 最后一个 run 的 status/stopReason

```bash
python3 - <<'EOF'
import json, glob, os
files = sorted(glob.glob(os.path.expanduser("~/.rocky_agent_dev/sessions/"+os.environ['SID']+"/runs/*.json")))
for f in files[-8:]:
    r = json.load(open(f))
    print(os.path.basename(f)[:26], r.get('status'), r.get('stopReason'), 'created=', r.get('createdAt'), 'ended=', r.get('endedAt'))
EOF
```

（跑前 `export SID`。）判读：末 run `status=running` 且无 `endedAt` → run 还挂着（活 hang 或进程已死没收尸）；`failed/error` → ②b；`interrupted + stopReason=null` → 用户 abort 或 reconcile 收尸（§4 签名 3 区分）。

### ②b error.log 按 session 取失败分类

```bash
grep "$SID" $DATA/logs/error.log | tail -5
```

`category` 直接给根因：`TIMEOUT_INTER_CHUNK`（LLM 流 stall）、`RATE_LIMITED`（429 限流）等。实测案例 1 的「hang 后报错」即三连 `TIMEOUT_INTER_CHUNK: stall timeout`。

### ③ transcript 尾部 + dangling tool_call 检测

```bash
python3 - <<'EOF'
import json, glob, os
calls, results = {}, set()
for p in sorted(glob.glob(os.path.expanduser("~/.rocky_agent_dev/sessions/"+os.environ['SID']+"/transcript/*.jsonl"))):
    for ln in open(p):
        if not ln.strip(): continue
        m = json.loads(ln)
        for b in (m.get('content') or []):
            if isinstance(b, dict):
                if b.get('type') == 'tool_call': calls[b['id']] = (m.get('id'), b.get('name'))
                if b.get('type') == 'tool_result': results.add(b.get('toolCallId'))
dang = set(calls) - results
print(f"tool_call={len(calls)} tool_result={len(results)} dangling={len(dang)}")
for cid in sorted(dang): print("  dangling:", cid, "tool=", calls[cid][1], "msg=", calls[cid][0])
EOF
```

判读：dangling 的 `tool=` 即卡死/被截断的工具名。**位于 transcript 最末尾的 dangling** = 当前卡点；历史中段的 dangling = 旧 max_iterations 半轮 / 崩溃遗留（对时间戳区分）。

### ④ agent.log loop 时间线（开关开了才有）

```bash
grep "$SID" $DATA/logs/agent.log | python3 -c "
import json,sys
for ln in sys.stdin:
    d=json.loads(ln)
    print(d['ts'], d['event'], {k:d[k] for k in ('runId','step','stopReason','rounds','toolNames','from','to','ok','count') if k in d})" | tail -30
```

健康序列：`loop_enter{mode,triggerInputIds}` → (`loop_step{step}` → `loop_tools_begin{toolNames,toolCallIds}` → `loop_tools_end{resultCount,pendingCount}`)×N → `loop_exit{stopReason,rounds,interrupted}`。
**卡死签名 = 有 `loop_step`/`loop_tools_begin` 但永不出现配对的 `loop_tools_end`/`loop_exit`**（tool 内 hang）。有 `loop_tools_end` 无下一轮 `loop_step` 也无 `loop_exit` → 卡在 ingest/compact。辅助事件：`state_change{from,to,ok}`（**ok=false = CAS fail**，activate/abort 竞态线索）、`inbox_enqueue/inbox_drain{count,kinds}/inbox_cancel/inbox_remove`（enqueue 累计远大于 drain 累计 = inbox 堆积）。

### ⑤ event.log SSE 尾部序列

```bash
grep "$SID" $DATA/logs/event.log | tail -20 | python3 -c "
import json,sys
for ln in sys.stdin:
    d=json.loads(ln); e=d.get('event',{})
    print(d['ts'], e.get('type'), e.get('stopReason') or (e.get('data') or {}).get('state') or '')"
```

关键事件类型（实测分布）：`message_enqueued` / `message_start/end` / `text_block_start/delta/end` / `tool_call_start/end` / `tool_result_start/end` / `llm_attempt` / `error` / `run_end{stopReason}` / `session_status_update`（v0.0.130 起另有 `tool_execution_start/end`，见 §5）。
**hang 签名 = `tool_call_end` 之后长时间无 `tool_result_start`**（工具执行中挂死）；`message_enqueued` 连发而无 `message_start` = loop 没起或没 drain（inbox 堆积）。

### ⑤b hang 时间空洞检测（无 agent.log 时的主武器）

```bash
python3 - <<'EOF'
import json, os
from datetime import datetime
SID=os.environ['SID']; evs=[]
for ln in open(os.path.expanduser('~/.rocky_agent_dev/logs/event.log')):
    try: d=json.loads(ln)
    except Exception: continue
    e=d.get('event',{})
    if e.get('sessionId')==SID: evs.append((d['ts'], e.get('type')))
p=lambda ts: datetime.fromisoformat(ts.replace('Z','+00:00'))
for a,b in zip(evs, evs[1:]):
    gap=(p(b[0])-p(a[0])).total_seconds()
    if gap>300: print(f"{a[0]} {a[1]} -> {b[0]} {b[1]}  gap={gap:.0f}s")
EOF
```

判读：空洞两端的事件类型点名卡点——实测案例 1 出 `message_enqueued -> tool_result_start gap=873s`（bash 工具卡 14 分钟）+ 数千秒空洞期间用户消息堆积。

## 4. 已知故障签名对照表

| # | 签名 | 证据组合 | 归因 |
|---|---|---|---|
| 1 | **stuck-running（tool 卡死）** | ①state=running+updatedAt 陈旧；②末 run status=running 无 endedAt；④有 loop_tools_begin 无 loop_tools_end；⑤tool_call_end 后无 tool_result_start + 大空洞 | v0.0.130 前无 tool 超时兜底；卡住的 tool 名看 ③dangling / ④toolNames |
| 2 | **max_iterations dangling** | ②stopReason=max_iterations；③末尾 assistant 有 tool_call 无配对 tool_result | v0.0.130 前旧判定位置（②assistant 落盘后、③执行前 break）产生半轮；实测案例 2（12 个 dangling）。v0.0.130 后不应再现 |
| 3 | **reconcile 收尸（server 重启）** | ②status=interrupted+stopReason=null，且**跨多个 session 的 runs endedAt 同一秒批量出现** | 启动 reconcile 把遗留 running 批量标 interrupted。实测：`2026-07-11T07:58:12` 同秒 4 session 各 1 run。核查配方：全局扫 `$DATA/sessions/*/runs/*.json` 按 `endedAt[:19]` 分组数 status=interrupted |
| 4 | **429 限流** | ②b error.log category=`RATE_LIMITED`；llm.log 尾部 error 行 | 外因，等窗口重试；连环 RATE_LIMITED → 查并发 run 数 |
| 5 | **孤儿进程** | `pgrep -lf <精确 pid 或 pidfile>`、`ps -o pid,ppid,etime,command -p <pid>`（ppid=1 = 孤儿） | **禁 pkill 宽匹配**（会误杀其他 worktree 同名进程）；只按 pidfile/精确 pid 查。v0.0.130 后 bash 组杀应无孤儿 |
| 6 | **代理死连接下载 hang** | `lsof -p <server_pid> -a -i TCP | grep CLOSE_WAIT`；⑤b 大空洞 + 卡点 tool=bash/web_fetch | 实测案例 1 根源：bash 下载走死代理连接永挂。v0.0.130 后被 tool 超时兜底截断 |

## 5. v0.0.130 之后的预期行为基线（先分清版本再归因）

诊断前确认 server 版本（根 `package.json` version / git log）。v0.0.130（hang-fix）起：
- **tool 超时三层兜底**：超时 tool_result 以 `[timeout] <tool名> exceeded <ms>ms` 开头（`tools/engine-timeout.ts`）——签名 1 不应再现；出现该前缀 = 兜底生效，属**预期行为**不是 bug
- **bash 组杀无孤儿**：bash 子进程按进程组清理——签名 5 出现即回归
- **SSE 阶段事件**：`tool_execution_start{toolNames,toolCallIds}` / `tool_execution_end{resultCount,pendingCount}`（与 agent.log loop_tools_begin/end 同址）——前端「思考中」期间可见执行阶段
- **max_iterations 轮次边界判定**（step++ 之后、完整轮结束才 break）：凡已落盘 tool_call 必有配对 tool_result——签名 2 出现即回归

在 v0.0.130 前的数据上看到签名 1/2/5/6 = 已知旧问题，不重复立 BUG；在之后的版本复现 = 回归，立 BUG 并附本 skill 证据链。

## 6. 汇报模板

```
结论：<签名 N：一句话>（版本 <v>，v0.0.130 前/后）
证据：① state=… updatedAt=…  ② 末 run …  ③ dangling=…(tool=…)  ④/⑤ <时间线关键行>
处置建议：<等待/让用户开 enableAgentLog 复现/立 BUG/外因重试>
```
