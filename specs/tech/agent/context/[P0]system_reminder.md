---
type: interface
title: System Reminder
priority: P0
status: active
updated: 2026-08-15
since: v0.0.8
---

# System Reminder

> 系统动态注入的上下文，**链式 + 双模式**（full / incremental，v0.0.361 重构），注入到**最后一条 user/tool message**（v0.0.274 起 tool_result 也注入，assistant/system 不注入）的 content 末尾。**不进 system prompt**（保 prompt cache）；**静态项（env / workspace / 团队盘路径 / 成员名单）已迁 system prompt `session_states` 段**（v0.0.361，见 `[P0]system_prompt.md §4` + `[P1]squad_reminder_providers.md §2 退役注记`），reminder 只承载动态半。todo provider 依赖缺失时 no-op。
> system_prompt 的 timestamp/dynamic_context 已移出走 reminder（见 `[P0]system_prompt.md §4 末`）。
> **[v0.0.223] ReminderCtx 扩展 todoStore**：仿 squadContext 模式（`[P1]squad_reminder_providers.md §1`）加可选 `ctx.todoStore`，由 ingest 构造期按 config.sessionId 注入，供 todo provider 读 session 级 todo 数据。缺省 undefined → todo provider 降级 no-op。

## 1. 定位

system reminder 是**系统**（非 LLM、非用户）在运行时动态注入的上下文提醒。每个 turn 可能变（状态/todo/task 变化），故**不进 system prompt**（会破 cache），而是注入到**最后一条 user/tool message**（v0.0.274 起 user/tool/a2a 触发，assistant/system 不触发）的 content 末尾 —— 只影响该 message，system prompt cache 保留。

**双模式（v0.0.361）**：run 首轮 / summary 重建后首轮 = **full**（跑动态 provider 链全量产出 + 清空 queue）；run 内后续轮 = **incremental**（只发时间固定段 + queue 增量 drain）。静态项不再由 reminder 承载（已迁 system prompt session_states 段）。

典型 reminder：todo（当前 session 双层待办进度）、squad_task（活跃 task 列表）、squad_agents_status（成员状态/presence 动态半）、tool_error（上轮工具错误，现状 no-op）。系统时间 = injector 内部固定段（time provider 已退役，v0.0.361）。

## 2. reminder 链（链式）

多个 reminder provider 各贡献 0-N 个 reminder，[v0.0.18] 按 effective order（per-point 连续 1..n，无 record 时按 manifest 登记序末尾补位）串成链，顺序聚合。

```typescript
interface SystemReminder {
  id: string;                // 唯一标识
  content: string;           // reminder 正文（系统生成）
  tier?: "info" | "warn";    // 提示/警告（影响呈现）
}

interface SystemReminderProvider {
  /** 贡献 0-N 个 reminder（本次 turn） */
  provide(ctx: ReminderCtx): SystemReminder[] | Promise<SystemReminder[]>;
}

interface ReminderCtx {
  config: SessionConfig;
  // provider 按需读：env(config) / time(now) / workspace(cwd/git) / tool_error(上轮 result) / ...
}
```

## 3. ext point:system_reminder

provider 链是一个 ordered ext point：

```typescript
const SystemReminderPoint = {
  id: "system_reminder",
  group: "context",
  cardinality: "ordered",   // [v0.0.18] provider 按 effective order 升序串联
};
```

> **[v0.0.13]** provider 链由 `ContextEngine`（经 ingest 的 `system_reminder_injector` handler）调 `PluginManager.getExtensionImpls(SystemReminderPoint)` 取 active provider 跑（见 `[P0]context_engine.md` §3.5 + `[P0]context_ingest_detail.md` §3）。4 个内置 provider 归 `rocky_context` plugin（见 `[P0]extension point and implementations.md` §3.6）。

内置 provider（**v0.0.361 起瘦身至 4 个动态半**；env/workspace/squad_workspace/time 四个静态项已退役——前三个逻辑平移进 `session_states` mapper（system prompt），time 平移为 injector 内部时间固定段）：

