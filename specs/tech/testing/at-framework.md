---
type: design
title: AT 真实调 API 框架（case.yaml DSL + run_case/run_all + 429 skip + dev config 内容 copy）
priority: P1
status: active
updated: 2026-07-22
since: v0.0.190
related: [index.md, et-framework.md, ../../version_logs/v0.0.190/change_plan.md, ../agent/providers_and_models/[P0]llm_client_interface.md]
---

# AT 真实调 API 框架

> 管什么：`tests/api/` 的 case.yaml DSL + run_case.py / run_all.sh / step_exec.py / case_loader.py / env_start.sh 编排 + 429 skip 机制 + dev config 内容 copy。
> 不管什么：protocol/SSE/tool loop（→ `../agent/`）、LlmClient 组合契约（→ `../agent/providers_and_models/`）、ET（→ `et-framework.md`）。
> 历史背景：v0.0.120 ~ v0.0.189 期间本文件描述的是「AT record/replay stub 基建」（拦截 fetchImpl 录制/回放 + drift + golden + http/sse 入站通道），于 v0.0.190 整体删除（维护成本不可持续，对齐 ET v0.0.188 真实跑范式）。本文件 v0.0.190 重写为「真实调 API 框架」并改名 `record-replay.md` → `at-framework.md`（与 `et-framework.md` 平行；旧机制历史段落保留在 §5，架构考古用）。

## 1. 概述

**强约束（管什么）**：每 case 真实调 minimax 等 provider + 契约断言；case.yaml 声明式 DSL（setup/steps/teardown 三段）；429/529/503 → `skipped, reason=429`（不重试不阻塞）；dev config 5 组技术配置 copy（web_search/see_image/runtime/web/consolidation）+ provider pool（test pool，case 硬编码 ULID）+ default_models=minimax（不 reuse dev deepseek）。
**不管什么**：不改 protocol 解析、不 stub ET、不录制不回放、不 drift。
**与外界交互**：env_start.sh 启 server + copy dev config 内容 + post-boot seed contextWindow；run_case.py 每步调 HTTP API + 收 SSE 事件 + 写 per-step 产物；step_exec.py 检测 429 抛 RateLimitedError；_run_all_exec.py 聚合 5 分类（pass/fail/timeout/not_run/skipped）。

## 2. 组件模型（代码路径精确）

| 组件 | 文件 | 职责 |
|---|---|---|
| case_loader | `tests/api/lib/case_loader.py` | 加载 + 校验 case.yaml；schema（_TOP_FIELDS / _STEP_FIELDS）；拒载未知字段 / 多动作类 / 非原子 check / 未声明插值变量 |
| run_case | `tests/api/lib/run_case.py` | 单 case 入口：load → setup/steps/teardown 编排 → 写 result.json；捕获 RateLimitedError → result='skipped'；cleanup_written_files 必跑（finally）|
| _run_all_exec | `tests/api/lib/_run_all_exec.py` | run_all 执行引擎：逐 case 串行跑 run_case.py（subprocess + 进程组树杀）+ 5 分类聚合 + budget 控制 + progress.jsonl journal |
| run_all.sh | `tests/api/lib/run_all.sh` | run_all 入口：env_start → _run_all_exec → env_shutdown；CASES 白名单 + MODULE + ROUND + LIST_ONLY + SKIP_ENV + RUN_BUDGET_SECONDS 参数 |
| step_exec | `tests/api/lib/step_exec.py` | step 执行器：动作类分发（requests/run/poll/wait/oracle/files）+ save + check；429 检测抛 RateLimitedError；oracle 未配置 langfuse 时 skip |
| RateLimitedError | `step_exec.py` | 新异常类（v0.0.190），标记 case 应 skip 不 fail；保守谓词 `_is_rate_limited(status, body)` |
| case.yaml | `tests/api/<module>/<case>/case.yaml` | case 声明式 DSL：setup/steps/teardown + 每 step 动作类（requests/run/poll/wait/oracle/files）+ sse.sub + save + check |
| env_start.sh | `tests/api/env_start.sh` | 启 server（NODE_ENV=test）+ copy dev 5 组技术配置（cp -rL）+ provider pool symlink + post-boot seed contextWindow |
| artifacts | `tests/api/lib/artifacts.py` | per-step 产物落盘（`last_run/steps/NN/{responses,events,checks}.json`）+ `result.json` |
| interp | `tests/api/lib/interp.py` | 插值 + HTTP 原语（`http_request`、`interpolate`、`interpolate_strict`）|
| check_engine | `tests/api/lib/check_engine.py` | 原子 check 谓词解析 + 求值（`parse_atomic` / `eval_check`）|
| sse_collector | `tests/api/lib/sse_collector.py` | SSE 订阅 + 事件收集 + wait_for_condition（命名流条件等待）|
| langfuse_client | `tests/api/lib/langfuse_client.py` | langfuse trace 轮询（oracle 动作类用，可选）|

