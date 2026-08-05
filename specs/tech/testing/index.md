---
type: index
title: Testing 子系统总起（AT 真实调 API + ET agent 玩 app 范式）
priority: P1
status: active
updated: 2026-07-29
since: v0.0.120
---

# Testing 子系统总起（AT 真实调 API + ET agent 玩 app 范式）

## ① 是什么

testing 子系统管两套测试基建，**双轨分离**，v0.0.190 起统一「不录制不回放真调 LLM」范式：

- **AT（API Test）= 真实调 API 框架**（`tests/api/lib/`）：case.yaml 声明式 DSL（requests / run / poll / wait / oracle / save / check / sse.sub），每 case 真调 minimax 等 provider + 契约断言。429/529/503 → `skipped, reason=429`（不重试不阻塞）。dev config 内容 copy 到 test env（web_search / see_image / runtime / web / consolidation——test env self-contained 拥有自己的拷贝；providers 不 copy 用 test pool ULID；default_models 保 minimax）。**v0.0.190 删除 server 侧 record/replay 基建**（`app/server/src/testing/` 整目录）+ stub/frame_checks/MODE/drift/recordings 全去——维护成本不可持续（v0.0.131 实证：team 工具加 4 action 引发 28+ case 重录一整天）。
- **ET（E2E Test）= agent 玩 app 范式**（`tests/e2e/`，v0.0.188 重构）：agent 用 playwright-cli 真实操作 app，case = 纯自然语言（Use Case + 编号操作目标），executor 读 case.md + app-guide 玩，每步留证，自由心证 blocking/small/pass。**不录制不回放，真调 LLM**（minimax 优先）。**snapshot 增强**（v0.0.218 起）：`snapshot-with-keys.sh` 逐交互节点 eval 注入 `[action-key=X]`，让 executor 主信息源（snapshot.yml）可见 v0.0.211 铺的 `data-action-key`（playwright a11y snapshot 本身丢 data-*）。

> 本 KB 管 **AT 真实调 API 框架架构**（case.yaml DSL + run_case/run_all + 429 skip + dev config 内容 copy）+ **ET 框架架构**（env.sh / executor / case.md / 留证 / 判定）。tests/ 脚本层 + 逐 case 用法 = `tests/README.md`（双轨入口）。设计冻结见 `../../version_logs/v0.0.190/change_plan.md`。

| 核心概念 | 一句话 |
|---|---|
| **case.yaml DSL** | 声明式步骤序列（setup/steps/teardown 三段）；step = requests / run / poll / wait / oracle / files + sse.sub + save + check（原子谓词）|
| **prep 阶段** | case 自管环境准备（setup phase 建 session / seed 数据 / 配置依赖）→ steps（调 API + check）→ teardown 清理 |
| **dev config copy** | env_start.sh 把 dev 的 5 组技术配置（web_search/see_image/runtime/web/consolidation）用 `cp -rL` 拷到 test DATA_DIR（test env self-contained 拥有自己的拷贝，不依赖 dev 运行态）|
| **RateLimitedError** | 429/529/503 或 body error type ∈ {rate_limit, overloaded, rate_limit_error} → 抛 RateLimitedError → run_case 捕获 → result='skipped', reason='429' |
| **5 分类聚合** | pass / fail / timeout / not_run / skipped（v0.0.190 起 drift 删除、skipped 新增）；overall = pass iff fail==0 && timeout==0（skipped/not_run 不翻 overall）|
| **per-step 产物** | `last_run/steps/NN/{responses.json, events.jsonl, checks.json}` + `result.json`；fail 的 actual 自解释（键缺失列实际可用键 / events fail 列实际事件分布）|
| **端口跨会话隔离**（v0.0.215）| AT API 42xxx / ET API 43xxx / AT WEB 44xxx / ET WEB 45xxx / ET CDP 46xxx，基址 = `<千段> + suffix`（suffix = worktree 目录名小版本号后三位）；不同 worktree 天然不同段，跨会话不互杀 |
| **snapshot 增强**（v0.0.218）| `tests/e2e/snapshot-with-keys.sh`：snapshot 后逐交互节点 eval `dataset.actionKey` 注入 `[action-key=X]`，让 executor 主信息源（snapshot.yml）可见 `data-action-key`（a11y snapshot 本身丢 data-*）；session per-cwd 复用 + `--session=` 透传；定位优先 action-key 降级文案 name |

## ② 边界

| 管 | 不管（→ 别处） |
|---|---|
| AT case.yaml DSL schema + run_case/run_all 编排 + 429 skip + env reuse | LlmClient 组合/call/stream 契约（→ `../agent/providers_and_models/`）|
| AT requests/check/sse.sub/run/poll/wait/oracle/save 动作类语义 | protocol 解析/SSE/tool loop（→ `../agent/`）|
| AT env_start.sh copy dev 技术配置内容到 test DATA_DIR | dev 配置本体（→ `~/.rocky_agent_dev/app_config/`，仅启动期 copy 一次）|
| ET env.sh + run.sh + case.md schema + 留证规范 + 判定三态（→ `et-framework.md`） | executor agent 定义与工作流详参（→ `.claude/agents/e2e-test-executor.md` + `.claude/skills/playwright-cli/references/executor-workflow.md`）|
| ET 真调 LLM（不 stub，minimax 优先） | app-guide 导航底图（→ `specs/ui/overall/00-app-guide.md`）|

## ③ 与系统的关系

