# v0.0.301 变更计划书 — a2a 信封消息去掉左侧发送者头像

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 权威输入：`specs/prd/version_logs/v0.0.301/prd.md`（§3 功能设计 = avatar:null 双分支；§6 验收 9 条）+ `states/v0.0.301/context.md`（leader/prd findings）

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（ui-chat） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（行粒度 = 符号） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-chat | app/web/src/components/chat-page/chat-actor-strategy.tsx | resolveGroupActor()（群聊 a2a 分支，现 L66-74） | 修改 | a2a inbox 分支返回值 `avatar` 由 `<MemberAvatar name={ref.name} role={role} id={ref.sessionId}/>` 改为 `null`；`name: ref.name` 与 `showNameAsPrefix: true` 保留不变 | MUST NOT 删 `name`/`showNameAsPrefix` 字段（信封 senderName 数据源 + 前缀行守卫依赖）；MUST NOT 改 human user 分支（L75 `MemberAvatar name="you" role="user"`） | specs/prd/version_logs/v0.0.301/prd.md §3.1；specs/ui/components/chat-page/section-chat-session.md「groupRender 门控矩阵」 | 1 行改值（-1/+1 字符级） |
| ui-chat | app/web/src/components/chat-page/chat-actor-strategy.tsx | resolveMemberActorFactory()（单聊 a2a 分支，现 L106-110） | 修改 | 工厂返回的 resolver 中 a2a inbox 分支 `avatar` 由 `<MemberAvatar name={ref.name} role={refRole} id={ref.sessionId}/>` 改为 `null`；`name: ref.name` 与 `showNameAsPrefix: true` 保留不变 | MUST NOT 删 `name`/`showNameAsPrefix`（信封 senderName 数据源）；MUST NOT 改 human user 分支（L100-102）与对端普通回复分支（L111，非 a2a 消息左侧对端头像保留） | specs/prd/version_logs/v0.0.301/prd.md §3.1；specs/ui/components/chat-page/section-chat-session.md「member 单聊 a2a 消息渲染」 | 1 行改值 |
| ui-chat | app/web/src/components/chat-page/chat-actor-strategy.tsx | RenderStrategy / actor 返回类型（`{ avatar: ReactNode; ... }`） | 修改 | **无需改**（类型层面确认：`ReactNode` 含 `null`，avatar 置 null 是既有类型的合法取值，无需类型变更/新增占位组件） | MUST NOT 新增占位组件/新类型（最小 diff，零新概念） | specs/prd/version_logs/v0.0.301/prd.md §5（无新概念发明） | 0 |
| ui-chat | app/web/src/components/chat-page/component-message-stream.tsx | L226 user 侧渲染表达式 `{actor ? actor.avatar : <DefaultUserAvatar/>}` | 修改 | **无需改**（零改动确认：actor 对象存在时渲染 `actor.avatar`，为 null 则不渲染头像节点、不 fallback 默认头像；human user 分支 avatar 仍非 null，零回归） | MUST NOT 改此表达式（a2a 走 assistant 侧 L236 分支，L226 仅 user 侧） | specs/prd/version_logs/v0.0.301/prd.md §3.1「为什么 avatar=null 可行」 | 0 |
| ui-chat | app/web/src/components/chat-page/component-message-stream.tsx | L236 assistant 侧渲染表达式 `{actor ? actor.avatar : <DefaultAgentAvatar/>}` | 修改 | **无需改**（零改动确认：a2a 消息 actor.avatar=null → 该表达式渲染 null 不产生节点，即 a2a 行左侧无头像；assistant answer/tool 分支 avatar 仍非 null 照常渲染） | MUST NOT 改此表达式；MUST NOT 为 a2a 行额外加占位 div（信封行 inline-flex 贴左，无需 w-9 对齐） | specs/prd/version_logs/v0.0.301/prd.md §3.2（布局稳定性）；context.md [prd 20:06] | 0 |
| ui-chat | app/web/src/components/chat-page/component-message-stream.tsx | L239 `!isA2aInbox(msg)` 前缀行守卫 + L246-250 ComponentA2aEnvelope 装配 + L261 `w-9 shrink-0` 右侧占位 | 修改 | **无需改**（零改动确认：a2a 不渲前缀行守卫保留；信封组件 senderName={actor?.name ?? ''} 不受 avatar 影响；右侧 w-9 占位与整体 flex 不动） | MUST NOT 改这些行（最小 diff：只去左侧头像节点本身） | specs/prd/version_logs/v0.0.301/prd.md §3.2/§3.3 | 0 |

### 文件级变更清单

| 文件 | 操作 | 变更内容 |
|---|---|---|
| app/web/src/components/chat-page/chat-actor-strategy.tsx | 修改 | 仅 2 处：resolveGroupActor a2a 分支（L70）与 resolveMemberActorFactory a2a 分支（L109）的 `avatar` 值改为 `null` |
| app/web/src/components/chat-page/component-message-stream.tsx | 不改 | 渲染表达式零改动（avatar=null 自动不渲染节点） |
| app/web/src/components/chat-page/component-a2a-envelope.tsx | 不改 | 信封组件零改动（收起/展开/senderName/气泡全保留） |

### 测试要求（UT）

- `chat-actor-strategy.test.tsx`：a2a inbox 消息（群聊 + 单聊两分支）→ `resolveActor(msg).avatar` 为 null（或 falsy）；human user → avatar 仍为 MemberAvatar；单聊对端普通回复 → avatar 仍为 MemberAvatar（零回归断言）
- `component-message-stream-strategy.test.tsx`：resolveActor 注入用例 L129+ —— a2a 行渲染无头像节点（如 snapshot/查询无 img/avatar 元素）；非 a2a 行头像仍在
- 无 AT 需求（纯前端 UI，确定性展示；见 PRD §6 验收 9）

## 影响面评估

- **跨模块**：仅 ui-chat 前端 1 文件（chat-actor-strategy.tsx）2 个符号改值；component-message-stream.tsx / component-a2a-envelope.tsx / 后端 / API 零改动
- **破坏性**：无。`avatar` 可空是既有类型合法取值（ReactNode 含 null）；渲染表达式已天然处理 null
- **依赖顺序**：无跨层依赖（单文件前端改动，不触 protocol/server）
- **风险点**：① 误删 `name`/`showNameAsPrefix` 会破坏信封 senderName 与前缀行逻辑 → 约束列已钉死；② 误改 human/assistant 分支造成头像回归 → 约束列已钉死；③ 测试文件需同步断言 avatar=null（T3 编码任务覆盖）
- **ET 视觉确认点**：群聊/单聊 a2a 信封行左侧无头像；human 消息头像照常（PRD §4 路径 1-4）

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
