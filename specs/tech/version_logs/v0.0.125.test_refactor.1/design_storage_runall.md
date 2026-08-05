# per-step 存储布局 + run_all v2

> 归属：`design.md §0` 目录页拆分文件。定义 per-step 存储布局、result.json/events.jsonl schema、run_all v2、双关聚合、输出目录。
> 现状基线：`tests/lib/port_alloc.sh`（per-worktree 端口文件）、`tests/lib/timeout_guard.sh`（python setsid 树杀）、`tests/api/lib/run_all.sh`（CASES 白名单/ROUND/progress.jsonl/分类聚合）——只借教训与接口惯例，不复用代码。

## 1. 目录布局

```
tests_v2/api/<module>/<case>/
├── case.yaml                    # 唯一 case 描述（DSL）
├── recordings/                  # 桩帧（入 git = 交付物）
│   ├── llm.jsonl                # llm 桩点帧（每行一次调用）
│   ├── web_search.jsonl         # web_search 桩点帧（可选，无调用则无此文件）
│   ├── web_fetch.jsonl          # web_fetch 桩点帧（可选）
│   └── manifest.json            # 每桩点帧数 + 指纹（drift 判据）
└── last_run/                    # 运行产物（gitignore）
    ├── result.json              # case 级汇总（逐 check 结果含 actual）
    └── steps/
        ├── 00/                  # setup step 0（setup/steps/teardown 全局连续编号）
        ├── 01/{responses.json, events.jsonl, checks.json}
        └── 02/...
```

- **step 编号**：setup → steps → teardown 全局连续两位数（`00`,`01`,...）；result.json 记录每号归属哪个 phase。
- `recordings/` 入 git（含 manifest.json；jsonl 按实际桩点存在）；`last_run/` 加入 `.gitignore`（`tests_v2/**/last_run/`）。

## 2. 产物 schema

### 2.1 `steps/NN/responses.json`（本 step HTTP 响应）

```json
{
  "phase": "steps",
  "name": "发消息同步等终态",
  "action": "run",
  "requests": [
    { "method": "POST", "path": "/session/01.../run", "status": 200, "body": { "state": "idle", "stopReason": "no_tool_call", "messages": [] } }
  ],
  "main_output_ref": "requests[0].body"
}
```

- `action` ∈ `requests|run|poll|wait|oracle|none`（none = 纯订阅/纯 check step）。
- poll：额外记 `poll_rounds`（轮数）+ `satisfied`（bool）+ `last_actual`。
- wait/oracle：记 `satisfied` + `elapsed_ms` + `skipped`（replay 轮 oracle=true）。

### 2.2 `steps/NN/events.jsonl`（本 step 期间该流收到的 SSE 事件快照）

每行一个事件（**per-step 独立存储**——每步落该步执行窗口内各命名流累积的事件切片）：
```json
{"stream":"main","seq":0,"topic":"agent_loop","type":"run_start","data":{...},"ts":"..."}
{"stream":"main","seq":1,"topic":"agent_loop","type":"message_start","data":{...},"ts":"..."}
```

- 命名流全程累积（case 级），但**每步落盘该步结束时各流的当前快照增量**（便于逐步诊断「这一步收到了什么」）。wait/check 引用的是 case 级累积缓冲，events.jsonl 是诊断镜像。

### 2.3 `steps/NN/checks.json`（本 step 逐 check 结果）

```json
[
  { "expr": ".state == \"idle\"", "pass": true, "actual": "idle" },
  { "expr": "main.count(type=run_end) == 1", "pass": false, "actual": 0, "note": "expected 1" }
]
```

### 2.4 `result.json`（case 级汇总）

```json
{
  "case": "chat_basic_reply",
  "module": "chat",
  "mode": "replay",
  "result": "pass",
  "phases": {
    "setup":  { "pass": true },
    "steps":  { "pass": false, "failed_steps": [2] },
    "teardown": { "pass": true }
  },
  "steps": [
    { "n": "00", "phase": "setup", "name": "建会话", "pass": true, "checks": 0 },
    { "n": "02", "phase": "steps", "name": "发消息", "pass": false, "checks_failed": ["main.count(type=run_end) == 1"] }
  ],
  "stub": { "frames": { "llm": 2 }, "audit_ok": true },
  "drift": { "detected": false },
  "undeclared": [],
  "elapsed_ms": 3420,
  "double_gate": { "record": "pass", "replay": "pass" }
}
```

- `result` ∈ `pass|fail|drift|timeout|not_run`（five-class，见 §3）。
- **case 主判定 = steps phase 全 pass**（setup fail → `not_run(setup_failed)`；teardown check fail 不影响 result，D8）。
- `double_gate` 仅新增/重录 case 有（record+replay 两轮结果）；纯 replay 轮省略。

## 3. run_all v2

落 `tests_v2/api/lib/run_all.sh`（bash wrapper，调 Python run_case 逐 case）。

### 3.1 入参（沿用旧惯例，防呆一致）

| 变量 | 语义 |
|---|---|
| `MODE=record\|replay\|live` | **执行层模式**（req 拍板归执行层，不写 case）；缺省 `replay` |
| `CASES=a,b` | case_id 白名单（唯一白名单变量；无 AT_CASES/ET_CASES，防呆 fail-loud 沿用旧 run_all） |
| `MODULE=m` | 限定模块 |
| `ROUND=N` | 结果 per-round 隔离（`round-N/api-test-v2/`）+ 跨轮 skip-passed |
| `LIST_ONLY=1` | dry-run 只列 case |
| `SKIP_ENV=1` | env 外部管理 |
| `RUN_BUDGET_SECONDS=N` | 总 wall-clock 预算 hard-stop（默认 900） |

