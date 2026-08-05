---
type: interface
title: Context Engine — assemble 详解
priority: P0
status: active
updated: 2026-08-04
since: v0.0.8
---

# Context Engine — assemble 详解

> 主文档：`[P0]context_engine.md`。ContextSnapshot 见 `[P0]context_snapshot_interface.md`。mapper/reducer 扩展点机制见 `../../plugin_system/[P0]extension_point_interface.md`。system prompt 构建见 `[P0]system_prompt.md`（v0.0.66 起由 context-engine.assemble 独立调 builder，不走 assemble 链）。SessionStore 见 `../session/[P0]session_store.md`。

> **当前形态**：`assemble` 走 mapper 链（`context_assemble_mapper`）+ reducer 链（`context_assemble_reducer`，v0.0.178 起 2 impl：default 用 base_builder、forked 用 forked_builder）；面向 LLM 的清理 reducer 剥离到独立 EP `context_clean_view_reducer`（v0.0.256 起 8 项：dedup_tool_result + 原有 6 项 + bubble_text_before_tool_call，由 `ContextEngine.getCleanSnapshot` 在深克隆副本上跑，§5b）。**[v0.0.173] snapshot 永远 rebuild**（base_builder）：删 append 分支 + appendNew + 3 workaround（§2 重写）；确定性纯函数 `f(summary, transcript)`——同输入同输出保 prompt cache 稳定；transcript id 严格单调（monotonic ulid）→ `[...transcript]` 天然有序，根治 v0.0.161/0.0.173 tool_call 乱序。**[v0.0.178] forked_builder**：forked scope 用 forked_builder（§5c）复用固定 parentSnapshot.messages + summaryUpTo 后 in_memory 增量 upsert，非 rebuild——修 v0.0.173 删 append 分支后 forked agent 看不到 parent transcript 的 silent regression（compact 自 v0.0.173 起静默坏：LLM 只看 reminder+directive 无对话内容）；主干 `ContextEngine.assemble` 零 forked 分支，差异靠 scope EP impl 切换。chain 由 `ContextEngine` 经 `PluginManager.getExtensionImpls(point, scopeId)` 取 active impl（mapper/reducer/clean view 三个 point 分别 get）：mapper `map(ctx)` 贡献 `Partial<AssembleData>` deepMerge；reducer 链式 `reduce(data, input, ctx)`（见 `[P0]context_engine.md` §3.5）。**12 个内置 impl（2 mapper + 2 assemble_reducer + 8 clean_view_reducer，v0.0.66 删 system_prompt mapper；v0.0.173 删 prev_snapshot mapper + 6 清理 reducer 迁 EP；v0.0.178 加 forked_builder；v0.0.207 加 dedup_tool_result；v0.0.256 加 bubble_text_before_tool_call）**归 `rocky_context` plugin（见 `[P0]extension point and implementations.md` §3.2/§3.3/§3.10）。全 disabled 时 fallback（mapper 空 → transcript_reader 单读；reducer 空 → base_builder input=null 兜底；clean view 链空 → `getCleanSnapshot` 返原 messages 浅克隆 fallback）。**[v0.0.66] default + forked 同一套主干逻辑**：store 由 session_store EP 按 scope 切实现（持久 / 内存），assemble_reducer 也按 scope 切 impl（default=base_builder rebuild / forked=forked_builder reuse+upsert）；clean view 与 default 完全一致；system prompt 由 context-engine.assemble 独立调 builder（design §1.3），不进 mapper 链。
>
> **历史基线（v0.0.8 简化版）**：v0.0.8 的 `assemble` **不跑** mapper/reducer 双扩展点、不做 base_builder 增量 cache 判定（§2）、不用 transcript_reader/head-tail reducer config（§6）。实现口径：
> ```
> const all = store.getMessages(sessionId);          // 升序
> const summary = store.getSummary(sessionId);
> let picked = (summary && all.length > 6)
>   ? [...all.slice(0,3), summaryMsg(summary), ...all.slice(-3)]
>   : all;
> const inputCharCount = picked.reduce((n,m) => n + charCount(m), 0);
> const cw = { tokenLimit: config.client.contextWindow, usedTokens: inputCharCount * 1.0,
>              remainingTokens: tokenLimit - usedTokens };
> return { system: config.systemPrompt, messages: picked, inputCharCount, contextWindowUsage: cw };
> ```
> v0.0.13 下沉为 `base_builder` 默认 config（design [D1.2]：head3+tail3 → base_builder headMin2/headMax5/fraction0.05；ratio 1.0 → ratio 学习 S3 未激活前 fallback 1.0，但走真链路）。历史路径见 `specs/tech/version_logs/v0.0.8/change_log.md` §1/§5。**不主动 compact**（§8 不变）：agent_loop 在 `remainingTokens < 0` 时调 compact。

## 1. 概述

assemble 构建 LLM 上下文快照（`ContextSnapshot`），由 **mapper / assemble_reducer 双 ordered EP** 驱动（与 system_prompt 同构）；**面向 LLM 的清理 reducer 独立成 `context_clean_view_reducer` EP**（v0.0.173 分层重构），由 `ContextEngine.getCleanSnapshot` 在喂 LLM 前跑（深克隆副本，不污染 snapshot，见 `[P0]context_engine.md` §3 getCleanSnapshot）：

