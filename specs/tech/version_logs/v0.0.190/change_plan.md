# v0.0.190 变更计划书 — AT 去 replay：真实调 API + 配置 reuse dev + minimax 优先 + 429 skip

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径（worktree 内） |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么（禁「更新调用链」等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

## 版本主题

`tests/api`（AT）去 record/replay stub，case 真实调 API + 断言；env reuse dev 技术配置（providers/web_search/see_image/runtime/web/consolidation）；default_models=minimax（不 reuse dev deepseek）；429 → case `skipped, reason=429`。

**范围边界**：ET（v0.0.188 agent 玩 app 范式）不动；产品代码零行为变更（仅删 test-only wiring 分支，prod 行为不变）；跳过 PRD（纯测试基建）。

## 设计决策（架构期冻结）

1. **「产品代码不动」解读**（**MUST 用户确认**）：record/replay 机制由两部分组成—— (a) `app/server/src/testing/` 运行时基建；(b) 该基建在产品文件（`router.ts`/`bootstrap-bus-phase.ts`/`llm-client-factory.ts`/`jina-fetcher.ts`/`misc-routes.ts`/`sse-channel.ts`/`event-bus.ts`）里的 **test-only 接线分支**（全部 `NODE_ENV === 'test'` 门控，prod 模式下 no-op）。删除机制必须同时清理两类代码，否则 import 指向已删模块 → TypeScript 编译失败。**采纳解读 B**：删 testing/ 全目录 + 清理产品文件里 test-only 接线分支（行为零变化，因为这些分支在 prod 永不执行）。**Flag 为用户决策点**：若用户坚持字面「产品代码不动」，唯一出路是保留 testing/ 作 no-op stub——违背 memory `delete-old-code-fully-when-replacing`，不推荐。
2. **case.yaml DSL 保留 + 简化**：保留 `requests/check/sse.sub/run/poll/wait/save/oracle`；**删除 `stub` 字段 + `frame_checks` 字段**（frame_checks 依赖 recordings/llm.jsonl，无录制则无法求值；stub 字段记录声明的出站桩点，replay 没了便无意义）。**Flag 为用户决策点**：req 写「保留 frame_checks」——但 frame_checks 失去求值基础后保留字段会变僵尸字段，建议删；用户若坚持保留，coder 改为 schema 接受但 eval 永远 no-op（不推荐）。
3. **429 检测层级**：HTTP 层（`_do_requests`/`_do_run` 检查响应 status ∈ {429, 529, 503} 或 body error type 含 `rate_limit`）→ 抛 `RateLimitedError` → `run_case` 捕获 → result='skipped', reason='429' → `run_all` 单列计数不进 fail。**不重试不阻塞别的 case**。
4. **env reuse 策略**：~~symlink dev 配置目录到 test DATA_DIR~~ → **`cp -rL` 内容 copy dev 5 组技术配置（web_search/see_image/runtime/web/consolidation）到 test DATA_DIR**（test env self-contained，不依赖 dev 运行态；dev 不存在则回退 symlink test pool）。**【用户裁决偏离修正 2026-07-22】**：原「symlink dev」被用户驳回——自动化测试优先 self-contained，可 copy dev 配置内容但不直接依赖 dev 环境；providers 保 test pool symlink；严禁碰 dev 业务数据（sessions/messages/squad/memory）。
5. **providers 不 reuse dev**（**Flag 为用户决策点**）：req 提及「providers 凭证 reuse」但 test pool 已有 cases 硬编码的 providerId（`01KVJMPG2EZ1078MCT9JH4J5HG` 等）+ 真实 credentials；dev 的 provider 实例 ID 不同（`01KVJMPG2FA9ZSWDND60HV56N2` 等），换源会让所有 case 找不到 provider。**建议 KEEP test pool providers 不动**。

## 变更清单

