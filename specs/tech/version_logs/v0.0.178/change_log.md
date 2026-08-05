# v0.0.178 change_log — UT 全量回归修复（3 簇：EP 计数 / forked mock / forked assemble silent regression）

> 跨版本发布说明（版本轴）。位置轴见 `specs/tech/agent/context/log.md`。method 级 review 合同见 `change_plan.md`。

## 背景（UT 全量回归 20 fail / 9 文件 — 三簇各自独立，唯一共性是 v0.0.173 改代码未同步测试/产品）

`bun run test` 全量 **20 fail / 9 文件**。三簇根因（已通过加临时日志捕获真实 stack + 跑 actual 测试验证，见 `states/v0.0.178/context.md` findings [architect 12:50-13:00]）：

| 簇 | fail 数 | 根因 | 修复策略 |
|---|---|---|---|
| 簇1：EP/impl 计数测试过时 | ~9 | v0.0.173 新增 EP `context_clean_view_reducer`（16→17 EP）+ 6 清理 reducer 从 `context_assemble_reducer` 迁过来（mapper 不变 2 个 / assemble_reducer 7→1 / clean_view 新增 6）。计数测试与 i18n locale 未同步 | 改测试断言（17/16/11/2/1/6/40）+ 补 `context_clean_view_reducer.description` 双 locale 键 |
| 簇2：forked-agent mock 缺 getCleanSnapshot | 7 | v0.0.173 在 `callLLMForSpec` 新增 `await spec.wireContextEngine.getCleanSnapshot(rawSnapshot, scopeId)`（`loop-stage-llm.ts:53`），forked-agent.test.ts 的 `mockContextEngine()` 未 mock 该方法 → undefined → `.messages`/`.system` 访问 throw → loop catch 转 stopReason=error | 改测试 mock（加 `getCleanSnapshot` spy 透传入参） |
| 簇3a：forked assemble 父上下文丢失（**真 bug**） | 2 | v0.0.173 base_builder 改「永远 rebuild」时漏改 forked 路径——v0.0.66 设计 forked 走 base_builder append 分支透传 parent transcript，v0.0.173 删 append 分支 + `AssembleData.prevMessages` 字段后，base_builder 只读 `data.transcript`（= in_memory store `[reminder, directive]`）→ parent transcript 完全丢失 → compact forkedRun('summary') 的 LLM 只看到 reminder+directive 但无对话内容，产 summary 空洞（silent regression 自 v0.0.173，5 个版本） | 改产品：新建 `forked_builder` reducer + 固定 `parentSnapshot` |
| 簇3b：assemble-prev-snapshot-ratio 测试 v0.0.66 append 语义过时 | 1 | 该测 P0-1 case 验证 default scope 的「连续两次 assemble + version 不变 → 第二次末尾追加 m4」（v0.0.66 append 语义）；v0.0.173 删 append 后两次都 rebuild，snap2 末尾不是 m4 而是 `summary:1`（rebuild 始终产 `[summaryMsg, ...recent]`） | 改测试：删旧 append 断言，改测 rebuild 不变量 |

## 簇3a 修复方案（用户确认 2026-07-19）— forked_builder + 固定 parentSnapshot

**方案**：新建 `forked_builder` reducer 复用**固定 parent snapshot** + in_memory 累积增量；主干 `ContextEngine.assemble` **零 forked 分支**（守 v0.0.66 §2.3「差异靠 store EP impl 切换」）。比「assemble 加 prepend 分支」更干净（不打主干补丁 + 多轮正确）。

**多轮正确性关键**：`forked_builder` 读 `ctx.prevSnapshot.messages` 必须是**固定 parent**（opts.snapshot），不能是每轮漂移的 `state.snapshot`。因为 `prepareStage` 每轮 `state.snapshot = assemble(...)` 把 snapshot 覆盖成 forked 自己的输出，若 prevSnapshot 漂移则第 2 轮起 `[...prevSnapshot.messages, ...transcript]` 会把 reminder/userMessage 重复（transcript 是 in_memory 累积全量，prevSnapshot 又带回上轮增量）。故 `LoopState` 加 `parentSnapshot`（固定）+ `prepareStage` forked 分支用它作 prevSnapshot。

