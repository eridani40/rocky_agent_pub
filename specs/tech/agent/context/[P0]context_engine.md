---
type: interface
title: Context Engine（总纲）
priority: P0
status: active
updated: 2026-08-04
since: v0.0.8
---

# Context Engine

> 参见 `[P0]context_snapshot_interface.md` 了解 ContextSnapshot 定义，`../agent_interface_and_loop/[P0]agent_loop_eager_drain.md` 了解调用时机，`../agent_interface_and_loop/[P0]agent_manager.md` 了解 SessionConfig 定义。
>
> 各方法的详细语义见同目录 detail 文档（§5 索引）。

> **当前形态**：ContextEngine **plugin 化完成**——构造注入 `PluginManager`，`ingest` / `assemble`（system prompt 由 context-engine 独立调 builder，design §1.3）/ `system_reminder` 由 `PluginManager.getExtensionImpls(pointId, scopeId)` 驱动跑 ordered 链（**10 个 context EP：7 ordered + 3 exclusive（含 v0.0.66 新增 `session_store` exclusive）+ 43 个 `rocky_context` builtin impl**，见 `[P0]extension point and implementations.md`）。`compact` 用 forked agent（S2，见 `[P0]context_compact_detail.md`）；**[v0.0.40]** compact 触发经 `tryCompact` 胶水 + 2 exclusive EP plugin 化（见 §2c），源/汇可注入（D1=B，见 §3.6）；**[v0.0.66]** session store 也 EP 化（`SessionStorePoint` exclusive，default→`persistent_session_store` / forked→`in_memory_session_store`），主干 ingest/assemble 零 `isForked` 分支，纯 scope 驱动。
>
> **历史基线（v0.0.8 简化版）**：v0.0.8 落地的是 **简化版** ContextEngine，三接口实现口径：
> - `ingest` = **仅 append 进 transcript**（不走 ordered handler chain / truncate / offload）。
> - `assemble` = **单 mapper 读全 transcript**；有 summary 则 `head 3 + tail 3 + recent`；ratio 常数 1.0。
> - `compact` = 裸 `client.call`（不用 forked agent）。
>
> v0.0.8 简化逻辑在 v0.0.13 下沉为 builtin impl 的默认 config 兜底（design [D1.2]：append-only ingest → ordered chain 兜底；head3+tail3 → `base_builder` 默认 headMin2/headMax5/fraction0.05；ratio 1.0 → ratio 学习 S3 未激活前 fallback 1.0，但走真链路）。历史实现路径见 `specs/tech/version_logs/v0.0.8/change_log.md` §5。

## 1. 概述

ContextEngine 管理 Agent 的上下文生命周期：消息 ingest、snapshot 组装、历史压缩、usage 统计。

它是 Agent Loop 的核心协作组件——loop 每个阶段产出消息后都交给 ContextEngine 处理。

**设计原则**：
- **方法级 session context**：每个方法显式接收 `config: SessionConfig` 作为 session context（含 `sessionId`、`model`、`systemPrompt`），不依赖实例持有的隐式状态。
- **基础设施依赖走构造函数**：`store`（transcript 持久化）等无状态基础设施由构造函数注入，跨 session 复用同一实例。
- **消息落库后不可变**：进入 transcript 后不可修改，仅在 `allowEdit=true` 时允许按 id 覆盖。ingest 链（落库前的预处理）可改写待入库 message（如 truncate handler 截断），见 `[P0]context_ingest_detail.md` §4。

---

## 2. SessionContext —— 复用 SessionConfig

ContextEngine 需要的 session 维度信息（`sessionId` 圈定 transcript 范围、`client` 提供 contextWindow（tokenLimit）、`systemPrompt` 作为 snapshot 的 system）全部已包含在 `SessionConfig` 中（token 估算用 session ratio，ContextEngine 自持，不经 client，见 context_usage_detail §4），因此**直接复用 `SessionConfig` 作为 session context**，不另造类型。

