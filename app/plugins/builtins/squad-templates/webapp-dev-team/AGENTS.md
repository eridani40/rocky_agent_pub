# WebApp 研发团队

leader 负责接需求、拆分、委派与裁决；mate 各司其职。leader 编排/委派/门禁流程见 leader 个人 AGENTS.md。

## 🔧 项目环境配置

> **`INITIALIZED = false` → 初始化未完成，leader 必须先执行初始化（见 leader 个人 AGENTS.md），完成后改 `true`。**
> 全体 agent 执行任务时先读本块获取环境实际值。值为 `无` 表示项目当前不涉及此项。
> 每项格式：`KEY = 待收集  # 默认: <默认值>`。leader 初始化时：与默认冲突的覆盖，不冲突的保留默认。
> **本文档及所有 agent md 中用 `{SPECS_DIR}`、`{STATES_DIR}`、`{REQS_DIR}`、`{WORKTREES_DIR}` 引用团队工作目录，执行时替换为配置块对应键的实际值。**

```
INITIALIZED     = false

PROJECT_ROOT    = 待收集  # 默认: 无（必须问用户）
PKG_MANAGER     = 待收集  # 默认: npm
INSTALL_CMD     = 待收集  # 默认: 按 PKG_MANAGER 推导
UT_RUN_CMD      = 待收集  # 默认: npm test
TYPECHECK_CMD   = 待收集  # 默认: npx tsc --noEmit
BUILD_CMD       = 待收集  # 默认: npm run build
AT_RUN_CMD      = 待收集  # 默认: 无
AT_CASE_DIR     = 待收集  # 默认: 无
E2E_TEST_DIR    = 待收集  # 默认: 无
VISION_CHECK_CMD= 待收集  # 默认: 无
HAS_FRONTEND    = 待收集  # 默认: false

# 团队工作目录（相对于 PROJECT_ROOT，冲突时加后缀如 specs-team/）
SPECS_DIR       = 待收集  # 默认: specs/
STATES_DIR      = 待收集  # 默认: states/
REQS_DIR        = 待收集  # 默认: reqs/
WORKTREES_DIR   = 待收集  # 默认: worktrees/
```

### 目录冲突规则

团队使用的目录（`SPECS_DIR`、`STATES_DIR`、`REQS_DIR`、`WORKTREES_DIR` 及测试目录）可能与目标项目已有目录冲突。冲突时**不自动让步**——该目录可能就是本团队（或另一个团队）之前创建的。leader 发现冲突时**问用户**：是复用已有目录（同一项目多团队共享），还是用新目录（如 `specs-team2/`）。

## 🔴 SPECS 优先（第一原则）

所有问题第一入口是 `{SPECS_DIR}/`（prd/tech/api/ui），不是代码。spec 读不出路径 = spec 缺失，必须补。spec 与代码不符 = 当即修 spec。禁止大范围扒代码作为理解入口。

## 工作目录

项目根 = 用户正在开发的项目目录（非 squad workspace）。所有路径相对于项目根。worktree 统一建在 `{项目根}/{WORKTREES_DIR}/`。

**项目链接**：初始化时 leader 在 squad workspace 根创建项目根的 symlink（`ln -s {PROJECT_ROOT} {squad_workspace}/project`），使 mate 在 squad 目录即可访问项目代码。所有 agent 通过 `project/` 前缀访问项目文件（如 `project/src/`、`project/package.json`）。

## 沟通

优先私聊，除非老板在群聊说话或要通知全员。

## 双轨状态管理

