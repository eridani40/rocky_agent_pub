---
type: design
title: v0.0.49 — Context Ext Impl 对接 + Scope 配置（design.md §5 展开）
version: 0.1
updated: 2026-07-02
status: done
parent: specs/tech/version_logs/v0.0.49/design.md
related:
  - specs/tech/agent/context/[P0]context_engine.md
  - specs/tech/agent/context/[P0]extension point and implementations.md
  - specs/tech/agent/context/[P0]context_compact_detail.md
---

# Context Ext Impl 对接 + Forked Scope 配置

> 本文展开 `design.md §5`：forked 旁路 run 在新骨架下如何**真正走 contextEngine impl 链**（之前 `ForkedContextPort` 直接 `buffer.push()` 绕过链的死代码修复）。
>
> 用户决策对齐：D9 保留 contextEngine impl 链 / D11 tryCompact 统一挂载（forked scope `reject_should_compact` 恒 false 自动跳过）/ D14 Forked→forked 小写。

---

## 1. forked 三个 ext impl 契约（逐个核对）+ default sink EP 化（v0.0.49 新增 store_sink）

> 三 forked impl 已实现（`app/plugins/builtins/rocky_context/{ingest,assemble}/*.ts`），manifest 已登记（plugin.json line 45/175/233），forked scope 经 `ensureForkedScope` 启用。**v0.0.49 forked ext impl 零新增、零修改**——只是骨架终于开始调用它们。
>
> v0.0.49 新增 `store_sink`（§1.4）：default scope 专属 sink impl（EP 化修复 context-engine.ts:187-190 的 if 硬尾，对称于 forked 的 `buffer_sink`）。

### 1.1 `buffer_sink`（context_ingest_handler — forked 汇/写哪）

- **文件**：`app/plugins/builtins/rocky_context/ingest/buffer_sink.ts`
- **契约接口**：`IngestHandler.handle(messages: Message[], ctx: IngestCtx): Message[]`（同步）
- **行为**：
  - `ctx.buffer` 非空 → `for (m of messages) ctx.buffer.push(m)`（in-place mutate per-run 数组）；返回原 messages
  - `ctx.buffer` 空（default scope 误调 / UT 未注入）→ no-op 返回 messages
- **对齐新骨架**：✅ 新骨架调 `contextEngine.ingest(config, [msg], scopeId='forked', false, state.buffer)` → context-engine 把 `state.buffer` 注入 ctx → `buffer_sink` push 写回 buffer。骨架 `recordAssistant` 不再 `buffer.push`，**统一走 ingest 链**。

### 1.2 `buffer_reader`（context_assemble_mapper — forked 源/读哪）

- **文件**：`app/plugins/builtins/rocky_context/assemble/buffer_reader.ts`
- **契约接口**：`AssembleMapper.map(ctx: AssembleCtx): Promise<Partial<AssembleData>>`
- **行为**：
  - `ctx.buffer` 非空 → `{ transcript: ctx.buffer }`（贡献全部 buffer 给 AssembleData.transcript）
  - `ctx.buffer` 空 → `{}`（空贡献，不阻塞 deepMerge 链）
- **对齐新骨架**：✅ 新骨架调 `contextEngine.assemble(config, scopeId='forked', state.buffer)` → context-engine 把 buffer 注入 ctx → `buffer_reader` 读 buffer 贡献 transcript。骨架不再自取 `state.buffer`，**统一走 assemble 链**。

### 1.3 `append_passthrough`（context_assemble_reducer — forked 不 rebuild）

- **文件**：`app/plugins/builtins/rocky_context/assemble/append_passthrough.ts`
- **契约接口**：`AssembleReducer.reduce(data: AssembleData, input: Message[] | null, ctx: AssembleCtx): Message[]`（同步）
- **行为**：
  - `ctx.buffer` 非空 → 返回 `data.transcript`（buffer_reader 贡献的 buffer 原样，忽略 input）
  - `ctx.buffer` 空 → 返回 `input ?? []`（default scope 防御性 fallback，不干扰 base_builder 主链）
- **登记序**：snip_handler 之后（链尾 reducer）。前序清理 reducer（orphan/empty/role_merge/snip）的输出在 buffer 存在时被本 reducer 丢弃（return data.transcript 不取 input）→ 等价"不 rebuild"语义。
- **对齐新骨架**：✅ forked scope `base_builder` disable → `append_passthrough` 是唯一 active reducer → 返回 buffer 原样。**保 append-only 缓存前缀不变量**。

### 1.4 `store_sink`（context_ingest_handler — default 专属写 store，**v0.0.49 新增**）

