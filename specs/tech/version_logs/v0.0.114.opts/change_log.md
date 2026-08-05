# v0.0.114.opts — Tech Change Log（member intro 一句话介绍 + memory entry `description`→`intro` 全链路改名）

> 跨版本发布说明（版本轴）。本目录级变更见各 KB `log.md`（位置轴）：
> `specs/tech/squad/log.md`（块 1）+ `specs/tech/agent/memory/log.md` + `specs/tech/config/log.md`（块 2）。

## 概览

两块独立优化：
1. **块 1 — squad member 加 `intro` 一句话介绍**：让 Team Roster 花名册每个成员带角色职责简介，leader 安排工作 / mate 相互寻址时一眼识别谁负责什么（此前花名册只有 name/role/sessionId）。
2. **块 2 — memory entry `description` → `intro` 全链路改名**：一句话摘要字段原名 `description` 与 JSON-schema 关键字撞名（工具 inputSchema 里同名易混淆），改名 `intro` 消歧。**语义不变，纯改名**；读侧全链路兼容存量 `description`。

## §1 块 1：member intro（squad KB + api KB + ui/prd）

### 1.1 Member 加 `intro`（schema optional / 业务 required）

`Member` schema（`app/server/src/agent/schema_defs/squad/member.ts`）加 `intro: { type: 'string', required: false }`。刻意 **schema 宽容 + 业务收紧**：

- **fresh 建 mate — 必填**：`member-service.ts resolveEffective` 校验 `intro.trim()` 非空 → 空/缺 `throw 'intro required'`；`handlers/member.ts handleHire` 入参再校验一次 → 转 `400 intro required`（双层）。
- **leader 建队 — 代码固定文案**：`squad-service.ts` 模块内函数 `defaultLeaderIntro()` 返回 `'团队 leader，负责分配任务、与用户（老板）沟通定义目标和路径、评估工作是否完成等'`（非 LLM 生成、非从 `leader.md` frontmatter 派生），`createSquadService` 建 leader member 时填入。后续职能变化可通过 PATCH member intro 编辑。
- **derive — 继承父**：`resolveEffective` derive 分支 `derivedIntro = (overrides.intro ?? parent.intro ?? '').trim()`（override 优先，否则继承父，父无则空串降级）。
- **落盘**：`createMemberService` 仅 `intro !== ''` 时写字段（空串不写盘，保 optional 语义）。

**为什么 schema optional 而非 required**：Member 走 PATCH read-modify-write；若 schema `required=true`，历史无 intro 的 member record 一被 PATCH（改名/换 model）就因 schema 校验炸。schema 宽容 + 业务在创建入口收紧 = 新数据完整 + 不追溯报错既有数据。→ `specs/tech/squad/[P1]data_model.md §1.2 / §1.2a`

### 1.2 花名册渲染（squad prompt KB）

`app/plugins/builtins/rocky_context/prompt/team_roster.ts renderRoster`：行格式 `- {name}({role}) (sessionId: {sid}) — {intro}`。intro 随完整 MemberRecord 从 bootstrap → `config.studioContext.members` 整记录透传流入（mapper 不直接持 memberStore，依赖方向约束）；intro 缺省时优雅降级不显 ` — ` 分隔符。→ `specs/tech/squad/[P1]prompt_sections.md §3.2`

### 1.3 HTTP hire body（api KB）+ 前端表单

- `HireMemberBody.fresh` 加 **必填** `intro`（derive `overrides.intro` 可选）；`handlers/member.ts HireBody` 同步。
- **前端 HireModal fresh 表单**用 `intro` input 取代原 `systemPrompt` textarea——systemPrompt 从 hire body 移除（此前前端传 systemPrompt 但后端 fresh body 从不声明/消费，是历史遗留；旧 client 若仍传为未知字段静默丢弃，向后兼容）。i18n 加 `hireModal.freshIntroLabel/freshIntroPlaceholder`。
- **intro 可编辑（PATCH）**：`PatchMemberBody`（后端 `handlers/member.ts` + 前端 `squad-types.ts`）加 `intro?: string`；`handlePatchMember` 走 read-modify-write 更新（`trim()` 落库），提供空串 → `400 intro required`（与创建口径一致），不传不影响其他字段。前端在成员管理面板（`section-member-panel.tsx` `member-intro-input`）编辑。→ `specs/api/overall/11a-squad-endpoints.md §2.2`

