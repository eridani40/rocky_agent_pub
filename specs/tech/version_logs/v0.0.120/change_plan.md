# v0.0.120 变更计划书 — AT/ET record/replay 改革 + env 优先级修复

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 方案总纲见同目录 `design.md`（§ 引用即指该文件章节）。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么 |
| 约束 | MUST / MUST NOT |
| 参考 | design.md § / 代码位置 / 决策号 |
| 预计影响行 | +N / -M |

## 变更清单

### A. server 侧 record/replay 基建（`app/server/src/testing/` 新目录，均 test-gate）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| testing | app/server/src/testing/types.ts | `LlmMode` (type) | 新增 | union `'replay'\|'record'\|'off'\|'mock'` | MUST 与 checkpoint `llm` 字段枚举一致 | design §9 | +6 |
| testing | app/server/src/testing/types.ts | `RecordingResponse` (interface) | 新增 | `{kind:'json'\|'sse', status:number, body?:unknown, sse_frames?:string[]}` | MUST 同时支持 json 与 sse 两形态 | design §4.2；决策 2 | +10 |
| testing | app/server/src/testing/types.ts | `LlmRecording` (interface) | 新增 | 单次 LLM 调用行：`{seq,session_hint,fingerprint,request_meta,response}` | MUST NOT 含 messages 正文/credentials | design §4.2；决策 11 | +12 |
| testing | app/server/src/testing/types.ts | `WebSearchRecording` (interface) | 新增 | web_search 调用行：`{seq,session_hint,provider,request_meta,response}` | 同上脱敏约束 | design §4.3；决策 9 | +10 |
| testing | app/server/src/testing/types.ts | `RecordingManifest` (interface) | 新增 | case 级元信息 + fingerprint 基线 | MUST 含 system_prompt_hash/tools_schema_hash/model | design §4.1；决策 4 | +12 |
| testing | app/server/src/testing/types.ts | `Fingerprint` (interface) | 新增 | `{system_prompt_hash,tools_schema_hash,model}` | — | design §4.1/§6 | +6 |
| testing | app/server/src/testing/types.ts | `ActiveCase` (interface) | 新增 | `{caseId,mode:LlmMode,recordingsDir:string}` | recordingsDir MUST 绝对路径 | design §3 | +6 |
| testing | app/server/src/testing/recording-codec.ts | `writeManifest()` | 新增 | 写 `recordings/manifest.json`（覆盖语义） | MUST 覆盖旧文件（决策 3） | design §4.1/§7；决策 3 | +20 |
| testing | app/server/src/testing/recording-codec.ts | `readManifest()` | 新增 | 读 manifest；缺失返 undefined | — | design §4.1 | +14 |
| testing | app/server/src/testing/recording-codec.ts | `appendLlmRecording()` | 新增 | 追加一行到 buffer（内存），非直写文件 | MUST 走 buffer，PASS 才 flush（§7） | design §7；决策 6 | +12 |
| testing | app/server/src/testing/recording-codec.ts | `flushRecordings()` | 新增 | buffer → `recordings/{manifest,llm.jsonl,web_search.jsonl}` 落盘 | MUST 仅 PASS 调用；覆盖旧 recordings | design §7；决策 3/6 | +26 |
| testing | app/server/src/testing/recording-codec.ts | `loadReplaySet()` | 新增 | 读 llm.jsonl/web_search.jsonl → 按 session_hint 分组 + seq 排序 | MUST 按 session 分道（决策 4） | design §5 | +26 |
| testing | app/server/src/testing/recording-codec.ts | `computeFingerprint()` | 新增 | 从 CanonicalRequest 算 system_prompt_hash + tools_schema_hash + model（确定性规范化） | MUST 确定性（同输入同 hash）；tools schema 排序去动态字段 | design §6；决策 4 | +30 |
| testing | app/server/src/testing/recording-codec.ts | `redact()` | 新增 | 落盘前剔除 Authorization/api_key/credentials/token | MUST NOT 落盘任何密钥/Authorization | design §4.4；决策 11 | +24 |
| testing | app/server/src/testing/recording-codec.ts | `extractSessionHint()` | 新增 | 从请求上下文取稳定 session_hint（s1/s2…映射；无则 `_default`） | MUST 稳定跨跑（不用原始 ULID） | design §5.1；决策 4 | +18 |
| testing | app/server/src/testing/record-replay-registry.ts | `RecordReplayRegistry` (class) | 新增 | 进程内单例：持 active case + als 上下文 + replaySet 缓存 + record buffer | MUST 仅 test 环境实例化 | design §2/§3；决策 7 | +40 |
| testing | app/server/src/testing/record-replay-registry.ts | `setActiveCase()` | 新增 | `/test/llm-mode` 调；设当前 case+mode+dir，重置游标，record 模式清 buffer；mode=replay 且 recordings 缺失→自动切 record | MUST sticky 覆盖整 case 生命周期（含异步 tool loop） | design §3/§7；决策 6/7 | +30 |
| testing | app/server/src/testing/record-replay-registry.ts | `runWithSession()` | 新增 | als.run 包住一次 session 的 LLM 调用，注入 session_hint | 单 session case 可不调（`_default` 兜底） | design §5.1；决策 4 | +14 |
| testing | app/server/src/testing/record-replay-registry.ts | `commitIfPassed()` | 新增 | case 收尾按 pass 落盘 record buffer 或丢弃 | MUST FAIL 绝不落盘 | design §7；决策 6 | +16 |
| testing | app/server/src/testing/record-replay-registry.ts | `getRegistry()` | 新增 | 返进程单例（懒建）；非 test env 返 null | 非 test → null（pickFetchImpl 走真 fetch） | design §3 门禁；决策 7 | +12 |
| testing | app/server/src/testing/record-replay-registry.ts | `pickFetchImpl()` | 新增 | 按 active case mode 返 RecordingFetch/ReplayFetch/undefined(off/非test) | MUST NOT 进 prod 路径（非 test 返 undefined） | design §2/§3；决策 1/7 | +22 |
| testing | app/server/src/testing/record-replay-registry.ts | `pickWebFetch()` | 新增 | web_search 出站 fetch 的 record/replay 选择器（同 pickFetchImpl 逻辑） | 同上 test-gate | design §2/§4.3；决策 9 | +18 |
| testing | app/server/src/testing/recording-fetch.ts | `createRecordingFetch()` | 新增 | 包真 fetch：透传出站 → 读响应（clone）→ codec.append 到 buffer → 原样返调用方 | MUST 透传真实响应给业务链路（决策 1）；落 buffer 脱敏 | design §2/§4；决策 1/11 | +60 |
| testing | app/server/src/testing/recording-fetch.ts | `captureSseResponse()` | 新增 | tee SSE ReadableStream：一路给业务、一路收帧文本存 buffer | MUST 逐帧保留原始文本（含 `\n\n`） | design §4.2；决策 2 | +40 |
| testing | app/server/src/testing/recording-fetch.ts | `captureJsonResponse()` | 新增 | clone 非流式响应 body 存 buffer | — | design §4.2 | +18 |
| testing | app/server/src/testing/replay-fetch.ts | `createReplayFetch()` | 新增 | 按 session_hint+seq 取 recording → 构造 Response（json 或 SSE stream）；游标越界/漂移抛 RecordingDriftError | MUST 不匹配请求体（决策 4）；drift ≠ fail | design §5/§6；决策 4 | +60 |
| testing | app/server/src/testing/replay-fetch.ts | `buildSseResponse()` | 新增 | 从 sse_frames[] 拼 ReadableStream 逐帧 enqueue → Response(text/event-stream) | MUST 帧序列真实喂 protocol.parseStream | design §4.2；决策 2 | +34 |
| testing | app/server/src/testing/replay-fetch.ts | `buildJsonResponse()` | 新增 | 从 body 构造非流式 Response | — | design §4.2 | +14 |
| testing | app/server/src/testing/replay-fetch.ts | `checkDrift()` | 新增 | 比对当前请求 fingerprint vs 录制 fingerprint，漂移抛 RecordingDriftError | 漂移抛专门错误类，非普通 fail | design §6；决策 4 | +24 |
| testing | app/server/src/testing/replay-fetch.ts | `RecordingDriftError` (class) | 新增 | 携 caseId + 漂移维度 + 期望/实际 hash 摘要 | MUST 可被 handler 捕获转 result=recording_drift | design §6；决策 4/12 | +14 |
| testing | app/server/src/testing/golden-recorder.ts | `captureGolden()` | 新增 | record PASS 时从 messages 提结构骨架（tool_call 名序列/role/stopReason/绑定拓扑），规范化剔动态值 → 存 `recordings/golden.json` | MUST 规范化剔除 ULID/timestamp/token/正文（§16）；覆盖旧 golden | design §16；追加裁决 2.3 | +50 |
| testing | app/server/src/testing/golden-recorder.ts | `normalizeTranscript()` | 新增 | 纯函数：ULID→`<id>`占位、去 timestamp/usage/cost、text 留空/非空布尔、保留 tool_call 名序列 + arguments key 集合 + tool_result 绑定拓扑 | MUST 确定性纯函数；MUST NOT 剔除 tool_call 序列/拓扑（断言价值核心） | design §16 结构匹配算法；追加裁决 2.3 | +54 |
| testing | app/server/src/testing/golden-recorder.ts | `compareGolden()` | 新增 | replay 时对 actual 同规范化 → deep-equal golden → 返首个差异点（`golden drift at tool_calls[1].name`） | 结构匹配非全文；golden fail = 普通 fail | design §16；追加裁决 2.3 | +40 |
| testing | app/server/src/testing/golden-recorder.ts | `readGolden()` | 新增 | 读 `recordings/golden.json`；缺失/`golden:off` 返 undefined（跳过比对） | — | design §16 | +12 |
| testing | app/server/src/testing/types.ts | `GoldenTranscript` (interface) | 新增 | 规范化结构基线形状（role 序列/tool_call 名序列/arguments key/绑定拓扑/stopReason） | — | design §16 | +14 |

