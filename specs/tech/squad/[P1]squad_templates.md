---
type: spec
title: Squad Templates — 模板定义 + 从模板创建
priority: P1
updated: 2026-08-08
---

# Squad Templates

## ① 是什么

Squad Template = **可复用的 squad 配置包**——把一个配置好的 squad（AGENTS.md + .rocky/{agents,skills,memory,templates,commands,settings.json} + member 清单）打包成模板，用户创建新 squad 时可选「从模板创建」，一键得到结构完整、团队就绪的 squad（leader + N mate + 全部配置文件）。

| 概念 | 说明 |
|---|---|
| **template** | 模板（slug 目录下 manifest.json + 配置文件） |
| **builtin template** | 随 app 打包的模板（builtin:true，bootstrap 时复制到用户目录） |
| **manifest.json** | 模板元信息 + mate 清单（name/intro/skillConfig） |
| **从模板创建** | POST /squad 带 templateSlug → 建 squad + leader + 批量 hire + 复制配置文件 |

## ② 数据模型

### 模板目录结构

```
~/.rocky_agent_prod/squad-templates/{slug}/
├── manifest.json          # 元信息 + mate 清单
├── AGENTS.md              # 团队规则（直接复制到 squad 根）
├── .rocky/
│   ├── agents/            # {role}.md（如 prd.md, coder.md...）
│   ├── skills/            # 通用 skills
│   ├── memory/            # group memory
│   ├── templates/         # 工作模板
│   ├── commands/          # 命令文件
│   └── settings.json      # permissions 配置
```

### manifest.json schema

```json
{
  "slug": "webapp-dev-team",
  "name": "WebApp Dev Team",
  "description": "完整的 WebApp 研发团队：PRD → 架构 → 编码 → 审查 → 测试 → 交付",
  "leaderName": "Darvin",
  "leaderIntro": "团队 leader，负责分配任务、与用户沟通定义目标和路径",
  "builtin": true,
  "members": [
    { "name": "prd", "intro": "产品经理...", "skillConfig": { "mode": "inherit", "overrides": {} } },
    { "name": "architect", "intro": "架构师...", "skillConfig": { "mode": "inherit", "overrides": {} } }
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| slug | string | 唯一标识（kebab-case，= 目录名） |
| name | string | 显示名 |
| description | string | 一句话描述 |
| leaderName | string | 预填 leader 名（用户可改） |
| leaderIntro | string? | 预填 leader intro（可选） |
| builtin | boolean | 是否 builtin（随 app 打包） |
| members | MemberSpec[] | mate 清单（不含 leader） |

MemberSpec:

| 字段 | 类型 | 说明 |
|---|---|---|
| name | string | mate name（如 `prd`、`coder`） |
| intro | string | 一句话介绍 |
| skillConfig | MemberSkillConfig | skill 叠加配置 |

### agent 文件命名

模板中 agent 文件用 **{role}.md**（如 `prd.md`、`coder.md`），不含 memberId。

创建 squad 时复制到 `.rocky/agents/{name}-{memberId}.md`（按 createMemberService 返回的 memberId 改名）。

## ③ Builtin 机制

### 打包位置

```
app/plugins/builtins/squad-templates/{slug}/
```

与现有 `app/plugins/builtins/skills/` 同层（builtin skills 目录）。`builtinsDir` 解析路径 = `path.resolve(__dirname, '../../plugins/builtins')`，与 `bootstrap-plugin-phase.ts` 一致。

### Bootstrap 复制

bootstrap 阶段（bootstrapPluginPhase 之后、store phase 之前），扫描 `app/plugins/builtins/squad-templates/*/manifest.json`，将每个 builtin 模板**整体复制**到 `~/.rocky_agent_prod/squad-templates/{slug}/`：

- 覆盖策略：builtin 模板始终覆盖用户目录同名 slug（保证 builtin 最新版生效）
- 用户自定义模板（builtin:false）不被覆盖
- 复制逻辑用 `cpSync(..., { recursive: true, dereference: true })`（跟随 symlink，解引用，对齐 `cp -rL` 语义）

### 时序

```
bootstrapPluginPhase → squadTemplatesBootstrap → bootstrapStorePhase → ...
```

squadTemplatesBootstrap 只需 dataDir（确定 `~/.rocky_agent_prod/` 根）+ builtinsDir（`__dirname` 相对解析）。无依赖，可放在 plugin phase 之后任意位置。

## ④ 模板列出 API

`GET /squad-templates` → 200 + `{ items: TemplateSummary[] }`

TemplateSummary:

| 字段 | 类型 | 说明 |
|---|---|---|
| slug | string | 唯一标识 |
| name | string | 显示名 |
| description | string | 描述 |
| builtin | boolean | 是否 builtin |
| memberCount | number | mate 数量（不含 leader） |
| leaderName | string | 预填 leader 名（UI 预填用，来自 manifest.leaderName） |

实现：扫描 `~/.rocky_agent_prod/squad-templates/*/manifest.json`，读 manifest 取字段，memberCount = members.length。

## ⑤ 从模板创建 squad（核心流程）

### POST /squad 扩展

请求体增加可选字段 `templateSlug?: string`。有值时在正常建 squad + leader 之后，执行模板应用。

### 流程

```
POST /squad { name, modelDefault, leader:{name}, templateSlug }
  │
  ├── 1. createSquadService（建 squad + leader + squadChat + 目录骨架）
  │      leader.name 用用户填的（不强制用模板 leaderName）
  │
  ├── 2. 读模板 manifest.json（从 squad-templates/{templateSlug}/）
  │      templateSlug 不存在 → 400 template_not_found
  │
  ├── 3. 遍历 manifest.members，批量 createMemberService(mode=fresh)
  │      每个 member：name + intro + skillConfig 来自 manifest
  │      失败不中断（best-effort）：记 failed[] 列表
  │
  ├── 4. 复制模板配置文件到新 squad 目录
  │      AGENTS.md → squad 根（覆盖默认空文件）
  │      .rocky/agents/{role}.md → .rocky/agents/{name}-{memberId}.md
  │      .rocky/skills/ → .rocky/skills/（merge，不覆盖已有）
  │      .rocky/memory/ → .rocky/memory/
  │      .rocky/templates/ → .rocky/templates/
  │      .rocky/commands/ → .rocky/commands/
  │      .rocky/settings.json → .rocky/settings.json（如不存在才覆盖）
  │
  └── 5. 201 + SquadDetail（含全部 members）