| implId | 默认 order（登记序） | 内容 | 来源 |
|---|---|---|---|
| `tool_error` | 1 | 上一轮工具错误/警告（**现状 no-op**：无数据源，占位保留） | 上轮 tool_result（isError） |
| `todo` | 2 | 当前 session todo 进度（双层待办：主 item + 步骤） | todo store（`ctx.todoStore.listBySession(sessionId)`）；仅 parent.main session 产出；空则 no-op 返 []（`[P1]todo_tools.md §6`） |
| `squad_agents_status` | 3 | 成员**状态行**（running/idle + presence）+ SquadChat 可达行（**动态半**——成员名单已归 system prompt `team_roster` 段，不再重复输出） | `ctx.squadContext`（`listMembers` + `isSessionRunning`）；full 模式数据源 |
| `squad_task` | 4 | 活跃 task 列表（squad 看板） | `ctx.squadContext`（`[P1]squad_reminder_providers.md §4`） |

> **[v0.0.64→v0.0.361] time 退役注记**：time provider 曾按 v0.0.64 口径输出 `"Current date and time: YYYY-MM-DD HH:MM (TZ)"`（含时分 + 进程本地 tz——Electron server 跑用户机器 = client tz，不查 session）。v0.0.361 起 provider 出链，**同等输出平移为 injector 内部时间固定段**（full 与 incremental 每轮都输出，逻辑零变化——`Intl.DateTimeFormat().resolvedOptions().timeZone` + `new Date()` 本地方法）；tz 语义不变。

> 可扩展：插件挂 `system_reminder` ext point 提供自定义 reminder。

## 4. 注入:system_reminder_injector（ingest handler 实例）

reminder 注入由 **ingest handler 链** 的一个 impl `system_reminder_injector` 完成（ext point `context_ingest_handler`，见 `context_ingest_detail.md §3`，[v0.0.18] 默认 order 3，在 truncate 之后）—— 在 **ingest 时**把 reminder 加到 message 并**落库持久化**进 transcript；后续 assemble / LLM **透明**读到（reminder 已是 message 一部分，没人需要知道它是 reminder）。

```
// system_reminder_injector handler（context_ingest_handler impl，v0.0.361 双模式）
handle(messages: Message[], ctx: IngestCtx): Message[] {
  last = messages[messages.length - 1]                                   // 只看最后一条
  if (!last || !shouldTriggerReminder(last)) return messages             // user/tool/a2a 触发
  const full = ctx.runState?.useFullReminder !== false                   // undefined 视 true（run 首轮天然 full）
  let lines: string[] = [timeLine()]                                     // ① 时间固定段（time provider 平移，full/incremental 都出）
  if (full) {
    // ② full：跑瘦身动态 provider 链全量产出（todo / squad_task / squad_agents_status 动态半）
    lines.push(...providers.map(p => p.provide(ctx)).flat().map(format))
    ctx.queueClearAll()                                                  // ③ full 已涵盖最新态，pending 作废（拿锁清空）
    ctx.runState.useFullReminder = false                                 // ④ 置 false（后续轮走增量）
  } else {
    // ② incremental：拿锁 drain queue（按序读 value + 清空）——value 是已渲染注入行，直接拼
    lines.push(...ctx.queueDrain())
  }
  // reminder block 设块级 isSystemReminder=true（前端 DEFAULT_BLOCK_FILTER 精确隐这一块）
  block = { type: "text", text: formatBlock(lines), isSystemReminder: true }
  last.content.push(block)                                              // 追加到 content 末尾（落库持久化）
  return messages
}
```

**注入规则（简单）**：
- 只看 ingest 进来的 **messages 最后一条**；触发条件 = **user message OR tool message OR a2a**（`shouldTriggerReminder(last)` = `role==='user' \|\| role==='tool' \|\| sender?.source==='agent'`），否则不处理。
  - **user**（真用户消息，`role==='user'`）→ 触发注入
  - **tool**（工具结果消息，`role==='tool'`，v0.0.274 新放宽）→ 触发注入——解决工具循环（tool_call → tool_result → ...）期间 reminder 缺失：tool 密集 loop 中后期 LLM 也始终看到最新团队状态/todo/reachable 等上下文
  - **a2a**（`role==='user'` + `sender.source==='agent'`）→ 触发注入（a2a 是独立触发源语义）
  - **assistant**（agent 自己输出）→ **不触发**（agent 输出不是输入）；**system** → **不触发**（天然排除，不匹配任何分支）
