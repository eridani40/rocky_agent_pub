# v0.0.233 — derive_academy 派生升级：继承预检 + 同名裁决

> 类型：派生体验功能扩展（用户可感知：派生前看清「带什么」+ 同名项可逐项裁决）
> 权威 req：`reqs/[working] v0.0.233.derive_conflict_resolve/req.md`
> 用户决策原话：`states/user_query.md` v0.0.233 section
> 全量定义：`specs/prd/overall/12-academy.md` §12.15（本版本追加章节）
> 概念权威源（本 PRD 已读对齐）：
> - `specs/tech/academy/[P1]squad_derive.md`（**落后于代码**——仍 v0.0.210 个人盘设计 + §5.2「独立演化」对 skills/memory 已不成立；本 PRD 以 v0.0.232 现状为准，spec 由 doc-modifier 阶段 5 统一 reframe 到预检+裁决终态）
> - `specs/api/overall/11a-squad-endpoints.md` §2.1（`POST /squad/:id/member` mode='derive_academy' 现状）
> - `specs/ui/components/academy-page/component-derive-academy-picker.md`（From Classroom 二级 select 现状）
> - `specs/prd/overall/13-agent-definition.md`（v0.0.232 团队 ws 简化 + AGENTS.md/skills/memory 落点）

## 0. 决策基线（用户已锁定，本 PRD 不推翻）

| # | 决策 | 出处 |
|---|------|------|
| D1 | derive_academy 从「一次性自动 copy + 同名覆盖」升级为**继承预检 → 同名裁决 → 执行**三段 | 用户原话（user_query v0.0.233） |
| D2 | **继承页面预检**：From Classroom 选定 classroom/student/version 后、**派生前**展示「将带过去的东西」清单（学生 AGENTS.md / skills / memory）+ 预检 squad 团队盘同名项并标出 | user_query v0.0.233 决策 1 |
| D3 | **同名裁决默认不覆盖**（保留 squad 原有）；用户可**逐项**打开「覆盖」开关；**不同名直接 merge** | user_query v0.0.233 决策 2 |
| D4 | **memory 走同一套同名裁决**（不单独排除）；AGENTS.md 是个人差异文件（文件名带 memberId）天然无同名冲突，直接带 | user_query v0.0.233 决策 3 + req.md L24 |
| D5 | memory 落点不变（仍团队盘 group scope，全队共享），本版本**只加同名保护**，不改落点 / 不改共享语义 | req.md L25 + 13-agent-definition §13.2.3 |
| D6 | **不做 namespace 隔离**（接受「同名默认不覆盖 + 可选覆盖」，不按 member 名前缀隔离） | req.md L35 |
| D7 | derive mode（从 mate 派生）/ academy 训练引擎 / academy session 启动**不动**（本版本不波及） | req.md L33-34 + context.md findings |
| D8 | spec 同步放 doc-modifier 阶段 5 一起做（不单独先补 v0.0.232 现状，直接写终态） | req.md L26-30 |

## 1. 背景

### 1.1 问题（v0.0.232 重映射 seed 落点后浮现）

v0.0.232 把 squad session `workspaceDir` 统一团队盘（`squads/{sid}/`）后，derive_academy 的 seed 落点被重映射（`member-academy-bridge.ts seedMemberWorkspaceFromVersion`）：

- 学生 `AGENTS.md` → `squads/{sid}/.rocky/agents/{名字}-{memberId}.md`（member 私有个人差异文件）
- 学生 `.rocky/skills/**` → `squads/{sid}/.rocky/skills/`（**团队盘，全队共享**）
- 学生 `.rocky/memory/**` → `squads/{sid}/.rocky/memory/`（**团队盘 group scope，全队共享**）

现状 = 「一次性自动 copy + 同名覆盖」（`copyDirRecursive` 后者覆盖前者）。问题：多个 member 各自从不同学生派生、带同名 skill/memory 时，后者**静默覆盖**前者，用户无感知；且学生 memory 直接变团队共享记忆，可能污染其他 mate 行为。

### 1.2 产品解法（对应 overall §12.15）

把 derive_academy 从「一次性自动 copy」升级为**继承预检 → 同名裁决 → 执行**：派生前先读两侧（源 = 学生版本工作区；目标 = squad 团队盘），列清单 + 标同名 + 用户逐项裁决，再按裁决结果执行 seed。

## 2. 关键用户路径（MANDATORY — 测试最低覆盖）

每条路径 = 至少一个 UT 覆盖同名裁决逻辑（裁决为确定性文件操作，归 UT；本版本属普通 feature，按 CLAUDE.md「持久化测试用例库」铁律**不新增 AT/ET case**，回归冒烟集 + UT 即可）。