### 3.2 执行流（框架不并行，全串行）

1. `env_start.sh`（起 server NODE_ENV=test；端口从 port_alloc 读/分配，与 AT/ET 共享 `.env_port`；**v2 与旧 tests/ 不可并发**）。
2. 解析 case 列表（CASES 白名单 / MODULE / skip-passed）。
3. **逐 case 串行**跑 `run_case.py <case_dir>`（timeout_guard 包住，读 `case.yaml.timeout`）：
   - **`MODE=record`**：先跑 record 轮 → PASS 则自动紧接 replay 轮（**双关**，§3.4）；两轮全绿标 pass，record 绿 replay 红标 fail。
   - **`MODE=replay`**：单轮回放（recordings 缺失 → server 自动切 record，该 case 走双关补录）。
   - **`MODE=live`**：直通真调（`requires: live` case 才跑；非 live case 在 live 模式下仍可跑但走真出网）。
4. 每 case 完成 append `progress.jsonl`（`start`/`case`/`done` 三事件，沿用旧惯例——长跑轮询 done 行防读旧结果）。
5. `env_shutdown.sh` + 聚合 `run_all_result.json`。

### 3.3 聚合 schema（five-class 分列）

```json
{
  "version": "v0.0.125.test_refactor.1",
  "mode": "replay",
  "total_count": 12,
  "pass_count": 10,
  "fail_count": 1,
  "drift_count": 1,
  "timeout_count": 0,
  "not_run_count": 0,
  "wall_time_seconds": 84.2,
  "cases": [
    { "case": "chat_basic_reply", "module": "chat", "result": "pass", "elapsed_ms": 3420 },
    { "case": "web_search_tc1", "module": "web", "result": "drift", "drift_points": ["web_search"] }
  ]
}
```

- `result` five-class：`pass` / `fail`（含 stub_audit fail / undeclared / check fail / timeout 归 timeout）/ `drift`（replay 帧漂移，不翻 overall）/ `timeout`（case 超 timeout）/ `not_run`（requires_live skip / setup_failed / budget_exhausted）。
- **drift 不算 fail、单列、不翻 overall**（req + CLAUDE.md 判定规则 3）。
- 通过率口径：`pass_count / (total_count - drift_count - not_run_count)`（drift/not_run 出分母）——与门禁阈值对齐。

### 3.4 双关编排（run_all 层，design.md §4）

record 轮 case 跑完（`run_case.py` 返 record 结果）：
- record PASS（steps 全绿 + stub_audit_ok）→ recordings 已 flush → **run_all 立即对同 case 再跑一次 `MODE=replay`**（读刚落盘的 recordings）：
  - replay PASS → case 终判 `pass`，`double_gate={record:pass, replay:pass}`，recordings 保留（可 commit）。
  - replay FAIL/drift → case 终判 `fail`，`double_gate={record:pass, replay:fail}`——录制不可离线回放（动态 marker/时序断链），需查（不 commit 该 recordings，或标问题）。
- record FAIL → case 终判 `fail`，不触发 replay（record 都没绿，无有效 recordings）。

## 4. 双关验收流程（orchestrator 视角）

- orchestrator 对新增/重审 case：`MODE=record CASES=<新增白名单> ROUND=1 bash tests_v2/api/lib/run_all.sh`——run_all 内部完成 record→replay 双关，聚合里每 case 的 `double_gate` 两轮全绿才算通过。
- 纯回归（只改产品代码）：`MODE=replay CASES=<白名单> bash tests_v2/api/lib/run_all.sh`（recordings 不动，离线回放）。
- 达阈值口径 + 遗留 case 汇报沿用 CLAUDE.md「测试迭代与阈值门禁」。

## 5. env 脚本（tests_v2/api/）

| 脚本 | 职责 |
|---|---|
| `tests_v2/api/env_start.sh` | 起 server（NODE_ENV=test，DATA_DIR=per-worktree，端口 port_alloc 分配）；复用 `tests/lib/port_alloc.sh`（同一 `.env_port`，端口全局唯一） |
| `tests_v2/api/env_shutdown.sh` | 读 `.env_port` → 杀 pid + 清端口 + 删文件 |
| `tests_v2/api/lib/run_all.sh` | §3 executor wrapper |
| `tests_v2/api/lib/run_case.py` | 单 case 入口（runner v2，见 design.md §3 模块划分） |
| `tests_v2/lib/`（如需） | v2 专属 lib（若与 tests/lib 共享则直接 source `tests/lib/{port_alloc,timeout_guard}.sh`，不复制） |

> **端口/DATA_DIR 共享 + 不并发**：tests_v2 与 tests/ 用同一 port_alloc 注册表（端口是全局资源）；因框架不并行铁律 + 共享 DATA_DIR，**v2 run 与旧 tests/ run 不可同时进行**（run_all 启动时若检测到 `.env_port` 有活 pid 属别的 run，等待或报错，沿用旧 boot-race 二次校验）。

## 6. gitignore 增量

```
tests_v2/**/last_run/
tests_v2/**/last_run.json
```
（`recordings/` 入 git，不 ignore。）
