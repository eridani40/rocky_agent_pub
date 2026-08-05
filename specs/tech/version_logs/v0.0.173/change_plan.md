# v0.0.173 变更计划书 — snapshot / clean view 分层重构 + 修 tool_call 乱序 400

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 背景（root cause + 修复策略）

**Root cause**（`reqs/[working] v0.0.173/req.md` 已坐实）：
1. `role_merge`（assemble reducer 链内）合并相邻同 role 消息时**吞掉被合并者的 message id**（后者 content 并入前者，前者 id 保留）。
2. 下一轮 `base_builder.appendNew`：
   - `mergedPrev` 用 transcript 原版覆盖保留 id 的消息（恢复 tool_call block）
   - 被吞 id 不在 `prevIds` → 当 newOnes **追加到末尾**
3. 结果：tool_use（在被吞的消息里，末尾）落到 tool_result（前部）**后面** → MiniMax 顺序校验 400。

**致乱动作**：`appendNew` 的「末尾追加不排序」。**触发器**：`role_merge` 合并让 id 消失。**污染源**：清理 reducer 跑在 assemble 链内，输出直接进 `state.snapshot.messages` → snapshot 被清理污染 → 下轮 appendNew 基于被污染的 prevSnapshot。

**修复策略**（req 锁定）：
- **snapshot 构建**：messages **永远 rebuild**（删 append 分支 + appendNew + 3 个 workaround）。snapshot = 确定性纯函数 `f(summary, transcript)`。system 复用规则保留（不参与本次重构）。
- **清理分层**：新增 `context_clean_view_reducer` EP（与 `context_assemble_reducer` 同构 ordered EP）。6 个清理 reducer（snip_handler / orphan_tool_call / think_remove / fill_empty_text / empty_message / role_merge）迁过去。assemble 链只剩 `base_builder`。
- **新增 `ContextEngine.getCleanSnapshot`**：`structuredClone(snapshot.messages)` → 跑 clean view 链 → 返回新 snapshot（深克隆，原 snapshot 不被触碰）。
- **调用方**：所有「喂 LLM」的直接消费点（即 `loop-stage-llm.ts:callLLMForSpec`）改走 `getCleanSnapshot`。
- **不动边界**：encode wire 合并、reminder 过滤 + cache_control、rebuild 的 summary 分支逻辑（summaryMsg + recent）、system 复用规则、6 个清理 reducer 的内部算法（仅迁移 EP，不改代码）。

## 开放点结论（architect 决策）

### A1. `prev_snapshot` mapper 在 rebuild 路径下是否还需要？

**结论：删除**。grep `prevMessages` 全部消费方：
- `prev_snapshot.ts:36` 贡献者（自删）
- `assemble-pipeline.ts:175/186` deepMerge accumulator（自删字段）
- `base_builder.ts:220 appendNew()` 唯一真实消费方（随 appendNew 删除一起消失）
- `types.ts:178 AssembleData.prevMessages` 字段（自删）
- 6 个清理 reducer 全部 `_data: AssembleData` 不读（已核实）
- 4 个测试文件（`append-tool-pair.test.ts` / `append-real-session-v0161.test.ts` / `assemble-reducers.test.ts` / `assemble-mappers.test.ts`）—— 按本计划同步调整

**rebuild 路径只读 `data.transcript` + `data.summary`**，`prevMessages` 失去存在意义。删 mapper + 删字段 + 删 deepMerge 行，链条收敛。

### A2. clean view EP 的注册机制

- `extension-point.ts` 新增 `ContextCleanViewReducerPoint: ExtensionPoint` 常量（id=`'context_clean_view_reducer'`，cardinality=`'ordered'`）+ append 进 `BUILTIN_EXTENSION_POINTS` 数组。
- `plugin.json` 修改 6 个 clean reducer impl 的 `point` 字段：`context_assemble_reducer` → `context_clean_view_reducer`。**impl 文件代码、implId、configSchema 都不变**。
- `scopes/default.yaml` + `scopes/forked.yaml`：把 6 个 impl 从 `context_assemble_reducer` 节点迁到新增的 `context_clean_view_reducer` 节点；`context_assemble_reducer` 节点只剩 `base_builder`。**顺序保持原样**（snip_handler → orphan_tool_call → think_remove → fill_empty_text → empty_message → role_merge，对应原 default.yaml L43-49 / forked.yaml L42-48）。

### A3. getCleanSnapshot ↔ encode 衔接顺序

