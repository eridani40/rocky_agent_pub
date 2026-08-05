---
type: log
title: Testing KB 变更记录
updated: 2026-07-29
---

# Testing KB — 变更日志（ISO 倒序）

## 2026-07-29 — v0.0.218 · snapshot 增强（action-key 暴露：eval 注入 [action-key=X] 让 executor 可见）

v0.0.211 铺的 `data-action-key`（DOM 157 处）住 DOM 但 playwright snapshot = a11y tree 丢 data-*，executor 主信息源 snapshot.yml 看不到 → 对 ET 是死代码。a11y 口子（aria-label→name / title→tooltip）承载机器标识会污染无障碍，搭不了便车。**方案 = eval 增强**（不改二进制不污染 a11y）。doc-modifier 阶段 5 同步本 KB：

- **`et-framework.md §2 新增组件**：`snapshot-with-keys.sh`（tests/e2e/）—— snapshot 增强（v0.0.218 起）：逐交互节点 eval `dataset.actionKey` 注入 `[action-key=X]`，让 executor 主信息源可见 action-key。
- **`et-framework.md §5.1 新增**「snapshot 增强（action-key 注入，v0.0.218 起）」：①为什么需要（a11y snapshot 丢 data-* + a11y 口子承载机器标识污染无障碍 → eval 增强方案）②机制（snapshot-with-keys.sh：存盘 → 正则提 `[ref=e<N>]` → 仅交互节点 eval `dataset.actionKey \|\| ''` → 三层校验防 `--raw eval` 错误时 exit=0+stdout 污染：单行 + JSON 字符串字面量 + action-key 命名规范 → 注入 `[action-key=X]`）③session 复用（per-cwd 机制 spike 实测确认：脚本继承 executor cwd 自然复用 + 命名 session `--session=` 透传）④executor 约定（snapshot 双层：a11y 基线 + action-key 增强；留证推荐增强版；定位优先级 action-key > ref > 文案 name 降级）。
- **`et-framework.md §5 executor 铁律 + §11 边界对齐`**：铁律加「增强 snapshot 可见 action-key 时优先按 action-key 锁定元素」；§11 边界表加 snapshot-with-keys.sh 归属行 + action-key 命名规范归属行（→ `specs/ui/components/_conventions.md §12`）。
- **`index.md` 对齐**：①是什么 ET 段加 snapshot 增强一句；概念表加「snapshot 增强（v0.0.218）」一条；④设计原则 ET 加第 7 条「snapshot 增强 action-key 优先定位」。

> 详细变更见 `../version_logs/v0.0.218/change_log.md`（交付 + 4 偏离 + 验证结论）。实现：`tests/e2e/snapshot-with-keys.sh`（142 行）+ `.claude/skills/playwright-cli/references/executor-workflow.md §3/§6`（coder T1 改）+ skill 版本对齐（install --skills）。spike 实测 9 交互节点全注入正确（~9s）。**4 偏离全实现细节增强未触核心约束**（garbage 三层校验 / bash while-read 末行坑 / 恢复 install --skills 误删的 SKILL.md `app-e2e-real-run.md` 索引行 / §3 扩展 snapshot 双层概念 + 定位优先级表）。

## 2026-07-29 — v0.0.215 · 端口跨会话隔离（版本号编码基址 + 全局注册表 + 只杀自己 pid）

多 worktree 并发跑 AT/ET 互杀 server（v0.0.215 实证：v0.0.217 另一会话清残留 `lsof -ti:$port | xargs kill` 误杀我 3700 server）。doc-modifier 阶段 5 同步本 KB：

