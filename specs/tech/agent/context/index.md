---
type: index
title: Context 子系统总起
priority: P0
updated: 2026-08-04
---

# Context 子系统总起

## ① 是什么

`ContextEngine` 管理 agent 的 **context 生命周期**：消息 ingest、snapshot 组装、历史压缩（compact）、usage 估算，以及 system prompt / system reminder 构建。是 Agent Loop 的核心协作组件——loop 每阶段产出的消息都交给 ContextEngine 处理。

**全面 plugin 化**：ingest / assemble / system_reminder 三个执行点全部由 `PluginManager.getExtensionImpls(point, scopeId)` 驱动跑 ordered 链（**11 个 context EP = 8 ordered + 3 exclusive（含 v0.0.66 `session_store` + v0.0.173 `context_clean_view_reducer`）+ 57 个 `rocky_context` builtin impl（v0.0.173 删 prev_snapshot mapper；含 v0.0.126 `search_indexing` ingest handler + v0.0.256 `bubble_text_before_tool_call` clean view reducer）**，见 `extension point and implementations.md`）；compact 用 forked agent，**[v0.0.40] compact 触发也 plugin 化**（`tryCompact` 胶水 + 2 exclusive EP）。**[v0.0.40] 源/汇可注入**（D1=B）。**[v0.0.49 D15] default sink 也 EP 化**（`store_sink` impl 对齐 forked `buffer_sink`）。**[v0.0.51] 新增 `context_post_compact` ordered EP** + `memory_user`/`memory_session` mapper。**[v0.0.66] session store 也 EP 化**（`SessionStorePoint` exclusive）+ 主干零 isForked（default + forked 共用同一套 ingest/assemble 主干，差异纯靠 store EP impl 切换 + summary 驱动 rebuild）+ system prompt 独立（删 system_prompt assemble impl，由 context-engine.assemble 独立调 builder，复用规则：shouldRebuild=!prevSnapshot || summary.version 变）。**[v0.0.126] ingest 链加 `search_indexing` 派生索引旁路 sink**（order 5，紧随 store_sink；只 default scope active，forked 经声明式 yaml disable；投递 HistoryIndexer.index 不 await + reconcile 兜底）。**[v0.0.173] assemble 链只剩 base_builder（永远 rebuild）+ 新增 `context_clean_view_reducer` EP（6 清理 reducer 由 getCleanSnapshot 在深克隆副本上跑）**。

