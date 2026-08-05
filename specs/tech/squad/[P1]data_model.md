---
type: interface
title: Squad 数据模型 + 存储布局 + 建队事务
priority: P1
status: active
updated: 2026-08-04
since: v0.0.33.1
---

# Squad 数据模型 + 存储布局 + 建队事务（squad 层）

> 定位：定义 squad / member 两个 entity 的 **SchemaDef 形态** + **三组双向关联**（应用层 service 单点维护）+ **存储布局**（FS 目录树）+ **建 squad / hire member 事务流程**（含补偿回滚）。
> 命名体系（B 方案锁定）：**squad-member-subagent** + `member.role = leader | mate`；[v0.0.56] session 身份维度统一走 SessionKind（`role: 'squad'|'leader'|'mate'|'rocky'` + `derivation: 'main'|'subagent'` + `biz: 'playground'|'studio'`），旧 `session.type` 字段已删除。
> 参考：`states/v0.0.33.1/design.md`（实体 + API + 流程权威）；`[P1]squad_definition.md`（Squad/Member 概念）；`specs/tech/persistence/[P0]fs_crud_store_engine.md`（CrudStore FS engine + sharding）；`specs/tech/agent/session/[P0]session_store.md`（Session interface）。

---

## 1. Entity SchemaDef（两个新 entity + session 增量字段）

### 1.1 squad（file engine，不分片，可硬删除）

```typescript
interface Squad {
  // ── 标识 ──
  id: string;                // ULID（PK，业务生成）
  name: string;              // required
  description: string;       // 可空
  // ── 默认模型（v0.0.155：ModelRef 复合 = {modelId, providerId?}；[v0.0.158] 删「独立 summary 模型」层）──
  modelDefault: string;      // modelId 部分（required）——chat/compact/T1 记忆整理同链读此字段（studio 场景，见 ../agent/providers_and_models/[P0]model_resolve.md §3 第 2 行）
  modelDefaultProviderId?: string;    // [v0.0.155 复合 ModelRef] modelDefault 的配对 providerId（optional back-compat；与 modelDefault 同存同缺：providerId 非空但 modelDefault 空 → 400）
  // [v0.0.158] summaryModelDefault + summaryModelDefaultProviderId 两字段整删（存量数据由 migration handler clean-squad-summary-model-default 幂等清理）
  // ── 双向关联（应用层 service 维护）──
  leaderId: string;          // → member.id（建队回填）
  memberIds: string[];       // → member.id[]（leader 也在内；hire/bench 维护）
  squadChatSessionId: string;// → session.id（建队回填）
  // ── 自主性 infra（v0.0.33.4 实跑；[v0.0.116] 心跳升级 squad 级统一调度）──
  enableHeartBeat: boolean;  // 总开关（默认 false；替代旧 autonomyEnabled）。off → 停调度、下面配置全收起（UI）
  budget: { limit: number; window: "daily"; scope: "team" } | null;
                             // 预算控制（[v0.0.116] off/on 语义显式化）：
                             //   null = **off = 不限量**（gate 放行；现有 null 语义天然对齐 req）
                             //   非 null = **on = 限量**，limit token/天（UI 默认 1_000_000），gate 用 Σ team 总消耗判断
  timezone?: string;         // IANA tz（activeWindows + daily 回血窗口都跟它；缺省 user local）
  heartbeatConfig: SquadHeartbeatConfig | null;  // [v0.0.116 新增] squad 级统一心跳调度参数（见 §1.1a）。null/缺省=用默认（interval=15/activeWindows=[]全天/scope=all）
  // ── 信封 ──
  createdAt: string;
  updatedAt: string;
  version: number;
}
```

