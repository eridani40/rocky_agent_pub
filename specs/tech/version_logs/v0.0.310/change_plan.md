# v0.0.310 变更计划书 — send_message 信封化（全 agent 通信统一信封）

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 背景与目标

agent 调用 `send_message` 向其他 agent 发消息时，当前 UI 与 read/write/bash 混在一起渲染为 `tool-call-item`（可折叠参数卡）。本版把 send_message 从工具调用序列摘出，提升为独立信封消息（`component-a2a-envelope` direction="out"），与已有 a2a inbox 信封（direction="in"）形成 in/out 对称。

**用户裁决（覆盖 PRD §7 约束 1）**：
1. **全局拦截**（非仅 Studio）：flatten 层全局拦截 send_message，Playground + Studio 统一变信封。
2. **pending/running 合并**：无 result 时统一显示「发送中...」（用户视角无区别）。

## 源码核查结论（架构师已 grep 验证）

### 1. target 字段结构

`send-message-tool.ts` L36 `inputSchema.properties.target` description: `AgentRef {type,sessionId,name} | sessionId string | "parent" alias`。

LLM 实际传入 `tool_call.arguments.target` 有三种形态：
- **AgentRef 对象** `{type,sessionId,name}`（最常见，工具描述引导）
- **sessionId 字符串**（ULID）
- **别名字符串** `"parent"` / `"squadchat"` / `"leader"` / member name

**targetName 解析策略**（纯前端、flatten/渲染层）：
```
arguments.target:
  → object? .name 非空? → 用 .name
                    → .sessionId（兜底）
  → string? → 原样显示（可能是 sessionId、别名、或 name）
```
不反查 member store（flatten 是纯函数，无异步查数据能力）。LLM 传 AgentRef 时 99% 带 name；字符串场景用原始值兜底已够用。

### 2. isA2aInbox 已覆盖 subagent — 无需放宽

`inbox-enrich.ts` `enrichForInbox()` 对所有 `sender.source === 'agent'` 消息**反查发送方 session record 补全 ref**（sessionId→type/name）。subagent 消息经 enrich 后 `ref = {type:'subagent', sessionId, name:templateType||'subagent'}`。

`subagent-reply-fallback.ts` L118 构造的 fallback 消息也带完整 `ref: {type:'subagent', sessionId:childSid, name:''}` → 经 enrich 补全 name。

**结论**：`isA2aInbox(msg) = sender.source === 'agent' && !!sender.agent?.ref` **已覆盖所有 agent 来源**（leader/mate/squad/subagent/rocky）。ref 在 enrich 后永远非空。**不需放宽判定条件。**

### 3. 群聊中 send_message out 信封不渲染

群聊白名单 `groupMessageFilter = isUser || isA2aInbox` 只放行 human user + a2a inbox。assistant 自产的 tool_call（含 send_message）被白名单滤掉（mute）。因此 out 信封仅在 **member 单聊**（全 transcript）和 **Playground**（全 transcript）中渲染。这是正确行为——群聊看的是 agent 间收到的消息，不看某 member 的内部工具执行。

### 4. status 判定在渲染层（非 flatten 层）

`flattenMessages()` 是纯函数，不接受 `runActive`（它是 `ComponentMessageStream` 的 prop）。用户裁决 pending/running 合并为单一「sending」态后，status 只需 `result`：
- `result === undefined` → `sending`
- `result.isError === true` → `error`
- 否则 → `done`

判定逻辑放在渲染层（`build-render-rows.ts` 构建 row 时计算，或 `component-message-stream.tsx` 装配时计算），同 `component-tool-call-item.tsx` 的 `statusOf()` 模式。

### 5. batch 断裂安全

`groupToolBatches()` 只合并连续 `tool-call-item`。新 kind `send-message-envelope` 不是 `tool-call-item`，天然在序列中断开 batch。前后的 tool-call-item 各自独立成 batch——正确行为（信封是独立消息，不该和工具调用混）。

### 6. Playground 兼容

`ComponentMessageStream` 是 playground/studio 共享内核。全局拦截后 Playground 的 send_message 也会产 `send-message-envelope` → 渲染层新增分支统一走 `ComponentA2aEnvelope direction="out"`。Playground 不传 `resolveActor`（默认头像）、不传 `messageFilter`（全展示），out 信封归 assistant 侧左列渲染——自然兼容。