**forked_builder 算法（用户精确化，从简单拼接 → summaryUpTo filter + upsert merge）**：
- `parent = ctx.prevSnapshot.messages.slice()`（含 summaryMsg + recent，原序，绝不 mutate）
- `summaryUpTo = ctx.prevSnapshot?.summary?.summaryUpTo`（parent summary 已总结到的 id）
- `newMsgs = transcript.filter(m => m.id > summaryUpTo)`（取 summaryUpTo 之后的「增量」；summaryUpTo null → 全部 transcript）
- upsert 合并：同 id 替换（update，HITL tool_reply 占位编辑后同 id 落 transcript 的场景）/ 新 id 按 ULID 升序 insert（保 summaryMsg 的 non-ULID id 原位不动——`isUlid()` 跳过 non-ULID 元素只与 ULID 比较，全局 sort 会排乱 summaryMsg）

**多轮流转链路（已确认完整未断）**：ingest（reminder/userMessage/assistant/tool）→ `in_memory_session_store`（Map<runId, Message[]> append-only，同 id upsert；per-runId 桶）→ transcript_reader 读全量 → forked_builder。增量累积天然正确，forked_builder 只补固定 parent 前缀。summary_reader 已从 forked.yaml 去掉（forked 无 summary）。sys 由 `ContextEngine.assemble` 独立处理（复用 `parentSnapshot.system`）。

## 改动清单（method 级）

### 簇1：EP/impl 计数测试 + locale 同步（11 处）

测试断言全量对齐实际值（17 EP / 2 mapper / 1 assemble_reducer(base_builder) / 6 clean_view_reducer / inventory 40 / default activatedPoints 16 / forked activatedPoints 11），涉及 5 个测试文件（channel-ep-registration / group-meta-loader / group-meta-provider / scope-config-loader / assemble-pipeline）+ 2 个 locale 文件（zh-CN + en plugin-config.json 补 `extpoint.context_clean_view_reducer.description` 键）。

### 簇2：forked-agent mock 补 getCleanSnapshot（1 处）

`forked-agent.test.ts:mockContextEngine()` 返回对象加 `getCleanSnapshot` spy：`vi.fn(async (snap) => snap)`（透传入参，UT 不验清理链）。加 spy 内不 mutate snapshot（与生产 structuredClone 语义一致）。

### 簇3a：forked_builder + 固定 parentSnapshot（产品修复，7 处）

| # | 文件 | 函数/符号 | 变更 |
|---|---|---|---|
| 1 | `app/plugins/builtins/rocky_context/assemble/forked_builder.ts` | `ForkedBuilderReducer`（新增 class，implements AssembleReducer） | 新增：forked scope 专属 reducer，summaryUpTo filter + upsert 合并算法（见上） |
| 2 | `app/plugins/builtins/rocky_context/plugin.json` | context_assemble_reducer EP 注册 `forked_builder` impl | 新增 impl 登记（与 base_builder 同 EP，靠 scope 切换） |
| 3 | `app/plugins/scopes/forked.yaml` | context_assemble_reducer impls | `base_builder` → `forked_builder`（default.yaml 不动）+ description 更新 |
| 4 | `app/server/src/agent/loop-ports.ts` | `LoopState.parentSnapshot`（新字段） | 新增可选字段（forked 固定 parent；main 不设 = null） |
| 5 | `app/server/src/agent/build-forked-deps.ts` | `wireInitState` 返回值 | 加 `parentSnapshot: opts.snapshot`（整 run 不变） |
| 6 | `app/server/src/agent/loop-stage-context.ts` | `prepareStage` forked 分支 | prevSnapshot 改用 `state.parentSnapshot`（固定），不再用漂移的 `state.snapshot` |
| 7 | `app/plugins/builtins/rocky_context/assemble/forked_builder.ts` i18n | `__MSG_plugin.builtin.rocky_context.impl.forked_builder.description__` | 双 locale（zh-CN + en）补键（reviewer Minor 直接修） |

### 簇3a 测试同步（2 处）

