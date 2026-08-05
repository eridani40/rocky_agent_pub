# v0.0.173 change_log — snapshot 永远 rebuild + clean view 分层（根治 tool_call 乱序 400）

> 跨版本发布说明（版本轴）。位置轴见 `specs/tech/agent/context/log.md`。method 级 review 合同见 `change_plan.md`。

## 背景（root cause 链 — req.md 坐实）

prod leader session `01KXTN7GZZ4T4MBT1GVJ96J3RV` 报 `LLM provider returned 400: tool result's tool id(call_xxx) not found (2013)`（MiniMax-M3），14:02→14:09 每轮同一 call id 失败；美术 session `01KXTQ0B4QFKHB2B0SNKNF887F` 6 处时序倒置。诊断依据：4 份 payload dump + transcript 数据对比，全程只读核实。

**致乱动作**：`base_builder.appendNew` 的「末尾追加不排序」。
**触发器**：`role_merge`（assemble reducer 链内）合并相邻同 role 消息时**吞掉被合并者的 message id**（后者 content 并入前者，前者 id 保留）。
**污染源**：清理 reducer 跑在 assemble 链内 → 输出直接进 `state.snapshot.messages` → snapshot 被清理污染 → 下轮 appendNew 基于被污染的 prevSnapshot。

**链路**：
1. leader: assistant `59Z9`(text) + assistant `6RK8`(text+tool_use) 相邻 → role_merge 合并进 `59Z9`(2text+tool_use)，`6RK8` id 消失
2. 下一轮 `base_builder.appendNew`：
   - `mergedPrev` 用 transcript 原版覆盖保留 id 的消息（恢复 tool_call block）
   - 被吞 id 不在 `prevIds` → 当 newOnes **追加到末尾**
3. 结果：tool_use（在被吞的消息里，末尾 idx251）落到 tool_result（`7396`，前部 idx201）**后面** → MiniMax 顺序校验失败

**曾误判的点**（避免后续 agent 重蹈）：不是 OrphanToolCallReducer 顺序问题（它查存在性配对，这对都在；reorderToolAdjacency 只单向向后扫）；不是 reissue 双记录（核实是不同 sender/内容）；不是 snapshot 写入漏收（是 role_merge 合并吞掉 id）。

## 修复策略（req 锁定）

- **snapshot 构建**：messages **永远 rebuild**（删 append 分支 + appendNew + 3 workaround）。snapshot = 确定性纯函数 `f(summary, transcript)`。system 复用规则保留（不参与本次重构）。
- **清理分层**：新增 `context_clean_view_reducer` EP（与 `context_assemble_reducer` 同构 ordered EP）。6 个清理 reducer（snip_handler / orphan_tool_call / think_remove / fill_empty_text / empty_message / role_merge）迁过去。assemble 链只剩 `base_builder`。
- **新增 `ContextEngine.getCleanSnapshot`**：`structuredClone(snapshot.messages)` → 跑 clean view 链 → 返回新 snapshot（深克隆，原 snapshot 不被触碰）。
- **调用方**：所有「喂 LLM」的直接消费点（即 `loop-stage-llm.ts:callLLMForSpec`）改走 `getCleanSnapshot`。
- **不动边界**：encode wire 合并、reminder 过滤 + cache_control、rebuild 的 summary 分支逻辑（summaryMsg + recent）、system 复用规则、6 个清理 reducer 的内部算法（仅迁移 EP，不改代码）。

## 13 项改动清单（method 级）

### 一、EP 注册（基础设施层）

1. `app/server/src/plugin/extension-point.ts` 新增 `ContextCleanViewReducerPoint` 常量（id=`'context_clean_view_reducer'`，cardinality=`'ordered'`，i18n 占位 description）+ append 进 `BUILTIN_EXTENSION_POINTS`（保持 context 子系统 EP 相邻，紧随 `ContextAssembleReducerPoint`）。
2. `app/plugins/builtins/rocky_context/plugin.json` 6 个清理 reducer impl 的 `point` 字段：`context_assemble_reducer` → `context_clean_view_reducer`（implId / impl 路径 / description / configSchema 全不变）。
3. `app/plugins/scopes/default.yaml` + `scopes/forked.yaml`：`context_assemble_reducer.impls` 只剩 `base_builder`；新增 `context_clean_view_reducer` 节点含 6 impl（顺序 = 原 assemble 链顺序）。
4. `app/plugins/groups.json` 的 `context-assemble.extPoints` 数组加 `context_clean_view_reducer`（影响 inventory/UI 分组 + `ScopeConfigValidator.validateGroups` bootstrap 强制校验 EP 必须属 group）。