```
assemble(config, prevSnapshot?)                                    喂 LLM 前（callLLMForSpec）
  │                                                                 ↓
  ├─ ① mapper 链（context_assemble_mapper, ordered）── 读数据源    getCleanSnapshot(snapshot, scopeId)
  │     transcript_reader / summary_reader                            │
  │       ↓ AssembleData（数据源集合）                                ├─ structuredClone(snapshot.messages)
  ├─ ② assemble_reducer 链（context_assemble_reducer, ordered）       │    （关键不变量：绝不 mutate 入参）
  │     default scope → base_builder（v0.0.173 永远 rebuild）         ├─ 跑 clean view 链（context_clean_view_reducer, ordered）
  │     forked  scope → forked_builder（v0.0.178 reuse+upsert）       │     dedup_tool_result → snip_handler → orphan_tool_call
  │       ↓ Message[]                                                 │       → bubble_text_before_tool_call → think_remove
  └─ ContextSnapshot { system, messages, tools, summary,             │       → fill_empty_text → empty_message → role_merge
                       contextWindowUsage, inputCharCount }          └─ 返新 ContextSnapshot（messages 已清理）
```

- **mapper** = 数据源读取（transcript / summary）
- **assemble_reducer** = 框架构建；同一 EP 两 impl，靠 scope 切换：default → `base_builder`（永远 rebuild，确定性纯函数 f(summary, transcript)）；forked → `forked_builder`（v0.0.178 复用固定 parentSnapshot + summaryUpTo 后 in_memory 增量 upsert，§5c）
- **clean_view_reducer**（v0.0.173 新增，v0.0.256 起共 8 项）= 面向 LLM 的清理（dedup / snip / orphan / bubble_text / think / fill / empty / role_merge）；snapshot 不被清理污染 → 下轮 rebuild 仍基于干净的 summary + transcript

assemble 只构建视图，**不调用 LLM**（产出的 snapshot 供 LLM 调用使用，喂 LLM 前由 caller 经 `getCleanSnapshot` 跑清理视图）。

---

## 2. snapshot 永远 rebuild（v0.0.173 重构 — 确定性纯函数 + cache 友好）

**核心不变量**：`base_builder.reduce()` 永远走 `buildRebuild()`——`snapshot = 确定性纯函数 f(summary, transcript)`。同输入同输出，保 prompt cache 稳定。

**v0.0.173 重构（删 append 分支 + appendNew + 3 workaround）**：v0.0.52-v0.0.172 的 `base_builder` 有 append / rebuild 双分支（`shouldRebuild = !prev || prev.messages 空 || summary version 变`；append 走 `appendNew`，rebuild 走 `buildRebuild`）。v0.0.173 判定 append 路径是「致乱源」全部删除：
- **root cause（prod tool_call 乱序 400）**：`role_merge`（assemble reducer 链内）合并相邻同 role 消息时**吞掉被合并者的 message id** → 下轮 `appendNew` 的 `mergedPrev` 用 transcript 原版覆盖恢复 id 后，被吞 id 不在 `prevIds` → 当 newOnes 追加到末尾 → tool_use（在被吞的消息里，末尾）落到 tool_result（前部）后面 → MiniMax 顺序校验 400。详见 `specs/tech/version_logs/v0.0.173/change_log.md`。
- **根治**：删 `shouldRebuild` 分支 + 删 `appendNew()` 函数 + 删 3 个 workaround（① 按 id 用 transcript 原版覆盖 prevMessages / ② 集合 diff 判断新消息 / ③ summaryUpTo cutoff）；`reduce()` 函数体只剩 `if (input !== null) return input; return this.buildRebuild(data, ctx);`。
- **prev_snapshot mapper 一并删除**（贡献 `AssembleData.prevMessages`）——rebuild 路径只读 `data.transcript + data.summary`，`prevMessages` 失去存在意义。

**rebuild 路径**（`base_builder.buildRebuild()` 算法不动）：
- 无 summary → `[...transcript]`（system 由 `snapshot.system` 独立承载，v0.0.66）
- 有 summary → `[summaryMsg, ...recent]`（summaryMsg 1 个 text content block 3 段 = preamble + head + tail；recent 从新→旧累加至 budget；§6 产出结构 + §6.5 assemble budget）

**为何 rebuild 不损 prompt caching**：cache 看 wire bytes 前缀稳定性，不看 JS 内存引用。rebuild 是确定性纯函数：summary 版本不变 + transcript 无 HITL 更新 → 同输入同输出 → 字节稳定 → cache 命中。`append` 的「引用稳定」是 JS 层错觉，不增 wire cache。

**transcript id 严格单调（保 `[...transcript]` 有序）**：`config/ulid.ts` 是 monotonic ulid（同 ms 随机段 +1，单进程共享 lastTime/lastRandom）；所有 message id 分配点（drainAndPartition reissue / agent-loop-stage-llm assistant）用同一 `ulid()`。leader transcript 592 条 0 处 id 下降 → rebuild `[...transcript]` 天然有序，无需 sort。

**HITL tool_reply 占位→真实**：占位 block 编辑后同 id 落 transcript，rebuild 每轮读最新天然反映（v0.0.66 原 `appendNew` ① workaround 要处理的场景，rebuild 天然解决，无需特殊处理）。

