---
type: log
title: Observability KB 变更记录
updated: 2026-08-15
---

# Observability KB 变更记录（ISO 倒序，最新在前）

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-08-15 · v0.0.354（tool span 时长修复 — start 逐个化不含排队）

- **`[P0]observability_interface.md §5.4`**：`ToolSpanMetadata.durationMs` 注释补语义——真实执行时长（startToolSpan 逐个化：startTime=该 tool 串行开始时刻，即上一 result 完成时刻；不再被批量预起的 t0 拉长到含批内排队等待）。接口/字段零变化，仅语义注释。
- 详情：`specs/tech/version_logs/v0.0.354/change_log.md`

## 2026-08-15 · v0.0.353（Langfuse 逻辑/物理两层语义校准）

- **`[P0]observability_interface.md §5.1 TraceMetadata`**：增 `routingPlan?: { planId, planName? }`（有方案才带，记录 run 级生效方案快照）。
- **`[P0]observability_interface.md §5.2 GenStart/GenMetadata`**：增 `routingPlan`（logical/ skipped gen 携带）、`providerId/providerName`（physical 真实；logical 显式 null）、`logicalView`（A1 治理）、`skipped/skipReason`（D9 被跳候选成对 gen 标记）。
- **`[P0]llm_caller.md §2.1`**：`ObservabilityPort` 注释补 `recordAttemptTarget` / `recordSkippedCandidate`。
- 详情：`specs/tech/version_logs/v0.0.353/model-routing-trace-correctness/change_log.md`

## 2026-08-05 · v0.0.258（episode 落 performance.log — 修 prod console 蒸发）

- **新增 `hang-sink.ts`**（`app/server/src/observability/hang-sink.ts`，~68 行）：模块级 sink 模块（同 `slow-query.ts` 范式）。export `HangRecord`（type 别名，含 `kind:'hang'` + `phase:'enter'|'recover'` + `source` + enter 阶段的 metric 字段 lagMs/cpuUserMs/cpuSysMs/elu/profileFile 均 optional）+ `HangSink` 回调类型 + `setHangSink()` 注册函数 + `reportHang()` 上报通道（sink 为 null 零短路）。
- **event-loop-monitor.ts 双写**：tick() episode enter 分支在 `log.warn` 后调 `reportHang({kind:'hang',phase:'enter',source,lagMs,cpuUserMs,cpuSysMs,elu,profileFile})`；episode recover 分支在 `log.info` 后调 `reportHang({kind:'hang',phase:'recover',source})`。console 保留（dev 即时反馈）+ LogWriter sink（文件落盘，受 `enablePerformanceLog` 门禁），不互斥。
- **bootstrap.ts 注入**：`setHangSink(record => logWriter.write('performance', record))`，紧接 `setSlowQuerySink`（L327），同一 logWriter 实例 + 同 performance 通道。
- **slow-query.ts 加 `kind:'slowquery'`**：SlowQueryInfo type + queryWithSlowLog 构造对象均加 `kind:'slowquery'` 字段，与 HangRecord 的 `kind:'hang'` 对称——`grep kind:` 统一筛 performance.log 不同来源记录。
- **`[P1]hang_monitor.md` 同步**：§1 与外界交互补 performance.log 落点；§2 episode 状态机补 reportHang 描述；§3 新增 §3.8（sink 模块 + console 双写 + HangRecord 字段表 + 零开销短路）；§4 补 performance.log JSONL 示例 + `grep kind:hang` 用法；§5 边界加 hang-sink.ts + bootstrap 注入行。
- **`index.md` §④** 原则 8 末尾补「episode 经 hang-sink.ts 双写 console + performance.log（kind:hang）」并更新引用至 §3.8。

详情：`specs/tech/version_logs/v0.0.258/change_plan.md`

## 2026-08-04 · v0.0.254（跨三进程卡顿自动监控埋点 — hang monitor 首落地）

