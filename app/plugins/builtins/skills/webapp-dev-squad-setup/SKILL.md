---
name: webapp-dev-squad-setup
description: '从零搭 webapp 研发 squad：AGENTS.md+12角色+skills/templates'
source: agent
production_method: consolidation
evolvable: true
updated: '2026-08-08T12:50:00.000Z'
---
# webapp-dev-squad-setup — 从零搭建 Rocky webapp 研发 squad 团队

> 把一套已验证的 {projectName} 研发团队配置打包成标准模板包：**公共 AGENTS.md（团队纪律）+ leader 个人 AGENTS.md + 11 个 mate 角色个人 AGENTS.md + 项目无关 skills/templates/commands + settings.json**。任何新项目用它快速复刻同样的团队结构。
>
> 与 `cc-to-rocky-team` 的分工：cc-to-rocky-team 是「Claude Code 团队配置 → Rocky 迁移」的方法论（1:1 复刻 + 精简）；本 skill 是「从零搭建 Rocky 原生研发 squad」的标准模板包（不依赖 .claude/ 源，直接 hire + 复制模板）。

## 1. 何时加载（触发条件）

- 老板说：「**新建一个研发 squad 团队**」「**从零搭一个 rocky 研发团队**」「**照这套配置再建一个团队**」
- 需要快速复刻「1 leader（orchestrator）+ 11 角色 mate（coder 可多实例）」的研发流水线团队结构
- 需要把已验证的研发纪律（双轨状态 / spec 驱动 / 质量三关 / 文档产出链路）迁移到新项目

## 2. 团队结构概览

**1 leader（orchestrator）+ 13+ mate（11 个角色 + coder/code-reviewer 可多实例）**：

| 角色 | 职责 | 实例数 |
|---|---|---|
| leader（orchestrator） | 接需求、拆分、委派、裁决、门禁 | 1（唯一） |
| prd | 产品经理：需求 → PRD（specs/prd/） | 1 |
| architect | 架构师：PRD → tech/api spec + change_plan + task.json | 1 |
| planner | 计划定义者：创建 task.json（architect 未顺带产出时启用） | 1 |
| coder | 代码开发者：实现 task.json 任务 + 单元测试 | **N（可多实例）** |
| code-reviewer | 代码审核员：结构化检查清单审查 + 直接修 Minor | **N（可多实例）** |
| api-test-designer | API 测试用例设计师（case.yaml DSL，不执行） | 1 |
| api-test-executor | API 测试执行者（跑 run_all.sh，真实调 API） | 1 |
| e2e-test-executor | E2E 测试执行者（playwright-cli 玩 app，留证 + 心证） | 1 |
| verify-reviewer | 验证审核员（按需启用，see_image 审截图） | 1 |
| researcher | 竞品调研员：深度调研 refs/ → specs/research/ | 1 |
| doc-modifier | 文档修正员：按需改文档 + 版本完成后统一验收 | 1 |

**模板 vs 实例（关键概念）**：`references/agents/{role}.template.md` 是**角色模板**（一份）；`team.hire` 出的 mate 是模板的**实例**（每实例带独立 memberId + sessionId）。**模板 1 个、实例可 N 个**——并行需要时 leader 可自主再 hire 同模板第二/第三实例（如 coder2/coder3、code-reviewer2），共享模板定义、独立干活，无需问老板。**leader/orchestrator 只能 1 个**；其余角色（coder、code-reviewer 等审核/执行类）可多实例——**哪个工种成为瓶颈就扩哪个工种的实例**（老板 2026-08-06 授权）。

## 3. 执行步骤（zip 解压 → setup → hire → setup → clean）

> **核心设计**：所有模板打成一个 `squad-template.zip`（含 setup/clean 脚本 + 全部模板 + 11 skills）。agent 解压到临时目录，跑脚本操作，完事清理。不依赖 asar 文件读取。
>
> **占位符**：`{skillDir}` = `skill` 工具返回的 skillDir；`{squadRoot}` = 目标 squad 根；`{projectName}` = 项目名（如 `myapp`）。

### Step 1：解压 zip 到临时目录

```
skill(action="read", name="webapp-dev-squad-setup")
→ 拿到 skillDir

bash(command="TMP=$(mktemp -d /tmp/squad-setup-XXXXXX) && unzip -q {skillDir}/references/squad-template.zip -d $TMP && echo $TMP")
→ 拿到临时目录路径（记为 {tmpDir}）
```

### Step 2：init — 一键创建全部文件基础设施（hire 前）

```
bash(command="bash {tmpDir}/setup-squad.sh init {squadRoot} {dataDir} {projectName}")
```

init 自动完成：AGENTS.md + 5 templates + 1 command + settings + 11 skills（`{projectName}` 全替换）。

