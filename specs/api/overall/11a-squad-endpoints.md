# Squad / Member / Charter 端点契约（v0.0.33.1 — 11-squad.md 姊妹文件）

> version: 1.12 · 引入版本 v0.0.33.1 · **[v0.0.89 modified]** 加 `summaryModelDefault` · **[v0.0.113 modified]** Member.skills→skillConfig overlay · **[v0.0.116 modified]** squad 级心跳（PATCH /squad 加 heartbeatConfig，废弃 PATCH /member/:mid/heartbeat）+ Member.currentWork presence · **[v0.0.142 modified]** Member + PatchMemberBody 加 `workStyle`（可空/空串=清空/无 400；hire 不含；仅用户可编辑）· **[v0.0.158 modified]** 删「独立 summary 模型」层——`summaryModelDefault` + `summaryModelDefaultProviderId` 两字段整删（Schema + POST/PATCH body + GET 响应 + 校验规则）· **[v0.0.169 modified]** hire（§2.1）扩 `workStyle?`（fresh 直传 trim 回写/空串=空串/无 400；derive 默认复制父 + `overrides.workStyle` 覆盖，空串=清空——对齐 §2.2 v0.0.142 语义）· **[v0.0.192.delete_cleanup modified]** §1.5 `DELETE /squad/:id` 行为修订——step② `listSessionsBySquad` 按 squadId 平铺快照全量 squad session（含 spawn children）；step④ 改 `deleteSquadAdministrativeSubpaths`（只删管理性子路径），**保留 workspaces/outputs/reports 工作产出** · **[v0.0.210 modified]** §2.1 hire body 加 `mode: 'derive_academy'`（从教室学生版本派生；academySource 三字段；tech `specs/tech/academy/[P1]squad_derive.md`）· **[v0.0.233 modified]** §2.1 derive_academy 分支加 `resolution?`（同名裁决：默认全 skip 同名 + 用户逐项改 overwrite + 不同名 merge）+ §2.5 新增 `POST /squad/:id/member/derive-academy/preview`（派生前预检，纯只读返 PreviewResult）—— tech 权威 `specs/tech/academy/[P1]derive_preview_conflict.md` · **[v0.0.237 removed]** §3 Charter 整组端点（GET/PUT/GET history `/squad/:id/charter*`）+ `/squad/:id/board/*` 全套 board endpoint（后者曾在 11b-squad-workitems.md，已随 board 全链路删）+ squad.charter schema 字段 + charter_history entity 整体退役——AT 不可 curl，§3 细节保留作历史契约 · **[v0.0.250 modified]** §1.3 Member + §2.1 HireMemberBody derive 分支 + step 删 `inheritMemory`（dead：声明「派生复制父记忆」从未落地；memory 已 v0.0.232 团队盘 `.rocky/memory/` 全队共享，无复制语义）+ §2.1 step 列表加 7.5（derive 复制父成员个人 AGENTS.md，父无/失败 → 静默 no-op 不回滚）· **[v0.0.270 modified]** §1.3 SquadDetail + §1.4 PatchSquadBody 加 `enableGroupChat`（群聊可见性：回显 ?? true / PATCH !== undefined 才改）· **[v0.0.279 modified]** §1.3 SquadDetail + §1.4 PatchSquadBody 加 `effortDefault`（团队默认推理强度：回显 ?? 'default' / PATCH !== undefined 才改，显式 'default' 也落盘不清空 / 非法值 400 先于 404）· **[v0.0.305 modified]** §1.2 SquadSummary +3 optional 聚合字段（onlineCount/inProgressCount/lastActiveAt，GET /squad 列表批量聚合）+ §4.5 新增 `squad_meta` SSE topic 契约（SquadMetaBroadcaster 触发 + 前端 useSquadMeta 消费）· **[v0.0.319 modified]** 新增 §5 团队同步端点（`GET /squad/:id/export` 导出 zip + `POST /squad/import?step=preview|execute` 两阶段导入建队）—— tech 权威 `specs/tech/version_logs/v0.0.319/change_plan.md`
> 管什么：v0.0.33.1 squad/member 两组管理端点的**完整端点契约**（payload / 响应 / 行为 / 错误码）——§1 Squad CRUD + §2 Member 管理（§3 Charter 组已于 v0.0.237 移除，详见该章节头）。
> 不管什么：session schema 增量字段 + bizType 隔离 + 占位 chat 403 + SSE 策略 + AT 映射 + 文件清单（→ `11-squad.md`）；agent loop / chat 真实跑（→ v0.0.33.2）。
> **本文件是 AT（API Test）squad/member/charter 端点的唯一依据**：api-verifier 黑盒 curl，不读代码。
>
> **权威概念源**：`specs/tech/squad/[P1]data_model.md` + `[P1]squad_definition.md` + `states/v0.0.33.1/design.md`。
>
> **[v0.0.158 modified] `summaryModelDefault` 字段族整删**：`POST /squad` / `PATCH /squad/:id` body 移除 `summaryModelDefault?` + `summaryModelDefaultProviderId?`；`GET /squad/:id` SquadDetail 响应移除两字段；`createSquadService` 校验/归一化/落盘分支同步删。**兼容层**：旧 client body 传字段被静默忽略（不进 handler validation、不落库、不返 400；schema `validateRecord` 不拒 extra 字段，migration handler `clean-squad-summary-model-default` 会清理存量 record 的字段残留）。**背景**：v0.0.89 引入的「独立 summary 模型」层在 v0.0.158 退役——chat / 手动 compact / 自动 compact / T1 记忆整理全部走同一入口 `agentManager.resolveConfigBySid(sid)`（studio 场景统一读 `squad.modelDefault`）。技术权威 `specs/tech/agent/providers_and_models/[P0]model_resolve.md §3/§4 原则 6`。历史（v0.0.89-0.0.157）：见 `specs/api/version_logs/v0.0.89/change_log.md §2`。

## 1. Squad CRUD（§B）

### 1.1 `POST /squad` — 建 squad（事务性）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/squad` | 建 squad（事务：squad + leader member + leader session + 群聊 session + 目录骨架），含补偿回滚 | `CreateSquadBody` | `201` + `SquadDetail` |

```typescript
interface CreateSquadBody {
  name: string;                  // required
  description?: string;
  modelDefault: string;          // ModelRef
  // [v0.0.158] summaryModelDefault + summaryModelDefaultProviderId 两字段已整删（兼容层：旧 client 传字段被静默忽略）
  leader: {
    name: string;                // leader member 名（squad 内唯一）
    systemPrompt?: string;       // [v0.0.33.3] accept-and-ignore（兼容旧 payload，不存储；身份走 squad_role fragment）
  };
  charter?: {                    // 4 字段均可空，缺省空串
    goals?: string;
    workingStyle?: string;
    collaboration?: string;
    escalation?: string;
  };
}
```

**行为**（事务 8 步 + 补偿回滚，详见 `data_model.md §4 createSquadService`）：
1. 生成 squadId + 建 squad record（charter embedded，memberIds=[]，leaderId 暂空，enableHeartBeat=false，[v0.0.116] heartbeatConfig=null=默认）。
2. 建 leader member（role=leader, state=deployed, squadId）。
3. 建 leader session（role=leader, biz=studio, squadId, memberId, parentSessionId=null）。**leader session 的 `modelId` 缺省不传**（不从 body 直接派生 leader session 模型；session record 存 `modelId='default'` 保留字或 undefined），运行时经 `agentManager.resolveConfigBySid(sid)` 走 model resolve fallback 链：`session.modelId → squad.modelDefault`（v0.0.158 chat/compact 同链，见 `specs/tech/agent/providers_and_models/[P0]model_resolve.md §3` 第 2 行 studio 链）。故建队时 body.modelDefault 是权威源（squad 未设 modelDefault → 400），leader session 无需独立配置。
4. 回填 member.sessionId + squad.leaderId。
5. 建 squadChat session（role=squad, biz=studio, squadId, parentSessionId=null）。
6. 回填 squad.squadChatSessionId + append squad.memberIds=[leaderId]。
7. 建目录骨架（squads/{squadId}/{members,charter_history,board,outputs,reports/{daily,tasks,goals},workspaces/{leaderMemberId},.rocky/state}）+ `[v0.0.33.3]` OKF md skeleton（index/log/charter.md + board/{goals,krs,requirements,tasks}/）。
8. 任一步失败 → 补偿删除已建 record + 目录（反向顺序，best-effort）。