- **无 status 字段 / 无 archived**（squad 本身不参与工作项的归档/取消可见性）。
- **可硬删除（解散团队，v0.0.111）**：`DELETE /squad/:id` → `dissolveSquad`（`squad-dissolve.ts`）编排硬删，顺序不可颠倒——① `squadRuntime.disposeSquad(id)`（per-squad 运行时 teardown：abort 在跑 loop + 注销 heartbeat jobs + 停 file-watcher + 清 per-squad 状态，`[P1]scheduler.md §9`，**先于删数据防潜伏调度**）→ ② 枚举会话（`squadChatSessionId` + 各 `member.sessionId`）`sessionStore.deleteSession(sid)`（级联 `rm sessions/{sid}/` 含 cron.json + `onSessionDestroyed` 注销内存 cron）→ ③ `squadStore.deleteSquad(id)`（仅删 record `{root}/squad/{id}.json`）→ ④ `deleteSquadAdministrativeSubpaths(dataDir, id)` 删办公室管理性子目录（保 outputs/reports 等工作产出，详 `squad_workspace.md §7`）。**session + 历史消息随之物理删、不可恢复**（用户已接受；根除潜伏调度是硬删的动机）。API 契约见 `11a-squad-endpoints.md §1.5`。
- **`summaryModelDefault` / `summaryModelDefaultProviderId` 字段族已整删（v0.0.158）**：v0.0.89 引入的「独立 summary 模型」层退役——chat / 手动 compact / 自动 compact / T1 记忆整理**全部走同一入口** `agentManager.resolveConfigBySid(sid)`（studio 场景统一读 `squad.modelDefault`）。存量数据由 migration handler `clean-squad-summary-model-default`（`app/server/src/migration/handlers/`）启动期自动幂等清理（`<0.0.158` 版本 gate）。**兼容层**：旧 client body 传两字段被 handler 静默忽略（不返 400 / 不落库）。技术权威 `../agent/providers_and_models/[P0]model_resolve.md §3/§4 原则 6`。
- **v0.0.155 ModelRef 复合字段**（`modelDefaultProviderId`）：optional back-compat（旧 squad 无此字段 → resolver hint 空 → 跨 provider 反查兜底，无需 migration，INV-B3）。校验：providerId 非空但配套 modelId 空 → 400 `providerId without modelDefault`。POST/PATCH body 透传；SquadDetail response 回显（不省 key，对齐「无 null 输出」）。

#### 1.1a SquadHeartbeatConfig（[v0.0.116] squad 级统一心跳调度参数）

**[v0.0.116] 心跳从 per-member 升级为 squad 级统一调度**：整队一份配置，到点整团队一次，按范围对符合条件成员逐个 `deliverTo` 固定心跳提示词。**废弃 per-member `member.heartbeat`**（§1.2 标 dead）。schema 新增 `squad.heartbeatConfig`：

```typescript
interface SquadHeartbeatConfig {
  interval: 5 | 15 | 30 | 60;       // 唤醒间隔（分钟），enum 四选一，默认 15
  activeWindows: Array<{ start: string; end: string }>;  // 多工作时间段（"HH:mm" 24h，跟 squad.timezone）
                                    // 约束：段间不重叠；单段不跨 0 点（start < end 同日）；空数组 [] = 全天（无时段限制）
  scope: {
    mode: "all" | "whitelist";      // off=all（全员，含 leader）/ on=whitelist（仅白名单）
    memberIds: string[];            // mode=whitelist 时生效；mode=all 时忽略（约定空数组）
  };
}
```

- **与现有 `enableHeartBeat` / `budget` / `timezone` 的分工**（避免重复概念）：
  - `enableHeartBeat`（总开关）+ `budget`（预算 gate）+ `timezone`（时区基准）**三字段职责不变**，`heartbeatConfig` 只新增「调度参数」维度（间隔 / 时段 / 范围）。
  - v0.0.33.4 的调度参数（interval / activeWindow）原分散在 `member.heartbeat`，现**上收到 squad 级** `heartbeatConfig`——一队一份，不再 per-member。
- **`interval` enum 化**：v0.0.33.4 是任意分钟数；v0.0.116 收敛为 `5|15|30|60`（UI 选项，默认 15），与 req 一致。schema 存 number（不校验 enum 值，容忍历史；UI 只给四选项）。
- **`activeWindows` 多段**：替代旧单段 `activeWindow`。段间不重叠 + 单段不跨 0 点（`start < end`）由 HTTP 写入校验兜底（`11a §1.4`）。空数组 = 全天可调度（req「不加时间段=不限时段」）。跨午夜需求用户可拆成两段（如 22:00-24:00 需拆 22:00-23:59 + 次段——但不跨 0 点约束下夜班暂不支持跨午夜，与 v0.0.33.4 API「不暴露跨午夜」一致）。
- **`scope` 范围**：`all`=全员（默认，含 leader）；`whitelist`=仅唤醒 `memberIds` 中的成员——**后续新增成员不自动纳入**（req「自定义则新增用户不唤醒」）。benched 成员任何模式下都不唤醒（gate 内 filter）。
- **`heartbeatConfig=null`（未配 / 缺省）**：等价默认值（interval=15 / activeWindows=[] 全天 / scope=all）。schema `required=false`（容忍历史 squad record 无此字段，读到 null 走默认）。
- **消耗口径不新增分桶**（req 决策 4）：预算 gate 仍用现有 `Σ team session_usage total`（团队总消耗/天），不为调度单独记消耗。
- **权威调度语义** = `../scheduling/[P1]heartbeat_handler.md`（squad 级 job + gate chain + 逐成员展开）。