**唯一风险点（[v0.0.185] 已根治）**：有 summary 时 head/tail 边界随消息数变可能 cache miss（buildRebuild 自己用 `summaryUpTo` 切 head/recent，同输入同输出，但消息数变则切点变）。**[v0.0.185] 修复**：head/tail 候选改由 summary_reader 锚定贡献（head=会话真第一条起 / tail=summaryUpTo 结尾，均不受 recent 窗口滑动影响）+ 选取算法换 min=1 + tokenCap——同 summary version 下 summary block 逐字节一致（§6 head/tail 选取）。

**forked 复用 prevSnapshot.system**（v0.0.66 system 复用规则保留不动）：
- prevSnapshot 存在 **且** summary 版本一致 → 复用 prevSnapshot.system（不重算 system prompt）
- 任一不满足（首次 / summary 变）→ 重算 system
- messages 不参与此判定（messages 恒 rebuild）

> **历史基线**：v0.0.8 简化版（`head3 + tail3 + recent`）下沉为 `base_builder` 默认 config 兜底（design [D1.2]）；v0.0.13-v0.0.66 多次演进（append 分支激活 / forked 对齐 / shouldRebuild 统一）；v0.0.161 `appendNew` 加集合 diff + summaryUpTo cutoff 加固（治标）；**v0.0.173 删 append 路径**（治本，根治 tool_call 乱序）。详见 `log.md` + `specs/tech/version_logs/v0.0.173/change_log.md`。

---

## 3. 三个 ordered 扩展点（v0.0.173 起 mapper + assemble_reducer + clean_view_reducer）

```typescript
const ContextAssembleMapperPoint = {
  id: "context_assemble_mapper",
  group: "context",
  cardinality: "ordered",
};

const ContextAssembleReducerPoint = {
  id: "context_assemble_reducer",       // v0.0.173 起只剩 base_builder（永远 rebuild）
  group: "context",
  cardinality: "ordered",
};

const ContextCleanViewReducerPoint = {  // v0.0.173 新增：面向 LLM 的清理 reducer 链
  id: "context_clean_view_reducer",
  group: "context",
  cardinality: "ordered",
};
```

mapper / assemble_reducer / clean_view_reducer 都是 ordered ext impl，**可插拔**；系统提供一组常用内置默认（base_builder + 8 clean reducer）。开发者可替换/增删做实验。

```typescript
/** mapper 贡献的集合；各 mapper 贡献 Partial，deepMerge 合并（同字段后者覆盖）
 *  [v0.0.66] system 字段已删——system 由 context-engine.assemble 独立调 buildSystemPrompt（design §1.3），
 *  不再走 assemble mapper 链（删 system_prompt impl）。
 *  [v0.0.173] prevMessages 字段已删——snapshot 永远 rebuild，不再需要上一版 messages 作增量基础
 *  （prev_snapshot mapper 一并删除）。 */
interface AssembleData {
  transcript: Message[];      // transcript_reader 贡献（最近 N 条；v0.0.66 store 由 session_store EP 按 scope 解析）
  summary: SummaryInfo;       // summary_reader 贡献（含 version；forked in_memory 恒 null）
}

interface AssembleMapper {
  /** 读数据源，贡献 Partial<AssembleData> */
  map(ctx: AssembleCtx): Partial<AssembleData> | Promise<Partial<AssembleData>>;
}

/** assemble_reducer + clean_view_reducer 共享同一契约（链式 reduce → Message[]）。
 *  [v0.0.173] 事实实现：base_builder（assemble_reducer）+ 8 clean reducer（clean_view_reducer）；
 *  clean view reducer 的 data 不读（用占位 AssembleData 满足签名），input 永远非 null（= 上一步输出或 caller 传入的 messages）。 */
interface AssembleReducer {
  /** 链式：input = 上一 reducer 输出（assemble_reducer 首 reducer base_builder 收 input=null 从 data 构建；clean_view_reducer input 永远非 null）；产出改写后的 Message[] */
  reduce(data: AssembleData, input: Message[] | null, ctx: AssembleCtx): Message[];
}

interface AssembleCtx {
  config: SessionConfig;
  prevSnapshot: ContextSnapshot | null;   // 来自 RunState；[v0.0.173] base_builder 不再读（rebuild 是纯函数 f(summary,transcript)）；字段保留供 system 复用规则 + 其他潜在消费者
  ratio: number;                           // [v0.0.52 P2-3] 动态 ratio（与 computeContextWindowUsage 同源 store.getRatio；forked in_memory 恒 1.0）
}
```

---

## 4. 内置 mapper（数据源）

> v0.0.13 起归 `rocky_context` plugin（见 `[P0]extension point and implementations.md` §3.2）。
> **[v0.0.66] `system_prompt` mapper 已删**：system 由 `context-engine.assemble` 独立调 `buildSystemPrompt`（design §1.3），不走 assemble mapper 链。
> **[v0.0.173] `prev_snapshot` mapper 已删**：snapshot 永远 rebuild，不再需要 prevMessages 作增量基础。

| implId | 默认 order（登记序） | 数据 | configSchema | 来源 |
|---|---|---|---|---|
| `transcript_reader` | 1 | 最近 N 条 message（N=500，归本 mapper config `limit`） | ✅ `{ limit: 500 }`（显式 JSON Schema 见 `extension point and implementations.md` §4.3） | `store.getMessages(sessionId, {limit})`（store 由 session_store EP 按 scope 解析：default 持久 / forked 内存） |
| `summary_reader` | 2 | summary + version（含 [v0.0.186] `block` 烘焙文本；仅 summary 无 `block` 时同取 head/tail 候选） | — | `store.getSummary(sessionId)`（forked in_memory 恒返 null） |