- **文件**：`app/plugins/builtins/rocky_context/ingest/store_sink.ts`（**v0.0.49 新增**）
- **契约接口**：`IngestHandler.handle(messages: Message[], ctx: IngestCtx): Message[]`
- **行为**：
  - `ctx.store` 非空 → `ctx.store.appendMessages(ctx.config.sessionId, messages)`（写 store transcript 持久化）；返回原 messages
  - `ctx.store` 空（forked scope 不注入 / UT 未注入）→ no-op 返回 messages（防御性 fallback）
- **对齐新骨架**：✅ default scope run 新骨架调 `contextEngine.ingest(config, [msg], scopeId='default', false, undefined)` → context-engine 把 `wireStore` 注入 `ctx.store` → chain 尾 `store_sink` impl 写 store。**contextEngine 删 `if scopeId !== FORKED` 硬尾**（D15），default/forked sink 对称（都走 chain 尾 impl，非代码 if 分支）。
- **`IngestCtx` 字段（v0.0.49 加）**：`store?: SessionStore`（default scope 由 context-engine 注入 `wireStore`；forked scope 不注入；`store_sink` 读它）
- **区别于 `buffer_*` 三件套**：`buffer_sink`/`buffer_reader`/`append_passthrough` 是 v0.0.40 已有 impl（forked 专属）；`store_sink` 是 **v0.0.49 新增 impl**（default 专属），二者对称（chain 尾二选一）。

---

## 2. buffer 透传机制（per-run RunState 字段持有）

> spec `context_engine.md §3.6` 已声明：buffer 由 caller（`buildForkedDeps`）装配 ContextPort 时新建并传入 ctx。新骨架下 caller 改为 `buildForkedDeps` 装配 RunSpec/RunState，buffer 是 RunState 字段。

```typescript
// buildForkedDeps 装配：
const initialSnapshot = await contextEngine.assemble(config, 'default'); // 拿父 snapshot
const buffer: Message[] = [
  initialSnapshot.system,
  ...initialSnapshot.messages,
  userMessage,
];
const state: RunState = {
  ...,                // base 字段
  buffer,             // ★ forked 持引用（与 context-engine ctx.buffer 同一实例）
  ingestUpTo: null, llmUpTo: null,  // forked 不用游标
};
```

**关键不变量**：buffer 是 per-run 内存数组。`buildForkedDeps` 创建一次，`RunState.buffer` 持引用，每次 `contextEngine.ingest/assemble(scopeId='forked', state.buffer)` 传同一引用 → `buffer_sink` push 与 `buffer_reader` read 是同一数组（in-place mutate，append-only）。

**main 不持 buffer**：main RunState.buffer=null。`contextEngine.ingest/assemble(scopeId='default', undefined)` → ctx.buffer 空 → `buffer_sink`/`buffer_reader` no-op + `transcript_reader`/`base_builder`/`store.appendMessages` 主链跑（default scope 行为不变）。

---

## 3. 新骨架下 forked pipeline 实际跑哪些 impl

> 用户决策 D9：保留 contextEngine impl 链。下表是新骨架下 forked 一次 run 经 contextEngine 调用的实际 active impl 链（vs default 对照）。

### 3.1 `ingest(config, msgs, scopeId='forked', false, buffer)`

| EP | forked active impl 链（按 order） | default active impl 链（对照） |
|---|---|---|
| context_ingest_handler | `query_truncate` → `tool_result_truncate`（system_reminder_injector **disabled**）→ **`buffer_sink`**（链尾 append 到 buffer，**`store_sink` disabled**） | `query_truncate` → `tool_result_truncate` → `system_reminder_injector` → **`store_sink`**（v0.0.49 新增，chain 尾 append 到 store） |

> 注（D15）：v0.0.49 前 default 的 `store.appendMessages` 是 `if scopeId !== FORKED` 分支硬尾（`context-engine.ts:187-190`，**不对称于 forked 的 `buffer_sink` impl**，已标待修复）。v0.0.49 用 `store_sink` impl EP 化：default chain 尾 activate `store_sink`，forked chain 尾 activate `buffer_sink`（`store_sink` disabled）；contextEngine 删 if 硬尾，default/forked sink 对称（都走 chain 尾 impl）。

### 3.2 `assemble(config, scopeId='forked', buffer)`

| EP | forked active mapper | forked active reducer（链尾生效） |
|---|---|---|
| context_assemble_mapper | `buffer_reader`（transcript_reader/summary_reader/prev_snapshot/system_prompt 在 forked 都 disable 或 no-op）| `append_passthrough`（base_builder **disabled**；前序 orphan/empty/role_merge/snip 输出被本 reducer 丢弃） |
| system_prompt_mapper | （不激活，forked 不构建新 system——buffer[0] 已是父 snapshot.system） | — |
| system_prompt_reducer | （不激活） | — |