### A. 删除：server testing/ 运行时基建

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| testing | app/server/src/testing/record-replay-registry.ts | RecordReplayRegistry (class) + getRegistry + pickLlmFetch + pickWebFetch + setActiveCase + commitIfPassed 等 | 删除 | 整文件删 | MUST 同步删所有 consumer 的 import；MUST NOT 留 no-op stub | record-replay.md §2；决策 1 | -450 |
| testing | app/server/src/testing/recording-fetch.ts | createRecordingFetch | 删除 | 整文件删 | — | record-replay.md §2 | -200 |
| testing | app/server/src/testing/replay-fetch.ts | createReplayFetch + RecordingDriftError | 删除 | 整文件删 | — | record-replay.md §2 | -250 |
| testing | app/server/src/testing/recording-codec.ts | computeFingerprintFromInit + appendLlmRecording + flushRecordings + writeManifest 等 | 删除 | 整文件删 | — | record-replay.md §2 | -350 |
| testing | app/server/src/testing/recording-fingerprint.ts | 整文件 | 删除 | 整文件删 | — | record-replay.md §2 | -100 |
| testing | app/server/src/testing/golden-recorder.ts | captureGolden + normalizeTranscript + compareGolden + readGolden | 删除 | 整文件删 | — | record-replay.md §2 | -200 |
| testing | app/server/src/testing/http-route-interceptor.ts | interceptHttpRequest + recordHttpResponse | 删除 | 整文件删 | — | record-replay.md §7.3 | -180 |
| testing | app/server/src/testing/sse-interceptor.ts | installSseTestInterceptor + finalizeAllSseRecorders + StreamRecorder (type) | 删除 | 整文件删 | — | record-replay.md §7.4；§9 | -300 |
| testing | app/server/src/testing/inbound-channels.ts | 整文件 | 删除 | 整文件删 | — | record-replay.md §7 | -80 |
| testing | app/server/src/testing/registry-seq-audit.ts | 整文件 | 删除 | 整文件删 | — | record-replay.md | -100 |
| testing | app/server/src/testing/types.ts | 整文件 | 删除 | 整文件删 | MUST 确保 stub-handler/test-llm-mode-handler 先删，避免悬空 import | record-replay.md §2 | -120 |
| testing | app/server/src/testing/stub-handler.ts | handleTestStub + handleTestStubCommit + handleTestStubStep | 删除 | 整文件删 | MUST 同步删 misc-routes.ts `/test/stub*` 路由 | record-replay.md §2 | -150 |
| testing | app/server/src/testing/test-llm-mode-handler.ts | handleTestLlmMode + handleTestCommit | 删除 | 整文件删 | MUST 同步删 misc-routes.ts `/test/llm-mode*` 路由 | record-replay.md §2 | -180 |
| testing | app/server/src/testing/__tests__/ (整目录) | stub-v2.test.ts / stub-http.test.ts / stub-sse.test.ts / test-llm-mode-handler.test.ts 等 | 删除 | 整目录删 | — | record-replay.md §6 | -800 |
| server-test | app/server/src/__tests__/http-server-sse-record-mode.test.ts | 整文件 | 删除 | 测 record 模式的 UT，随机制度除 | — | record-replay.md §9 | -150 |

