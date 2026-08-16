# 04a — Session Chrome（GET /session/:id/chrome，会话装饰同构接口）

> since: v0.0.216 · 权威源：本文件（capabilities 静态表 + kind 数据源映射）
> 上游：`specs/tech/app/frontend/[P0]chat_session_assembly.md`（前端消费契约）
> 关联：`04-agent-session.md`（Session CRUD）/ `11a-squad-endpoints.md`（SquadDetail）/ academy 教室实体（`specs/tech/academy/[P0]data_model.md`）

## 1. 概述

- **管什么**：`GET /session/:id/chrome` —— 前端统一 chat 装配层（`SectionChatSession`）的**唯一装饰数据源**：会话身份（kind/title/tag/readOnly）+ 输入区状态（sessionModel/defaultModel/effort/approvalMode）+ 成员（members）+ 能力开关（capabilities）。
- **不管什么**：run 态/消息流/usage（各自既有端点 + SSE）；写路径（仍走 `PUT /session/:id`）。
- **同构承诺（核心契约）**：**所有 kind 返回同一响应 shape**（字段集恒定）。kind 间差异只体现在**字段值**（defaultModel 来源不同、capabilities 开关不同、members 空不空），**不体现在字段有无**。前端因此零 kind 分支。

## 2. 端点与响应 shape

```
GET /session/:id/chrome
200 → SessionChromeView   |   404 {error:"session not found"}   |   405 (非 GET)
```

```ts
type ChromeKind =
  | 'playground' | 'studio_member' | 'studio_group'
  | 'academy_head' | 'academy_coach' | 'academy_student';

interface SessionChromeView {
  sessionId: string;
  kind: ChromeKind;                 // 派生规则见 §3.1
  /** derivation==='subagent' → true（只读观察，输入侧能力整体不适用） */
  readOnly: boolean;
  /** session.title（titled=false 时仍返原值，前端按 titled 语义显 defaultTitle） */
  title: string;
  titled: boolean;
  /** 身份 tag：studio="squad.name · role|群聊"；academy/playground='' （前端身份 header 自渲） */
  tag: string;
  /** session 持久 model；modelId 空/保留字 'default' → null（picker 显默认态） */
  sessionModel: { providerId: string; modelId: string } | null;
  /** 该 kind 的默认模型（picker 顶部「默认模型」项数据源）；未配置 → null */
  defaultModel: { providerId?: string; modelId: string } | null;
  /** 该 kind 挂载的默认方案（picker「方案 · 名（默认）」数据源）；未挂载/方案被删 → null；academy 恒 null（同构：字段恒在） */
  defaultRoutingPlan: { planId: string; planName: string } | null;
  effort: 'default' | 'low' | 'high' | 'max' | null;
  approvalMode: 'normal' | 'greenlight' | null;
  /** studio: squad 全体成员投影（群聊 actor 解析用）；其他 kind 恒 []（同构：字段恒在） */
  members: { id: string; name: string; role: string }[];
  /** studio_member: 对端 member id；其他 kind 无对端 → null */
  memberId: string | null;
  capabilities: SessionCapabilities;
}
```

## 3. kind 判定与数据源映射（后端静态表）

### 3.1 kind 派生（`services/session-chrome.ts.deriveChromeKind()`）

| 判定（按序） | kind |
|---|---|
| `biz==='studio' && role==='squad'` | `studio_group` |
| `biz==='studio'`（leader/mate） | `studio_member` |
| `biz==='academy' && role==='head_teacher'` | `academy_head` |
| `biz==='academy' && role==='coach'` | `academy_coach` |
| `biz==='academy' && role==='student'` | `academy_student` |
| 其余（含 biz 缺省） | `playground` |

`readOnly = session.derivation === 'subagent'`（与 kind 正交；subagent 保留宿主 kind）。

### 3.2 defaultModel / defaultRoutingPlan / tag / members 数据源

