# v0.0.178 变更计划书 — UT 全量回归修复（3 簇：EP 计数 / forked mock / forked assemble 回归）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。
> coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 背景（root cause + 修复策略 — 三簇各自独立，唯一共性是 v0.0.173 改代码未同步测试/产品）

`bun run test` 全量 **20 fail / 9 文件**。三簇根因（**已通过加临时日志捕获真实 stack + 跑 actual 测试验证**，见 `states/v0.0.178/context.md` findings [architect 12:50-13:00]）：

### 簇1：EP/impl 计数测试过时（~9 fail，**改测试**）— 不动产品
v0.0.173 新增 EP `context_clean_view_reducer`（`BUILTIN_EXTENSION_POINTS` 16→17）+ 6 个清理 reducer 从 `context_assemble_reducer` 迁过来（mapper 不变 2 个 / assemble_reducer 7→1 / clean_view 新增 6）。计数测试与 i18n locale 未同步：
- 实际：17 EP / context_assemble_mapper=2 impl / context_assemble_reducer=1 impl（base_builder）/ context_clean_view_reducer=6 impl
- 计数断言测试还写旧值（16 EP / 3 mapper / 7 reducer / inventory 41）
- `context_clean_view_reducer` extPoint description 在 zh-CN + en locale 缺失

### 簇2：forked-agent mock 缺 getCleanSnapshot 方法（7 fail，**改测试**）— 不动产品
**真实 stack**（在 run-react-loop.ts:230 catch 加临时日志捕获）：
```
TypeError: spec.wireContextEngine.getCleanSnapshot is not a function
  at callLLMForSpec (loop-stage-llm.ts:53:54)
```
v0.0.173 在 callLLMForSpec 新增 `await spec.wireContextEngine.getCleanSnapshot(rawSnapshot, scopeId)`（`loop-stage-llm.ts:53`）。`forked-agent.test.ts:133-166` 的 `mockContextEngine()` 未 mock 该方法 → undefined → `.messages`/`.system` 访问 throw → loop catch 转 stopReason=error。

### 簇3a：forked assemble 父上下文丢失（2 fail，**改产品 — 真 bug**）
v0.0.173 base_builder 改「永远 rebuild」时**漏改 forked 路径**：
- v0.0.66 设计：forked assemble 走 base_builder append 分支，`[...prevSnapshot.messages, ...新增]` → forked agent 看 parent transcript + reminder + directive（`context-compact-runner.ts:24` 注释：`LLM 实际收到：[system, ...snapshot.messages, reminder, directive]——对话历史只出现一次`）
- v0.0.173 删 append 分支 + AssembleData.prevMessages 字段，base_builder 只读 `data.transcript`（= in_memory store `[reminder, directive]`）→ parent transcript **完全丢失**
- **生产影响（silent regression 自 v0.0.173）**：compact forkedRun('summary') 的 LLM 只看到 [reminder, directive]（"请总结以下对话..."但**无对话内容**），产出的 summary 空洞 → 主对话 compact 后失去历史上下文
- 修法：在 `ContextEngine.assemble` 给 scopeId='forked' 加 prepend 分支（`picked = [...prevSnapshot.messages, ...rebuild]`），base_builder 保持纯函数不动

### 簇3b：assemble-prev-snapshot-ratio 测试 v0.0.66 append 语义过时（1 fail，**改测试**）— 不动产品
该测 P0-1 case 验证 default scope 的「连续两次 assemble + version 不变 → 第二次末尾追加 m4」（v0.0.66 append 分支语义）。v0.0.173 删 append 后两次都 rebuild，snap2 末尾不是 m4 而是 `summary:1`（rebuild 始终产 `[summaryMsg, ...recent]`）。测试写的就是已删的 append 行为。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（context_engine / i18n / test / locale） |
| 文件路径 | 完整相对路径（worktree 根为准） |
| 函数/符号 | 函数名或符号名（行粒度 = 符号） |
| 类型 | 新增 / 修改 / 删除（标注：改产品 code / 改测试 test / 改 locale / 改 spec-doc） |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

## 变更清单