**衔接链**（落 change_plan 约束）：
```
ContextEngine.assemble → state.snapshot（稳定 rebuild，含原始 role + reminder block）
  ↓
ContextEngine.getCleanSnapshot(snapshot)
  = structuredClone(snapshot)
  + 跑 clean view 链（snip/orphan/think/fill/empty/role_merge）
  → 返回新 ContextSnapshot（messages 已清理，原 snapshot 不变）
  ↓
loop-stage-llm.callLLMForSpec
  messages = [cleanSnapshot.system, ...cleanSnapshot.messages]
  ↓
toLogicalMessages → protocol.encode
  做 wire 层：tool→user role 映射 + mergeAdjacentSameRole（wire 合并）
  + reminder 过滤（isSystemReminder 标记）+ cache_control bp#1/bp#2
```

**职责不可互换**（req 锁定）：clean view 的 `role_merge` 合并的是**原始 role**（user/user、assistant/assistant）；encode 的 `mergeAdjacentSameRole` 合并的是**role 映射后**（tool→user）的 wire role。clean 时还没 role 映射，做不到 wire 合并的职责。两层独立，不互删、不抽公共函数。

### A4. 清理 reducer 迁到 clean view 链后的 priority 顺序

**结论：保持原 assemble 链顺序不变**（snip_handler=500 → orphan_tool_call=800 → think_remove → fill_empty_text → empty_message=700 → role_merge=600；scope yaml 显式序就是 priority）。理由：6 个 reducer 的相互依赖（如 `think_remove` 必须排在 `empty_message` 之前，否则删 reasoning block 后变空的 assistant 会被 empty_message 当「自然空」漏过；`role_merge` 排最后合并相邻同 role）已在原顺序里固化。迁移纯改 EP 归属，不动顺序。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（context_engine / context_assemble / clean_view / llm-stage / config / test / spec） |
| 文件路径 | 完整相对路径（worktree 根为准） |
| 函数/符号 | 函数名或符号名（新增 class/interface/type/常量各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

## 变更清单

<!-- 顺序：EP 注册（基础设施）→ assemble 链改（base_builder 重构 + prev_snapshot 删）→ clean view 链（新 EP + pipeline + getCleanSnapshot）→ 调用方（loop-stage-llm）→ 测试 → spec 同步 -->

### 一、EP 注册（基础设施层，先改后续才能挂新 impl）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| config | app/server/src/plugin/extension-point.ts | `ContextCleanViewReducerPoint` 常量 | 新增 | 新 EP 定义：`{ id: 'context_clean_view_reducer', cardinality: 'ordered', description: '__MSG_extpoint.context_clean_view_reducer.description__' }`。放在 `ContextAssembleReducerPoint` 之后（同 context 子系统块内）。 | MUST id 用 snake_case；MUST cardinality='ordered'（与 ContextAssembleReducerPoint 同构）；MUST 走 i18n 占位符（与现有 6 个 context EP 一致，description 不直接写文案） | 现有 ContextAssembleReducerPoint L80-86；`specs/tech/plugin_system/[P0]extension_point_interface.md §3` | +10 / -0 |
| config | app/server/src/plugin/extension-point.ts | `BUILTIN_EXTENSION_POINTS` 数组 | 修改 | 在 `ContextAssembleReducerPoint` 后追加 `ContextCleanViewReducerPoint`（保持 context 子系统 EP 相邻）。 | MUST append 进数组（builtin-loader 遍历此数组注册 EP）；MUST NOT 删除其他 EP | 现有 L261-286 数组结构 | +1 / -0 |
| config | app/plugins/builtins/rocky_context/plugin.json | 6 个 impl 的 `point` 字段：`orphan_tool_call` / `empty_message` / `think_remove` / `fill_empty_text` / `role_merge` / `snip_handler` | 修改 | 每个的 `"point": "context_assemble_reducer"` → `"point": "context_clean_view_reducer"`。**implId / impl 路径 / description / configSchema 全不变**。 | MUST 6 个全部迁移（漏一个就还有清理在 assemble 链污染 snapshot）；MUST NOT 改 implId（保测试 import 路径稳定）；MUST NOT 改 impl 文件路径 | plugin.json L193-227（6 个 clean reducer impl 登记） | +6 / -6 |
| config | app/plugins/scopes/default.yaml | `context-assemble` group 下 `context_assemble_reducer.points.impls` 节点 | 修改 | 节点下只保留 `base_builder`（删 snip_handler / orphan_tool_call / think_remove / fill_empty_text / empty_message / role_merge 6 项）。 | MUST `context_assemble_reducer` 只剩 `base_builder`（assemble 链不挂清理）；MUST 保 transcript_reader/summary_reader mapper 不动（prev_snapshot 在二节删） | default.yaml L41-49 | +0 / -6 |
| config | app/plugins/scopes/default.yaml | `context-assemble` group 新增 `context_clean_view_reducer` 节点 | 新增 | 在 `context_assemble_reducer` 之后追加 `- pointId: context_clean_view_reducer impls: [snip_handler, orphan_tool_call, think_remove, fill_empty_text, empty_message, role_merge]`（顺序 = 原 assemble 链顺序）。 | MUST 顺序与原 default.yaml L43-49 一致（保 reducer 依赖关系：think_remove 在 empty_message 前；role_merge 在最后）；MUST 在 context-assemble group 内（group 归属不变） | default.yaml 原顺序；req §二.6 | +8 / -0 |
| config | app/plugins/scopes/forked.yaml | `context-assemble` group 下 `context_assemble_reducer` 节点 | 修改 | 节点下只保留 `base_builder`（删 snip_handler / orphan_tool_call / think_remove / fill_empty_text / empty_message / role_merge 6 项，原 forked 显式固化 order 的 7 项变 1 项）。 | MUST forked 与 default 同构（clean view EP 也激活；forked 也跑清理——base_builder 正确后 5+1 个清理是格式保障，对齐 default） | forked.yaml L38-48 | +0 / -6 |
| config | app/plugins/scopes/forked.yaml | `context-assemble` group 新增 `context_clean_view_reducer` 节点 | 新增 | 在 `context_assemble_reducer` 之后追加 `- pointId: context_clean_view_reducer impls: [snip_handler, orphan_tool_call, think_remove, fill_empty_text, empty_message, role_merge]`（显式固化 order 与 default 一致，保 forked scope 激活后取源稳定）。 | MUST 与 default 顺序一致；MUST 显式列（forked scope 激活后取源 = forked，需显式列拿 order，否则走登记序补位可能漂移） | forked.yaml 原 L41-48 注释；default.yaml 同结构 | +8 / -0 |