### B. 删除：产品文件里的 test-only 接线分支（prod 行为零变化）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| llm-client | app/server/src/llm-client-factory.ts | buildLlmClient() | 修改 | 删 `import { getRegistry, pickLlmFetch }`；删第 5 步 `recordReplayFetch` 分支，仅保留 `ROCKY_TEST_MOCK_LLM=1 → createMockFetch` 二分路径 | MUST 保留 ROCKY_TEST_MOCK_LLM mock 路径（computer_use 剧本依赖）；MUST NOT 改 prod 默认 fetch 行为 | llm-client-factory.ts L24,85-99 | +0/-18 |
| router | app/server/src/router.ts | dispatchRequestInternal() | 修改 | 删 `import { interceptHttpRequest, recordHttpResponse }`+`getRegistry`；删 dispatch 头部 `interceptHttpRequest` 分支 + 响应返回前 `recordHttpResponse` 分支；dispatch 直接 `return await _dispatchRequestCore(req, dataDir)` | MUST NOT 改 prod 路由分发行为（intercept/record 在 prod 永远 no-op，删除等价） | router.ts L24-25,104-114 | +0/-12 |
| bootstrap | app/server/src/bootstrap-bus-phase.ts | bootstrapBusPhase() | 修改 | 删 `import ... from './testing/sse-interceptor'`+`import { getRegistry }`；删末尾 `installSseTestInterceptor` 调用 + `sseRegistry.setSseRecorders` 块 | MUST NOT 改 SseChannel 装配（仅去 test 拦截器装配） | bootstrap-bus-phase.ts L26-27,130-140 | +0/-18 |
| web-fetch | app/server/src/tools/web-fetch/jina-fetcher.ts | JinaFetcher.fetch() | 修改 | 删 `import { getRegistry, pickWebFetchFetch }`；删 `pickWebFetch(getRegistry()) ?? proxyFetch` 分支，直接用 `proxyFetch` | MUST NOT 改 prod jina fetch 行为 | jina-fetcher.ts L19,L88-90 | +0/-6 |
| routes | app/server/src/routes/misc-routes.ts | dispatchMiscRoutes() | 修改 | 删 `import { handleTestCommit, handleTestLlmMode }`+`import { handleTestStub, ... }`；删 `/test/llm-mode*` + `/test/stub*` 两段 path 分支（约 4 行 if 块 + 6 行 route handler）；**保留 `/test/consolidation-run`**（独立 test-only handler，不走 stub） | MUST NOT 删 `/test/consolidation-run`（t2 AT case 依赖） | misc-routes.ts L33-34,L110-123 | +0/-18 |
| sse | app/server/src/sse/sse-channel.ts | SseChannel | 修改 | 删 `setTestInterceptor()` 公开方法 + `testInterceptor` 字段 + `subscribe()` 内 `testInterceptor.onSubscribe/shouldSkipHubReplay/onWriteFrame` 三处分支 | MUST NOT 改 SSE channel 业务行为（subscribe/writeFrame/pushWireToSinks 主链路保留） | sse-channel.ts L101-115,207-260,376-380 | +0/-50 |
| event-bus | app/server/src/agent/event-bus.ts | ReplayableEventBus.subscribe() | 修改 | 删 `opts.skipReplayHistory` 参数 + 对应 `if (this.replayable && !opts?.skipReplayHistory)` 分支恢复成 `if (this.replayable)` | MUST 保留 replayable sticky/buffer 回放语义（prod 业务依赖） | event-bus.ts L122-160 | +0/-8 |

### C. 删除：AT 框架 record/replay 脚本层

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| at-runner | tests/api/lib/stub_client.py | set_case + set_step + commit + post_json（整文件） | 删除 | 整文件删（不再有 stub 协议） | — | record-replay.md §2 | -55 |
| at-runner | tests/api/lib/recordings_snapshot.py | snapshot_recordings + restore_recordings + discard_snapshot（整文件） | 删除 | 整文件删（无录制，无快照回滚） | — | record-replay.md §3.3 | -55 |
| at-runner | tests/api/lib/frame_checks_eval.py | eval_frame_checks + validate_frame_check_exprs（整文件） | 删除 | 整文件删（frame_checks 字段同步删） | MUST 同步从 case_loader._TOP_FIELDS 删 frame_checks | 决策 2 | -120 |
| at-data | tests/api/**/recordings/ (11 个目录) | manifest.json + llm.jsonl [+ golden.json + web_*.jsonl + http.jsonl + sse.jsonl] | 删除 | 全部 case 的 recordings 目录删除 | MUST 删干净不残留（gitignore 已包含 last_run，recordings 入库须 git rm） | tests/api/.gitignore；决策 2 | -files |