### 二、assemble 链改造（base_builder 永远 rebuild + 删 appendNew + 删 prev_snapshot）

5. `base_builder.ts`：
   - `reduce()` 删 shouldRebuild 分支判定 + append 分支调用，函数体只剩 `if (input !== null) return input; return this.buildRebuild(data, ctx);`。
   - `buildRebuild()` 算法本身不动（保 summary 分支逻辑 = req 不动边界）；顶部注释更新。
   - `appendNew()` 函数（含 3 workaround）整段删除。
6. `types.ts` + `assemble-pipeline.ts` 两处 `AssembleData` interface 同步删 `prevMessages: Message[]` 字段。
7. `assemble-pipeline.ts::deepMergeAssembleData()` 删 accumulator `prevMessages: []` + 字段合并 `if (partial.prevMessages) acc.prevMessages = partial.prevMessages;`。
8. `app/plugins/builtins/rocky_context/assemble/prev_snapshot.ts` 整文件删除（贡献 prevMessages 的唯一 mapper）。
9. `plugin.json` 删 `prev_snapshot` impl 登记；`scopes/default.yaml` 的 `context_assemble_mapper.impls` 删 `prev_snapshot`；`scopes/forked.yaml` 同步注释。

### 三、clean view 链（新 pipeline + getCleanSnapshot）

10. **新增 `app/server/src/agent/clean-view-pipeline.ts`**（87 行）：`runCleanViewPipeline(pluginManager, messages, scopeId, config) → Message[] | null`；取 `ContextCleanViewReducerPoint` 的 active impl → 链式 `reduce(EMPTY_DATA, acc, ctx)`（input=messages 起步，base_builder 不参与）→ 返最终 Message[]；无 pluginManager 或链空 → null（caller fallback）。EMPTY_DATA = 占位空壳 data（clean reducer 都不读 data 字段）；单 reducer 失败降级 catch + 保留 acc。
11. **`ContextEngine.getCleanSnapshot(snapshot, scopeId)`** 新增（context-engine.ts:306）：(1) `structuredClone(snapshot.messages)` 深克隆；(2) `runCleanViewPipeline(this.pluginManager, cloned, scopeId, placeholderConfig) ?? cloned`（placeholderConfig.sessionId 从 snapshot.system 派生，fill_empty_text 写日志用）；(3) 返新 snapshot `{ ...snapshot, messages: cleaned }`（其他字段引用复用）。

### 四、调用方改造（喂 LLM 的直接消费点）

12. `loop-stage-llm.ts::callLLMForSpec`（L46-54）改走 `getCleanSnapshot`：
    - `rawSnapshot = state.snapshot!`
    - `cleanSnapshot = await spec.wireContextEngine.getCleanSnapshot(rawSnapshot, scopeId)`
    - `messages = [cleanSnapshot.system, ...cleanSnapshot.messages]`
    - `inputCharCount / contextWindowUsage / systemText` 读 **rawSnapshot**（cleanSnapshot 字段引用复用=同值，但显式取 rawSnapshot 表达「clean 不改 token 数」语义，cache 友好）。

唯一喂 LLM 入口 = `loop-stage-llm.callLLMForSpec`（已 grep 核实：context-engine.assemble 是 snapshot 生产者不是消费者；loop-stage-context.ts 读 lastMessageId 不喂 LLM；context-compact-runner.ts 同；forked agent 走同一 callLLMForSpec 一处覆盖；protocol-encode.ts 是 wire 层不动）。

### 五、测试改造

