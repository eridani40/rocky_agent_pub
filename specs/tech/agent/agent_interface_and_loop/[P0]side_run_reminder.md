---
type: spec
title: Side-Run Reminder（cache 前缀之后注入，零污染）
priority: P0
status: active
updated: 2026-07-25
since: v0.0.48
---

# Side-Run Reminder（cache 前缀之后注入 · 不复用 system_reminder_injector）

> 定位：给旁路 run（compact `summary` / consolidate `memory_extract` 内存 run）补 system reminder，让 LLM 知道「自己是 side run、tools 来自 main、实际可运行 tool 列表 = profile.toolBound」。
> 参考：`specs/research/v0.0.48-tool-system.md §10.6`（三态语义 + compaction 事实）+ `specs/prd/version_logs/v0.0.48/change_log.md §3.2`（行为契约）；`[P0]agent_loop_side_run.md §4/§8`（side-run buffer 拼装 + system 注入）；`[P0]agent_scope_router.md §4`（summary/consolidate scope 配置：禁用 `system_reminder_injector`）。
> 关联：`../tools/[P0]tool_policy.md §3`（resolveTools 三态 option 消费 `enableToolWhitelist`/`toolWhitelist`）+ `../tools/[P0]tool_execution_engine.md §3.1`（白名单外统一 `tool_not_allowed` 拒绝）。

> **命名沿革**：v0.0.48–v0.0.203 称 `Forked Reminder`（`forked-reminder-injector.ts` / `injectForkedReminder` / `ForkedReminderInput` / `ForkedReminderHandler` / `content/forked_reminder/`）。v0.0.204 forked 概念整体退役 + 文件/符号 rename（`side-run-reminder-injector.ts` / `injectSideRunReminder` / `SideRunReminderInput` / `SideRunReminderHandler` / `content/side_run_reminder/`）；skeleton.md 文案 `[Forked Agent Context]`→`[Side Run Context]`、"forked agent"→"side run"。本文描述当前态（runKind=summary/consolidate 旁路 run 的 reminder 注入契约），历史命名按映射理解。

---

## 1. 为什么不复用 `system_reminder_injector`

`session-type-scopes/*.yaml` 中 summary / consolidate scope 显式禁用 `system_reminder_injector`——理由：旁路 run buffer 前缀（system + snapshot.messages + userMessage）整个 run 不变，注入 reminder 会**污染 cache 前缀**（prompt cache miss）。

不动该禁用——`system_reminder_injector` 是 **context_ingest_handler** EP 的 impl，作用是把 reminder 写进 ingest 链产出的 snapshot/buffer（旁路 run 场景必污染 cache 前缀）。

**当前设计**：旁路 run 专属 reminder 注入器，注入位置在 **cache 前缀之后**（snapshot 之后、userMessage 之前/之后追加，作为独立 message block），不进 system 前缀、不进 snapshot——cache 前缀完全不变。

---

## 2. 注入点（cache 前缀之后的具体位置）

旁路 run buffer 拼装（`[P0]agent_loop_side_run.md §4` + `agent-side-run.ts`）：

```
buffer = [ snapshot.system, ...snapshot.messages, userMessage, ...loop_appended ]
         ├── cache 前缀（整个 loop 不变）─────────────┤
                              ├── cache 之后 ──┤
```

reminder 注入点：**snapshot 之后、userMessage 之前**，作为独立 user-role message：

```
buffer = [
  snapshot.system,                                    // cache 前缀
  ...snapshot.messages,                               // cache 前缀
  ─────────────── cache 前缀结束 ───────────────
  sideRunReminderMessage,                             // ★ 旁路 run 专属（user role，cache 之后）
  userMessage,                                        // 任务说明（compact prompt / spawn task）
  ...loop_appended,                                   // assistant + tool（loop 多轮追加）
]
```

### 2.1 注入接口

`injectSideRunReminder(opts): Message | null`（落 `app/server/src/agent/side-run-reminder-injector.ts`）：

```typescript
interface SideRunReminderInput {
  /** caller intent（resolveTools 算 allowedTools 用同一对；reminder 文案读 toolWhitelist 描述） */
  enableToolWhitelist: boolean;
  toolWhitelist: string[];
  /** runKind（"summary" / "consolidate"）——文案可按 mode 微调（compaction 强调「输出 summary」） */
  runKind: "summary" | "consolidate";
}

function injectSideRunReminder(input: SideRunReminderInput): Message | null {
  // 仅旁路 run 调；main/subagent 调用方不注入
  return {
    id: ulid(),
    role: 'user',                          // ★ user-role（不抢 system 前缀；side-run 专属）
    content: [{ type: 'text', text: buildReminderText(input) }],
    sender: { source: 'system' },          // 标记 system 注入（不进 a2a 拓扑）
  };
}
```