```typescript
// 见 [P0]agent_manager.md §2，此处仅列出 ContextEngine 实际读取的字段
interface SessionConfig {
  sessionId: string;        // ✅ ContextEngine 用于圈定 transcript 范围
  systemPrompt: string;     // ✅ assemble() 时作为 snapshot.system（由 system_prompt mapper/reducer 构建，见 [P0]system_prompt.md）
  client: LlmClient;        // ✅ 提供 contextWindow（tokenLimit 来源）；token 估算用 char×ratio（ContextEngine 持 session ratio，见 context_usage_detail §4），不经 client
  tools?: Tool[];           // ⬜ ContextEngine 不读取（仅 assemble 时透传 tool 定义给 snapshot）
  // maxIterations / permissionRules / middlewares —— ContextEngine 不读取
}
```

> 约定：后续所有方法签名中的 `config: SessionConfig` 即代表 session context。

---

## 3. 接口定义

```typescript
/**
 * ContextEngine 是无业务状态的协调组件：
 * - 构造函数注入基础设施（store / session_store EP 解析见 §3.6）
 * - 每个方法接收 config: SessionConfig 作为 session context
 * - 同一实例可服务多个 session
 */
interface ContextEngine {
  /**
   * 将消息 ingest 到 transcript = ordered handler chain（链尾 store_sink 写 store）。
   * - ① ordered chain（EP context_ingest_handler）：经 PluginManager.getExtensionImpls(point, scopeId) 拿 active handler（见 §3.5/§3.6），逐个 transform messages（如 truncate）
   * - ② sink impl（chain 尾 `store_sink`）：`ctx.store.appendMessages(sessionId, messages)` 写 store
   * - 落库后不可变（allowEdit=false 撞 id → DuplicateMessageIdError）
   * - [v0.0.66] 删 buffer 参数 + 删 if scopeId 硬尾：store 按 scope 选中 EP impl（default=`persistent_session_store` 持久 / forked=`in_memory_session_store` 内存），统一注入 store_sink；default/forked 同一套主干逻辑（design §1）
   * 详见 [P0]context_ingest_detail.md
   *
   * 实现（context-engine.ts:146）：`scopeId` 默认 `'default'`；`allowEdit` 当前忽略（前缀 `_`）；`store = this.resolveStore(scopeId)`（v0.0.66 session_store EP）。
   */
  ingest(config: SessionConfig, messages: MessageInput[], scopeId?: string, allowEdit?: boolean, opts?: StoreCallOpts): Promise<void>;

  /**
   * 组装 LLM 上下文快照 = mapper/reducer 双 ordered EP（v0.0.13 起由 PluginManager 驱动，见 §3.5）。
   * - mapper（context_assemble_mapper）读数据源（transcript / summary）—— default + forked 都用 transcript_reader/summary_reader（store EP 按 scope 切实现）；v0.0.173 删 prev_snapshot mapper（rebuild 不再需要 prevMessages）
   * - reducer（context_assemble_reducer）= base_builder（v0.0.173 永远 rebuild，确定性纯函数 f(summary,transcript)；6 清理 reducer 迁到 context_clean_view_reducer EP 由 getCleanSnapshot 跑）
   * - cache 友好：rebuild 是确定性纯函数，summary 版本不变 + transcript 无 HITL 更新 → 同输入同输出 → wire bytes 稳定 → prompt cache 命中（详见 [P0]context_assemble_detail.md §2）
   * - 不调用 LLM；产出 ContextSnapshot 供 LLM 调用（caller 经 getCleanSnapshot 跑清理视图后再喂 LLM）
   * - 产出 snapshot 后内部调 store.updateContextWindowUsage（forked in_memory store no-op，不污染主对话）
   * - scopeId 透传：决定 store EP impl（持久 vs 内存）
   * - [v0.0.66] 零 isForked：default/forked 同一套主干逻辑，差异靠 store EP impl + scope EP impl 切换（design §1）——reducer 层 default 选 base_builder、forked 选 forked_builder
   * - [v0.0.178] forked 用 forked_builder（复用固定 parentSnapshot.messages + summaryUpTo 后 in_memory 增量 upsert，非 rebuild）：主干 `ContextEngine.assemble` 零 forked 分支，差异靠 `context_assemble_reducer` EP 按 scope 选 impl 切换（forked.yaml 激活 forked_builder / default.yaml 激活 base_builder）。多轮正确性靠 caller 传固定 `state.parentSnapshot`（LoopState 字段，wireInitState 整 run 设一次）作 prevSnapshot——不能用每轮漂移的 `state.snapshot`（否则 [...prev, ...transcript] 重复 reminder/userMessage）。sys 由 assemble 复用 parentSnapshot.system。
   * - [v0.0.66 §1.3] system prompt 独立：删 system_prompt assemble impl，system 由本方法独立调 buildSystemPrompt（复用规则：!prevSnapshot.system || summary.version 变 → 调 builder；否则用 prevSnapshot.system；messages 不参与此判定恒 rebuild）
   * - [v0.0.204 C2] buildSystemPrompt 透 scopeId + async：`await buildSystemPrompt(pluginManager, config, scopeId)`——mapper/reducer 链按 scopeId 取 impl 列表（scope 级覆写生效；此前恒走 default scope 致 scope yaml system_prompt 覆写全死）；async 因 mapper 链可能含 async impl（如读 store），sync 迭代 Promise 被降级 catch 吞掉输出
   * - [v0.0.52 P2-3] 动态 ratio：读 `store.getRatio` 注入 ctx，base_builder pickWindow 用（与 computeContextWindowUsage 同源，冷启动 fallback 1.0；forked in_memory store 恒返 1.0）。
   * 详见 [P0]context_assemble_detail.md
   *
   * 实现（context-engine.ts:177）：`scopeId` 默认 `'default'`；`prevSnapshot?` main 路径透传 `state.snapshot`，forked 透传**固定 `state.parentSnapshot`**（v0.0.178）；`store = this.resolveStore(scopeId)`（v0.0.66 session_store EP）；`summary = await store.getSummary(sessionId)`（forked 恒 null）；`ratio = await store.getRatio(sessionId)`（动态）。
   *
   * [v0.0.83.forked_per_run_isolation] `opts?: StoreCallOpts`（含 `runId`）：消息缓冲类方法（appendMessages/getMessages/releaseSlot）按 run 隔离的 per-call 参数。
   *   session(sid) + run(runId) 是通用领域 id；forked 路径 caller 传 `{ runId }`（每个 forked run 独立 buffer 桶，sibling 不混），default 路径不传（persistent 按 sid）。session-meta 方法（getSummary/getRatio/updateContextWindowUsage）与 run 无关，不接受 opts。`slot` 只是 in_memory impl 内部概念（桶 key=runId），不出现在本接口。详见 `specs/tech/version_logs/v0.0.83.forked_per_run_isolation/change_plan.md`。
   */
  assemble(config: SessionConfig, scopeId?: string, prevSnapshot?: ContextSnapshot | null, opts?: StoreCallOpts): Promise<ContextSnapshot>;

  /**
   * 压缩一段对话成 summary、推进 summaryUpTo（基于 assemble snapshot 输入）。
   * - 经旁路 run（runKind='summary'）调 LLM（继承父 system prompt，压缩 prompt 作 user message）
   * - 只产 summary + 推进游标；head/tail 原文选取归 assemble（不在 compact）
   * - compact 后必须重新 assemble
   * - @returns `true`=完成；`false`=CAS 失败（已有 compact 在跑，跳过不重复执行）
   * - [v0.0.40] compact 触发 plugin 化：本方法现由 `context_do_compact` EP 的 active impl（`summary_do_compact`）调
   *   用（main scope）。loop 骨架不再直接调 compact；summary/consolidate scope 显式选 reject_should_compact（恒 false）→ tryCompact
   *   谓词检查处 return，doCompact 在旁路 run scope 结构上不可达。
   * - [v0.0.204 A1] compact 内部调 `this.assemble(config, scopeIdOf(config.kind!))`（v0.0.204 修复：原 `this.assemble(config)`
   *   漏传 scopeId → 走默认 default scope，与 caller session 真实 scope 不一致；现按 config.kind 派生正确 scopeId）。
   * 详见 [P0]context_compact_detail.md §2c
   */
  compact(config: SessionConfig): Promise<boolean>;

  /**
   * [v0.0.173 新增] 在 assemble 产出的稳定 snapshot 上跑清理视图（面向 LLM）。
   *
   * 设计动机：v0.0.173 重构前 6 个清理 reducer（snip/orphan/think/fill/empty/role_merge）挂在
   * `context_assemble_reducer` EP 里，输出直接进 `state.snapshot.messages` → snapshot 被清理污染 →
   * 下轮 base_builder appendNew 基于被污染的 prevSnapshot，触发 role_merge 吞 id + 末尾追加 →
   * tool_call 乱序 400（prod leader session）。**v0.0.173 解法**：snapshot = 确定性纯函数（永远 rebuild），
   * 清理剥到独立 EP `context_clean_view_reducer`（§5b）+ 经本方法在深克隆副本上跑，原 snapshot 不被触碰。
   *
   * 不变量（req 关键约束 + change_plan §三）：
   * - MUST `structuredClone` 深克隆（绝不 mutate 入参 snapshot.messages）
   * - MUST 返新 snapshot 对象（不 mutate 原 snapshot 任何字段）
   * - MUST NOT 跑 assemble mapper/reducer 链（clean view 只跑 clean reducer）
   * - pluginManager=null / 链空 → 返 messages 深克隆 fallback（保 UT fixture 兼容，不阻塞 LLM 调用）
   * - 其他字段（system/tools/summary/contextWindowUsage/inputCharCount）引用复用（不被触碰）
   *
   * 衔接链（change_plan 开放点 A3）：
   *   assemble → state.snapshot（稳定 rebuild）
   *     → getCleanSnapshot(snapshot, scopeId)
   *        = structuredClone(snapshot.messages)
   *        + 跑 clean view 链（dedup/snip/orphan/bubble_text/think/fill/empty/role_merge，§5b 8 项）
   *     → 返新 ContextSnapshot（messages 已清理，原 snapshot 不变）
   *     ← loop-stage-llm.callLLMForSpec 取 messages
   *     → toLogicalMessages → protocol.encode（wire: tool→user 映射 + mergeAdjacentSameRole + reminder 过滤）
   *
   * 实现（context-engine.ts:306）：`placeholderConfig.sessionId` 从 snapshot.system 派生（fill_empty_text 写日志用，
   * 不读 config 数据字段）；`runCleanViewPipeline(pluginManager, cloned, scopeId, placeholderConfig)` 见
   * `clean-view-pipeline.ts`。
   *
   * caller = `loop-stage-llm.callLLMForSpec`（唯一喂 LLM 入口）；inputCharCount / contextWindowUsage
   * 读原 rawSnapshot（cleanSnapshot 字段引用复用=同值，但显式取 rawSnapshot 表达「clean 不改 token 数」语义，cache 友好）。
   */
  getCleanSnapshot(snapshot: ContextSnapshot, scopeId?: string): Promise<ContextSnapshot>;
}
```