### B. llm-client-factory + web_search 接线

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| llm | app/server/src/llm-client-factory.ts | `buildLlmClient()` | 修改 | 第 5 步 fetchImpl 选择：先 `pickFetchImpl(getRegistry(), env)`；返非空用之，否则退现有 `createMockFetch(ROCKY_TEST_MOCK_LLM=1)` 分支，否则 undefined（真 fetch） | MUST NOT 破坏现有 mock:* 剧本路径（决策 9 legacy 保留）；MUST 只在 test env 注入 | design §2/§9；代码 llm-client-factory.ts:88-95；决策 1/9 | +14/-4 |
| web-search | app/plugins/builtins/zhipu_web_search/zhipu-provider.ts | zhipu fetch 调用点（`proxyFetch(ZHIPU_URL,...)`） | 修改 | 出站前经 `pickWebFetch(getRegistry())` 决策：replay/record 时改走 record/replay fetch，off/非 test 走原 proxyFetch | MUST NOT 改真实请求参数/协议；仅换 fetch 实现 | design §2/§4.3；代码 zhipu-provider.ts:132；决策 9 | +12/-2 |
| web-fetch | app/server/src/tools/web-fetch/jina-fetcher.ts | `JinaFetcher.fetch()` | 修改 | 同 zhipu：出站前经 pickWebFetch 决策 record/replay/真 | 同上 | design §4.3；代码 jina-fetcher.ts:88；决策 9 | +10/-2 |