**AT（真实调 API 框架，`tests/api/lib/`）**：
```
run_all.sh ──► env_start.sh（dev config 内容 copy symlink + provider pool symlink + post-boot seed contextWindow）
            ──► _run_all_exec.py（串行 + 5 分类聚合：pass/fail/timeout/not_run/skipped）
                  └─► run_case.py（setup/steps/teardown + RateLimitedError 捕获 → skipped）
                        └─► step_exec.py（requests/run/poll/wait/oracle/files + 429 检测）
                              └─► 429/529/503 → raise RateLimitedError → run_case 标 skipped
            ──► env_shutdown.sh
```

**ET（agent 玩 app 范式，`tests/e2e/`）**：
```
orchestrator 委派 executor ──bash tests/e2e/env.sh start <cid>──► 起 server+web dev (+electron)
                                                                        │ 分配独立 DATA_DIR + 隔离端口
                                                                        ▼
   executor: playwright-cli open <web_url>（或 attach --cdp=<cdp_url>）
   executor: 读 case.md + app-guide §相关章节
   executor: 每步留证（screenshot+dom.html+snapshot.yml+meta.json）→ states/<ver>/verify/e2e/<cid>/steps/
   executor: 自由心证 blocking/small/pass → verdict.json
   executor: playwright-cli close
   orchestrator: bash tests/e2e/env.sh stop <cid>  → pidfile kill + 删 DATA_DIR
```

**对外协作点**：v0.0.190 AT 改真实调 API 契约见 `../../version_logs/v0.0.190/change_plan.md`；ET 重构契约见 `../../version_logs/v0.0.188/change_plan.md`。LlmClient fetchImpl 契约见 `../agent/providers_and_models/[P0]llm_client_interface.md`（v0.0.190 删除 test-only pickLlmFetch/recordReplayFetch 分支，保留 ROCKY_TEST_MOCK_LLM 二分路径）；ET 导航底图见 `specs/ui/overall/00-app-guide.md`；逐 case 用法 + 判定规则见 `tests/README.md`。

## ④ 核心设计原则（不变量）

**AT 真实调 API 框架**：
1. **case.yaml 声明式 DSL**——纯静态可读，无控制流；step 三段（setup/steps/teardown），原子 check 谓词 `any/all`，fail 的 actual 自解释。
2. **真调 LLM 不录制不回放**——每 case 真调 minimax 等 provider（ROCKY_TEST_MOCK_LLM=1 mock 路径仅 computer_use case 用）。
3. **case 自管环境**——setup phase 建 session / seed 数据 / 配置依赖，teardown phase 清理（files 原语写入的文件无论 pass/fail/skipped 必清理）。
4. **429 skip 不重试不阻塞**——RateLimitedError 抛到 run_case，case 标 `result='skipped', reason='429'`，聚合单列计数，overall 不翻（保守谓词：status ∈ {429,529,503} 或 body error type 精确匹配）。
5. **dev config 内容 copy**——5 组（web_search/see_image/runtime/web/consolidation）copy dev 真实凭证；providers 不 reuse（case 硬编码 test pool ULID）；default_models 保 minimax（不 reuse dev deepseek）。
6. **5 分类聚合 + per-step 产物**——pass/fail/timeout/not_run/skipped；overall = pass iff fail==0 && timeout==0；per-step `last_run/steps/NN/{responses,events,checks}.json` 供诊断。
7. **端口跨会话隔离**（v0.0.215）——版本号编码基址（AT 42xxx / ET 43xxx / WEB 44xxx-45xxx / CDP 46xxx，suffix = worktree 目录名小版本号后三位）+ 全局注册表 `~/.rocky_agent_test/_registry/` 跨会话确权 + 清残留只杀自己注册 pid（cmdline marker 验证，禁 `lsof|xargs kill` 裸杀——旧固定段多 worktree 共用注册表会跨会话互杀）。详见 `at-framework.md §4.3`。

**ET agent 玩 app 范式**：
1. **case = 纯自然语言**——Use Case + 编号操作目标；零断言零录制零选择器预定义（executor 按 snapshot 文案/位置自选定位方式）。
2. **真调 LLM 不 stub**——每 case 真调 minimax 等 provider，不录制不回放（req 决策：避免 record/replay 维护成本）。
3. **每 case 独立 DATA_DIR**——`~/.rocky_agent_et_<case_id>`，stop 时一次性删除，不跨 case 复用。
4. **每步留证四件套**——screenshot + dom.html + snapshot.yml + meta.json，缺一不可（供人诊断）。
5. **executor 不看截图**——snapshot.yml 是主信息源（守 CLAUDE.md 禁截图）；screenshot.png 只是留证。
6. **判定三态自由心证**——pass / small / blocking；不再有 dom_asserts / hard_fail / conflict / recording_drift 等机械分类。
7. **snapshot 增强 action-key 优先定位**（v0.0.218）—— `snapshot-with-keys.sh` 逐交互节点 eval 注入 `[action-key=X]` 让 executor 可见 v0.0.211 铺的 `data-action-key`；定位优先 action-key（机器稳定）降级文案 name（未铺节点兜底）。session per-cwd 复用 + `--session=` 透传。

## ⑤ 本目录导航

| 文件 | 管什么（一句话） |
|---|---|
| [at-framework.md](at-framework.md) | **AT 真实调 API 框架**（v0.0.190 重写，原名 record-replay.md）：case.yaml DSL schema + run_case/run_all 编排 + 429 skip 机制 + dev config 内容 copy + 5 分类聚合 + per-step 产物 + 历史债记录（旧 record/replay 机制于 v0.0.190 删除）|
| [et-framework.md](et-framework.md) | **ET 范式（v0.0.188 重构）**：agent 玩 app 框架——env.sh + run.sh + executor agent + case.md（纯自然语言）+ 每步留证四件套 + 自由心证三态（blocking/small/pass）；不录制不回放真调 LLM；Playground 基线 5 case |

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`../version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
