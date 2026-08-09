---
type: research
title: v0.0.270 群聊开关（group-chat-switch）调研
priority: P1
status: active
updated: 2026-08-06
author: researcher
---

# v0.0.270 群聊开关 — 注入点 / UI 入口 / 开关落点调研

## 0. 需求语义（老板拍板）

- **squad 一定有群聊**（SquadChat session 实体恒存在，不删不建）
- 开关 `enableGroupChat`：**开** = agents 注入里可见（reachable_agents / 协作规则）+ 用户入口可见（队长卡按钮 / chat 渲染策略）；**关** = agents 注入里没有 SquadChat、UI 入口隐藏
- 本质是**可见性开关**（注入层 + UI 层），不是功能开关（session/路由机制不删）

## 1. Agents 注入点清单（server 侧）

### 注入点 A：reachable_agents（system_reminder provider）★ 核心

| 项 | 值 |
|---|---|
| 文件 | `app/plugins/builtins/rocky_context/prompt/reachable_agents.ts` |
| 机制 | 每 turn 派生 reachable_agents reminder（volatile，保 system prompt cache） |
| SquadChat 出现位置 | `reachable_agents.ts:103-124` `deriveSquadScoped()`：`squadChatRef`（`{type:'squad', sessionId: squadChatSessionId, name:'SquadChat'}`）push 进 **leader**（行 121）与 **mate**（行 124）的列表 |
| 数据源 | `ctx.config.studioContext.squad.squadChatSessionId`（bootstrap 注入；`studioContext` 组装见 `app/server/src/agent/context-types.ts:280-291`） |
| 派生表（a2a §3） | squad→[leader,mates]；leader→[squadchat,mates]；mate→[squadchat,leader,peers]；subagent→[parent]；standalone→[] |
| **开关落点** | `deriveSquadScoped()` 里 `squadChatRef` 仅当 `squad.enableGroupChat !== false` 时构造（leader/mate 列表自动收缩） |

### 注入点 B：squad_role（system_prompt_mapper，固定规范）

| 项 | 值 |
|---|---|
| 文件 | `app/plugins/builtins/rocky_context/prompt/squad_role.ts` |
| 机制 | 按 sessionType 加载 content fragment：leader→`leader.md`、mate→`mate.md`、squad→`squad_chat.md`（`squad_role.ts:40-72`） |
| SquadChat 出现位置 | **leader.md / mate.md 协作规则段**：「在团队群聊（SquadChat）@leader 问 / 群里 @mate 下达」（mate 侧「问 leader 走群聊不走神秘直连」）——**内容文件** `app/plugins/builtins/rocky_context/prompts/content/squad/{leader,mate}.md` |
| squad_chat.md | SquadChat 路由器人设（永不创作 + 3 段转发模板 + `{{squad_name}}` fillTemplate，`squad_role.ts:47-54`） |
| **开关落点** | 开关关时：leader/mate 的协作规则段**建议仍保留**（它们描述「存在群聊」的协作约定；若群聊关闭，此段应改写为「无群聊，用直接 send_message 给 leader/mate」或整段移除——需产品裁决）。squad_chat.md 本身不影响（SquadChat session 不跑） |

### 注入点 C：team_roster（system_prompt_mapper）

| 项 | 值 |
|---|---|
| 文件 | `app/plugins/builtins/rocky_context/prompt/team_roster.ts` |
| 机制 | Team Roster 段（leader/mate/squad 注入），只含成员（`team_roster.ts:118-131` renderRoster），**不含 SquadChat** |
| 开关落点 | 无直接影响（roster 是成员花名册，与群聊开关正交） |

### send_message 路由（开关关闭后行为）

| 项 | 值 |
|---|---|
| 文件 | `app/server/src/agent/tools/send-message-tool.ts` + `app/server/src/agent/tools/runtime-context.ts` |
| 'squadchat' 别名解析 | `runtime-context.ts:293-301` `resolveSquadAlias()` 优先级 3：`'squadchat'` → `squad.squadChatSessionId` |
| squad clique 校验 | `send-message-tool.ts:145-189` `checkSquadClique()`：同 squad 内 squad/leader/mate 互相可达；跨 squad 拒绝 |
| **开关落点** | 开关关时 `resolveSquadAlias()` 里 `'squadchat'` 分支返回 null（解析失败）→ `send_message` 返 `cannot resolve target`——**对齐 isAttachEnabled not_enabled 模式**（见 §3），比静默投递好（防「消息发了没人看」） |

### SquadChat 转发机制本身（无独立 router）

- SquadChat = `type='squad'` session 跑**正常 agent-loop** → LLM 读 user 消息 → 调 `send_message(target=leader/mate)` 路由 → 输出 `<EOS>` 结束
- EOS 装配：`app/server/src/agent/build-run-deps.ts:170-172`（`isSquad = kind.role === 'squad'` → `stopSequences=[EOS_STOP_TOKEN]` + `eosStripper`）；EOS helper：`app/server/src/agent/agent-loop-stage-llm.ts:19-39`
- needReply 机制：`send-message-tool.ts:284-289`（默认 true；显式 false 保留）——转发时按 `### 说明` 段语义由 SquadChat LLM 判断
- **开关对转发机制零影响**（session 实体 + agent-loop + send_message 链路不动，只动「谁可见/可达」）

