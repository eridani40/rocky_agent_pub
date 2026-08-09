# v0.0.274 变更计划书 — system_reminder 注入策略放宽（tool_result 也注入）+ 密度分级预案

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> **背景**：BUG-reminder-only-on-user-message-not-tool —— reminder 只在 user/a2a 消息注入，tool 循环（tool_call → tool_result → ...）期间不刷新；叠加 encode 层「非最末 drop reminder」→ 工具循环中后期 LLM 上下文里一个 reminder 都没有（团队状态/todo/reachable 全消失）。老板拍板：**user + tool_result + a2a 都注入，assistant 不注入**（assistant 是 agent 输出不是输入，显式排除）。Anthropic encode 侧零改动（bp#2 跳过 reminder block 已天然配合）。其他 protocol 预案记录不实现。测试全 UT（不新增 AT/ET 持久 case）。

## 架构裁决（req 关键裁决点落实）

| # | 裁决点 | 结论 | 理由 |
|---|--------|------|------|
| R1 | **shouldTriggerReminder 精确判定** | `role==='user' \|\| role==='tool' \|\| sender?.source==='agent'`。tool_result 判定 = `msg.role === 'tool'`（ingestToolResults 构造 `role: 'tool'`，MessageRole 4 类 `system/user/assistant/tool` 已确认）；a2a = `role==='user'` + `sender.source==='agent'`（既有分支保留）；assistant/system 天然排除（不匹配任何分支） | 库内 tool 消息 role 恒为 `'tool'`（loop-stage-context.ts L179），与 Anthropic wire 层 tool→user 映射自洽；a2a 消息 role='user' + sender.source='agent'（send-message-tool.ts L119），`role==='user'` 已命中，保留 sender 分支显式承载「a2a 是独立触发源」语义 |
| R2 | **截断/dedup 是否需要** | **不需要 ingest 层 dedup/截断**。wire 层 encodeMessage（cache_control.md §3.3）已保证「非最末 message drop 全部 reminder + 最末 message 只保留最末一个 reminder」→ **LLM 上下文不堆积**；transcript 存储膨胀（每条 tool_result 多一个聚合 reminder block，几十-几百字符 × 工具调用数）可接受 | `prompt/dedup.ts` 是 **system_prompt_reducer**（管 prompt fragments 同 id 去重），**不适用于** ingest 的 reminder block（不同层，勿误用）；加 ingest 层 dedup（reminder 内容变化才注入）复杂度 > 收益——wire 层已收敛，LLM 每轮只见最末一个聚合块 |
| R3 | **是否所有 provider 在 tool 轮次重跑** | **全部 9 个 provider 重跑（不筛子集）**。runReminderProviders 每次 applyIngestPipeline 全跑 provider 链（env/time/workspace/tool_error/todo/reachable_agents/squad_workspace/squad_team_status/squad_task），机制上无「按触发类型分 provider 子集」 | 加 provider 级触发条件（只 team-status/todo 重跑）需新机制，复杂度 > 收益；wire 层已保证 LLM 每轮只见 1 个聚合块（全部 provider 聚合），token 成本 = 1 块/turn 不随 provider 数线性增；tool_error provider 在工具出错轮次重跑恰是其意义场景 |
| R4 | **Anthropic encode 零改动复核** | **复核确认零改动 ✅**。`encodeMessage`（§3.3）最末 message（role 不限）保留最末 reminder、非最末 drop 全部；`injectLastNonReminderCacheControl`（bp#2 §3.2）从末尾向前扫**跳过 reminder block**、命中第一个非 reminder block 注入 cache_control → tool 消息带 reminder 时：最末 tool_result 保留 reminder 发给 LLM + bp#2 落在 tool_result 内容块（非 reminder）→ **reminder 永远在 cache 边界外，不破坏 prompt caching** | spec cache_control.md §3.2 已写明「bp#2 落点通常是 user 正文 / tool_result / assistant 回复」——tool_result 是预设落点；§3.3 修正动机（2026-07-22）已把口径从「最末 user message」改为「最末 message」role 不限。**本版本零代码改动，仅加 UT 固化配合** |
| R5 | **其他 protocol 预案** | **只记录方向不实现**。不支持 cache_control 的 protocol（openai_chat_completions 等未来 impl）：tool 上加 reminder 会导致前缀失配、缓存全废 → 预案 = protocol 能力标志 `supportsCacheControl` + 不支持时清理 run 内非首个 reminder（或每 10 个留第一个）保持密度平衡 | req 明确定「纯设计预案，本版本不实现」；目前无其他 protocol impl（cache_control.md §7 未来 protocol 行已记录）；实现时在 protocol 层按能力标志分派（不污染 context 层） |

## 变更清单