### 构造函数

```typescript
interface ContextEngineOptions {
  store: SessionStore;        // transcript 持久化（见 ../session/[P0]session_store.md §4）
  pluginManager: PluginManager;  // [v0.0.13] 跑 ordered 链的唯一入口（见 §3.5）
}

class ContextEngine {
  constructor(options: ContextEngineOptions) { /* ... */ }
}
```

> `store` 由 AgentLoop 注入（与 loop 自身使用的 store 同一实例），保证 ContextEngine 写入与 SessionStore 读取一致。`pluginManager` 同样由 AgentLoop/bootstrap 注入（与 llm_anthropic 走同一 PluginManager 实例）；ContextEngine **不持有 ext impl 类**，每次方法调用通过 `getExtensionImpls(point)` 拿当前 active impl 实例（config 改 → next-call 反映）。

### 3.5 ContextEngine 如何调框架（v0.0.13 spec 真正缺口）★

各 detail spec 描述了「ordered chain / mapper-reducer 执行**语义**」，但没写 **ContextEngine 怎么拿到链并跑**——本节补这个缺口。

**统一调用模式**（所有 context 执行点同构）：

```typescript
// 通用：拿当前 point 下 active impl（[v0.0.18] 按 effective order 升序，1 在前），逐个跑
function runOrderedChain<T>(point, ctx, runImpl): T {
  const impls = pluginManager.getExtensionImpls<T>(point);  // active = registry ∩ enabled，已排序
  // 各执行点自定 runImpl 形态（transform / map→deepMerge / reduce→链式 / concat）
  // impls 空时 fallback builtin 默认行为（见各 detail spec）
}
```