**产出**：snapshot.messages = buffer 整个原样。snapshot.system = buffer[0]（由 buffer_reader 贡献的 transcript 头）。snapshot.contextWindowUsage 复用初始 snapshot（forked 不重算）。

### 3.3 `tryCompact(pluginManager, { scopeId: 'forked', ... })`

| EP | forked active impl | 行为 |
|---|---|---|
| context_should_compact | `reject_should_compact`（setExclusive 显式选中）| `check()` 恒返 false → tryCompact 谓词检查处 return |
| context_do_compact | `noop_do_compact`（setExclusive 显式选中，defense-in-depth）| 结构上不可达（shouldCompact 恒 false） |

**结果**：forked run 永不 compact。骨架统一调 tryCompact，scope 路由自动跳过，**无需 if main/forked 分支**（D11）。

---

## 4. ext impl 改动确认（v0.0.49 新增 store_sink + context-engine.ts 改 if 硬尾）

| 项目 | 状态 |
|---|---|
| `buffer_sink` impl | ✅ 已实现（v0.0.40），零修改 |
| `buffer_reader` impl | ✅ 已实现（v0.0.40），零修改 |
| `append_passthrough` impl | ✅ 已实现（v0.0.40），零修改 |
| `reject_should_compact` / `noop_do_compact` | ✅ 已实现，零修改 |
| `try-compact.ts` 胶水 | ✅ 已实现（v0.0.40），零修改 |
| `store_sink` impl | 🆕 **v0.0.49 新增**（D15，default 专属 sink，对齐 `buffer_sink`；详见 §1.4） |
| `context-engine.ts` | 🔧 **v0.0.49 修改**（D15）：删 `if scopeId !== FORKED_SCOPE_ID store.appendMessages` 硬尾（line 187-190）+ `IngestCtx` 加 `store?: SessionStore` 字段（default 注入 wireStore / forked 不注入） |
| `context-ingest-pipeline.ts` ctx 注入 | 🔧 v0.0.49 加 `ctx.store` 注入（default scope，对齐已有 `ctx.buffer` 注入机制） |
| `assemble-pipeline.ts` ctx.buffer 注入 | ✅ 已实现，零修改 |

**结论**：v0.0.49 ext 侧 **1 个新增**（`store_sink`）+ **2 个修改**（`context-engine.ts` 删 if 硬尾 + `context-ingest-pipeline.ts` 注入 ctx.store），其余 forked ext impl 零修改。其他改动在**骨架（删 ContextPort + 调 contextEngine，drainMode 三态分支）+ 装配（buildForkedDeps 传 buffer+state，buildMainDeps 注入 wireStore 给 ctx.store）+ scope 配置（Forked→forked 小写 + disable store_sink in forked + activate store_sink in default）** 三处。

---

## 5. `ensureForkedScope` 逐项配置

> 文件：`app/server/src/agent/forked-scope-bootstrap.ts:55-85`（已实现，幂等）。新骨架下沿用，仅需做 D14 小写更名。

### 5.1 逐项配置表（沿用 + 标注 v0.0.49 是否动）

#### forked scope（`ensureForkedScope`）

| # | 配置项 | 当前值 | v0.0.49 动作 | 理由 |
|---|---|---|---|---|
| 1 | `createScope('forked', name, desc)` | `'Forked'` / 描述串 | **D14 改名**：`'Forked'` → `'forked'`（小写）；描述串保留 | 用户决策 D14：scope name 与 scopeId 一致（都小写），减少混淆 |
| 2 | `setExclusive('reject_should_compact', 'forked')` | 已设 | 不动 | 防递归 MANDATORY：谓词恒 false → tryCompact 跳过 |
| 3 | `setExclusive('noop_do_compact', 'forked')` | 已设 | 不动 | defense-in-depth + 让 exclusive EP 在所有 scope 都"总有人被选中"（不靠 disable 唯一实现造 zero-active） |
| 4 | `disableImplInForked('context_assemble_mapper', 'transcript_reader')` | 已 disable | 不动 | forked 不读 store transcript，由 `buffer_reader` 替代 |
| 5 | `disableImplInForked('context_assemble_reducer', 'base_builder')` | 已 disable | 不动 | forked 不 rebuild / 不 head-tail，由 `append_passthrough` 替代 |
| 6 | `disableImplInForked('context_ingest_handler', 'system_reminder_injector')` | 已 disable | 不动 | forked 不注入 reminder 到 buffer（reminder 会污染 cache 前缀） |
| 7 | **`disableImplInForked('context_ingest_handler', 'store_sink')`** | — | 🆕 **v0.0.49 新增 disable**（D15）| forked 不写 store（chain 尾是 `buffer_sink`）；删 context-engine.ts if 硬尾后**必须显式 disable**，否则 `store_sink` 会被 chain 选中误写 store（若 ctx.store 万一被注入） |
| 8 | 隐式：`buffer_sink` / `buffer_reader` / `append_passthrough` enabled | activateEp 复制 default 配置带上 enabled=true | 不动 | P0 默认开，无需显式 enable（spec §3.6 已声明） |