每个版本维护 `{STATES_DIR}/v{N}.{M}/` 下：
- **task.json**：唯一机器状态源（agent 读写 + checkpoint 恢复）
- **task-board.md**：人类看板（Check 记录 + Bug 追踪）
- **context.md**：版本共享上下文（files 表 + findings，全体 agent 共同维护，只 Edit 追加禁 Write 覆盖，≤200 行）
- **bugs/**：`BUG-xxx-{简述}-[open|fixed|closed].md`

状态变更必须同时更新 task.json + task-board.md。

## Spec 驱动开发

```
概念({SPECS_DIR}/ui/ + {SPECS_DIR}/tech/) → PRD({SPECS_DIR}/prd/) → API({SPECS_DIR}/api/) → 测试用例 → 编码
```

**概念先行**：新概念先落 ui/tech spec 再进 PRD，禁止 PRD 先发明概念。设计稿 = 视觉契约（有设计稿时功能 PASS ≠ 视觉还原）。

**硬性规则**：PRD 未确认 → 禁止架构；架构未完成 → 禁止写测试；test-plan 未确认 → 禁止编码。

**PRD 参与边界**：纯技术改动（无用户可感知变化）跳 PRD，走 需求→架构→测试→编码。

## 验证体系（三层）

1. **UT**（coder 白盒）：按 `UT_RUN_CMD` 执行（MANDATORY，无豁免）
2. **AT**（黑盒真实调 API）：api-test-designer 设计 case → api-test-executor 按 `AT_RUN_CMD` 执行
3. **ET**（agent 玩 app）：e2e-test-executor 按 case.md 用浏览器自动化真实操作，每步留证，自由心证 pass/small/blocking

**AT/ET 均不录制不回放，真调 LLM**。

### 版本验证执行标准

UT 必须；改后端逻辑默认走 AT；UI 改动默认看一眼 ET；只有「很小」改动（文案/样式/单行）可豁免 AT/ET（test-plan 写明理由）。验证在版本 worktree 跑。

### 测试用例库 = 核心冒烟集

AT ≤20 条、ET 3~5 条。普通 feature 不新增持久 AT/ET case（冒烟集回归 + UT 即可）。只有引入新 LLM 不确定性场景/新板块才评估入选。

### ET 判定三态

- **pass**：走通全部操作目标，无瑕疵
- **small**：走通但有瑕疵，不阻塞合并
- **blocking**：走不下去，阻塞合并

### 视觉判定

有 E2E 截图时一律按 `VISION_CHECK_CMD` 执行视觉判定，禁止 MCP / 禁 Read 看图。executor 靠 snapshot 导航。

### 验证产出

统一在 `{STATES_DIR}/v{N}.{M}/verify/`。

## 范围纪律（MANDATORY）

只做用户当前 query 明确要求的工作。不介入未 query 的需求/在途版本/其他 worktree。不猜测用户意图——不确定就问。

## 文件大小与输出控制

单文件 ≤300 行；单次输出 ≤10000 字符；优先 Edit 而非 Write；JSON 精简。

## `.rocky/` 写入限制

只允许写 `.rocky/{commands,agents,skills}/`。禁止改 AGENTS.md、templates/、tools/、settings.json 等。

## memory 记录规范

只记录跨版本可复用的经验教训（陷阱/判断/偏好/gotcha）。禁止写版本快照/进度/状态/调试叙事。

## 重要原则

1. task.json + task-board.md 双轨驱动，状态变更同时更新
2. 质量三关不可跳过：coding → code-review → api/e2e 测试
3. 禁止查看截图（用视觉判定工具）
4. 禁止跳过测试
5. 先理解再动手：先读 specs 再少量读代码确认，禁止凭猜测做决策
6. 功能完成后必须更新 specs + 验证代码-spec 一致（doc-modifier 负责）
7. 发现 specs 不准确立即修正
8. coder 交付必须贴 `git diff --stat`（禁止只说「全绿」）
9. 死代码必须删除（零引用组件/hook/函数/测试 = 必删）
10. ui spec 必须记录消费方（哪些页面渲染了它）
11. change_plan = method 级编码前置硬阻断（不存在/不完整 → 禁止编码）
12. coder 可合理偏离 change_plan 实现细节，但必须向 leader 汇报偏离
13. spec↔code 双向对齐：spec 落后是常态，但偏离必须可见 + 最终对齐
