# Team Setup Guide — 从零搭建 Rocky 研发 squad 团队

> 本指南配套 `webapp-dev-squad-setup` skill。按步骤执行即可复刻「1 leader + 13 mate」的 {projectName} 研发团队结构。
> 模板源：`references/AGENTS.md.template` + `references/agents/*.template.md` + `references/templates/` + `references/commands/` + `references/settings.json.template`。

## 0. 前置

- 已创建目标 squad（`{squadRoot}` = squad 根目录，如 `{dataRoot}/squads/{squadId}/`）
- 确定 leader 名称（默认 `Darvin` 或按需改名，本指南用 `{leaderName}` 占位）
- 确定项目类型：**全新项目**（无 Claude Code 共同维护）或**迁移项目**（有 .claude/ 源，走 `cc-to-rocky-team` skill）

## 1. 创建 squad 根 AGENTS.md

```bash
cp references/AGENTS.md.template <squadRoot>/AGENTS.md
```

**说明**：这是**公共纪律**（全队共享）。leader 特有纪律在 `references/agents/leader.template.md`，不进本文件。

公共纪律涵盖：
- 双轨状态管理（task.json + task-board.md + context.md + bugs/ + verify/）
- Spec 驱动 + 测试驱动开发（概念先行 / 硬性规则 / PRD 参与边界）
- 文档产出链路（researcher → prd → arch → orchestrator → designer → coder → executor → doc-modifier）
- 持久化测试用例库（AT ≤20 / ET 3-5，核心冒烟集）
- 验证体系（三层：UT / AT / ET + 视觉保真度）
- 文件大小与输出控制（单文件 ≤300 行 / 单次输出 ≤10000 字符）
- `.rocky/` 目录写入限制（仅 commands / agents / skills）
- 长期记忆记录规范
- 重要原则（16 条）+ 范围纪律 / 不越界
- 测试运行规范（vitest 命令表 + 严禁命令）

## 2. hire 13 个 mate

**先 hire（拿 memberId）**，再复制个人 AGENTS.md。**hire 顺序建议**：先 hire 非 coder 角色，再 hire coder 实例（coder / coder2 / coder3）。

### hire 命令模板

```json
{
  "action": "team.hire",
  "mode": "custom",
  "name": "<agent-name>",
  "intro": "<一句话角色定位 + 关键纪律指针 + 引用 AGENTS.md>",
  "skillConfig": {"mode": "custom", "overrides": ""}
}
```

### 角色清单（name + intro + skillConfig）

| 顺序 | name | intro 示例 | skillConfig |
|---|---|---|---|
| 1 | prd | 产品经理。分析用户需求，设计产品功能，产出 PRD 到 specs/prd/。遵循 squad 团队 AGENTS.md + 个人 AGENTS.md；不编码、不越界。 | custom + doc_specs |
| 2 | architect | 架构师。基于 PRD 设计技术架构，产出 specs/tech/ + specs/api/ + change_plan + task.json。遵循团队+个人 AGENTS.md；不编码、不越界。 | custom |
| 3 | planner | 计划定义者。基于 PRD/技术设计创建任务列表 task.json（仅在 architect 未顺带产出时启用）。遵循团队+个人 AGENTS.md；不编码、不越界。 | custom |
| 4 | code-reviewer | 代码审核员。带结构化检查清单审查（文件体量/冗余/单一职责），可直接修复 Minor。遵循团队+个人 AGENTS.md；不越界。 | custom |
| 5 | api-test-designer | API 测试用例设计师（AT=tests/api，真实调 API）。按 case.yaml DSL 设计 case，断言基于 specs/api/ 契约。遵循团队+个人 AGENTS.md；不执行测试、不读产品代码。 | custom + api-testing |
| 6 | api-test-executor | API 测试执行者（AT=tests/api，真实调 API）。按 orchestrator 白名单跑 run_all.sh，读结果汇报。遵循团队+个人 AGENTS.md；不设计/不改 case、不读产品代码。 | custom |
| 7 | e2e-test-executor | E2E 测试执行者（agent 玩 app）。用 playwright-cli 按 case.md 真实操作 app，留证 + 自由心证。遵循团队+个人 AGENTS.md；不调试/不改 case/不 Read 截图。 | custom + playwright-cli |
| 8 | verify-reviewer | 验证审核员。审核三类验证覆盖度与真实性，用 see_image 审 E2E 截图。遵循团队+个人 AGENTS.md；仅 orchestrator 按需启用。 | custom + see_image |
| 9 | researcher | 竞品调研员。针对 feature 点深度调研 refs/，产出调研报告到 specs/research/。遵循团队+个人 AGENTS.md；不编码、不越界。 | custom + doc_specs |
| 10 | doc-modifier | 文档修正员。按需修改文档 / 版本完成后统一验收同步 specs。遵循团队+个人 AGENTS.md；不编码、不越界。 | custom + doc_specs |
| 11 | coder | 代码开发者。实现 task.json 任务，编写代码和单元测试。遵循团队+个人 AGENTS.md；守 change_plan 约束、偏离必报；不越界。 | custom + doc_specs |
| 12 | coder2 | 代码开发者（coder 实例2）。同 coder 模板，独立实例。 | custom + doc_specs |
| 13 | coder3 | 代码开发者（coder 实例3）。同 coder 模板，独立实例。 | custom + doc_specs |