| # | 路径名 | 用户操作链路 | 预期结果 |
|---|---|---|---|
| **P1** | 全不同名 → 一键派生 | 选 classroom/student/version → 预览面板展示全部项标「新增」（无同名）→ 点「派生为成员」 | 派生执行：AGENTS.md 落个人差异文件、skills/memory 全部 merge 进团队盘（无同名跳过逻辑触发）；新 member session 启动后能读到这些 skills/memory |
| **P2** | 有同名 → 默认不覆盖直接派生 | 选 classroom/student/version（学生带的某 skill/memory 与 squad 团队盘同名）→ 预览面板同名项默认标「保留原 squad」→ 不改任何开关 → 点「派生为成员」 | 派生执行：同名项**跳过**（squad 团队盘原文件不动），不同名项 merge；用户可在派生后到团队盘验证原 skill/memory 内容未变 |
| **P3** | 有同名 → 逐项打开覆盖再派生 | 选 classroom/student/version（有同名）→ 预览面板同名项默认「保留原 squad」→ 用户逐项打开「覆盖」开关（开关变覆盖态）→ 点「派生为成员」 | 派生执行：打开覆盖的同名项被学生版本**替换**（squad 原文件被覆盖），未打开的保留；用户可在团队盘验证对应项已变为学生版本 |
| **P4** | memory 同名裁决 | 选 student/version（学生 memory 与 squad 团队盘 memory 同名）→ 预览面板该 memory 默认「保留原 squad」→ 打开覆盖 → 派生 | memory 走与 skill 同一套裁决：默认保留 / 可覆盖；落团队盘 group scope，其他 mate 共享读；同名 memory 默认不被覆盖（保护现行团队记忆） |
| **P5** | AGENTS.md 个人差异无冲突直接带 | 选 student/version（学生有 AGENTS.md）→ 预览面板 AGENTS.md 项标「将带入」（无同名开关）→ 派生 | AGENTS.md 落 `squads/{sid}/.rocky/agents/{名字}-{memberId}.md`（文件名带 memberId，天然无同名）；新 member session prompt 含该 AGENTS.md 正文（叠加在团队 AGENTS.md 之上，v0.0.232 机制） |

> P1-P5 同样覆盖到 overall §12.15.4 E2E Use Cases 表。

## 3. 范围边界

**IN（v0.0.233）**：
- 继承预检（读两侧、列清单、标同名）— 后端预检 endpoint + 前端预览面板
- 同名裁决（默认不覆盖 + 用户逐项可选覆盖 + 不同名直接 merge）— 裁决结果传 hire body、seed 按裁决执行
- memory 走同一套同名裁决（落点不变，只加保护）
- AGENTS.md 个人差异无冲突直接带（落点 v0.0.232 既定，本版本无变化）
- spec reframe（`[P1]squad_derive.md` + `11a-squad-endpoints.md` + `component-derive-academy-picker.md`）由 doc-modifier 阶段 5 统一写终态

**OUT（显式不做）**：
- derive mode（从 mate 派生）不动 — 配置继承不拷贝 ws 内容，v0.0.232 ws 改动与它无关；`inheritMemory` 仍是半成品，本版本不补
- academy 训练引擎不动 — 训练用 `version.workspaceDir`（`academy/{cid}/students/{sid}/versions/{label}/ws/` 独立目录树），不走 squad 团队盘
- 不做 namespace 隔离（不按 member 名前缀隔离 skills/memory）— 用户接受「同名默认不覆盖 + 可选覆盖」
- 不改 memory 落点 / scope 语义（仍团队盘 group scope 全队共享，v0.0.232 既定）
- 不改 AGENTS.md 个人差异落点 / 注入语义（v0.0.232 既定）
- 不补存量数据迁移（用户手动，平台不跑破坏性迁移）

## 4. 待架构实证事项（PRD 不决策，交架构阶段）

1. **预检 API 形态**：用独立 `POST /squad/:id/member/derive-academy/preview`（新 endpoint）还是在 `POST /squad/:id/member` body 加 `dryRun?` 字段 — 归 architect 落 `11a-squad-endpoints.md`。PRD 只要求「选定后能预览、能逐项裁决、裁决结果能传到 hire」。
2. **裁决结果 body schema**：裁决结果（per-item skip/overwrite 决策）如何传 hire body — 归 architect 落 api spec。PRD 只要求「默认全 skip 同名 + 用户可逐项改 overwrite」的语义能完整表达。
3. **预检读两侧的实现**：源 = `version.workspaceDir` 下 AGENTS.md / `.rocky/skills` / `.rocky/memory`；目标 = `squads/{sid}/.rocky/skills` + `squads/{sid}/.rocky/memory`（团队盘）— 复用 `seedMemberWorkspaceFromVersion` + `copyDirTracking` 现有读取能力，归 architect 落 tech spec。
4. **seed 失败补偿**：现状 `copyDirTracking` 记具体顶层项、补偿 rmSync force 不删团队根目录本身；加裁决后补偿按裁决结果 skip/overwrite 对应项 — 归 architect 落 tech spec（安全不变量：补偿绝不删 squad 团队盘 `.rocky/skills|.rocky/memory` 目录本身）。