### 一、簇1：EP/impl 计数测试过时（改测试 + locale）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| test | app/server/src/channel/__tests__/channel-ep-registration.test.ts | `it('不重排其他 EP（... 长度 = 16 ...）')` 断言（L34） | 修改（test） | `expect(BUILTIN_EXTENSION_POINTS.length).toBe(16)` → `.toBe(17)`。注释同步：`v0.0.173 加 context_clean_view_reducer → 17 EP`。 | MUST 用 17（实际值，extension-point.ts L279-305 数组）；MUST NOT 改其他断言（channel 仍在、see_image/skill_market 仍末两位） | extension-point.ts L99-104 新 EP；L286 数组项 | +1 / -1 |
| test | app/server/src/plugin/__tests__/group-meta-loader.test.ts | `it('加载真实 groups.json，10 group + 16 EP ...')`（L51） | 修改（test） | 标题 + 断言：`16 EP` → `17 EP`，`toHaveLength(16)` → `toHaveLength(17)`。 | MUST 与 groups.json L13（context-assemble.extPoints 含 3 项）实际匹配（context_clean_view_reducer 已加）；MUST NOT 改 10 group（数量未变） | app/plugins/groups.json L9-14（context-assemble group L13 含 3 EP） | +3 / -3 |
| test | app/server/src/plugin/__tests__/group-meta-loader.test.ts | `it('真实 groups.json 中 15 EP 归属按 D5...')`（L88） | 修改（test） | 标题：`15 EP` → `16 EP`；`context-assemble` 断言加 `context_clean_view_reducer`：`expect(byId.get('context-assemble')).toEqual(['context_assemble_mapper', 'context_assemble_reducer', 'context_clean_view_reducer'])`。 | MUST 包含 context_clean_view_reducer（groups.json L13 已声明）；MUST NOT 改其他 group 归属（D5 不变量） | groups.json L9-14 | +2 / -2 |
| test | app/server/src/plugin/__tests__/group-meta-provider.test.ts | `it('Loader.load() → LoadedGroupMetaProvider 构造成功（真实 10 group + 16 EP ...）')`（L103-117） | 修改（test） | 标题：`16 EP` → `17 EP`；`expect(allPoints).toHaveLength(16)` → `17`。 | MUST 用 17；MUST NOT 改 10 group 断言 | group-meta-loader.test.ts 同步 | +2 / -2 |
| test | app/server/src/plugin/__tests__/group-meta-provider.test.ts | `it('真实 groups.json: getGroupByPoint("llm_provider")...')`（L120-138） | 修改（test） | 新增断言：`expect(provider.getGroupByPoint('context_clean_view_reducer')?.id).toBe('context-assemble')`。 | MUST 断言 context_clean_view_reducer 归属 context-assemble（groups.json L13 已声明） | groups.json L13 | +1 / -0 |
| test | app/server/src/plugin/__tests__/scope-config-loader.test.ts | `it('读取真实 default.yaml + forked.yaml，... activatedPoints 正确')`（L45-79） | 修改（test） | (1) `default.yaml 全 15 EP 激活` 注释 + `expect(d.activatedPoints).toHaveLength(15)` → `16`（v0.0.173 新增 context_clean_view_reducer 节点）；(2) `forked 10 context EP 激活` + `expect(f.activatedPoints).toHaveLength(10)` → `11`。 | MUST 用 16/11（实际 scope yaml 中 activated pointId 数）；MUST NOT 改 exclusivePicks 断言（threshold/summary/persistent 等不变） | app/plugins/scopes/default.yaml L45-54（context_clean_view_reducer 节点）；app/plugins/scopes/forked.yaml L43-52 | +4 / -4 |
| test | app/server/src/plugin/__tests__/scope-config-loader.test.ts | `it('default.yaml 固化 ordered EP order（base_builder=1 / snip=2 / ... role=7）')`（L81-95） | 修改（test） | 拆为两段断言：`context_assemble_reducer` 只剩 `base_builder=1`；`context_clean_view_reducer` 6 项 `snip_handler=1 / orphan_tool_call=2 / think_remove=3 / fill_empty_text=4 / empty_message=5 / role_merge=6`（v0.0.173 6 impl 迁 EP）。 | MUST 与 default.yaml L40-54 实际 order 一致；MUST NOT 改 system_prompt_reducer 链（tier_sort=1/dedup=2/budget_truncate=3 不变） | default.yaml L40-54 | +8 / -6 |
| test | app/server/src/plugin/__tests__/scope-config-loader.test.ts | `it('forked.yaml context_assemble_reducer 显式固化 order 1..7 ...')`（L122-132） | 修改（test） | 标题改：`context_assemble_reducer + context_clean_view_reducer`；断言：`context_assemble_reducer` 只 `base_builder=1`；新增 `context_clean_view_reducer` 6 项（snip=1/orphan=2/think=3/fill=4/empty=5/role=6）。 | MUST 与 forked.yaml L38-52 实际 order 一致 | forked.yaml L38-52 | +8 / -6 |
| test | app/server/src/agent/__tests__/assemble-pipeline.test.ts | `it('context_assemble_mapper 3 impl + context_assemble_reducer 7 impl')`（L85-94） | 修改（test） | 标题改：`context_assemble_mapper 2 impl + context_assemble_reducer 1 impl + context_clean_view_reducer 6 impl`；断言：mappers=2、assemble_reducers=1、新增 clean_view_reducers=6。 | MUST 与 plugin.json 实际匹配（mapper=transcript_reader/summary_reader；reducer=base_builder；clean=snip/orphan/think/fill/empty/role_merge） | rocky_context/plugin.json L147-222 | +5 / -3 |
| test | app/server/src/agent/__tests__/assemble-pipeline.test.ts | `it('全 impl inventory（...）= 41')`（L96-114） | 修改（test） | counts 对象加 `context_clean_view_reducer: 6`；mapper 3→2、reducer 7→1；total 41→40。 | MUST total=40（5+2+1+6+11+3+11+1）；MUST NOT 改 ingest=5/prompt_mapper=11/prompt_reducer=3/reminder=11/session_store=1 | plugin.json 实际计数 | +3 / -3 |
| locale | app/web/src/i18n/locales/zh-CN/plugin-config.json | `extpoint.context_clean_view_reducer.description` 键 | 新增（locale） | 在 `extpoint.context_assemble_reducer` 后追加：`"context_clean_view_reducer": { "description": "喂 LLM 前的「清理视图」ordered 链（reduce → Message[]，深克隆后跑，原 snapshot 不被触碰）" }`。 | MUST 与 extension-point.ts L103 占位符 `__MSG_extpoint.context_clean_view_reducer.description__` 对齐；MUST 中文（zh-CN 文件） | extension-point.ts L99-104 EP 定义；i18n key 约定 `extpoint.<id>.description` | +1 / -0 |
| locale | app/web/src/i18n/locales/en/plugin-config.json | `extpoint.context_clean_view_reducer.description` 键 | 新增（locale） | 在 `extpoint.context_assemble_reducer` 后追加英文 description：`Ordered chain for clean-up view before feeding LLM (reduce → Message[]; runs on deep-clone, original snapshot untouched)`。 | MUST 与 zh-CN 同位置（双 locale 键集对齐，groups-locale-coverage.test.ts 强制）；MUST 英文 | groups-locale-coverage.test.ts L90-102（双 locale 护栏） | +1 / -0 |