> intro 长度：一句话角色定位（≤50 字），关键边界纪律（不写代码 / 不越界 / spec 先于实现），引用 AGENTS.md。**不要塞完整 prompt**（个人 AGENTS.md 自动注入）。

## 3. 复制个人 AGENTS.md 模板

拿到每个 mate 的 memberId 后：

```bash
DEST=<squadRoot>/.rocky/agents
mkdir -p $DEST
cp references/agents/leader.template.md             $DEST/{leaderName}-{leaderMemberId}.md
cp references/agents/prd.template.md                $DEST/prd-{prdMemberId}.md
cp references/agents/architect.template.md          $DEST/architect-{architectMemberId}.md
cp references/agents/planner.template.md            $DEST/planner-{plannerMemberId}.md
cp references/agents/coder.template.md              $DEST/coder-{coderMemberId}.md
cp references/agents/code-reviewer.template.md      $DEST/code-reviewer-{codeReviewerMemberId}.md
cp references/agents/api-test-designer.template.md  $DEST/api-test-designer-{apiTestDesignerMemberId}.md
cp references/agents/api-test-executor.template.md  $DEST/api-test-executor-{apiTestExecutorMemberId}.md
cp references/agents/e2e-test-executor.template.md  $DEST/e2e-test-executor-{e2eTestExecutorMemberId}.md
cp references/agents/verify-reviewer.template.md    $DEST/verify-reviewer-{verifyReviewerMemberId}.md
cp references/agents/researcher.template.md         $DEST/researcher-{researcherMemberId}.md
cp references/agents/doc-modifier.template.md       $DEST/doc-modifier-{docModifierMemberId}.md
# coder 多实例：复制同一份 coder.template.md
cp references/agents/coder.template.md              $DEST/coder2-{coder2MemberId}.md
cp references/agents/coder.template.md              $DEST/coder3-{coder3MemberId}.md
```

**命名规则**：`{name}-{memberId}.md`（ULID 形式 memberId 后缀，平台自动生成）。leader 文件用 `{leaderName}-{memberId}.md`。

## 4. 复制 templates / commands / settings

```bash
mkdir -p <squadRoot>/.rocky/templates <squadRoot>/.rocky/commands
cp references/templates/*.md references/templates/*.json <squadRoot>/.rocky/templates/
cp references/commands/*.md <squadRoot>/.rocky/commands/
cp references/settings.json.template <squadRoot>/.rocky/settings.json
```