---

## 5. 内置 assemble_reducer（v0.0.178 起 2 impl：base_builder + forked_builder）

> v0.0.13 起归 `rocky_context` plugin（见 `[P0]extension point and implementations.md` §3.3）。
> **[v0.0.173] 6 个清理 reducer 迁到 `context_clean_view_reducer` EP（§5b）**——assemble_reducer 链不再含清理 reducer，snapshot 不被清理污染。
> **[v0.0.178] 同一 EP 两个 impl，靠 scope yaml 切换**：default scope 激活 `base_builder`（永远 rebuild 纯函数 f(summary,transcript)），forked scope 激活 `forked_builder`（复用固定 parentSnapshot.messages + summaryUpTo 后 in_memory 增量 upsert，非 rebuild）。主干 `ContextEngine.assemble` 零 forked 分支，差异纯靠 `context_assemble_reducer` EP 按 scope 选 impl 切换。

| implId | EP | 激活 scope | yaml 生效序 | 类别 | configSchema | 职责 |
|---|---|---|---|---|---|---|
| `base_builder` | `context_assemble_reducer` | default | 1 | 核心组装（rebuild） | ✅ `tokenCap`（显式 JSON Schema 见 `extension point and implementations.md` §4.4；[v0.0.186] 起仅 fallback 即时构建路径用，烘焙记录零计算） | **v0.0.173 永远 rebuild**（删 shouldRebuild 分支 + appendNew 函数）；构建 `[summaryMsg?, ...recent]` 框架（§6 产出结构 + §6.5 assemble budget；[v0.0.186] summary 有烘焙 `block` 直接用作 msg[0]）；不再构 systemMsg（v0.0.66 system 独立由 snapshot.system 承载） |
| `forked_builder` ★ v0.0.178 | `context_assemble_reducer` | forked | 1 | 核心组装（reuse+upsert） | — | **复用固定 parentSnapshot.messages** + 从 in_memory transcript 取 summaryUpTo 之后的增量 upsert（非 rebuild）；详细算法见 §5c |

> assemble_reducer 链式（见 §3 契约 `input` 参数）：激活的 reducer（base_builder 或 forked_builder）(input=null) 构框架 → 直接输出 Message[]（后续不再接清理 reducer，6 清理 reducer 在 clean view EP 由 getCleanSnapshot 跑）。[v0.0.18] effective order 小者先（无 record 时按登记序）。

## 5b. 内置 clean_view_reducer（v0.0.173 新增 EP — 面向 LLM 的清理）

> **v0.0.173 重构**：6 个清理 reducer 从 assemble_reducer 迁到独立 EP `context_clean_view_reducer`（ordered）。EP 激活后由 `ContextEngine.getCleanSnapshot(snapshot, scopeId)` 在深克隆 messages 副本上跑（深克隆保原 snapshot 不被 mutate）。caller = `loop-stage-llm.callLLMForSpec`（唯一喂 LLM 入口），见 `[P0]context_engine.md` §3 getCleanSnapshot + §3.5 调用表。
>
> **顺序保持原 assemble 链顺序**（reducer 间相互依赖已固化：`dedup_tool_result` 必须在 `orphan_tool_call` 之前——dedup 先去重，orphan 才能正确判配对（否则 orphan 见同 toolCallId 双 result 都当 paired 全留，兜底失效）；`bubble_text_before_tool_call` 必须紧跟 `orphan_tool_call` 之后——orphan 先做配对过滤 + message 级邻接，bubble 再处理配对齐全但 content 内 block 乱序（text 冒泡到 tool_call 前）；`think_remove` 必须排在 `empty_message` 之前，否则删 reasoning block 后变空的 assistant 会被 empty_message 当「自然空」漏过；`role_merge` 排最后合并相邻同 role）。scope yaml 显式序 = priority（`app/plugins/scopes/default.yaml` 的 `context_clean_view_reducer.impls` 列表——唯一自有该链的 scope yaml，其它 scope 均 per-EP 继承 default）。