<!-- 每行一个函数/符号；相关方法的行放在一起（同模块/同文件相邻） -->

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| rocky_context-ingest | app/plugins/builtins/rocky_context/ingest/system_reminder_injector.ts | shouldTriggerReminder() | 修改 | 判定放宽：`role==='user' \|\| role==='tool' \|\| sender?.source==='agent'`。tool_result 消息（role='tool'）触发注入（v0.0.274 新放宽——解决工具循环 reminder 缺失）；user/a2a 触发保留；assistant/system 显式排除（不匹配任何分支） | MUST 加 `msg.role === 'tool'` 分支；MUST 保留 `role==='user'` + `sender.source==='agent'`（a2a）分支；MUST NOT 触发 assistant/system（agent 输出不是输入）；MUST 更新函数头注释（触发条件 user/tool/a2a，assistant/system 不触发） | req §1；cache_control.md §3.3（最末 message 保留 reminder）；system_reminder.md §4 | +2/-0 |
| rocky_context-ingest | app/plugins/builtins/rocky_context/ingest/system_reminder_injector.ts | handle() | 修改 | 仅注释更新：L47「末尾非 user message → 不动」→「末尾 user/tool message 触发注入；assistant/system 不触发」；L58-61 触发扩展注释同步放宽语义 | MUST 零行为改动（判定逻辑全在 shouldTriggerReminder）；MUST NOT 改注入块构造（isSystemReminder 块级标记保持） | req §1；本 change_plan R1 | +0 |
| test | app/plugins/builtins/rocky_context/__tests__/ingest-handlers.test.ts | system_reminder_injector describe 用例 | 修改 | ① 新增「末尾 tool message（role='tool'，tool_result block）→ 触发 reminder 追加」；② 既有「末尾非 user message → 不动」用例改为明确「末尾 assistant message → 不动」（语义不变，改名防误解）；③ 新增「末尾 system message → 不动」；④ a2a 触发用例保持 | MUST 用 mkToolMsg（既有 helper，role='tool' + tool_result block）构造 tool 消息；MUST 断言 tool 消息 content 末尾追加 reminder block（isSystemReminder=true）；MUST assistant/system 断言 content 长度不变 | req 验收「shouldTriggerReminder 3 类判定」；本 change_plan R1 | +25/-3 |
| test | app/plugins/builtins/llm_anthropic/__tests__/protocol-encode-cache.test.ts | encode + bp#2 配合用例 | 新增 | ① 最末 tool 消息带 reminder block → encodeMessage 保留该 reminder + injectLastNonReminderCacheControl 落在**非 reminder block**（tool_result 内容块），reminder block 无 cache_control；② 多 tool 轮次各带 reminder（模拟长 run）→ wire 层只剩**最末消息的最末一个 reminder**，历史 reminder 全 drop；③ reminder 位置不变时 bp#2 落点稳定（cache 前缀稳定段不变） | MUST 直接构造 canonical Message（含 isSystemReminder=true 的 text block）走 encodeAnthropicMessages，零 mock；MUST 断言 cache_control 计数（reminder block 恒无 cache_control）；MUST 断言 wire 输出 reminder block 数 = 1（最末） | req 验收「encode 配合不破坏缓存 + 长 run reminder 密度」；cache_control.md §3.2/§3.3 | +40 |
| spec-sync(T3) | specs/tech/agent/context/[P0]system_reminder.md | §4 注入规则（触发条件） | 修改 | 触发条件从「必须 user message（role==='user'）」放宽为「user message OR tool message（role==='tool'，v0.0.274 新放宽）OR a2a（sender.source='agent'）」；assistant/system 显式排除；§4.2 伪代码 `if (!last || last.role !== "user")` 同步放宽 | MUST 与 change_plan R1 一致；MUST 注明 assistant 是 agent 输出不是输入故排除；MUST 验证代码实现 == spec 契约（injector 实际行为） | 本 change_plan R1；req §1 | +10/-5 |
| spec-sync(T3) | specs/tech/agent/providers_and_models/[P0]cache_control.md | §3.3 过滤历史 reminder（tool 场景补注） | 修改 | 补充「tool 消息也注入 reminder 后」的最末保留语义说明：最末 tool_result 消息带 reminder → 保留发给 LLM（工具循环中 LLM 始终看到最新 reminder）；非最末 tool 消息的 reminder wire 层 drop（transcript 仍持久化）；bp#2 落点仍为非 reminder block（tool_result 内容块） | MUST 与实现一致（本版 encode 零改动，仅文档补注 tool 场景）；MUST NOT 改 §3.2 bp#2 规则（已是正确口径） | 本 change_plan R4；req §2 | +8/-0 |

## 影响面评估

- **跨模块**：rocky_context 插件 ingest（injector）+ llm_anthropic 插件（零改动，仅测试）+ spec 文档（system_reminder.md + cache_control.md）
- **破坏性变更**：无。wire 层契约零变化（encode 零改动）；transcript 数据形态变化（tool 消息多 reminder block，块级 isSystemReminder 标记兼容前端过滤）
- **依赖顺序**：T1（ingest 放宽 + 判定 UT）∥ T2（encode 配合验证 UT，fixture 直接构造不依赖 T1）可并行；T3（spec 同步）依赖 T1+T2
- **风险点**：
  1. **transcript 存储膨胀**：每条 tool_result 消息多一个聚合 reminder block（几十-几百字符）× 工具调用数。可接受：wire 层 drop（LLM token 零增）、压缩/清理机制处理历史、块级标记前端可精确过滤
  2. **assistant 消息误注入**：显式排除（role!=='user' && role!=='tool' && sender 非 agent）——UT 固化防回归
  3. **其他 protocol 未来接入**：不支持 cache_control 时 reminder 全进 wire → 前缀失配缓存全废；预案已记录（supportsCacheControl 能力标志 + 密度分级清理），本版不实现
  4. **dedup reducer 误用**：prompt/dedup.ts 是 system_prompt_reducer（管 prompt fragments），不适用于 ingest reminder block——T1 不碰 dedup.ts（MUST NOT）

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