## 2. 用户入口清单（web 侧）

### 展示点 A：队长卡（SeatCard）操作行「群聊」按钮 ★ 老板点名

| 项 | 值 |
|---|---|
| 文件 | `app/web/src/components/studio-page/component-seat-card.tsx:143-162` |
| 形态 | 操作行中档按钮：`data-action-key="studio.squad.open-group-chat"`，Icon `squad` + `seats.team.groupChatTitle`；灰色 outline（不抢「进入对话」主按钮） |
| 传入方 | `component-seats-body.tsx:73-79`：`onOpenGroupChat={() => onOpenGroupChat(buildGroupChatNode())}` + 右键复制 squadChat sessionId |
| 打开行为 | `buildGroupChatNode()`（`use-seats-data.ts`）→ `onOpenGroupChat(node)` → 进 studio chat 落地页（squadChatSessionId session） |
| **开关落点** | SeatCard 的 `onOpenGroupChat` 缺省不渲染（组件已支持 `onOpenGroupChat?: () => void`，`component-seat-card.tsx:33-34,143`）——SeatsBody 在开关关时不传该 prop 即可隐藏 |

### 展示点 B：studio chat 落地页（群聊渲染策略）

| 项 | 值 |
|---|---|
| 文件 | `app/web/src/components/chat-page/chat-actor-strategy.tsx`（`capabilities.groupRender=true` → 群聊策略：白名单 filter + a2a actor + 前缀行）；`message-flatten.ts:11`（messageFilter：`isUser(m) || isA2aInbox(m)`）；`component-message-stream.tsx:231`（a2a 角色名前缀行） |
| 开关落点 | 开关关时用户无法从队长卡进入群聊 → 此页不会被打开（群聊 session 仍存在但无入口）；若会话列表/历史直链仍能进，需二次拦截或保持可读（产品裁决） |

### 展示点 C：其他

- **sidebar**：`section-studio-sidebar.tsx` 只 squad 行（选中进 seats，v0.0.168 删展开树）——**不含群聊节点**，无需改
- **seats 状态**：`use-seats-data.ts:100`（`sids = [squadChatSessionId, ...members]` 统计 inProgressCount）——数据层，不展示，无需改

## 3. 开关落点建议

### 3.1 squad schema 新增字段

文件：`app/server/src/agent/schema_defs/squad/squad.ts`（现无群聊开关字段）

```typescript
/** 群聊可见性开关（v0.0.270）：true=agents 注入可见 + UI 入口可见；false=两者隐藏。
 *  squad 实体恒存在（squadChatSessionId 不删）；仅控制注入层 + UI 层可见性。 */
enableGroupChat: { type: 'boolean', required: false },
```

**required:false + 读取时 `?? true` 兜底**（仿 `heartbeatConfig` 容忍旧 record 模式，`squad.ts:66-74`）——避免存量 squad 无此字段时 migration 复杂化；语义「缺省 = 开」。

### 3.2 既有开关先例（两种模式都现成）

**模式 1：squad 字段布尔开关（enableHeartBeat）——开关落点主参考**
- schema：`squad.ts:59`（`enableHeartBeat: { type: 'boolean', required: true }`）
- service 建队默认：`squad-service.ts:213`（`enableHeartBeat: false`）
- handler PATCH：`handlers/squad.ts:402`（`if (body.enableHeartBeat !== undefined) patch.enableHeartBeat = body.enableHeartBeat`）
- UI toggle：`component-squad-autonomy-toggle.tsx:23-44`（开/关 + `onPatch({ enableHeartBeat: !enableHeartBeat })` → PATCH /squad → 父级 refresh 回灌）
- runtime 消费：`squad-runtime.ts` + `heartbeat-handler` gate0 每 tick 动态判

**模式 2：工具级动态门控（isAttachEnabled）——send_message 拒绝行为参考**
- `attach-mode-impl.ts:29`：`if (env.isAttachEnabled && !env.isAttachEnabled()) return { ok:false, error:{ kind:'not_enabled', message:'...' } }`
- 注入：`bootstrap-connectors-phase.ts:133`（`isAttachEnabled: () => connectorManager.getState?.('browser')?.switch === 'on'`）
- 语义：开关关 = 工具调用明确报错，不静默

### 3.3 管理 UI 落点

- 现有 squad 管理面板 = **autowork-tab**（`component-autowork-tab.tsx:27` 挂 SquadAutonomyToggle）——群聊开关 toggle 放同一区域（SquadAutonomyToggle 模式复制：`data-action-key` + PATCH /squad + 父级 refresh）
- PATCH /squad 已有字段扩展通道（`handlers/squad.ts:402` 模式）

## 4. 存量 squad 迁移建议