- **`at-framework.md §4.3 新增`**（v0.0.215 端口跨会话隔离）：版本号编码基址（AT API 42xxx / ET API 43xxx / AT WEB 44xxx / ET WEB 45xxx / ET CDP 46xxx；suffix = worktree 目录名小版本号后三位，如 v0.0.215 → 42215/43215）+ 独立千段（非「43xxx 内偏移」——suffix 可达 999 会撞 AT WEB 边缘）+ 全局注册表 `~/.rocky_agent_test/_registry/<port>.json`（pid+worktree+version 跨会话确权，分配写/关清/pid-death stale cleanup）+ 清残留只杀自己注册 pid（`_port_kill_tree` cmdline marker 验证，禁 `lsof -ti:$port|xargs kill` 裸杀）+ suffix 来源（worktree 目录名优先，非 package.json——后者 close-out 才 bump）+ dev/prod 不动。
- **`et-framework.md §4.3/§4.4 对齐`**：ET 端口段表从旧固定段（API 3800-3899 / WEB 8900-8999 / CDP 9222-9299）改为版本编码千段（43xxx/45xxx/46xxx），引用 at-framework §4.3 详情；§4.4 进程管理「start 前 lsof 清孤儿」改为「`_kill_port_orphans` cmdline marker 验证」。
- **`index.md` 概念表/原则对齐**：加「端口跨会话隔离」核心概念一条 + ④核心设计原则 AT/ET 共加一条「端口版本编码隔离」。

> 详细变更见 `../version_logs/v0.0.215/change_plan.md` 的「AT/ET 端口跨会话隔离」增补任务段。实现：`tests/lib/port_alloc.sh`（220 行重写）+ `tests/api/env_start.sh` + `env_shutdown.sh` + `tests/e2e/env.sh`。dev/prod 完全不动。macOS bash 3.2 非 UTF-8 locale 下 CJK 全角括号紧贴 `$var` 触发 unbound variable 的 gotcha 已落 memory。

## 2026-07-26 — v0.0.197 · testid 已废弃，ET 定位策略切 snapshot/文案/位置

用户裁决：testid 已废弃（全链路：代码 data-testid 已删、specs/ui/components/ 已无 testid section）。doc-modifier 同步本 KB + 生态文档：

- **`et-framework.md`**：删所有「testid 从 specs/ui/components/ 契约读」描述（testid 已废弃）；定位策略改为 **snapshot（role + 可见文案 + ref）为主，getByText/getByRole 优先，ref 编号辅助**；文案来源 = 组件 spec「状态 / 交互」中的可见文案描述；blocking 例子改「关键元素找不到」；snapshot 结构描述改为 ref / role / text。
- **`index.md`**：④设计原则 ET 第 1 条对齐（零选择器预定义，executor 按 snapshot 文案/位置自选定位方式）。
- **生态文档同步**（非本 KB，但同批改；testid 已废弃）：`tests/e2e/*/case.md`（6 case 删 testid 软提示，改文案/位置描述）；`.claude/skills/playwright-cli/`（SKILL.md + references/ 下 executor-workflow / app-e2e-real-run / element-attributes / test-generation，getByTestId 示例全改 getByText/getByRole）；`.claude/agents/e2e-test-executor.md` + `.qoder/agents/e2e-test-{executor,designer}.md`（删 testid 职责描述）。

## 2026-07-22 — v0.0.190 · AT 改真实调 API（删 record/replay stub 全基建 + 429 skip + dev config copy 到 test env）

AT 从「record/replay 双关验收 + drift + golden + http/sse 入站通道 + stub audit」整体改为 **真实调 API + 契约断言** 范式，对齐 ET v0.0.188。doc-modifier 阶段 5 同步本 KB：

