# v0.0.270 PRD — 群聊开关（enableGroupChat）

> 版本目录：`specs/prd/version_logs/v0.0.270.group_chat_switch/`
> 需求来源：`reqs/[working] v0.0.270/req.md`（含老板 2026-08-06 补充注入点）
> 调研报告：`specs/research/group-chat-switch.md`（researcher 已摸清注入点/UI 点/先例/风险）
> PRD 边界：产品可感知行为（squad 群聊的可见性开关）；实现细节归架构 change_plan

## 1. 背景

### 1.1 现状问题

团队沟通纪律 = **优先私聊**（老板 2026-08-06 拍板）——但现状 agent 会误发群聊（SquadChat），造成噪音。群聊是 squad 的固有实体（SquadChat session 恒存在），但**可见性不可控**：agents 注入里恒有 SquadChat 可达条目、UI 入口恒显示，无法按团队沟通偏好关闭。

### 1.2 目标

把群聊做成 squad 级**可见性开关** `enableGroupChat`：

- **开（默认 true）**：agents 注入里看得到 SquadChat（system prompt + system_reminder 两头）+ 用户 UI 入口看得到（队长卡「群聊」按钮）
- **关（false）**：agents 注入里没有 SquadChat（reachable_agents 不构造 squadChatRef）+ UI 入口隐藏（队长卡按钮不传 prop）+ send_message 发 squadchat 报错（not_resolved，对齐 isAttachEnabled 模式，不静默投递）+ 协作规则文案随开关切换（防 agents 尝试发群聊报错）

### 1.3 范围

**squad 实体恒存在**：开关只控「注入层 + UI 层」可见性，**不删 squadChatSessionId、不动 squad 解散逻辑、不动群聊 session/路由机制**。schema 加字段 + server 注入判定 + send_message 路由判定 + UI 入口隐藏 + 管理面板 toggle + 协作规则文案切换。**无 migration**（required:false + 读取 `?? true` 兜底，仿 heartbeatConfig 容忍旧 record）。

## 2. 核心产品决策（代决）

| # | 决策 | 理由 |
|---|------|------|
| D1 | **squad 一定有群聊（实体恒存在）**：开关只控可见性，不删不建 session | 老板语义「squad 一定有群聊」；删 session 是破坏性变更，且群聊历史/路由机制保留 |
| D2 | **默认开（true）**：存量 squad 无字段 → 读取 `?? true`；新建 squad → 建队 service 显式写 true | 存量 + 新建行为不变（不破坏现有群聊工作流）；required:false 容忍旧 record，无需 migration |
| D3 | **注入开关 = reachable_agents 的 squadChatRef 构造处**（一处改动管两头）：`squadChatRef = squad.enableGroupChat !== false ? {...} : null` | leader 亲自核实：`reachable_agents.ts` 就是 system_reminder `[Reachable agents]` 段的数据源（L183 渲染函数逐字一致），同一 provider 同时供 system prompt + system_reminder；squadChatRef=null → compact 自动过滤，两头同时覆盖，无第二注入点 |
| D4 | **send_message('squadchat') 关时解析失败报错**：`resolveSquadAlias` 的 'squadchat' 分支按开关返 null → send_message 返 cannot resolve target | 对齐 isAttachEnabled not_enabled 模式（不静默投递）；防「消息发了没人看」+ 防 SquadChat 跑一轮空路由浪费 LLM |
| D5 | **协作规则（群聊）段无条件删除（老板最终裁决，非开关控制）**：leader.md/mate.md「## 协作规则（在群聊里讲话）」段从 squad_role.ts 写死删除——**开/关都不注入**（纪律留在 AGENTS.md，prompt 里这段冗余）；开关只管「注入可见性」（Reachable agents 的 SquadChat 条目 + UI 入口 + send_message 门控） | 老板最终裁决覆盖前两条：协作规则段写死在 leader/mate 里冗余，直接删掉；无需两态切换（开态也不注入）。D3 的 reachable_agents 判定仍管注入可见性 |
| D6 | **UI 入口隐藏 = SeatsBody 不传 `onOpenGroupChat`**：SeatCard 已支持缺省隐藏（`onOpenGroupChat?: () => void`） | 最小改动；不新增 UI 分支，组件契约已就绪 |
| D7 | **管理开关放 autowork-tab**（SquadAutonomyToggle 同区域/同模式）：toggle + PATCH /squad + 父级 refresh | 对齐 enableHeartBeat 先例（模式 1），复用成熟交互（data-action-key + role=switch + error banner） |
| D8 | **群聊 session 历史可达性**：关群聊后 UI 无入口；若经直链/历史进入群聊落地页 → 页面仍可读（只读历史，不新增引导） | 群聊 session 保留；不做二次拦截（session chrome capabilities.groupRender 不变，渲染策略照常） |

