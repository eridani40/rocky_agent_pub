# v0.0.298 change_plan — Squad Templates

> 架构期冻结的 method 级契约。coder 按此实现，reviewer 按此查偏离。

## T1 — 后端：模板读取 + Builtin 机制 + 从模板创建

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad_templates | app/server/src/services/squad-template-service.ts | ManifestSchema / MemberSpec / TemplateSummary | 新增 | 模板 manifest 类型定义（slug/name/description/leaderName/leaderIntro?/builtin/members[]） | ManifestSchema.members = MemberSpec[]；MemberSpec.skillConfig 形态对齐 MemberSkillConfig | specs/tech/squad/[P1]squad_templates.md §②；schema_defs/squad/member.ts MemberSkillConfig | +25 |
| squad_templates | app/server/src/services/squad-template-service.ts | templatesDir(root) | 新增 | 返回 `{root}/squad-templates` 路径（root = dataDir） | 纯函数，不 IO | specs/tech/squad §③模板目录结构 | +3 |
| squad_templates | app/server/src/services/squad-template-service.ts | listTemplates(root) | 新增 | 扫描 squad-templates/\*/manifest.json，读 manifest 返回 TemplateSummary[] | 目录不存在返空数组（不 throw）；manifest 读失败跳过+warn | specs/tech/squad §④ | +20 |
| squad_templates | app/server/src/services/squad-template-service.ts | getTemplate(root, slug) | 新增 | 读单个模板 manifest.json + 返回 ManifestSchema；不存在返 undefined | 路径校验（slug kebab-case，防 path traversal） | specs/tech/squad §② | +12 |
| squad_templates | app/server/src/services/squad-template-service.ts | applyTemplate(root, squadId, slug, deps) | 新增 | 读 manifest → 遍历 members 批量 createMemberService(fresh) → 复制配置文件 → 返回 {created:[],failed:[]} | MUST 复用 createMemberService（不绕过事务）；member hire 失败不中断（best-effort，记 failed）；文件复制用 cpSync/递归 merge（skills/memory/templates/commands merge 不覆盖，AGENTS.md 覆盖）；agent 文件改名 {role}-{memberId}.md；settings.json 仅目标不存在才复制 | specs/tech/squad §⑤；squad-service.ts createSquadService；member-service.ts createMemberService | +80 |
| squad_templates | app/server/src/handlers/squad-template-handler.ts | handleSquadTemplateRoute(deps) | 新增 | GET /squad-templates → 200+{items:TemplateSummary[]} | 只读，无副作用 | specs/api/overall/11b §1 | +30 |
| squad_templates | app/server/src/handlers/squad.ts | CreateSquadBody | 修改 | 新增 `templateSlug?: string` 字段 | optional；无值时行为不变（back-compat） | specs/api/overall/11b §2 | +2 |
| squad_templates | app/server/src/handlers/squad.ts | handleCreateSquad(req, deps) | 修改 | createSquadService 后，若 body.templateSlug 非空 → 调 applyTemplate；templateSlug 不存在→400 template_not_found | MUST 先 createSquad 成功再 applyTemplate（squad 已建好骨架目录）；applyTemplate 失败不回滚 squad（best-effort，返回已创建成员的 detail）；返回 toDetail 含全部 members | specs/tech/squad §⑤；handlers/squad.ts L317-351 handleCreateSquad | +15 |
| squad_templates | app/server/src/routes/squad-routes.ts | dispatchSquadRoutes(req, method, path, bs, dataDir) | 修改 | 新增 `/squad-templates` 前缀分发 → handleSquadTemplateRoute | MUST 放在 `/squad` 前缀匹配之前（`/squad-templates` startsWith `/squad` 会命中旧路由） | specs/api/overall/11b §1；routes/squad-routes.ts L43 | +5 |
| squad_templates | app/server/src/bootstrap/squad-templates-bootstrap.ts | syncBuiltinSquadTemplates(builtinsDir, dataDir) | 新增 | 扫描 `{builtinsDir}/squad-templates/*/manifest.json`，整体复制到 `{dataDir}/squad-templates/{slug}/`（覆盖 builtin:true 的） | MUST 只覆盖 builtin:true 模板（用户自定义不碰）；用 cpSync recursive 跟随 symlink；错误不阻断 bootstrap（console.warn） | specs/tech/squad §③ Builtin 机制 | +40 |
| squad_templates | app/server/src/bootstrap.ts | bootstrapBuiltinPlugins(dataDir) | 修改 | bootstrapPluginPhase 之后调 syncBuiltinSquadTemplates | builtinsDir = `path.resolve(__dirname, '../../plugins/builtins')`（与 bootstrapPluginPhase L58 一致） | bootstrap-plugin-phase.ts L58 | +3 |