- **文件改名 `record-replay.md` → `at-framework.md`**（doc-modifier 阶段 5 执行）：旧名描述已删除的机制，误导导航；新名与 `et-framework.md` 平行。引用同步：`index.md` ⑤导航 + `et-framework.md` frontmatter/§头注/§6 边界表 + 本文件历史条目里的 `record-replay.md §X` 引用保持原样（历史叙述，指向当时版本的内容）。
- **`at-framework.md` 大幅重写**：标题从「LLM record/replay 基建」改为「AT 真实调 API 框架」；§2 组件模型改为新组件（case_loader / run_case / _run_all_exec / run_all.sh / step_exec / RateLimitedError / case.yaml / env_start.sh / artifacts）；§3 case.yaml DSL schema（去 stub + frame_checks）；§4 429 skip 机制（保守谓词：status ∈ {429,503,529} 或 body error.type 精确匹配）；§4.1 dev config 5 组技术配置 copy（web_search/see_image/runtime/web/consolidation，`cp -rL` 解引用 symlink → test DATA_DIR self-contained）+ 不 copy 列表（providers / default_models）；§4.2 5 分类聚合（pass/fail/timeout/not_run/skipped，drift 删除）；§5 历史背景（record/replay 机制 v0.0.120 ~ v0.0.189，于 v0.0.190 删除）。
- **`index.md` AT 部分对齐新范式**：①是什么 改双轨（AT 真实调 + ET agent 玩 app）+ 核心概念表去 RecordReplayRegistry/RecordingFetch/ReplayFetch/RecordingCodec/GoldenRecorder/recording_drift，加 case.yaml DSL / prep 阶段 / dev config copy / RateLimitedError / 5 分类聚合 / per-step 产物；②边界 AT 改新条目；③与系统的关系 ASCII 图改新流程；④核心设计原则 AT 6 条不变量改写（真实调 LLM + case 自管环境 + 429 skip 不重试 + dev config copy + 5 分类聚合）。
- **删除**（移至 `soft_deleted/v0.0.190/`）：`tests/api/lib/{stub_client.py, recordings_snapshot.py, frame_checks_eval.py}` + 11 个 `recordings/` 目录。**产品代码（server 侧）由 T1 清理**：`app/server/src/testing/` 整目录 + 7 个产品文件的 test-only 接线分支（router/bootstrap-bus-phase/llm-client-factory/jina-fetcher/misc-routes/sse-channel/event-bus）。
- **case.yaml 清理**：12 个 case.yaml 删 `stub:` 行（共 30 行）+ 2 个 case.yaml（coach-chat + compact_model_directive）删 `frame_checks:` 块。
- **env_start.sh 调整（v0.0.190 用户裁决：test env 优先，self-contained）**：加 5 组 dev config `cp -rL` copy 段（web_search/see_image/runtime/web/consolidation → test DATA_DIR/app_config，幂等 `[ ! -e DEST ]`）+ 删 see_image POST /config/app seed 段（copy dev see_image config 已替代，含真实 minimax key）+ 保留 provider pool symlink（test pool）+ contextWindow seed + ROCKY_TEST_MOCK_LLM 默认值。**用户纠正点**：原 architect 建议「symlink dev 配置」被用户驳回——test env 应 self-contained，不依赖 dev 运行态；dev 仅作配置内容源（启动期 copy 一次）。
- **保留的产品侧 test-only 机制**：`ROCKY_TEST_MOCK_LLM` mock 路径（computer_use case 依赖）+ `/test/consolidation-run` 端点（t2_daily_consolidation case 依赖）。

> 详细变更见 `../version_logs/v0.0.190/change_plan.md`（method 级 8 列契约）+ `reqs/[working] v0.0.190.at-replay-remove/req.md`（方案 + 决策记录）。**用户裁决纠正**（2026-07-22，覆盖 req.md / change_plan §E / context.md §决策点 3 的「dev config 内容 copy symlink」表述）：改用 copy 不 symlink，且**严禁碰 dev 业务数据**（仅 cp `~/.rocky_agent_dev/app_config/<group>` 5 组配置，不 cp dev DATA_DIR 根的 sessions/messages/squad/memory 等）。

## 2026-07-22 — v0.0.188 · ET 重构为 agent 玩 app 范式（删旧 case.yaml DSL 框架）

ET 框架从「声明式断言脚本」（case.yaml DSL + record/replay + run_all + compares[] + designer 设计 / executor 执行两段）重构为 **「agent 用 playwright-cli 真实玩 app」范式**，doc-modifier 阶段 5 同步本 KB：