- **新增 `[P1]hang_monitor.md`**：跨三进程（server / electron 主进程 / renderer）事件循环卡顿自动抓捕能力，与 trace 树链路人格独立。核心实现 `app/server/src/observability/event-loop-monitor.ts`（`startEventLoopMonitor`：`perf_hooks.monitorEventLoopDelay` 周期采样 lag + 超阈值触发 `node:inspector` CPU profile 写盘 `<dataDir>/profiles/<source>-<ts>.cpuprofile`）。
- **三进程开关与接线**：server = `EVENT_LOOP_MONITOR=1`（默认关），接线 `http-server.ts startServer()` listen 回调（非 bootstrap——bootstrap 懒加载覆盖不到启动期卡顿）；electron 主进程 = `MAIN_EVENT_LOOP_MONITOR=1`（默认关），经 `app/electron/src/main-event-monitor.ts` 在 `main.ts` loadRuntimeConfig 后调用（独立 env：packaged 下后端内嵌主进程采样同一条 event loop，共用会对一次卡顿写两份 profile）；renderer = `VITE_LONGTASK_MONITOR`（dev 默认开 / prod 默认关），`app/web/src/lib/longtask-monitor.ts`（PerformanceObserver longtask + long-animation-frame），`main.tsx` 首屏前调用。
- **⚠️ Bun runtime 局限（实测，§3.2 醒目标注）**：dev(Bun 1.3.14) 下 server 侧 monitorEventLoopDelay 对真实阻塞不敏感（阻塞 1s/3s 恒报 ~2ms）+ inspector Profiler.stop 只返 ~3 空壳 node → **server 侧 lag/profile 仅 packaged(Electron Node) 有效**；已用真机 /Applications/rocky_agent.app（Electron 42/Node 24）实证（阻塞 1500ms→测得 1518ms、profile 含真实调用栈）。renderer longtask 与 electron 主进程 lag 两条路 dev/prod 均有效。
- **设计要点**：episode 闸（一次卡顿只抓一次、回落复位）+ profileInFlight 闸（在飞 profile 限一个）；失败静默红线（特性检测 + 全 try/catch，监控绝不影响启动/主流程）；开关关时近零开销（不建直方图不启 timer）；写盘走 resolveDataDir（BUG-004 护栏，禁字面 ~）。
- **`index.md` 同步**：① 是什么补第三条独立链路 + 概念表加 HangMonitor 行；② 边界表加卡顿监控行；④ 加第 8 条核心设计原则（失败静默 + Bun 局限）；⑤ 导航加「卡顿监控」分区链到 `[P1]hang_monitor.md`。
- re-export：`app/server/src/observability/index.ts` → `app/server/src/index.ts`（electron 侧经 `@app/server` 包名值导入）。

详情：`specs/tech/version_logs/v0.0.254/change_log.md`

## 2026-07-14 · v0.0.138（LangfuseAdapter → LangfuseEventQueue 有界队列 + drop-new — 核心红线强化）