## 3. 功能需求

### 3.1 squad schema 新增字段（enableGroupChat）

- `app/server/src/agent/schema_defs/squad/squad.ts` 加字段：
  ```
  /** 群聊可见性开关（v0.0.270）：true=agents 注入可见 + UI 入口可见；false=两者隐藏。
   *  squad 实体恒存在（squadChatSessionId 不删）；仅控制注入层 + UI 层可见性。
   *  required:false + 读取 ?? true 兜底（容忍旧 squad record，无需 migration）。 */
  enableGroupChat: { type: 'boolean', required: false },
  ```
- 语义：**缺省 = 开**（`?? true`）；显式 false = 关。

### 3.2 server 注入判定（一处管两头）

- `app/plugins/builtins/rocky_context/prompt/reachable_agents.ts` `deriveSquadScoped()`：`squadChatRef` 构造处加判定
  ```
  const squadChatRef: AgentRef | null =
    squadChatSid && squad.enableGroupChat !== false
      ? { type: 'squad', sessionId: squadChatSid, name: 'SquadChat' }
      : null;
  ```
- **效果**：leader（L121）+ mate（L124）列表自动收缩；system prompt 与 system_reminder `[Reachable agents]` 段**同时**不含 SquadChat（leader 已核实同一 provider）。
- **无需改**：`[squad:tasks]` / `[squad:team-status]` 段（核实：squad_task.ts / squad_team_status.ts 不含 SquadChat 条目）。

### 3.3 send_message 路由判定（关时报错不静默）

- `app/server/src/agent/tools/runtime-context.ts` `resolveSquadAlias()`：'squadchat' 分支加判定
  ```
  if (alias === 'squadchat') {
    if (squad.enableGroupChat === false) return null; // 群聊关闭 → 解析失败
    return squad.squadChatSessionId;
  }
  ```
- 解析失败 → send_message 返 cannot resolve target（对齐 isAttachEnabled not_enabled 模式，明确报错不静默投递）。
- **不阻塞**：'leader' / member name 别名解析不变（私聊通道不受影响，开关关 = 全私聊语义）。

### 3.4 协作规则（群聊）段无条件删除（老板最终裁决）★ 非开关控制

- 文件：`app/server/src/prompts/content/squad/{leader,mate}.md`（群聊协作段）+ `squad_role.ts` map() 分支。
- **产品语义（老板最终裁决 2026-08-06，覆盖前两条）**：「## 协作规则（在群聊里讲话）」段从 squad_role.ts **写死删除——开态也不注入**（不是两态切换）。协作纪律留在 AGENTS.md 即可，prompt 里这段冗余。
- **实现（架构期定）**：leader/mate content 文件删除该段（或 squad_role.ts 注入时剥离该段，架构期定最简方式）；`[Reachable agents]` 段由 §3.2 squadChatRef=null 自然收缩（关态无 SquadChat 条目）。
- **开关只管**：① Reachable agents 的 SquadChat 条目（§3.2）② UI 入口（§3.5）③ send_message 门控（§3.3）。协作规则段不随开关，无条件删除。