### 1.2 member（file engine，按 squadId 分片）

```typescript
interface Member {
  id: string;                // ULID（PK）
  squadId: string;           // → squad.id（双向之一）
  sessionId: string;         // → session.id（双向之一；仅 leader/mate 有 session）
  // ── 身份 ──
  name: string;              // squad 内唯一（a2a 人类可读寻址符）
  intro?: string;            // 一句话介绍（渲染进 Team Roster 花名册行尾，安排工作/相互寻址时快速识别角色职责）
                             //   schema optional + 业务 required（见 §1.2a）：schema 层不强制（容忍历史 member record 无此字段——
                             //   PATCH read-modify-write 不炸、旧队花名册优雅降级）；业务层 fresh 建 mate 必填（member-service 校验）、
                             //   leader 建队用代码固定文案、derive 继承父 intro；可编辑（PATCH member intro）。
  workStyle?: string;        // [v0.0.142] 工作方式（成员编辑面板可管理，仅用户可编辑）。仅注入该成员**自己个人 session**
                             //   的 system prompt（squad_role mapper leader/mate 分支追加段），不进 team_roster 花名册、
                             //   不进 agent 管理工具 schema（见 §1.2c）。schema optional，可空默认空（空则不注入，无 400——区别 intro）。
  role: "leader" | "mate";   // B 方案（原 type=leader|member）
  // ── 能力配置 ──
  // [v0.0.33.3] systemPrompt 字段已移除（prompt_sections §7 step3）：身份正文由 squad_role
  //   mapper 注入（content fragment），不落 DB。derive 模式改配置继承（parent.{role 降 mate,
  //   tools,skills,model}，非 prompt 继承）。
  // [v0.0.48] **tools 字段标 deprecated/dead**：leader/mate 工具集改 static-by-type（查
  //   `tool-policy.ts` `TOOL_POLICY.roles['studio-leader'|'studio-mate'].bound`，leader=15 / mate=15）。
  //   entity 字段保留（避免 migrate 风险），但 `session-config.ts:buildSessionConfigFromDeps` 不再读
  //   `member.tools`，改 `resolveTools(role)` 查 policy；旧 Member.tools 值不读不写（dead）。
  //   API：PATCH body 带 tools 字段 → 忽略并 warn（不返 400，向后兼容）；HireBody 去 tools 字段。
  //   详见 `../agent/tools/[P0]tool_policy.md` + `[P1]agent_leader.md §3` + `[P1]agent_member.md §3`。
  tools: string[];            // [v0.0.48] dead（保留 entity 字段，不再被读取）
  // [v0.0.113] skills 白名单（string[]）**推翻重写**为 overlay 快照（不兼容旧数据，用户拍板）。
  //   旧 `skills: string[]`（D4 交集白名单，占位死数据）删除；新概念见下 skillConfig。
  skillConfig: {              // [v0.0.113] 成员局部 skill overlay 配置（替代旧 skills 白名单）
    mode: "inherit" | "custom";        // off=inherit(跟全局) / on=custom(全局叠加局部快照)
    overrides: Record<string, boolean>; // skill name → on/off 快照；仅 custom 有意义；inherit 恒 {}
  };
  // [v0.0.155] model 字段**硬删**（A4 决策）：member 退管理概念（name/role/intro/workStyle/tools/skillConfig），
  //   运行配置（model/effort/approval）全跟 session（session.modelId + session.providerId 复合）。
  //   resolver 不再读 member.model（INV-A1），字段变 dead 故删（不保留 dead，原则「不遗留死代码」）。
  //   存量 member.model 值读侧忽略（resolver 不读），写侧永不再落盘——无 migration 需要。
  //   影响：hire/PATCH member API body.model 不再接受（旧 client 传 → warn+ignore 非 400）；
  //         team 工具 hire schema 去 model 字段；squad admin UI 移除 member.model 设置项。
  //   替代路径：picker 改走 updateSession({providerId, modelId}) 写 session（INV-D1）。
  // ── 状态机 ──
  state: "deployed" | "benched";
  benchReason?: string;      // state=benched 时填
  benchedAt?: string;        // ISO 8601，state=benched 时填
  // ── presence（[v0.0.116] 成员当前工作标记，自由文本，每人一条）──
  currentWork: { text: string; updatedAt: string } | null;  // set 覆盖 / clear=null。running 成员的 currentWork 进 leader team-status reminder（§1.2b）
  // ── 心跳（[v0.0.116] dead：per-member heartbeat 废弃，升级 squad.heartbeatConfig §1.1a）──
  heartbeat: { activeWindow: { start: string; end: string; timezone?: string }; interval: number } | null;
                             // [v0.0.116] **dead**：schema 字段保留（避免历史 member record 迁移风险），
                             //   但代码不再读写——心跳调度改查 squad.heartbeatConfig（§1.1a）+ scope 范围唤醒。
                             //   listHeartbeatRoles/projectMemberHeartbeat/per-member job 全废弃（同 member.tools v0.0.48 dead 处理）。
  // ── hire 时一次性（derive 模式）──
  deriveFrom?: string;       // → member.id（父 member；hire 后无后续联动）
  // ── store 投影（agent tool 写时填，HTTP 不传）──
  lastWriteMessageId?: string;  // ulid；agent tool 写 member 时填 = 当前 message id；HTTP 路径不传 = undefined（向后兼容）。
                             //   v0.0.128：deploy/bench/edit 经 member-mutations service 接 lastWriteMessageId? 入参写入；
                             //   hire 经 createMemberService（未接此入参）= 不记（D8 部分实现，遗留 gap）。
  // ── 信封 ──
  createdAt: string;
  updatedAt: string;
  version: number;
}
```