> **一致性由 service 保证**：建完 member.sessionId + session.memberId 双向；squad.leaderId + member.squadId 双向；session.squadId 单向；squad.memberIds 含 leaderId。

**错误**：`400` name/leader.name/modelDefault 缺 / **`modelDefault` 非某已启用 provider 的合法 enabled modelId（[v0.0.36] 写入校验，见 `services/model-validation.ts`）** / body 非法 JSON；`500` 事务失败（已补偿回滚，返错误原因）。

### 1.2 `GET /squad` — squad 列表

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/squad` | 列出所有 squad（按 `updatedAt` desc） | `200` + `{ items: SquadSummary[] }` |

```typescript
interface SquadSummary {
  id: string;
  name: string;
  description: string;
  modelDefault: string;
  leaderId: string;
  memberCount: number;            // = memberIds.length
  squadChatSessionId: string;
  enableHeartBeat: boolean;       // [v0.0.33.4] 实跑（scheduler killswitch，每 tick 轮询生效）
  createdAt: string;
  updatedAt: string;
  // [v0.0.305] 聚合视图 3 字段（全部 optional，向后兼容旧前端）：
  onlineCount?: number;           // 在线成员数 = member.state==='deployed' 数（与 seats onlineCount 同口径）
  inProgressCount?: number;       // 工作中数 = squadChat + members 直连 session state∈{running,interrupting,suspended} 数（与 seats inProgressCount 同口径）
  lastActiveAt?: string;          // 成员最后会话时间 = max(直连 session.updatedAt)；集合空 → squad.updatedAt（恒有值可排序）
}
```

> **`[v0.0.305]` 聚合字段口径**（与 seats 面板完全一致，统一数据源不各自算各自）：
> - `onlineCount` = `members.filter(m => m.state === 'deployed').length`
> - `inProgressCount` = 遍历 `[squadChatSessionId, ...members[].sessionId]` 直连 session 集合，数 `state ∈ {running, interrupting, suspended}`（**不含 subagent 派生会话**——spawn children 也带 squadId 但不在直连集合，避免多算）
> - `lastActiveAt` = 上述直连 session 集合 `updatedAt` 最大值；集合空 → `squad.updatedAt`
> - 计算收敛为后端单一聚合服务 `squad-aggregate-service`（GET 列表 + SSE 推送共用，技术权威 `specs/tech/squad/[P1]squad_aggregate.md`）

> **分页**：本版不分页（design.md §6.5 待定，squad 数量预期小）。后续可加 `cursor/limit` query。

### 1.3 `GET /squad/:id` — squad 详情

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/squad/:id` | squad 完整详情（含 members + charter + 各 sessionId） | `200` + `SquadDetail` |

```typescript
interface SquadDetail {
  id: string;
  name: string;
  description: string;
  modelDefault: string;
  // [v0.0.279] 团队默认推理强度（canonical 语义键 4 档 'default'|'low'|'high'|'max'；存量无字段回显 ?? 'default'——UI 下拉恒有值）
  effortDefault: 'default' | 'low' | 'high' | 'max';
  // [v0.0.158] summaryModelDefault 字段整删（响应不再回显；旧前端读为 undefined 兼容）
  leaderId: string;
  memberIds: string[];
  members: Member[];              // 完整 member records（含 leader）
  squadChatSessionId: string;
  charter: Charter;               // embedded 4 字段
  budget: { limit: number; window: "daily"; scope: "team" } | null;  // [v0.0.116] null=off=不限量；非null=on=限量
  enableHeartBeat: boolean;       // [v0.0.33.4] 实跑（scheduler killswitch，总开关）
  enableGroupChat: boolean;       // [v0.0.270] 群聊可见性（true=注入 SquadChat + UI 入口可见；false=两者隐藏；存量无字段回显 ?? true=开）；**[v0.0.340] 新建团队默认 false=关**（POST /squad 响应回显 false；PATCH toggle 可改）
  timezone?: string;              // [v0.0.33.4] IANA tz（如 "Asia/Shanghai"），activeWindows + daily 回血窗口都跟它；缺省 user local
  heartbeatConfig: {              // [v0.0.116] squad 级统一心跳配置（null=未配=默认 interval=15/全天/all）
    interval: number;             // 5|15|30|60，默认 15
    activeWindows: Array<{ start: string; end: string }>;  // 多段（空=全天）
    scope: { mode: "all" | "whitelist"; memberIds: string[] };
  } | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface Member {
  id: string;
  squadId: string;
  sessionId: string;              // → session（双向）
  name: string;
  intro?: string;                 // 一句话介绍（渲染进 Team Roster；fresh 必填/leader 固定模板/derive 继承父）；旧 member 可能缺省
  workStyle?: string;             // [v0.0.142] 工作方式（仅注入该成员自己个人 session prompt，不进 Team Roster；仅用户可编辑，PATCH member）；旧 member 缺省
  role: "leader" | "mate";
  // [v0.0.33.3] systemPrompt 字段已移除（身份由 squad_role mapper + fragment 组装，不落库；prompt_sections §7）
  // [v0.0.48] **tools 字段 deprecated/dead**：leader/mate 工具集改 static-by-type（查 tool-policy.ts，
  //   leader=15 / mate=15）；entity 字段保留避免 migrate，但不再被读取。响应中仍可能返回旧值（兼容历史
  //   record），UI/调用方不应再消费。详见 `specs/tech/squad/[P1]data_model.md §1.2`。
  tools: string[];                // [v0.0.48] dead（保留 entity 字段，不再被读取）
  // [v0.0.113] skills 白名单推翻重写为 skillConfig overlay（不兼容旧数据）。旧 record 无 skillConfig
  //   → 视为默认 inherit（前端兜底）。resolve 语义见 tech `[P1]session_config_studio.md §3.2`。
  skillConfig: { mode: "inherit" | "custom"; overrides: Record<string, boolean> };
  model: string;                  // ModelRef，缺省 = squad.modelDefault
  state: "deployed" | "benched";
  benchReason?: string;
  benchedAt?: string;
  currentWork: { text: string; updatedAt: string } | null;  // [v0.0.116] presence 当前工作标记（presence 工具 set/clear；进 leader team-status）；旧 record 可能缺
  heartbeat: { activeWindow: { start: string; end: string }; interval: number } | null;  // [v0.0.116] **dead**：per-member 心跳废弃（升级 squad.heartbeatConfig）；响应可能返旧值，UI 不应消费
  deriveFrom?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface Charter {
  goals: string;
  workingStyle: string;
  collaboration: string;
  escalation: string;
}
```

**错误**：`404` squad 不存在。

### 1.4 `PATCH /squad/:id` — 改 squad 元信息（`[v0.0.33.4]` autonomy/budget/timezone 字段生效）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `PATCH` | `/squad/:id` | 改 name/description/modelDefault；`[v0.0.33.4]` **enableHeartBeat / budget / timezone 真生效**（写后 `scheduler.reloadSquad()`）；`[v0.0.270]` **enableGroupChat**（群聊可见性） | `PatchSquadBody` | `200` + `SquadDetail`（必含 enableHeartBeat / budget / timezone / enableGroupChat 字段回显） |