### T1 文件级变更清单

| 文件 | 操作 | 变更内容 |
|---|---|---|
| services/squad-template-service.ts | 新增 | ManifestSchema/TemplateSummary 类型 + listTemplates/getTemplate/applyTemplate |
| handlers/squad-template-handler.ts | 新增 | handleSquadTemplateRoute（GET /squad-templates） |
| bootstrap/squad-templates-bootstrap.ts | 新增 | syncBuiltinSquadTemplates |
| handlers/squad.ts | 修改 | CreateSquadBody 加 templateSlug + handleCreateSquad 调 applyTemplate |
| routes/squad-routes.ts | 修改 | dispatchSquadRoutes 加 /squad-templates 分发 |
| bootstrap.ts | 修改 | 调 syncBuiltinSquadTemplates |

### T1 测试要求（UT）

- `listTemplates`：空目录返空数组；正常 manifest 返正确 TemplateSummary
- `getTemplate`：slug 存在/不存在；path traversal 防护（slug 含 `..` → 拒绝）
- `applyTemplate`：正常路径（hire + copy）；部分 hire 失败（best-effort，记 failed）；文件复制覆盖/merge 策略
- `handleCreateSquad` 带 templateSlug：成功（squad + members + files）；templateSlug 不存在 → 400
- `syncBuiltinSquadTemplates`：builtin 模板覆盖；用户自定义不被覆盖

---

## T2 — 前端：模板选择 UI

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-squad | app/web/src/components/studio-page/squad-types.ts | CreateSquadBody | 修改 | 新增 `templateSlug?: string` 字段 | optional back-compat | specs/api/overall/11b §2 | +1 |
| ui-squad | app/web/src/components/studio-page/squad-types.ts | TemplateSummary | 新增 | { slug, name, description, builtin, memberCount } interface | 对齐后端 GET /squad-templates 响应 | specs/api/overall/11b §1 | +8 |
| ui-squad | app/web/src/lib/squad-api.ts | listSquadTemplates() | 新增 | GET /squad-templates → TemplateSummary[] | 复用 req() 封装 | squad-api.ts L25 req() | +8 |
| ui-squad | app/web/src/components/studio-page/component-new-squad-modal.tsx | NewSquadModal | 修改 | 加模板 select（默认「无」）；选模板后预填 leaderName（可改） | MUST 保留 name/modelDefault/leader.name 必填校验；templateSlug 选「无」时不传（back-compat）；选模板时 leaderName 从 manifest.leaderName 预填但可编辑；useEffect 加载模板列表 | component-new-squad-modal.tsx L30-96 | +35 |

### T2 文件级变更清单

| 文件 | 操作 | 变更内容 |
|---|---|---|
| squad-types.ts | 修改 | CreateSquadBody 加 templateSlug + 新增 TemplateSummary |
| squad-api.ts | 修改 | 新增 listSquadTemplates() |
| component-new-squad-modal.tsx | 修改 | 模板 select + leaderName 预填 |

### T2 测试要求（UT）

- 无新增 UT 文件（前端组件测试现有未覆盖 NewSquadModal；跟随现有覆盖水平）
- 验证方式：ET 手动验证（NewSquadModal 选模板 → leader 名预填 → 创建成功 → members 列表完整）

---