| implId | EP | yaml 生效序 | configSchema | 职责 |
|---|---|---|---|---|
| `dedup_tool_result` ★ v0.0.207 | `context_clean_view_reducer` | 1 | — | 同 toolCallId 多 tool_result 去重（兜底防御）：扫所有 role='tool' message 内 tool_result block 按 toolCallId 分组，多 result 时挑 keeper（优先 `isError=false` 完整结果，否则首条），非 keeper 从 message.content 过滤掉（不可变，返新数组；不删 message 即便 content 变空交 empty_message 兜底）；零命中（单 result）原样返回。命中写 error log（鸭子类型 `ctx.config.logWriter.write('error', {reducer, sessionId, duplicates, toolCallIds})`，try/catch fail-silent，与 fill_empty_text 同模式）。**为什么需要**：中断后 loop 与 abort api 各写一条 tool_result（同 toolCallId）→ 畸形消息发给 LLM（k3 tokenization failed 根因）；T2 authority transfer 已从源头根治，本 reducer 作兜底防御历史脏数据/漏网场景 |
| `snip_handler` | `context_clean_view_reducer` | 2 | — | 被 snip 的 content block（message.snip 标记）替换为占位 `[content snipped]`，保留结构 |
| `orphan_tool_call` | `context_clean_view_reducer` | 3 | — | 移除无配对的 tool_use block（其后无对应 tool_result）与无对应 tool_use 的 tool_result block（按 toolCallId↔tool_use_id 配对）|
| `bubble_text_before_tool_call` ★ v0.0.256 | `context_clean_view_reducer` | 4 | — | assistant message content 的 block 级重排：单遍三段稳定分区 `[reasoning…][text…][其余(含 tool_call)…]` 拼接（桶内各保原相对顺序），把 text 冒泡到所有 tool_call 之前；丢弃 trim 后空的 text block。只处理 `role==='assistant'`（user/tool/system 原样透传）；不合并 text block；不删 message（全丢空交 empty_message 兜底）；不 mutate input（变更返新 message 对象 + 新 content 数组）；分区结果与原序一致且无丢弃 → 返原 message 引用（省分配）。**为什么需要**：stall 掐断留半截 tool_call（arguments `{_raw}`）落库、prefill 续写在其后接新 text+tool_call 时，assistant content 出现 text 夹在 tool_call 之间；anthropic-compatible provider 要求 tool_use 后块级紧跟 tool_result，text 夹中间即 400。orphan_tool_call 只做配对过滤 + message 级邻接，不碰 content 内 block 顺序——本 reducer 做确定性视图层兜底，对历史污染 + 未来任何乱序源生效（reasoning 段最前：Anthropic 要求 thinking 在 assistant content 最前，think_remove 缺席的 scope 下本重排也正确） |
| `think_remove` | `context_clean_view_reducer` | 5 | — | 删除所有 message 的 reasoning(think) content block（`b.type === 'reasoning'` 过滤，不可变 `{...m, content: filtered}`，input===null→[]）；不删 message 本身（删 block 后变空的 message 由其后 empty_message 兜底清理） |
| `fill_empty_text` | `context_clean_view_reducer` | 6 | — | 把 `role==='user'` message 与 `role==='tool'` message 里 success tool_result（isError:false）嵌套 content 中 `type==='text' && text===''` 的 block 兜底为 `"empty"`，防空 text content block 发给 LLM 撞 Anthropic 400 "text content is empty"。命中（有 block 被填）时经 `ctx.config.logWriter` 写一条 error 级日志（鸭子类型能力探测 + try/catch fail-silent，`enableErrorLog` 开关由 LogWriter 内部门禁）。不动 assistant message / error tool_result 嵌套 text / 非空 text / 非 text 类型 block |
| `empty_message` | `context_clean_view_reducer` | 7 | — | 剔除 content blocks 为空的 message |
| `role_merge` | `context_clean_view_reducer` | 8 | — | 相邻同 role（user/user、assistant/assistant、tool/tool）合并：后者 content blocks 并入前者；system 不合（恒首条）。**[v0.0.173 关键]** 合并只发生在 clean view（一次性深克隆副本），原 snapshot.messages 不被触碰 → 下轮 rebuild 仍基于干净的 transcript → 所有 message id 都保留 → 不会出现「id 消失 → appendNew 末尾追加 → 乱序」的 v0.0.173 root cause 链 |

> **[v0.0.66] forked active clean view 与 default 完全一致**（v0.0.256 起 8 个全 active）：base_builder 正确产 messages 后清理 reducer 是格式保障。旧 v0.0.49 「forked 关 4 清理 reducer 削减 chain 遍历开销」基于 append_passthrough 丢弃 input 的前提，v0.0.66 forked 改用 base_builder 后 input 不丢弃，前提失效。

> **encode wire 合并 vs clean view role_merge 职责不可互换**：clean view 的 `role_merge` 合并的是**原始 role**（user/user、assistant/assistant）；encode 的 `mergeAdjacentSameRole` 合并的是**role 映射后**（tool→user）的 wire role。clean 时还没 role 映射，做不到 wire 合并的职责。两层独立，不互删、不抽公共函数。

---

## 5c. forked_builder 算法（v0.0.178 新增 — 复用固定 parent + summaryUpTo 后增量 upsert）

> **背景（v0.0.178 修 silent regression 自 v0.0.173）**：v0.0.66 设计 forked assemble 走 base_builder append 分支（`[...prevSnapshot.messages, ...新增]`），让 forked agent 看到 parent 全量 transcript（`context-compact-runner.ts:24` 契约：`LLM 实际收到：[system, ...parent.messages, reminder, directive]——对话历史只出现一次`）。v0.0.173 删 append 分支 + `AssembleData.prevMessages` 字段后，base_builder 只读 `data.transcript`（= in_memory store `[reminder, directive]`）→ parent transcript 完全丢失 → compact forkedRun('summary') 的 LLM 只看到 reminder+directive 但**无对话内容**，产出的 summary 空洞。v0.0.178 新建 `forked_builder` 替代 base_builder 在 forked scope 的位置（同 EP `context_assemble_reducer`，差异靠 scope EP impl 切换），主干 `ContextEngine.assemble` 零 forked 分支（守 v0.0.66 §2.3「主干零 isForked」）。

**算法**（`app/plugins/builtins/rocky_context/assemble/side_run_builder.ts` `SideRunBuilderReducer.reduce()`）：