| 核心概念 | 一句话 |
|---|---|
| **ContextEngine** | 无业务状态的协调组件；构造注入 store + PluginManager，每方法接 `SessionConfig` + `scopeId`（v0.0.40）+ `resolveStore(scopeId)` 按 session_store EP 解析（v0.0.66） |
| **ingest** | 消息进入唯一入口 = ordered handler chain（truncate/offload/inject）+ chain 尾 `store_sink` impl 落库（store 由 session_store EP 按 scope 解析：default 持久 / forked 内存，v0.0.66） |
| **assemble** | 组装 LLM 上下文快照 = mapper（读数据源）/ assemble_reducer（框架构建）双 ordered EP；不调 LLM；**v0.0.66 主干零 isForked**（default+forked 共用主干逻辑，差异靠 store EP impl + assemble_reducer EP impl 按 scope 切换）；**v0.0.173** base_builder 永远 rebuild（确定性纯函数 f(summary,transcript)，删 append 分支 + shouldRebuild 判定）；**v0.0.178** forked 切换到 forked_builder（复用固定 parentSnapshot + summaryUpTo 后 in_memory 增量 upsert，修 v0.0.173 silent regression）；v0.0.52 P2-3 base_builder pickWindow 用动态 ctx.ratio |
| **compact** | 压缩对话成 summary + 推进 `summaryUpTo`，经 forked agent 调 LLM；只产 summary；**v0.0.40 触发 plugin 化**（tryCompact + shouldCompact/doCompact EP）；**v0.0.81 触发阈值改纯使用比例 `total/limit > compactRatio`**（去 estimatedOutput）；**v0.0.158 SessionConfig 组装收敛为唯一入口** `agentManager.resolveConfigBySid(sid)`（chat/compact 同链，无 `task` 参数、无 summary 子链；runner input 删 `config` 字段，bootstrap 闭包内自 resolve） |
| **tryCompact** | v0.0.40 固定胶水，骨架 `runReActLoop` 统一调（v0.0.49 起不再下沉到 ContextPort 包装）：`if(shouldCompact) doCompact()`；forked scope 显式选 reject_should_compact 恒 false → 防递归 |
| **post-compact handler** | v0.0.51 新增 `context_post_compact` ordered EP，compact 成功完成后触发（setSummary + appendMessages + markSummaryDone 之后）；默认 impl = `memory_skill_consolidation`（启动整理 fork-2）；forked scope 跳过防递归 |
| **ContextSnapshot** | assemble 产出的不可变快照（system 独立 Message 字段 + messages 纯对话历史 + usage 估算，v0.0.66） |
| **session_store EP** | **[v0.0.66]** exclusive context EP（`SessionStorePoint`），default→`persistent_session_store`（包装真实持久 SessionStore）/ forked→`in_memory_session_store`（per-session Map）；forked `getSummary` 恒 null + `updateContextWindowUsage` no-op → 主干零 isForked |
| **system_prompt** | map（贡献 PromptFragment）→ reduce（tier_sort/dedup/budget_truncate）→ build 三阶段；**[v0.0.66] 不走 assemble mapper 链**，由 context-engine.assemble 独立调 buildSystemPrompt（复用规则：shouldRebuild=!prevSnapshot \|\| summary.version 变） |
| **system_reminder** | 动态上下文（env/time/workspace/tool_error/todo），注入最后一条 user message 末尾（保 cache） |
| **PromptTier** | stable / context / volatile 三层——决定 cache 友好度 + budget_truncate 裁剪顺序 |
| **ratio** | char→token 估算系数（per-session 学习窗口，冷启动 1.0；forked in_memory store 恒返 1.0） |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| ContextEngine 三方法（ingest/assemble/compact）+ 调 PluginManager 跑链（v0.0.40 透传 scopeId） | AgentLoop 本体调用时机 + RunSpec 装配（→ `../agent_interface_and_loop/[P0]agent_loop_unified.md`） |
| 11 context EP（8 ordered + 3 exclusive）+ 57 rocky_context impl（含 v0.0.49 `store_sink` + v0.0.51 post-compact + v0.0.126 `search_indexing` + v0.0.256 `bubble_text_before_tool_call`，整合索引） | EP cardinality / plugin 框架（→ `../../plugin_system/`） |
| tryCompact 胶水 + shouldCompact/doCompact EP 契约（v0.0.40；v0.0.49 起骨架统一调）+ post-compact handler EP 契约（v0.0.51） | scopeId 路由（→ `../agent_interface_and_loop/[P0]agent_scope_router.md`） |
| 源/汇可注入（D1=B + v0.0.49 D15 sink 对称 EP 化）：store_sink（default scope）/ buffer_sink（forked scope，3 个 forked 专属 impl + 1 个 default 专属 store_sink） | scope 注册/预建 + dev-config（→ `../../plugin_system/` + dev-config） |
| system_prompt 构建（mapper/reducer/builder）+ PromptFragment/tier | SessionConfig 定义（→ `../agent_interface_and_loop/[P0]agent_manager.md`） |
| system_reminder provider 链 + 注入末条 user message | transcript / summary / raw 持久化（→ `../session/`） |
| context window usage 估算（char×ratio）+ 调 accumulate/update 时机 | usage view/存储/聚合/通知（→ `../session/[P0]session_usage.md`） |
| prompt 正文文件读取层（PromptHandler） | prompt 正文内容本身（→ `app/server/src/prompts/content/*.md`） |

## ③ 与系统的关系