> **coder 决策权（design §5.1/§9 标注开放点）**：session_hint 派生（als vs 显式透传）、buffer flush 触发时机（registry 内 vs commit 端点）、`llm` 与旧 `llm_mode` 是否映射合并——coder 可择优实现，偏离核心约束（决策 1/4 拦截层/按序回放）须报 orchestrator。

### C. test-only HTTP 端点

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| testing | app/server/src/testing/test-llm-mode-handler.ts | `handleTestLlmMode()` | 新增 | 处理 `POST /test/llm-mode {caseId,mode,recordingsDir}` → `getRegistry().setActiveCase(...)` → 200；非 test 二次 gate 404 | MUST 二次 gate（防绕过，对齐 session-run.ts:117）；MUST NODE_ENV=test | design §3；代码 handlers/session-run.ts:117 模式；决策 7 | +50 |
| testing | app/server/src/testing/test-llm-mode-handler.ts | `handleTestCommit()` | 新增 | 处理 `POST /test/llm-mode/commit {caseId,passed}` → registry.commitIfPassed（flush recordings）+ golden-recorder.captureGolden（PASS 时产 golden.json） | 若 coder 选 registry 内部 flush 则本 handler 可省（标 coder 定位）；MUST FAIL 不落盘/不产 golden | design §7/§16 coder 定位；决策 6；追加裁决 2.3 | +40 |
| router | app/server/src/router.ts | `dispatchRequestInternal()` — `/test/llm-mode` 分支 | 修改 | 新增 `if (path.startsWith('/test/llm-mode'))` 路由块：`NODE_ENV !== 'test' → 404`，否则派发 handleTestLlmMode/handleTestCommit | MUST 对齐现有 test-gate 模式（router.ts:393/416）；MUST NOT 进 prod surface | design §3；代码 router.ts:390-423；决策 7 | +12 |
| router | app/server/src/router.ts | import handleTestLlmMode | 修改 | 顶部 import 新 handler | — | 代码 router.ts:56-108 import 区 | +2 |