### 二、assemble 链改造（base_builder 永远 rebuild + 删 appendNew workaround + 删 prev_snapshot mapper）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| context_assemble | app/plugins/builtins/rocky_context/assemble/base_builder.ts | `BaseBuilderReducer.reduce()` | 修改 | 删 shouldRebuild 分支判定（L94-107）+ append 分支调用（L106）；函数体只剩 `if (input !== null) return input; return this.buildRebuild(data, ctx);`。 | MUST 永远 rebuild（不再判 prevSnapshot/summary version）；MUST NOT 依赖 ctx.prevSnapshot（rebuild 是纯函数 f(summary,transcript)）；MUST 保留 `input !== null` 短路（防被误挂非链首时透传） | req §一.1；context_assemble_detail §2；context.md findings [orchestrator 21:50] | +1 / -25 |
| context_assemble | app/plugins/builtins/rocky_context/assemble/base_builder.ts | `BaseBuilderReducer.buildRebuild()` | 修改 | 函数体本身算法**不动**（无 summary → `[...transcript]`；有 summary → summaryMsg + head/tail + recent + budget）。仅更新顶部注释：移除「rebuild 路径（prevSnapshot 空 / summary version 变 / prev.messages 空）」的触发条件描述，改为「rebuild 是唯一路径（v0.0.173 重构：snapshot 永远 rebuild，增量分支删除）」。 | MUST NOT 改算法（保 summary 分支逻辑 = req 不动边界）；MUST NOT 改 summaryUpTo cutoff 逻辑（保 compact 场景 head/recent 切分）；MUST 改注释反映新语义（避免 spec/代码漂移） | req §五.13（tool_call 乱序由永远 rebuild 根治）；req §不动边界 | +3 / -3 |
| context_assemble | app/plugins/builtins/rocky_context/assemble/base_builder.ts | `appendNew()` 函数（L195-241 整段） | 删除 | 整个函数删除（含 workaround ① mergedPrev 覆盖 / ② 集合 diff / ③ summaryUpTo cutoff）。永远 rebuild 不需要 append 路径。 | MUST 彻底删（不留 @deprecated 僵尸）；MUST grep 确认无其他 caller（当前唯一 caller 是 reduce() L106，本表已删） | req §一.2；memory `delete-old-code-fully-when-replacing` | +0 / -47 |
| context_assemble | app/plugins/builtins/rocky_context/types.ts | `AssembleData` interface（L172-179） | 修改 | 删 `prevMessages: Message[]` 字段（含注释 L178）。interface 只剩 `transcript` + `summary`。 | MUST 删字段（无消费方，详见开放点 A1）；MUST NOT 改 transcript/summary 字段定义 | 开放点 A1 结论；types.ts L172-179 | +0 / -3 |
| context_assemble | app/server/src/agent/assemble-pipeline.ts | `AssembleData` 本地 interface（L29-34） | 修改 | 同步删 `prevMessages: Message[]` 字段。 | MUST 与 plugin types.ts 同步（duck typing 等价契约，两边对齐） | assemble-pipeline.ts L29-34 | +0 / -1 |
| context_assemble | app/server/src/agent/assemble-pipeline.ts | `deepMergeAssembleData()` 函数 | 修改 | 删 accumulator 初始值的 `prevMessages: []`（L175）+ 删字段合并 `if (partial.prevMessages) acc.prevMessages = partial.prevMessages;`（L186）。 | MUST 删两行（字段已从 AssembleData 移除）；MUST NOT 改 transcript/summary 合并语义 | assemble-pipeline.ts L168-189 | +0 / -2 |
| context_assemble | app/plugins/builtins/rocky_context/assemble/prev_snapshot.ts | 整个文件 | 删除 | `PrevSnapshotMapper` class 整个删除（贡献 prevMessages 的唯一 mapper，随字段一起废）。 | MUST 彻底删文件；MUST grep 确认无其他 import（仅 plugin.json 登记引用 + 测试，本表同步处理） | 开放点 A1；memory `delete-old-code-fully-when-replacing` | +0 / -39 |
| config | app/plugins/builtins/rocky_context/plugin.json | `prev_snapshot` impl 登记（L167-171） | 删除 | 整个 impl 对象删除（`{implId: "prev_snapshot", point: "context_assemble_mapper", impl: "./assemble/prev_snapshot.ts", ...}`）。 | MUST 删（文件已删，登记必随之删，否则 builtin-loader 找不到 .ts 崩） | plugin.json L167-171 | +0 / -5 |
| config | app/plugins/scopes/default.yaml | `context_assemble_mapper.impls` 下 `prev_snapshot` | 删除 | 节点下 `impls` 只剩 `[transcript_reader, summary_reader]`（删 `prev_snapshot`）。 | MUST 删；MUST NOT 删 transcript_reader/summary_reader（rebuild 还需要） | default.yaml L37-40 | +0 / -1 |
| config | app/plugins/scopes/forked.yaml | `context_assemble_mapper.impls` 注释 | 修改 | 注释从「transcript_reader/summary_reader/prev_snapshot 继承 default」改为「transcript_reader/summary_reader 继承 default」（节点本身 `impls: []` 不变，全继承 default）。 | MUST 同步注释（避免 spec/代码漂移） | forked.yaml L35-37 | +1 / -1 |