四个执行点的具体接线（契约细节见各 detail spec，本节只写「调哪个 point + 链形态」）：

| ContextEngine 方法 | 调的 EP | 链形态 | fallback（impl 全 disabled 时） |
|---|---|---|---|
| `ingest` | `context_ingest_handler` | transform 链：`Message[] → Message[]`（逐 handler 调 `handle`，链尾 `store_sink` 写 store） | 空链 → applyIngestPipeline 按注入 store 直 append（= v0.0.8 行为） |
| `assemble`（mapper 阶段） | `context_assemble_mapper` | map→deepMerge：各 `map(ctx) → Partial<AssembleData>`，同字段后者覆盖 | 空链 → transcript_reader 单读兜底 |
| `assemble`（reducer 阶段） | `context_assemble_reducer` | reduce 链：`reduce(data, input, ctx) → Message[]`（v0.0.173 起只剩 base_builder，首 reducer input=null 永远 rebuild） | 空链 → base_builder 兜底（input=null 构框架） |
| **`getCleanSnapshot`（v0.0.173 新增）** | `context_clean_view_reducer` | reduce 链：`reduce(EMPTY_DATA, input, ctx) → Message[]`（input 永远非 null，起步 = caller 传入的 structuredClone 副本；8 个清理 reducer 顺序见 `[P0]context_assemble_detail.md §5b`） | 空链 / pluginManager=null → 返原 messages 深克隆 fallback（caller 不阻塞 LLM 调用） |
| `assemble` 内 system_prompt 构建（**v0.0.66 改：不走 assemble 链**） | `system_prompt_mapper` + `system_prompt_reducer`（由 `buildSystemPrompt` 直接调，**v0.0.204 起按 assemble 入参 scopeId 解析 impl 列表 + async**） | map→concat fragments；reduce 链 `PromptFragment[] → PromptFragment[]`；builder 固定 `"\n\n".join` | mapper 空 → throw（v0.0.64 硬失败）；reducer 空 → 直接 join |
| `system_reminder`（经 ingest 的 `system_reminder_injector` handler 触发） | `system_reminder` | provider 链：各 `provide(ctx) → SystemReminder[]`，concat 聚合 | 空链 → 不注入 reminder |
| **`session_store` 解析（v0.0.66 新增）** | `session_store` | exclusive EP：`resolveStore(scopeId)` 选 1 active impl（default=`persistent_session_store` / forked=`in_memory_session_store`） | 无 active impl → fallback 到构造注入的真实 store（UT fixture 兼容） |