```
                  ┌── agent_interface_and_loop/  (AgentLoop 调用时机 + SessionConfig 定义)
                  │
   context KB ────┼── session/                   (transcript/summary/raw 持久化 + usage view/存储)
   (本目录)        │
                  ├── plugin_system/             (ordered EP 机制：mapper/reducer/handler chain)
                  │
                  ├── message/                   (Message / ContentBlock 类型)
                  │
                  ├── memory/                    (memory 经 system_prompt mapper 注入 = memory_user/session impl)
                  │
                  └── persistence/               (CrudStore FS engine)
```

**对外协作点**：
- ContextEngine 落 `app/server/src/agent/context-engine.ts`（store + pluginManager 构造注入，AgentLoop 持同一实例）。
- ingest/assemble pipeline 落 `context-ingest-pipeline.ts` / `assemble-pipeline.ts`；compact runner 落 `context-compact-runner.ts`（forked agent）。
- 11 EP（8 ordered + 3 exclusive）+ 57 impl 落 `app/plugins/builtins/rocky_context/`（单 builtin plugin，manifest `plugin.json`）。
- prompt 正文落 `app/server/src/prompts/content/*.md`（PromptHandler 读取层）。

## ④ 核心设计原则（跨文件不变量）

1. **方法级 session context**——每方法显式接 `config: SessionConfig`（sessionId/model/systemPrompt）+ `scopeId`（v0.0.40），不依赖实例隐式状态；store 等无状态依赖构造注入。→ `context_engine.md` §1
2. **消息落库后不可变**——进 transcript 后不可改（仅 `allowEdit=true` 时按 id 覆盖）；ingest 链（落库前）可改写待入库 message。→ `context_ingest_detail.md` §4
3. **链是 active 投影，非编译期常量**——`getExtensionImpls(point, scopeId)` 每次方法调用求值（config/scope 改 → next-call 反映），ContextEngine 无状态、不缓存链。→ `context_engine.md` §3.5
4. **compact 不走 ordered chain**——compact 是单次 LLM 调用（经 forked agent），不是 ordered chain；只产 summary，head/tail 选取归 assemble。→ `context_compact_detail.md`
5. **[v0.0.40] compact 触发 plugin 化（tryCompact 胶水 + 2 exclusive EP；v0.0.49 调用点回归骨架）**——loop 骨架对 compact 零感知；`tryCompact(pluginManager, ctx)` 固定胶水骨架 `runReActLoop` 统一调（v0.0.40-0.0.48 在 current ContextPort.recordAssistant 内调，v0.0.49 删 ContextPort 后回归骨架）：`if(await shouldCompact(ctx)) await doCompact(ctx)`。`context_should_compact`（谓词，默认 `threshold_should_compact` >60% 提前压）+ `context_do_compact`（动作，默认 `summary_do_compact`）首批 exclusive context EP。forked scope 显式选 `reject_should_compact`（恒返 false）→ tryCompact 谓词检查处 return → **结构上不可能递归 compact**（防递归靠 scope 隔离 + 显式 dummy，不靠运行时 flag）。→ `context_compact_detail.md` §2c + `extension point and implementations.md` §3.7
6. **[v0.0.40] 源/汇可注入（D1=B）+ [v0.0.49 D15] sink 对称 EP 化**——current 与 forked 都走 `contextEngine.ingest/assemble(scopeId, buffer)`（v0.0.49 起骨架直调，删 ContextPort/ForkedContextPort 中间层，修复 v0.0.40-0.0.48 ForkedContextPort 直接 `buffer.push()` 绕过 impl 链的死代码）；源（读哪）/汇（写哪）下沉到 impl 链：default=`transcript_reader` + `base_builder` + chain 尾 `store_sink`（v0.0.49 D15 EP 化，替代 context-engine.ts `if scopeId !== FORKED` 硬尾）/ forked=`buffer_reader` + `append_passthrough`（原样返回，**不 rebuild 保 cache 前缀**）+ chain 尾 `buffer_sink`。→ `context_engine.md` §3.6
7. **system_reminder 注入末条 user message，不进 system prompt**——保 prompt cache；snapshot.system 是 role=system 的 message（随 messages[0] 发，不另走 CanonicalRequest.system）。→ `system_reminder.md` §1 + `context_snapshot_interface.md` 头注
8. **reminder 双标记（块级 + 消息级共存）**——`system_reminder_injector` 生成 reminder block 时同时设块级 `TextBlock.isSystemReminder=true`（前端 `DEFAULT_BLOCK_FILTER` 精确隐这一块，不误伤同 message 的 user 正文）+ 消息级 `metadata.isSystemReminder=true`（兼容旧路径/按消息级读取的工具）。反例：仅消息级则前端要么整条隐要么不隐（两难）；仅块级则旧工具失效。两套标记都不进 wire，对 LLM 零侵入。→ `system_reminder.md` §4 + `../message/[P0]agent_message_interface.md` §4.1
9. **[v0.0.54.compaction] compact 接口 409 简化 + subagent 放开**——`POST /session/:id/compact` 唯一 409 = `compact_in_progress`（`summaryTask.status==='running'`）；删 `session.state==='running'/'interrupting' → 409` 旧 guard（forked agent 不碰 session.state/Run，与主对话 AgentLoop 在写 buffer 上正交——session.state 与 compact 正交，旧 guard 是误解）。compact 互斥由接口层 summaryTask 检查 + 内部 `markSummaryRunning` CAS 双保险保证。同时 subagent 放开（不再 403）——subagent 长跑上下文同样会爆炸，必须 support 手动 + 自动 compact。原则：**任何 session 任何时间都能 compact，除非 compact 正在跑**（subagent 防爆炸关键）。→ `context_compact_detail.md` §2b + `../../../api/overall/04-agent-session.md` §7 + `../../../api/overall/10-multi-agent.md` §4.3
10. **[v0.0.54.compaction] compact task message = 纯 directive（forked 不变量）**——compact prompt 只下「概括上面对话历史」指令，**不复述 `serialized_transcript`、不注入 `old_summary`**。snapshot 是唯一信息源（system + messages + reminder 已在 forked buffer 中），复述等于把对话历史发两遍——破坏 cache 命中、违反 forked 不变量（详见 `../agent_interface_and_loop/[P0]agent_loop_side_run.md` §1）。`compact.md` 模板正文整删占位符；`serializeMessages` 函数已删（死代码）。→ `context_compact_detail.md` §3.0 + `prompt_content_files.md` §4/§5
11. **[v0.0.66] 主干零 isForked + session_store EP**——default 与 forked 共用同一套 ingest/assemble 主干逻辑，差异纯靠 `session_store` EP（exclusive）按 scope 选 impl 切换 + summary 驱动 rebuild：default=`persistent_session_store`（持久）/ forked=`in_memory_session_store`（per-session Map，`getSummary` 恒 null + `updateContextWindowUsage` no-op + `releaseSlot` 清内存槽）。`base_builder` 统一 `shouldRebuild = !prev || prev.messages 空 || (curVersion!==null && curVersion!==prevVersion)`，forked curVersion 恒 null → 永远 append 复用 prevSnapshot（无 isForked 判断）。删 4 buffer/system impl（`buffer_sink`/`buffer_reader`/`append_passthrough`/`system_prompt`），system prompt 由 context-engine.assemble 独立调 builder（design §1.3，复用规则同 base_builder）。**`appendNew` 按 id 用 transcript 原始版本覆盖 prev 中已有的**（保 tool_call 配对不被清理 reducer 中间状态剥掉）。**[v0.0.178] forked 切换到 `forked_builder`**：v0.0.173 删 base_builder append 分支后 forked agent 看不到 parent transcript（silent regression），新建 `forked_builder` reducer（同 EP，靠 scope 切换）复用固定 `LoopState.parentSnapshot` + summaryUpTo 后 in_memory 增量 upsert；caller 传固定 parentSnapshot（不能用漂移 state.snapshot，否则多轮重复）。主干 `ContextEngine.assemble` 仍零 forked 分支。→ `context_engine.md` §3.6 + `context_assemble_detail.md` §2/§5c
12. **[v0.0.80.t1] compact 触发点 = callLLM 前（prepareStage 后）+ sibling 双发 + 纯生产者**——`runTryCompact` 触发点从 `ingestAssistant`（callLLM 后、可能 hanging tool_use）迁移到 `run-react-loop.ts` 的 `prepareStage` 后 / `callLLM` 前（last msg 必 user/tool_result，干净）。`tryCompact` 谓词 true 后 deep clone snapshot ONCE → `void runSummarySibling + void runConsolidationSibling` 并发双发（替代旧 `await action.run + await triggerPostCompact` 串行链）。**summary = 纯生产者**：compact 只产 summary + accumulateUsage('forked') write；**[v0.0.81.compaction_bug] 不再 appendMessages compact_notice**（旧版 v0.0.16-v0.0.80.t1 还插一条 `role=system, metadata.kind=compact_notice` 留痕 message + UI 居中 pill，v0.0.81 判定「无信息量、只增消息数、还污染 assemble 上下文」整删，grep 0 残留）；删 `runTryCompact` 同步尾（re-assemble + setSystem + notifyUsageChanged）+ `runCompact` 内部 notifyUsageChanged 循环；usage 推送归正规 assemble 管线（`prepareStage`/`ingestAssistant`/`ingestToolResults` 每次 assemble 后 notify）。fork-2 handler 内部 acquire `'tier1_consolidation'` 锁（`../session/[P0]session_task_lock.md §6` 实接）。→ `context_compact_detail.md §2c.1/§2c.1.0/§2c.1.1/§2d`