### 二、簇2：forked-agent mock 缺 getCleanSnapshot（改测试）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| test | app/server/src/agent/__tests__/forked-agent.test.ts | `mockContextEngine()` 返回的 `ce` 对象（L155-165） | 修改（test） | 新增 `getCleanSnapshot` spy：`const getCleanSnapshotSpy = vi.fn(async (snap: ContextSnapshot) => snap)`（透传入参 snapshot，UT 不验清理链）；加入返回对象 + return tuple。 | MUST 加方法（loop-stage-llm.ts:53 强制调用）；MUST 透传入参（mock 不验清理）；MUST NOT 在 spy 里 mutate snapshot（与生产 structuredClone 语义一致） | loop-stage-llm.ts L53 (`await spec.wireContextEngine.getCleanSnapshot(rawSnapshot, scopeId)`)；context-engine.ts L310-330 真实 getCleanSnapshot 行为 | +3 / -0 |

### 三、簇3a：forked assemble 父上下文丢失（改产品 — forked_builder + 固定 parentSnapshot）

> **方案（用户确认 2026-07-19）**：新建 `forked_builder` reducer 复用**固定 parent snapshot** + in_memory 累积增量；主干 `ContextEngine.assemble` **零 forked 分支**（守 v0.0.66 §2.3「差异靠 store EP impl 切换」）。比"assemble 加 prepend 分支"更干净（不打主干补丁 + 多轮正确）。
>
> **多轮正确性关键**：`forked_builder` 读 `ctx.prevSnapshot.messages` 必须是**固定 parent**（opts.snapshot），不能是每轮漂移的 `state.snapshot`。因为 `prepareStage` 每轮 `state.snapshot = assemble(...)` 把 snapshot 覆盖成 forked 自己的输出，若 prevSnapshot 漂移则第 2 轮起 `[...prevSnapshot.messages, ...transcript]` 会把 reminder/userMessage 重复（transcript 是 in_memory 累积全量，prevSnapshot 又带回上轮增量）。故 LoopState 加 `parentSnapshot`（固定）+ prepareStage forked 用它作 prevSnapshot。
>
> **多轮流转链路（已确认完整）**：ingest → in_memory store（per-runId 桶，append-only 累积）→ transcript_reader 读全量 → forked_builder。assistant/tool 每轮 ingest 到 in_memory，下一轮 transcript_reader 读累积 → 增量累积天然正确，forked_builder 只需补固定 parent 前缀。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| plugin_impl | app/plugins/builtins/rocky_context/assemble/forked_builder.ts | `ForkedBuilderReducer`（新增 class，implements AssembleReducer） | 新增（code） | forked scope 专属 reducer：`reduce(data, input, ctx) { if (input !== null) return input; const parent = ctx.prevSnapshot?.messages ?? []; return [...parent, ...data.transcript]; }`。复用固定 parent.messages + transcript_reader 读的 in_memory 累积增量。 | MUST `[...parent, ...transcript]`（parent 在前，对齐 context-compact-runner.ts:24 契约 `[system, ...parent, reminder, directive]`）；MUST NOT rebuild（forked 无完整 transcript，rebuild 缺 parent）；MUST NOT mutate prevSnapshot.messages；MUST NOT 读 summary（forked 无 summary）；依赖 ctx.prevSnapshot 是固定 parent（见下行 parentSnapshot 改动） | base_builder.ts（ContextImplBase / AssembleReducer 契约参考）；context-compact-runner.ts:24 | +30 |
| plugin_config | app/plugins/builtins/rocky_context/plugin.json | context_assemble_reducer EP 注册 `forked_builder` impl | 修改（config） | 注册 ForkedBuilderReducer 到 context_assemble_reducer EP（与 base_builder 同 EP；forked scope 激活 forked_builder，default 激活 base_builder）。 | MUST 注册（forked.yaml 引用 forked_builder）；default.yaml 不动（仍 base_builder） | plugin.json base_builder 注册段 | +3 |
| scope_config | app/plugins/scopes/forked.yaml | context_assemble_reducer impls + description | 修改（config） | context_assemble_reducer impls 从 `base_builder`（用户占位）改为 `forked_builder`；L14 description 去掉"base_builder 永远 rebuild"改述 forked_builder 复用 parent snapshot。 | MUST forked_builder；default.yaml 不动（base_builder） | forked.yaml L14 + L38-42 | +2 / -2 |
| loop_state | app/server/src/agent/loop-ports.ts | `LoopState` 加 `parentSnapshot: ContextSnapshot \| null`（可选） | 修改（code） | 新增可选字段（forked 固定 parent；main 不设 = null）。 | MUST 可选（main 不设）；forked 整 run 不变 | loop-ports.ts LoopState 定义 | +1 |
| forked_deps | app/server/src/agent/build-forked-deps.ts | `wireInitState` 返回加 `parentSnapshot: opts.snapshot` | 修改（code） | wireInitState 返回的 LoopState 加 `parentSnapshot: opts.snapshot`（固定 parent 全量，整个 run 复用）。 | MUST = opts.snapshot（固定 parent）；MUST NOT 每轮变 | build-forked-deps.ts L244-262 | +1 |
| loop_stage | app/server/src/agent/loop-stage-context.ts | `prepareStage` forked 分支 prevSnapshot 改用 `state.parentSnapshot` | 修改（code） | forked（drainMode='none'）L122: `state.snapshot = await ce.assemble(config, scopeId, state.parentSnapshot ?? null, { runId })`（固定 parent），不再用漂移的 `state.snapshot`。修多轮 prevSnapshot 漂移致 forked_builder 重复。 | MUST forked 用 parentSnapshot（固定）；MUST NOT 用 state.snapshot（漂移）；main 分支不动；state.snapshot 仍更新为 assemble 结果（callLLM 读 state.snapshot） | loop-stage-context.ts prepareStage L118-124 | +1 / -1 |
| spec-doc | specs/tech/agent/context_and_memory/[P0]context_engine.md | forked assemble 段 | 修改（spec-doc，doc-modifier 阶段 5 写） | 同步：forked scope 用 forked_builder（复用固定 parentSnapshot + in_memory 增量），主干零 forked 分支；多轮 parent 固定 + transcript 累积不重复。 | MUST doc-modifier 写 | 本 change_plan 簇3a | +6 / -3 |
| spec-doc | specs/tech/version_logs/v0.0.178/change_log.md | 新增 v0.0.178 条目 | 新增（spec-doc，doc-modifier 阶段 5 写） | roll-up：3 簇根因 + 修复（簇1 测试/locale 同步、簇2 mock 补 getCleanSnapshot、簇3a forked_builder + 固定 parentSnapshot 修 forked assemble、簇3b 测试过时）。 | MUST doc-modifier 写 | CLAUDE.md 阶段 5 doc-sync | +50 / -0 |