- **`et-framework.md` 整篇重写**：新组件模型（env.sh / run.sh / vision_check.py 工具 / case.md 纯自然语言 / executor agent + 详参 + app-guide）+ case.md schema（Use Case + 编号操作目标 + 验收口径，零断言零录制）+ 双模式 env（headless / electron）+ 每 case 独立 DATA_DIR（`~/.rocky_agent_et_<cid>`，stop 清理）+ 端口段隔离（ET 3800-3899 / 8900-8999 / 9222-9299，与 AT 3700-3799 / 8787-8887 隔离）+ 留证规范（4 件套 screenshot+dom.html+snapshot.yml+meta.json）+ 判定三态自由心证（pass/small/blocking，不再有 dom_asserts/hard_fail/conflict/recording_drift）+ 不看截图原则（snapshot.yml 是主信息源）+ Playground 基线 5 case（send-message 样例模板 + tool-call / multi-turn / session-switch / model-switch）。
- **`index.md` ET 部分对齐新范式**：①是什么 改为双轨（AT record/replay + ET agent 玩 app）+ ②边界 加 ET env.sh/run.sh/case.md/留证/判定三态 + executor agent 定义与 app-guide 归「别处」+ ③与系统的关系 拆 AT/ET 两 ASCII 图 + ④核心设计原则 加 ET 6 条不变量 + ⑤本目录导航 et-framework.md 改描述为新范式。
- **删除 / soft-delete**（不在本 KB 范围，但影响相邻）：`.claude/agents/e2e-test-designer.md` → `soft_deleted/v0.0.188/agents/`（新范式无 designer 角色）；`tests/e2e/{env_start.sh,env_shutdown.sh,lib/*}` + 所有 `<module>/<case>/` → `soft_deleted/v0.0.188/tests_e2e/`（旧框架全删）；`tests/lib/{new_case.sh,gen_case_md.sh}` → `soft_deleted/v0.0.188/tests_lib/`（绑 checkpoint 旧格式无消费者）；`tests/run_all.sh` → `soft_deleted/v0.0.188/`（顶层 wrapper，AT/ET 范式分离后无合并 wrapper 需求）；`.claude/skills/e2e-testing-vision/` 整 skill → `soft_deleted/v0.0.188/skills/`（旧 compares 框架教学，新范式 vision_check 工具用法已在 `playwright-cli/references/executor-workflow.md` 覆盖）。
- **AT 完全不动**：`record-replay.md` + `tests/api/` 全部保留，标技术债「AT 重构待议」另版治本。
- **代码-spec 一致核实（doc-modifier 阶段 5）**：`tests/e2e/env.sh` start/stop/case-data-dir 三子命令 + `tests/e2e/run.sh` list + run_one_case + `tests/e2e/vision_check.py` 两 CLI 签名（单图 + compare）+ 5 个 `tests/e2e/playground-*/case.md` 纯自然语言（无断言无录制）+ `.claude/agents/e2e-test-executor.md` 270 行 agent 定义（铁律 + 上手手册 + 留证规范 + 判定三态）+ `.claude/skills/playwright-cli/references/executor-workflow.md` 详参 + CLAUDE.md ET 10+ 章节对齐 = 全部一致。**一处补漏**：`et-framework.md §4.2` 原只写「symlink 全局 provider pool」，实际 env.sh start symlink 三件（`providers/` + `web_search/` + `default_models/`）—— `default_models` 符链由 T1 coder 补（验证发现模型 picker 缺它显示「未配置」），spec §4.2 已扩写三件对齐代码。

> 详细变更见 `../version_logs/v0.0.188/change_plan.md`（method 级 8 列契约）+ `reqs/[working] v0.0.188.et-playwright-agent/req.md`（方案 + 决策记录）。tests/ 脚本层入口见 `tests/README.md`。

## 2026-07-15 — v0.0.151.t2_consolidate · http-route-interceptor replay 短路门控修复（BUG-001）+ baseline_model_drift 聚合层误翻 fail 阻断落盘（backlog）

AT case `consolidation/t2_daily_consolidation` 的 record→replay 双关暴露 http 入站通道短路门控缺陷，doc-modifier 阶段 5 同步本 KB：