- **`[P0]langfuse_adapter.md §2` 重写（SDK 接入 → SDK 接入 + LangfuseEventQueue）**：SDK 调用不再由 LangfuseAdapter 直接发起，全部经新文件 `langfuse-event-queue.ts` 的 **LangfuseEventQueue**。重构动机：langfuse SDK 攒 2.6MB batch + 高频 squad 活动致后端阻塞。新机制：start 方法 enqueue create-op（同步生成 handle.id，caller 立即可用）+ end/setLevel enqueue update-op + 单 consumer async loop 批处理（批间 `await sleep(250ms)` yield，memory `async-marked-fn-sync-io-blocks-eventloop`）；consumer FIFO 保证 parent op 先于 child op 处理（`resolveParent` 必命中）。
- **`§2` 500MB byte buffer + drop-new**：`MAX_BUFFER_BYTES=500MB`（用户硬上限），enqueue 估算 op size → 超限 drop new（FIFO 丢新保老）+ 节流 warn。observability 旁观者，drop = 缺一段 trace，不影响业务。
- **`§2` 核心红线三层守卫**：(1) adapter `start*/end*/setLevel` 全包 try/catch + `warnSuppressed` 模块级函数（**非类方法**，保「observability 失败 console.warn debug 级」契约）；(2) consumer `_apply` try/catch 吞 SDK 错误；(3) enqueue 同步不 await（fire-and-forget），start/end 同步返 Handle。
- **`§2` SDK 状态迁入队列**：`traces/obs/genKind` Map 从 LangfuseAdapter 迁入 LangfuseEventQueue（consumer 维护，key/value 语义不变）；LangfuseAdapter 瘦身到 ~230 行（API 表面 + handle 生成 + op 构造）。
- **`§3` shutdown 改 `drainAndShutdown`**：`while (q.length>0 || writing) && Date.now()<deadline: await sleep(20)` → `await client.shutdownAsync()`。**drain 先于 shutdownAsync**（兑现 flush 契约，防丢未处理事件）。`writing` flag 抄 `log-queue.ts` 修 race（consumer splice 出队后才 _apply，q.length===0 ≠ apply 完成）。5s deadline 防 hang。
- **`§4` 接口映射表 + startGeneration/endGeneration 代码改 enqueue 路径**：表头补「consumer `_apply` 实际发起的 SDK 调用」说明；代码示例改 `this.queue.enqueue(op)` + try/catch + warnSuppressed。
- **`§4` genKind 时序偏离记录（已 sound）**：genKind 不能在 consumer `_apply` 处理 create-gen 时才 set（endGeneration 可能在 consumer 处理 create-gen 前被调 → 误按 logical 处理 physical gen）。修复：`LangfuseEventQueue.enqueue` 内对 create-gen **同步 set genKind**（入队前），`getGenKind(id)` 返 `genKind.get(id) ?? 'logical'`。
- **`index.md` 概念表加 LangfuseAdapter（API 表面）+ LangfuseEventQueue 两行 + §③ ASCII 反映 queue 链路 + §④ 加第 7 条核心设计原则（LangfuseEventQueue async consumer loop + 500MB drop-new + 核心红线三层守卫 + drainAndShutdown）**。
- **公共 API 零变化**：`LangfuseAdapter` 构造参数 + `start*/end*/setLevel/shutdown` 签名不变；`ObservabilityManager` 只用公共 API，零变化。行为变化：trace 落到 langfuse backend 有 ≥250ms 延迟（队列批处理）+ 队列满 drop new（observability 旁观者，不影响业务）。

详情：`specs/tech/version_logs/v0.0.138/change_plan.md`

## 2026-07-06 · v0.0.78.bug（trace name 加 modeKey 段 — forked 用途一目了然）

- **`buildTraceName` 加第 4 参 `modeKey?: string`**（`agent-loop-helpers.ts`）：modeKey 非空且 ≠ 'current' → kind 段拼后缀 `${kind}[${modeKey}]`（紧贴 kind 不加空格）；modeKey 缺省 / ='current' → 退原格式（main loop 视觉零回归）。
- **`LoopObservabilityOpts.modeKey?`**（`agent-loop-observability.ts`）：optional 字段，注释指明来源（forked='summary'|'memory_extract'，main='current'|undefined）。
- **main 显式 'current'**（`build-deps.ts`）：main loop 构造 LoopObservability 时显式传 `modeKey: 'current'`（langfuse UI 区分 main vs forked）。
- **forked 透传 caller modeKey**（`build-forked-deps.ts`）：opts.modeKey = BuildForkedDepsOpts.modeKey（caller 决定：compact='summary' / tier1 consolidation='memory_extract'），不二次推导。
- 例：`studio-leader[summary] 01KWBPa3 helloworld`（forked compact）/ `studio-leader[memory_extract] 01KWBPa3 ...`（tier1）/ `studio-leader 01KWBPa3 helloworld`（main，退原格式）。
- 同步 `[P0]observability_interface.md §5.1` TraceStart.name 字段补 modeKey 段语义。

详情：`specs/tech/version_logs/v0.0.78.bug/change_log.md §T3`

## 2026-07-05 · v0.0.68（setLevel 接口 + LangfuseAdapter metadata.errorLevel 等价机制 — R7 langfuse trace level）