- **全 agent**（无 human member）。
- **leader 永远 `state=deployed`**——不可 bench（API 返 403）。
- state 状态机：`(none) ─hire─▶ deployed ⇌ bench/deploy`（U5：无 fire；长期 bench = 离队，但不删 record）。
- **[v0.0.113] `skillConfig`（overlay 快照，替代旧 `skills` 白名单/D4 交集）**：成员 session（及其 subagent）可见 skill = **workspace 层 skill 恒生效** + **builtin/app 层 skill 按 overlay 叠加**。
  - `mode:'inherit'`（off，默认新成员）：builtin/app 层跟随**全局 enabled**（skill 页 `skill_state`），`overrides` 恒 `{}`。
  - `mode:'custom'`（on）：builtin/app 层 = 全局 enabled **叠加** `overrides` 快照——`overrides[name]` 有记录用快照值，无记录（如后续新增 skill）跟全局 enabled。
  - resolve 逻辑权威见 `session_config_studio.md §3`（替代旧 D4）；产品行为见 PRD `2-member-skills-mechanism.md`。**不兼容旧数据**：旧 member.json 的 `skills` 字段不迁移（读不到 skillConfig 即走默认 inherit）。
  - **角色区分不再靠 skill 白名单**：overlay 下 leader/mate 都 inherit 全局 enabled 的 builtin（含 okf-skill）；角色行为由 `squad_role` mapper（system prompt fragment）+ tool-policy 保证（原则 #3/#6）。

#### 1.2a intro 一句话介绍（schema optional / 业务 required）

`intro` 是成员的一句话角色介绍，注入进 Team Roster 花名册（`prompt_sections §3.2`），让 leader 安排工作、mate 相互寻址时一眼识别谁负责什么。