### D. bootstrap（registry 生命周期 — 若需 test 环境实例化钩子）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| bootstrap | app/server/src/bootstrap.ts | `bootstrapBuiltinPlugins()` | 修改 | test 环境（APP_ENV/NODE_ENV=test）确保 `getRegistry()` 懒建可用（registry 为模块单例，通常无需 bootstrap 改动——仅若需注入 dataDir 兜底 recordingsDir 时加） | MUST NOT 在非 test 建 registry；若 registry 纯模块单例则本行 no-op（标 coder 定位） | design §3/§12；代码 bootstrap.ts:126-251；决策 7 | +0/+6 |

> registry 设计为**模块级懒建单例**（`getRegistry()` 内 `process.env.NODE_ENV==='test'` 才建），`buildLlmClient` 直接 import 调用（对齐现有 `createMockFetch` import 范式），**优先不改 bootstrap**。D 行仅在 coder 发现必须经 bootstrap 注入 dataDir 时才动。

### E. tests 脚本（AT + ET 两套）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tests-at | tests/api/lib/run_case.sh | llm-mode + commit 路由块（新增段） | 修改 | 读 checkpoint `llm` 字段（缺省 replay）+ 判 recordings 存在 → 决 record/replay；`RECORD=1` 强制 record；`POST /test/llm-mode` 告知 server（caseId+mode+绝对 recordingsDir）；case 跑完按 last_run.result `POST /test/llm-mode/commit`（PASS 才 flush recordings+golden）；replay 时 golden 比对由 runner/server 侧执行（此处只接线路由） | MUST 展开 recordingsDir 为绝对路径（护栏§4）；MUST 保留现有 timeout_guard/custom.sh 分流/llm_mode gate；FAIL 不 commit | design §3/§7/§8/§16；代码 run_case.sh:38-62；决策 6/7；追加裁决 2.3 | +44/-2 |
| tests-at | tests/api/lib/run_case.sh | llm_mode=mock 分支（computer_use） | 修改 | `llm:mock` → server 该 case ROCKY_TEST_MOCK_LLM=1 走 legacy createMockFetch（修 computer_use 永久 SKIP） | MUST 13 computer_use case 从 SKIP 变实跑（决策 10 约束） | design §9；case-remediation E 组；决策 10 | +10 |
| tests-e2e | tests/e2e/lib/run_case.sh | llm-mode 路由块（新增段） | 修改 | 同 AT run_case：读 `llm` 字段 + `POST /test/llm-mode` + commit（ET=真后端+后端内回放，不 stub API/SSE） | MUST NOT stub ET 的 API/SSE（决策 8）；仅后端内 LLM 回放 | design §3/§8；代码 e2e/run_case.sh:32-46；决策 8 | +38/-2 |
| tests-e2e | tests/e2e/lib/runner.py | `_eval_expect()` | 修改 | fail 时 reason 串附带 actual 实际值（现只打期望关系如 `actual==True`，误导 triage——B 组 4 case 被误判「框架比较 bug」根因）；actual 过长截断（~200 字符） | MUST 保持既有 expect 语法/返回结构 `(ok,reason)` 不变，仅增强 fail reason 信息量 | states/v0.0.120.testing/verify/case-slim-plan-et.md「Orchestrator 裁决附注」；代码 runner.py:152-256（fail reason 175/178/185 等） | +6/-2 |
| tests-at | tests/api/lib/run_all.sh | 聚合 STATUS_MAP + counts | 修改 | 新增 `recording_drift` 分类（不算 fail、不翻 overall、单列计数提示重录）；对齐四分类框架 | MUST NOT 破坏现有 pass/fail/interrupted/not_run/skip 分类 + budget/skip-set/CASES | design §6/§12；代码 run_all.sh:253-268；决策 12 | +14/-2 |
| tests-e2e | tests/e2e/lib/run_all.sh | 聚合分类 | 修改 | 同 AT：加 recording_drift 分类（ET run_all 聚合处，与 AT 对齐） | 同上，不破坏 hard_fail/vision 分类 | design §6/§12；决策 12 | +14/-2 |
| tests-env | tests/test.env | `ROCKY_TEST_MOCK_LLM` 行 | 修改 | `ROCKY_TEST_MOCK_LLM=0` → `ROCKY_TEST_MOCK_LLM="${ROCKY_TEST_MOCK_LLM:-0}"`（默认语义，命令行 override 穿透） | MUST 显式参数 > 文件默认（决策 10）；MUST NOT 改 provider/model id 键 | design §8；代码 test.env:28；决策 10 | +1/-1 |
| tests-env | tests/test.env | 其他可 override 键（如需） | 修改 | 若 designer 发现别的键也被静默覆盖，同改 `:-default` 形态（coder 排查） | 仅改需 override 的键 | design §8 | +0/+3 |