### Step 3：hire 13 个 mate（工具调用，不能脚本化）

```
team(action="hire", mode="fresh", name="prd", intro="产品经理。分析用户需求，设计产品功能，产出 PRD 到 specs/prd/。遵循 squad 团队 AGENTS.md + 个人 AGENTS.md；不编码、不越界。", skillConfig={mode:"inherit"})
team(action="hire", mode="fresh", name="architect", intro="架构师。基于 PRD 设计技术架构，产出 specs/tech/ + specs/api/ + change_plan + task.json。遵循团队+个人 AGENTS.md；不编码、不越界。", skillConfig={mode:"inherit"})
team(action="hire", mode="fresh", name="planner", intro="计划定义者。基于 PRD/技术设计创建任务列表 task.json（仅在 architect 未顺带产出时启用）。遵循团队+个人 AGENTS.md；不编码、不越界。", skillConfig={mode:"inherit"})
team(action="hire", mode="fresh", name="code-reviewer", intro="代码审核员。带结构化检查清单审查（文件体量/冗余/单一职责），可直接修复 Minor。遵循团队+个人 AGENTS.md；不越界。", skillConfig={mode:"inherit"})
team(action="hire", mode="fresh", name="api-test-designer", intro="API 测试用例设计师（AT=tests/api，真实调 API）。按 case.yaml DSL 设计 case，断言基于 specs/api/ 契约。遵循团队+个人 AGENTS.md；不执行测试、不读产品代码。", skillConfig={mode:"inherit"})
team(action="hire", mode="fresh", name="api-test-executor", intro="API 测试执行者（AT=tests/api，真实调 API）。按 orchestrator 白名单跑 run_all.sh，读结果汇报。遵循团队+个人 AGENTS.md；不设计/不改 case、不读产品代码。", skillConfig={mode:"inherit"})
team(action="hire", mode="fresh", name="e2e-test-executor", intro="E2E 测试执行者（agent 玩 app）。用 playwright-cli 按 case.md 真实操作 app，留证 + 自由心证。遵循团队+个人 AGENTS.md；不调试/不改 case/不 Read 截图。", skillConfig={mode:"inherit"})
team(action="hire", mode="fresh", name="verify-reviewer", intro="验证审核员。审核三类验证覆盖度与真实性，用 see_image 审 E2E 截图。遵循团队+个人 AGENTS.md；仅 orchestrator 按需启用。", skillConfig={mode:"inherit"})
team(action="hire", mode="fresh", name="researcher", intro="竞品调研员。针对 feature 点深度调研 refs/，产出调研报告到 specs/research/。遵循团队+个人 AGENTS.md；不编码、不越界。", skillConfig={mode:"inherit"})
team(action="hire", mode="fresh", name="doc-modifier", intro="文档修正员。按需修改文档 / 版本完成后统一验收同步 specs。遵循团队+个人 AGENTS.md；不编码、不越界。", skillConfig={mode:"inherit"})
team(action="hire", mode="fresh", name="coder", intro="代码开发者。实现 task.json 任务，编写代码和单元测试。遵循团队+个人 AGENTS.md；守 change_plan 约束、偏离必报；不越界。", skillConfig={mode:"inherit"})
team(action="hire", mode="fresh", name="coder2", intro="代码开发者（coder 实例2）。同 coder 模板，独立实例。", skillConfig={mode:"inherit"})
team(action="hire", mode="fresh", name="coder3", intro="代码开发者（coder 实例3）。同 coder 模板，独立实例。", skillConfig={mode:"inherit"})
```

### Step 4：agents — 一键植入全部 agent AGENTS.md（hire 后）

```
bash(command="bash {tmpDir}/setup-squad.sh agents {squadRoot} {projectName} \
  {leaderName}:{leaderMemberId} \
  prd:{prdMemberId} architect:{architectMemberId} planner:{plannerMemberId} \
  code-reviewer:{codeReviewerMemberId} api-test-designer:{apiTestDesignerMemberId} \
  api-test-executor:{apiTestExecutorMemberId} e2e-test-executor:{e2eTestExecutorMemberId} \
  verify-reviewer:{verifyReviewerMemberId} researcher:{researcherMemberId} \
  doc-modifier:{docModifierMemberId} coder:{coderMemberId} \
  coder2:{coder2MemberId} coder3:{coder3MemberId}")
```

### Step 5：clean — 清理临时目录

```
bash(command="bash {tmpDir}/clean-squad.sh {tmpDir}")
```

### Step 6：验证

```
team(action="list") → 确认 1 leader + 13 mate = 14 人
```

### 模板植入清单（每个文件复制后需调整的占位符）