### 四、簇3b：assemble-prev-snapshot-ratio 测试 append 语义过时（改测试）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响 |
|---|---|---|---|---|---|---|---|
| test | app/server/src/agent/__tests__/assemble-prev-snapshot-ratio.test.ts | `describe('P0-1 ContextEngine.assemble prevSnapshot 端到端透传')` 整个 describe 块（L95-132） | 修改（test） | 改测 rebuild 不变量（v0.0.173 新语义）：(1) 同输入（summary version + transcript 不变）→ 同输出（picked 引用相等或 id 序列相等）；(2) transcript 新增 m4 → rebuild 的 recent 自动反映 m4（无需 append 分支）。删掉旧的「snap2 末尾 = m4 + 前缀保留」append 语义断言。 | MUST 测 rebuild 不变量（v0.0.173 设计核心）；MUST NOT 测已删的 append 行为（snap2 末尾 = m4 不再成立，summary 在前 recent 在后）；MUST 保 P2-3 ratio 测试不动（rebuild 的 head/tail 选取仍正确） | base_builder.ts L82-89 reduce（永远 rebuild）；v0.0.173 change_plan 簇二行 1（删 append 分支） | +12 / -18 |

### 五、簇3a 测试同步：context-engine-forked-scope 修产品后断言更新

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响 |
|---|---|---|---|---|---|---|---|
| test | app/server/src/agent/__tests__/context-engine-forked-scope.test.ts | `it("scopeId='forked' + prevSnapshot（父全量）... pickedIds").toEqual(['parent-a1', 'forked-u1'])`（L184-213） | 修改（test，仅注释） | 测试本体断言**不变**（产品修复后 `['parent-a1', 'forked-u1']` 即为正确行为）。更新注释：`base_builder append` → `ContextEngine.assemble forked prepend 分支（v0.0.178 修复）`。 | MUST 断言 `['parent-a1', 'forked-u1']`（修产品后真实行为）；MUST NOT 改断言值（产品修复后该断言通过） | 本 change_plan 簇3a 行 1（ContextEngine.assemble prepend） | +2 / -2 |
| test | app/server/src/agent/__tests__/context-engine-forked-scope.test.ts | `it("[v0.0.66 收尾] forked scope role_merge active：父末尾 + 新增同 role 合并")`（L215-241） | 修改（test） | v0.0.173 把 role_merge 迁到 `context_clean_view_reducer`（assemble 不再跑清理）。assemble 输出现在是 `[parent-u1, forked-u1]`（未合并），role_merge 在 `getCleanSnapshot` 才合并。修法：断言从 `toEqual(['parent-u1'])`（已合并）改为 `toEqual(['parent-u1', 'forked-u1'])`（assemble 输出，未合并）；可选补一条 `getCleanSnapshot(snap)` 后再断言 `['parent-u1']`（验清理链）。 | MUST 反映 v0.0.173 后清理分层（assemble 不跑 role_merge）；MUST NOT 期望 assemble 输出已合并（role_merge 已迁 clean_view EP） | extension-point.ts L99-104（context_clean_view_reducer EP 定义）；v0.0.173 change_plan 簇一行 1-7（6 impl 迁 EP） | +6 / -4 |