### 2.2 调用点

`buildRunDeps`（`build-run-deps.ts`，v0.0.204 单装配合并）装配旁路 RunSpec 时：

```typescript
// buildRunDeps 内（profile 驱动）：
const reminder = profile.runKind !== "main" && profile.enableToolWhitelist
  ? injectSideRunReminder({ enableToolWhitelist: true, toolWhitelist: profile.toolBound, runKind: profile.runKind })
  : null;

// wireInitState 构造 buffer 时插入（在 userMessage 之前）：
const initialBuffer = [
  snapshot.system,
  ...snapshot.messages,
  ...(reminder ? [reminder] : []),   // ★ cache 之后、user 之前
  userMessage,
];
```

> **cache 不污染保证**：reminder 是 cache 前缀**之后**的 buffer 元素；snapshot.system + snapshot.messages 完全不变 → prompt cache 前缀 hash 不变 → cache 命中。reminder 在多轮 loop 中保持在 buffer（loop 不删），无副作用。

---

## 3. 文案模板

> **正文文件化**：以下模板正文（§3.1-§3.3）不再是 `side-run-reminder-injector.ts` 内的字符串字面量，已迁移至 `app/server/src/prompts/content/side_run_reminder/*.md`（5 个文件：`skeleton.md` + `tools_none.md`/`tools_all.md` + `mode_tail_summary.md`/`mode_tail_consolidate.md`），经 `SideRunReminderHandler` 读取拼接。措辞逐字一致（下方模板仍是权威文案来源，只是介质从代码字面量改为文件）；**三态/runKind「选哪个」的业务判断逻辑仍留在 `buildReminderText()` 调用方**，handler 只按 key 取文件+拼接。通用机制见 `../context/[P0]prompt_content_files.md §4.2`。

### 3.1 通用骨架

```
[Side Run Context]
You are running as a side run (runKind={runKind}) — a short-lived in-memory run that reuses the main agent's prompt and tools for cache efficiency.

Key facts:
- Your system prompt and tool definitions come from the MAIN agent (shared for cache), NOT chosen for this task.
- The tools you can ACTUALLY EXECUTE = {actualToolsDescription}.
- Focus on completing THIS message's task; do not call tools outside the executable list.
- Output your result as final text answer (no send_message back to parent).
```

### 3.2 三态文案分叉（actualToolsDescription）

按 PRD §3.2 / research §10.6 三态语义填充 `actualToolsDescription`：

| 三态 | enableToolWhitelist | toolWhitelist | actualToolsDescription |
|---|---|---|---|
| 零工具（compaction） | `true` | `[]` | `[] (no tools allowed — output summary text directly)` |
| 限定白名单 | `true` | `[read, web_search, ...]` | `[read, web_search, ...]`（join toolWhitelist） |
| 不强制（bound 内全可执行） | `false` | — | `bound of this run's role (resolveTools output)`（一般 side run 不走此态；fallback 用「all tools in your tool definitions」） |

### 3.3 runKind 微调

- `runKind="summary"`：在骨架后追加一行 `This is a compaction run: produce a concise summary of the conversation so far as your final answer. Do NOT call any tools.`
- `runKind="consolidate"`：追加 `This is a memory extraction run: use the allowed tools to extract and persist long-term memory, then output a brief status as final answer.`

### 3.4 文案 i18n

英文为主（对齐 system prompt 主语言）；旁路 run 复用 main system prompt 语言——若 main prompt 是中文，可注入对应中文版（英文版常量 + main prompt 语言检测，按需切中文；非阻断 TBD）。

---

## 4. RunSpec / RunOptions 字段（§6 in tool_policy.md 关联）

`RunSpec`（`loop-ports.ts`）含 2 个 caller-intent 字段（main/subagent 不传，side run 必传）：

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `enableToolWhitelist` | `boolean` | `false` | caller intent：是否强制白名单（side run=true；main/subagent=false，由 resolveTools 走 role 算 allowedTools） |
| `toolWhitelist` | `string[]` | `[]` | caller intent：白名单列表（仅 enableToolWhitelist=true 时读） |

**与 `RunSpec.allowedTools` 的关系**（共存而非替代）：
- `allowedTools` 是 resolveTools **产出**（exec 层 engine.execute 消费，行为不变）
- `enableToolWhitelist + toolWhitelist` 是 caller **输入**到 resolveTools（main/subagent 不传；side run 传，由 resolveTools 算出 allowedTools）