**删除范围（leader.md/mate.md）**：

| 角色 | 删除段 | 说明 |
|------|--------|------|
| leader | `## 协作规则（在群聊里讲话）` | 4 条群聊协作指引（下达/接收/汇报/转发回复）整段删除；leader.md 其余内容保留（角色定位/工具权限/task 说明等） |
| mate | `## 协作规则（在群聊里讲话）` | 4 条群聊协作指引（问 leader/peer/回报/转发回复）整段删除；mate.md 其余内容保留（角色定位/工具权限/task 说明等） |
| 全部 | `[Reachable agents]` 段 | 关态无 SquadChat 条目（§3.2 squadChatRef=null 自然收缩）；`[squad:tasks]` / `[squad:team-status]` 保留（与群聊无关，老板未异议） |

- **其他「群聊」表述（leader.md/mate.md 除协作规则段外的零星引用）**：「接需求」「分配」「收交付」「报进度」等段若含「群聊 @」表述，同样清理（prompt 不再指引群聊广播）；架构期评估最简清理点。**原则：prompt 无任何群聊广播指引（协作靠 AGENTS.md 纪律）**。
- **squad_chat.md 不影响**：SquadChat session 不跑（关时无注入无入口），路由器人设保留无妨。

### 3.5 UI 入口隐藏（队长卡群聊按钮）

- `component-seats-body.tsx`：`onOpenGroupChat` 传参加判定——`detail.enableGroupChat !== false` 时才传 `onOpenGroupChat`（+ 右键复制 sessionId 的 onGroupChatContextMenu 同步不传）；SeatCard 已支持缺省隐藏（`component-seat-card.tsx:143` `{onOpenGroupChat && ...}`）。
- **效果**：关群聊 → 队长卡操作行只留「进入对话」+ more 按钮，群聊按钮消失；布局无位移（条件渲染不占位，flex 自然收缩）。

### 3.6 管理开关（autowork-tab toggle）

- 新建 `component-group-chat-toggle.tsx`（仿 `component-squad-autonomy-toggle.tsx` 模式）：
  - 形态：label + toggle（role=switch + data-action-key + aria-checked）+ on/off 文案 + error banner
  - 交互：点击 → `onPatch({ enableGroupChat: !enableGroupChat })` → PATCH /squad → 父级 refresh 回灌新值（无本地态切换）
  - 视觉基线：与 SquadAutonomyToggle 一致（同区域同风格）
- 挂载：`component-autowork-tab.tsx`（SquadAutonomyToggle 之后，独立块）。
- i18n：studio namespace 新增 `groupChat.*`（label/hint/on/off），en + zh-CN。
- **后端 PATCH**：`app/server/src/handlers/squad.ts` 加 `if (body.enableGroupChat !== undefined) patch.enableGroupChat = body.enableGroupChat;`（enableHeartBeat 同款）。
- **SquadDetail 回显**：`toDetail()` / `toSummary()` 加 `enableGroupChat`（前端 toggle 读回显值）；`squad-types.ts` SquadDetail/SquadSummary/PatchSquadBody 同步。

### 3.7 建队默认（新建 squad 默认开）

- `app/server/src/services/squad-service.ts` 建队 record 显式写 `enableGroupChat: true`（对齐 `enableHeartBeat: false` 模式，方向相反：群聊默认开）。

