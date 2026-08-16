# WebApp 研发团队（通用）

leader 接需求、拆解、委派、裁决；mate 各司其职。初始化承接见 leader 个人 AGENTS.md。

## 变量区（初始化必填）

> 所有可变量集中于此。接新项目时先填此表，其余文档一律引用变量名（`${VAR}` 风格），不写死具体值。

| 变量 | 当前值 | 说明 |
|------|--------|------|
| `${PROJECT_NAME}` | （初始化时填） | 项目名 |
| `${PROJECT_ROOT}` | （初始化时填） | 项目根路径 |
| `${PROJECT_LINK}` | （初始化时填，建议 project） | squad workspace 下指向项目根的 symlink 名 |
| `${MAIN_BRANCH}` | （初始化时填，如 main） | 主开发分支 |
| `${APP_NAME}` | （初始化时填） | 应用名（环境变量 / DATA_DIR 前缀） |
| `${WORKTREE_PREFIX}` | （初始化时填，建议 worktrees） | worktree 目录（相对项目根） |
| `${STATES_DIR}` | （初始化时填，建议 states） | 版本状态目录 |
| `${REQS_DIR}` | （初始化时填，建议 reqs） | 需求目录 |
| `${SPECS_DIR}` | （初始化时填，建议 specs） | 文档目录（prd/tech/api/ui/research） |
| `${TESTS_DIR}` | （初始化时填，建议 tests） | 测试框架目录（AT/ET） |
| `${ENV_DEV}` | （初始化时填，建议 dev.env） | dev 环境文件（项目根，从 example 拷贝） |
| `${ENV_TEST}` | （初始化时填，建议 `${TESTS_DIR}/test.env`） | 测试环境文件（提交 schema，无 secrets） |
| `${SECRETS_TEST}` | （初始化时填） | 测试 secrets（gitignored，测试脚本直连用） |

## 占位符约定（MANDATORY）

- 所有占位符统一 **`${VAR}`** 风格，变量名自解释：`${VERSION}` = 版本号（如 `0.0.320`，路径拼 `v${VERSION}`）；`${SLUG}` = worktree/功能短描述（kebab-case）；`${CASE_ID}` = ET case id（`[a-z0-9-]+`）
- 正文引用变量区变量一律写 `${VAR}`（如 `${SPECS_DIR}/ui/`、`${STATES_DIR}/v${VERSION}/`）
- **使用前必须替换为实际值**，禁止把 `${...}` 当字面字符串直接用

## 环境隔离（通用原则）

**端口与数据目录是全局资源，必须按环境隔离。** dev/test/prod 各占独立端口段与 `DATA_DIR`；自动化测试用「版本号编码基址 + 全局注册表 + lsof 双校验 + 窗口回退」分配端口，可多实例并行；AT/ET 共享注册表建议串行。具体分配模式、启停协议、DATA_DIR 隔离见 `web-app-testing` skill。

## 沟通

优先私聊，除非老板在群聊说话或要通知全员。

## 公共规范

### SPECS 优先（第一原则）

所有问题第一入口是 `${SPECS_DIR}`（prd/tech/api/ui），不是代码。spec 读不出路径 = spec 缺失，必须补。spec 与代码不符 = 当即修 spec。禁止大范围扒代码作为理解入口。

### 双轨状态管理