- **`ObservabilityAdapter` 加可选 `setLevel` 接口**（`[P0]observability_interface.md`）：`setLevel?(h: TraceHandle | SpanHandle | GenHandle, level: ObservabilityLevel): void`——按 handle.kind 分支落盘。adapter 可选实现（不支持时 LoopObservability.safe 吞 + warning，不阻塞 run）。
- **`ObservabilityManager.setLevel` fan-out**（`[P0]observability_manager.md`）：composite 把 setLevel 翻译成 per-child handle（`resolveParentPerChild` 模式，与 startGeneration/endGeneration 一致）后调 child.setLevel。
- **`LangfuseAdapter.setLevel` 按 handle.kind 分支**（`[P0]langfuse_adapter.md` §4 setLevel 段）：
  - `trace` 类型走「等价机制」——langfuse `ApiTraceBody` schema **无 level 字段**，SDK `trace.update({level})` silently 被后端忽略；改 `trace.update({metadata: {errorLevel: level}})`（metadata deep-merge 不覆盖原字段，可被 GET /traces/{id} 查询）。**关键**：trace 顶层**没有** level 字段，必须走 metadata.errorLevel 等价表达。
  - `span` / `generation` 类型——observation schema 支持 level，直接 `o.update({level})` 落盘。
- **`LoopObservability.markTraceError(reason)`**（`agent-loop-observability.ts`）：run 失败路径调，内部走 `safe('markTraceError', () => adapter.setLevel(traceHandle, 'ERROR'))`；adapter 不支持 setLevel 时 safe 吞 + warning（D7 标注）。**endTrace 签名不变**（避免破坏 4+ 调用点 + 测试）——markTraceError 与 endTrace 是正交的两个方法。
- **关联**：BUG-001（langfuse trace.level=None）根因即此——v0.0.68 起草时 spec 写「trace level=ERROR 落盘」未察觉 ApiTraceBody schema 限制；改走 metadata.errorLevel 等价机制后 trace_level=ERROR pass（commit 03c1b9a8）。llm_caller/log.md v0.0.68 条目同步对齐。

详情：`specs/tech/version_logs/v0.0.68/change_log.md` §R7

## 2026-07-04 · v0.0.61（key 名对齐协议 — cache/reasoning snake_case）

- **mapUsageDetails key 名对齐 langfuse-usage-protocol**：cache/reasoning key 从自造 camelCase 改为 langfuse Anthropic 原生 snake_case（对齐 `reqs/v0.0.61.langfuse_opt_v1/langfuse-usage-protocol.md` §二/§四，匹配 langfuse 内置 model pricing + 官方示例）：
  - `usageDetails.inputCacheRead` → `cache_read_input_tokens`（Anthropic 同名）
  - `usageDetails.inputCacheCreation` → `cache_creation_input_tokens`（Anthropic 同名）
  - `usageDetails.reasoning` → `output_reasoning_tokens`（OpenAI flatten 名，§四.2）
- **值不变 / 防双计语义不变**：input/output key 不动；fallback 用 total 不传 cache key 不变；值为 0 跳过逻辑不变。
- 影响范围：`langfuse-metadata.ts`（impl + JSDoc）+ `langfuse-adapter.ts`（顶部注释）+ 5 个单测断言 + API case `langfuse_usage_cache_tc1/`（checkpoint.json canonical 断言 + run.sh python 校验逻辑 + test_case.md 字段映射表）+ `[P0]langfuse_adapter.md §6`（映射表 + fallback 段 + 代码块 + 新增 canonical 命名段）。
- 详见 `specs/tech/version_logs/v0.0.61/change_log.md §6`。

## 2026-07-03 · v0.0.61（trace 命名修复 + usageDetails 防双计）