### D. 修改：AT 框架核心脚本（run_all + run_case + step_exec + case_loader）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| at-runner | tests/api/lib/run_case.py | main() | 修改 | 删 `mode` 参数（恒 live）；删 `requires: live` 分支（恒真无意义）；直接调 `_run_case_once(case, case_dir)` | MUST 保留 load_error 分支 | run_case.py L247-282 | +0/-30 |
| at-runner | tests/api/lib/run_case.py | _run_case_once() | 修改 | 删 `mode`/`snapshot`/`_stub_set_case`/`_stub_commit`/`drift_info`/`undeclared` 全部逻辑；简化为「setup → steps → teardown → cleanup → return」；捕获 `RateLimitedError`（来自 step_exec）→ result='skipped', reason='429'；删 `_eval_frame_checks_for_case` 调用 | MUST 保留 phase 三段结构 + per-step 产物 + cleanup_written_files；MUST 保留 SSE collector | run_case.py L97-244 | +60/-150 |
| at-runner | tests/api/lib/run_case.py | _run_phase() | 修改 | 删 `_stub_set_step(case_id, n, declared)` 调用（stub 协议已废）；其余不变（step 循环 + write_step + summary） | MUST NOT 改 step fail-break 语义 | run_case.py L26-94 | +0/-3 |
| at-runner | tests/api/lib/run_case.py | _eval_frame_checks_for_case() | 删除 | 整函数删 | — | run_case.py L97-120 | -25 |
| at-runner | tests/api/lib/step_exec.py | _do_requests() | 修改 | 加 429/529/503 检测：响应 status ∈ {429,529,503} 或 body 含 `rate_limit`/`overloaded` error type → raise `RateLimitedError`（新异常类）；其余 unchanged | MUST NOT 改其他 status 的 StepFailError 语义；MUST 在 raise 前附 reason 上下文（status/body snippet） | 决策 3 | +15/-0 |
| at-runner | tests/api/lib/step_exec.py | _do_run() | 修改 | 调 `POST /session/:id/run` 返回后检查 body.stopReason + lastError：若 `stopReason=='error'` 且 error type 含 rate_limit → raise `RateLimitedError`；其余 unchanged | MUST NOT 改非 429 错误的 StepFailError 语义 | 决策 3 | +12/-0 |
| at-runner | tests/api/lib/step_exec.py | _do_oracle() | 修改 | 删 `if mode == 'replay': return skipped` 分支（replay 模式已废）；保留 langfuse 轮询主体 | ~~MUST 保留 env 未配置时的 StepFailError~~ **【orchestrator 裁决偏离修正 2026-07-22】**实际实现：langfuse 未配置（LANGFUSE_BASE_URL/PUBLIC_KEY/SECRET_KEY 任一缺失）→ 返回 skipped（reason=langfuse_not_configured），与 langfuse-verification skill「凭证缺失则 clean SKIP」约定一致；当前零 case 用 `oracle:`（零现实影响），README/at-framework.md/designer agent 已自洽 | step_exec.py L307-337 | +0/-3 |
| at-runner | tests/api/lib/step_exec.py | RateLimitedError (class) | 新增 | 新异常类，标记 case 应 skip 不 fail。**【偏离修正 2026-07-22】**实际直接继承 `Exception` 而非 StepFailError——机制必需：`exec_step` 捕获 StepFailError 转 step fail，若为子类 skip 信号会被吞掉 | — | 决策 3 | +5 |
| at-runner | tests/api/lib/case_loader.py | _TOP_FIELDS | 修改 | 删 `'frame_checks'`；保留 case/module/timeout/requires/setup/steps/teardown | MUST 同步删 frame_checks 解析逻辑（L141-150） | 决策 2 | +0/-15 |
| at-runner | tests/api/lib/case_loader.py | _STEP_FIELDS + _STUB_POINTS | 修改 | 删 `'stub'` 字段 + 整个 `_STUB_POINTS` 常量 + step.stub 校验逻辑（L199-203） | MUST NOT 拒载历史 case.yaml——同步在本版本 case.yaml 清理时移除 stub 字段（D 节 case.yaml 改） | 决策 2 | +0/-10 |
| at-runner | tests/api/lib/case_loader.py | Case (dataclass) | 修改 | 删 `frame_checks: List[str] = None` 字段 | — | 决策 2 | +0/-1 |
| at-runner | tests/api/lib/_run_all_exec.py | _double_gate() | 删除 | 整函数删（无 record→replay 双关） | — | _run_all_exec.py L169-212 | -45 |
| at-runner | tests/api/lib/_run_all_exec.py | _run_once() | 修改 | 删 `MODE=run_mode` env 透传（mode 恒 live）；函数签名 `def _run_once(case_dir, run_case_py)`；其余（subprocess + timeout + result.json 读）不变 | MUST 保留 timeout 树杀 + mtime 新鲜度检查（v0.0.120 事故教训） | _run_all_exec.py L69-134 | +5/-5 |
| at-runner | tests/api/lib/_run_all_exec.py | _make_entry() | 修改 | 删 drift 分支（drift_info/drift_detected/drift_summary 全去）；新增 `skipped` 分类——`rd.get('result') == 'skipped'` → entry.result='skipped', entry.skip_reason=rd.get('reason') | — | _run_all_exec.py L137-166 | +10/-15 |
| at-runner | tests/api/lib/_run_all_exec.py | main() | 修改 | 删 `mode` 参数解析；调用从 `if mode == 'record': _double_gate(...) else: _run_once(...)` 简化为单调 `_run_once(...)`；聚合分类从 5 类（pass/fail/drift/timeout/not_run）改为 5 类（pass/fail/timeout/not_run/**skipped**）——skipped 单列不算 fail，不翻 overall；打印 + run_all_result.json schema 同步加 `skipped_count` | MUST overall 计算保持 `fail==0 && timeout==0`（skipped 不影响 overall） | _run_all_exec.py L215-298 | +30/-30 |
| at-runner | tests/api/lib/run_all.sh | MODE 处理 | 修改 | 删 `MODE=record|replay|live` 入口（保留环境变量兼容但忽略值，永远 live）；删 help 文本里的 MODE 说明 | MUST 保留 CASES/ROUND/LIST_ONLY/SKIP_ENV/RUN_BUDGET_SECONDS | run_all.sh L7,19,52,115 | +0/-8 |

### E. 修改：case.yaml + env_start.sh + env reuse

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| at-case | tests/api/**/case.yaml (12 文件) | stub 字段 | 修改 | 逐 case 删所有 `stub: [...]` 行（12 文件 × 1-3 处） | MUST 不动 case 主体逻辑；MUST grep 验证 `grep -r 'stub:' tests/api/` 归零 | 决策 2 | +0/-25 |
| at-case | tests/api/academy/coach-chat/case.yaml | frame_checks 字段 | 修改 | 删顶层 `frame_checks:` 块（如有） | — | 决策 2 | +0/-10 |
| at-case | tests/api/compact/compact_model_directive/case.yaml | frame_checks 字段 | 修改 | 删顶层 `frame_checks:` 块（如有） | — | 决策 2 | +0/-10 |
| at-env | tests/api/env_start.sh | provider pool symlink 段 | 修改 | KEEP（test pool 已有真实凭证，cases 硬编码 ID 能命中） | MUST NOT reuse dev providers（决策 5） | env_start.sh L84-97 | +0/-0 |
| at-env | tests/api/env_start.sh | web_search/see_image/runtime/web/consolidation 内容 copy 段 | 新增 | 加 5 组 copy：源 `$HOME/.rocky_agent_dev/app_config/<group>` → `$DATA_DIR/app_config/<group>`，用 `cp -rL`（解引用 symlink，test env self-contained）；幂等（`[ ! -e DEST ]` 跳过）；dev 不存在则回退 symlink test pool。**【用户裁决偏离修正 2026-07-22】**原设计为 symlink dev（同 provider pool 范式），用户驳回改 copy，见决策 4 | MUST reuse dev 技术配置（req 决策）；MUST NOT reuse default_models（保持 minimax）；MUST NOT 碰 dev 业务数据（sessions/messages/squad/memory） | env_start.sh L94-111 | +25 |
| at-env | tests/api/env_start.sh | see_image POST /config/app seed 段（L139-154） | 删除 | 删整段（copy dev see_image 已替代） | — | env_start.sh L139-154 | +0/-18 |
| at-env | tests/api/env_start.sh | contextWindow=300000 seed 段（L121-137） | 修改 | KEEP（消除 compact 双触发，仍幂等有用） | — | env_start.sh L121-137 | +0/-0 |
| at-env | tests/api/env_start.sh | ROCKY_TEST_MOCK_LLM 默认值 | 修改 | KEEP `ROCKY_TEST_MOCK_LLM=0`（默认真调，computer_use case 用 ROCKY_TEST_MOCK_LLM=1 覆盖） | MUST NOT 默认 mock | env_start.sh L100-101 | +0/-0 |