- **`record-replay.md §7.3` 订正**（BUG-001，归因 B = AT 框架问题非产品 bug）：replay 模式短路门控从「有 activeCase + replay 模式 + 命中录制」一律短路改为「**仅当 `active.caseDeclared?.includes('http')` 才短路**」。背景：ET case 惯例顶层 `stub:[...,http,...]` 声明被动浏览器流量整案豁免（`stub_client.set_case` 透传 caseDeclared），AT case.yaml 的 `stub:` 词汇官方文档只列 `llm`/`web_fetch`，`case_declared` 恒 `undefined`。修复前 AT case 自身的 `requests` 步骤（如 `PUT /config/app`）也被静默伪造：响应是录制的 `{"ok":true}` canned，从未真调 `handleKvConfigPut` 写盘；若后续 `/test/*` 测试专用端点（显式排除拦截、始终跑真实业务逻辑）依赖这次写入的真实副作用，就会读到陈旧状态（本 case replay 轮 `model_not_configured` 假失败根因）。代码 `http-route-interceptor.ts:160-161`（`if (!active.caseDeclared?.includes('http')) return null`）；UT `stub-http.test.ts` 29/29 绿（更新 2 例反映 ET 惯例显式声明 + 新增 2 例 AT 惯例透传）。详见 `states/v0.0.151.t2_consolidate/bugs/BUG-001-...-[fixed].md`。
- **`record-replay.md §6` 新增 backlog 项**（baseline_model_drift advisory 被聚合层误翻 fail）：case 用 glm-5.2（MiniMax 配额耗尽切 fallback）vs test 默认 `TEST_MODEL_ID`=MiniMax-M3，`registry.checkBaselineModelDrift()` 必然推一条 `baseline_model_drift` advisory 事件（manifest.model ≠ TEST_MODEL_ID），**advisory 设计上"不算 fail"**（`types.ts:240-250` 注释明示）。但 `run_all` 的 double_gate 聚合层把任何 drift 事件硬翻 fail、阻断 recordings 落盘——这是聚合层违背 advisory 语义的框架债（非产品 bug，非 case 错误），用户裁决记 backlog 不本版本修。case 暂无离线 recordings 落盘（功能正确性已通过 record 轮真 LLM 整理 + replay 轮修 BUG-001 后双绿充分验证），后续回归走 record/live 模式。
- **代码-spec 一致核实（doc-modifier 阶段 5）**：`http-route-interceptor.ts:160` 门控分支 + `types.ts:205` `caseDeclared` 字段定义 + `record-replay-registry.ts:124-137` baseline_model_drift 推送逻辑 + `types.ts:240-263` DriftEvent schema 均与本 KB 描述一致。

## 2026-07-14 — v0.0.141.see_img · record→replay 双关同进程状态泄漏两修 + tests/ 脚本层配套

see_image AT case si1 的 record 双关暴露两处「上一轮真实运行产物混进下一轮回放」的框架 bug，doc-modifier 阶段 5 同步本 KB：

- **`record-replay.md §9` 新增**（v0.0.141 运行时基建两修，`app/server/src/{agent,sse,testing}/`）：
  - **§9.1 skipReplayHistory gate**：`EventBus.subscribe(group, {skipReplayHistory?})` 新增开关，`true` 跳过 `ReplayableEventBus` 的 sticky slot + content buffer 历史灌入；链路 `SseChannel.subscribe()`→`EventHub.sub()`→`bus.subscribe()` 纯转发，判断权归 `sse-interceptor.ts` 的 `shouldSkipHubReplay: () => getActiveCase()?.mode==='replay'` hook。**生产零回归**：`NODE_ENV!=='test'` → testInterceptor 恒 null → skipReplayHistory 恒 false（字面等价旧代码），仅 test+replay 双条件激活。修 replay 轮同 sid 复用致陈旧 run_start/run_end 瞬时回放、`wait until run_end` 假满足（elapsed 0ms）判负。
  - **§9.2 setActiveCase 清 sseRecorders**：case-start 边界 `if (this.sseRecorders) this.sseRecorders.clear()`（只清内容不置 null——保闭包长期 Map 引用）。修 FAIL（未 commit）case 的残留 recorder 被下个 PASS case 的 finalize 无差别遍历混进 `sse.jsonl`（实测混入 40 帧）。
  - **§9.3 tests/ 脚本层配套索引**：files 原语 `encoding: base64`（`files_action.py`/`files_validator.py` 二进制 fixture 写盘）+ env_start see_image 凭证预置（`env_start.sh §12` post-boot seed）——权威在 `tests/README.md`。