- **trace 命名修复（unnamed-trace）**：`LoopObservabilityOpts` 加 `sessionKind?: string`（SessionKind.toolPolicyRole 可读标签）；`build-deps.ts` / `build-forked-deps.ts` 构造 LoopObservability 时传 `sessionKind: config.kind?.toolPolicyRole`；新增纯函数 `buildTraceName(sessionKind, sessionId, triggerMessages)`（落在 `agent-loop-helpers.ts`，**非** LoopObservability 私有方法——因主文件已超 300 行拆出）拼 name = `${kind} ${sid.slice(0,6)} ${inputText.slice(0,10)}`（kind = sessionKind ?? `'session'` 兜底；inputText 从 triggerMessages 提取首条 user 消息所有 TextBlock.text 拼接、`\s+`→单空格 trim、slice(0,10)；无 user 消息则空串）；`LoopObservability.startTrace` 调用 buildTraceName 后透传 `adapter.startTrace({id, sessionId, name, input, metadata})`。`LangfuseAdapter.startTrace` 不变（已条件透传 name，TraceStart.name optional 已存在）。
- **usage 映射改 `usageDetails`/`costDetails`（防双计核心）**：`mapUsage` → `mapUsageDetails`（返 `{usageDetails: Record<string,number>, costDetails: Record<string,number>}`）。语义决策：langfuse UI 求和含 "input" 子串的 key；anthropic `input_tokens` 不含 cache（实测 input_tokens=1123 + cache_read=128 = total=1251）→ 必须传互斥不重叠拆分，绝不能 input=grand total 又加 cache key。fallback：优先用拆分（input_no_cache/input_cache_read/input_cache_write 任一非 null → 拆分路径，值为 0 的 cache key 跳过），三者全缺才用 input_total_tokens 兜底且不传 cache key。输出同理（output_response/output_reasoning vs output_total_tokens）。costDetails: `cost!=null ? {total:cost} : {}`（保留 LlmClient.computeCost 应用定价权威）。`endGeneration` 改 `upd.usageDetails/costDetails`（physical 路径 `mapUsageDetails({})` 全 0）；`total/unit/charCount/currency` 不再落 langfuse。
- 文档更新：`[P0]langfuse_adapter.md §4` endGeneration 行 + §6（整章重写为 mapUsageDetails）；`[P0]observability_interface.md §5.1` TraceStart.name 补语义。
- `langfuse-metadata.ts::mapGenMetadata` 中 `cacheReadTokens`/`cacheWriteTokens` 字段保留（GenMetadata 类型契约不删，避免连锁改），仍写进 generation metadata，无害冗余。

详情：`specs/tech/version_logs/v0.0.61/change_log.md`

## 2026-07-02 · v0.0.50（双 generation + logPhysical 开关 + physical kind 分支）

- `GenStart` 加字段 `kind?: 'logical' | 'physical'`（默认 logical）+ `physicalInput?: unknown`（wire body 载荷）+ `name?: string`（`llm-N-logical` / `llm-N-physical`，adapter 优先用 caller 传入）；`GenMetadata.physicalWireBody` 标 `@deprecated`（停写，写路径改走独立 physical generation）。
- `[P0]observability_interface.md §4` 时序补 physical 分支（startGeneration physical → endGeneration 无 usage/output）；§4.1 新增「双 generation」段（logical + physical 同 step、同 N，物理方法归属 `LangfuseObservabilityPort` 而非 `LoopObservability`——避 `llm/caller→agent` 依赖循环）；§5.2 GenStart/GenMetadata 字段对齐。
- `[P0]langfuse_adapter.md §4` startGeneration/endGeneration 按 kind 分支（physical：input=physicalInput、metadata.physicalWire=true、endGeneration mapUsage({})→total=0、不传 output）；name fallback `llm-physical`/`llm`。
- `[P0]observability_manager.md` ChildEntry 加 `logPhysical: boolean`（来自 item.logPhysical ?? false）+ §5.3 fan-out 过滤（physical kind 仅 fan-out 到 logPhysical=true child）+ `hasPhysicalChild(): boolean` 能力探测（manager 暴露给 LangfuseObservabilityPort 用）。
- 命名格式（§4.3）：logical=`llm-N-logical`，physical=`llm-N-physical`（N=genIteration，每轮 LLM 递增；AT case 硬要求此格式）。
- 与 message/llm 子系统联动：v0.0.50 起 logical generation input.messages 经 `toLogicalMessages` 展平（sender 已变文本前缀），与 LLM 真正看到的 input 一致；physical generation input.messages = wire body（protocol.encode 后）。
- **doc 阶段订正**：原 tech change_log §2.4 把物理方法列在 `agent-loop-observability.ts`（过度规约），实际在 `LangfuseObservabilityPort`（llm/caller/）——见 change_log §2.4 更新说明 + interface §4.1 归属说明。