#### default scope（plugin.json P0 或 `ensureDefaultScope`）

| # | 配置项 | v0.0.49 动作 | 理由 |
|---|---|---|---|
| D1 | `activate('context_ingest_handler', 'store_sink')` | 🆕 **v0.0.49 新增 activate**（D15） | default scope chain 尾必须有 sink impl 写 store；plugin.json P0 标 `enabled=true`，或 `ensureDefaultScope` 显式 activate。删 context-engine if 硬尾后，default chain 尾不能再依赖代码 if 分支，必须靠 scope 配置选中 `store_sink` |
| D2 | 其他 default impl（transcript_reader / base_builder / system_reminder_injector / threshold_should_compact / summary_do_compact） | 不动 | default scope 行为不变（spec §3.6 契约保留）|

### 5.2 Forked→forked 小写位置（D14 精确清单）

| 文件 | 行 | 改动 |
|---|---|---|
| `app/server/src/agent/forked-scope-bootstrap.ts` | `const FORKED_SCOPE_NAME = 'Forked'` (line 32) | → `'forked'` |
| `app/server/src/agent/forked-scope-bootstrap.ts` | `FORKED_SCOPE_DESCRIPTION` 字符串（line 33-34）| 描述内若有"Forked"大写可一并小写（描述性文字不强求，仅 name 字段必改）|

> 注：`FORKED_SCOPE_ID = 'forked'` 已是小写（router 常量），无需改。其他 spec 文档中的"Forked" 大写形式作为章节标题或概念提及，非配置项，不改。

### 5.3 可选精简：关 4 清理 reducer（建议非强制）

> 现状：forked scope 仍激活 4 个清理 reducer（`orphan_tool_call` / `empty_message` / `role_merge` / `snip_handler`）。它们跑在 `append_passthrough` **之前**，输出被 `append_passthrough` 丢弃（return data.transcript，忽略 input）→ **行为零影响，仅浪费 chain 遍历**。

**建议**：在 `ensureForkedScope` 末尾追加 4 个 `disableImplInForked('context_assemble_reducer', ...)`：
```typescript
disableImplInForked(svc, 'context_assemble_reducer', 'orphan_tool_call');
disableImplInForked(svc, 'context_assemble_reducer', 'empty_message');
disableImplInForked(svc, 'context_assemble_reducer', 'role_merge');
disableImplInForked(svc, 'context_assemble_reducer', 'snip_handler');
```

**优先级**：建议但非阻塞。即使不 disable，`append_passthrough` 的尾 reducer 语义保证 buffer 原样返回，不变量不破。可作为 v0.0.49 收尾的可选项。

---

## 6. 验证检查清单（实现后核对）

- [ ] `buffer_sink.handle(messages, ctx)` 在新骨架 forked run 下确实被调（可加临时 log 验证）
- [ ] `buffer_reader.map(ctx)` 返回 `{ transcript: ctx.buffer }` 被 assemble pipeline 接收
- [ ] `append_passthrough.reduce` 返回 `data.transcript`（buffer 原样）
- [ ] forked run 中 `tryCompact` 谓词 `reject_should_compact.check()` 被调且返 false
- [ ] forked run 结束后 store transcript 数量**未增长**（旁路无污染）
- [ ] main run 中 `transcript_reader` / `base_builder` 行为不变（default scope 配置不动）
- [ ] **default run 中 `store_sink.handle(messages, ctx)` 被调且 `ctx.store.appendMessages` 写入**（v0.0.49 新增 store_sink 生效）
- [ ] **forked run 中 `store_sink` 不被调**（chain 不含；`ensureForkedScope` disable 生效）
- [ ] **`context-engine.ts` 不再含 `if scopeId !== FORKED_SCOPE_ID` 硬尾分支**（grep 验证 D15 已删；sink 完全由 chain 配置决定）
- [ ] **scopeId='forked' 时 `store.appendMessages` 不触发**（chain 尾是 `buffer_sink`；非代码 if 硬尾跳过）

> 上述检查可转为 UT case（白盒断言 impl 被调）+ AT case（真 LLM forked run 后查 store 未污染；default run 后查 store transcript 增长验证 `store_sink` 生效）。