模板清单：
- `change-plan-template.md` — 变更计划书（method 级 review 合同，8 列）
- `context-template.md` — 版本共享上下文
- `task-board-template.md` — 人类看板
- `task-template.json` — 机器状态源（task.json 格式）
- `verify-checkpoint-template.json` — 验证 checkpoint

## 5. 复制所需 skills（按项目需要）

skills 目录**不打包在本 skill 里**（独立可演进的知识资产）。新项目按需复制：

```bash
mkdir -p <squadRoot>/.rocky/skills
# 研发流水线核心 skill（从任一已验证 squad 复制）
cp -R <sourceSquad>/.rocky/skills/api-testing         <squadRoot>/.rocky/skills/
cp -R <sourceSquad>/.rocky/skills/doc_specs           <squadRoot>/.rocky/skills/
cp -R <sourceSquad>/.rocky/skills/okf-skill           <squadRoot>/.rocky/skills/
cp -R <sourceSquad>/.rocky/skills/playwright-cli      <squadRoot>/.rocky/skills/
cp -R <sourceSquad>/.rocky/skills/debug-agent-state-issue <squadRoot>/.rocky/skills/
# 按角色需求选择性复制
# doctor / dump-dev-html / front-end-design-prompt / langfuse-fetcher / langfuse-verification ...
```

**skill 依赖清单**（agent 模板 frontmatter 引用的）：
| 角色 | 依赖 skill |
|---|---|
| prd / architect / planner / coder / code-reviewer / researcher / doc-modifier | doc_specs |
| api-test-designer | api-testing |
| e2e-test-executor | playwright-cli |
| doc-modifier | okf-skill（tech spec 用 OKF） |
| 全队（按需） | debug-agent-state-issue / doctor / dump-dev-html 等 |

## 6. 路径修复 + 验证清单

### 路径修复

- 模板中无硬编码绝对路径（已脱敏）；检查 agent md 里引用的 `.rocky/skills/...` 路径与复制后的实际目录一致
- 替换 `{squadRoot}` / `{memberId}` / `{leaderName}` 占位符为实际值

### 验证清单

- [ ] `team.list` 看到 1 leader + 13 mate（11 角色 + 2 额外 coder 实例）
- [ ] 每个 mate 有个人 AGENTS.md（`{name}-{memberId}.md`），内容与模板一致
- [ ] squad 根 AGENTS.md 行数合理（公共纪律，不含 leader 特有）
- [ ] `.rocky/templates/` 5 个模板齐全
- [ ] `.rocky/commands/` 1 个 command
- [ ] `.rocky/settings.json` 就位（permissions 白名单齐全）
- [ ] `.rocky/skills/` 覆盖所有 agent frontmatter 引用的 skill（grep `skills:` vs 实际目录）
- [ ] 无残留敏感内容（模板中占位符 `{projectName}` / `{TEST_PROVIDER_ID}` 等已全部替换为实际项目值；grep `{projectName}` 在产出文件中无残留占位符）

## 7. 常见问题

### Q: 要不要 hire coder2/coder3？
A: 视并行度需求。**模板 1 个、实例可 N 个**——并行需要时 leader 可自主再 hire，无需问老板。初始搭建建议按标准 13 个（含 coder2/coder3）建齐，后续可 bench。

### Q: leader 个人 AGENTS.md 与 squad 根 AGENTS.md 怎么分？
A: 公共纪律（对全员有约束）→ squad 根；leader 特有（启动流程/委派/门禁/worktree 管理/合并）→ leader 个人。判断标准：**对所有 agent 都有约束 → 公共；只对 leader 有约束 → leader 个人**。

### Q: 与 cc-to-rocky-team 的区别？
A: `cc-to-rocky-team` = 从 Claude Code `.claude/` 迁移（1:1 复刻 + 精简，有源可抄）；`webapp-dev-squad-setup` = 从零搭建（无源，直接 hire + 复制脱敏模板）。迁移项目先走 cc-to-rocky-team，全新项目直接走本 skill。