### 三、clean view 链（新 pipeline + getCleanSnapshot）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| clean_view | app/server/src/agent/clean-view-pipeline.ts | 整个文件 | 新增 | 新文件（≤150 行）。提供纯函数 `runCleanViewPipeline(pluginManager, messages, scopeId, config) → Message[] \| null`：经 `ContextCleanViewReducerPoint` 取 active reducers，链式 reduce（input=messages 起步，base_builder 不参与），返回清理后的 Message[]。链空 → 返回 null（caller fallback 原 messages）。结构抄 `assemble-pipeline.ts` 的 reducer 链段（L98-127）。 | MUST 单文件 ≤300 行（实际 ~80 行）；MUST 单 reducer 失败降级跳过（保留上一步 acc，同 assemble 链策略）；MUST 返回 null 时 caller fallback 用原 messages（不阻塞 LLM 调用） | assemble-pipeline.ts L98-127 reducer 链结构；req §二.6 | +80 / -0 |
| clean_view | app/server/src/agent/clean-view-pipeline.ts | `runCleanViewPipeline()` 函数 | 新增 | 函数签名：`runCleanViewPipeline(pluginManager: PluginManager \| null, messages: Message[], scopeId: string = 'default', config: SessionConfig): Message[] \| null`。实现：取 `ContextCleanViewReducerPoint` 的 active impl（`getExtensionImpls<AssembleReducer>(point, scopeId)`）→ 链式 `reduce(data, input, ctx)`（data 用空 transcript/summary 占位，input=messages 起步）→ 返最终 Message[]。无 pluginManager 或链空 → null。 | MUST 取 clean view EP（不得误取 assemble_reducer）；MUST NOT mutate 入参 messages（reducer 内部各自不可变处理已保证，pipeline 层不再额外克隆——getCleanSnapshot 上层已 structuredClone）；MUST tolerate single reducer throw（catch + 保留 acc，不中断链） | assemble-pipeline.ts `runAssemblePipeline` L83-127；6 个 clean reducer 的 reduce 签名（`reduce(data, input, ctx): Message[]`） | +35 / -0 |
| context_engine | app/server/src/agent/context-engine.ts | `ContextEngine.getCleanSnapshot()` 方法 | 新增 | 方法签名：`async getCleanSnapshot(snapshot: ContextSnapshot, scopeId: string = 'default'): Promise<ContextSnapshot>`。实现：(1) `const messages = structuredClone(snapshot.messages)` 深克隆；(2) `const cleaned = runCleanViewPipeline(this.pluginManager, messages, scopeId, /* config 占位 */) ?? messages`；(3) 返回 `{ ...snapshot, messages: cleaned }`（其他字段 system/tools/summary/contextWindowUsage/inputCharCount 复用原 snapshot，clean 只换 messages）。 | MUST `structuredClone` 深克隆（绝不 mutate 入参 snapshot.messages — req 关键约束）；MUST 返新 snapshot 对象（不 mutate 原 snapshot 任何字段）；MUST NOT 跑 assemble mapper/reducer 链（clean view 只跑 clean reducer）；MUST pluginManager=null 时返原 messages 的浅克隆 fallback（保 UT fixture 兼容） | req §二.7；开放点 A3 衔接链；memory `delete-old-code-fully-when-replacing`（新方法不与 assemble 冲突） | +25 / -0 |
| clean_view | app/server/src/agent/context-engine.ts | `import { runCleanViewPipeline } from './clean-view-pipeline'` | 新增 | 顶部新增 import。 | MUST 仅 import runCleanViewPipeline（其他 pipeline 内部 helper 不外泄） | context-engine.ts 顶部 import 段 | +1 / -0 |