> **链是 active 投影，非编译期常量**：`getExtensionImpls` 在每次方法调用时求值（config 改 → next-call 反映新链），故 ContextEngine 无状态、不缓存链。enabled/order 由 `PluginConfigService` 管理（写面），ContextEngine 只读 active（见 `../../plugin_system/[P0]plugin_manager_interface.md` §3）。
>
> **compact 不走 chain**：compact 是单次 LLM 调用（经 forked agent），不是 ordered chain——见 `[P0]context_compact_detail.md`（S2）。**[v0.0.40]** compact 触发经 `tryCompact` 胶水 + 2 exclusive EP（`context_should_compact` 谓词 + `context_do_compact` 动作，见 §2c）。

### 3.6 session_store EP（v0.0.66 重构：源/汇 EP 化 + 主干零 isForked）

> **演进脉络**：
> - **v0.0.40 D1=B**：源/汇可注入（forked 用 buffer 数组，default 用 store）
> - **v0.0.49 D15**：default sink 也 EP 化（`store_sink` impl，对齐 forked `buffer_sink`），删 context-engine.ts `if scopeId` 硬尾
> - **v0.0.66**：彻底重构——session store 也 EP 化（`SessionStorePoint` exclusive），删 4 buffer/system impl（`buffer_sink`/`buffer_reader`/`append_passthrough`/`system_prompt`），default + forked 共用同一套主干逻辑，差异纯靠 store EP impl 切换 + summary 驱动 rebuild