### 1.4 顺带修 spec 残留

`[P1]squad_definition.md §3/§4` 概念 Member 仍列 `systemPrompt`（v0.0.33.3 已在 entity 层移除，概念表未清）——本次加 intro 同时清掉残留 systemPrompt，概念对齐 data_model。

## §2 块 2：memory entry `description` → `intro`（memory KB + config KB + api/ui/prd）

### 2.1 全链路改名 + 兼容读

字段改名贯穿全链路，**写侧只落 `intro`，读侧全兜底 `intro ?? description`** 容忍存量：

- **存储层**：`managed-store.ts parseEntry`（frontmatter `intro ?? description`）+ `serializeEntry`（落 `intro`）；`user-memory-service.ts readIntro(e) = e.intro ?? e.description`（app_config record entry）。
- **工具**：`memory-manage.ts` write payload `intro ?? description`、`toListMeta` 回 intro、inputSchema `entry.intro`；`memory.ts` search 回 name+intro；纯读工具 description 文案更新。
- **L0 注入**：`prompt/memory.ts formatL0` 输出 `- {name}: {intro}`。
- **HTTP**：`handlers/memory.ts` + `memory-helpers.ts coerceEntryInput/mergeEntry`（读侧兼容旧 description，写侧 intro）。
- **前端**：`memory-api.ts` + `component-memory-editor-modal.tsx`（state intro）+ `component-memory-entry-card.tsx`（渲染 entry.intro）+ i18n `introPlaceholder`。

### 2.2 testid 不改名（保 E2E 观测契约）

memory editor `{prefix}-editor-description` / entry card `{prefix}-entry-{name}-desc` **保留原 testid**——数据字段改名刻意不牵动 DOM 测试锚点，E2E 观测契约稳定。→ `specs/ui/components/chat-page/component-memory-editor-modal.md §4` + `component-memory-entry-card.md §4`

### 2.3 一次性迁移脚本

`app/server/src/memory/migrate-memory-intro.ts`：把存量落盘 `description` 迁到 `intro`——覆盖 session memory（per-session md frontmatter，重序列化 + `.pre-intro.bak` 备份）+ user memory（app_config `user_memory/default` entries[].description→intro）。

- **非破坏**：intro 承接 description 原值，值不丢；session 文件改前备份。
- **幂等**：已迁（无 description）跳过，可安全重跑。
- **不进 bootstrap**：手动 CLI（`bun run app/server/src/memory/migrate-memory-intro.ts [dataDir]`），遵循「运行时启动路径不做破坏性状态迁移」。
- **覆盖三环境**：test/dev/prod dataDir（`~/.rocky_agent_{env}`，homedir 展开，禁字面 ~）。

## §3 spec 同步清单

| KB / 目录 | 文件 | 变更 |
|---|---|---|
| squad tech | `[P1]data_model.md` | §1.2 Member 加 intro + 新增 §1.2a 设计决策；§4/§5 create 入参 |
| squad tech | `[P1]squad_definition.md` | §3 Member 加 intro + 清 systemPrompt 残留；§4 derive |
| squad tech | `[P1]prompt_sections.md` | §3.2 team_roster 渲染格式 |
| squad tech | `index.md` / `log.md` | ① 概念表 member 补 intro；log 记块 1 |
| memory tech | `[P0]memory_definition.md` | §3 entry schema intro + 改名/兼容读设计；§5/§6 |
| memory tech | `[P0]memory_manage_tool.md` | §2 entry.intro；§3 list meta |
| memory tech | `[P0]memory_injection.md` | §1/§3/§5 L0 注入 name+intro |
| memory tech | `[P0]memory_tool.md` | §1/§3 search 回 name+intro |
| memory tech | `index.md` / `log.md` | ① 概念表加 intro + ④ 原则 4；log 记块 2 + 迁移脚本 |
| config tech | `[P0]app_config.md` | §3.5 user_memory record 落盘键 intro + 兼容读 |
| config tech | `log.md` | 记 app_config 键改名 |
| api | `11a-squad-endpoints.md` | Member + HireMemberBody + hire 错误 |
| api | `15-memory-ui.md` | §2/§3/§4/§5 request/response intro + 兼容读 |
| ui | `component-memory-editor-modal.md` / `component-memory-entry-card.md` / `section-memory-panel.md` | 字段列表 intro + testid 保留说明 |
| prd | `09-memory.md` | L0 注入 name+intro |