### 四、调用方改造（喂 LLM 的直接消费点）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| llm-stage | app/server/src/agent/loop-stage-llm.ts | `callLLMForSpec()` — 取 messages 处（L46-54） | 修改 | L46-52 替换：从 `const snapshot = state.snapshot!; const messages: Message[] = [snapshot.system, ...snapshot.messages];` 改为 `const rawSnapshot = state.snapshot!; const cleanSnapshot = await spec.wireContextEngine.getCleanSnapshot(rawSnapshot, spec.scopeId); const messages: Message[] = [cleanSnapshot.system, ...cleanSnapshot.messages];`。后续 inputCharCount / systemText / contextWindowUsage 等读 cleanSnapshot（system 不被 clean view 触碰，仍等于原 system；inputCharCount 用原 snapshot 的 = 不重算，保 cache 稳定）。 | MUST 走 getCleanSnapshot（req §三.8 唯一喂 LLM 入口）；MUST 用 `spec.wireContextEngine` 拿 ce 实例（不引入新依赖）；MUST NOT mutate state.snapshot（getCleanSnapshot 内部已 structuredClone）；MUST 保留 inputCharCount/contextWindowUsage 字段透传原 snapshot 值（cache 友好，clean 不改 token 数） | req §三.8；开放点 A3；context_engine.md §3（getCleanSnapshot 落点） | +6 / -3 |

> **说明**：req §三.8 提到「context-engine / loop-stage-context / forked agent / encode 入口」需逐个 grep 梳理。已 grep 核实：
> - `context-engine.assemble()` 是 snapshot **生产者**（写 messages），不是 LLM 消费者 — 不改。
> - `loop-stage-context.ts` 读 `state.snapshot.messages[last].id` 用于 `triggerMessageId`（compact meta）— 在永远 rebuild 下 last.id = transcript 末尾 id（稳定可靠），不是喂 LLM — 不改。
> - `context-compact-runner.ts:127` 同上（取 summaryUpTo 锚点 id）— 不改。
> - `forked agent` 走同一 `callLLMForSpec`（loop-stage-llm.ts:40 入口，main+forked 共用）— 上表一处改动全覆盖。
> - `protocol-encode.ts` 是 wire 层 — req 不动边界明确禁改。
>
> **唯一喂 LLM 入口 = `loop-stage-llm.ts:callLLMForSpec`**，改这一处即根治。