- **schema `required=false`，业务分角色约束**（`schema_defs/squad/member.ts`）——刻意让 schema 宽容、业务收紧：
  - **fresh 建 mate**：**必填**。`member-service.ts resolveEffective` 校验 `intro.trim()` 非空，空/缺 → `throw 'intro required'`（`handlers/member.ts handleHire` 转 `400 intro required`）。避免花名册只有名字。
  - **leader 建队**：无用户输入，`squad-service.ts` 调模块内 `defaultLeaderIntro()` 返回**代码固定职能文案**（`'团队 leader，负责分配任务、与用户（老板）沟通定义目标和路径、评估工作是否完成等'`）——建队时 squad 只有名字、无个性化信息，故用固定文案，非 LLM 生成、非从 `leader.md` 派生。后续职能变化可通过 PATCH member intro 编辑。
  - **derive**：`overrides.intro ?? parent.intro ?? ''`（override 优先，否则继承父；父为旧 member 无 intro 时降级空串——不强制，与 fresh 区分）。
  - **可编辑（PATCH）**：`PATCH /squad/:id/member/:mid` body 带 `intro` 即更新（`handlers/member.ts handlePatchMember` 走 read-modify-write `memberStore.putMember`）。校验：提供 `intro` 但 `trim()` 后为空 → `400 intro required`（与创建校验口径一致）；不传 `intro` 不影响其他字段。UI 在成员管理面板（`section-member-panel.tsx`，`member-intro-input`）编辑。
  - **落盘**：`createMemberService` 仅当 `intro !== ''` 时写字段（空串不写盘，保持 optional 语义）；PATCH 更新时 `trim()` 后写字段。
- **为什么 schema optional 而非 required**：Member 走 PATCH read-modify-write，若 schema 强制 `required=true`，则任何历史遗留（v0.0.114 前建的）无 intro 的 member record 一旦被 PATCH（改名/换 model）就会因 schema 校验炸。schema 宽容 + 业务在**创建入口**收紧，既保新数据完整又不追溯报错既有数据。

#### 1.2b currentWork presence（[v0.0.116] 成员当前工作标记）

`currentWork` 是成员**自由文本**的「当前正在做的事」标记，让 leader 判断团队状态。每个成员只有一条（set 覆盖上一条 / clear 取消）。

- **schema `required=false`**（`{ text, updatedAt } | null`）——容忍历史 member record 无此字段（读到即视为 null）；PATCH read-modify-write 不炸。
- **维护入口 = 独立 `presence` 工具**（独立小工具，不塞进 team 工具）——`presence(set, text)` 覆盖 / `presence(clear)` 置 null（工具定义见 `squad_tools.md §4`）。leader/mate 可用（写自己 session 对应 member 的 currentWork）；SquadChat 不需要。
- **用途 = leader team-status reminder**（§1.2b 数据源）：leader system prompt 新增「团队当前状态」段，**只展示 session 正在 running 的成员及其 currentWork**（可能为空）；睡着（idle）的成员不展示（`squad_reminder_providers.md §4.6`）。
- **updatedAt**：ISO 8601，`presence(set)` 时刻。用于展示「多久前标记的」（可选，UI/reminder 决策）。
- **不触发 reminder 变化检测**：currentWork 变化不记 `lastWriteMessageId`（team-status provider 每轮直接产出，交 dedup reducer，见 §4.6）——因「活跃=running」是运行时态、每轮都可能变，无稳定变化锚点。
- **落盘**：`presence` 工具 read-modify-write `memberStore.putMember`（复用现有 member 写路径）。currentWork 进 `SquadDetail.members[]` 回显（UI 可展示）。

#### 1.2c workStyle 工作方式（[v0.0.142] 仅用户可编辑 / 仅注入个人 session）

`workStyle` 是成员的**自由多行文本**「工作方式」（偏好 / 原则 / 习惯），由用户在成员编辑面板填写。与 `intro` 的孪生 optional 字段（数据模型 / API / 前端三层照 intro 落地），但两点实质差异：