## 4. 关键用户路径（MANDATORY）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 新建 squad → 进入 squad 首页（seats）→ 看队长卡操作行 | 群聊按钮可见（默认开）；autowork 面板群聊开关默认 on |
| UC-2 | 存量 squad（升级前创建，无 enableGroupChat 字段）→ 看队长卡 + agents 注入 | 群聊行为不变（读取 `?? true` = 开），零破坏 |
| UC-3 | autowork 面板关群聊开关 → PATCH 成功 → 父级 refresh | 开关显示 off；返回 squad 首页 → 队长卡群聊按钮消失 |
| UC-4 | 关群聊后，leader/mate 每轮 system_reminder 看 `[Reachable agents]` 段 | 无 SquadChat 条目（system prompt 注入同样无） |
| UC-5 | 查看 leader/mate 的协作规则 prompt（开/关态均适用） | 「## 协作规则（在群聊里讲话）」段**不存在**（无条件删除，纪律在 AGENTS.md） |
| UC-6 | 关群聊后，agent 调 `send_message(target='squadchat')` | 返回解析失败报错（cannot resolve target），不静默投递、不触发 SquadChat 空路由 |
| UC-7 | 关群聊后，agent 调 `send_message(target=leader 或 mate sessionId)` | 正常投递（私聊通道不受开关影响） |
| UC-8 | autowork 面板再开群聊开关 → PATCH 成功 → refresh | 开关显示 on；队长卡群聊按钮恢复；agents 注入恢复 SquadChat（协作规则段不恢复，无条件删除） |
| UC-9 | 关群聊后，经直链/复制 sessionId 进入群聊落地页 | 页面可读（历史只读），无新增引导；squad 首页无群聊入口 |

## 5. 概念对齐 + 新概念

### 概念对齐（复用现有）

| 概念 | 出处 | 复用方式 |
|------|------|---------|
| squad 布尔开关先例（enableHeartBeat） | `squad.ts:59` schema / `squad-service.ts:213` 建队 / `handlers/squad.ts:402` PATCH / `component-squad-autonomy-toggle.tsx` toggle | schema + service + PATCH + toggle 四层同款复制 |
| 工具级动态门控（isAttachEnabled） | `attach-mode-impl.ts:29`（not_enabled 报错）/ `bootstrap-connectors-phase.ts:133` | send_message 关时解析失败报错语义对齐 |
| heartbeatConfig 容忍旧 record | `squad.ts:66-74`（required:false + ?? 兜底） | enableGroupChat 同模式（required:false + ?? true），无 migration |
| SeatCard 缺省隐藏 | `component-seat-card.tsx:143` `{onOpenGroupChat && ...}` | UI 入口隐藏零新增分支 |
| reachable_agents reminder | `reachable_agents.ts`（system_reminder provider + system prompt 共用） | squadChatRef 构造处单点判定管两头 |
| PATCH /squad 字段扩展 | `handlers/squad.ts:402` | enableGroupChat 同款字段 |

### 新概念

| 概念 | 说明 | 需落 spec |
|------|------|----------|
| **enableGroupChat 开关**（squad 字段） | 群聊可见性开关（默认 true）；注入层 + UI 层双控 | `specs/api/overall/11a-squad-endpoints.md` §1.3/§1.4 + `specs/tech/squad/[P1]data_model.md` §1.1 |
| **group-chat-toggle 组件**（新） | autowork-tab 内开关（仿 SquadAutonomyToggle） | `specs/ui/components/studio-page/component-group-chat-toggle.md` |
| **协作规则私聊版**（新） | leader/mate 群聊协作段的无群聊版本（开关关时注入） | `specs/tech/squad/[P1]prompt_sections.md` §3.1 |

## 6. 边界 / 不做

- **不做删群聊 session / 改 squadChatSessionId / dissolve**：squad 一定有群聊（老板语义），开关只控可见性。
- **不做群聊历史清理**：session 保留，历史消息保留；关群聊后经直链仍可读（只读）。
- **不做跨 squad 群聊**：开关是 squad 级，不影响其他 squad。
- **不做成员级群聊权限**：开关是 squad 级统一控制，不细分成员。
- **不做发送拦截 UI 提示**：关群聊后 agent 发 squadchat 报错是工具层语义（not_resolved），无前端 toast/引导（agent 侧 prompt 已切换，正常不会触发）。
- **不新增 AT/ET 持久 case**：开关是确定性布尔控制（无 LLM 不确定性），UT 覆盖 schema 判定 + 注入派生 + 路由解析 + toggle 交互；ET 回归既有 squad 冒烟（若 orchestrator 认为值得，可加一条群聊开关冒烟）。