**接线（已删除）**：v0.0.190 删除 server 侧 test-only 接线（`router.ts::dispatchRequestInternal` 的 interceptHttpRequest/recordHttpResponse 分支、`bootstrap-bus-phase.ts::bootstrapBusPhase` 的 installSseTestInterceptor 调用、`llm-client-factory.ts::buildLlmClient` 的 recordReplayFetch 分支、`jina-fetcher.ts::JinaFetcher.fetch` 的 pickWebFetchFetch 分支、`misc-routes.ts` 的 /test/stub* 与 /test/llm-mode* 路由、`sse-channel.ts::SseChannel` 的 setTestInterceptor + testInterceptor 字段 + 三处 onSubscribe/shouldSkipHubReplay/onWriteFrame 分支、`event-bus.ts::ReplayableEventBus.subscribe` 的 skipReplayHistory opt）。prod 行为零变化（所有删除分支 NODE_ENV=test 门控，prod 永不执行）。保留 ROCKY_TEST_MOCK_LLM mock 路径（computer_use case 依赖）+ /test/consolidation/run 端点（t2_daily_consolidation case 依赖）。

## 3. case.yaml DSL schema

```yaml
case: <case_id>           # 必须与目录名一致
module: <module>           # 必须与父目录名一致
timeout: 60                # case 整体超时秒，[1, 300]
requires: live             # 可选，'live' 或省略（v0.0.190 起恒 live 真调，省略即可）

setup:                     # 可选，环境准备（建 session / seed 数据 / 配置依赖）
  - name: <step_name>
    requests: [...]        # HTTP 请求列表（简写或 object 形式）
    save: { var: .path }   # 从 main_output 提取变量到 ctx
    check: [...]           # 原子 check 表达式列表
    sse:
      sub:                 # SSE 订阅（topic + group + as 命名流）
        - { topic: ..., group: ..., as: stream_name }

steps:                     # 必填，至少 1 step；主测试逻辑
  - name: <step_name>
    run: { content: ... }  # 动作类：requests/request/run/poll/wait/oracle/files（互斥）
    save: ...
    check: ...
    timeout: 30            # step 级 timeout（仅 requests/request 适用，覆盖默认 30s）

teardown:                  # 可选，清理（删 session / squad 等）
  - name: ...
    requests: [...]
```

**动作类（互斥）**：
- `requests` / `request`：HTTP 请求（简写 `'POST /session {...}'` 或 object `{method, path, body, status, multipart}`）
- `run`：`POST /session/{sid}/run` 同步等 agent loop 终态
- `poll`：轮询直到条件满足或超时（`{request, until, every?, timeout}`，timeout ≤ 60）
- `wait`：等 SSE 命名流条件满足（`{stream, until, timeout}`，timeout ≤ 60）
- `oracle`：langfuse trace 轮询（`{langfuse: {timeout, ready_when}}`，未配置 langfuse 自动 skip）
- `files`：写文件到 DATA_DIR（case 结束自动清理）

**check 原子谓词**：
- 路径比较：`.path == value` / `.path != value` / `.path exists` / `.path contains "text"` / `.path matches /regex/`
- 数组谓词：`.items[] any .field == value` / `.items[] all .field != value`
- SSE 流：`main.count(type=run_end) == 1` / `main.absent(type=error)` / `main.order(run_start < run_end)`
- 详见 `tests/README.md` DSL schema 章节

## 4. 429 skip 机制（v0.0.190 新增）

**保守谓词**（避免正常 fail 误判为 skip 导致假绿）：
- HTTP status ∈ {429, 503, 529}（覆盖 anthropic 529 overloaded + 通用 429/503）
- body `error.type` 或 `error.code` 字面量 ∈ {`rate_limit`, `overloaded`, `rate_limit_error`}（小写精确匹配，不做模糊包含）