- **注入面唯一 = squad_role mapper 的 leader/mate 分支**（`prompt_sections §3.1`）——`studioContext.member` 是当前 session 自己的 member，故 workStyle 只进**该成员自己个人 session** 的 system prompt，天然满足「仅个人 session」。**MUST NOT 进 `team_roster`/`members[]`**（全队花名册，那是 intro 的注入面）。空（trim 后）则不追加、无悬空标题（追加段形态，非 `{{}}` 模板占位）。
- **可空 + 允许清空，无非空校验**（区别 intro）：schema `required=false`；PATCH 提供空串 → 回写空串（清空），`patchMemberService` `merged.workStyle = patch.workStyle.trim()`，**不 throw**（`schema-validation` 只 typeof 检查，空串是合法 string）。
- **仅用户可编辑（agent 工具面显式豁免）**：workStyle 覆盖 store（schema）↔ HTTP API（PATCH member + **[v0.0.169]** hire）↔ UI（编辑面板 textarea + **[v0.0.169]** 创建页）三面，**故意不覆盖 agent 管理工具面**（不进 `team` 工具 schema）——理由 = 「工作方式」是用户对成员的定制，不应由 LLM 经 `team.edit` 自我改写。`team-write-actions.ts runEdit()` 服务端显式剔除 `workStyle`（`squad_tools §2`），兜底 LLM 经裸 patch object 绕过。
- **hire 入口（[v0.0.169] 扩展）**：`createMemberService`/`HireMemberBody` 加 `workStyle?`——fresh 直传（trim 回写，空串=空串无 400，不传=缺省无）；derive 默认复制父 workStyle，`overrides.workStyle` 覆盖（空串=清空）。agent 面仍不暴露：`team-write-actions.ts runHire()` 服务端剔除 `overrides.workStyle`（同 runEdit 模式）。
- **落盘**：PATCH read-modify-write `memberStore.putMember`（复用现有 member 写路径）。进 `SquadDetail.members[]` 回显（编辑面板回填）。

### 1.3 session（[v0.0.56] 字段更新：type→role+derivation，bizType→biz；详见 `[P0]session_store.md` + `[P0]session_kind.md`）

```typescript
interface Session {
  // ...现有字段...
  role: "rocky" | "leader" | "mate" | "squad";    // [v0.0.56] 替代旧 type 字段（subagent 存 parent.role）
  derivation: "main" | "subagent";                  // [v0.0.56] 替代旧 scope + type='subagent'
  biz: "playground" | "studio";                     // [v0.0.56] 替代旧 bizType（必填）
  squadId?: string;                                 // 既有（所有 studio session 带）
  memberId?: string;                                // 既有（仅 leader/mate session）
  parentSessionId?: string;                         // 既有；leader/mate/squad=null，仅 subagent 有 parent
}
```

> [v0.0.56] 旧 type/bizType 字段已删除。SessionKind 概念见 `specs/tech/agent/session/[P0]session_kind.md`（独立成文）。biz/role write-time 校验规则见 `[P0]session_biztype.md §4`。

---

## 2. 双向关联（三组，应用层 service 单点维护）

**一致性由 createSquadService / createMemberService 等 service 层单点保证，无 DB 外键、无 trigger。**

### 2.1 squad ⇄ member

```
squad.leaderId + squad.memberIds[]  ↔  member.squadId
```
- 建队：先建 leader member → 回填 squad.leaderId + memberIds=[leaderId]。
- hire mate：建 mate member → append squad.memberIds。
- bench 不改关联（member 仍在 squad 内，仅 state 变）。

### 2.2 member ⇄ session

```
member.sessionId  ↔  session.memberId    （仅 leader/mate）
```
- 建 leader/mate member 时同步建对应 session（[v0.0.56] role=leader|mate, biz=studio, derivation=main），双向回填。
- subagent session **无 memberId**（它是 member 派生的临时子 agent，不是 member 本身）。

### 2.3 session ⇄ squad

```
session.squadId  →  squad    （所有 studio session：squad / leader / mate / studio 内的 subagent）
```
- 单向（session 持 squadId），squad 不持所有 sessionId 列表（除 squadChatSessionId + 经 member 间接持有 leader/mate sessionId）。
- studio 内 subagent session 也带 squadId（[v0.0.56] 跟 parent.biz）。

> **[v0.0.56] biz 必填**（无 lazy 默认）：数据迁移后所有 session 写 `biz: 'playground'|'studio'`；GET /session 缺省按 playground 过滤。

---

## 3. 存储布局

> okf 知识库（index.md / log.md / 各 type md）是 agent **自愿组织**的轻量建议（非强制，无后台投影），详 `[P1]squad_okf.md`。

```
data_dir/
├── sessions/...                                   ← 现有（session + transcript，FS 分片）
├── squad/{squadId}.json                           ← store：squad record（CrudStore entity='squad' 不分片，落 {root}/squad/{squadId}.json；schema_defs/squad/squad.ts 注释权威）
└── squads/{squadId}/                              ← squad「办公室」（建 squad 即建）
    ├── (okf 知识库 — agent 自愿组织，非强制；index.md / log.md / *.md，详 squad_okf §1)
    ├── members/{memberId}.json                    ← store：member records（file + 按 squadId 分片落此）
    ├── 交付/  /  temp/                              ← 最终成果 / 草稿（v0.0.237 轻量建议目录）
    ├── outputs/                                   ← 公共产出（公共 deliverables）
    ├── reports/{daily,...}/                       ← 报告（okf type: report）
    ├── workspaces/{memberId}/                     ← 【已废止·存量保留】旧个人工位（v0.0.232 起不再新建）
    └── .rocky/                                    ← 系统内部·隐藏（建队时建骨架）：state/（scheduler/budget/history）+ memory/ + skills/（旧 .rocky_squad/ 改名）
```