13. **[v0.0.81.compaction_bug] compact 阈值纯使用比例 + assemble budget 0.95×limit−estimatedOutput + summary 1-block 3-段（三层独立但同源 estimated output 常量）**——
    - **compact 阈值**（`threshold_should_compact`）：`totalTokens / tokenLimit > compactRatio`（默认 0.6）—— **纯使用比例，不含 estimatedOutput**（旧口径 `(total+maxOutput)/limit` 把 estimated output 算进占用致刚到 60% 已逼近撞墙）。用户视角占用 = 已用/window，简洁可预期。
    - **assemble budget**（`base_builder`）：`budget_tokens = 0.95 × tokenLimit − estimatedOutput`（保护调 LLM 时 input + output 合计不过载）；summary block 始终放置（自身超 budget 丢 tail），recent 从新→旧累加至剩余预算。
    - **summary block 结构**：1 个 text content block（不是每消息 1 block）文本 3 段（preamble + head 段 `[msgid|role] content` + tail 段同格式）；`role=user`（非 system——recap 是 user 提供的上下文）；head∩tail 按 head 算去重。
    - **estimated output 常量**：`ContextWindowUsage.maxOutputTokens` = 估算输出常量（默认 20000，app_config `context.maxOutputTokens` 可覆盖；常量源 `session-usage-helper.ts DEFAULT_MAX_OUTPUT_TOKENS`，**非 model maxOutput，不随 model 变**）。字段名保留不改（持久化 record + SSE schema 兼容）。**消费边界**：✅ 进 assemble budget / ❌ 不进 compact 阈值 / ❌ 不进 UI 占用展示（component-usage-panel 进度条 4→3 段，去 reserve）。
    → `context_compact_detail.md §1/§2c.2/§2c.5` + `context_assemble_detail.md §6/§6.5` + `context_usage_detail.md §3` + `context_snapshot_interface.md §2` + `specs/ui/components/chat-page/component-usage-panel.md §2/§4/§5/§6`

