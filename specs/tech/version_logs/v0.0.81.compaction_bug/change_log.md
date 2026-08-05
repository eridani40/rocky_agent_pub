# v0.0.81.compaction_bug — Tech Change Log

> 跨版本发布说明（版本轴）。本目录级变更见各 KB `log.md`（位置轴）。
> 权威输入：`reqs/[working] v0.0.81.compaction_bug/req.md` + `specs/tech/version_logs/v0.0.81.compaction_bug/change_plan.md`。

## 概览

compact 触发阈值、base_builder 放置策略、summary 块结构、UI dedup 四块 bug 修复 + spec 同步。

**关键语义澄清（用户拍板）**：`ContextWindowUsage.maxOutputTokens` = **estimated output 估算输出常量**（默认 20000，非 model maxOutput，不随 model 变）；字段名保留不改（持久化 record + SSE schema 兼容）；仅 assemble budget 消费，**不进 compact 阈值 / 不进 UI 占用展示**。

## §1 compact 触发阈值改纯使用比例

**before**：`(totalTokens + maxOutputTokens) / tokenLimit > compactRatio`（分母含 estimated output，导致刚到 60% 实际已逼近撞墙）。

**after**：`totalTokens / tokenLimit > compactRatio`（默认 0.6，纯使用比例）。

**理由**：estimated output 是为 assemble budget 留的 LLM 调用保护量，不是已用量；新口径 = 用户视角的真实占用，与 UI 占用展示同口径，简洁可预期。

**代码**：`app/plugins/builtins/rocky_context/compact/threshold_should_compact.ts:49-55`。

**spec**：`specs/tech/agent/context/[P0]context_compact_detail.md §1/§2c.2/§2c.5`。

## §2 base_builder 放置预算 + summary 1-block 3-段重构

### 2.1 assemble budget

`budget_tokens = 0.95 × tokenLimit − estimatedOutput`（保护调 LLM 时 input + output 合计不过载）。

**放置算法**：summary block 始终放置（自身超 budget 丢 tail 保 preamble + head）；recent 从新→旧累加至剩余预算，超额丢最旧。

**代码**：`app/plugins/builtins/rocky_context/assemble/base_builder.ts:buildRebuild()` + 拆出的 `base_builder_helpers.ts:pickRecentWithinBudget()` + `getEstimatedOutput()`。

**常量源**：`app/server/src/agent/session-usage-helper.ts:DEFAULT_MAX_OUTPUT_TOKENS=20000`（导出供 base_builder_helpers 复用）。

**spec**：`specs/tech/agent/context/[P0]context_assemble_detail.md §6.5`（新增章节）。

### 2.2 summary block 1-block 3-段

**before**：summary msg 每消息 1 个 text content block（summary 正文 + head 每条 1 block + tail 每条 1 block）。

**after**：summary msg 1 个 text content block，文本 3 段：
- preamble（引导 LLM + summary.content）
- head 段（`[msgid|role] content` 每条 1 行）
- tail 段（同格式）；超 budget 时 tail 段替换为降级说明

`role=user`（不是 system——recap 是 user 提供的上下文，Claude Code 口径）；`id=summary:{version}`；head∩tail 按 head 算去重（Set）。

**代码**：`base_builder_helpers.ts:buildSummaryBlock() + serializeMessageLine()`。

**spec**：`specs/tech/agent/context/[P0]context_assemble_detail.md §6`（重写）。

## §3 compact_notice 整删（compact 真正零 transcript 副作用）

compact 是**纯生产者**：只产 summary + accumulateUsage('forked') write，**不再 appendMessages 任何 notice**。

**删除足迹**（grep 0 残留）：
- `app/plugins/builtins/rocky_context/compact/summary_do_compact.ts` noticeEmitter 参数删
- `app/plugins/builtins/rocky_context/types.ts` noticeEmitter 字段删
- `app/server/src/agent/context-compact-runner.ts` appendMessages 调用删
- `app/server/src/agent/build-deps.js / build-forked-deps.js / context-engine.js / loop-ports.d.ts` compactNoticeEmitter 装配删
- `app/web/src/components/chat-page/message-flatten.ts` system role 居中 pill 分支删
- `app/web/src/store/chat-slice-reducer.ts` compact_notice 来源分支删

**spec**：`specs/tech/agent/context/[P0]context_compact_detail.md §6.5` 整删（替换为退役说明段）+ §6.4 caller 契约副作用行改述；`specs/ui/components/chat-page/_overview.md §2.5b` + `component-usage-panel.md §6` 整删。

## §4 UI dedup（by-id merge 防御）

`use-session-run-state.setMessages`（transcript fetch / loadMore prepend）调 `merge-messages-by-id.ts:mergeMessagesById(prev, incoming, prepend)` 按 id 合并：
- 同 id 取 prev（保 SSE 累积的 tool_call rawArgs / pendingError，不覆盖）
- prepend=true（loadMore）：incoming + prev 独有 id 补回
- prepend=false（transcript fetch）：不补 prev 独有 id（transcript 是权威最新 list）

