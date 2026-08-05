---
type: interface
title: System Reminder
priority: P0
status: active
updated: 2026-07-30
since: v0.0.8
---

# System Reminder

> **workspace provider 接线**：provider 实现不变（仍读 `config.workdir`），但 loop 构造 SessionConfig 时 `workdir = session.workspaceDir`（持久化字段，见 `../session/[P0]session_workspace.md`）。零新增 provider、零破 cache、零改注入机制。下一轮 ingest 自动反映新 workspaceDir。
> 系统动态注入的上下文（环境/时间/workspace/tool 运行错误等），**链式**，注入到**最后一条 user message** 的 content 末尾。**不进 system prompt**（保 prompt cache）。todo provider 依赖缺失时 no-op。
> system_prompt 的 timestamp/dynamic_context 已移出走 reminder（见 `[P0]system_prompt.md §4 末`）。
> **[v0.0.223] ReminderCtx 扩展 todoStore**：仿 squadContext 模式（`[P1]squad_reminder_providers.md §1`）加可选 `ctx.todoStore`，由 ingest 构造期按 config.sessionId 注入，供 todo provider 读 session 级 todo 数据。缺省 undefined → todo provider 降级 no-op。

## 1. 定位

system reminder 是**系统**（非 LLM、非用户）在运行时动态注入的上下文提醒。每个 turn 可能变（时间/环境/工具错误），故**不进 system prompt**（会破 cache），而是注入到**最后一条 user message** 的 content 末尾 —— 只影响该 message，system prompt cache 保留。

典型 reminder：env（环境/平台/模型）、time（系统时间）、workspace（工作目录/git 状态）、tool_error（上轮工具错误）、todo（当前 session 双层待办进度）等。

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

> **[v0.0.13]** provider 链由 `ContextEngine`（经 ingest 的 `system_reminder_injector` handler）调 `PluginManager.getExtensionImpls(SystemReminderPoint)` 取 active provider 跑（见 `[P0]context_engine.md` §3.5 + `[P0]context_ingest_detail.md` §3）。5 个内置 provider 归 `rocky_context` plugin（见 `[P0]extension point and implementations.md` §3.6）。

内置 provider：

| implId | 默认 order（登记序） | 内容 | 来源 |
|---|---|---|---|
| `env` | 1 | 环境（test/dev/prod、平台、模型） | config |
| `time` | 2 | 系统时间（**含时分 + 时区名**，每 turn 注入；tz 来源 = **进程本地**（Electron server 跑用户机器 = client tz），不查 session，[v0.0.64] 修正） | now（new Date() 本地方法） |
| `workspace` | 3 | 工作目录、git 状态 | config.workdir（**[v0.0.17] 接线 session.workspaceDir**：loop 构造 SessionConfig 时 `workdir = session.workspaceDir`，见 `../session/[P0]session_workspace.md §1`） |
| `tool_error` | 4 | 上一轮工具错误/警告 | 上轮 tool_result（isError） |
| `todo` | 5 | **[v0.0.223 重定义]** 当前 session todo 进度（双层待办：主 item + 步骤） | todo store（`ctx.todoStore.listBySession(sessionId)`）；仅 parent.main session 产出（subagent/forked 不产出）；空则 no-op 返 []；**[D1.1] 旧版 task 进度 no-op 空壳已在 v0.0.223 填壳为 session todo 进度**（`[P1]todo_tools.md`） |
| `reachable_agents` | 6 | squad/leader/mate/subagent 本轮可达对象 | `[v0.0.33.2]` 从 `SessionConfig.sessionType + studioContext` 动态派生；volatile，不进 system prompt |

> **[v0.0.64] time provider 精度修正**：旧版（v0.0.8-）只输出 `"Current date: YYYY-MM-DD"`（无时分、用 server 进程本地 tz），理由标注「保 system prompt cache」。**该权衡是误置**（§5 详述）：reminder 注入最后一条 user message，**本来就不破 system prompt cache**（system 字段独立）；user message 段每 turn 失效，时间精度日→分钟无额外 cache 损失。新版输出 `"Current date and time: YYYY-MM-DD HH:MM (TZ)"`，让 agent 能正确回答「现在几点」和跨时区时间相关问题（旧版只剩日期，agent 只能瞎猜）。**tz 来源单一为进程本地**（`Intl.DateTimeFormat().resolvedOptions().timeZone`）：Rocky 是 Electron 本地 app，server 进程跑用户机器 → server 进程 tz = client tz，`new Date()` 本地方法拿到的就是用户本地时间，**不需要 session.timezone 链路**（那是 cron schedule 持久化 job.tz 的需求，不是 reminder 当前时间的需求）。