### F. checkpoint schema + 文档

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tests-schema | tests/README.md | 「写 case」章节 — `llm` 字段 | 修改 | 新增 `llm: replay(默认)\|record\|off\|mock` 字段说明 + record/replay 生命周期 + recordings 目录格式 + RECORD=1 用法 + recording_drift 含义 | MUST 与 §9 枚举/§4 格式/§7 生命周期一致 | design §4/§7/§9；决策 5/6 | +40 |
| tests-schema | tests/README.md | 「写 case」章节 — `golden` 字段 + steps DSL | 修改 | 新增 `golden: on(默认)\|off` 字段 + golden.json 机制说明；steps DSL 新增 `run`/`save`/`create_session` step + `_case_lib.sh` helper 用法；`references`/`prd_path` 标可选 | 对齐 §14-§16 | design §14/§15/§16；追加裁决 2 | +40 |
| tests-schema | tests/README.md | env 优先级说明 | 修改 | 补「显式参数 > test.env 默认」+ ROCKY_TEST_MOCK_LLM override 用法 | 对齐 §8 | design §8；决策 10 | +8 |
| tests-schema | tests/README.md | 目录树 + 精简/录制流程 | 修改 | 目录树加 `recordings/{manifest,llm.jsonl,web_search.jsonl,golden.json}`（case 下）+ `app/server/src/testing/` 提及；补 case 精简准则 + RECORD_BATCH 全量录制流程 + new_case.sh/gen_case_md.sh 工具 | — | design §4/§10/§14/§17；追加裁决 1/2/3 | +16 |

### G. specs/api（test-only 端点文档）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| api-spec | specs/api/overall/04-agent-session.md | `POST /test/llm-mode` + `/commit` 端点章节 | 新增 | 追加 test-only 端点契约：body/响应/NODE_ENV=test gate/非 test 404/record/replay 路由 + commit 落盘用途 | MUST 标注「绝不进 prod surface」（对齐现有 test-only 端点标注） | design §18；代码对齐 §2.6.4 workspace test-only 范式；决策 7 | +28 |