**触发点**：
- `_do_requests`（step_exec.py）：HTTP 响应检测
- `_do_run`（step_exec.py）：`POST /session/:id/run` 同步响应检测；另检查 `stopReason == 'error' && lastError.type` 命中（异步 run 内部限流）

**流程**：
```
step_exec → raise RateLimitedError → run_case._run_case_once except 捕获
                                     → result='skipped', reason='429', detail=<错误片段>
                                     → cleanup_written_files（finally 必跑）
                                     → write_result
                                     → sys.exit(0)（skipped 不算失败退出码）
_run_all_exec → entry={result: 'skipped', skip_reason: '429', detail: ...}
              → 聚合 skipped_count++
              → overall 不翻（仅 fail/timeout 翻 overall）
```

## 4.1 dev config 内容 copy 到 test env（v0.0.190 新增）

**用户裁决**：test env 优先（self-contained，不依赖 dev 运行态），但 dev 真实凭证可通过 copy 注入到 test DATA_DIR。

**5 组技术配置 copy from dev**（`tests/api/env_start.sh` 第 8 步，`cp -rL` 解引用 symlink）：

| 配置组 | dev 源 | 用途 | case 依赖 |
|---|---|---|---|
| `web_search` | `~/.rocky_agent_dev/app_config/web_search` | zhipu 真实 key（web_search 工具）| 多 case 用 web_search |
| `see_image` | `~/.rocky_agent_dev/app_config/see_image` | minimax_m3 真实 key（image 理解）| `si1_minimax_multi_image` 硬前置 |
| `runtime` | `~/.rocky_agent_dev/app_config/runtime` | langfuse 本地配置 | oracle step（可选）|
| `web` | `~/.rocky_agent_dev/app_config/web` | jina 真实 key（web_fetch）| web_fetch 涉及 case |
| `consolidation` | `~/.rocky_agent_dev/app_config/consolidation` | glm-5.2 daily 04:00 配置 | `t2_daily_consolidation` |

**幂等范式**：`[ -d SRC ] && [ ! -e DEST ] && cp -rL SRC DEST`（test env 拥有自己拷贝；dev 不存在则回退 symlink test pool）；`-L` 解引用 dev 内部的 symlink，copy 实际 JSON 文件内容。

**不 copy 的**：
- `providers`：case 硬编码 test pool ULID（如 `01KVJMPG2EZ1078MCT9JH4J5HG`），dev 的 provider 实例 ID 不同（`01KVJMPG2FA9ZSWDND60HV56N2` 等），换源会让所有 case 找不到 provider → 仅 symlink test pool
- `default_models`：dev = deepseek-v4-pro；test 保 minimax（用户要 minimax 优先，与 dev deepseek 冲突）

**post-boot seed（保留）**：contextWindow=300000（对齐 dev 环境值，消除 compact 双触发）。

**已删除的 seed（v0.0.190 删）**：原 `POST /config/app group=see_image` seed 段（copy dev see_image config 已替代，含真实 minimax key）。

## 4.2 5 分类聚合（v0.0.190 调整）

| 分类 | 含义 | 是否翻 overall |
|---|---|---|
| `pass` | 所有 step check 全过 | 否 |
| `fail` | step check 失败 / StepFailError / load_error | 是 |
| `timeout` | case.yaml timeout 超出 | 是 |
| `not_run` | setup fail / budget_exhausted / load_error | 否 |
| `skipped` | RateLimitedError（429/529/503）| 否 |

**聚合 schema**（`run_all_result.json`）：
```json
{
  "version": "v0.0.190", "overall": "pass",
  "total_count": 5, "pass_count": 3, "fail_count": 0, "timeout_count": 0,
  "not_run_count": 0, "skipped_count": 2,
  "wall_time_seconds": 45.2, "budget_hit": false,
  "cases": [
    {"case": "...", "module": "...", "result": "skipped", "skip_reason": "429", "detail": "...", "elapsed_ms": 1200},
    ...
  ]
}
```

## 4.3 端口跨会话隔离（v0.0.215 新增 — AT/ET 共用）

**背景（为什么需要）**：旧端口段 AT API 3700-3799 / WEB 8787-8887 与 ET API 3800-3899 / WEB 8900-8999 是**固定段**——多 worktree 并发跑 AT/ET 时共享同一 `.env_port` 注册表，`env_shutdown` / `env.sh stop` 清残留用 `lsof -ti:$port | xargs kill` 裸杀端口上所有 listener。跨会话互杀由此产生：A 会话 env_shutdown 把 B 会话正在跑的 3800 server 当孤儿 SIGTERM（v0.0.215 实证：v0.0.217 另一会话起停 dev env 清残留误杀我 3700 server，全程与代码无关）。