**与 `manager.sideRun` opts 的关系**：v0.0.204 起 `manager.sideRun(opts)` 不直传 allowedTools（由 buildRunDeps 读 profile.toolBound 派生 + 写 RunSpec.allowedTools），caller 只传 `{ sessionId, runKind, userMessage, snapshot, emit }`。

---

## 5. 三态语义对照（research §10.6）

| 场景 | enableToolWhitelist | toolWhitelist | resolveTools 产出 allowedTools | reminder actualToolsDescription |
|---|---|---|---|---|
| compaction side run | `true` | `[]` | `[]`（零工具） | `[] (no tools allowed)` |
| consolidate side run | `true` | `[skill_manage, memory_manage]` | `toolWhitelist ∩ allTools` | 列出 toolWhitelist |
| subagent（共用机制） | `true` | `<mainAllowedTools ∩ bound ∩ parentBound>` | 同 toolWhitelist | 不注入 reminder（subagent 有自己的 template prompt，非 side run） |
| 顶层角色（不传这对 option） | `false`（默认） | `[]` | role.bound | 不注入 reminder（非 side run） |

> subagent 不走 reminder（subagent 用 template systemPrompt 作身份正文，非 side run）；side run 与 subagent 仅在「实际可执行工具」resolveTools 链上共用 enableToolWhitelist+toolWhitelist 这对 option（formal 化统一），reminder 是 side run 专属。

---

## 6. 不变量（实现 + UT 必须断言）

1. **cache 前缀不变**：side-run buffer `[snapshot.system, ...snapshot.messages]` 整个 run 不变；reminder 插入位置严格在 snapshot 之后、userMessage 之前——prompt cache 命中保证不退化。
2. **reminder 只在旁路 run 注入**：main/subagent run（runKind="main"）不调 `injectSideRunReminder`；reminder 是 side run 专属，不污染主对话。
3. **reminder 实际 toolWhitelist 来自 RunSpec/profile**：reminder 与 resolveTools 必须读同一对 `enableToolWhitelist+toolWhitelist`（避免 reminder 写 [read,write]、实际 allowedTools=[] 的对齐缝）。
4. **compaction 强制零工具**：runKind="summary" 时 `enableToolWhitelist=true, toolWhitelist=[]` 是硬约束（caller 必传；resolveTools 算出 allowedTools=[] → engine.execute 全 toolCall 拒绝，产 `tool_not_allowed` result 喂回 LLM 自修正）。

---

## 7. 文件清单

| 文件 | 角色 |
|---|---|
| `app/server/src/agent/side-run-reminder-injector.ts` | `injectSideRunReminder(input)` 纯函数 + `buildReminderText(input)`（§3 文案模板）；单文件 ≤150 行 |
| `app/server/src/agent/loop-ports.ts` | `RunSpec` 含 `enableToolWhitelist: boolean` + `toolWhitelist: string[]`（默认 false/[]，§4） |
| `app/server/src/agent/agent-manager.ts` | `sideRun(opts)` 入口（runKind=summary/consolidate 装配旁路 RunSpec） |
| `app/server/src/agent/build-run-deps.ts` | `buildRunDeps` 装配旁路 spec 时调 `injectSideRunReminder` + 写 RunSpec.enableToolWhitelist/toolWhitelist + RunSpec.allowedTools（resolveTools 算） |
| `app/server/src/prompts/handlers/side-run-reminder-handler.ts` | `SideRunReminderHandler`（按 key 取 content md 段 + 拼接，§3） |
| `app/server/src/prompts/content/side_run_reminder/{skeleton,tools_none,tools_all,mode_tail_summary,mode_tail_consolidate}.md` | 5 段 content 正文 |

---

## 8. 边界 + 衔接

| 零件 | 归属 |
|---|---|
| side-run reminder 注入点 + 文案模板 + 三态对照 + RunSpec 新字段 + 不变量 | 本文 ✅ |
| resolveTools 签名（消费 enableToolWhitelist/toolWhitelist 算 allowedTools） | `../tools/[P0]tool_policy.md §3` |
| 统一拒绝错误（side run 零工具时 LLM 调 tool → `tool_not_allowed`） | `../tools/[P0]tool_execution_engine.md §3.1` |
| side-run buffer 拼装（cache 前缀 + 多轮 append） | `[P0]agent_loop_side_run.md §4/§8` |
| summary/consolidate scope 配置（system_reminder_injector 禁用保持） | `[P0]agent_scope_router.md §4` + `session-type-scopes/*.yaml` |
| RunSpec 字段（loop-ports.ts） | `[P0]agent_interface.md §2` |

---

> 变更历史见 `log.md`（本 KB 位置轴）+ `specs/tech/version_logs/vX.Y/change_log.md`（跨版本发布说明）。