```typescript
interface PatchSquadBody {
  name?: string;
  description?: string;
  modelDefault?: string;
  // [v0.0.279] 团队默认推理强度（canonical 语义键 4 档）。undefined=不修改；显式 'default' 也落盘（不清空，与 enableGroupChat 模式对称）；非法值 → 400（字段级，先于 404）
  effortDefault?: 'default' | 'low' | 'high' | 'max';
  // [v0.0.158] summaryModelDefault + summaryModelDefaultProviderId 两字段已整删（兼容层：旧 client 传字段被静默忽略，不返 400 / 不落库）
  // [v0.0.33.4] 以下字段本版生效（v0.0.33.1 仅占位存）：
  enableHeartBeat?: boolean;        // killswitch，toggle 后 ≤1s 生效（scheduler 每 tick 轮询）
  enableGroupChat?: boolean;        // [v0.0.270] 群聊可见性：false=隐藏（agents 注入 SquadChat + UI 入口 + send_message('squadchat') 门控）；true/缺省=开。undefined=不修改（对齐 enableHeartBeat 模式）
  budget?: { limit: number; window: "daily"; scope: "team" } | null;  // [v0.0.116] null=off=不限量；非null=on=限量（limit token/天）
  timezone?: string;                // IANA tz，默认 user local；activeWindows + daily 回血都跟它
  // [v0.0.116] squad 级统一心跳配置（替代废弃的 PATCH /member/:mid/heartbeat）：
  heartbeatConfig?: {
    interval: 5 | 15 | 30 | 60;     // 分钟，默认 15
    activeWindows: Array<{ start: string; end: string }>;  // "HH:mm" 24h；段间不重叠 + 单段 start<end（不跨0点）；空数组=全天
    scope: { mode: "all" | "whitelist"; memberIds: string[] };  // all=全员/whitelist=白名单
  } | null;                          // null=清空（回退默认 interval=15/全天/all）；undefined=不修改
}
```

**`[v0.0.33.4]` 行为变更**（v0.0.33.1 占位 → 本版生效）：
- 写 `enableHeartBeat` → scheduler killswitch 即时（下一 tick ≤1s 读到新值，不依赖 reloadSquad）。
- 写 `budget` → budget-aggregator 即时用新 limit（null=跳过 gate）。
- 写 `timezone` → activeWindow 判定 + daily 窗口分桶即时切新 tz。
- 三字段均触发 `scheduler.reloadSquad()`（主要刷 budget/timezone 缓存；killswitch 本就每 tick 轮询）。
- **[v0.0.116] 写 `heartbeatConfig`** → `scheduler.reloadSquad()` 重建 squad heartbeat job（新 interval/activeWindows/scope/tz 实时生效；取代废弃的 `PATCH /member/:mid/heartbeat` + reloadRole）。
- **SquadDetail 完整回显**：响应必含 `enableHeartBeat` / `budget`（含 null 未配）/ `timezone` / **`heartbeatConfig`（含 null）** / **[v0.0.270] `enableGroupChat`** / **[v0.0.279] `effortDefault`** 字段（GET /squad/:id 同样回显），前端据此回显 UI 状态。**[v0.0.270] enableGroupChat 回显 `?? true` 兜底**（存量 squad 无字段=开，与 reachable 注入 `!== false` 语义一致）；`!== undefined` 才 patch（不误改旧 squad 其他字段）。**[v0.0.279] effortDefault 回显 `?? 'default'` 兜底**（存量 squad 无字段=厂商默认档）；`!== undefined` 才 patch，显式 `'default'` 也落盘（不清空，与 enableGroupChat 模式对称）。

**错误**：`400` body 非法 / timezone 非 IANA / budget.limit<0 / **[v0.0.116] heartbeatConfig.activeWindows 段间重叠 或 单段 start>=end（跨0点）或格式错 / interval 非 5\|15\|30\|60 / scope.mode 非法** / **[v0.0.279] effortDefault 非 'default'\|'low'\|'high'\|'max'（字段级校验，先于 404）**；`404` squad 不存在。

### 1.5 `DELETE /squad/:id` — team 硬删除（解散，`[v0.0.111]` 新增；`[v0.0.192.delete_cleanup]` 保留工作产出 + 级联删子孙）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `DELETE` | `/squad/:id` | 硬删除（解散）整个 team：teardown 停调度 → 按 squadId 平铺删全量 session（含 spawn children）→ 删 record → 删办公室**管理性子路径**（保留工作产出） | 无 | `200` + `{ deleted: true }` |

**行为**（编排见 `specs/tech/squad/[P1]data_model.md §1.1` + `squad-dissolve.ts`；顺序不可颠倒）：
1. 校验 squad 存在 → 不存在 `404 squad not found`。
2. `store.listSessionsBySquad(id)` 平铺快照全部 squad session（按 `Session.squadId` 字段扫全量 crud，catch 含 spawn children 在内的任意深度派生 session）。
3. `squadRuntime.disposeSquad(id)` — per-squad 运行时 teardown（abort 在跑 loop + 注销 heartbeat jobs + 清 per-squad 状态；**先于删数据防潜伏调度**，`[P1]scheduler.md §9`）。
4. **逐个** `deleteSession(sid)`（快照的全部 squad session）：每个都级联 rm `sessions/{sid}/`（含 cron.json）+ 触发 `onSessionDestroyed` → 该 session 的内存 cron job 在 engine 中注销（堵「删 parent 后 child cron 继续烧 token」的潜伏调度漏洞，`[P1]cron_subsystem.md §8`）。
5. `deleteSquad(id)` 删 squad record。
6. `deleteSquadAdministrativeSubpaths(dataDir, id)` 删办公室**管理性子路径**：`members/` `charter_history/` `panorama/` `.rocky/` 四目录 + `charter.md` `index.md` `log.md` 三文件（均 force:true 幂等，缺失不报错）。

**保留工作产出（用户裁决 2026-07-23）**：`workspaces/` `outputs/` `reports/` `board/` 四类**用户可读工作产出原地保留**（可查可回收，详 `specs/tech/squad/[P1]squad_workspace.md §7`）。判据：用户看得懂的产出留 / 程序才懂的内部数据删。

> **不可逆硬删（管理性数据）**：member session + 历史消息 + 调度状态 + member 档案 + charter 历史**物理清除**，**不留回收站/软归档/潜伏调度**（用户 2026-07-10 确认）。但工作产出（workspaces/outputs/reports/board）原地保留供用户查阅——解散不等于一键清空工作成果。AT 用临时 squad 验证，勿删真实数据。

**错误**：`404` squad 不存在。

> **无 member DELETE**：member 仍不可删（bench 兜底，§2.4），仅 team 整体可硬删。

## 2. Member 管理（§C，squad 内）

> **[v0.0.128]** tool 层接入 hire/deploy/bench/edit（`team` 工具扩 4 action），HTTP 端点/payload/status 全保留不变——业务逻辑抽共享 service `member-mutations.ts`，HTTP handler 改 thin wrapper 调同一 service（三路同源，`squad index.md ④#18`）。`member.lastWriteMessageId` 新增（agent tool 写时填，HTTP 不传）。

### 2.1 `POST /squad/:id/member` — hire member（fresh / derive）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/squad/:id/member` | hire（fresh 填新字段 / derive 从父 member 复制 + overrides）→ 建 member + mate session + workspace | `HireMemberBody` | `201` + `{ member: Member, sessionId: string }` |