**方案（v0.0.215 用户裁决立即修）**：版本号编码端口基址 + 全局注册表跨会话确权 + 清残留只杀自己注册的 pid。

### 4.3.1 端口布局（独立千段，杜绝跨版本跨 kind 重叠）

| 段 | 用途 | 基址公式（suffix = 小版本号后三位） |
|---|---|---|
| AT API 42xxx | AT server 监听 | `42000 + suffix`（如 v0.0.215 → 42215） |
| ET API 43xxx | ET server 监听 | `43000 + suffix`（如 v0.0.215 → 43215） |
| AT WEB 44xxx | AT web dev 监听 | `44000 + suffix` |
| ET WEB 45xxx | ET web dev 监听 | `45000 + suffix` |
| ET CDP 46xxx | ET electron 外壳（仅 electron 模式分配） | `46000 + suffix` |

**为什么独立千段（非「43xxx 内偏移」）**：suffix 可达 999，43xxx 段只够 API 容纳；若 WEB/CDP 在同段内偏移会与 AT WEB 44000+suffix 边缘重叠（v0.0.999 ET CDP=43999 撞 v0.0.999 AT API=42999 邻段；更糟是跨 kind 撞 v0.0.099 的 43099 段）。独立千段彻底切断跨版本跨 kind 重叠窗口。

**suffix 来源（worktree 目录名优先，非 package.json）**：`tests/lib/port_alloc.sh _port_suffix()` 从 worktree 目录名 `v0.0.NNN-...` 抽 `NNN`；package.json 此刻仍滞后（close-out 才 bump 到当前版本），worktree 名才是会话版本真相。与 `tests/api/lib/run_all.sh:74` 已有先例一致（VERSION 优先 worktree 名）。

**容错窗口**：基址被偶发占用时回退 `+0 ~ +19`（20 个 slot 兜底；实测并发占用罕见）。

### 4.3.2 全局注册表（跨会话确权）

`~/.rocky_agent_test/_registry/<port>.json`（每端口一份 JSON，分配时写入 + 关闭时清理）：

```json
{
  "port": 42215,
  "pid": 49518,
  "kind": "at",
  "version": "v0.0.215",
  "worktree": "/Users/.../worktrees/v0.0.215-head-manage-student",
  "allocatedAt": "2026-07-29T18:20:14Z"
}
```

- **分配写入**：`port_alloc.sh _port_at_*_base` / `_port_et_*_base` 找到空 slot 后写注册表。
- **关闭清理**：`env_shutdown.sh` / `env.sh stop` 成功 kill 自己 pid 后删 JSON。
- **pid-death stale cleanup**：若 server 进程已死但 JSON 残留（kill -9 / OS 重启），下次分配前检测 pid 不存活 → 视为 stale，覆盖分配。

### 4.3.3 清残留只杀自己注册 pid（禁裸杀端口）

`env_shutdown.sh` / `env.sh stop` 的「清端口孤儿」逻辑（v0.0.215 重写为 `tests/lib/port_alloc.sh _port_kill_tree`）：

1. 读注册表拿自己 pid（kind+version+worktree 匹配）。
2. 杀 pid + descendants（`pgrep -P` 递归）。
3. **cmdline marker 验证**：`cat /proc/$pid/cmdline`（macOS 用 `ps -o command=`）含本 worktree 路径或 server 启动 marker（如 `index.ts`）才杀——防 pid 被 OS reuse 成无关进程时误杀。
4. 删注册表 JSON。

**禁裸杀**：`lsof -ti:$port | xargs kill` 一律删除——它无法区分「我注册的 server」vs「兄弟 worktree 同段偶发占用的 server」（v0.0.215 跨会话互杀事故的根因）。

### 4.3.4 dev / prod 完全不动

本机制只作用于 `NODE_ENV=test` 的 AT env_start/env_shutdown + ET env.sh。dev server / packaged app 的端口分配（用户态 `~/.rocky_agent_dev/`）完全不变。