```
input = data.transcript              # in_memory_session_store 的累积（reminder + userMessage + assistant + tool，按 runId 桶）
prev = ctx.prevSnapshot              # ★ 固定 parentSnapshot（caller 传 state.parentSnapshot，非漂移 state.snapshot）
parent = prev.messages.slice()       # 拷贝（绝不 mutate prev.messages）；含 summaryMsg + recent 原序
summaryUpTo = prev.summary?.summaryUpTo    # parent summary 已总结到的 id

newMsgs = summaryUpTo ? transcript.filter(m => m.id > summaryUpTo) : transcript
                                     # 取 summaryUpTo 之后的「增量」（之前已被 parent summary recap 覆盖）
if newMsgs.length === 0 → return parent

# upsert 合并（同 id 替换 / 新 id 按 ULID 升序 insert）：
for m in newMsgs:
  if m.id 已在 parent → 替换该条内容（HITL tool_reply 占位编辑后同 id 落 transcript 的场景）
  else → 从末尾往前找第一个更小 ULID 的位置，插其后（保 summaryMsg.id=`summary:N` 非 ULID 原位不动）
return parent
```

**关键不变量**：
- **MUST 拷贝 prev.messages**（`.slice()`）—— 绝不 mutate `ctx.prevSnapshot.messages`（caller snapshot 不被污染）。
- **MUST NOT 全局 sort by id** —— summaryMsg.id 形如 `summary:N` 非 ULID，全局 sort 会把它排乱；保持 parent 原顺序 + newMsgs 按 ULID 升序插入。
- **MUST NOT 读 data.summary**（forked in_memory store 恒 null）。
- **MUST NOT rebuild**（forked 无完整 transcript——in_memory 只存本 run 增量；rebuild 缺 parent 全量上下文）。
- isUlid 跳过 non-ULID 元素（summaryMsg）只与 ULID 比较，否则 splice 会把 summaryMsg 挤到非首位。

**多轮正确性关键（caller 须传固定 parentSnapshot）**：
- `LoopState.parentSnapshot`（v0.0.178 新增字段，wireInitState 整 run 设一次 = opts.snapshot）。
- `prepareStage` forked 分支用 `state.parentSnapshot ?? null` 作 prevSnapshot（不能用漂移的 `state.snapshot`）。
- 反例：若用漂移的 `state.snapshot`（prepareStage 每轮 `state.snapshot = assemble(...)` 覆盖成 forked 自己的输出），第 2 轮起 `[...prevSnapshot.messages, ...transcript]` 会重复 reminder/userMessage（transcript 是 in_memory 累积全量 + 漂移 prevSnapshot 又带回上轮增量）。

**多轮流转链路**（完整，未断）：ingest（reminder/userMessage/assistant/tool）→ `in_memory_session_store`（Map<runId, Message[]> append-only，同 id upsert；per-runId 桶）→ transcript_reader 读全量 → forked_builder。增量累积天然正确，forked_builder 只补固定 parent 前缀。summary_reader 已从 forked.yaml 去掉（forked 无 summary）。sys 由 `ContextEngine.assemble` 独立处理（复用 `parentSnapshot.system`）。

> **代码定位**：`app/plugins/builtins/rocky_context/assemble/side_run_builder.ts`（class `SideRunBuilderReducer extends ContextImplBase implements AssembleReducer`，构造器签名 `(implId, cfg)` 与其他 reducer 一致；EP 注册 `plugin.json` 与 base_builder 同 pointId=`context_assemble_reducer`）。caller `build-run-deps.ts wireInitState`（设 `parentSnapshot: opts.snapshot`）+ `loop-ports.ts:LoopState.parentSnapshot`（字段定义）。

---

## 6. base_builder 产出结构

```
[summary msg?]                       ← 有 summary 时第一条（v0.0.66：system 不在 messages；v0.0.81：1 个 text block 3 段）
   └─ content block[0]: text = preamble + head 段(msgid+content) + tail 段(msgid+content)
[recent messages]                    ← summaryUpTo 之后的新消息（v0.0.81：从新→旧放置至 budget）
```