## 影响面评估

### 跨模块影响

| 模块 | 影响 |
|---|---|
| **产品代码（仅 1 处真 bug 修复）** | `ContextEngine.assemble` 加 forked prepend 分支（+6 行，scopeId gate + 数组拼接） |
| **base_builder / AssembleData** | 不动（保 v0.0.173 永远 rebuild 纯函数 invariant） |
| **测试（5 文件）** | (1) cluster 1: 5 文件计数/归属/order 断言更新；(2) cluster 2: forked-agent mock 加 getCleanSnapshot；(3) cluster 3b: assemble-prev-snapshot-ratio 改测 rebuild 不变量；(4) cluster 3a: context-engine-forked-scope 注释 + role_merge 断言更新 |
| **locale（2 文件）** | zh-CN + en 各加 `extpoint.context_clean_view_reducer.description` |
| **spec-doc** | 2 处（context_engine.md forked 段 + v0.0.178 change_log），doc-modifier 阶段 5 写 |

### 破坏性 / 兼容性

- **产品行为修复**：cluster 3a 修 forked assemble → compact / memory_extract / consolidation 等 forked agent 全部恢复看 parent 上下文。silent regression 自 v0.0.173（5 个版本）现在修。
- **API 契约**：零变更（assemble 是内部方法）。
- **prompt caching**：forked prepend 后 messages 前缀 = parent transcript（来自稳定 main snapshot），稳定 → cache 友好。
- **测试**：5 测试文件断言更新到 v0.0.173 后的实际值；无测试被删（只改断言）。
- **locale**：新增 2 个 key，不删旧 key。