> 模板里所有纪律、流程、验证体系、测试规范都是**项目无关的通用方法论**——只有 `{projectName}` 占位符需要按项目替换。

| 文件 | 需替换占位符 | 说明 |
|------|-------------|------|
| **AGENTS.md.template** | `{projectName}` × 5 处 | 标题、描述、ET DATA_DIR ×3 |
| **leader.template.md** | `{projectName}` × 1 处 | 打包产物名 `{projectName}-{version}-arm64.dmg` |
| **api-test-designer.template.md** | `{TEST_PROVIDER_ID}` ×1、`{TEST_MODEL_ID}` ×1 | test pool ULID + 厂商模型名 |
| **其余 agent 模板** | 无 | 完全通用，直接 write |
| **templates/commands/settings** | 无 | 完全通用，直接 write |

## 4. 关键陷阱清单

### 坑 1：只放 `.md` 不 hire
**反例**：把 agent md 放进 `.rocky/agents/` 但没调 `team.hire`——平台不知道有这些人。
**正解**：必须先 `team.hire` 拿 memberId + sessionId，再复制个人 AGENTS.md。

### 坑 2：把完整 agent prompt 塞进 intro
**反例**：intro 字段塞 1000 字完整 prompt。
**正解**：intro 是一句话角色定位，**完整角色纪律通过 squad 团队级 + 个人 AGENTS.md 自动注入**。

### 坑 3：审核/执行类工种单实例成瓶颈
**反例**：任务并行时 coder/code-reviewer 只 1 个，其他任务排队等（review 排队、编码排队）。
**正解**：**模板 1 个、实例可 N 个**——并行/瓶颈时 leader 自主 hire 同模板新实例（coder2/coder3、code-reviewer2，复制模板改名新 memberId），哪个工种堵了扩哪个。

### 坑 4：复制模板时带了 memberId 后缀
**反例**：直接 `cp` 源 agent 文件（含旧 memberId），新成员文件仍带旧 ID。
**正解**：用本 skill 的 `references/agents/*.template.md`（已脱敏），复制后按新 memberId 命名。

### 坑 5：bench 后立刻 hire 同名
**反例**：bench prd 后立刻 hire prd → `member_name_conflict`。
**正解**：bench 后 rm `members/{oldId}.json` + sleep 5+ 秒，再 hire。

## 5. 配套资源

- `references/team-setup-guide.md` — 详细搭建指南（hire 命令示例 / 角色 intro / skillConfig / 验证清单）
- `references/AGENTS.md.template` — squad 根公共纪律模板
- `references/agents/` — leader + 11 角色个人 AGENTS.md 模板（脱敏）
- `references/templates/` — 5 个状态模板（change-plan / context / task-board / task / verify-checkpoint）
- `references/commands/` — optimize-agent-prompt command
- `references/settings.json.template` — 平台设置模板（权限白名单）
- `references/setup-squad.sh` — dev 模式快捷脚本（自动完成 Step 1 + Step 4）
- `cc-to-rocky-team` — 从 Claude Code 迁移团队配置到 Rocky 的方法论（互补）

## 6. 反例（绝对禁止）

- ❌ **不读 references/team-setup-guide.md 就动手** —— 先摸清 13 个 mate 的 name/intro/skillConfig 再 hire
- ❌ **只放 `.md` 不 hire** —— 平台不知道有人
- ❌ **复制源 agent 文件（带旧 memberId）** —— 必须用脱敏模板 + 新命名
- ❌ **coder 只当单实例** —— 并行时自主 hire 多 coder 实例
- ❌ **bench 后立刻 hire 同名** —— 必 sleep 或 rm JSON
- ❌ **把 leader 特有纪律写进 squad 根 AGENTS.md** —— 公共/个人分层（leader 特有 → leader 个人文件）

## 7. 首次配置检查（MANDATORY — 团队搭建后第一次跑 AT/ET 前）

> AT/ET 依赖外部配置（provider keys、test.env、技术配置），新项目第一次跑验证时必然缺失。
> **团队搭建完成（Step 1-5）后，第一次进入验证阶段前，leader 必须检查以下依赖并指引用户配置。**

### 配置链路（AT/ET 共用）

```
tests/test.env (committed schema, 无 secrets)
  ├─ 端口/DATA_DIR/启停命令
  ├─ TEST_PROVIDER_ID=01JV... (provider ULID — 指路 id，非密钥)
  └─ TEST_MODEL_ID={TEST_MODEL_ID} (厂商模型名字符串)

~/.{projectName}_test/app_config/  (test provider pool, gitignored)
  ├─ providers/app_config/<ULID>.json  ← 真密钥在这里 (data.credentials.key)
  ├─ default_models/                   ← 避免每个 case 手选模型
  ├─ web_search/                       ← web_search 工具配置
  └─ ...                               ← 其他 app_config 子目录

~/.{projectName}/test.secrets.env (可选, gitignored)
  └─ 额外环境变量 (大多数项目不需要, provider key 已在 pool JSON 里)

~/.{dataDir}/app_config/  (AT env_start 用 cp -rL copy 这 5 组)
  ├─ web_search / see_image / runtime / web / consolidation
  └─ (dev 环境运行过一次后自动生成)
```