- **CrudStore FS engine 配置**（root=`data_dir`，store 装配统一）：
  - **squad entity**：不分片，落 `data_dir/squad/{squadId}.json`（entity='squad' → 目录名 `squad/`，单数；与 office 目录 `squads/{squadId}/` 分离，schema_defs/squad/squad.ts 注释权威）。
  - **member entity**：按 squadId 分片，落 `data_dir/squads/{squadId}/members/{memberId}.json`（entity 复数 = 目录名）。
- **无 `_archived/` 目录**——squad 删除是**硬删不留痕**（`DELETE /squad/:id` → `dissolveSquad` `deleteSquadAdministrativeSubpaths` 删管理性子目录，保 outputs/reports 等工作产出，§1.1 + `squad_workspace.md §7`），不做「软归档到 `_archived/`」。旧 req.md 的 `DELETE /squad → _archived` 软归档方案已推翻。

---

## 4. 建 squad 流程（createSquadService，事务性 + 补偿回滚）

```typescript
async function createSquadService(input: {
  name: string;
  description?: string;
  modelDefault: string;
  // [v0.0.33.3 step3] leader.systemPrompt 移除（身份正文迁 squad_role mapper content fragment）
  leader: { name: string };
}): Promise<{ squadId: string; leaderMemberId: string; leaderSessionId: string; squadChatSessionId: string }> {
  // 1. 生成 squadId + 建 squad record（memberIds=[]，enableHeartBeat=false，leaderId 暂空）
  // 2. 建 leader member（role=leader, state=deployed, squadId, intro=defaultLeaderIntro() 代码固定职能文案；可 PATCH 编辑）→ 写 member record
  // 3. [v0.0.56] 建 leader session（role=leader, biz=studio, derivation=main, squadId, memberId, parentSessionId=null）
  // 4. 回填 member.sessionId + squad.leaderId
  // 5. [v0.0.56] 建 squadChat session（role=squad, biz=studio, derivation=main, squadId, parentSessionId=null）
  // 6. 回填 squad.squadChatSessionId + append squad.memberIds=[leaderId]
  // 7. 建目录骨架（squads/{squadId}/{members,outputs,reports/{daily},workspaces/{leaderMemberId},.rocky/state}；交付/temp 由 agent 按需建）
  // 8. 任一步失败 → 补偿删除已建 record + 目录（反向顺序，best-effort）
}
```

- **一致性保证**：建完 member.sessionId + session.memberId 双向；squad.leaderId + member.squadId 双向；session.squadId 单向；squad.memberIds 含 leaderId。
- **补偿回滚**：步骤 1-7 任一失败，反向删除已创建的 session/member/squad record + 已建目录（不保证强一致，但避免半成品占位）。

---

## 5. hire member 流程（createMemberService）