| 项 | 建议 |
|---|---|
| 存量 squad | **默认开**（`required:false` + 读取 `?? true`；无 migration 脚本）——避免存量群聊消失的破坏性变更 |
| 新建 squad | 默认开（建队 service 显式写 `enableGroupChat: true`，对齐 `squad-service.ts:213` 模式） |
| schema migration | 不需要硬 migration（required:false）；如未来改 required:true 再走 data_model migration |

## 5. 风险点

1. **注入与 UI 双读同一数据源**：reachable_agents（server）+ SeatCard 按钮（web）都要读 `squad.enableGroupChat`——读同一字段（SquadDetail 已有 squadChatSessionId 透传通道），避免「一侧隐藏、另一侧仍可路由/仍显示」的撕裂。
2. **send_message 行为决策**：开关关后 leader/mate 发 `'squadchat'` —— 建议 `resolveSquadAlias` 返 null（解析失败报错，对齐 isAttachEnabled not_enabled），**不静默投递**（防「消息发了没人看」+ 防 SquadChat 跑一轮空路由浪费 LLM）。
3. **SquadChat session 实体**：开关关 ≠ 删 session（老板语义）。**不能**动 `squadChatSessionId` / dissolve；只动注入层 + UI 层。
4. **协作规则文案**：leader.md / mate.md 协作规则段提「群聊（SquadChat）@leader 问」——开关关时此段语义失效。产品裁决：整段移除 / 改写为直接 send_message 对端寻址 / 保留（因为团队仍可能重开）。建议**开关关时 mapper 对该段做条件渲染**（或先接受文案过期，后续版本改）。
5. **reminder 注入判断**：reachable_agents provider 读 `squad.enableGroupChat`——`squadChatRef` 仅开关开时构造。注意 `studioContext.squad` 是 bootstrap 注入的投影，开关 PATCH 后需刷新（现有 refresh 机制覆盖）。
6. **UI 状态刷新**：开关切换后 seats 页群聊按钮即时隐藏——SquadAutonomyToggle 模式已解决（PATCH 成功 → 父级 refresh → 回灌）。
7. **SSE/实时性**：开关 PATCH 后 running 的 agent 当轮 reminder 可能仍含旧 reachable（volatile reminder 每 turn 现取，下一轮即收敛——低风险）。

## 6. 实现要点清单（供 change_plan 参考）

| # | 层 | 改动点 |
|---|---|---|
| 1 | schema | `squad.ts` 加 `enableGroupChat: boolean`（required:false） |
| 2 | service | 建队写默认 true（`squad-service.ts`） |
| 3 | handler | PATCH /squad 支持 `enableGroupChat`（`handlers/squad.ts:402` 模式） |
| 4 | 注入 | `reachable_agents.ts` `deriveSquadScoped` 按开关构造 squadChatRef |
| 5 | 路由 | `runtime-context.ts` `resolveSquadAlias` 'squadchat' 分支按开关返 null |
| 6 | UI | `component-seats-body.tsx` 开关关不传 `onOpenGroupChat`（SeatCard 已支持缺省隐藏） |
| 7 | UI | 管理面板 autowork-tab 加 toggle（SquadAutonomyToggle 模式复制） |
| 8 | 待裁决 | leader.md/mate.md 协作规则段开关关时文案处理 |

## 7. 关键文件索引

| 文件 | 作用 |
|---|---|
| `app/plugins/builtins/rocky_context/prompt/reachable_agents.ts` | ★ 注入点 A（squadChatRef 构造，行 103-124） |
| `app/plugins/builtins/rocky_context/prompt/squad_role.ts` | 注入点 B（sessionType→content fragment） |
| `app/plugins/builtins/rocky_context/prompt/team_roster.ts` | 注入点 C（Team Roster，不含 SquadChat） |
| `app/plugins/builtins/rocky_context/prompts/content/squad/{leader,mate,squad_chat}.md` | 协作规则文案（含「群聊（SquadChat）」引用） |
| `app/server/src/agent/tools/send-message-tool.ts` | send_message 投递 + squad clique 校验（行 145-189） |
| `app/server/src/agent/tools/runtime-context.ts` | 'squadchat' 别名解析（行 293-314） |
| `app/server/src/agent/build-run-deps.ts` | SquadChat EOS 装配（行 170-172） |
| `app/server/src/agent/schema_defs/squad/squad.ts` | ★ squad schema（加 enableGroupChat 处） |
| `app/server/src/services/squad-service.ts` | 建队默认值（行 213 模式） |
| `app/server/src/handlers/squad.ts` | PATCH 字段扩展（行 402 模式） |
| `app/web/src/components/studio-page/component-seat-card.tsx` | ★ 队长卡群聊按钮（行 143-162，缺省隐藏已支持） |
| `app/web/src/components/studio-page/component-seats-body.tsx` | 群聊按钮传入（行 73-79） |
| `app/web/src/components/studio-page/component-squad-autonomy-toggle.tsx` | ★ 管理开关先例（enableHeartBeat toggle 模式） |
| `app/web/src/components/chat-page/chat-actor-strategy.tsx` | 群聊渲染策略（groupRender） |
| `app/server/src/tools/browser/attach-mode-impl.ts` | isAttachEnabled 门控先例（行 29） |