## T3 — Builtin 模板打包：webapp-dev-team

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad_templates | app/plugins/dist/builtins/squad-templates/webapp-dev-team/manifest.json | (manifest) | 新增 | 11 mate 清单（name/intro/skillConfig） + leaderName=Darvin + builtin=true | members[] 11 项不含 leader；skillConfig 全 inherit | specs/tech/squad §② manifest schema | +1 file |
| squad_templates | app/plugins/dist/builtins/squad-templates/webapp-dev-team/AGENTS.md | (content) | 新增 | 团队规则泛化版 | MUST 保留流程骨架（状态机/质量三关/spec 驱动/测试驱动/file≤300 行/验证体系 UT→AT→ET）；MUST 泛化路径（不绑定 `tests/api/lib/run_all.sh` 等具体文件名，用「按项目测试框架执行」通用描述） | 当前 squad AGENTS.md（泛化编辑） | +1 file |
| squad_templates | app/plugins/dist/builtins/squad-templates/webapp-dev-team/.rocky/agents/{role}.md | (11 files) | 新增 | 11 个角色定义（prd/architect/planner/coder/code-reviewer/api-test-designer/api-test-executor/e2e-test-executor/verify-reviewer/researcher/doc-modifier） | 文件名用 {role}.md（如 prd.md）；内容从当前 squad .rocky/agents/ 对应文件泛化 | specs/tech/squad §② agent 文件命名 | +11 files |
| squad_templates | app/plugins/dist/builtins/squad-templates/webapp-dev-team/.rocky/skills/ | (dir) | 新增 | 11 个通用 skills（okf-skill/doc-specs/doctor/api-testing/playwright-cli/langfuse-verification/langfuse-fetcher/debug-agent-state-issue/dump-dev-html/front-end-design-prompt/performance-log-analysis） | 从当前 squad .rocky/skills/ 复制 | specs/tech/squad §② | +11 dirs |
| squad_templates | app/plugins/dist/builtins/squad-templates/webapp-dev-team/.rocky/memory/ | (dir) | 新增 | group memory（跨项目可复用经验教训） | 从当前 squad .rocky/memory/ 复制；去掉项目特定路径引用 | specs/tech/squad §② | +dir |
| squad_templates | app/plugins/dist/builtins/squad-templates/webapp-dev-team/.rocky/templates/ | (dir) | 新增 | 工作模板（change-plan/task-board 等） | 从当前 squad .rocky/templates/ 复制 | specs/tech/squad §② | +dir |
| squad_templates | app/plugins/dist/builtins/squad-templates/webapp-dev-team/.rocky/settings.json | (content) | 新增 | permissions 配置（allow/deny 列表） | 保留通用安全策略；attribution 可留空 | specs/tech/squad §② | +1 file |

### T3 泛化规则（MANDATORY — 模板内容与项目解耦）

模板内容的泛化分两类：

**A. 我们创造的概念 — 固定写死（我们说了算）**：
- 状态流转状态机（task: pending→coding→code_review→verifying→verified；phase: not_started→...→completed）
- 团队工作流（需求→调研→PRD→架构→测试计划→编码→审查→验证→文档→合并）
- 质量三关（coding→code-review→test）
- spec 驱动 + 测试驱动开发方法论
- 验证体系三层（UT→AT→ET）
- code-review 结构化检查清单
- 文件大小限制（≤300 行）、范围纪律
- task.json / task-board.md / context.md 结构

**B. 外部项目的东西 — 给默认但不强制（不绑定具体实现）**：
- 项目目录结构：建议默认 `specs/` 但不假设一定存在，用户项目有自己的目录就算了
- 测试框架：不假设是 vitest/jest/mocha，不假设有 `tests/api/` 目录；描述用「在项目测试框架下」
- 环境配置：不强制用户配 test.env / provider / secrets 才能工作；开箱即用
- 构建工具：不假设 bun/vite/electron
- 具体脚本路径：不写死 `tests/api/lib/run_all.sh`，用「按项目测试框架执行」

**C. 泛化编辑示例**：
- ❌ `bun --bun x vitest run` → ✅ 「按项目配置的测试命令执行单元测试」
- ❌ `bash tests/api/lib/run_all.sh` → ✅ 「在项目的 API 测试框架下执行」
- ❌ `specs/prd/version_logs/` → ✅ 「按团队规范在 specs 目录维护 PRD」
- ❌ `states/v{N}.{M}/task.json` → ✅ 「维护版本状态文件（task.json）」
- ❌ `.claude/` → ✅ `.rocky/`

**原则：模板开箱即用，新 squad 创建后不需要用户配任何东西就能开始工作。不能因为缺 test.env / 缺 tests/ 目录 / 缺 provider 配置就卡住。**

### T3 测试要求

- 无 UT（打包内容非代码逻辑）
- 验证：bootstrap 启动后 GET /squad-templates 能列出 webapp-dev-team；POST /squad 带 templateSlug=webapp-dev-team 成功创建 1+11 members 的 squad