> 可扩展：插件挂 `system_reminder` ext point 提供自定义 reminder。

## 4. 注入:system_reminder_injector（ingest handler 实例）

reminder 注入由 **ingest handler 链** 的一个 impl `system_reminder_injector` 完成（ext point `context_ingest_handler`，见 `context_ingest_detail.md §3`，[v0.0.18] 默认 order 3，在 truncate 之后）—— 在 **ingest 时**把 reminder 加到 message 并**落库持久化**进 transcript；后续 assemble / LLM **透明**读到（reminder 已是 message 一部分，没人需要知道它是 reminder）。

```
// system_reminder_injector handler（context_ingest_handler impl）
handle(messages: Message[], ctx: IngestCtx): Message[] {
  reminders = systemReminderProviders.map(p => p.provide(ctx)).flat()   // 跑 provider 链
  if (!reminders.length) return messages                                // 无 reminder 不动
  last = messages[messages.length - 1]                                   // 只看最后一条
  if (!last || last.role !== "user") return messages                     // 必须是 user message，否则不动
  // reminder block 设块级 isSystemReminder=true（前端 DEFAULT_BLOCK_FILTER 精确隐这一块）
  block = { type: "text", text: formatReminders(reminders), isSystemReminder: true }
  last.content.push(block)                                              // 追加到 content 末尾
  // 注：v0.0.50 起停写消息级 metadata.isSystemReminder（块级 TextBlock.isSystemReminder 唯一权威）
  return messages
}
```

**注入规则（简单）**：
- 只看 ingest 进来的 **messages 最后一条**；且**必须是 user message**（`role === "user"`），否则不处理
- 加 reminder content block 到该 message 的 content 末尾（块级 `isSystemReminder=true`）
- 经 ingest 落库 → **持久化**进 transcript；后续 assemble 透明读（已是 message 一部分）

**注入形态**：默认**一个 TextBlock**（reminder 聚合），block 设 `isSystemReminder=true`（块级，前端精确过滤）。块级字段定义见 `../message/[P0]agent_message_interface.md §4.1`；前端过滤策略见 `specs/ui/overall/02-llm-chat.md §3`。

> **设计决策 — 块级标记（v0.0.39 引入，v0.0.50 唯一化）**：
> - **结论**：injector 只设块级 `block.isSystemReminder=true`；v0.0.50 起停写消息级 `metadata.isSystemReminder`（块级为唯一权威）。
> - **理由**：消息级 metadata 只能表达「这条 message 含 reminder」，前端要隐 reminder 时要么整条隐（误伤 user 正文）要么不隐（reminder 暴露）。块级标记让前端 DEFAULT_BLOCK_FILTER 精确隐这一块 text，user 正文同 message 不受影响。
> - **v0.0.39 → v0.0.50 演进**：v0.0.39 引入块级时保留消息级双标记（兼容旧路径/工具）；v0.0.50 验证下游已全部按块级读取后停写消息级。`metadata` 字段本身保留（其他 kv 透传），仅 `isSystemReminder` 写路径停。旧 transcript 数据被前端块级 filter 忽略、不迁移。
> - **LLM 零侵入**：`encodeContentBlock(text)` 只读 `b.text`（`app/server/src/llm/protocol-encode.ts`），两套标记都不进 wire —— reminder 仍透明发 LLM，system prompt cache 不破坏（见 §5）。

> **forked-reminder-injector 漂移点证伪**（v0.0.50 doc 阶段澄清）：v0.0.48 新增的 `app/server/src/agent/forked-reminder-injector.ts`（forked 场景 reminder 注入器），v0.0.50 设计阶段曾推测它也写消息级 `metadata.isSystemReminder`、需同步停写。**实际代码证伪**：`injectForkedReminder` 仅写 message 的 `id/sessionId/role/content/sender`，**从不写 metadata**。本版无需改动该文件。