**v0.0.66 改动（design §1）**：
1. **`SessionStorePoint`（exclusive, group='context'）**：default → `persistent_session_store`（包装真实持久 SessionStore）/ forked → `in_memory_session_store`（per-session Map）。`ContextEngine.resolveStore(scopeId)` 经 `pluginManager.getExtensionImpls(SessionStorePoint, scopeId)` 拿 active impl（拆到 `context-engine-store-resolver.ts`）。
2. **`ContextEngine.ingest/assemble` 主干零 isForked**：删 `if scopeId !== FORKED` 硬尾、删 buffer 参数、删 forked fallback 分支；统一逻辑：
   - `store = resolveStore(scopeId)`（default 持久 / forked 内存）
   - `summary = await store.getSummary(sid)`（forked in_memory 恒返 null → version 永远 null → 永远 append）
   - `ratio = await store.getRatio(sid)`（forked in_memory 恒返 1.0）
   - `await store.updateContextWindowUsage(sid, cw)`（forked in_memory no-op，不污染主对话 meta）
3. **删 4 buffer/system impl**（manifest 不再登记，forked-scope-bootstrap disable 仅作幂等防御清历史 scope 残留 enabled）：
   - `buffer_sink`（context_ingest_handler）→ 由 `store_sink` 统一（store EP 按 scope 切实现）
   - `buffer_reader`（context_assemble_mapper）→ 由 `transcript_reader` 统一（store EP 切实现）
   - `append_passthrough`（context_assemble_reducer）→ forked 改用 `base_builder`（复用 prevSnapshot.messages + 追加内存 store 增量）
   - `system_prompt`（context_assemble_mapper）→ system 由 context-engine.assemble 独立调 `buildSystemPrompt`（design §1.3）
4. **`ContextEngine.ingest/assemble` 签名精简**：删 `buffer?` 参数（v0.0.40-0.0.65 forked 透传 buffer 数组，v0.0.66 store EP 取代）；`assemble` 第 3 参数直接是 `prevSnapshot`（main + forked 都透传）。
5. **forked reducer 切换为 forked_builder（v0.0.178）**：forked scope 不再走 base_builder（v0.0.66-v0.0.177 的「forked 复用 base_builder append 分支」契约在 v0.0.173 删 append 分支后已静默断链——forked agent 看不到 parent transcript，只看到 in_memory store 的 [reminder, directive]）。v0.0.178 新建 `forked_builder` reducer（同 EP `context_assemble_reducer`，forked.yaml 激活 forked_builder / default.yaml 仍激活 base_builder）——主干零 forked 分支（呼应 design §1 主干零 isForked）。算法：复用固定 parentSnapshot.messages + 从 in_memory transcript 取 summaryUpTo 之后的增量 upsert（同 id 替换 / 新 id 按 ULID 升序 insert；isUlid 跳过 summaryMsg 的非 ULID id 保其原位）。多轮正确性：caller（`loop-stage-context.ts:prepareStage` forked 分支）传 `state.parentSnapshot`（LoopState 字段，wireInitState 整 run 设一次 = opts.snapshot）作 prevSnapshot；不能用漂移的 `state.snapshot`（prepareStage 每轮覆盖为 forked 自己的输出 → 多轮重复 reminder/userMessage）。详见 `[P0]context_assemble_detail.md` §5 + §5c。