### F. 修改：文档（specs + agents + CLAUDE.md + tests/README.md）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| spec-testing | specs/tech/testing/record-replay.md | 整文件 | 修改 | **大幅瘦身 + 改标题**——改名「AT 真实调 API 基建」（或拆为新文件 `at-realcall.md` + 此文件 soft_delete）；删 §1-§9 所有 record/replay 组件描述；新增章节：AT 真实调 API + case 自管 prep（setup phase）+ env reuse dev 配置 + 429 skip 机制 + 5 分类聚合（pass/fail/timeout/not_run/skipped） | MUST 保留「概念权威源」性质；MUST 删干净不留僵尸段（memory `delete-old-code-fully-when-replacing`） | record-replay.md 全文 | +200/-270 |
| spec-testing | specs/tech/testing/index.md | 整文件 | 修改 | 改标题「AT record/replay 基建」→「AT 真实调 API 基建」；删概念表里的 RecordReplayRegistry/RecordingFetch/ReplayFetch/RecordingCodec/GoldenRecorder/recording_drift 行；新增真实调 + 429 skip + env reuse 三概念行；改 ASCII 关系图 | — | testing/index.md 全文 | +30/-40 |
| spec-testing | specs/tech/testing/log.md | 整文件 | 修改 | 追加 v0.0.190 条目（去 record/replay + 真实调 + env reuse + 429 skip）；旧条目保留（历史） | MUST 只追加不删 | testing/log.md | +20/-0 |
| agent | .claude/agents/api-test-executor.md | description + 执行纪律 + 汇报格式 | 修改 | 删 MODE/双关/drift；改为「直接跑 run_all.sh（无 MODE）」；汇报格式去 drift 单列，加 skipped 单列 | MUST 保留长跑轮询 + AT/ET 互斥 + 不改 case/不读代码边界 | api-test-executor.md 全文 | +40/-40 |
| agent | .claude/agents/api-test-designer.md | description + LLM record/replay 章节 + DSL 陷阱 + case 标准 + 产出 | 修改 | 删整段「LLM record/replay + 双关」「判定规则」；删陷阱 #4 stub 范围 / #6 命名流整 case（不实，保留）/ 等；删 `stub` 字段、`frame_checks` 字段说明；改为「case 真实调 API + setup 自管 prep + 429 skip 不重试不阻塞」 | MUST 保留 DSL 核心（requests/run/poll/wait/save/check/sse.sub） | api-test-designer.md 全文 | +60/-80 |
| claude | .claude/CLAUDE.md | 持久化测试用例库 AT 段（L189-235） | 修改 | 删「record/replay 双关」「stub 协议」描述；改为「case 真实调 API + 429 skip + env reuse dev」；DSL 核心保留 | MUST 同步 index 章节里 AT 描述（双轨说明表） | L189-235 | +30/-30 |
| claude | .claude/CLAUDE.md | 测试计划 + 用例创建 AT 段（L237-279） | 修改 | 删「record 双关 PASS」要求；改为「case 真实调 API PASS」；AT case 文件结构去 recordings/ | — | L237-279 | +5/-10 |
| claude | .claude/CLAUDE.md | 验证体系 AT 层 + LLM record/replay 段（L280-378） | 修改 | 删「LLM record/replay（AT 专属 — MANDATORY）」整节；改 AT 描述「真实调 API（不录制不回放），对齐 ET 范式」 | — | L280-378 | +10/-50 |
| claude | .claude/CLAUDE.md | 测试迭代 + 阈值门禁（L482-513） | 修改 | 删 drift 分类说明；加 skipped 分类（429 → 不算 fail 不算分母） | — | L482-513 | +5/-5 |
| claude | .claude/CLAUDE.md | 文档产出链路 AT 行（L153-166） | 修改 | 删「record 双关」「recordings 入 git」描述 | — | L153-166 | +2/-3 |
| claude | .claude/CLAUDE.md | 测试运行规范 AT 行（L585-595） | 修改 | 删 `MODE=record|replay`；改为 `CASES=<id,id> bash tests/api/lib/run_all.sh` | — | L585-595 | +1/-2 |
| claude | .claude/CLAUDE.md | 简化流程段（末尾） | 修改 | 删「record 双关」字样 | — | 末尾 | +0/-2 |
| tests-doc | tests/README.md | 部署段 + AT DSL schema + MODE/stub/双关 段 | 修改 | 删「MODE=record|replay/live」「stub 协议」「双关验收」「frame_checks」「recording_drift」章节；改为「真实调 API + 429 skip + env reuse dev」+ DSL schema 去 stub/frame_checks | MUST 保留 DSL 核心 + secrets 部署段 | tests/README.md 全文 | +80/-200 |