- `context-engine-forked-scope.test.ts`：测试本体断言**不变**（产品修复后 `['parent-a1', 'forked-u1']` 即为正确行为），仅更新注释；role_merge 断言改为 `['parent-u1', 'forked-u1']`（assemble 输出未合并，v0.0.173 后 role_merge 在 clean_view_reducer EP 由 getCleanSnapshot 跑，不在 assemble）。
- `assemble-prev-snapshot-ratio.test.ts`：删 v0.0.66 append 语义断言（snap2 末尾 = m4 不再成立），改测 rebuild 不变量（同输入同输出 + transcript 新增自动反映；contextWindow=100000 避免 budget 陷阱吞掉 recent）。

### 偏离 B（v0.0.177 forked.yaml 隐藏回归 — coder 额外发现 + 修复）

v0.0.177 简化 forked.yaml 的 `context_ingest_handler.impls` 只列 3 active impls（query_truncate/tool_result_truncate/store_sink），遗漏了 `system_reminder_injector` + `search_indexing` 的**显式 disabled 条目**——按 ScopeConfigLoader 语义「未列=继承 default=enabled」，这两个被错误激活（注释说 forked 关它们但实际没关）。修复：补回 `{implId, enabled: false}` 显式声明，对齐注释意图，同时修 `scope-config-loader.test.ts:111` + `search_indexing.test.ts:241` 两 fail。

## 不动边界

- **base_builder**（永远 rebuild 纯函数，v0.0.173 invariant 保留）
- **clean-view-pipeline.ts / getCleanSnapshot**（v0.0.173 新增逻辑）
- **loop-stage-llm.ts**（v0.0.173 加的 getCleanSnapshot 调用）
- **extension-point.ts / 6 clean reducer impl 文件**（v0.0.173 已配置正确）
- **API/UI/PRD**：纯技术修复，无用户可感知行为/界面变化（UT fix 版本，跳过 PRD/API/UI spec 同步）

## 关键 invariant（reviewer 必查）

1. forked_builder 仅 scopeId='forked' 启用，default 不动（v0.0.173 tool_call 乱序根治成果保住）。
2. forked_builder 不 mutate `ctx.prevSnapshot.messages`（用 `.slice()` 拷贝）。
3. forked_builder 不全局 sort by id（summaryMsg 的非 ULID id 会被排乱）。
4. caller（wireInitState + prepareStage）必须传固定 parentSnapshot，不能用漂移的 state.snapshot。
5. mock spy 内不 mutate snapshot（与生产 structuredClone 语义一致）。
6. locale 双 locale 同步（groups-locale-coverage.test.ts 强制）。

## 验证

- `bun run typecheck` ✅
- `bun run test` 全量 **8140/0 fail**（含 fix 前的 20 fail + 8120 pass 全部回归通过）

## spec 同步（doc-modifier 阶段 5）

- `[P0]context_engine.md`：§3 assemble JSDoc 加 v0.0.178 forked_builder 段（forked 用 forked_builder / 多轮固定 parentSnapshot / sys 复用 parentSnapshot.system）；§3.6 第 5 项 forked reducer 切换为 forked_builder；§3.6 forked-active impl 表更新；§4 交互图说明更新；frontmatter `updated → 2026-07-19`。
- `[P0]context_assemble_detail.md`：frontmatter `updated → 2026-07-19`；§当前形态段（10 个内置 impl 含 forked_builder）；§1 流程图 assemble_reducer 分支；§5 标题 + 表加 forked_builder 行；新增 §5c「forked_builder 算法」（背景 + 算法 + 关键不变量 + 多轮正确性 + 多轮流转链路 + 代码定位）。
- `[P0]extension point and implementations.md`：frontmatter `updated → 2026-07-19`；§1 概述 + impl 计数 47→48；§2 EP 表 assemble_reducer 行；§3.3 标题 + 表加 forked_builder 行 + v0.0.178 注；§3.9 in_memory_session_store 注；§5 manifest sample 加 forked_builder 行；§5 forked scope 配置（激活 forked_builder 替代 base_builder）；§6 EP 契约索引 assemble_reducer 行。
- `index.md`：frontmatter `updated → 2026-07-19`；顶部 banner 加 v0.0.178；④ 原则 11 末尾加 v0.0.178 forked_builder 段。
- `log.md`：新增 2026-07-19 v0.0.178 条目（位置轴顶部）。