| implId | EP | scope | 行为 |
|---|---|---|---|
| `persistent_session_store` ★ v0.0.66 | `session_store` | default | 包装真实持久 SessionStore（delegate holder，全方法） |
| `in_memory_session_store` ★ v0.0.66 | `session_store` | forked | per-session `Map<sessionId, Message[]>`；只实现 appendMessages + getMessages + getSummary（恒 null）+ getRatio（恒 1.0）+ updateContextWindowUsage（no-op）+ releaseSlot |
| `store_sink`（v0.0.49 D15） | `context_ingest_handler` | default + forked active | `ctx.store.appendMessages(sessionId, messages)` 写 store（store EP 按 scope 切实现：default 写持久 transcript / forked 写内存数组） |

> **`in_memory_session_store` 关键不变量**：
> - **`getSummary` 恒返 null（不 throw）**：让 forked curVersion 永远 null → 永不触发 rebuild → 永远 append 复用 prevSnapshot，纯数据驱动无 isForked 判断
> - **`updateContextWindowUsage` no-op**：forked 旁路不污染主对话 session meta
> - **`releaseSlot`（v0.0.66 命名分离）**：forked run 结束 `ForkedLifecyclePort.onRunEnd` 调 `ContextEngine.clearScopeSession` → 本方法删 Map slot；与 `SessionStore.clearSession`（删整 session 返 Session）命名分离，避免误删真实 session
>
> **forked scope 配置**（`ensureForkedScope` 预建，详见 `../../agent_interface_and_loop/[P0]agent_scope_router.md §4`）：
> - `setExclusive('in_memory_session_store', 'forked')`（session_store EP 选内存 impl）
> - `setExclusive('reject_should_compact', 'forked')` + `setExclusive('noop_do_compact', 'forked')`（防递归 compact）
> - 显式 enable forked-active impl：`forked_builder`（v0.0.178 替代 base_builder）+ `store_sink` + `transcript_reader`（声明式 yaml 激活；覆盖历史落盘 false drift）
> - disable `system_reminder_injector`（旁路不注入 reminder）
> - disable `memory_skill_consolidation`（post_compact EP 防递归整理）
> - disable 历史 buffer impl（`buffer_sink`/`buffer_reader`/`append_passthrough`，幂等防御——manifest 已删，disable 清 scope 残留）
> - 5 清理 reducer（orphan/empty/role_merge/snip/think_remove）**保持 active**（v0.0.66 收尾——对齐 default）
>
> **引擎类本身不重写**（呼应调研 §6.3）：ContextEngine 仍是「跑 ordered chain 的协调器」，源/汇选择下沉到 session_store EP（scope 配置选 impl）。ContextEngine 持真实 SessionStore 实例（构造注入），`persistent_session_store` impl 经 `session-store-ep-delegate.ts` holder 读它（plugin → server import 方向正确，与 `setSideRunner` 同模式打破初始化顺序依赖）。

---

## 4. 与 Agent Loop 的交互

> **[v0.0.49]** ContextPort 中间层移除——骨架 `runReActLoop(spec)` 直调 `contextEngine.ingest/assemble(scopeId)` 与 `callLLMForSpec`（见 `../agent_interface_and_loop/[P0]agent_loop_unified.md §2`）。`ingest/assemble` 接 `scopeId` 入参（current=`default` / forked=`forked`，由 `AgentScopeRouter.resolve` 产出）；compact 触发经 `tryCompact` 胶水骨架统一调。**[v0.0.66]** 主干零 isForked，default/forked 同一套主干逻辑（差异靠 session_store EP impl + assemble_reducer EP impl 切换）。**[v0.0.173]** loop-stage-llm 喂 LLM 前先经 `getCleanSnapshot` 跑清理视图（structuredClone 深克隆保 snapshot 不被 mutate），再 prepend `[cleanSnapshot.system, ...cleanSnapshot.messages]`。**[v0.0.178]** forked assemble 用 forked_builder（复用固定 parentSnapshot），`loop-stage-context.prepareStage` forked 分支 prevSnapshot 改用 `state.parentSnapshot`（固定）而非漂移的 `state.snapshot`——修 v0.0.173 删 append 分支后 forked agent 看不到 parent transcript 的 silent regression。