- 加 reminder content block 到该 message 的 content 末尾（块级 `isSystemReminder=true`）
- 经 ingest 落库 → **持久化**进 transcript；后续 assemble 透明读（已是 message 一部分）

> **[v0.0.274] 触发放宽依据（老板拍板）**：tool_result 判定 = `msg.role === 'tool'`（loop-stage-context.ts ingestToolResults 构造 `role:'tool'`，MessageRole 4 类 `system/user/assistant/tool`）——与 Anthropic wire 层 tool→user 映射自洽（tool_result 属于 user 侧，user/assistant 交替结构不破坏）。assistant 显式排除（agent 输出不是输入）。**v0.0.361 起历史 reminder 块进 wire 全保留**（不再 drop——bp#2 固定打最末 message 最末 block，见 `../providers_and_models/[P0]cache_control.md §3.2/§3.3`；历史块 append-only 字节稳定是 bp#2 前缀命中的前提）；transcript 本就持久化全部。

**注入形态**：默认**一个 TextBlock**（reminder 聚合），block 设 `isSystemReminder=true`（块级，前端精确过滤）。块级字段定义见 `../message/[P0]agent_message_interface.md §4.1`；前端过滤策略见 `specs/ui/overall/02-llm-chat.md §3`。

> **设计决策 — 块级标记（v0.0.39 引入，v0.0.50 唯一化）**：
> - **结论**：injector 只设块级 `block.isSystemReminder=true`；v0.0.50 起停写消息级 `metadata.isSystemReminder`（块级为唯一权威）。
> - **理由**：消息级 metadata 只能表达「这条 message 含 reminder」，前端要隐 reminder 时要么整条隐（误伤 user 正文）要么不隐（reminder 暴露）。块级标记让前端 DEFAULT_BLOCK_FILTER 精确隐这一块 text，user 正文同 message 不受影响。
> - **v0.0.39 → v0.0.50 演进**：v0.0.39 引入块级时保留消息级双标记（兼容旧路径/工具）；v0.0.50 验证下游已全部按块级读取后停写消息级。`metadata` 字段本身保留（其他 kv 透传），仅 `isSystemReminder` 写路径停。旧 transcript 数据被前端块级 filter 忽略、不迁移。
> - **LLM 零侵入**：`encodeContentBlock(text)` 只读 `b.text`（`app/server/src/llm/protocol-encode.ts`），两套标记都不进 wire —— reminder 仍透明发 LLM，system prompt cache 不破坏（见 §5）。

> **forked-reminder-injector 漂移点证伪**（v0.0.50 doc 阶段澄清）：v0.0.48 新增的 `app/server/src/agent/forked-reminder-injector.ts`（forked 场景 reminder 注入器），v0.0.50 设计阶段曾推测它也写消息级 `metadata.isSystemReminder`、需同步停写。**实际代码证伪**：`injectForkedReminder` 仅写 message 的 `id/sessionId/role/content/sender`，**从不写 metadata**。本版无需改动该文件。

> 与 snapshot 视图的区别：reminder **落库持久化**（不是临时视图）；每 turn 新 ingest 的 user/tool message 才注入新 reminder，历史 message 的 reminder 留在 transcript 里不动。

## 5. 为什么不进 system prompt

reminder 每 turn 变（时间/环境/工具错误），进 system prompt 会**破坏整个 prompt cache**（system 变 → cache 全失效）。注入最后 user/tool message 只影响该 message，system prompt cache 保留（见 system_prompt §4 末/§9）。