> 与 snapshot 视图的区别：reminder **落库持久化**（不是临时视图）；每 turn 新 ingest 的 user message 才注入新 reminder，历史 message 的 reminder 留在 transcript 里不动。

## 5. 为什么不进 system prompt

reminder 每 turn 变（时间/环境/工具错误），进 system prompt 会**破坏整个 prompt cache**（system 变 → cache 全失效）。注入最后 user message 只影响该 message，system prompt cache 保留（见 system_prompt §4 末/§9）。

> **[v0.0.64] 设计澄清 — 「日期精度保 cache」是误置权衡**：
> v0.0.8 旧版 time provider 标注「日期精度，保 cache」作为约束，限制输出仅 `"Current date: YYYY-MM-DD"`。该标注是**误置**——把「保 system prompt cache」当成了 reminder 节流的理由：
> 1. **reminder 不进 system prompt**（本节核心）——system prompt cache 是否保留与 reminder 内容精度无关；
> 2. **user message 段每 turn 失效**——不管 reminder 是日期精度还是分钟精度，本 turn 的 user message 都是新对象，cache 本来就 miss；
> 3. **wire 层 `cache_control` breakpoint 落在最后非 reminder block**（cache_control.md），进一步保证 reminder 不影响 message 段历史 cache breakpoint。
>
> 故分钟级时间精度**无额外 cache 损失**，旧版约束是伪命题。新版（v0.0.64 起）time provider 输出 `"Current date and time: YYYY-MM-DD HH:MM (TZ)"`，让 agent 能回答时间相关问题（旧版只剩日期，agent 只能瞎猜）。wire 层 message 段 cache 由 cache_control breakpoint 管（与 reminder 内容精度正交），本 spec 不重复。

> **wire 层 cache_control breakpoint 是 protocol 层职责**：reminder 注入最后 user message 保住 system prompt cache，但末 user message 的 reminder 每 turn 变仍会影响 message 段 cache——此问题由 protocol encode 层的显式 `cache_control` breakpoint（bp 落在最后非 reminder block）+ wire 层过滤历史 reminder 解决，见 `../providers_and_models/[P0]cache_control.md`。本 spec 只管 reminder **持久化**（context 层），不管 wire 层 breakpoint。

### 5.1 reachable_agents provider `[v0.0.33.2]`

- **核心概念**：`reachable_agents` 是 a2a 可达列表的动态提醒，告诉 LLM 当前能 `send_message` 到谁。
- **设计思路**：hire/bench/spawn 会改变可达对象，放 stable system prompt 会破坏缓存；放 system_reminder 只影响本 turn，且与 workspace/time reminder 同一注入链。
- **代码路径**：`app/plugins/builtins/rocky_context/prompt/reachable_agents.ts.provide() → app/server/src/agent/context-engine.ts.ingest() → app/server/src/agent/context-ingest-detail.ts.system_reminder_injector()`。
- **接口签名**：`provide(ctx: ReminderCtx): SystemReminder[]` —— squad→leader/mates，leader→squad/mates，mate→squad/leader/peers/subagents，subagent→parent；user 永不在列表。
- **版本演进**：`[v0.0.33.2]` 作为 volatile reminder 落地，支撑 Studio 4 scope 对话与 a2a 黑盒测试。

## 6. 边界

| 零件 | 归属 |
|---|---|
| reminder 类型 + provider 链（ext point）+ 内置 provider | 本文（system_reminder）✅ |
| 注入逻辑（`system_reminder_injector` handler） | context_ingest_detail §3（handler 链 impl） |
| 注入形态（content block / `metadata.isSystemReminder`） | agent_message_interface |
| 触发时机（assemble） | context_engine / assemble_detail |

## 7. 版本

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。

> **squad 场景注记**：v0.0.33.2 起新增 `reachable_agents` provider（按 sessionType/studioContext 派生 squad clique 可达对象，作为 volatile system_reminder 注入，不破 system prompt cache）。本 spec §3 的 5 provider 清单为**非 squad 通用基线**；squad 场景的 provider 全集（含 reachable_agents）权威见 `../../squad/[P1]prompt_sections.md`。