13. **删除**：`append-tool-pair.test.ts` 场景 B/C/D（验证已删 appendNew workaround）+ 顶部注释改「v0.0.173 rebuild 路径」；`append-real-session-v0161.test.ts` 整文件删。
    **保留**：`append-tool-pair.test.ts` 场景 A（rebuild 路径多轮一次性 ingest 后 tool_call 配对完整）。
    **新增**：
    - `append-tool-pair.test.ts` 场景 E（v0.0.173 prod session 复现 + 根治验证）：用真实 BaseBuilderReducer + RoleMergeReducer + OrphanToolCallReducer 端到端断言 tool_use.id 在 tool_result.id 之前。
    - `clean-view-pipeline.test.ts`（6 子 case）：空 pluginManager → null / 空链 → null / role_merge 合并 / orphan_tool_call 剥 / think_remove 剥 / 单 reducer throw 降级。
    - `get-clean-snapshot.test.ts`（4 子 case 强 invariant）：深克隆不变性 / role_merge 后原 snapshot 未 mutate / pluginManager=null 浅克隆 fallback / 其他字段引用复用。
    - 连锁：`assemble-mappers.test.ts`（删 PrevSnapshotMapper import + describe 块）/ `assemble-reducers.test.ts`（emptyData 删字段 + 删 2 个 append 失效测试）/ `base-builder-v081.test.ts`（emptyData 删字段）/ `agent-loop-user-msg-reissue.test.ts` + `drain-and-partition-sender.test.ts` 各 1 处历史脉络注释。

## 实施偏离记录（vs change_plan）

- **T2 连锁文件 7 个（change_plan §二漏列）**：`assemble-mappers.test.ts` / `assemble-reducers.test.ts` / `base-builder-v081.test.ts`（emptyData 删 prevMessages 字段 + 失效测试删除）/ `loop-stage-context.ts` 3 处注释 / `context-engine.ts` 1 处注释 / `agent-loop-user-msg-reissue.test.ts` + `drain-and-partition-sender.test.ts` 各 1 处历史脉络注释。属「删字段/删函数的直接必要连锁」，coder 汇报后未越界处理。
- **T3 `loop-stage-llm` `inputCharCount` 读 `rawSnapshot` 而非 `cleanSnapshot`**：change_plan §四未明示；显式取 rawSnapshot 表达「clean 不改 token 数」语义（cleanSnapshot 字段引用复用=同值，但显式取原值更直观），cache 友好。
- **T4 `get-clean-snapshot.test.ts` 改用 inline fake reducer 替代真实 BaseBuilderReducer + RoleMergeReducer**：change_plan §五写「MUST 用真实 BaseBuilderReducer + RoleMergeReducer 实例」，但 server tsconfig `rootDir:./src` 限制使 server 测试不能 import `app/plugins/` 源码（tsc TS6059）。改用 inline fake reducer（行为等价 role_merge 算法）。本测试目的是验证 structuredClone 深克隆 invariant，reducer 只需 mutate cloned messages 让 invariant 可观测即可；真实 reducer 行为由 `append-tool-pair 场景 E` 覆盖（plugins dir 可直 import）。
- **T1 漏 `groups.json` 登记**（阻塞全量 test）：T1 新增 ContextCleanViewReducerPoint EP 但 `app/plugins/groups.json` 的 `context-assemble` group `extPoints` 数组未同步加 → `ScopeConfigValidator.validateGroups`（plugin/scope-config-validator.ts:97-100）抛错 → 整个 bootstrap 链路崩 → 全量 test 265 fail / 39 文件。修法 = groups.json L13 加一项即可。T1 coversFiles 漏列此文件。orchestrator 直接补（按 memory `orchestrator-can-edit-devconfig-plugin-ext` 授权）。
- **`context-engine.ts` 353 行**（review 裁决：未破 450 行硬线，defer 拆分）。
- **`AssembleCtx.prevSnapshot` 字段保留**（T2 未删）：base_builder 不再读它，但 runAssemblePipeline 仍接收 + ctx 仍带；删字段会引发更大范围 fixture 改动（多个 UT 注入 prevSnapshot: null），超出 T2 coversFiles，不阻塞。

## 关键 invariant（reviewer 必查）