- **代码-spec 一致核实（doc-modifier 阶段 5）**：`event-bus.ts:148` `if (this.replayable && !opts?.skipReplayHistory)` + `sse-channel.ts:252` `shouldSkipHubReplay?.() ?? false` + `sse-interceptor.ts:287` hook 装配 + `record-replay-registry.ts:106` `sseRecorders.clear()` 与 §9 描述逐项一致，无偏离。

> 详细变更见 `../version_logs/v0.0.141.see_img/change_log.md`（若有）+ `states/v0.0.141/context.md` findings（debugger 归因 + coder-框架 修复）。tests/ 脚本层权威 `tests/README.md`。

## 2026-07-13 — v0.0.127 · ET 框架重构完成 + Phase 1 易用性优化 + count 缺勤修复

ET 框架从旧框架（checkpoint.json + runner.py + /test/llm-mode）重构为对齐 AT 的新模型（case.yaml DSL + record/replay 双关 + per-step 产物 + selftest），doc-modifier 阶段 5 同步本 KB：

- **`et-framework.md` 新增**（本目录另一文件）：ET 框架组件模型（CaseLoader/StepExec/CheckEngineEtExt/SseAutowait/VisionAction/EtValidators/RunCase/RunAll/Selftest）+ ET case.yaml schema（顶层 + ET step 字段 + dom 断言语法 + G1-G6 schema gap 裁决）+ 与 AT 共用 lib 导入机制 + Playwright 启动 + window.api 注入 + record/replay 双关 + per-step 产物 + selftest + case 迁移映射。
- **`record-replay.md §7` 新增 http/sse 入站通道**（v0.0.127 扩展，ET 专属）：五通道架构（llm/web_search/web_fetch 出站 + http/sse 入站）+ http-route-interceptor.ts（入站 HTTP 拦截，匹配键 api_normalized+seq）+ sse-interceptor.ts（fan-out 模型，topic+group 匹配键）+ 数据格式（http.jsonl/sse.jsonl）+ audit 语义 + 兼容性（加性扩展不破坏 AT）。
- **`et-framework.md §3.4-§3.6` 新增 Phase 1 易用性优化**（v0.0.127 重构完成时落地）：
  - **dom check auto-wait**（`eval_dom_check(timeout_ms=5000)`）：正向 op 先 `wait_for(state='attached')`，反向 op 立即快照。
  - **count 缺勤分类**（`_is_negative_dom_count(op, rhs)`，mirror SSE 侧）：count==0/count_lt/count_le → negative 立即；count_eq rhs>=1/count_ge/count_gt → positive wait。修复回归（count==0 误判 positive 等缺勤元素 timeout）。
  - **SSE check auto-wait**（`sse_autowait.eval_check_with_sse_autowait`，复用 `sse_collector.wait_for_condition`）：正向轮询/反向立即。
  - **后代选择器**（`expand_testid`）：`testid:X input` → `[data-testid="X"] input`。
  - **interp js_eval 豁免**（`_do_js_eval = page.evaluate(code, ctx)`，JS 侧 `(ctx)=>{...ctx.var...}`）：`_check_interp_refs` 排除 js_eval code 不扫 {var}。
  - **check_events 深度遍历**（`_deep_find`，BUG-002 修复）：解 event.data.data.X 嵌套，AT/ET 共用向后兼容。
  - **文件拆分**：sse_autowait.py / vision_action.py / et_validators.py（step_exec 367→287 / case_loader 312→156）。
- **`record-replay.md §7.9` 新增动态 marker 陷阱**：URL/path 含 Date.now()/随机 → replay stub 不命中（normalized URL 不归一化 path 参数动态部分）→ 透传真 handler → 行为偏移（deleted=0/404）。规避：用固定 name/URL（前缀+序号）。
- **代码-spec 一致核实（doc-modifier 阶段 5）**：逐项对齐实现——`eval_dom_check` line 138-204 auto-wait + `_is_negative_dom_count` line 121-135 与 spec 一致；`sse_autowait.eval_check_with_sse_autowait` line 16-50 + `is_negative_sse_assertion` line 53-69 一致；`step_exec._do_js_eval` line 260-269 page.evaluate(code,ctx) 一致；`check_events._deep_find` line 62-78 + match_event line 81-98 深度遍历后备一致；`et_validators._check_interp_refs` line 168-182 js_eval 豁免一致；`expand_testid` line 89-110 后代选择器一致。无偏离。

