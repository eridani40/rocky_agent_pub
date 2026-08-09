# v0.0.270 变更计划书 — 群聊开关（enableGroupChat）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（schema / api-squad / context-inject / a2a-routing / prompt-content / ui-seats / ui-autowork / web-types / i18n / test） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

## 架构裁决（5 条）

1. **schema required:false + 读取 `?? true` 兜底**（对齐 heartbeatConfig 容忍旧 record）：`enableGroupChat` 加进 SquadSchema，存量 squad 无字段 → 读取时 `?? true`（缺省=开）；新建 squad 建队 service 显式写 `true`（对齐 `enableHeartBeat: false` 模式，方向相反）。无 migration。
2. **注入门控单点 = reachable_agents.ts `deriveSquadScoped()` squadChatRef 构造处**（PRD D3，leader 核实）：`squadChatRef = squadChatSid && squad.enableGroupChat !== false ? {...} : null`。**用 `!== false` 而非 `=== true`**——undefined（旧 record）视为开，与 toDetail `?? true` 语义一致。同一 provider 供 system prompt + system_reminder 两头，squadChatRef=null → compact 自动过滤 → 两头同时覆盖，无第二注入点。`[squad:tasks]` / `[squad:team-status]` 段已核实不含 SquadChat 条目，零改动。
3. **协作规则（群聊）段无条件删除 = 改 content 文件**（PRD D5 老板最终裁决）：leader.md / mate.md 直接删「## 协作规则（在群聊里讲话）」段 + 清理其他「群聊 @」广播指引（改 send_message 直连口径）；**squad_role.ts map() 逻辑不动**（LeaderContentHandler/MateContentHandler 是纯 `readContent()` 文件读取，删文件段即生效，开/关态均不注入）。保留 user 沟通类表述（「user 在群聊提需求」「会话或群聊和 user 对齐」——描述外部沟通，非 agent 群聊广播指引）。
4. **send_message 门控 = resolveSquadAlias 'squadchat' 分支关时返 null**（PRD D4，对齐 isAttachEnabled not_enabled 模式）：`if (squad.enableGroupChat === false) return null` → send_message 返 cannot resolve target（不静默投递）。'leader' / member name 私聊解析不受影响（关 = 全私聊语义）。
5. **任务并行切分**：T1（schema + server 注入 + 路由 + prompts 删除）与 T2（web types + toggle + SeatCard 隐藏 + i18n）**文件级零重叠可并行**（server/plugins/prompts vs web）；T3 spec 同步依赖两者。⚠️ 集成注意：T2 组件读 `detail.enableGroupChat` 运行时依赖 T1 的 toDetail 回显——T1/T2 完成后一起集成验证（同一 worktree，合并前统一回归）。

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| schema | app/server/src/agent/schema_defs/squad/squad.ts | SquadSchema.enableGroupChat | 新增 | 加 `enableGroupChat: { type: 'boolean', required: false }` + v0.0.270 语义注释（true=注入+UI 可见；false=两者隐藏；squad 实体恒存在仅控可见性；required:false + ?? true 兜底容忍旧 record） | MUST required:false（无 migration）；MUST 注释写明「缺省=开」 | PRD §3.1；调研 §3.1 | +6 |
| squad-service | app/server/src/services/squad-service.ts | createSquad putSquad record | 修改 | 建队 putSquad 显式写 `enableGroupChat: true`（对齐 `enableHeartBeat: false` 位置，方向相反默认开） | MUST 不依赖前端传参；MUST 与 enableHeartBeat 相邻 | PRD §3.7；调研 §3.3 | +1 |
| api-squad | app/server/src/handlers/squad.ts | PatchSquadBody / SquadSummary / SquadDetail | 修改 | 三类型各加 enableGroupChat：PatchSquadBody `?: boolean`、SquadSummary/SquadDetail `: boolean` | MUST 与 web squad-types.ts 字段同步 | PRD §3.6；specs/api/overall/11a-squad-endpoints.md §1.3/§1.4 | +3 |
| api-squad | app/server/src/handlers/squad.ts | toSummary() / toDetail() | 修改 | 回显 `enableGroupChat: s.enableGroupChat ?? true` | MUST `?? true` 兜底（required:false 旧 record） | PRD §2 D2；PRD §3.6 | +2 |
| api-squad | app/server/src/handlers/squad.ts | PATCH 分支 | 修改 | `if (body.enableGroupChat !== undefined) patch.enableGroupChat = body.enableGroupChat;` | MUST undefined=不修改（对齐 enableHeartBeat 模式 L402） | PRD §3.6；调研 §3.2 模式1 | +1 |
| context-inject | app/plugins/builtins/rocky_context/prompt/reachable_agents.ts | deriveSquadScoped() squadChatRef 构造 | 修改 | `squadChatRef: AgentRef \| null = squadChatSid && squad.enableGroupChat !== false ? { type:'squad', sessionId: squadChatSid, name:'SquadChat' } : null` | MUST `!== false`（undefined=开，与 toDetail ?? true 一致）；MUST 一处管两头（system prompt + system_reminder 共用 provider） | PRD §3.2 D3；调研 §1 注入点A | +2/-1 |
| a2a-routing | app/server/src/agent/tools/runtime-context.ts | resolveSquadAlias() 'squadchat' 分支 | 修改 | `if (alias === 'squadchat') { if (squad.enableGroupChat === false) return null; return squad.squadChatSessionId; }` | MUST 关时返 null（解析失败报错不静默投递）；MUST 'leader'/member name 分支不受影响 | PRD §3.3 D4；调研 §1 send_message | +3/-1 |
| prompt-content | app/server/src/prompts/content/squad/leader.md | 「## 协作规则（在群聊里讲话）」段 + 群聊广播表述 | 修改 | 删除 L17-22 协作规则段（4 条）；清理其他「群聊 @」广播指引（L8 分配/L10 收交付/L38 派单通知 → send_message 直连口径）；保留 L7「user 在群聊提需求」/L11「会话或群聊和 user 对齐」（外部沟通描述） | MUST 无条件删除（开/关态均不注入，非两态切换）；MUST prompt 无 agent 间群聊广播指引（纪律留 AGENTS.md） | PRD §3.4 D5；specs/tech/squad/[P1]prompt_sections.md §3.1 | -20 |
| prompt-content | app/server/src/prompts/content/squad/mate.md | 「## 协作规则（在群聊里讲话）」段 + 群聊广播表述 | 修改 | 删除 L19-24 协作规则段（4 条）；清理其他「群聊 @」广播指引（L7 接分配/L10 报进度/L15 问 leader/L17 peer 协作/L23 报完成 → send_message 直连口径）；保留工具权限等其余内容 | MUST 无条件删除（开/关态均不注入）；MUST prompt 无 agent 间群聊广播指引 | PRD §3.4 D5；specs/tech/squad/[P1]prompt_sections.md §3.1 | -20 |
| web-types | app/web/src/components/studio-page/squad-types.ts | SquadSummary / SquadDetail / PatchSquadBody | 修改 | 三类型各加 enableGroupChat（SquadSummary/SquadDetail `: boolean`、PatchSquadBody `?: boolean`） | MUST 与 server handlers 类型同步 | PRD §3.6 | +3 |
| ui-seats | app/web/src/components/studio-page/component-seats-body.tsx | SeatCard onOpenGroupChat / onGroupChatContextMenu 传参 | 修改 | `detail.enableGroupChat !== false` 时才传 `onOpenGroupChat` + `onGroupChatContextMenu`（关时不传 → SeatCard 缺省隐藏，`component-seat-card.tsx:143` 已支持） | MUST 双 prop 同步（按钮 + 右键复制 sessionId）；MUST 不新增 UI 分支（条件渲染自然收缩不占位） | PRD §3.5 D6；调研 §2 展示点A | +2/-2 |
| ui-autowork | app/web/src/components/studio-page/component-group-chat-toggle.tsx | GroupChatToggle | 新增 | 群聊可见性开关：label + toggle（role=switch + data-action-key=studio.squad.toggle-group-chat + aria-checked）+ on/off 文案 + error banner；点击 → `onPatch({ enableGroupChat: !enableGroupChat })` → PATCH /squad → 父级 refresh 回灌（无本地态切换）；防 in-flight 双击竞态 | MUST 仿 SquadAutonomyToggle 模式（data-action-key + role=switch + pending + error banner）；MUST 无本地态切换（成功靠父级 refresh 回灌） | PRD §3.6 D7；调研 §3.2 模式1 | +80 |
| ui-autowork | app/web/src/components/studio-page/component-autowork-tab.tsx | AutoworkTab 挂载 | 修改 | SquadAutonomyToggle 之后挂 `<GroupChatToggle squadId={detail.id} enableGroupChat={detail.enableGroupChat} onPatch={onSaveMeta} />`（独立块） | MUST 在 SquadAutonomyToggle 后（同区域同风格）；MUST 纯容器透传（不新增数据流） | PRD §3.6；调研 §3.3 | +6 |
| i18n | app/web/src/i18n/locales/en/studio.json + zh-CN/studio.json | groupChat.* | 新增 | groupChat.label / groupChat.hint / groupChat.on / groupChat.off 键（对齐 autonomy 段风格） | MUST en + zh-CN 同步 | PRD §3.6；specs/ui/components/studio-page/component-group-chat-toggle.md | +8 |
| test | app/server/src/handlers/__tests__/squad-handler.test.ts | PATCH enableGroupChat + 回显用例 | 新增 | PATCH { enableGroupChat: false } → toDetail 回显 false；undefined 不修改；存量无字段 squad → ?? true；toSummary 同 | MUST 确定性 HTTP 契约 UT（不进 AT 持久 case，项目铁律） | PRD §7 验收口径1/6 | +20 |
| test | app/server/src/services/__tests__/squad-service.test.ts | 建队默认用例 | 新增 | 新建 squad → record.enableGroupChat === true | MUST 建队默认开 | PRD §7 验收口径1 | +5 |
| test | app/plugins/builtins/rocky_context/__tests__/prompt-studio.test.ts（或新 reachable 测试） | squadChatRef 开关用例 | 新增 | enableGroupChat=false → leader/mate reachable 列表无 SquadChat 条目；undefined/true → 有 | MUST 注入门控两态（system prompt + reminder 同一 provider 覆盖） | PRD §7 验收口径2/3 | +15 |
| test | app/server/src/agent/tools/__tests__/runtime-context-a2a-routing.test.ts | resolveSquadAlias squadchat 开关用例 | 新增 | enableGroupChat=false → resolveSquadAlias('squadchat') null；true → squadChatSessionId；'leader' 解析不受影响 | MUST 路由门控两态 + 私聊通道零影响 | PRD §7 验收口径4/7 | +15 |
| test | app/web/src/components/studio-page/__tests__/component-group-chat-toggle.test.tsx（新） | toggle 交互用例 | 新增 | 渲染 label/switch/on-off 文案；点击调 onPatch 翻转值；PATCH 失败 error banner + toggle 保持原态；pending 期间 disabled | MUST 仿 component-squad-autonomy-toggle.test.tsx 模式 | PRD §7 验收口径6 | +40 |
| test | app/web/src/components/studio-page/__tests__/component-seats-panel.test.tsx（或 seats-body 测试） | 开关传参用例 | 新增 | detail.enableGroupChat=false → 不传 onOpenGroupChat（SeatCard 无群聊按钮）；true/undefined → 传 | MUST UI 入口两态 | PRD §7 验收口径3/6 | +15 |