- **[v0.0.186] summary 烘焙优先（组装期零计算）**：`summary.block`（compact 时烘焙的完整 block 文本，见 `context_compact_detail.md` §2 step 5）存在 → **messages[0] 文本直接 = `summary.block`**：不 pickHead/pickTail、不读 head/tail 候选、不做 summary 侧 budget/tailDropped 判定。烘焙那一刻用什么 ratio / 候选 / budget，文本就永远是什么样——**ratio 后续漂移、transcript 增长、recent 窗口滑动都不影响 messages[0]**（修 v0.0.185 残留的第二机制：动态 ratio 撑缩 head 窗口，prod 实测 52→55 条破缓存前缀）。`summary_reader` 见 `summary.block` 也不再取 head/tail 候选（省每轮 2 次 `getMessages`）。**边界**：烘焙后 head/tail 窗口内历史消息被 HITL 编辑**不回刷** block（recent 区每轮读最新不受影响），下次 compact 重新烘焙。
- **fallback（存量旧 summary 无 `block`）**：走下方 [v0.0.185] 即时构建路径（锚定候选 + tokenCap + budget tailDropped），行为与 v0.0.185 完全一致；下次 compact 自动升级为烘焙记录。不做启动迁移。
- **算法单源**：summary block 全部算法（pickHead/pickTail/buildSummaryBlock/getEstimatedOutput/烘焙 `bakeSummaryBlock`）落 server `app/server/src/agent/summary-block.ts`——compact 烘焙（`context-compact-runner.runCompact`）与组装 fallback（plugin `base_builder`）两处消费同一实现（server 不能反向 import plugin 源码，故算法单源在 server，plugin 深 import 复用）。
- **system**：**[v0.0.66] 不在 messages**，由 `snapshot.system` 独立承载（Message 字段，role=system，content=[text block]）。**[v0.0.173]** `loop-stage-llm.callLLMForSpec` 先经 `spec.wireContextEngine.getCleanSnapshot(rawSnapshot, scopeId)` 取清理视图，再 prepend `[cleanSnapshot.system, ...cleanSnapshot.messages]`（system 不被 clean view 触碰，等于原 system），protocol encode 抽 system 落到 wire system 位（cache_control bp#1）。`context-engine.assemble` 按 design §1.3 system 复用规则构建 systemText（!prevSnapshot.system || summary.version 变 → 调 buildSystemPrompt；否则用 prevSnapshot.system）—— messages 不参与此判定（messages 恒 rebuild）。
- **summary message（[v0.0.81.compaction_bug] 1 个 text content block，3 段）**：当 `summary.content != null` 时存在；`role=user`（不是 system——summary 是对话历史的 recap，作 user 提供的上下文，Claude Code 口径）；`id=summary:{version}`；**1 个 content block**（`{type:'text', text: <拼好的字符串>}`），文本 3 段：
  - **preamble**：引导 LLM「以下是之前对话的摘要，以及为保持上下文连续保留的原文片段（head=早期，tail=近期）」+ 空行 + `<summary.content>` + 空行
  - **head 段**：`--- head（早期保留原文）---` 行 + 每条消息 1 行 `[<msgid>|<role>] <content>`（按原序）
  - **tail 段**：`--- tail（近期保留原文）---` 行 + 同格式每条 1 行（按原序）；summary 自身超 budget 时 tail 段替换为降级说明「tail 段已因 budget 限制截断」（保 preamble + head）
  - **head∩tail 按 head 算**（去重）：summary 区间短时 head/tail 选窗可能重叠，重叠 id 在 tail 段剔除（`base_builder.buildRebuild` 用 Set 过滤）
  - 旧版（v0.0.8-0.0.80）head/tail 各消息单独一个 text content block —— v0.0.81 改单 block 三段拼字符串（req：「整理成 1 个 content block，不是每消息 1 个 block；head/tail 内 msgid+content 配对」）。
- **recent messages**：summaryUpTo 之后的新消息按原序（升序）；**[v0.0.81]** 从新→旧累加至 budget，超额丢最旧（`pickRecentWithinBudget`：从 transcript 末尾最新往前取，超 budget 即停，最后 reverse 回升序返回）。
- **head/tail 选取**（[v0.0.186] 起主要运行于 **compact 烘焙时**；组装期仅旧 summary fallback 用）：参数归 impl `ExtImpl.configSchema`（**谁用归谁**）——烘焙路径归 `summary_do_compact`（`tokenCap` + `candidateLimit`），fallback 路径归 `base_builder`（`tokenCap`）+ `summary_reader`（`candidateLimit`），默认值一致（10000 / 500）：
  ```json
  { "tokenCap": 10000, "candidateLimit": 500 }
  ```
  显式 JSON Schema（type/default/min/required）见 `[P0]extension point and implementations.md` §4.4（本节仅散文默认值）。
  算法（**[v0.0.185]** owner 拍板版；head/tail 各自独立预算，cap 不合计）：
  - **候选锚定（prompt 缓存前缀稳定的关键）**：候选**不**从「最近 N 条」transcript 窗口派生（那会随新消息滑动、summary block 每轮换血）。[v0.0.186] 起由 **`bakeSummaryBlock`（compact 时）** 取——`store.getMessages({upToId: summaryUpTo, limit: candidateLimit(默认500), takeFromStart: true})`（head=会话真第一条起）+ `store.getMessages({upToId: summaryUpTo, limit: candidateLimit})`（tail=summaryUpTo 结尾）；fallback 路径由 `summary_reader` mapper 单次 `getSummary` 后同取（同两调用，贡献 `AssembleData.headCandidates/tailCandidates`，仅 summary 无 `block` 时执行）：
    - headCandidates = 会话真第一条起的前 N 条（锚定 transcript 起点）
    - tailCandidates = summaryUpTo 结尾的末 N 条（锚定 summaryUpTo）
    - 同 summary version 下两候选逐字节稳定 → summary block 逐字节稳定；summaryUpTo 掉出 recent 窗口也不影响（顺带修掉旧 `upToIdx=-1` 候选为空的异常路径）。候选缺省（无 summary / forked / 旧测试 ctx）→ base_builder 回退 transcript 派生。
  - head：从候选首条往后累加 char×ratio，**加上当前条会超过 tokenCap 就放弃当前条并停止**；不足 1 条保底 1 条
  - tail：从候选末尾（= summaryUpTo）往前累加，同规则；结果按原序返回
  - token 用 char×ratio 估算（见 §7 / context_usage_detail §4）
  - **[v0.0.52 P2-3] ratio 动态化**：`ctx.ratio` 透传（与 computeContextWindowUsage 同源 `store.getRatio`，per-session 学习窗口），冷启动 fallback 1.0（forked in_memory store 恒返 1.0）；v0.0.40-0.0.51 期间 base_builder 内部硬编码 `RATIO = 1.0` 常量（与 context_usage_detail §4 的动态 ratio 不同源），v0.0.52 P2-3（并入 v0.0.49 落地）改为从 ctx 拿——head/tail 选取与总用量估算同源 ratio，避免分母不一致。
  - 旧版（v0.0.13-0.0.184）6 字段（headMin/Max/Fraction + tailMin/Max/Fraction）算法：min~max 条数 + fraction×contextWindow 预算——**[v0.0.185] 已删除**（换 min=1 + tokenCap；config schema 直接替换无兼容层）。