## 架构决策

| # | 决策 | 内容 |
|---|---|---|
| **D1** | 全局拦截 | flatten 层全局判定 `b.name === 'send_message'`，产出 `send-message-envelope` kind（不产 `tool-call-item`）。Playground + Studio 统一。 |
| **D2** | pending/running 合并 | status 三态：`sending | done | error`。`result === undefined` → sending；`result.isError` → error；否则 done。判定在 render 层（`buildRenderRows` 算 status 写入 row）。 |
| **D3** | targetName 纯前端解析 | `arguments.target` → object 取 `.name` 兜底 `.sessionId`；string 原样用。不反查 store（flatten 纯函数约束）。 |
| **D4** | isA2aInbox 不改 | 已确认所有 agent 来源（含 subagent）经 enrichForInbox 后 ref 必非空。in 信封覆盖面已全，不需放宽。 |
| **D5** | direction 默认 'in' | `A2aEnvelopeProps.direction` 默认 `'in'`，现有 a2a inbox 装配不传 direction = 行为 100% 不变（零回归）。 |
| **D6** | batch 天然断裂 | `send-message-envelope` 非 `tool-call-item`，`groupToolBatches` 自动跳过。不需额外改 batch 逻辑。 |

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名 |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么 |
| 约束 | MUST / MUST NOT |
| 参考 | spec 位置 |
| 影响行 | +N / -M |

## 变更清单

### A 组：类型扩展 — ViewElement 新增 send-message-envelope kind

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| chat-page types | app/web/src/components/chat-page/types/message.ts | ViewElement | 修改 | 判别联合新增第 4 成员 `{kind:'send-message-envelope'; key; messageId; toolCallId; arguments: Record<string,unknown>; result?: {content: ToolResultContentBlock[]; isError: boolean}}`。字段结构与 tool-call-item 的 result 绑定同形（复用 buildToolResultMap 绑定）。 | MUST key 格式 `${m.id}:sm:${b.id}`（sm 前缀区分）；MUST result 类型与 tool-call-item.result 同构（复用绑定逻辑）；不含 `name` 字段（固定 send_message，不需存） | types/message.ts L103-123 ViewElement 现状 | +8 |

### B 组：flatten 拦截 — send_message 产出新 kind

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| message-flatten | app/web/src/components/chat-page/message-flatten.ts | flattenMessages() | 修改 | assistant 消息的 `b.type === 'tool_call'` 分支内新增判定：`b.name === 'send_message'` → 产出 `{kind:'send-message-envelope', ...}`（复用 resultMap.get(b.id) 绑定 result）；否则 → 产出 `{kind:'tool-call-item', ...}`（现有逻辑不变） | MUST 全局拦截（不区分视图/不传参）；MUST result 绑定复用 resultMap.get(b.id)（同 tool-call-item）；MUST NOT 产 tool-call-item（send_message 不再进 tool-batch）；MUST key 用 `${m.id}:sm:${b.id}` | message-flatten.ts L121-131 现有 tool_call 产出分支 | +12/-0 |

### C 组：render rows — 新增 send-message-envelope row 类型

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| build-render-rows | app/web/src/components/chat-page/build-render-rows.ts | RenderRow | 修改 | 判别联合新增 `{type:'send-message-envelope'; key; messageId; toolCallId; arguments; result?; status: 'sending'\|'done'\|'error'; targetName: string}` | MUST 含 status（render 层从 result 派生）；MUST 含 targetName（从 arguments.target 解析）；不进 tool-batch（同 user-text/agent-answer 独立成行） | build-render-rows.ts L15-18 RenderRow 现状 | +6 |
| build-render-rows | app/web/src/components/chat-page/build-render-rows.ts | buildRenderRows() | 修改 | while 循环新增分支：`el.kind === 'send-message-envelope'` → 构建 row（算 status + 解析 targetName）；不进 batch 合并 | MUST status 派生逻辑：`!result → 'sending'; result.isError → 'error'; else → 'done'`（同 tool-call-item statusOf 模式）；MUST targetName 解析：target 为 object 取 .name 兜底 .sessionId；为 string 原样用 | build-render-rows.ts L45-76 现有 while 循环；component-tool-call-item.tsx L22-25 statusOf 模式 | +20 |