```typescript
type MemberSkillConfig = { mode: "inherit" | "custom"; overrides: Record<string, boolean> };
type DeriveResolution = {
  skills?: Array<{ name: string; action: "skip" | "overwrite" }>;
  memory?: Array<{ name: string; action: "skip" | "overwrite" }>;
};
type HireMemberBody =
  | { mode: "fresh"; name: string; intro: string; workStyle?: string; skillConfig?: MemberSkillConfig; model?: string }
  | { mode: "derive"; deriveFrom: string; overrides?: {
      name?: string; intro?: string; workStyle?: string; skillConfig?: MemberSkillConfig; model?: string;
    } }
  | {
      mode: "derive_academy";                       // [v0.0.210] 从教室学生 formal+active 版本派生
      name: string;                                  // 必填（squad 内 member 名）
      intro?: string; workStyle?: string; skillConfig?: MemberSkillConfig;
      academySource: { classroomId: string; studentId: string; versionId: string };  // 三字段必填
      resolution?: DeriveResolution;                 // [v0.0.233] 同名裁决结果（undefined = 默认全 skip 同名 + 不同名 merge）
    };
// [v0.0.233] derive_academy resolution 字段（同名裁决，tech `specs/tech/academy/[P1]derive_preview_conflict.md §3`）：
//   - resolution.skills/memory = per-item 全清单（{name, action:'skip'|'overwrite'}），由前端预览面板同名项 toggle 产出
//   - action 闭合枚举（不引入其他值）；未在 resolution 列出 + 同名 → 默认 skip；未列出 + 不同名 → 默认 merge
//   - undefined = 默认全 skip 同名（向后兼容，旧 client 不传 → 安全默认）
//   - 派生前预检走独立 endpoint（§2.5 POST /squad/:id/member/derive-academy/preview）拉 PreviewResult 喂预览面板
// [v0.0.169] workStyle 扩展（对齐 §2.2 PATCH 语义）：
//   fresh：workStyle? 直传，trim() 后回写；可空——提供空串 = 回写空串（无 400，区别 intro）；不传 = 缺省无 workStyle。
//   derive：默认复制父 member workStyle；overrides.workStyle 覆盖（trim 后回写，空串 = 清空回写空串）。
//   workStyle 仅用户面可写（HTTP hire/PATCH 编辑面板）；agent `team` 工具不暴露（team.hire 服务端剔除 overrides.workStyle）。
// [v0.0.114] fresh 加 **必填** intro（一句话介绍，渲染进 Team Roster）：空/缺 → 400 `intro required`。
//   derive overrides.intro 可选（不传则继承父 intro）。前端 HireModal fresh 表单用 intro input
//   （systemPrompt 从 hire body 移除，后端 seed；旧 client 若仍传 systemPrompt/tools，为未知字段静默丢弃，向后兼容）。
// [v0.0.113] skills?: string[] → skillConfig?（缺省 = {mode:'inherit',overrides:{}}，后端 seed）。
//   overlay 容忍未知 name，skillConfig 不做 catalog 命中校验。
// [v0.0.33.3] systemPrompt 一律 accept-and-ignore（不存储；身份走 squad_role fragment）
// [v0.0.48] **tools 字段 accept-and-ignore（dead）**：leader/mate 工具集改 static-by-type 查
//   tool-policy.ts（leader=15 / mate=15），不再由 caller 配置。hireBody 仍声明 `tools?` 字段向后兼容
//   （旧 client 传不报错），但 member.tools 不再写盘/读取；行为上等同于「请求带 tools 字段会被忽略并 warn」。
//   详见 `specs/tech/squad/[P1]data_model.md §1.2` + PRD §3.4。
```

**行为**（事务 8 步 + 补偿回滚，详见 `data_model.md §5 createMemberService`）：
1. resolve effective 配置（fresh 直用 / derive 从父 member 复制 + overrides 覆盖；**[v0.0.169]** workStyle 同此规则——fresh 直用 / derive 复制父 + overrides 覆盖）。
2. 校验 name 在 squad 内唯一（a2a 寻址要求，`squad_definition.md §3`）。
3. 建 member record（role=mate, state=deployed, squadId, deriveFrom 一次性记）。
4. 建 member session（role=mate, biz=studio, squadId, memberId, parentSessionId=null）。
5. 回填 member.sessionId。
6. append squad.memberIds。
7. 建 workspace 目录（squads/{squadId}/workspaces/{memberId}/）；derive_academy 在此 step7 内 seed（AGENTS.md→个人差异文件、skills/memory→团队盘）。
7.5. **derive（非 academy）**：复制父成员个人差异 AGENTS.md（`.rocky/agents/{父name}-{父id}.md` → `.rocky/agents/{子name}-{子id}.md`，路径字面拼）；父成员无个人 AGENTS.md 或复制失败 → 静默 no-op（**不触发事务回滚**，子成员继续用团队级 AGENTS.md 兜底）。
8. 任一步失败 → 补偿回滚（反向顺序）。

> **derive 后两 member 完全独立**——无后续联动（仅 hire 时一次性复制配置 + 个人 AGENTS.md）。memory 在 squad 内是团队盘共享（`.rocky/memory/` 全队可读），不存在「派生复制父记忆」语义。mate 不可改 role 为 leader（leader 是建队时唯一确定的）。

**错误**：`400` mode 缺 / fresh 缺 name / **fresh 缺 intro（`intro required`）** / derive 缺 deriveFrom / **derive_academy 缺 name / academySource 三字段任一缺（`invalid_academy_source`）/ version 非 formal+active / classroom 不存在（`invalid_academy_source`）**；`409` name 在 squad 内重复（`member_name_conflict`）；`404` squad 不存在 / deriveFrom 指向不存在的 member。

> `[v0.0.210]` **derive_academy mode** —— 从教室学生 formal+active 版本派生（squad_derive §2）：hire body 加 `mode: 'derive_academy'` + `academySource: {classroomId, studentId, versionId}`（三字段必填，versionId 必须 formal + active；process 版本 = 训练临时区不可派生）；与 deriveFrom 互斥。step7 追加 `seedMemberWorkspaceFromVersion`：学生 `AGENTS.md` → `squads/{sid}/.rocky/agents/{name}-{memberId}.md`（member 私有个人差异）；学生 `.rocky/skills` / `.rocky/memory` → `squads/{sid}/.rocky/{skills,memory}`（团队盘，全队共享——v0.0.232 重映射后落点）。

> `[v0.0.233]` **derive_academy 加 resolution 字段（同名裁决）** —— 把「一次性自动 copy + 同名覆盖」升级为「预检 → 同名裁决 → 执行」：hire body 加可选 `resolution: { skills?, memory? }`（per-item `{name, action: 'skip'|'overwrite'}`），同名项默认 skip（保留 squad 原有）、用户可逐项改 overwrite、不同名直接 merge；`resolution` undefined = 默认全 skip 同名（向后兼容）。派生前预检走独立 endpoint（§2.5）拉 PreviewResult。技术权威 `specs/tech/academy/[P1]derive_preview_conflict.md`；补偿安全不变量（written 只记本次写入项 / 永不删团队根目录）见该文件 §4。

> `[v0.0.33.1 doc-fix]` name 冲突错误码从 `400` 改 `409 member_name_conflict`（与 §6 错误码汇总 + 实现 + AT case 对齐；409 Conflict 语义正确，spec 旧文 `400` 是笔误）。

### 2.2 `PATCH /squad/:id/member/:mid` — edit member

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `PATCH` | `/squad/:id/member/:mid` | edit member 可变字段（不含 state，state 走 deploy/bench 端点） | `PatchMemberBody` | `200` + `{ member: Member }` |