### 依赖顺序（task 切分参考）

1. **locale + 测试计数（cluster 1+2+3b）** — 独立、互不依赖，可并行
2. **cluster 3a 产品修复（ContextEngine.assemble forked prepend）** — 独立，可并行
3. **cluster 3a 测试更新（context-engine-forked-scope 注释 + role_merge 断言）** — 依赖 task 2（产品修复后断言才过）
4. **spec-doc 同步** — doc-modifier 阶段 5 统一写

### 风险点

1. **forked prepend 顺序契约**：`[...prevSnapshot.messages, ...picked]` 必须保持 parent 在前、forked 增量在后。反了会破坏 `[system, ...parent, reminder, directive]` 契约（context-compact-runner.ts:24）。reviewer 必查。
2. **role_merge 在 clean view 后的边界**：cluster 3a 修复后 forked assemble 输出未合并；调用方需通过 `getCleanSnapshot` 才拿到合并后的视图。callLLMForSpec 已自动走 getCleanSnapshot（loop-stage-llm.ts:53），无额外改动。
3. **测试断言数值一致性**：cluster 1 各计数（17/16/11/2/1/6/40）必须与 plugin.json + extension-point.ts + scope yaml 实际值一致。reviewer 用 grep 复核。

### 无关模块（不动清单）

- **base_builder.ts**：纯函数不动（v0.0.173 rebuild invariant 保留）
- **clean-view-pipeline.ts / getCleanSnapshot**：v0.0.173 新增逻辑不动
- **loop-stage-llm.ts**：v0.0.173 加的 getCleanSnapshot 调用不动
- **build-forked-deps.ts / wireInitState**：不动（forked 装配链路本身正确，bug 在 ContextEngine.assemble）
- **plugin.json / extension-point.ts / scope yaml / groups.json**：v0.0.173 已配置正确，不动
- **6 个 clean reducer impl 文件**：v0.0.173 已迁 EP，代码不动

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- **本 change_plan 关键 invariant**（reviewer 必查）：
  1. cluster 3a forked prepend 仅 scopeId='forked' 启用，default 不动（v0.0.173 tool_call 乱序根治成果保住）
  2. cluster 3a 不 mutate prevSnapshot.messages（caller snapshot 不被污染）
  3. cluster 1 计数断言全部对齐实际值（17 EP / 2 mapper / 1 reducer / 6 clean_view / inventory 40 / 16 default activatedPoints / 11 forked activatedPoints）
  4. cluster 2 mock 加 getCleanSnapshot 但 spy 内不 mutate snapshot（与生产语义一致）
  5. cluster 3b 测 rebuild 不变量，不再测已删的 append 行为
  6. locale 双 locale 同步（groups-locale-coverage.test.ts 强制）