> **[v0.0.64] 设计澄清 — 「日期精度保 cache」是误置权衡**：
> v0.0.8 旧版 time provider 标注「日期精度，保 cache」作为约束，限制输出仅 `"Current date: YYYY-MM-DD"`。该标注是**误置**——把「保 system prompt cache」当成了 reminder 节流的理由：
> 1. **reminder 不进 system prompt**（本节核心）——system prompt cache 是否保留与 reminder 内容精度无关；
> 2. **user message 段每 turn 失效**——不管 reminder 是日期精度还是分钟精度，本 turn 的 user message 都是新对象，cache 本来就 miss；
> 3. **wire 层 `cache_control` 三断点**（system 末 bp#1 / tools 末 bp#T / messages 末 bp#2，cache_control.md §3），message 段历史缓存由 bp#2 前缀命中保障（v0.0.361 起历史 reminder 块全保留——append-only 字节稳定）。
>
> 故分钟级时间精度**无额外 cache 损失**，旧版约束是伪命题。新版（v0.0.64 起）time provider 输出 `"Current date and time: YYYY-MM-DD HH:MM (TZ)"`，让 agent 能回答时间相关问题（旧版只剩日期，agent 只能瞎猜）。wire 层 message 段 cache 由 cache_control breakpoint 管（与 reminder 内容精度正交），本 spec 不重复。

> **wire 层 cache_control 三断点是 protocol 层职责**：reminder 注入最后 user/tool message 保住 system prompt cache；message 段历史缓存由 bp#2（messages 末）前缀命中保障——v0.0.361 起历史 reminder 块全保留进 wire（append-only 字节稳定，bp#2 前缀 = 稳定历史 + 本轮新块，每轮命中上一轮缓存条目），见 `../providers_and_models/[P0]cache_control.md §3`。本 spec 只管 reminder **持久化**（context 层），不管 wire 层 breakpoint。

### 5.1 squad_agents_status provider（曾名 reachable_agents，v0.0.273 统一块）

- **核心概念**：`squad_agents_status` 是成员状态行（running/idle + presence）+ SquadChat 可达行的动态提醒，告诉 LLM 团队各成员在干嘛（**v0.0.361 拆半后动态半**——成员名单 name/role/sessionId/intro 归 system prompt `team_roster` 段静态承载，本 provider 不再重复输出名单，只留 name 锚点 + 状态）。
- **设计思路**：状态与 presence 每 turn 可变，放 stable system prompt 会破坏缓存；放 system_reminder 只影响本 turn。[v0.0.273] 三合一取代旧 `reachable_agents`（仅可达列表）+ `squad_team_status`（仅 leader 看 running），squad/leader/mate/subagent 全员可见；v0.0.361 静态半（名单）归 team_roster 后专职动态。
- **代码路径**：`app/plugins/builtins/rocky_context/prompt/squad_agents_status.ts.provide() → app/server/src/agent/context-engine.ts.ingest() → app/server/src/agent/context-ingest-detail.ts.system_reminder_injector()`。
- **接口签名**：`provide(ctx: ReminderCtx): SystemReminder[]` —— squad→leader+全部 mate，leader→SquadChat+全部 mate，mate→SquadChat+leader+peers，subagent→parent；user 永不在列表；全员列出（idle 不消失）+ benched 过滤。
- **版本演进**：`[v0.0.33.2]` 作为 volatile reminder 落地，支撑 Studio 4 scope 对话与 a2a 黑盒测试；`[v0.0.273]` 统一为 squad_agents_status（细节见 `../../squad/[P1]prompt_sections.md §5` + `../../squad/[P1]squad_reminder_providers.md §3`）。

## 6. 边界

| 零件 | 归属 |
|---|---|
| reminder 类型 + provider 链（ext point）+ 内置 provider | 本文（system_reminder）✅ |
| 注入逻辑（`system_reminder_injector` handler） | context_ingest_detail §3（handler 链 impl） |
| 注入形态（content block / `metadata.isSystemReminder`） | agent_message_interface |
| 触发时机（assemble） | context_engine / assemble_detail |

## 7. 版本

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。

> **squad 场景注记**：v0.0.33.2 起新增 `reachable_agents` provider，[v0.0.273] 演进为 `squad_agents_status` 统一块（可达 + 状态三合一，数据源迁 squadContext），[v0.0.361] 拆半（名单归 team_roster，本 provider 留动态半）。本 spec §3 的 4 provider 清单为**通用基线**（tool_error/todo/squad_agents_status/squad_task——静态项已迁 system prompt session_states 段）；squad 场景的 provider 全集权威见 `../../squad/[P1]prompt_sections.md`。