14. **[v0.0.81.compaction_bug] UI messages by-id merge（防 transcript fetch 重置 SSE 累积态）**——`use-session-run-state.setMessages`（transcript fetch / loadMore prepend 路径）调 `merge-messages-by-id.ts.mergeMessagesById(prev, incoming, prepend)`：同 id 取 prev（保 SSE 累积的 tool_call rawArgs / pendingError），不覆盖；prepend=true（loadMore）补 prev 独有 id；prepend=false（transcript fetch）不补（transcript 是权威 list）。SSE reducer（`chat-slice-reducer`）已按 id dedup，本 helper 只管 transcript/loadMore 路径。修复「transcript fetch 重置已渲染的同 id 消息 → tool_call 增量丢失」bug。→ `specs/tech/app/frontend/[P0]component_architecture.md §3.4` + `app/web/src/components/chat-page/merge-messages-by-id.ts`

15. **[v0.0.82] forked 复用 main 产物保 cache（tools + snapshot 双对齐）**——forked wire body 与 main 必须前缀一致以命中 anthropic prompt cache。两层修复：(1) **tools 走 snapshot.tools**—— assemble 把 tools 写进 snapshot（与 main spec.toolDefinitions 同源），buildForkedDeps 读 `opts.snapshot.tools`（不读 `defaultToolDefinitions(workdir)` registry 全集，旧 24 vs main 20 分叉 cache_read 0%）；(2) **snapshot 对象直接复用**—— runCompact 收 `ContextSnapshot` 直读，不再收 assembleFn 回调（v0.0.16 历史过度设计）；caller 持 main state.snapshot 深拷贝传入，手动入口由 `ContextEngine.compact` 先 assemble。修复后实测 cache_read_input_tokens：MAIN 56%、SUMMARY/MEM_EXT 93%。→ `context_snapshot_interface.md §2` + `context_assemble_detail.md §7.5` + `../agent_interface_and_loop/[P0]agent_loop_side_run.md §4/§5` + `context_compact_detail.md §2b.3/§6.4`