1. `BaseBuilderReducer.reduce()` 永远走 buildRebuild（无 shouldRebuild 分支 + 无 appendNew 调用）— ✅
2. `appendNew` 函数彻底删除（grep `appendNew` 产品代码归零）— ✅
3. `prev_snapshot` mapper 文件彻底删除（grep `prev_snapshot` 产品代码归零）— ✅
4. `AssembleData` 两处定义的 `prevMessages` 字段同步删除 — ✅
5. `ContextCleanViewReducerPoint` 在 extension-point.ts 定义 + BUILTIN_EXTENSION_POINTS 注册 — ✅
6. plugin.json 6 个 clean reducer 的 `point` 全部改 `context_clean_view_reducer` — ✅
7. scopes/{default,forked}.yaml 的 `context_assemble_reducer.impls` 只剩 `base_builder`；新增 `context_clean_view_reducer` 节点含 6 个 impl（顺序 = 原顺序）— ✅
8. `app/plugins/groups.json` 的 `context-assemble.extPoints` 加 `context_clean_view_reducer`（ScopeConfigValidator 强制校验 EP 必须属 group）— ✅
9. `ContextEngine.getCleanSnapshot` 用 `structuredClone` 深克隆，绝不 mutate 入参（UT 强 invariant 测试）— ✅
10. `loop-stage-llm.callLLMForSpec` 走 `getCleanSnapshot`（唯一喂 LLM 入口）— ✅
11. `append-tool-pair.test.ts` 场景 B/C/D 删除；新增 rebuild 乱序根治回归测试（v0.0.173 400 bug 回归保护）— ✅
12. spec 4 处更新与代码 100% 对齐（doc-modifier 阶段 5 核对）— ✅

## 验证结果

- typecheck 通过（worktree 内 `bun run typecheck`）
- 全量 UT 265 fail → 0（groups.json 修复后；AT 5/5 冒烟通过）
- AT 冒烟回归 **5/5 pass**（10.6s）：chat_send_tool / chat_send_reply / compact_model_directive / approval_allow_deny / ask_question_flow 全绿
- code-review ✅ CONDITIONAL PASS（4 task 全过，11 invariant 全核，无 Critical/Major；Minor 直接修：clean-view-pipeline EMPTY_DATA 简化 + spec 路径 + 注释瘦身 + 清 8 个 tsc 产物）

## 影响面

- **前端 / UI**：零破坏。snapshot.messages 内部变化不影响 SSE 事件契约 / API 响应体。
- **prompt caching**：rebuild 是确定性纯函数，summary 版本不变 + transcript 无 HITL 更新 → 同输入同输出 → wire bytes 前缀稳定 → cache 命中。**唯一风险点**：有 summary 时 head/tail 边界随消息数变可能 cache miss（上线后监控 caching 比例，掉太多再优化）。
- **持久化 record**：不影响历史 session 数据（transcript 落库 schema 不变；rebuild 是读侧，不写库）。
- **compact**：compact 路径走 forked agent → forked 走 callLLMForSpec → 自动经 getCleanSnapshot 覆盖。compact 的 snapshot 参数（来自 state.snapshot）现在是稳定 rebuild，读 lastMessageId 仍正确（= transcript 末尾 id）。
- **HITL tool_reply**：占位 block 编辑后同 id 落 transcript，rebuild 每轮读最新自然反映（这正是原 appendNew ① workaround 要处理的场景，rebuild 天然解决）。
- **forked scope**：forked 跑同一 callLLMForSpec（main+forked 共用），一处改动全覆盖；forked snapshot 也走 getCleanSnapshot。
- **API 契约**：零变更。

## 风险点（上线监控）

1. **rebuild 确定性纯函数 invariant**：rebuild 必须无 `Math.random` / 当前时间 / 外部状态。一旦混进非确定，cache 会默默废掉。当前 `buildRebuild` 算法已满足（pickHead/pickTail/buildSummaryBlock/pickRecentWithinBudget 都是纯函数）— reviewer 已查。
2. **structuredClone 深克隆 invariant**：getCleanSnapshot 必须深克隆，绝不 mutate 原 snapshot.messages。UT 强 invariant 测试已加（原 snapshot 字段值 + 元素引用不变）。
3. **clean view EP 注册一致性**：plugin.json + extension-point.ts + scopes/{default,forked}.yaml + groups.json 四处同步（漏一处 → builtin-loader / PluginManager 取不到 EP 或 impl，clean view 链空 → fallback 用原 messages → 仍有脏数据）。
4. **测试迁移完整性**：appendNew 相关场景 B/C/D 已删（测试已失效），新增的 rebuild 乱序根治回归测试已加（v0.0.173 400 bug 回归保护）。
5. **spec↔code 双向对齐**：doc-modifier 阶段 5 已同步 4 处 spec（context_assemble_detail / context_engine / extension point and implementations / log + index），无漂移。