### H. case 设计提速四件套（追加裁决 2）+ 全量录制驱动（追加裁决 1）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tests-dsl | tests/api/lib/_steps.py | `resolve/resolve_value/resolve_body/get_json_path/check_value/do_request/do_file_check` | 修改 | 从 runner.py 抽出这 7 函数到本新文件（行为等价，仅搬迁）；搬迁时核对 `check_value` fail note 已含 actual（`got {actual} want ...` runner.py:167/169/185，无 e2e 那种只打关系的问题——AT 侧无需增强，仅确认） | MUST 行为等价（存量声明式 case 不回归） | design §12；代码 runner.py:31-275（现 367 行超限） | +180/-160（净迁移） |
| tests-dsl | tests/api/lib/_steps.py | `step_run()` | 新增 | 新 step 类型 `run`：`{run:{content,providerId?,modelId?},sessionId?}` → POST /session/:id/run（复用 test-only 同步端点）→ messages/state/stopReason 存 ctx | MUST 复用现有 /run 端点，不自造 poll | design §15.1；代码 README「/session/:id/run」；追加裁决 2.2 | +34 |
| tests-dsl | tests/api/lib/_steps.py | `step_save()` | 新增 | `save:{var:"path"}` 命名变量抽取 → `{var.X}` 引用；向后兼容 `{stepN.path}` | MUST NOT 破坏现有 `{stepN.path}` 语义 | design §15.2；代码 runner.py:49-59 | +20 |
| tests-dsl | tests/api/lib/_steps.py | `step_create_session()` | 新增 | `create_session:{title?,...}` 简写 → POST /session + save sid | — | design §15.3；追加裁决 2.2 | +18 |
| tests-runner | tests/api/lib/runner.py | `main()` | 修改 | 瘦身：import `_steps` 编排 step 循环（含新 run/save/create_session 派发）+ golden 比对钩子（replay 后调 compareGolden，若 server 未内联比对则 runner 侧比对——coder 定位比对归属） | MUST 瘦身后 <300 行；MUST 保留 last_run.json 契约不变 | design §12/§16；代码 runner.py:278-362 | +30/-200 |
| tests-helper | tests/api/lib/_case_lib.sh | `rr_init/rr_fail/rr_skip/rr_new_session/rr_run/rr_assert_msg/rr_assert_tool` | 新增 | 泛化 _cu_lib.sh 通用父集：session 建/run/断言 helper，命令式 custom.sh source 复用 | MUST 对齐 _cu_lib.sh last_run 写法；MUST NOT 回退 computer_use 13 case | design §15；代码 tests/api/computer_use/_cu_lib.sh（成熟范式） | +80 |
| tests-helper | tests/api/computer_use/_cu_lib.sh | `cu_new_session/cu_run` | 修改 | 可选：复用 _case_lib.sh 的 rr_ 等价函数减重复（coder 定位是否合并） | MUST NOT 改 computer_use case 行为（13 case 不回退） | design §15 定位；代码 _cu_lib.sh:53-70 | +0/-20 |
| tests-tool | tests/lib/gen_case_md.sh | `gen_case_md`（脚本主体） | 新增 | 从 checkpoint.json 渲染 test_case.md（description/steps 摘要/checks/references?/prd_path?）；批量模式扫全库再生 | test_case.md 不再手写（追加裁决 2.1） | design §14；追加裁决 2.1 | +70 |
| tests-tool | tests/lib/new_case.sh | `new_case`（脚手架主体） | 新增 | `new_case.sh <module> <case_id> --template crud\|run\|sse` 生成预填 checkpoint 骨架（对应 template） | 生成骨架含必填字段（case_id/module/llm/steps 或 custom.sh 桩） | design §14/§15；追加裁决 2.4 | +90 |
| tests-tool | tests/RECORD_BATCH.sh | `record_batch`（驱动主体） | 新增 | 分波驱动 `RECORD=1 CASES=<批> run_all.sh`：按 module/lane 切批串行录制 + 汇总落盘 + 失败 case 单列重试清单 | MUST 串行录制（避 rate-limit）；仅本版本全量录制用 | design §10；追加裁决 1 | +90 |
| tests-schema | tests/api/lib/runner.py（checkpoint schema） | `golden` 字段消费 | 修改 | 已含 main()（上行）——读 checkpoint `golden`（缺省 on）决定是否比对 golden.json；`golden:off` 跳过 | 缺省 on；off 退出比对 | design §16；追加裁决 2.3 | （并入 main 行） |