```typescript
interface PatchMemberBody {
  name?: string;                  // 改名仍需 squad 内唯一
  intro?: string;                 // [v0.0.114] 一句话介绍（渲染进 Team Roster）；提供但 trim 后为空 → 400 intro required
  workStyle?: string;             // [v0.0.142] 工作方式（trim 后回写）；**可空**——提供空串 = 清空回写空串（无 400 校验，区别 intro）；不传不影响其他字段
  tools?: string[];
  skillConfig?: MemberSkillConfig; // [v0.0.113] 整体替换 overlay 快照（含 mode 切换 + overrides）；后端不合并旧快照。off 存 → overrides={} (R6)；custom 存 → overrides 为前端补齐的全量快照 (R5)
  model?: string;                  // [v0.0.113] 字段保留：member.model 数据仍经此 PATCH 落盘——但 edit-member 面板不再有 model 编辑 UI（已删），改由对话界面 InputModelPicker 编辑（onChange→patchMember）。「删 model」= 删面板 UI，非删数据字段/接口
  heartbeat?: object | null;      // [v0.0.116] **dead（accept-and-ignore + warn）**：per-member 心跳废弃（升级 squad.heartbeatConfig）。PATCH 带 heartbeat 被 handler 忽略并 warn（不写盘、不返 400，向后兼容，同 v0.0.48 tools 先例）。心跳配置改走 PATCH /squad heartbeatConfig（§1.4）
}
```

> `[v0.0.114]` **`intro` 可编辑**——PATCH body 带 `intro` 即更新该成员一句话介绍（`trim()` 后落库）。校验与创建口径一致：提供 `intro` 但 `trim()` 后为空 → `400 intro required`；不传 `intro` 不影响其他字段。旧 member（无 intro）可经此补填。前端在成员管理面板（`member-intro-input`）编辑。

> `[v0.0.340]` **改名写时全同步**——PATCH body 带 `name` 时 `patchMemberService` 在 `putMember` 成功后**同步关联 session.title**（该成员 session）：判据 = 改名发生 || 关联 title !== patch.name（覆盖「上次部分失败后重试」）；仅 `session.titled !== true` 的默认标题被同步（titled=true = AI 起名/用户自定义，**不覆盖**）；`updateSession` 只传 `{ title }` 不传 `titled`（保留 existing 值，CAS 语义不破坏）；同步失败抛错透传（部分失败可见、重试可修复——「改彻底 + 诚实上报」老板原则）。**读侧配套**（[v0.0.340 决策 1]）：信封 targetName / in 信封 sender 名 / 系统提示 selfName 统一从 memberStore 反查实时成员名（`session.squadId+memberId → MemberStore.getMember`），session.title 只保留「会话标题」语义——改名后信封显示新名，无需刷新/重进。

> `[v0.0.142]` **`workStyle` 可编辑 + 可清空**——PATCH body 带 `workStyle` 即更新该成员工作方式（`trim()` 后落库）。**与 intro 关键区别 = 可空无校验**：提供空串 `""` → **清空回写空串（无 `400`）**，不传不影响其他字段。**[v0.0.169] 起 workStyle 两面可写**：`PATCH /squad/:id/member/:mid`（用户编辑面板 `member-workstyle-input`）+ **hire（§2.1）**（fresh 直传 / derive 复制父 + `overrides.workStyle` 覆盖，语义同本条）；**agent `team` 工具仍不暴露 workStyle**（`team.edit` 服务端显式剔除 + `team.hire` 剔除 `overrides.workStyle`，`specs/tech/squad/[P1]squad_tools.md §2`）。workStyle 仅注入该成员自己个人 session 的 prompt（tech `[P1]prompt_sections.md §3.1`），不进 Team Roster。

> `[v0.0.33.3 req6]` **移除 `systemPrompt` 字段**——req6 将 `member.systemPrompt` 从 schema 删除（身份由 squad_role mapper + fragment 组装，不落库）。PATCH 传 `systemPrompt` 被静默忽略（不存储、不出现在响应 `Member`）。可变字段收敛为 `name / intro / skillConfig / model`（**[v0.0.113]** `skills`→`skillConfig` overlay；**[v0.0.114]** 加 `intro`；**[v0.0.116]** `heartbeat` 转 dead accept-and-ignore，`tools` 自 v0.0.48 起即 dead）。

> `[v0.0.48]` **`tools` 字段 dead（accept-and-ignore）**——leader/mate 工具集改 static-by-type 查 `tool-policy.ts:TOOL_POLICY['studio-leader'|'studio-mate'].bound`（leader=15 / mate=15），不再由 caller 配置。PATCH 传 `tools` 字段会被**忽略并 warn**（不返 400，向后兼容；不写盘、不影响响应 Member.tools 的旧值）。**hireBody §2.1 同**：仍声明 `tools?` 兼容旧 client，但行为 dead。可变字段实际收敛为 `name / skillConfig / model / heartbeat(占位)`（**[v0.0.113]** `skills`→`skillConfig`）。详见 `specs/tech/squad/[P1]data_model.md §1.2` + PRD §3.4。

> **不可改字段**：role / state / squadId / sessionId / deriveFrom（建 member 时一次性定）。

**错误**：`400` body 非法 / **提供 intro 但 trim 后为空（`intro required`）**；`409` name 与同 squad 其他 member 重复（`member_name_conflict`，改名仍需 squad 内唯一）；`404` squad/member 不存在 / member 不属于该 squad。

> `[v0.0.33.1 doc-fix]` PATCH 响应 shape 从 `200 + Member` 改 `200 + { member: Member }`（与 §2.1 hire / §2.3 deploy / §2.4 bench 一致 wrap，实现+AT 用 wrap shape；spec 旧文直返 `Member` 是笔误）。

### 2.3 `POST /squad/:id/member/:mid/deploy` — deploy（恢复 deployed）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/squad/:id/member/:mid/deploy` | state: benched → deployed（清 benchReason/benchedAt） | 无 | `200` + `{ member: Member }` |

**幂等**：已是 deployed → 200 no-op（不发事件）。

**错误**：`404` squad/member 不存在。

### 2.4 `POST /squad/:id/member/:mid/bench` — bench（leader 不可 bench）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/squad/:id/member/:mid/bench` | state: deployed → benched + 填 benchReason/benchedAt + 通知 user | `BenchBody` | `200` + `{ member: Member }` |

```typescript
interface BenchBody {
  reason: string;                 // 必填
}
```

**行为**：
1. 校验 member.role !== "leader"（leader 永远 deployed，`squad_definition.md §8`）→ 否则 `403 leader_not_benchable`。
2. state: deployed → benched + benchReason/benchedAt（ISO 8601）。
3. 通知 user（数据层落地，UI 形态 v1 最小可见反馈，design.md §6.1 待定）。

**错误**：`400` reason 缺 / 空串；`403` leader 不可 bench（`leader_not_benchable`）；`404` squad/member 不存在。

> **无 `DELETE /squad/:id/member/:mid`**——member 不可删（bench 兜底，无 fire；长期 bench = 离队，record 保留可审计，`squad_definition.md §8`）。

### 2.5 `POST /squad/:id/member/derive-academy/preview` — derive_academy 继承预检（v0.0.233 新增）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/squad/:id/member/derive-academy/preview` | derive_academy 派生前预检：读学生版本源 + squad 团队盘目标 → 列「将带入」清单 + 标同名项（纯只读无副作用） | `{ classroomId, studentId, versionId }` | `200` + `PreviewResult` |

```typescript
interface PreviewRequest {
  classroomId: string;    // 必填
  studentId: string;      // 必填（与 hire body academySource 同结构）
  versionId: string;      // 必填（必须 formal + active；process 版本不可派生）
}

interface PreviewResult {
  agentsMd: { exists: boolean };  // 学生 AGENTS.md 是否存在（0.0 空版本可能无；个人差异文件无同名概念）
  skills: Array<{ name: string; sameNameConflict: boolean }>;   // 源 .rocky/skills 顶层 entry 名 + 目标同名检测
  memory: Array<{ name: string; sameNameConflict: boolean }>;   // 源 .rocky/memory 顶层 entry 名 + 目标同名检测
}
```