每个版本维护 `${STATES_DIR}/v${VERSION}/` 下：
- **task.json**：唯一机器状态源（agent 读写 + checkpoint 恢复）
- **task-board.md**：人类看板（Check 记录 + Bug 追踪）
- **context.md**：版本共享上下文（files 表 + findings，只 Edit 追加禁 Write 覆盖，≤200 行）
- **bugs/**：`BUG-${CASE_ID}-${SLUG}-[open|fixed|closed].md`

状态变更必须同时更新 task.json + task-board.md。

### Spec 驱动开发

```
概念(${SPECS_DIR}/ui/ + ${SPECS_DIR}/tech/) → PRD(${SPECS_DIR}/prd/) → API(${SPECS_DIR}/api/) → 测试用例 → 编码
```

**概念先行**：新概念先落 ui/tech spec 再进 PRD，禁止 PRD 先发明概念。设计稿 = 视觉契约（有设计稿时功能 PASS ≠ 视觉还原）。

**硬性规则**：PRD 未确认 → 禁止架构；架构未完成 → 禁止写测试；test-plan 未确认 → 禁止编码。

**PRD 变更**：纯技术改动（无用户可感知变化）跳 PRD，走 需求→架构→测试→编码。

### 验证体系（三层）

1. **UT**（coder 白盒）：必跑，项目自带测试框架（按初始化探索结果）
2. **AT**（黑盒真实调 API）：api-test-designer 写 mjs case（node --test）→ api-test-executor 起 env 跑
3. **ET**（agent 玩 app）：e2e-test-executor 按 case.md 用 playwright-cli 真实操作，每步留证，自由心证 pass/small/blocking

**AT/ET 均不录制不回放，真调 LLM。** 操作方法见 `web-app-testing` skill（AT mjs case / ET env.sh / vision_check / dump-dev-html）+ `playwright-cli` skill。ET case.md 由 prd 按模板写（样例 = squad `.rocky/templates/e2e-case-template.md`）。

### 版本验证执行标准

UT 必须；改后端逻辑默认走 AT；UI 改动默认看一眼 ET；只有「很小」改动（文案/样式/单行）可豁免 AT/ET（test-plan 写明理由）。验证在版本 worktree 跑。

### 测试用例库 = 核心冒烟集

AT ≤20 条、ET 3~5 条。普通 feature 不新增持久 AT/ET case（冒烟集回归 + UT 即可）。只有引入新 LLM 不确定性场景/新板块才评估入选。

### ET 判定三态

- **pass**：走通全部操作目标，无瑕疵
- **small**：走通但有瑕疵，不阻塞合并
- **blocking**：走不下去，阻塞合并

### 视觉判定

一律用 `${TESTS_DIR}/e2e/vision_check.py` 脚本（初始化从 squad `.rocky/skills/web-app-testing/references/vision_check.py` 拷入），禁止 MCP / 禁 Read 看图。executor 靠 snapshot.yml 导航。

### 验证产出

统一在 `${STATES_DIR}/v${VERSION}/verify/`（AT executor 落 `api-test/`；ET executor 按 `verify/e2e/${CASE_ID}/steps/` 写）。

### 范围纪律（MANDATORY）

只做用户当前 query 明确要求的工作。不介入未 query 的需求/在途版本/其他 worktree。不猜测用户意图——不确定就问。

### 文件大小与输出控制

单文件 ≤300 行；单次输出 ≤10000 字符；优先 Edit 而非 Write；JSON 精简。

## 整体工作流程

每个需求/版本沿一条流水线推进，各环节有明确负责人、产出物与确认门禁：

| 阶段 | 负责人 | 产出物 | 确认门禁 |
|------|--------|--------|----------|
| ① 需求记录 | leader | `${REQS_DIR}/[working] *.md` | — |
| ② worktree | leader | `${WORKTREE_PREFIX}/${VERSION}-${SLUG}` 分支 | — |
| ③ 调研（可选） | researcher | `${SPECS_DIR}/research/` | 用户确认 |
| ④ PRD | prd | `${SPECS_DIR}/prd/` | 用户确认 |
| ⑤ 架构 | architect | `${SPECS_DIR}/tech/` + `${SPECS_DIR}/api/` + change_plan + task.json | 用户确认 |
| ⑥ test-plan | api-test-designer | `${STATES_DIR}/v${VERSION}/verify/test-plan.md` | 用户确认 |
| ⑦ 编码 | coder | 代码 + UT | 全自动 |
| ⑧ 审查 | code-reviewer | review 报告 | 全自动 |
| ⑨ 验证 | api-test-executor / e2e-test-executor | `${STATES_DIR}/v${VERSION}/verify/` | 全自动 |
| ⑩ 文档同步 | doc-modifier | specs 更新 | 全自动 |
| ⑪ 老板试玩 | leader 组织 | dev 环境试玩反馈 | 用户确认 |
| ⑫ 合并 | leader | 主分支合并 + bump + req[done] | — |
| ⑬ 打包 | leader | 打包产物 | — |

**门禁规则**：
- PRD/架构/test-plan 必须用户确认；编码→审查→验证→文档全自动不打断
- 有用户可感知 UI 变化的版本，合并前必须老板试玩确认
- 纯技术改动（无用户可感知变化）跳 PRD，走 需求→架构→测试→编码
- architect 产出 change_plan 后顺带切 task.json（task 设计原则见 architect 个人 md）
- bug 先派 bug-analyst 出分析报告，再进 architect 修复流程
- task 数量通常 1-3 个，优先少量（纯串行无并行收益 = 差分配）

**方法参考**：文档规范见 `doc-specs` skill；OKF 知识组织见 `okf-skill`；测试与环境（AT/ET/启停/端口/DATA_DIR）见 `web-app-testing` skill；浏览器自动化见 `playwright-cli` skill。

## 重要原则

1. task.json + task-board.md 双轨驱动，状态变更同时更新
2. 质量三关不可跳过：coding → code-review → api/e2e 测试
3. 禁止查看截图（用 vision_check.py）
4. 禁止跳过测试
5. 先理解再动手：先读 `${SPECS_DIR}` 再少量读代码确认，禁止凭猜测做决策
6. 功能完成后必须更新 `${SPECS_DIR}` + 验证代码-spec 一致（doc-modifier 负责）
7. 发现 `${SPECS_DIR}` 不准确立即修正
8. coder 交付前必须 commit：贴 commit hash + `git diff --stat` + `git status` 确认无遗留（禁止只说「全绿」）
9. 死代码必须删除（零引用组件/hook/函数/测试 = 必删）
10. ui spec 必须记录消费方（哪些页面渲染了它）
11. change_plan = method 级编码前置硬阻断（不存在/不完整 → 禁止编码）
12. coder 可合理偏离 change_plan 实现细节，但必须向 leader 汇报偏离
13. spec↔code 双向对齐：spec 落后是常态，但偏离必须可见 + 最终对齐