16. **[v0.0.173] snapshot 永远 rebuild + clean view 分层（根治 tool_call 乱序 400）**——**root cause**：`role_merge`（assemble reducer 链内）合并相邻同 role 消息时吞掉被合并者 message id → 下轮 `base_builder.appendNew`（基于被污染 prevSnapshot）把被吞 id 当 newOnes 追加到末尾 → tool_use 落 tool_result 后 → MiniMax 顺序校验 400（prod leader session `01KXTN7GZZ4T4MBT1GVJ96J3RV`）。**解法（两层）**：(1) `base_builder` 永远 rebuild（删 append 分支 + appendNew + 3 workaround）= 确定性纯函数 f(summary, transcript)；同输入同输出保 prompt cache（cache 看 wire bytes 不看 JS 引用）；transcript id 严格单调（monotonic ulid）→ `[...transcript]` 天然有序。(2) 6 个清理 reducer 迁到新 EP `context_clean_view_reducer` + 新增 `ContextEngine.getCleanSnapshot(snapshot, scopeId)` = `structuredClone(messages)` 深克隆 + 跑 clean view 链 → 原 snapshot 不被 mutate（关键不变量）。**caller**：唯一喂 LLM 入口 `loop-stage-llm.callLLMForSpec` 改走 `getCleanSnapshot`。**encode wire 合并 vs clean view role_merge 职责不可互换**：clean 合原始 role（user/user）；encode 合 role 映射后（tool→user）的 wire role，clean 时还没 role 映射。→ `context_assemble_detail.md §2/§5b` + `context_engine.md §3 getCleanSnapshot` + `extension point and implementations.md §3.3/§3.10` + `specs/tech/version_logs/v0.0.173/change_log.md`

### 已知 issue / 待办（sibling 隔离失败 — v0.0.82 发现未修）