> **实现**：`tests/lib/port_alloc.sh`（220 行，含 `_port_suffix` / `_port_at_*_base` / `_port_et_*_base` / `_port_kill_tree` / `_port_registry_*`）/ `tests/api/env_start.sh` + `env_shutdown.sh`（AT 侧接线）/ `tests/e2e/env.sh`（ET 侧接线 + 自带 `_kill_port_orphans` cmdline 验证）。

## 5. 历史背景（v0.0.120 ~ v0.0.189 的 record/replay 机制，于 v0.0.190 删除）

**为什么删**：v0.0.131 实证——team 工具加 4 个 action 引发 28+ case 重录排查一整天，全量 case 库在全局性变更（工具 schema / prompt / UI）下维护成本不可持续。v0.0.188 ET 已先行改 agent 真实跑范式（删 record/replay 框架），v0.0.190 AT 同向重构。

**删除内容**：
- `app/server/src/testing/` 整目录（13 个 .ts 源 + __tests__/）：RecordReplayRegistry / RecordingFetch / ReplayFetch / RecordingCodec / GoldenRecorder / http-route-interceptor / sse-interceptor / stub-handler / test-llm-mode-handler 等
- 产品文件里的 test-only 接线分支（见 §2「接线（已删除）」段）
- AT 框架脚本层：`stub_client.py` / `recordings_snapshot.py` / `frame_checks_eval.py`（移至 `soft_deleted/v0.0.190/`）
- `run_case.py` 的 mode / snapshot / commit / drift / _eval_frame_checks_for_case 逻辑
- `_run_all_exec.py` 的 `_double_gate`（record→replay 双关编排）
- `case_loader.py` 的 `stub` + `frame_checks` 字段 + `_STUB_POINTS` 常量
- 11 个 `recordings/` 目录（manifest.json + llm.jsonl 等）
- `MODE=record|replay|live` 入口（run_all.sh / run_case.py main 参数）
- `frame_checks` 顶层字段（求值依赖 recordings/llm.jsonl，无录制则无法求值——变僵尸字段，删）
- `stub:` step 字段（记录声明的出站桩点，replay 没了便无意义，删）

**保留的产品侧 test-only 机制**（v0.0.190 不删）：
- `ROCKY_TEST_MOCK_LLM` mock 路径（computer_use case 依赖）
- `/test/consolidation/run` 端点（t2_daily_consolidation case 依赖）

## 6. 边界（零件唯一归属）

| 零件 | 归属 |
|---|---|
| case.yaml DSL schema + run_case/run_all 编排 + 429 skip + env reuse | 本 KB ✅ |
| `/test/consolidation/run` test-only 端点契约 | `specs/api/overall/04-agent-session.md` §13（本 KB 只述保留）|
| LlmClient.stream/call + ROCKY_TEST_MOCK_LLM 二分路径 | `../agent/providers_and_models/[P0]llm_client_interface.md` |
| web_search jina/zhipu provider 配置 | `../agent/tools/` |
| tests/ 脚本层逐 case 用法 + DSL 配方库 / 陷阱清单 | `tests/README.md` |
| legacy `createMockFetch` @@cu directive | `../mock-llm`（computer_use case 用，本框架不拥有）|

## 7. 已知债

- **429 检测谓词偏保守**：仅 status ∈ {429,503,529} + body error type 精确匹配。某些 provider 用非常规 status（如 400 + body 标 rate_limit）会被漏判为 fail，case 假红；反过来若把正常 fail 误标 rate_limit 会被误判 skip，case 假绿。当前谓词保守——宁可漏 skip 也不误 skip（假绿比假红危害大）。
- **dev config 内容 copy symlink 失效**：dev 配置目录结构变化（如 `app_config/<group>/app_config/<id>.json` 嵌套层级变）会让 copy 源路径不存在/损坏；server 启动期读不到内容只 warn 不 fail，case 跑时会因凭证缺失 fail。env_start.sh 只 warn，需人工检查 dev 目录结构。
- **providers 不 reuse dev**：req 的「providers 凭证 reuse」被识别为误判——cases 硬编码 test pool ULID，换源会让所有 case 找不到 provider。如未来要让 AT 用 dev providers，需同时改所有 case.yaml 的 providerId 字段（成本高，当前 KEEP test pool）。
- **langfuse oracle 可选**：env 未配置 LANGFUSE_* 时 oracle step 自动 skip（不算 fail），case 仍可继续；oracle 只是跨层证据增强，不是硬判定。