### 五、测试改造

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| test | app/plugins/builtins/rocky_context/__tests__/append-tool-pair.test.ts | 场景 B（中间态过度清理 appendNew workaround 验证） | 删除 | 场景 B 整个 `it(...)` block 删除（验证的是已删的 appendNew mergedPrev 覆盖逻辑）。 | MUST 彻底删（appendNew 已删，测试无意义）；MUST NOT 改场景 A（多轮一次性 ingest 完整 tool_call + tool_result 配对在 rebuild 下仍成立） | req §四.11；append-tool-pair.test.ts 场景 A/B | +0 / -35 |
| test | app/plugins/builtins/rocky_context/__tests__/append-tool-pair.test.ts | 场景 C（v0.0.161 msgId 乱序 + 集合 diff 修复验证） | 删除 | 场景 C 整个 `it(...)` block 删除（验证的是已删的 appendNew 集合 diff 逻辑）。 | MUST 删（appendNew 已删） | req §四.11；append-tool-pair.test.ts 场景 C | +0 / -42 |
| test | app/plugins/builtins/rocky_context/__tests__/append-tool-pair.test.ts | 场景 D（compact summaryUpTo cutoff 验证） | 删除 | 场景 D 整个 `it(...)` block 删除（验证的是已删的 appendNew summaryUpTo cutoff）。 | MUST 删（appendNew 已删）；compact 场景的 summaryUpTo 切分逻辑现在归 buildRebuild（rebuild 自带 head/recent 切分），由下面新测试覆盖 | req §四.11；append-tool-pair.test.ts 场景 D | +0 / -45 |
| test | app/plugins/builtins/rocky_context/__tests__/append-tool-pair.test.ts | 文件顶部注释（L1-22） | 修改 | 改测试文件描述：从「v0.0.66 append 路径 tool_call/tool_result 配对回归测试」改为「v0.0.173 rebuild 路径 tool_call/tool_result 配对回归测试」。**场景 A 保留**（验证 rebuild 路径多轮一次性 ingest 后 tool 配对完整）。 | MUST 保场景 A 通过（rebuild `[...transcript]` 天然保 tool 配对）；MUST 反映新语义 | append-tool-pair.test.ts L1-22 | +3 / -10 |
| test | app/plugins/builtins/rocky_context/__tests__/append-real-session-v0161.test.ts | 整个文件 | 删除 | 验证的是 appendNew 在 v0.0.161 真实 session 重放下的修复（msgId 乱序场景）。appendNew 已删，测试无意义。 | MUST 删（appendNew 已删）；MUST grep 确认无其他文件 import 本测试 helper | req §四.11 | +0 / -200 |
| test | app/server/src/agent/__tests__/clean-view-pipeline.test.ts | 整个文件（新 UT） | 新增 | 新增 `runCleanViewPipeline` 的 UT：(1) 空 pluginManager → 返 null；(2) 空 clean view 链 → 返 null；(3) 链含 role_merge → 相邻同 role 合并（被合并者 id 消失但 clean view 是一次性，不影响下轮 rebuild）；(4) 链含 orphan_tool_call → 无配对 tool_call/tool_result 被剥；(5) 链含 think_remove → reasoning block 被剥；(6) 单 reducer throw → 降级跳过保留 acc。 | MUST 单文件 ≤300 行；MUST 用 fake pluginManager + fake reducer（不启真 store） | req §四.11；assemble-pipeline reducer 链测试模式 | +180 / -0 |
| test | app/server/src/agent/__tests__/get-clean-snapshot.test.ts | 整个文件（新 UT） | 新增 | 新增 `ContextEngine.getCleanSnapshot` UT：(1) 深克隆不变性 — 入参 snapshot.messages 调用后字段值/元素引用不变（关键不变量）；(2) 链含 role_merge → 返回的 snapshot.messages 中相邻同 role 已合并，**但原 snapshot.messages 保持原样未被 mutate**；(3) pluginManager=null → 返回的 messages 是原 messages 的浅克隆（不抛错）；(4) 返回的 snapshot 其他字段（system/tools/summary/contextWindowUsage/inputCharCount）与原一致。 | MUST 强 invariant 测试：原 snapshot 不被 mutate（structuredClone 落实）；MUST 用真实 BaseBuilderReducer + RoleMergeReducer 实例（端到端） | req §四.11 + §关键约束；开放点 A3 | +150 / -0 |
| test | app/plugins/builtins/rocky_context/__tests__/append-tool-pair.test.ts | 场景 E（**新增**：rebuild 乱序场景下 tool_use/tool_result 顺序保持） | 新增 | 新增 `it(...)` 验证 v0.0.173 根治：构造 transcript 中 assistant(tool_use) id < tool_result id（正常单调）+ 模拟历史「role_merge 把 assistant 合并进前一条」场景（用真实 role_merge reducer 跑），断言：(1) clean view 输出中 tool_use 与 tool_result 仍相邻且 tool_use 在前；(2) 多轮 rebuild 后（round N+1 transcript 加新消息）snapshot.messages 中 tool 顺序依然正确。**这正是 v0.0.173 prod session 复现 + 根治验证**。 | MUST 用真实 BaseBuilderReducer + RoleMergeReducer + OrphanToolCallReducer 实例（端到端）；MUST 断言 tool_use.id 在 tool_result 之前（修 v0.0.173 400 bug 的回归保护） | req §五.13；req root cause 链 | +60 / -0 |