```typescript
async function createMemberService(input: {
  squadId: string;
  mode: "fresh" | "derive";
  // fresh 模式
  name?: string;
  intro?: string;              // 一句话介绍；fresh 建 mate 必填（resolveEffective 校验非空，空→'intro required'→400）
  // [v0.0.33.3 step3] systemPrompt 移除（身份正文迁 squad_role mapper content fragment）
  // [v0.0.48] tools 字段移除（leader/mate 工具集 static-by-type 查 tool-policy.ts）；
  //   hireBody 不再接收 tools 字段（caller 传则忽略并 warn，不返 400）
  tools?: string[];            // [v0.0.48] accept-and-ignore（dead，不再写 member.tools）
  skillConfig?: { mode: "inherit" | "custom"; overrides: Record<string, boolean> }; // [v0.0.113] 缺省 = {mode:'inherit',overrides:{}}（新成员默认 off/继承全局）
  // [v0.0.155] model 字段硬删（A4）——hire 不再接收 model；新 member session 用 squad.modelDefault 作 fallback。
  // [v0.0.169] workStyle?: string（fresh 直传 trim 回写/空串=空串无 400/不传=缺省无）
  // derive 模式
  deriveFrom?: string;            // → member.id
  // [v0.0.169] derive 默认复制父 workStyle；overrides.workStyle 覆盖（trim 回写，空串=清空）
  // [v0.0.33.3 step3] derive 改配置继承（parent.{tools,model}，非 prompt 继承）
  // [v0.0.48] overrides.tools accept-and-ignore（dead）
  // [v0.0.113] derive 不再复制父 skillConfig（新成员默认 inherit；overrides.skillConfig 显式传才用）
  // [v0.0.114] intro：derive 继承父 intro（overrides.intro 优先，否则 parent.intro，父无则空串不写盘）
  // [v0.0.128] overrides 去 dead tools（对齐 squad_tools §2 hire 入参 + D4）
  // [v0.0.155] overrides 去 model（A4：member.model 硬删）
  overrides?: Partial<{ intro; workStyle; skillConfig }>; // [v0.0.169] 加 workStyle
}): Promise<{ memberId: string; sessionId: string }> {
  // 1. resolve effective 配置（fresh 直用 / derive 从父 member 复制 + overrides 覆盖）
  // 2. 校验 name 在 squad 内唯一（a2a 寻址要求）
  // 3. 建 member record（role=mate, state=deployed, squadId, deriveFrom 一次性记）
  // 4. 建 member session（[v0.0.56] role=mate, biz=studio, derivation=main, squadId, memberId, parentSessionId=null）
  //    - derive 复制父成员个人 AGENTS.md（非记忆）见 step7.5
  // 5. 回填 member.sessionId
  // 6. append squad.memberIds
  // 7. derive_academy 建 workspace 目录 + seed（AGENTS.md→.rocky/agents/{name}-{id}.md；skills/memory→团队层）
  // 7.5. derive（非 academy）：复制父成员个人 AGENTS.md（{parentName}-{parentId}.md → {childName}-{childId}.md）；父无 → 静默 no-op（不触发事务回滚，子继续用团队级 AGENTS.md 兜底）
  // 8. 任一步失败 → 补偿回滚（反向）
}
```

- **derive 后两 member 完全独立**——无后续联动（仅 hire 时一次性复制配置 + 个人差异 AGENTS.md；memory 已团队盘共享，不存在派生复制语义）。
- mate 不可改 role 为 leader（leader 是建队时唯一确定的）。

---

## 6. 边界 + 衔接

| 零件 | 归属 |
|---|---|
| Squad / Member SchemaDef + 双向关联规则 + 存储布局 + 建队/hire 事务 | 本文 ✅ |
| Squad / Member 概念（角色分工 / member 派生 / SquadChat EOS） | `[P1]squad_definition.md` |
| Session interface（含 bizType/squadId/memberId 增量字段） | `specs/tech/agent/session/[P0]session_store.md` |
| bizType 二分（playground|studio）+ 隔离规则 | `specs/tech/agent/session/[P0]session_biztype.md` |
| CrudStore FS engine + sharding 机制 | `specs/tech/persistence/[P0]fs_crud_store_engine.md` |
| Squad / Member HTTP API 端点 | 架构阶段产出 `specs/api/overall/` |

---

## 7. 待定（架构阶段细化，非阻塞）

1. **model 字段形态** ~~（待定）~~ → [v0.0.36] **已收敛：直接 provider model id（modelId 字符串）** → [v0.0.155] **member.model 硬删**（model 不再挂 member，挂 session/squad 作复合 `{providerId?, modelId}` ModelRef，见 `[P0]model_resolve.md §4 原则 3`）。
2. ~~**hire derive 模式 overrides 精确字段集**~~ **[v0.0.128] 已决**：`overrides = { name?, intro?, skillConfig? }`（[v0.0.155] 去 `model?`，member.model 硬删；[v0.0.128] 去 dead `tools`）。
3. ~~**bench 通知 user UI 形态**~~ **[v0.0.128] 已决**：不发系统消息/send_message，leader 在 caller session final text 告知 user（`squad_tools §2` bench 通知说明）。

---

---

> 变更历史见 [\`log.md\`](log.md)（本 KB 位置轴）+ [\`specs/tech/version_logs/vX.Y/change_log.md\`](../version_logs/)（跨版本发布说明）。