详情：`specs/tech/version_logs/v0.0.50.sender_data_format/change_log.md`

## 2026-06-30 · v0.0.35

- OKF KB 化：建 `index.md`（5 章总起，76 行）+ 本 `log.md`。
- `[P0]overall.md` 按类拆流：overview/概念表/边界/导航 → index；接口契约 + 全量字段 + 埋点契约 + oracle 拆出独立成 `[P0]observability_interface.md`（正文对齐 docs_guide §2，补 §1 概述强约束）；原 overall.md 归档 soft_deleted。
- 3 文件加 YAML frontmatter（`type`/`title`/`priority`/`status`/`updated`/`since`）。
- 正文清理 inline `[vX.Y]` / `[vX.Y modified]` 噪声 + 顶部 `> version:` blockquote + 尾部 `## 版本` 段，迁移到 frontmatter `since` 或本 log。
- 修正 spec 错误：`observability_manager.md §10` 文件级清单 `manager.ts` → 实际 `observability-manager.ts`（对齐代码现状）。
- manager.md / langfuse_adapter.md 内 `[P0]overall.md §5/§6` 引用 → 改指 `[P0]observability_interface.md §5/§6`。

## 2026-06-12 · v0.0.24（langfuse 作为验证 oracle）

- 新增「langfuse 作为验证 oracle」用途：oracle 前提（激活）+ 三类断言（内容一致性 / 工具结果保真 / 多轮 generation）+ 可复用 lib（`langfuse_verify.py` / `langfuse_setup.sh`）+ 流程嵌入 api-verifier。
- observability 接口 / 字段 / 激活机制零改动，仅补 oracle 用法视角。

详情：`specs/tech/version_logs/v0.0.24/change_log.md`

## 2026-06-09 · v0.0.11（single → list + Manager + 移除 ENV）

- ObservabilityManager composite adapter 新增（实现 ObservabilityAdapter，持 child 列表 fan-out）。
- observability 配置 single 对象 → **列表**（`dev_config.runtime.observability` = `ObservabilityConfigItem[]`）；**移除 ENV 兜底**（`LANGFUSE_*` 不再读），纯 dev_config 列表驱动。
- §4.1 补双层 handle id 空间 + `resolveParentPerChild`（BUG-001 根因修复：parent 必须按 child 翻译，否则 generation/tool span 静默丢失）。
- per-item 独立 Langfuse client（不同 baseUrl/凭证隔离 batch queue）；bootstrap 构造不热更新（改列表重启 / 下个 session 生效）。

详情：`specs/tech/version_logs/v0.0.11/change_log.md`

## 2026-06-09 · v0.0.10（LangfuseAdapter 首落地）

- LangfuseAdapter 首个真实 backend（langfuse TS SDK，异步 batch）；NoopAdapter 默认。
- env var convention（`LANGFUSE_BASE_URL` 主 / `LANGFUSE_HOST` 兜底）+ flush 双触发（node SIGTERM/SIGINT + electron before-quit，不再依赖存活延迟）。
- 全量字段映射（§5）：adapter 字段 → langfuse input/output/metadata/model/usage 逐项落。

详情：`specs/tech/version_logs/v0.0.10/change_log.md`

## 2026-06-09 · v0.0.10 pre（接口契约确立）

- ObservabilityAdapter 接口（startTrace/endTrace/startGeneration/endGeneration/startSpan/endSpan/shutdown）+ 概念对齐（trace↔run / gen↔LLM / span↔step|tool）+ step span 嵌套 + per-session 注入 + loop 显式调用 + 同步语义（loop 不 await，仅 shutdown 异步）。