| kind | defaultModel 来源 | defaultRoutingPlan 来源 | tag | members |
|---|---|---|---|---|
| playground | `app_config.default_models.default.chat`（modelId only） | `app_config.model_routing.default.playgroundPlanId` → `getPlan` 反查 `plan.name` | '' | [] |
| studio_member / studio_group | `squadStore.getSquad(session.squadId)` → `modelDefault` + `modelDefaultProviderId` | `squad.modelRoutingPlanId` → `getPlan` 反查 `plan.name` | `squad.name · member.role` / `squad.name · 群聊` | `memberStore.listMembers(squadId)` 投影 |
| academy_head / coach / student | `academyStore.getClassroom(session.academyClassroomId)` → `defaultModel {providerId?, modelId}` | 恒 `null`（非目标） | '' | [] |

> `defaultRoutingPlan` 与运行时 `resolveModelRoutingPlan`（session-config.ts）同口径：方案被删（`getPlan` 返 undefined）→ `null`（视为未挂载，不 throw）；保证「显示 == 实际行为」。方案/默认模型互斥（T6），二选一。

**降级规则**：squad/classroom 不存在、default 未配置 → 对应字段 null/[]，**不 throw 不 4xx**（chrome 是展示装饰，缺数据按未配置渲染）。tag 逐段降级：studio_member 对端 member 缺失（members 列表中查无 `session.memberId`，数据不一致）→ tag 仅 `squad.name`（无 `· role` 段）；squad 名缺失 → tag=''。数据源读取异常（IO error）同样按「缺数据」降级（`services/session-chrome.ts.safeRead()`）。

## 4. capabilities 静态表（后端唯一权威，前端只消费）

```ts
interface SessionCapabilities {
  runState: boolean;       // run 态订阅 + 停止按钮（前端据此给 useRunState/useSummary 过 enabled 门）
  hitl: boolean;           // 提问卡 + 审批卡透传
  enqueue: boolean;        // 排队区
  effortPicker: boolean;
  approvalPicker: boolean;
  usage: boolean;          // usage 三件套
  compact: boolean;        // CompactBtn
  clear: boolean;          // ClearBtn + 清空 modal
  minimap: boolean;        // 历史 query minimap
  floatMenu: boolean;      // 右上悬浮菜单
  cron: boolean;           // 悬浮菜单内定时任务项（false = hideCron）
  groupRender: boolean;    // 群聊渲染策略（白名单 filter + a2a actor + 窄输入区）
}
```

| kind | 值（相对「全开」的差异） |
|---|---|
| playground / studio_member / academy_head / academy_coach / academy_student | **全开**，`groupRender=false`（academy 全开 = 用户拍板 2026-07-29） |
| studio_group | `runState=false, enqueue=false, effortPicker=false, approvalPicker=false, cron=false, groupRender=true`（v0.0.152 裁决保持：群聊不放两 picker、无 stop）；其余 true |

`readOnly=true` 时前端整体隐藏输入侧（HITL/stop/picker/enqueue 不适用）并隐藏 ClearBtn，保留 usage+Compact——readOnly 是**覆盖层**，capabilities 表不为 subagent 单列。

## 5. 与既有端点的关系

- **只读聚合**：本端点纯读（session + squad/classroom + app_config），无副作用、无状态机交互。
- **写路径不变**：model/effort/approvalMode 修改仍 `PUT /session/:id`（04 §2）；chrome 无 PUT。
- **运行中可改 + 下轮生效**（v0.0.351）：session 运行中输入区三件套（sessionModel/effort/approvalMode）可编辑，PUT 落库后由 main run 每轮 iteration 边界 `refreshRuntimeConfig` 重读 session 最新值生效（`loop-runtime-config.ts`；旁路 run 保持启动快照）。
- **取代的前端拼装**：`GET /session` + `GET /squad/:id` 两跳（旧 useStudioChatChrome）、academy 前端透传 classroom.defaultModel、playground useModelRestore 的 GET /session 回填——统一收敛为本端点一跳。
- **测试**：确定性 HTTP 契约 → UT 覆盖（不进 AT，冒烟集铁律）。

## 6. 错误码

| 状态 | 场景 |
|---|---|
| 200 | 正常（含数据源降级：defaultModel/members 为 null/[]） |
| 404 | session 不存在 |
| 405 | 非 GET（Allow: GET） |