**行为**（`specs/tech/academy/[P1]derive_preview_conflict.md §2`）：
1. 校验 squad 存在（`GET /squad/:id` 404 squad not found）。
2. `resolveAcademyDeriveIdentity` 校验三字段 + classroom 存在 + version formal+active（与 hire 同函数复用）→ 失败 throw `InvalidAcademySourceError` → 400 `invalid_academy_source`。
3. `version = academyStore.getVersion(classroomId, versionId)`；`sourceWorkspaceDir = version.workspaceDir`（INV-6 不可变真相源）。
4. 源侧枚举（`existsSync(AGENTS.md)` + `readdir(.rocky/skills)` + `readdir(.rocky/memory)`；源缺失 → 对应数组返空）。
5. 目标侧 = `squads/{squadId}/`：对每个源项 `existsSync(squadRoot/.rocky/{skills,memory}/<name>)` 检测同名。
6. 返回 `PreviewResult`（**纯只读，不写任何文件**）。

> **AGENTS.md 无 sameNameConflict 字段**：个人差异文件落 `.rocky/agents/{memberName}-{memberId}.md`（文件名带 memberId，天然无同名概念），预览仅返 `agentsMd.exists` 标「将带入」。

> **前端消费**：预览面板（`component-derive-academy-picker`）按 PreviewResult 渲染清单分组 + 同名项 amber 标 + 覆盖 toggle，用户裁决后产 `resolution` 传 hire body（§2.1）。

**错误**：`400` body 非法 / 三字段任一缺 / **version 非 formal+active / classroom 不存在（`invalid_academy_source`）**；`404` squad 不存在。

## 3. ~~Charter~~（§D，**`[v0.0.237 removed]`** — 整组端点退役）

> **整组移除**：`GET / PUT / GET history /squad/:id/charter*` 三端点 + `charter_history` entity + `CharterService`/`CharterHandler` + squad.charter schema 字段 + SquadDetail.charter 类型字段已于 v0.0.237 整体移除。AT **不可再 curl 这些端点**（返回 404）。下文细节保留作历史契约说明（v0.0.33.1-v0.0.236 期间有效）。

### 3.1 `GET /squad/:id/charter` — 读 charter

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/squad/:id/charter` | 读 charter 4 字段（embedded in squad record） | `200` + `Charter` |

**错误**：`404` squad 不存在。

### 3.2 `PUT /squad/:id/charter` — 改 charter（partial patch）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `PUT` | `/squad/:id/charter` | partial patch（4 字段子集）→ 更新 squad.charter + 写一条 charter_history | `PutCharterBody` | `200` + `{ charter: Charter, historyId: string }` |

```typescript
interface PutCharterBody {
  patch: {                        // partial（仅含本次变更字段）
    goals?: string;
    workingStyle?: string;
    collaboration?: string;
    escalation?: string;
  };
  reason: string;                 // 必填，变更原因（UI 编辑由用户填）
}
```

**行为**：
1. 校验 patch 非空 + reason 非空。
2. merge 到 squad.charter（partial 字段覆盖，未传字段保留）。
3. 写一条 charter_history（patch + reason + triggeredByMessageId=空，append-only）。
4. 返回更新后的 charter + 新建 historyId。

> **charter 不关联 member**（4 定性字段 embedded in squad record，非按 role 裁剪——那是 v3 对话驱动的 leader 持有语义）。本版由 user 在 UI/API 直接管理。
>
> **乐观锁**：本版不加 version 字段（design.md §6.3 待定）；并发 PUT 用 last-write-wins + history append-only 留痕（不会丢变更历史，但 squad.charter 当前值可能被覆盖）。

**错误**：`400` patch 空 / reason 缺；`404` squad 不存在。

### 3.3 `GET /squad/:id/charter/history` — charter 变更历史

| 方法 | 路径 | 语义 | query | 成功响应 |
|------|------|------|-------|---------|
| `GET` | `/squad/:id/charter/history` | charter 变更历史（时间倒序，append-only） | `limit?`（缺省 50） | `200` + `{ items: CharterHistory[] }` |

```typescript
interface CharterHistory {
  id: string;                     // ULID
  squadId: string;
  patch: { goals?: string; workingStyle?: string; collaboration?: string; escalation?: string };
  reason: string;
  triggeredByMessageId?: string;  // v1 UI 编辑=空；v3 对话驱动=消息 id
  createdAt: string;
}
```

**错误**：`400` limit 非 [1,200]；`404` squad 不存在。

## 4. Heartbeat / Budget / Scheduler 端点（`[v0.0.33.4]` 新增）

> 4 端点接通 v0.0.33.1 占位的 `member.heartbeat` / `squad.enableHeartBeat` / `squad.budget`。权威设计：`specs/tech/squad/[P1]scheduler.md` + `[P1]squad_autonomy.md §5/§6`。增量详见 `specs/api/version_logs/v0.0.33.4/change_log.md`。

### 4.1 端点总览

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| 1 | `PATCH` | `/squad/:id` | **[v0.0.116] squad 心跳配置读写**（§1.4）：enableHeartBeat / budget / timezone / **heartbeatConfig** 字段，写后 `scheduler.reloadSquad` |
| 2 | ~~`PATCH /squad/:id/member/:mid/heartbeat`~~ | — | **[v0.0.116] 废弃删除**（§4.2）：per-member 心跳升级 squad 级；心跳配置改走 #1 PATCH /squad `heartbeatConfig` |
| 3 | `GET` | `/squad/:id/budget/usage` | 当前 daily 窗口 consumed + remaining + limit + 窗口边界（横向聚合 team sessions） |
| 4 | `GET` | `/squad/:id/scheduler/history` | 自动工作历史（heartbeat 唤醒），who/when/reason/actionSummary |

> **[v0.0.116] presence 无专用 HTTP 端点**：`member.currentWork` 由 `presence` agent 工具写（`squad_tools.md §6a`），读走 `GET /squad/:id` 的 `SquadDetail.members[].currentWork` 回显（UI 展示 team status 时用）。本版本不新增 presence 专用端点（概念层；完整架构阶段若 UI 需专用读端点再定）。
> **[v0.0.33.4] 历史路径决策**（保留）：项目无独立 role entity（`member.role` 是字段，`leaderId=member.id`）；`/scheduler/history` 的 `roleId` 参数指 member.id。

### 4.2 ~~`PATCH /squad/:id/member/:mid/heartbeat`~~（[v0.0.116] 废弃删除）

**[v0.0.116] 端点删除**：per-member 心跳升级为 squad 级统一调度（`specs/tech/scheduling/[P1]heartbeat_handler.md §0`）。心跳配置改走 **`PATCH /squad/:id`** 的 `heartbeatConfig` 字段（§1.4）——一队一份 interval / activeWindows / scope，不再 per-member。

- 旧端点、`PatchHeartbeatBody`、`scheduler.reloadRole`、handler `squad-heartbeat-handler.ts` 全部删除。
- 旧 AT case（`heartbeat_patch_tc1` / `patch_heartbeat_400_start_ge_end` 等）迁移到 `PATCH /squad` heartbeatConfig 校验（新 AT）。
- **成员范围**由 `heartbeatConfig.scope`（all / whitelist）控制，非 per-member 开关；benched 成员任何模式不唤醒（调度层 filter，非 API 拒配）。

### 4.3 `GET /squad/:id/budget/usage`（新增）

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/squad/:id/budget/usage` | 当前 daily 窗口消耗 + 剩余 + limit + 窗口边界 | `200` + `BudgetUsage` |

```typescript
interface BudgetUsage {
  squadId: string;
  limit: number;                    // squad.budget.limit（budget=null 时=-1，仅 Display）
  window: "daily";
  consumed: number;                 // Σ team sessions 当窗口 delta（baseline-delta 算法）
  remaining: number;                // limit - consumed（<0 超限；budget=null 时=-1）
  windowStart: string;              // ISO，当日 squad.timezone 0 点
  windowEnd: string;                // ISO，次日 squad.timezone 0 点（回血时刻）
  perSession: Array<{ sessionId: string; role: "leader"|"mate"|"squad"; consumed: number }>;
  timezone: string;
}
```