## 7. 验收口径

**能力不变量**：
1. squad 新建默认 enableGroupChat=true（建队写死）；存量 squad 读取 `?? true`（无字段视为开）。
2. 开：system prompt + system_reminder `[Reachable agents]` 均含 SquadChat；队长卡群聊按钮可见。
3. 关：两处注入均无 SquadChat（一处 squadChatRef=null 管两头）；队长卡群聊按钮消失（不传 prop）。
4. 关：send_message('squadchat') 返解析失败报错，不静默投递；'leader' / member name 私聊解析正常。
5. **开/关态均**：leader/mate 协作规则 prompt 无「## 协作规则（在群聊里讲话）」段（无条件删除，纪律在 AGENTS.md）。
6. 管理开关：autowork-tab toggle + PATCH /squad + refresh 回灌（关→按钮消失、开→按钮恢复）。

**回归不变量**：
1. 群聊 session 实体零变化（squadChatSessionId 不变、消息/路由机制不动）。
2. 开关默认开 → 存量 squad 行为零变化（不破坏现有群聊工作流）。
3. enableHeartBeat / budget / heartbeatConfig 等既有字段与开关互不影响。
4. `[squad:tasks]` / `[squad:team-status]` 段零变化（不含 SquadChat 条目，无需判定）。

**性能护栏**：
- 注入判定是纯读字段（squad.enableGroupChat），无新增 IO/订阅；PATCH 走既有 refresh 链路。

## 8. spec 对齐备忘

- `specs/api/overall/11a-squad-endpoints.md`：§1.3 SquadDetail + §1.4 PatchSquadBody 加 `enableGroupChat?: boolean`（回显 + 可 PATCH）。
- `specs/tech/squad/[P1]data_model.md`：§1.1 squad schema 加 enableGroupChat 字段说明（required:false + ?? true）。
- `specs/tech/multi_agent/[P1]a2a_protocol.md`：reachable_agents 派生表加「enableGroupChat=false → squadChatRef 不构造」注记。
- `specs/tech/squad/[P1]prompt_sections.md`：§3.1 squad_role 加「群聊协作段（leader/mate）无条件删除，纪律留 AGENTS.md（老板裁决 v0.0.270）」。
- `specs/ui/components/studio-page/component-seat-card.md`：群聊按钮缺省隐藏说明（onOpenGroupChat 不传即隐藏，v0.0.270 起受开关控制）。
- `specs/ui/components/studio-page/component-autowork-tab.md`：加 group-chat-toggle 块。
- 新组件 spec：`component-group-chat-toggle.md`（仿 squad-autonomy-toggle.md）。

## 9. 版本总结

- **产品价值**：squad 群聊可见性可控——团队可关闭群聊（优先私聊纪律），agents 不再误发群聊；默认开零破坏，随时可重开。
- **范围**：schema 加字段 + server 注入单点判定（管 system prompt + system_reminder 两头）+ send_message 路由判定 + 协作规则（群聊）段无条件删除 + UI 入口隐藏 + 管理 toggle；无 migration。
- **关键决策**：squad 实体恒存在（只控可见性）；默认开（?? true 兜底）；注入开关落在 squadChatRef 构造处（leader 核实一处管两头）；关时 send_message 报错不静默；协作规则段无条件删除（开/关都不注入，纪律留 AGENTS.md——老板最终裁决）；管理开关在 autowork-tab。
- **风险/口子**：协作规则段删除影响现有 prompt 协作指引（纪律已留 AGENTS.md，团队 AGENTS.md 注入不受影响）；关群聊后群聊落地页经直链仍可读（不做二次拦截）；注入判定是读字段无性能风险。
