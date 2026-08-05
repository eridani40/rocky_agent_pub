# v0.0.120 — Tech Change Log（AT/ET 测试体系 record/replay 改革）

> 跨版本发布说明（版本轴）。本目录级变更见 `specs/tech/testing/log.md`（位置轴，新建 KB）。
> 架构方案冻结见 `design.md`；method 级契约见 `change_plan.md`（含「实现偏离注记」段）。

## 概览

把 AT/ET 的「凭空造剧本的 mock」升级为「**录制真实响应 + 确定性回放**」。拦截点 = `llm-client-factory` 的 fetchImpl 注入口（protocol/SSE/tool loop 全链路真实，只换出站 HTTP 响应字节）。首跑真调 LLM 录制（PASS 才落盘）→ 之后确定性回放，秒级、零 flaky、零 token。全部代码 `NODE_ENV=test` 门禁（三重 gate），prod 零侵入。

新增 tech KB：`specs/tech/testing/`（index + log + record-replay.md）。

## §1 server 侧基建（app/server/src/testing/ 新目录）

- **RecordReplayRegistry**（进程单例，仅 test env）：active case `{mode,recordingsDir}` + ALS 上下文 + per-session seq/cursor + driftEvents；`pickFetchImpl`/`pickWebFetch` 选择器。ReplayFetch 单例复用（suspend-resume 双 run 游标连续，本版修复）。
- **RecordingFetch**：包 `globalThis.fetch`，SSE tee / JSON clone 落内存 buffer（脱敏后）。
- **ReplayFetch**：per-session cursor 按序回放，构造 SSE ReadableStream / JSON Response；指纹漂移 + 游标越界抛 `RecordingDriftError`。
- **RecordingCodec**：manifest/jsonl 读写 + 确定性指纹 + 脱敏 + session_hint 派生；`flushRecordings` 同步 writeFileSync。
- **GoldenRecorder**：captureGolden / normalizeTranscript（纯函数）/ compareGolden（结构 deep-equal）/ readGolden。
- **test-llm-mode-handler**：`POST /test/llm-mode`（设 active case）+ `/commit`（PASS flush + golden + 回传 `drift.{detected,events}`）。
- **接线**：`buildLlmClient` 第 5 步 `pickFetchImpl`；`jina-fetcher`/`zhipu-provider` 出站前 `pickWebFetch(getRegistry()) ?? proxyFetch`；`router` `/test/llm-mode` 分支（NODE_ENV=test gate 404）。

## §2 llm 字段四值 + drift 分类

- `llm` 字段（正交新增，不动存量 `llm_mode`）：`replay`（缺省，无录制自动切 record）/ `record` / `off`（每次真调 smoke）/ `mock`（legacy @@cu，computer_use 用 → 修 13 case 永久 SKIP）。
- `recording_drift` = **第五结果类**（≠ fail）：录制数据与当前 prompt/tools schema 漂移（或游标越界），不翻 overall，提示重录。

## §3 tests 脚本层 + 工具

- **共享 lib `tests/lib/llm_mode.sh`**（偏离 change_plan Row92/94：原写 run_case 新增段，实现抽共享库消 AT/ET 重复）：`llm_mode_read_fields`/`llm_mode_setup`/`llm_mode_commit`（含 drift/golden 改写，drift 优先）。
- **AT runner 拆 `_steps.py`**（runner.py 367→<300）：steps DSL + `run`/`save`/`create_session` 高层封装。
- **工具**：`new_case.sh`（脚手架）/`gen_case_md.sh`（test_case.md 自动生成）/`RECORD_BATCH.sh`（分波串行录制）/`_case_lib.sh`（rr_ helper）。
- **env 修复**：test.env `ROCKY_TEST_MOCK_LLM` 改 `${...:-0}` 默认语义使命令行 override 穿透。
- **recordings 随 case 入 git**（~120 份，脱敏后无密钥）；`llm:off` 白名单 ~16 个（时序语义/并发多 session/langfuse oracle/外部 web_search——回放机制结构性边界）。

## §4 spec↔code 对齐结论（doc-modifier 核实）

逐项核实「代码实现 == spec 契约」，与实际一致，无静默偏离：

- **drift 接缝**（原则 12 重点核实）：design §6 原只写「handler/run_case 捕获」——实际 ReplayFetch 错回不到脚本，走 **onDrift 回调 → registry.driftEvents → commit 回传 drift → llm_mode.sh 改写 last_run**。本版补齐 design §6 完整链路契约。
- **FAIL 不落盘**：record 内存 buffer + `/commit {passed}` 触发 flush，FAIL clearBuffer，与 `commitIfPassed` 实现一致。
- **flush 同步**：`flushRecordings` writeFileSync，commit 200 时已落盘，rr case 无需固定 sleep 等 flush（补 design §4.4.0）。

**修正的 spec↔code 偏离 / 补注（本次对齐）**：
1. design §4.1：manifest 顶层 `provider`/`model` 恒 `'unknown'`（registry 不持 provider 元信息，行级 request_meta.model 才真实）。
2. design §4.3：record 期 web_search 走 `globalThis.fetch` 绕过 proxyFetch（proxy/SSRF 防护录制期不生效，仅 test env，prod 不受影响）。
3. design §7：`commitIfPassed` 置 activeCase=null 防重复 commit + handler caseId mismatch 守卫（并发 race no-op）。
4. `tests/README.md`：recordings **随 case 入 git**（原误写 gitignored）；`recording_drift` = **指纹漂移**（原误写 golden compare 不一致——golden mismatch 是普通 fail）；补录制/回放判定规则表。
5. `specs/api/overall/04-agent-session.md §13.2`：commit 响应补 `drift.{detected,events}` + `goldenResult` + caseId mismatch 守卫。

## §5 已知债（本版明示豁免）

- **ALS sessionId 未在 agent loop 注入** → 所有录制走 `_default` 单道；单 session case 无碍，并发多 session case 归 `llm:off`。后续版本 agent loop 发起 LLM 调用前 `als.run({sessionHint},...)` 补齐解锁多 session 回放。
- **ET runner.py 573 行 > 300**：本版明示豁免拆分（ET 走 Playwright action 序列，本版核心是 AT record/replay）；后续按 design §12 抽 `_e2e_steps.py`。

**已修（非遗留债）**：e2e runner.py 曾把 run 结果写回 checkpoint.json（污染 case 定义），v0.0.120 已修复（3f2a268f）为只写 last_run.json。

**.claude 配置**（用户 07-12 授权，已完成于 dev1 a4120bbd）：CLAUDE.md tests 结构图 + 验证体系 record/replay 语义 + 阈值门禁回放轮；api/e2e-test-designer.md + test-executor.md 的 llm 字段/golden/recordings/五分类/回放轮语义更新。