## 影响面评估

**跨模块**：schema（数据层）→ api-squad（PATCH/回显）→ context-inject（注入门控）→ a2a-routing（路由门控）→ prompt-content（协作规则删除）→ web-types/ui-seats/ui-autowork/i18n（UI 层）。依赖顺序：schema 字段先落（T1）→ reachable/runtime 判定读字段 → toDetail 回显 → web 读值（T2 运行时依赖 T1 回显，集成验证一起）。

**破坏性变更**：协作规则（群聊）段从 leader/mate prompt 删除（开/关态均不注入）——**唯一的 prompt 行为变更**，纪律已留团队 AGENTS.md；agent 间群聊广播指引全部改 send_message 直连口径。无 schema migration（required:false + ?? true）。

**风险点**：
1. **注入与 UI 双读同一数据源防撕裂**（调研 §5 风险 1）：reachable_agents（server 读 SquadRecord.enableGroupChat）+ SeatCard（web 读 SquadDetail.enableGroupChat 回显）读同一字段；toDetail `?? true` 与 reachable `!== false` 语义一致（undefined=开）。PATCH 后父级 refresh 回灌 → UI 即时收敛；running agent 当轮 volatile reminder 可能仍含旧 reachable（下一轮即收敛，低风险）。
2. **prompt 文案改写语义完整性**：协作规则段删除 + 群聊广播指引清理后，leader「分配/收交付/派单通知」与 mate「接分配/报进度/问 leader/协作」链路不能断——改 send_message 直连口径需保持各链路的寻址语义（谁发给谁、needReply 语义不变）。
3. **存量 squad 零破坏**：无字段 → `?? true`（server 回显）/ `!== false`（注入判定）双兜底——存量群聊工作流不变。未来若改 required:true 需 migration（当前不做）。
4. **send_message('squadchat') 关时报错**：resolveSquadAlias 返 null → cannot resolve target——不静默投递（防消息发了没人看 + 防 SquadChat 空路由）。私聊（leader/member name）不受影响。SquadChat session 自身（sessionType='squad'）不受影响（其 send_message 走 leader/member 别名，不走 'squadchat'；且关态下无注入无入口不跑）。
5. **PATCH 字段扩展边界**：`!== undefined` 才 patch——不误改旧 squad 其他字段；toDetail `?? true` 保证前端 toggle 拿正确初值（不会误显 off）。
6. **UI 入口隐藏零分支**：SeatCard 已支持 `onOpenGroupChat?: () => void` 缺省隐藏（component-seat-card.tsx:143）——SeatsBody 条件传参即可，不新增渲染分支；onGroupChatContextMenu 同步不传（右键复制 sessionId 入口一并隐藏）。

**性能护栏**：注入判定是纯读字段（squad.enableGroupChat），无新增 IO/订阅；PATCH 走既有 refresh 链路；group-chat-toggle 无本地态切换（父级 refresh 回灌）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- **协作规则段删除范围争议**（leader.md/mate.md 哪些「群聊」表述清、哪些留）→ 以本表「变更内容」列的清理清单为准；拿不准的表述留 AGENTS.md 纪律兜底，不扩大删除面