## 影响面评估

**跨模块**：
- server: `app/server/src/testing/` 全删 + 7 个产品文件 test-only 接线清理（router/bootstrap-bus-phase/llm-client-factory/jina-fetcher/misc-routes/sse-channel/event-bus）
- tests/api: lib/* 6 改 + 3 删 + 11 recordings/ 删 + 12 case.yaml 改 + env_start.sh 改
- docs: specs/tech/testing/* (3) + .claude/agents/api-test-* (2) + .claude/CLAUDE.md (7 段) + tests/README.md

**破坏性变更**：
- TypeScript：删 testing/ 会让产品文件 import 失败，MUST 同 PR 清理产品文件 import（B 节）
- AT case.yaml：移除 stub + frame_checks 字段会让旧 case.yaml 拒载，MUST 同 PR 清理 12 个 case.yaml（E 节）
- 产品运行时行为：零变化（所有删除的接线分支在 prod 模式下本来就 no-op）

**依赖顺序**：A（删 testing/）和 B（产品接线清理）同 PR；C/D（AT 脚本 + case.yaml）和 A/B 互不依赖可并行；F（文档）最后落（看到实际行为再写）

**风险点**：
1. **决策 1 用户驳回**：若用户坚持字面「产品代码不动」，方案需重定为「保留 testing/ 作 no-op」——工作量大且留僵尸代码，不推荐
2. **429 检测误判**：误把正常 fail 当 429 skip → case 假绿；漏判真 429 → case 假 fail。检测谓词保守（仅 status ∈ {429,529,503} + body error type 精确匹配 `rate_limit`/`overloaded`）
3. **env reuse dev 失效**：dev 配置目录结构变化（如 `app_config/<group>/app_config/<id>.json` 嵌套层级变）会让 copy 源路径不存在（env_start.sh 只 warn 不 fail，回退 symlink test pool）；server 启动期读不到配置内容只 warn 不 fail，case 跑时因凭证缺失 fail
4. **frame_checks 删除**：req 写「保留」，本方案删（依赖 recordings），用户若坚持保留需改本计划

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- 决策点 1/2/5 用户裁决后改本表 → 写进 `change_log.md`「用户决策」段