SSE reducer（`chat-slice-reducer`）已按 id dedup，本 helper 只管 transcript/loadMore 路径。

**修复 bug**：transcript fetch 整体替换重置已渲染同 id 消息 → tool_call 增量被覆盖丢失。

**代码**：`app/web/src/components/chat-page/use-session-run-state.ts:setMessages()` + 拆出 `merge-messages-by-id.ts`。

**spec**：`specs/tech/app/frontend/[P0]component_architecture.md §3.4`（加 by-id merge 段）。

## §5 UI usage 面板去 estimatedOutput 展示

进度条 4 分段 → 3 分段（删 reserve/输出预留段）；圆环 used/total/free 改用户视角：
- `used = ctx.totalTokens`（input 侧已用，不含 estimated output）
- `total = ctx.tokenLimit`
- `free = max(0, total − used)`（不再读 maxOutputTokens / remainingTokens）

**代码**：`app/web/src/components/chat-page/component-usage-panel.tsx` parts 删 reserve；free 改 `total - used`。

**spec**：`specs/ui/components/chat-page/component-usage-panel.md §2/§4/§5/§6/§7`（同步更新）。

## §6 estimated output 语义统一澄清

`ContextWindowUsage.maxOutputTokens`：
- = estimated output 估算输出常量（默认 20000，`DevConfig.context.maxOutputTokens` 可覆盖）
- 常量源 `app/server/src/agent/session-usage-helper.ts:DEFAULT_MAX_OUTPUT_TOKENS=20000`
- **非 model maxOutput，不随 model 变**
- 字段名保留不改（持久化 record + SSE schema 兼容）

**消费边界（MANDATORY）**：
- ✅ 进 assemble budget（base_builder 放置预算 = 0.95×tokenLimit − maxOutputTokens）
- ❌ 不进 compact 阈值（threshold 改纯使用比例）
- ❌ 不进 UI 占用展示（用户视角 = 已用/window）

**spec**：`specs/tech/agent/context/[P0]context_snapshot_interface.md §2`（字段注释加详细说明）+ `[P0]context_usage_detail.md §3`（estimated output 段）+ `[P0]context_compact_detail.md §1`（maxOutputTokens 语义段）。

## §7 文档同步（MANDATORY — 本次 doc-modifier 全量同步）

**Tech OKF KB（context 子系统）**：
- `index.md`：④ 原则 12 补「不再 appendMessages compact_notice」+ 新增原则 13（compact 阈值纯比例 + assemble budget + summary 1-block 3-段，三层独立但同源 estimated output 常量）+ 新增原则 14（UI by-id merge）；① 概念表 compact 行加 v0.0.81 阈值变更；顶部 callout 加 v0.0.81 摘要。
- `log.md`：追加 2026-07-06 · v0.0.81.compaction_bug 块（详）。
- `[P0]context_compact_detail.md`：§1 阈值公式 + estimatedOutput/maxOutputTokens 语义段；§2c.2 默认 impl 公式；§2c.5 历史算式演进注；§6.4 caller 副作用行；§6.5 整删。
- `[P0]context_assemble_detail.md`：§6 重写（1-block 3-段）；新增 §6.5 assemble budget 放置。
- `[P0]context_usage_detail.md §3`：estimated output 语义段（消费边界三句）。
- `[P0]context_snapshot_interface.md §2`：maxOutputTokens 字段注释加详细说明。
- frontmatter `updated`→2026-07-06（除 context_engine / ingest / system_* 等未涉及文件外）。

**UI 组件 spec**：
- `specs/ui/components/chat-page/component-usage-panel.md`：顶部加 v0.0.81 callout；§0 设计意图（4 分段→3 分段）；§2.2 字段映射（maxOutputTokens UI 不展示）；§2.3 派生计算（free=limit−total）；§4.6 进度条段（4→3 段）；§4.9 配色 token（删输出预留灰）；§5 testid 表（删 ctx-seg-reserve / ctx-leg-reserve）；§6 compact_notice 整删；§7 加 v1.1 版本行。
- `specs/ui/components/chat-page/_overview.md §2.5b`：compact_notice 整删（保留退役说明）。

**Frontend 架构**：
- `specs/tech/app/frontend/[P0]component_architecture.md §3.4`：setMessages 加 by-id merge 段（v0.0.81）。

## §8 不变量（MANDATORY）

- compact threshold = 已用/window（不含 estimatedOutput）
- assemble budget = 0.95×window − estimatedOutput（保护 LLM 调用不过载）
- summary = 1 个 user content block（preamble + head + tail，3 段），不进 compact_notice
- estimatedOutput = 常量 20000（DevConfig 可覆盖，不随 model 变），仅 assemble budget 用，不进 threshold/UI
- UI dedup：所有消息路径（SSE + transcript fetch + loadMore）按 id 合并
- 字段名 `maxOutputTokens` 保留不改（持久化 + SSE 兼容）