**关键理解**：provider 的真密钥（如 minimax API key）存在 provider pool 的 JSON 文件里（`data.credentials.key`），server 自己读取，测试脚本永不碰。test.env 里的 `TEST_PROVIDER_ID` 只是「指路 id」（告诉 server 用哪个 provider），不是密钥本身。

### 检查清单（第一次跑 AT/ET 前 leader 逐项检查）

| # | 依赖项 | 位置 | 检查命令 | 缺失时处理 |
|---|--------|------|----------|-----------|
| 1 | test.env | `tests/test.env` | `[ -f tests/test.env ]` | 从 {projectName} 模板复制，按项目端口调整 |
| 2 | TEST_PROVIDER_ID / TEST_MODEL_ID | test.env 内 | `grep TEST_PROVIDER tests/test.env` | **问用户**：provider ULID + 模型名因项目不同，必须改 |
| 3 | test provider pool | `~/.{projectName}_test/app_config/providers/` | `[ -d ~/.{projectName}_test/app_config/providers ]` | **问用户**：需要配置 provider JSON（含密钥），见下方「provider pool 配置指引」 |
| 4 | test default_models | `~/.{projectName}_test/app_config/default_models/` | `[ -d ~/.{projectName}_test/app_config/default_models ]` | 从 dev 环境 copy 或手动创建 |
| 5 | dev 技术配置（仅 AT） | `~/.{dataDir}/app_config/` | `[ -d ~/.{dataDir}/app_config ]` | 提示用户运行一次 dev 环境生成 |

### provider pool 配置指引（问用户时的操作步骤）

新项目没有 provider pool 时，leader 指引用户：

1. **最简路径**：在 Rocky app 里（dev 环境）添加一个 provider（如 minimax），填入 API key → app 自动生成 provider JSON 到 `~/.{dataDir}/app_config/providers/`
2. **复制到 test pool**：`cp -r ~/.{dataDir}/app_config/providers ~/.{projectName}_test/app_config/providers`
3. **更新 test.env**：把 provider JSON 文件名里的 ULID 填入 `TEST_PROVIDER_ID`，模型名填入 `TEST_MODEL_ID`
4. **default_models**：`cp -r ~/.{dataDir}/app_config/default_models ~/.{projectName}_test/app_config/default_models`（让 test 环境有默认模型，不用每个 case 手选）

### 429 skip 机制（无需配置，了解即可）

minimax 等 provider 限流时返回 429/529/503 → AT case 自动标 `skipped, reason=429`（不重试不阻塞）。换 provider 需手改 case.yaml 的 providerId/modelId（框架不支持自动 fallback）。

**原则**：不默认配置已就绪，不静默跳过验证。缺什么问什么，配置齐了才跑。

## 8. 运维经验沉淀（v0.0.270+ 实战）

### 工作分支（不硬编码）
- **用 `git branch --show-current` 获取当前分支**，不硬编码 dev1/main。leader AGENTS.md / 合并指令 / worktree 操作里所有「dev1」已泛化为「当前工作分支」。
- 创建 worktree 时 `git branch feat/0.0.XXX`（不 checkout）→ `git worktree add`（避免「branch already used」错误）

### 测试分配（MANDATORY）
- **每个 coding 任务必须带 UT**（bun --bun 全绿 + tsc 0 error），无豁免（基础设施改动也要 UT）
- **AT/ET 按版本验证执行标准派**：改了后端逻辑→默认走 AT；纯 UI→默认 ET 看一眼；很小改动（改文案/调样式）才可豁免，豁免在 test-plan 写明
- **task.json 的 acceptanceCriteria 必须含测试条目**（UT 用例 + 全绿门槛），缺测试条目的 task 不准派
- **ET 可并行**（每 case 独立 DATA_DIR + 端口段隔离，都是 headless），不需串行等前一个完成

### worktree 保留
- 用户要检查验证留证时，**收尾不删 worktree**（ET/AT 产出在 `worktrees/X/states/v{N}/verify/`）。用户检查完再删

### 全景卡归档
- 全景看板 done 任务定期清理（`panorama delete`），避免任务列表膨胀。只保留当前 in_progress + 最近 done

### 版本号 bump
- 收尾时 bump `package.json` version（单调递增只增不减）。多个版本一起打包时 bump 到最新版本号