### 六、spec 同步（doc-modifier 阶段 5 执行；本表只列产出预期）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| spec | specs/tech/agent/context/[P0]context_assemble_detail.md | §1 概述（reducer 链示意） + §2 增量构建与 cache + §2.6 appendNew + §5 reducer 表 | 修改 | (1) §1 reducer 链示意改为 `base_builder`（assemble_reducer EP，只剩本项）→ `context_clean_view_reducer` EP（6 项）；(2) §2 增量构建与 cache 整段重写为「snapshot 永远 rebuild（v0.0.173 重构）：确定性纯函数 f(summary, transcript)，删 append 分支 + appendNew + 3 workaround」；(3) §2.6 appendNew 算法块标记「**v0.0.173 已删**」整段移除；(4) §5 reducer 表把 6 个清理 reducer 的 EP 列从 `context_assemble_reducer` 改为 `context_clean_view_reducer`，base_builder 单独留在 assemble_reducer。 | MUST 由 doc-modifier 写（coder 只写代码）；MUST 同步代码实际（永远 rebuild + clean view 分层）；MUST NOT 删历史基线段（v0.0.8/v0.0.13/v0.0.52/v0.0.66 历史脉络保留） | CLAUDE.md「spec↔code 双向对齐」原则；req §不动边界 | +60 / -45 |
| spec | specs/tech/agent/context/[P0]context_engine.md | §3 接口定义 + §3.5 EP 调用表 | 修改 | (1) §3 接口签名新增 `getCleanSnapshot(snapshot, scopeId?): Promise<ContextSnapshot>` 方法定义 + 详细 JSDoc（深克隆 + 跑 clean view 链 + 不 mutate 原 snapshot）；(2) §3.5 ContextEngine 调用表新增一行：`getCleanSnapshot | context_clean_view_reducer | reduce 链（input=messages 起步）| 空 chain → 返原 messages 浅克隆`；(3) §4 与 Agent Loop 交互图新增 `getCleanSnapshot(state.snapshot)` 步骤插在 callLLMForSpec 之前。 | MUST 同步代码实际；MUST 反映开放点 A3 的衔接链（clean view 输出 → encode wire） | context_engine.md §3/§3.5/§4 | +35 / -3 |
| spec | specs/tech/agent/context/[P0]extension point and implementations.md | §2 context EP 列表 + §3 impl 表 | 修改 | (1) §2 新增 `context_clean_view_reducer` EP 定义（ordered，承接 LLM 视角的清理）；(2) §3 impl 表新增 6 行 clean view reducer（从 assemble_reducer 节迁过来）；(3) §3 删 `prev_snapshot` mapper 行（已删文件）。 | MUST 由 doc-modifier 写；MUST 与 plugin.json/extension-point.ts 同步 | extension_point_interface.md；plugin.json | +25 / -8 |
| spec | specs/tech/agent/context/log.md | 新增 v0.0.173 条目 | 新增 | 落 change_log roll-up：(1) root cause 一句话；(2) 13 项改动清单 roll-up（snapshot 永远 rebuild + clean view 分层 + getCleanSnapshot + 调用方改造 + 测试迁移）；(3) 不动边界（system 复用 / encode wire / reminder）；(4) 风险点（summary head/tail 边界随消息数变可能 cache miss，上线监控）。 | MUST 由 doc-modifier 写 | CLAUDE.md 阶段 5 doc-sync 强制项 | +50 / -0 |
| spec | specs/tech/version_logs/v0.0.173/change_log.md | 新增文件 | 新增 | 落 v0.0.173 version log（req root cause + 13 项 + 实施过程偏离记录）。 | MUST 由 doc-modifier 写 | CLAUDE.md 阶段 5 | +80 / -0 |

## 影响面评估

### 跨模块影响

| 模块 | 影响 |
|---|---|
| **extension-point / plugin.json / scope yaml** | 新增 1 个 EP 常量；6 个 impl 迁 EP；2 个 scope yaml 节点调整；1 个 mapper (prev_snapshot) 删登记 |
| **assemble-pipeline / base_builder / types** | base_builder 永远 rebuild（删 append 分支 + appendNew 函数）；prevMessages 字段从 AssembleData 删；prev_snapshot mapper 文件删 |
| **clean-view-pipeline（新文件）** | 新增 runCleanViewPipeline helper（结构抄 assemble-pipeline reducer 链） |
| **context-engine** | 新增 `getCleanSnapshot` 方法（structuredClone + 跑 clean view 链） |
| **loop-stage-llm** | 唯一喂 LLM 入口改走 getCleanSnapshot |
| **测试** | 删 3 个 appendNew 场景（B/C/D）+ 1 个 v0161 真实 session 测试文件；新增 clean-view-pipeline UT + getCleanSnapshot UT + rebuild 乱序根治回归测试 |
| **spec** | 4 处 spec 同步（doc-modifier 阶段 5） |

### 破坏性 / 兼容性

- **前端 / UI**：零破坏。snapshot.messages 内部变化不影响 SSE 事件契约 / API 响应体。
- **prompt caching**：rebuild 是确定性纯函数，summary 版本不变 + transcript 无 HITL 更新 → 同输入同输出 → wire bytes 前缀稳定 → cache 命中。**唯一风险点**：有 summary 时 head/tail 边界随消息数变可能 cache miss（req §为何 rebuild 不损 prompt caching 已标记，上线后监控 caching 比例，掉太多再优化）。
- **持久化 record**：不影响历史 session 数据（transcript 落库 schema 不变；rebuild 是读侧，不写库）。
- **compact**：compact 路径走 forked agent → forked 走 callLLMForSpec → 自动经 getCleanSnapshot 覆盖。compact 的 snapshot 参数（来自 state.snapshot）现在是稳定 rebuild，读 lastMessageId 仍正确（= transcript 末尾 id）。
- **HITL tool_reply**：占位 block 编辑后同 id 落 transcript，rebuild 每轮读最新自然反映（req §一.3 — 这正是原 appendNew ① workaround 要处理的场景，rebuild 天然解决）。
- **forked scope**：forked 跑同一 callLLMForSpec（main+forked 共用），一处改动全覆盖；forked snapshot 也走 getCleanSnapshot。
- **API 契约**：零变更。

