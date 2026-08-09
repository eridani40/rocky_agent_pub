# v0.0.274 tech change log — System Reminder 注入放宽（user/tool/a2a）

> 对应需求：`reqs/[working] v0.0.274/req.md`（BUG-reminder-only-on-user-message-not-tool）。
> 权威契约：`specs/tech/version_logs/v0.0.274/change_plan.md`（5 裁决，frozen）。
> 老板讨论记录：`specs/tech/version_logs/v0.0.274/reminder-cache-design-discussion.md`（密度分级设计，spec 已吸收）。

## 变更摘要

### 需求与动机

System reminder 只在 user/a2a 消息注入，工具循环（tool_call → tool_result → ...）期间不刷新；叠加 encode 层「非最末 drop reminder」→ 工具循环中后期 LLM 上下文里一个 reminder 都没有（BUG-reminder-only-on-user-message-not-tool）。老板拍板：**user + tool_result + a2a 都注入，assistant 不注入**（assistant 是 agent 输出不是输入，显式排除）。

### 方案（5 架构裁决 R1-R5，详见 change_plan「架构裁决」）

1. **R1 — shouldTriggerReminder 三分支**：`role==='user' || role==='tool' || sender?.source==='agent'`。tool_result 判定 = `msg.role === 'tool'`（ingestToolResults 构造 `role:'tool'`，loop-stage-context.ts L179）；a2a = `role==='user'` + `sender.source==='agent'`；assistant/system 天然排除。Anthropic wire 层 tool→user 映射自洽（tool_result 属于 user 侧，user/assistant 交替结构不破坏）。
2. **R2 — 不需要 ingest 层 dedup/截断**：wire 层 encodeMessage 已保证非最末 drop + 最末只留一个 reminder；prompt/dedup.ts 是 system_prompt_reducer（管 prompt fragments 同 id 去重），不适用于 ingest reminder block。
3. **R3 — 全部 9 个 provider 重跑（不筛子集）**：runReminderProviders 每次 applyIngestPipeline 全跑 provider 链（env/time/workspace/tool_error/todo/reachable_agents/squad_workspace/squad_team_status/squad_task），无按类型分 provider 子集机制。
4. **R4 — Anthropic encode 零改动复核确认**：encodeMessage 最末 message（role 不限）保留最末 reminder + injectLastNonReminderCacheControl bp#2 跳过 reminder block 落在非 reminder block——tool 上加 reminder 不破坏 prompt caching。
5. **R5 — 其他 protocol 密度分级预案（只记录方向不实现）**：supportsCacheControl 能力分组——支持（Anthropic）→ tool/user 注入不破缓存（bp#2 保护前缀稳定，reminder 在 cache 段外）；不支持（未来 openai_chat_completions 等，隐式 prefix matching）→ 预案 A（清理 run 内非首个 reminder）/ 预案 B（每 10 留 1 保持密度）。内容已吸收进 `cache_control.md §4.1`（老板 10:39 指令：spec 必须包含讨论内容，对未来加 protocol 有支撑）。

### T1 — ingest 放宽（commit b93bf8e3b）

- **`system_reminder_injector.ts`**：shouldTriggerReminder 判定放宽为 `role==='user' || role==='tool' || sender?.source==='agent'`（tool 分支新增 + a2a 保留 + assistant/system 天然排除）；handle 仅注释更新（L47/L58-61 触发语义同步放宽，零行为改动——判定逻辑全在 shouldTriggerReminder）；注入块构造不变（isSystemReminder 块级标记保持）。
- **`ingest-handlers.test.ts`**：+2/-3——新增「末尾 tool message（role='tool'，tool_result block）→ 触发 reminder 追加」（mkToolMsg 构造，断言 content 末尾追加 isSystemReminder=true block）；新增「末尾 system message → 不动」；既有「末尾非 user message → 不动」改为明确「末尾 assistant message → 不动」（语义不变，改名防误解）；a2a 触发用例保持。UT 21 全绿 + build:plugins 65 bundles 编译通过。

### T2 — encode UT 固化（commit 5226ce45f）

- **`protocol-encode-cache.test.ts`** +3 用例（9/9 绿）：①最末 tool 消息带 reminder block → wire 保留该 reminder + bp#2 落**非 reminder block**（tool_result 内容块），reminder block 无 cache_control；②多 tool 轮次各带 reminder（模拟长 run）→ wire 只剩最末消息的最末一个 reminder，历史 reminder 全 drop；③reminder 位置不变时 bp#2 落点稳定（cache 前缀稳定段不变）。直接构造 canonical Message（isSystemReminder=true text block）走真实 encodeAnthropicMessages，零 mock、**零生产改动**（protocol-encode-helpers.ts / protocol-encode.ts git diff 空）。

### T3 — spec 同步（commit 本任务）

- **`[P0]system_reminder.md` §4**：触发条件从「必须 user message」改为「user/tool/a2a 触发，assistant/system 不触发」；伪代码 `if (!last || !shouldTriggerReminder(last))` 对齐实际实现；说明 tool 分支（解决工具循环 reminder 缺失）+ Anthropic wire tool→user 映射自洽；§5 及文档头部「最后一条 user message」引用同步放宽为 user/tool message。
- **`[P0]cache_control.md` §3.3 + §4.1**：§3.3 补 tool 场景（最末 tool_result 携带 reminder 保留发给 LLM；非最末 tool 消息 reminder 同样 wire 层 drop）；§4.1 新增「reminder 密度分级」——supportsCacheControl 能力分组（Anthropic 支持 → tool/user 注入不破缓存；不支持 protocol → 预案 A 清理 run 内非首个 reminder / 预案 B 每 10 留 1 保持密度），只记录方向不实现。
- **`change_log.md`**（本文）。

## 核实表（T3 代码↔spec，MANDATORY）

| # | 核实项 | 结果 |
|---|---|---|
| 1 | shouldTriggerReminder 实际实现 == spec 描述（user/tool/a2a 三分支） | ✅ system_reminder_injector.ts L107-112：`if (msg.role === 'user' \|\| msg.role === 'tool') return true;` + `return sender?.source === 'agent'`——与 change_plan R1 + system_reminder.md §4 伪代码一致；assistant/system 天然排除（不匹配任何分支） |
| 2 | encode bp#2 跳过 reminder + 最末保留最末 reminder（protocol-encode-helpers.ts 零改动确认） | ✅ git diff HEAD 0 行（T1→HEAD llm_anthropic 仅测试文件 +108）；现有实现核实：encodeMessage 非最末 message 全 drop reminder、最末 message 保留最末一个；injectLastNonReminderCacheControl 从末尾向前扫 `flags[bi]===true` 跳过 reminder block、命中第一个非 reminder block 注入 cache_control |
| 3 | cache_control §4 密度分级补充与讨论文档一致 | ✅ 与 reminder-cache-design-discussion.md §五 逐条对齐：supportsCacheControl 能力分组（Anthropic 支持 → tool/user 注入不破缓存）；不支持 cache_control 的 protocol 预案（方案 A 清理 run 内非首个 reminder / 方案 B 每 10 留 1 保持密度）；只记录方向不实现（§4.1 明示） |

## 偏离记录

**无偏离**。T1/T2/T3 均与 change_plan 契约一致，coversFiles 完整交付；无 coversFiles 外产品代码改动（app/ 零改动，仅测试文件 +108 属 T2 契约内新增用例）。