**行为**：
- 横向聚合 team sessions（leader + members + squadChat）的当窗口 consumed。
- **reactive + proactive 都计入 consumed**（consumption always-on；budget gate 仅 proactive）。
- budget=null（未配）→ `limit=-1, remaining=-1`，consumed 仍算（**仅 Display 用**；该 -1 **不进 scheduler gate**——gate 对 null 直接放行，见 `[P1]scheduler.md §4 gate2`）。
- UI budget meter 轮询此端点 + SSE `session_usage_update` 实时刷新。

> **`[v0.0.33.4]` drift 订正（daily 窗口实现）**：`session_store.getUsageView` 真签名为 `getUsageView(sessionId): Promise<SessionUsageView>`——**无 windowStart 参数**，返全时累计 total（`[P1]scheduler.md §5` 旧文 `getUsageView(sid, windowStart)` 为 aspirational，已订正）。daily 窗口靠 **budget baseline-delta**：`budget-state.json` 维护 per-session baseline（windowStart 时刻的全时 total），`consumed = 当前全时 total − baseline`；窗口翻转（跨 squad tz 0 点）重置 baselines。wiring 在 `squad-runtime.ts`（包装 `sessionStore.getUsageView` + `BudgetState.getConsumed`）。

**错误**：`404` squad 不存在。

### 4.4 `GET /squad/:id/scheduler/history`（新增）

| 方法 | 路径 | 语义 | query | 成功响应 |
|------|------|------|-------|---------|
| `GET` | `/squad/:id/scheduler/history` | 自动工作历史（心跳唤醒） | `?limit=N`（缺省 50，max 200）+ `?roleId=<memberId>`（可选过滤） | `200` + `{ items: SchedulerHistoryEntry[] }` |

```typescript
interface SchedulerHistoryEntry {
  id: string;                       // [v0.0.33.4] handler 合成 `${at}_${roleId}` sanitize 非[A-Za-z0-9_]→_（稳定键，非 ulid/idx）
  squadId: string;                  // path 参数
  roleId: string;                   // member.id（leader 或 mate）
  roleName: string;                 // member.name（handler 查 memberStore 解析）
  at: string;                       // ISO，触发时刻
  reason: "heartbeat";
  result: "fired" | "skipped_busy" | "skipped_budget" | "skipped_window" | "skipped_killswitch";
  actionSummary?: string;           // role run 结束后回填的行动摘要（best-effort，可能空）
}
```

**行为**：
- 时间倒序（最新在前）。来源 = scheduler ring buffer（`[P1]scheduler.md §8`）+ 可选 history.jsonl 持久化（重启不丢）。UI「自动工作」tab 展示。

> **`[v0.0.33.4]` drift 订正（entry id 合成）**：spec 旧措辞「id: ulid」不准——`HistoryEntry`（scheduler ring buffer 内部）自身**无 id 字段**，由 handler 层合成 `makeHistoryEntryId(at, roleId)` = `${sanitize(at)}_${sanitize(roleId)}`。**不用 ulid**（随机 → 同 entry 每次 GET 返不同 id，UI testid `auto-work-item-{id}` 错位）；**不用数组 idx**（history 增长后同 entry 在倒序列表中 idx 偏移 → 跨 GET id 不稳定，BUG-003 教训）。sanitize 非 `[A-Za-z0-9_]` 为 `_`（ISO 含 `:`/`-`/`.`，testid attribute selector 安全）。backlog：让 HistoryEntry 自带 ulid。

**错误**：`404` squad 不存在；`400` limit>200。

### 4.5 `squad_meta` SSE topic — squad 聚合状态实时推送（`[v0.0.305]` 新增）

> 对齐 `session_meta` 广播模式（`04-agent-session.md §4.2` + `specs/tech/app/frontend/[P0]sse_channel.md §10`）：全量 payload、`_all` 共享广播 group、replayable=false。

| 项 | 值 |
|----|-----|
| **topic** | `squad_meta`（已加入 `handlers/sse.ts ALLOWED_TOPICS` 白名单 + bus-phase 注册 + 白名单双向断言） |
| **group** | `_all`（共享广播） |
| **replayable** | `false`（快照态；初始态走 GET /squad 拉全量，订阅后只收增量——同 session_meta §10.3 理由） |
| **事件类型** | `squad_meta_update`（唯一） |
| **data** | 全量聚合 payload（非 diff，前端 reducer 按 `data.squadId` 整条替换） |

```typescript
interface SquadMetaUpdateEvent {
  id: string;                    // 事件自身 ULID
  type: 'squad_meta_update';
  squadId: string;               // 变更的 squad（与 data.squadId 一致）
  createdAt: string;             // ISO 8601 UTC
  data: {
    squadId: string;
    onlineCount: number;         // member.state==='deployed' 数
    inProgressCount: number;     // busy session 数（running/interrupting/suspended）
    lastActiveAt: string;        // max(直连 session.updatedAt) ?? squad.updatedAt
  };
}
```

**触发方**：`SquadMetaBroadcaster`（squad 层组件，仿 SessionMetaBroadcaster 自治订阅 statusBus）：
- **session 事件触发**（statusBus wrap fan-out，事件→squad 路由：`sessionStore.getSession(sessionId)` → `s.squadId`；null=playground 跳过）：`session_status_update` / `summary_task_update` / `session_usage_update` / `session_read_update` / `messages_cleared`；高频 `session_workspace_file_changed` **不触发**。
- **写路径显式触发**（handler 落盘后 `squadMetaBroadcaster.broadcast(squadId)`）：member hire（`POST /squad/:id/member`）/ deploy / bench 成功后 + squad create（`POST /squad`）成功后。**不触发**：member PATCH（聚合不依赖 name/intro）、squad DELETE（前端 mutation 后 reloadSquads 兜底）。
- **触发纪律**：状态机 + agent-loop 不感知 squad_meta；写路径 await 落盘后再 broadcast（v0.0.163 race 教训）。

**前端消费**：`useSquadMeta` hook（page-studio 级单例）`onInit` subscribe('squad_meta','_all') → `onEvent` applyKeyed set 整条替换 → `aggregateMap`；SSE 断连重连（非 replayable）→ `onResumed` 触发 `reloadSquads()` 全量兜底。技术权威 `specs/tech/squad/[P1]squad_aggregate.md`。

## 5. 团队同步端点（§E，`[v0.0.319 modified]` 新增）

> 团队同步（导入导出团队配置）完整端点契约见**姊妹文件 `11d-squad-team-sync.md`**（本文件行数预算内只留指针）：
> - `GET /squad/:id/export` — 导出团队 zip 下载流（application/zip + Content-Disposition，中文名走 RFC 5987 filename*）
> - `POST /squad/import?step=preview` — FormData(file) 解包校验 → `{ importKey, manifest }`（importKey 5min TTL）
> - `POST /squad/import?step=execute` — FormData(importKey, name) 建队 → `{ squadId, created, failed }`
> - 错误：InvalidZipError（path traversal / manifest 缺失 / 结构不合法）→ 400；404 squad not found（导出）
> - **路由顺序（MANDATORY）**：export/import 分发在 `/squad/:id` CRUD 之前匹配（`squad-routes.ts` `dispatchSquadRoutes`）

## 6. 版本

version: 1.13 `[v0.0.319 modified]`：**新增 §5 团队同步端点**——`GET /squad/:id/export`（导出 zip 下载流，application/zip + Content-Disposition，中文名走 RFC 5987 filename*）+ `POST /squad/import?step=preview|execute`（两阶段导入：preview 解包校验返 `{importKey, manifest}`（importKey 5min TTL）/ execute 按 importKey 建队返 `{squadId, created, failed}`）。路径安全（zip entry 拒 `..`/绝对路径/盘符 → 400 InvalidZipError）；导出侧 symlink skip。modelDefault 继承当前 session squad → 系统 fallback。**路由顺序 MANDATORY**：export/import 分发在 `/squad/:id` CRUD 之前匹配。权威 `specs/tech/version_logs/v0.0.319/change_plan.md` D1-D3。