---

## 6.5 assemble budget 放置（[v0.0.81.compaction_bug] 新增）

**[v0.0.81]** base_builder 引入 assemble budget 放置算法，保护调 LLM 时 input + output 合计不过载：

```
budget_tokens = 0.95 × tokenLimit − estimatedOutput
  tokenLimit      = config.client.contextWindow         // modelConfig.contextWindow
  estimatedOutput = appConfig.context.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS(=20000)
                                                   // 常量源：app/server/src/agent/session-usage-helper.ts
                                                   // = estimated output 估算输出常量，非 model maxOutput
budget_chars    = budget_tokens / ratio                // 累积口径 char×ratio ≈ token；ratio = ctx.ratio
```

**放置算法**（`base_builder.buildRebuild()` + `base_builder_helpers.pickRecentWithinBudget`）：
1. **summary block 始终放置**（preamble + head + tail 拼好后的整段 text）；自身超 budget 时丢 tail 段（保 preamble + head）。**[v0.0.186] 烘焙记录此降级在 compact 时已完成并定格进 `block`**；组装期对烘焙记录零判定（直接用 `block`），仅 fallback 旧记录在组装期做本判定。
2. **recent 从新→旧累加至剩余预算**（`remaining = budget_chars − summaryText.length`，烘焙记录 `summaryText.length = block.length`），超额丢最旧。
3. 无 summary 时直接放 transcript（不走 budget）。

> **设计理由（req §新需求 4）**：estimated output 是 LLM 调用的输出预留（保护 input + output 合计不超过 window），从 input 侧的 95% 预算里先扣掉；剩下来的才是 input 预算。95% 留 5% 给 system prompt / wire 协议开销等。注意 estimated output **不进 compact 阈值**（compact 阈值是用户视角的纯使用比例，见 `context_compact_detail.md §1`）—— assemble budget 是 input 预算层，compact 阈值是触发层，两层独立。

---

## 7. contextWindowUsage 计算 + inputCharCount

每次 assemble 重算（非增量）：从 session 读 ratio（`session.getRatio(sessionId)`，session 算/存，见 context_usage_detail §4），用 **char × ratio** 估算：

```
ratio          = session.getRatio(sessionId)       // session 算/存（current session 学习）
inputCharCount = len(system) + Σ len(msg) + len(tools 序列化)   // 原始 char，记入 snapshot 供 ratio 学习
  systemTokens    = len(system) × ratio
  messageTokens   = Σ len(msg) × ratio
  toolTokens      = len(tools 序列化) × ratio
  totalTokens     = systemTokens + messageTokens + toolTokens      // input 侧
  maxOutputTokens = appConfig.context.maxOutputTokens ?? 20000
  tokenLimit      = config.client.contextWindow                   // modelConfig.contextWindow
  remainingTokens = tokenLimit − totalTokens − maxOutputTokens
snapshot.inputCharCount = inputCharCount   // 产出 snapshot 时记录；agent loop 构造 usage 时填入 usage.inputCharCount
```

> `remainingTokens < 0` 表示超限——assemble **不主动 compact**，由 agent loop 决策（见 §8）。token 估算用 per-session ratio（session 算/存，current 学习）；LlmClient 不估算 token。

---

## 7.5 tools 填充（assemble main）

snapshot.tools 由 **assemble main 填充**（非 mapper/reducer），从 `config.tools` 取 tool definitions：

```
snapshot.tools = config.tools.map(t => t.definition);
```

tools 是「哪些工具可用」的固定装配，不是组装策略，故不走 reducer 链；reducer 只管 messages。

> **[v0.0.82] 字段必填 + forked 复用保 cache**：spec §2 完整形态本含 tools，v0.0.8 简化时省略（task-5 自行从 config.tools 构造），v0.0.82 修复 cache 前缀分叉 bug 时恢复为必填——forked 之前用 `defaultToolDefinitions(workdir)` registry 全集（24，含 squad team/goal/requirement/task）与 main `config.tools` policy 裁剪集（20）分叉，wire body tools 段 24 vs 20 破 anthropic prompt cache 前缀。修复：assemble 把 tools 写进 snapshot（与 main spec.toolDefinitions 同源），forked 读 `snapshot.tools`（不读 opts.toolDefinitions 全集，见 `../agent_interface_and_loop/[P0]agent_loop_side_run.md §4/§5`）。

---

## 8. 不做的事

- ❌ **不调用 LLM**（只构建 snapshot）
- ❌ 不修改 transcript / summary（纯读 + 组装视图；snip 改写只作用于 snapshot 视图，不回写 store）
- ❌ 不推进游标（`ingestUpTo` / `llmUpTo` 是 RunState）
- ❌ 不主动 compact（超限暴露 `remainingTokens<0`，agent loop 决策）

---

## 9. 版本

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