### D 组：组件扩展 — ComponentA2aEnvelope 支持双向

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| a2a-envelope | app/web/src/components/chat-page/component-a2a-envelope.tsx | A2aEnvelopeProps | 修改 | 新增 3 可选 prop：`direction?: 'in'\|'out'`（默认 'in'）；`status?: 'sending'\|'done'\|'error'`；`errorContent?: ReactNode` | MUST direction 默认 'in'（零回归）；MUST status/errorContent 仅 out 方向使用 | PRD §3.3 Props 扩展 | +4 |
| a2a-envelope | app/web/src/components/chat-page/component-a2a-envelope.tsx | ComponentA2aEnvelope() | 修改 | ① 收起态 header 按方向渲方向箭头：in=`↙ from {name}`，out=`↗ to {name}`；② out+sending → 不可展开 + 右侧 muted「发送中...」；③ out+error → danger 色「发送失败」pill + 可展开显示 errorContent（danger 色）；④ out+done → 完整收起/展开（同 in 逻辑）；⑤ in 方向（默认）行为 100% 不变 | MUST in 方向代码路径零改动（direction 默认 'in'，不传 = 现有行为）；MUST out+sending 时 `expanded` 不可 toggle（无正文，点击无效）；MUST 方向箭头用字符 `↗`/`↙`（U+2197/U+2199 mono）；MUST error pill 用 `bg-[var(--danger-bg)] text-[var(--danger)]`（同 tool-call-item error pill 风格） | component-a2a-envelope.tsx L67-89 现有实现；PRD §3.3 渲染逻辑表；component-tool-call-item.tsx L27-31 STATUS_STYLE | +35/-5 |

### E 组：渲染层装配 — message-stream 新增分支

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| message-stream | app/web/src/components/chat-page/component-message-stream.tsx | rows.map() 渲染分支 | 修改 | assistant 侧渲染区新增 `row.type === 'send-message-envelope'` 分支 → 渲染 `<ComponentA2aEnvelope direction="out" senderName={row.targetName} status={row.status} errorContent={...}>`。done 态 children = result.content text block 拼接。归 assistant 侧左列（与 in 信封同列）。 | MUST 归 assistant 侧（side=assistant 左列，已有外层布局自动处理）；MUST done 态正文从 row.result.content 的 text block 拼接渲染（同 tool-call-item result content 取值）；MUST sending 态不传 children（不可展开） | component-message-stream.tsx L230-264 assistant 侧渲染分支 | +15 |

## 文件级变更清单

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| app/web/src/components/chat-page/types/message.ts | 修改 | ViewElement 判别联合新增 `send-message-envelope` 成员 |
| app/web/src/components/chat-page/message-flatten.ts | 修改 | flattenMessages() tool_call 分支判定 send_message 产新 kind |
| app/web/src/components/chat-page/build-render-rows.ts | 修改 | RenderRow 新增 send-message-envelope 类型 + buildRenderRows() 新分支 |
| app/web/src/components/chat-page/component-a2a-envelope.tsx | 修改 | Props 加 direction/status/errorContent + 渲染逻辑分支 |
| app/web/src/components/chat-page/component-message-stream.tsx | 修改 | assistant 侧渲染新增 send-message-envelope 分支 |

## 不做的事（明确排除）

1. **不改 isA2aInbox**：已确认覆盖所有 agent 来源（enrich 保证 ref 非空），in 信封覆盖面已全。
2. **不反查 member store 解析 targetName**：flatten 是纯函数，无异步查数据能力。target 是 AgentRef 时取 .name，字符串原样用。
3. **不改 groupToolBatches**：send-message-envelope 非 tool-call-item，天然被 batch 跳过。
4. **不引入 runActive 到 flatten**：用户裁决 pending/running 合并，status 只靠 result 派生。
5. **不新增 SVG icon**：方向箭头用字符 ↗/↙（mono 字体）。
6. **不改群聊白名单**：群聊中 send_message out 信封不渲染（assistant tool_call 被 groupMessageFilter mute），是正确行为。