version: 1.7 `[v0.0.169 modified]`：**hire 扩 `workStyle?`**。§2.1 `HireMemberBody` fresh 加 `workStyle?: string`（直传，`trim()` 后回写；可空——提供空串=回写空串无 400；不传=缺省无 workStyle）、derive `overrides` 加 `workStyle?: string`（默认**复制父 member workStyle**，override 覆盖 trim 回写，空串=清空回写空串）——语义对齐 §2.2 PATCH 的 v0.0.142 口径。仅用户面可写（HTTP hire + PATCH 编辑面板）；agent `team` 工具不暴露（`team.hire` 服务端剔除 `overrides.workStyle`，同 `team.edit` 剔除模式）。前端入口 = 成员创建页（`section-member-create`，弹层改版，06-studio §7）。概念权威 `specs/tech/squad/[P1]data_model.md §1.2c/§5`。

version: 1.6 `[v0.0.158 modified]`：**删「独立 summary 模型」层——`summaryModelDefault` 字段族整删**。§1.1 `CreateSquadBody` 删 `summaryModelDefault?`（兼容层：旧 client 传字段被 handler 静默忽略，不返 400/不落库）；§1.3 `SquadDetail` 响应删 `summaryModelDefault`（旧前端读为 undefined 兼容）；§1.4 `PatchSquadBody` 删 `summaryModelDefault?`（同兼容层）。`createSquadService` 校验/归一化/落盘分支同步删。**§1.1 建队事务补明 leader session `modelId` 缺省行为**：建 leader session 时不派生 modelId（存 `'default'` 保留字或 undefined），运行时经 `agentManager.resolveConfigBySid(sid)` 走 studio fallback 链 `session.modelId → squad.modelDefault`（chat/compact 同链）。**存量数据 migration**：`clean-squad-summary-model-default` handler（`app/server/src/migration/handlers/`）启动期自动幂等清理 squad record 残留字段（版本 gate `<0.0.158`）。技术权威 `specs/tech/agent/providers_and_models/[P0]model_resolve.md §3/§4 原则 6`。

version: 1.6 `[v0.0.192.delete_cleanup modified]`：§1.5 `DELETE /squad/:id` 行为修订——step② 改 `listSessionsBySquad` 按 `Session.squadId` 平铺快照全量 squad session（含 spawn children，不限 parentSessionId 链完整性，orphan 也兜住）；step④ 改 `deleteSquadAdministrativeSubpaths`（只删办公室管理性子路径：members/charter_history/panorama/.rocky 四目录 + charter.md/index.md/log.md 三文件，force:true 幂等），**保留 workspaces/outputs/reports/board 工作产出**（用户裁决 2026-07-23：用户看得懂的产出留 / 程序才懂的内部数据删）。每 descendant 经 deleteSession → onSessionDestroyed → 清内存 cron，堵「删 parent 后 child cron 继续烧 token」的潜伏调度。详 `specs/tech/squad/[P1]squad_workspace.md §7` + `specs/tech/scheduling/[P1]cron_subsystem.md §8` + `specs/tech/version_logs/v0.0.192.delete_cleanup/change_plan.md`。

version: 1.5 `[v0.0.142 modified]`：**member `workStyle` 工作方式字段**。§1.3 `Member` 加 `workStyle?: string`（仅注入个人 session prompt，不进 Team Roster；旧 member 缺省）；§2.2 `PatchMemberBody` 加 `workStyle?`（`trim()` 后回写，**空串=清空，无 400**——区别 intro）。仅 `PATCH /squad/:id/member/:mid`（用户编辑面板）可写：hire 不含、agent `team.edit` 服务端剔除（仅用户可编辑）。概念权威 `specs/tech/squad/[P1]data_model.md §1.2c` + 注入 `[P1]prompt_sections.md §3.1`。

version: 1.4 `[v0.0.116 modified]`：**心跳升级 squad 级统一调度 + member presence**。§1.4 `PatchSquadBody` 加 `heartbeatConfig{interval(5/15/30/60), activeWindows[](多段/不重叠/不跨0点/空=全天), scope{all/whitelist}}` | null；`budget` null=off=不限量语义显式化。§1.3 `SquadDetail` 加 `heartbeatConfig`（null 回显）；`Member` 加 `currentWork{text,updatedAt}|null`（presence），`heartbeat` 标 dead。§4.1 端点总览：**废弃删除 `PATCH /squad/:id/member/:mid/heartbeat`**（§4.2 改废弃说明，心跳配置改走 PATCH /squad）；presence 无专用端点（工具写 + SquadDetail.members[].currentWork 回显）。权威概念 `specs/tech/scheduling/[P1]heartbeat_handler.md §0` + `specs/tech/squad/[P1]data_model.md §1.1a/§1.2b`。

version: 1.3 `[v0.0.111 modified]`：新增 §1.5 `DELETE /squad/:id` team 硬删除（解散）——`dissolveSquad` 编排（disposeSquad teardown → deleteSession 各会话 → deleteSquad → rmSync 办公室目录，顺序不可颠倒），200 `{deleted:true}` / 404 not found；session+历史物理删不可恢复。§1.4 后原「无 DELETE / squad 不可删」表述删除（squad 现可硬删）。member 仍不可删（bench 兜底）。权威编排见 `specs/tech/squad/[P1]data_model.md §1.1` + `[P1]scheduler.md §9`。

version: 1.2 `[v0.0.33.4 modified]`：autonomy infra 收官——§1.4 PATCH /squad 占位字段生效（enableHeartBeat/budget/timezone 写后 `scheduler.reloadSquad`，SquadDetail 必含三字段回显）；§1.3 SquadDetail 加 `timezone?` + budget/enableHeartBeat/member.heartbeat 注释从「占位」改「实跑」；新增 §4 Heartbeat/Budget/Scheduler 4 端点（PATCH /member/:mid/heartbeat 实时刷 timer + benched 200+warning / GET /budget/usage 横向聚合 + baseline-delta daily 窗口 / GET /scheduler/history heartbeat+file-changed 统一历史，id 合成 `${at}_${roleId}` sanitize）。路径用 /member/:mid（非 PRD 措辞 /role/:roleId，无 role 实体）。4 处 drift 订正（getUsageView 无 windowStart/SquadRecord 用 memberIds+memberStore/cross-midnight API 严拒 start>=end/entry id 非_ulid）。权威实现见 `[P1]scheduler.md` + `[P1]squad_autonomy.md`。

version: 1.1 `[v0.0.33.3 modified]`：member.systemPrompt 移除（§1.3 `Member` 响应删字段；§1.1 `CreateSquadBody.leader.systemPrompt` + §2.1 `HireMemberBody` fresh/derive 一律 accept-and-ignore 兼容旧 payload，不存储；§1.1 建队事务 step7 加 OKF md skeleton；§1.1/§2.1 错误码去 systemPrompt 必填）。身份正文由 squad_role mapper + fragment 组装（`prompt_sections §7`）。board 只读端点见姊妹文件 `11b-squad-workitems.md`。

version: 1.0 `[v0.0.33.1]`（首版：从 `11-squad.md` 拆出的端点契约主体——§1 Squad CRUD（POST/GET/GET/:id/PATCH，无 DELETE，建队事务 8 步 + 补偿回滚）+ §2 Member 管理（hire fresh/derive / edit / deploy / bench，leader 403 leader_not_benchable，无 DELETE）+ §3 Charter（GET/PUT/GET history，PUT partial patch + 写 charter_history append-only）。payload / 响应 / 行为 / 错误码完整。姊妹文件 `11-squad.md` 管 session schema 增量 + bizType 隔离 + 占位 chat 403 + SSE 策略 + AT 映射 + 文件清单）。