## 影响面评估

- **跨模块**：server(testing 新模块含 golden-recorder + llm-client-factory + web_search + router + 可选 bootstrap) + tests(run_case/run_all AT&ET + test.env + README + DSL 拆分 _steps.py/runner.py + helper _case_lib.sh + 工具 gen_case_md/new_case/RECORD_BATCH) + specs/api。
- **破坏性变更**：无（运行时）。record/replay/golden 全 test-gate（非 test 环境 `pickFetchImpl` 返 undefined → 完全走真 fetch，prod 零影响）。legacy mock:* / @@cu directive 路径保留（决策 9），存量 144 case 的 `llm_mode` 字段不动。**runner.py 拆分是纯搬迁（行为等价）**——但改动面大，需波次 0 前跑全库现状基线做等价对比（design §11 风险）。
- **依赖顺序**（底层先于上层）：testing/types → recording-codec → recording-fetch/replay-fetch/golden-recorder → record-replay-registry → llm-client-factory 接线 + web_search 接线 → test-llm-mode-handler(含 commit) + router → tests DSL 拆分(_steps.py→runner.py) + _case_lib.sh + run_case/run_all/test.env → 工具(gen_case_md/new_case/RECORD_BATCH) → README/api-spec。
- **执行顺序（验证阶段，追加裁决 1/3）**：case 精简（§17，先删后录）→ 全量录制波次（§10，RECORD_BATCH 分波）→ 回放收口验证。精简/录制不属编码 task，属验证阶段 designer 工作（编码 task 只交付基建 + 工具）。
- **风险点**（详 design §11）：session_hint 派生稳定性；指纹规范化确定性；Bun AsyncLocalStorage 可用性；SSE tee 不破坏业务流式消费；**golden 剔除平衡（不足→假 fail / 过度→空壳）**；**runner.py 拆分等价性**；全量录制耗时/rate-limit；精简误删覆盖。
- **单文件 ≤300 行**：testing/ 七文件均预估 <250 行（design §12 拆分，含 golden-recorder ~200）；**runner.py 现 367 行超限 → 必拆 _steps.py（design §12）**，拆后 runner ~120 + _steps ~250；run_case.sh 现 68 行加 44 仍 <150。新工具脚本各独立文件 <100 行。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列如 stub 了 ET 的 API/SSE、密钥落 recordings、影响行严重偏离）→ 退 coder。
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计。
- coder 按代码实际调整引用符号（spec↔code 漂移）+ 汇报偏离 → orchestrator 记 doc-sync → doc-modifier 阶段 5 统一修 spec。

## 实现偏离注记（doc-modifier 阶段 5 收口 — 相对本表的实际实现调整）

- **Row92/94（run_case.sh AT+ET 的 llm-mode/commit 路由块）→ 抽到共享 `tests/lib/llm_mode.sh`**：本表原写「run_case.sh 新增段」，实现时 code review（去重）把 llm-mode setup + commit + drift/golden 改写逻辑**抽到共享库 `tests/lib/llm_mode.sh`**（AT 与 ET 的 run_case.sh 各 `source` 后调 `llm_mode_read_fields` / `llm_mode_setup` / `llm_mode_commit`，见 `tests/api/lib/run_case.sh` L29/40-41/78 + `tests/e2e/lib/run_case.sh` L24/38-39/58）。原因：AT/ET 两份 run_case 的路由块 90% 重复，抽库消冗余（对齐单一职责）。契约不变（读 `llm`/`case_id` 字段 → POST /test/llm-mode → 跑 case → POST commit）。已在 `tests/README.md` 记该共享 lib。
- **Row76（handleTestCommit）drift 接缝**：本表原写 commit「flush recordings + captureGolden」，实现时补齐 **drift 回传**：commit 响应带 `drift:{detected,events}`，脚本侧 `llm_mode_commit` 据此改写 last_run=recording_drift（drift 优先于 golden）。详见 design §6 drift 接缝契约。