```

### agent 文件改名映射

步骤 3 中 createMemberService 返回 `{ member, sessionId }`，member.id = memberId。
步骤 4 中按 `{member.name}-{member.id}.md` 匹配模板 `{role}.md`（role = member.name）。

```
模板 prd.md → .rocky/agents/prd-{memberId}.md
模板 coder.md → .rocky/agents/coder-{memberId}.md
```

### 复制策略

- `AGENTS.md`：覆盖（模板的 AGENTS.md 是核心团队规则）
- `.rocky/agents/{role}.md`：逐文件复制（改名 {role}-{memberId}.md）
- `.rocky/skills/`：递归复制，**merge 不覆盖**（新 squad 可能有其他 skills）
- `.rocky/memory/`：递归复制，merge
- `.rocky/templates/`：递归复制，merge
- `.rocky/commands/`：递归复制，merge
- `.rocky/settings.json`：**如目标不存在才复制**（不覆盖用户已有 settings）

### 错误处理

- `templateSlug` 对应目录/manifest 不存在 → 400 `template_not_found`
- manifest.json 格式错误 → 400 `invalid_template`
- 批量 hire 某个 member 失败（如 name 冲突）→ **不中断**，记 failed，返回 SquadDetail 带 partial 状态
- 文件复制失败 → best-effort（console.warn，不阻断）

## ⑥ 实现拆分

### 新增文件

| 文件 | 职责 | 行数 |
|---|---|---|
| `services/squad-template-service.ts` | 模板读取（list/get manifest）+ 应用（hire + copy） | 270 |
| `handlers/squad-template-handler.ts` | GET /squad-templates handler | 29 |
| `bootstrap/squad-templates-bootstrap.ts` | builtin 模板复制（bootstrap 期） | 45 |

### 修改文件

| 文件 | 变更 |
|---|---|
| `handlers/squad.ts` | CreateSquadBody 加 templateSlug?；handleCreateSquad 调 templateService |
| `routes/squad-routes.ts` | 新增 `/squad-templates` 前缀分发 |
| `bootstrap.ts` 或 `bootstrap-plugin-phase.ts` | 调 squadTemplatesBootstrap |
| 前端 `squad-types.ts` | CreateSquadBody 加 templateSlug?；新增 TemplateSummary 类型 |
| 前端 `squad-api.ts` | 新增 listSquadTemplates() |
| 前端 `component-new-squad-modal.tsx` | 加模板 select + leader 名预填 |
| 前端 `use-squad-mutations.ts` | 无变更（handleCreateSquad 透传 body） |

## ⑦ 文件级变更清单

| 文件 | 操作 | 变更内容 |
|---|---|---|
| app/server/src/services/squad-template-service.ts | 新增 | `SquadTemplateService`：listTemplates / getTemplate / applyTemplate（hire + copy files） |
| app/server/src/handlers/squad-template-handler.ts | 新增 | `handleSquadTemplateRoute`：GET /squad-templates |
| app/server/src/bootstrap/squad-templates-bootstrap.ts | 新增 | `syncBuiltinSquadTemplates(builtinsDir, dataDir)`：扫描 builtin 模板 → cp 到用户目录 |
| app/server/src/handlers/squad.ts | 修改 | `CreateSquadBody` 加 `templateSlug?`；`handleCreateSquad` 调 `applyTemplate` |
| app/server/src/routes/squad-routes.ts | 修改 | `dispatchSquadRoutes` 新增 `/squad-templates` 前缀 → `handleSquadTemplateRoute` |
| app/server/src/bootstrap.ts | 修改 | 调 `syncBuiltinSquadTemplates`（plugin phase 之后） |
| app/web/src/components/studio-page/squad-types.ts | 修改 | `CreateSquadBody` 加 `templateSlug?`；新增 `TemplateSummary` interface |
| app/web/src/lib/squad-api.ts | 修改 | 新增 `listSquadTemplates()` 函数 |
| app/web/src/components/studio-page/component-new-squad-modal.tsx | 修改 | 加模板 select 下拉 + leader 名预填逻辑 |
| app/plugins/builtins/squad-templates/webapp-dev-team/ | 新增 | 第一个 builtin 模板（manifest.json + AGENTS.md + .rocky/） |