> **sibling 隔离失败：router 塌缩 modeKey → store 共享 slot → buffer 混合**。`AgentScopeRouter`（Min 方案）把所有非 current modeKey（summary/memory_extract）映射成单一 `scopeId='forked'`；`in_memory_session_store` 按 `(scopeId, sid)` 隔离 → summary + memory_extract 两 sibling 共享 `('forked', sid)` slot → `wireInitState` clearScopeSession + ingest 互踩累加 → **buffer 混合两任务内容**。实测（session 01KWTYPW8A3D9NQ8JMKDF3AKS9）SUMMARY trace messages[12] 同时含 summary reminder + memory_extract directive + memory_extract reminder + compact NO_TOOLS trailer——LLM 收三种矛盾指令。modeKey 全程正确（trace name + reminder 注入都对），坏在 router 把 modeKey 塌缩成 'forked' scope，store 隔离层拿不到 modeKey 维度。
> **修复方向（待立项）**：router 改 `return modeKey`（per-modeKey scope：summary/memory_extract 各一个 entity）+ in_memory_session_store per-modeKey 注册 slot + ensureForked 建 per-modeKey scope entity。router 注释（`agent-scope-router.ts:26`）已自承「后续如需 per-modeKey 差异，router 改 map 即可」——v0.0.80.t1 加 sibling 双发时漏了这步。

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 链接 |
|---|---|---|
| **总纲 / 接口** | | |
| `context_engine.md` | ContextEngine 接口（ingest/assemble/compact + v0.0.173 getCleanSnapshot，v0.0.40 透传 scopeId）+ 复用 SessionConfig + 调 PluginManager 跑 ordered 链（§3.5）+ 源/汇可注入（§3.6） | [link]([P0]context_engine.md) |
| `extension point and implementations.md` | 11 context EP（8 ordered + 3 exclusive；含 v0.0.173 `context_clean_view_reducer`）+ 57 rocky_context impl 整合索引 + 8 impl 显式 configSchema + manifest 结构 | [link]([P0]extension point and implementations.md) |
| **方法 detail** | | |
| `context_ingest_detail.md` | ingest：ordered handler chain + 固定落库 + truncate offload + IngestHandler 契约 | [link]([P0]context_ingest_detail.md) |
| `context_assemble_detail.md` | assemble：mapper + assemble_reducer（v0.0.173 只剩 base_builder）+ clean_view_reducer（§5b）双 EP + base_builder 永远 rebuild（§2）+ head/tail 选取 | [link]([P0]context_assemble_detail.md) |
| `context_compact_detail.md` | compact：forked agent 压缩 + summaryUpTo 推进 + 压缩 prompt 模板 + **v0.0.40 §2c tryCompact 胶水 + 2 exclusive EP** + **v0.0.51 §2d post-compact handler EP（context_post_compact + memory_skill_consolidation）** | [link]([P0]context_compact_detail.md) |
| **数据类型 / usage** | | |
| `context_snapshot_interface.md` | ContextSnapshot / ContextWindowUsage / SummaryInfo 类型定义 | [link]([P0]context_snapshot_interface.md) |
| `context_usage_detail.md` | usage 调用时机（accumulate/update）+ context window 估算（char×ratio + ratio 学习） | [link]([P0]context_usage_detail.md) |
| **内容构建** | | |
| `system_prompt.md` | system prompt 构建：map→reduce→build 三阶段 + PromptFragment/tier + budget_truncate | [link]([P0]system_prompt.md) |
| `agent_profile.md` | 「定义你的 agent」section mapper（统一 mapper 按 kind 分支渲染 a/b/c 路径说明，v0.0.232） | [link]([P1]agent_profile.md) |
| `system_reminder.md` | system reminder：6 内置 provider 链（env/time/workspace/tool_error/todo/reachable_agents）+ 注入最后一条 user message 末尾（保 cache）；squad 系 provider 见 squad KB | [link]([P0]system_reminder.md) |
| `prompt_content_files.md` | prompt 正文文件读取层（PromptHandler 抽象基类 + 派生 handler + content 文件） | [link]([P0]prompt_content_files.md) |

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