```
Agent Loop（统一骨架 runReActLoop，drainMode='eager'）       ContextEngine
─────────────────────────────────────────────────          ──────────────
① drain（drainMode='eager' 主路径；forked drainMode='none' 跳过）
  user/tool messages →     ──→    ingest(config, msgs, scopeId)
                                 → assemble(config, scopeId, state.snapshot) → snapshot
                                 → state.snapshot = snapshot（v0.0.173 永远 rebuild = 确定性纯函数；prevSnapshot 仅 system 复用规则读）

② LLM Request（callLLMForSpec helper）
  [v0.0.173] rawSnapshot = state.snapshot
    → getCleanSnapshot(rawSnapshot, scopeId)
        = structuredClone(rawSnapshot.messages)
        + 跑 clean view 链（context_clean_view_reducer EP）
        → cleanSnapshot（原 rawSnapshot 不被触碰）
  [v0.0.66] messages = [cleanSnapshot.system, ...cleanSnapshot.messages] → LLM call（protocol encode 抽 system 落 wire system 位）
  assistant →              ──→    ingest(config, [llmMsg], scopeId)
                                 → assemble(config, scopeId, state.snapshot) → snapshot
                                 → tryCompact({config, snapshot, scopeId, pluginManager, ...})
                                    └─ getExtensionImpls("context_should_compact", scopeId)
                                       → predicate.check(ctx)
                                       └─ 若 true → getExtensionImpls("context_do_compact", scopeId)
                                                       → action.run(ctx) [summary_do_compact]
                                 → LifecyclePort.onUsage → session.accumulateUsage(sid,"current",u)

③ Tool Execution（executeTools 原语）
  tool results →           ──→    ingest(config, toolResults, scopeId)
                                 → assemble(config, scopeId, state.snapshot) → snapshot

Loop 结束（LifecyclePort.onRunEnd）
  [v0.0.66] forked scope → ContextEngine.clearScopeSession('forked', sid) → in_memory_session_store.releaseSlot 清内存 slot
  snapshot.contextWindowUsage → ──→    session.persistUsage()
```

**关键设计**：
- usage 的 **view / 通知 / 存储归 session**（`../session/[P0]session_usage.md`）；context engine 不持 usage 状态，只调 session 更新接口（assemble→`updateContextWindowUsage`、LLM 返回→`accumulateUsage(type)`）
- 类型（AccumulatedUsage / ContextWindowUsage）见 `[P0]context_snapshot_interface.md`
- **[v0.0.66] forked 内存 store slot 清理**：forked run 结束经 `ForkedLifecyclePort.onRunEnd` 调 `ContextEngine.clearScopeSession(scopeId, sid)` → `in_memory_session_store.releaseSlot(sid)` 删 Map slot（释放内存 + 防下次同 sid forked run 残留；persistent_session_store.releaseSlot no-op）

---

## 5. 详细文档索引

| 方法 | detail 文档 | 核心议题 |
|------|------------|---------|
| `ingest` | `[P0]context_ingest_detail.md` | ordered handler chain + 固定落库、truncate 副作用、不可变边界 |
| `assemble` | `[P0]context_assemble_detail.md` | 选取/过滤/裁剪、token 计算、snapshot 产出 |
| `compact` | `[P0]context_compact_detail.md` | 压缩区间、summaryUpTo 推进、head/tail 保留 |
| `usage` | `[P0]context_usage_detail.md` | 调用时机（accumulate/update）+ context window 估算（char×ratio） |

> 另：`SessionConfig.systemPrompt` 的构建机制（mapper / reducer 两个 ordered 扩展点）见 `[P0]system_prompt.md`。