### 依赖顺序（task 切分参考）

1. **基础设施先**（EP 注册 + scope yaml + plugin.json） — 其他 task 都依赖 ContextCleanViewReducerPoint 存在
2. **base_builder 重构 + 删 prev_snapshot + 删 appendNew** — 自包含，不依赖 clean view
3. **clean-view-pipeline 新建 + getCleanSnapshot** — 依赖 task 1 的 EP
4. **loop-stage-llm 改造** — 依赖 task 3 的 getCleanSnapshot
5. **测试改造** — 与对应产品代码 task 同 task（coder 边写边补 UT）
6. **spec 同步** — 由 doc-modifier 阶段 5 统一执行，不在 coder task 范围

### 风险点

1. **rebuild 确定性纯函数 invariant**：rebuild 必须无 `Math.random` / 当前时间 / 外部状态。一旦混进非确定，cache 会默默废掉。当前 `buildRebuild` 算法已满足（pickHead/pickTail/buildSummaryBlock/pickRecentWithinBudget 都是纯函数）— reviewer 必查。
2. **structuredClone 深克隆 invariant**：getCleanSnapshot 必须深克隆，绝不 mutate 原 snapshot.messages。UT 必须强 invariant 测试（原 snapshot 字段值 + 元素引用不变）。
3. **clean view EP 注册一致性**：plugin.json + extension-point.ts + scopes/{default,forked}.yaml 四处必须同步（漏一处 → builtin-loader / PluginManager 取不到 EP 或 impl，clean view 链空 → fallback 用原 messages → 仍有脏数据）。
4. **测试迁移完整性**：appendNew 相关场景 B/C/D 必须删（测试已失效），新增的 rebuild 乱序根治回归测试必加（否则 v0.0.173 400 bug 无回归保护）。
5. **spec↔code 双向对齐**：doc-modifier 阶段 5 必须同步 4 处 spec（context_assemble_detail / context_engine / extension point and implementations / log），漏改任一处会致「spec 声明 append 分支、代码永远 rebuild」漂移。

### 无关模块（不动清单）

- **UI**（`app/web/`）：零改动。
- **store schema / DB**：零改动。
- **API 契约**（`specs/api/`）：零改动。
- **protocol-encode.ts**（wire 层）：req 明确不动边界，不迁 reminder/cache_control/role 映射。
- **config/ulid.ts**：只读确认（monotonic 实现已满足 rebuild 天然有序），不改。
- **6 个 clean reducer impl 文件**：代码不改（仅 plugin.json point 字段迁移）。
- **compact 链路**（context-compact-runner.ts / tryCompact）：state.snapshot 现在是稳定 rebuild，读 lastMessageId 仍正确；forked 经 callLLMForSpec 自动覆盖。零改动。
- **ingest 链路**（context_ingest_handler）：零改动。
- **agent-loop-stage-pre.ts / drainAndPartition**：零改动（v0.0.161 user msg reissue 修复继续生效）。
- **system prompt 构建**（buildSystemPrompt）：零改动（system 复用规则保留）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- **本 change_plan 关键 invariant**（reviewer 必查）：
  1. `BaseBuilderReducer.reduce()` 永远走 buildRebuild（无 shouldRebuild 分支 + 无 appendNew 调用）
  2. `appendNew` 函数彻底删除（grep `appendNew` 应归零）
  3. `prev_snapshot` mapper 文件彻底删除（grep `prev_snapshot` 应只剩 spec/log 历史引用）
  4. `AssembleData` 两处定义（types.ts + assemble-pipeline.ts）的 `prevMessages` 字段同步删除
  5. `ContextCleanViewReducerPoint` 在 extension-point.ts 定义 + BUILTIN_EXTENSION_POINTS 注册
  6. plugin.json 6 个 clean reducer 的 `point` 全部改 `context_clean_view_reducer`
  7. scopes/{default,forked}.yaml 的 `context_assemble_reducer.impls` 只剩 `base_builder`；新增 `context_clean_view_reducer` 节点含 6 个 impl（顺序 = 原顺序）
  8. `ContextEngine.getCleanSnapshot` 用 `structuredClone` 深克隆，绝不 mutate 入参（UT 强 invariant 测试）
  9. `loop-stage-llm.callLLMForSpec` 走 `getCleanSnapshot`（唯一喂 LLM 入口）
  10. `append-tool-pair.test.ts` 场景 B/C/D 删除；新增 rebuild 乱序根治回归测试（v0.0.173 400 bug 回归保护）
  11. spec 4 处更新与代码 100% 对齐（doc-modifier 阶段 5 核对）