## 2026-07-13 — v0.0.125.test_refactor.1 · record-replay.md request_meta 扩展 + backlog 识别

AT 全面重构（`tests/api` 全新 DSL + record/replay 双关）收官，doc-modifier 阶段 5 同步本 KB：

- **`record-replay.md §4.1` 新增 `request_meta` 派生指纹段**：`roles[]`（角色名序列，验证 wire 无 role=tool 等）+ `tool_names[]`（工具名列表，验证 forked 零工具 等）由 `recording-fetch.ts::extractRequestMeta(init)` 从 messages/tools 派生；**非敏感元信息**——只有名字不存 schema/正文。新增安全约束明示：不存 messages 正文 / 不存 tool input_schema / 不存 credentials（与 redact 同列硬约束）。示例 JSON 同步含 `roles`/`tool_names`。
- **`record-replay.md §6` 已知债新增两条**（v0.0.125 识别，非修复只记录）：
  - **POST /session/:id/run wrapper 缺 auto-naming hook**：naming hook 只挂 `/messages` 生产路径；测 naming 类功能须走 `/messages`（产品 backlog：考虑给 wrapper 挂 hook 但有保真权衡）。
  - **budget gate 受 boot.ts budget cache 30s 异步刷新制约**：黑盒测试无法稳定测 budget gate → 转 UT；产品 backlog：PATCH budget 应 invalidate cache。
- **代码-spec 一致核实（doc-modifier 阶段 5）**：`extractRequestMeta` 实现 line 175-197 完全对齐 spec 描述；`roles`/`tool_names` 字段在录制里落 `request_meta`（无正文/schema 漂移）。

> 详细变更见 `../version_logs/v0.0.125.test_refactor.1/`（migration-plan / design / change_plan）。tests/ 新框架权威文档 `tests/README.md`。

## 2026-07-12 — v0.0.120 · testing KB 创建

新增 testing 子系统 KB，记录 LLM record/replay 基建（server 侧 `app/server/src/testing/`）：

- **index.md**：5 章总起 + 概念表（RecordReplayRegistry / RecordingFetch / ReplayFetch / RecordingCodec / GoldenRecorder / test-llm-mode-handler / llm 四值 / recording_drift）+ ASCII 关系图 + 6 条核心不变量。
- **record-replay.md**：组件契约（代码路径精确到 `文件.方法()`）+ 数据格式示例（禁 `...`）+ 3 段式设计决策 + 边界唯一归属 + 已知债。
- **代码-spec 一致核实（doc-modifier 阶段 5）**：逐项对齐实现——drift 接缝走 onDrift 回调 + commit 回传（非 try/catch）；FAIL 不落盘（内存 buffer + commit flush）；flush 同步 writeFileSync；manifest 顶层 provider/model='unknown'（行级 request_meta 真实）；record 期 web_search 绕过 proxyFetch（仅 test env）。均与 `record-replay-registry.ts`/`recording-fetch.ts`/`replay-fetch.ts`/`test-llm-mode-handler.ts`/`recording-codec.ts` 实际一致。

**已知债（本版明示豁免）**：ALS sessionId 未在 agent loop 注入（所有录制 `_default` 单道，并发多 session case 归 llm:off）；ET runner.py 573 行未拆分；manifest 顶层 provider/model 占位。

**已修（非遗留债）**：e2e runner.py 曾把 run 结果写回 checkpoint.json（污染 case 定义），v0.0.120 已修复（commit 3f2a268f）为只写 last_run.json。

> 详细设计冻结见 `../version_logs/v0.0.120/design.md`（method 级契约 `change_plan.md`）；tests/ 脚本层用法见 `tests/README.md`。
