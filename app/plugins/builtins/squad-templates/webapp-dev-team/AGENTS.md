# WebApp 研发团队（Multi-Agent Squad）

本 squad 是一个通用 WebApp 研发团队：leader（orchestrator）负责接需求、拆分、委派与裁决；11 个 mate 各司其职（prd/architect/planner/coder/code-reviewer/api-test-designer/api-test-executor/e2e-test-executor/verify-reviewer/researcher/doc-modifier）。

**全体成员（含 leader）必须遵守本文件全部纪律**；leader 的编排/委派/门禁流程见 leader 个人 AGENTS.md；各角色差异化定义见各自个人 AGENTS.md（{name}-{memberId}.md）。

## 工作目录（全队共识）

**项目根 = 用户正在开发的项目目录**（如 `/Users/username/projects/myapp`），不是 squad workspace（`~/.rocky_agent_prod/squads/xxx/`）。

本文档中所有路径（`states/`、`specs/`、`reqs/`、`worktrees/`、测试目录等）均**相对于项目根**。

- **leader 启动第一件事**：确定项目根路径，在首个消息中告知全体 mate
- **所有 mate 执行任务时**：以项目根为工作目录（cwd）
- **worktree 统一建在 `{项目根}/worktrees/`** 目录下（不在项目外、不在 squad workspace）
- 如果项目根下还没有 `states/`、`specs/` 等目录，leader 在启动版本时创建

## 沟通

优先私聊，除非老板在群聊说话，或者要通知大家，大家聊天。除非私聊解决。

## 双轨状态管理：task.json + task-board.md

每个版本维护两个状态文件，各司其职：

- **task.json**（机器驱动）：唯一状态源，agent 读写状态、checkpoint 恢复
- **task-board.md**（人类看板）：一个文件纵览全貌，带时间线审计日志

**每次状态变更必须同时更新两者。**

```
states/
├── user_query.md                    # 用户要求（每个版本追加）
└── v{N}.{M}/                        # 版本目录
    ├── task.json                    # 机器状态源
    ├── task-board.md                # 人类看板（从模板创建）
    ├── context.md                   # 版本共享上下文（全体 agent 共同维护，见下规范）
    ├── bugs/                        # Bug 追踪
    │   └── BUG-xxx-{简述}-[open].md
    └── verify/                      # 验证相关
        ├── unit-test/
        ├── api-test/
        ├── e2e-test/
        │   └── snapshots/
        └── review/
```

### task-board.md 看板规范

从 `.rocky/templates/task-board-template.md` 创建。核心字段：

- **当前状态**：与 project phase 同步
- **任务概览**：从 task.json 同步 task 状态简表
- **Check 记录**：每次 review/状态变更追加 `[HH:MM] 阶段 结论 原因`
- **Bug 追踪**：引用 bugs/ 目录下文件

### context.md 版本共享上下文（MANDATORY — 全体 agent 共同维护）

**定位**：版本内团队协同的「导航地图 + 在途发现」，让子 agent 跳过冷启动探索、直达相关文件。**职责边界**：不放状态/进度/Check 记录（归 task-board.md + task.json）、不放变更契约（归 change_plan.md）。创建 states 版本目录时从 `.rocky/templates/context-template.md` 创建，与 task-board.md 一起。

**结构**（# topic → ## section → ### intro / files / findings）：

```markdown
# v{N}.{M} context — {一句话版本主题}

## {分主题 section}
### intro
两三句：这件事怎么回事、关键决策
### files
| 路径 | 类型 | 一句话介绍 |
|------|------|-----------|
| specs/ui/components/xxx.md | spec | 组件契约，testid 在 §4 |
| src/components/Xxx.tsx | code | 输入区实现，280 行接近上限 |
| tests/e2e/chat/xxx/ | test | 主路径 case |
### findings
- [coder 14:30] X 方法有 Y 坑，绕行方式 Z
```

**全体 subagent 义务（MANDATORY）**：
- **启动先读**：接到委派后第一步读 `states/v{N}.{M}/context.md`（与自身上游文件并列），按 files 表直达相关文件，不重复探索
- **发现写回**：工作中发现的新相关文件补进 files 表；踩到的坑/关键事实追加 findings 一条（带 `[角色 HH:MM]` 署名）；结束前 Edit 进去
- files 表「类型」列 = spec / code / test / design。designer 类 agent 只取 spec/test/design 行（不破「不读产品代码」边界）

**写入规则（防并发互踩）**：只用 Edit 追加（files 加行、findings 加条），**禁止 Write 全量覆盖**；只有纠错才改旧行。全文 ≤200 行、只写结论不写过程（同 memory 纪律），超限由 orchestrator 精简。

### Bug 文件名状态机

`BUG-xxx-{简述}-[open].md → [fixed].md → [closed].md / [reopen].md`

文件名即状态，`ls bugs/` 就能看全局 Bug 状况。

**Project phase 状态机**：`not_started → requirements → research → prd_design → architecture → planning → coding → code_review → verifying → completed`

**Task status 状态机**：`pending → coding → code_review → verifying → verified`

Project phase 由所有 task 状态自动派生，不手动维护。

## Spec 驱动 + 测试驱动开发（MANDATORY）

**开发的前置条件（缺一不可）**：必须先完成 specs，再写测试用例，最后才能开始编码。

```
概念(specs/ui/ + specs/tech/) → PRD(specs/prd/) → API文档(specs/api/) → 测试用例 → 编码
```

**概念先行（MANDATORY）**：`specs/ui/`（UI 契约 + `specs/ui/components/` 组件 spec）+ `specs/tech/`（技术架构）是项目的**概念权威源**——定义「能做什么、组件/接口是什么」。**先有概念，才有需求**：PRD 是概念的产品化表达，必须对齐已有 ui/tech spec，不得凭空发明概念。
- **基于已有概念**：先确认 `specs/ui/` + `specs/tech/` 概念就绪 → PRD 引用对齐 → 编码
- **引入新概念**：新概念**先落 `specs/ui/` 或 `specs/tech/`**（架构/UI 契约层定义）→ 再进 PRD 引用 → 编码。禁止 PRD 先发明概念、ui/tech spec 事后追认
- **PRD 确认前**，orchestrator 必须核对 PRD ↔ `specs/ui/` + `specs/tech/` 对齐（组件命名、布局、数据概念、接口语义）。不一致时：以已有概念为准让 PRD 对齐，或新概念先补 ui/tech spec
- **设计稿 = 视觉契约（MANDATORY）**：版本带设计稿（原型/设计图）时，设计稿不仅是交互参考，更是**视觉权威源**——定义组件「长什么样」（字体/尺寸/布局/边框/配色）。**功能正确 ≠ 视觉还原，二者都是验收门槛**。coder 实现前按设计稿填组件 spec「视觉基线」字段；验证须做视觉保真度比对（见「验证体系」）。无设计稿时此项跳过。

**硬性规则**：
1. **PRD 未通过确认 → 禁止进入架构设计**
2. **架构 + API 文档未完成 → 禁止写测试用例**
3. **test-plan（测试计划）未经用户确认 → 禁止开始编码**；**case 文件未就绪 → 禁止进入验证**（case 文件创建与编码并行）
4. **每个版本的测试范围必须先审后行**：明确本版本要进行的 UT、AT（API Test）、ET（E2E Test）——test-plan 经用户确认后才能进入开发

**PRD 参与边界**：PRD 只负责**产品逻辑与体验——用户可感知的部分**。纯技术层面改动（重构 / 性能 / 内部机制等，不改变任何用户可感知行为与界面）**无需 PRD 参与**：跳过 PRD 阶段，流程为 需求 → 架构（change_plan，架构确认仍 MANDATORY）→ 测试用例 → 编码。判定标准 = 是否存在用户可感知的行为/界面/交互变化；拿不准时问用户，不自行归类。

**每个版本开始时，先完善测试目录下的 cases.md**：
- 对照 specs/api/ 更新 API cases.md（新增/变更接口必须有对应 case）
- 对照 specs/ui/ 更新 E2E cases.md（新增/变更页面必须有对应 case）
- 在 task-board.md 记录本版本的 UT/AT/ET 范围

## 文档产出链路

```
researcher → specs/research/（调研报告）
prd → prd/overall + prd/version_logs
    → arch 读 prd 产出 tech/（OKF：每子系统 KB=index.md+log.md）+ api/ + specs/tech/version_logs/v{N}.{M}/change_plan.md（method 级变更契约，行=函数/符号）
    → orchestrator 写 test-plan.md（路径→case 映射 + 视觉保真 compare 清单）
    → api-test-designer 读 api/ 设计 API 测试 case（声明式 DSL + test_case.md，断言基于 spec 契约，不看代码）
    → coder 读 tech/ 编码并细化 api/ + 编码前置产出/更新 specs/ui/components/ 组件 spec（先 spec 后实现）
    → AT 执行: api-test-executor 按项目 API 测试框架执行 → 轮询 progress 读聚合结果汇报（不看代码）
    → ET 执行: orchestrator 委派 e2e-test-executor，executor 用浏览器自动化工具按 case.md + app-guide 玩 app，每步留证，自由心证 blocking/small/pass（不看代码/不 Read 截图）
    → doc-modifier 最终同步（tech OKF KBs：index.md/log.md/frontmatter；prd/api/ui overall）+ app 布局手册（新增/变更板块入口与操作路径）
```

## 持久化测试用例库（MANDATORY — 双轨：AT + ET）

### 用例库定位 = 核心冒烟集

全量 case 库在全局性变更（工具 schema / prompt / UI）下维护成本不可持续。用例库只保留**核心冒烟集**，其余场景由 UT 覆盖：

- **规模上限**：AT ≤20 条、ET 3~5 条。AT ≤20 条内**不强制淘汰已有 case**；仅超 20 条时才评估一进一出。
- **AT 入选标准**：LLM 参与 + 行为不确定 + 跨层链路（HITL 审批/提问、LLM 回复/工具调用链、压缩、记忆写、子 agent、SSE 流式）。**确定性 HTTP 契约 / CRUD 一律 UT 覆盖，不进 AT**。
- **ET 入选标准**：板块级冒烟主路径（聊天主链路、审批卡、会话列表、设置等），一个板块至多一条。
- **🚫 普通 feature 一律不新增 AT/ET case**（维护成本太高）。普通功能开发 = 冒烟集回归 + UT 即可。**只有**引入「新的 LLM 不确定性场景 / 新板块」时才评估入选。

### 版本验证执行标准

「不新增持久 case」≠「不做 AT/ET 验证」。每个版本的验证执行口径：

**默认做 feature 就走 AT/ET**。有弹性，但弹性在豁免侧、不在执行侧：

1. **UT 是必须的**（无任何豁免）
2. **改了后端逻辑 → 默认走 AT**（跑相关已有 case 或一次性真调验证，不等于建持久 case）
3. **纯 UI 改动、好复现 → 默认看一眼**（ET 或手动玩一把确认）
4. **豁免是例外**：只有「很小」的改动（改文案、调样式、单行修复）才可豁免 AT/ET，豁免需在 test-plan 里写明理由
5. 版本验证一律在**版本 worktree** 里跑

**双轨**：**AT（API 测试）**——声明式 DSL + 真实调 API。**ET（E2E）**——agent 用浏览器自动化工具真实玩 app：case.md 纯自然语言 + executor agent + 每步留证 + 自由心证。

**AT 核心模型**：
- **声明式 DSL**：step = requests/run/poll/wait/oracle/files + save + 原子 check
- **真实调 API 不录制不回放**：每 case 真调 LLM provider；429/529/503 → case 标 skipped（不重试不阻塞）
- **5 分类聚合**：pass / fail / timeout / not_run / skipped；overall = pass iff fail==0 && timeout==0
- **per-step 独立产物**：每步产出 responses/events/checks 结果；fail 的 actual 自带解释

**ET 核心模型**：
- **case.md 纯自然语言**：Use Case + 前置条件 + 编号操作目标 + 验收口径（pass/small/blocking）；零断言零录制零 testid 预定义
- **executor agent 用浏览器自动化工具真实玩 app**：按 case.md 操作 → 每步留证（screenshot+dom+snapshot+meta 四件套）→ 自由心证 blocking/small/pass
- **每 case 独立数据目录**：不跨 case 复用
- **不录制不回放真调 LLM**
- **判定三态自由心证**：pass / small / blocking
- **视觉判定工具**（不绑框架）：executor 按需调用做视觉辅助判定

## 验证体系（三层）

1. **coder 单元测试**：白盒，看实现
2. **API 测试**（黑盒真实调 API）：
   - **api-test-designer**：设计 case（声明式 DSL），断言基于 specs/api/ 契约，不看代码
   - **api-test-executor**：按 orchestrator 白名单执行 → 读聚合结果汇报
3. **E2E 测试**（agent 用浏览器自动化工具真实玩 app）：
   - **无 designer 角色**：case.md 由 PRD「关键用户路径」维护
   - **e2e-test-executor**：orchestrator 委派 → 按 case.md + app-guide 操作 app → 每步留证 → 自由心证 pass/small/blocking

**视觉保真度比对（有设计稿时 MANDATORY）**：executor 逐维度（layout/font/border/color）判定。口径：整体风格基本一致 = PASS；明显偏差 = FAIL → 建 BUG 标 `视觉保真`。

> verify-reviewer 仅在 orchestrator 判断有必要时启用，不作为默认层级。

### 验证产出目录（MANDATORY — 统一位置）

**所有验证产出统一在 `states/v{N}.{M}/verify/` 目录**。case 在项目测试目录，结果在 `states/<ver>/verify/`。

### 验证流程

**AT 阶段**：
- **设计**：api-test-designer 读 test-plan.md + specs/api/ → 设计/迭代 case（断言基于 spec 契约，不看代码）
- **执行**：api-test-executor 按白名单执行（自动启/关 env，真实调 LLM）→ 聚合结果 → 读结果汇报

**ET 阶段**：
- **无 designer**：case.md 由 PRD「关键用户路径」维护
- **执行**：orchestrator 顺序委派 e2e-test-executor，一次一个 case：
  1. 起环境（起 server+web + 分配独立数据目录 + 隔离端口）
  2. executor 读 case.md + app-guide 相关章节
  3. executor 用浏览器自动化工具玩 app，每步留证
  4. executor 自由心证 pass/small/blocking → 写 verdict
  5. 停环境

**orchestrator 裁决（看具体结果，不只看汇报）**：
- AT fail：读 per-step 产物的 checks actual（自解释），判断实现 bug（退 coder + 建 BUG）vs case 设计缺陷（退 designer）
- ET blocking/small：读 steps 留证，判断实现 bug（退 coder + 建 BUG）vs case.md 操作目标不合理（改 case.md）vs 环境侧问题

**反例（绝对禁止）**：
- ❌ executor 改 case / 扒代码 / 调试（违反职责边界）
- ❌ executor Read screenshot.png（禁截图；snapshot 是主信息源）
- ❌ 不调用 API / 不真调 LLM 就说测试通过
- ❌ 只看 executor 汇报不核实产出文件
- ❌ 响应体用 `...` 省略
- ❌ 不经视觉判定就说视觉验证通过
- ❌ 做用户没有要求的工作和需求，或者查探、修改其他 worktree 的工作

### 视觉判定 — 一律用视觉判定工具（禁直接看图）

**当需要视觉判定时**（视觉呈现无法用 snapshot 判定 + 视觉保真 compare）**必须用视觉判定工具**。

**禁止**：用 MCP 图片理解工具、用 Read 工具直接加载图片。orchestrator 也不看截图，只读 executor 产出的 JSON 结果。

### E2E 判定模型 — executor 自由心证三态

- **pass**：完全走通 case.md 全部操作目标，无瑕疵
- **small**：走通了但有瑕疵，不阻塞合并（文案微差、视觉小问题、偶发 console warning）
- **blocking**：走不下去（元素找不到、click 报错、关键 API 500、LLM 一直空回、链路断），阻塞合并

**判定原则**：
- 走得通 + 主功能 OK = pass（不追求像素完美）
- 走得通 + 有瑕疵但不影响主路径 = small（留证供人判断）
- 走不下去 / 关键功能失效 = blocking（必附现象 + executor 归因事实描述，不猜 bug）
- **LLM 实际返回质量由人判**：executor 只判「有没有回复 + 回复链路通不通」，不判「这个回复好不好」

### 验证环境管理
- **AT**：测试框架自动管 env 生命周期（起 → 跑 case → 关），自动 mkdir 输出目录 + 清残留端口。
- **ET**：每 case 独立数据目录 + 隔离端口；orchestrator 管生命周期，executor 不自主 start/stop。

### LLM 真实调 API

**AT 与 ET 双轨均不录制不回放真调 LLM**。

**判定规则**：
1. **新增/修改 case → 直接真调跑**：case + test_case.md 一起提交，跑通即交付。
2. **只改产品代码 → 直接真调跑**：case 不动，全量真调验证。
3. **改需求**（prompt/工具 schema/断言语义）→ 直接真调跑确认契约。

**执行纪律**：
- **AT 严禁并发**（共享数据目录，并发互踩数据全废）；串行跑
- **ET 每 case 独立数据目录** → 理论可并发但**顺序跑**（一次一个 case）
- **AT 进度 journal**：每 case 完成即 append 进度记录。长跑时轮询进度，**见 done 才读结果文件，读前核对 mtime 新鲜**——防「中途被杀读旧结果误报 pass」
- AT 每轮记录 wall time；429 skip 不阻塞、单列计数、不翻 overall

## 文件大小与输出控制（MANDATORY）

1. 单文件 ≤ **300 行**，超出必须拆分
2. 单次输出 ≤ **10000 字符**
3. 优先 Edit 而非 Write
4. JSON 样例精简

## `.rocky/` 目录写入限制（MANDATORY）

在 `.rocky/` 目录下，**只允许写入以下 3 个子目录**：
- `.rocky/commands/`
- `.rocky/agents/`
- `.rocky/skills/`

**禁止修改 `.rocky/` 下的任何其他文件或目录**（包括但不限于 `AGENTS.md`、`templates/`、`settings.json` 等）。如需修改这些文件，必须由用户手动操作或明确授权。

## 长期记忆（memory）记录规范（MANDATORY）

长期记忆**只记录跨版本可复用的总结性经验教训**——陷阱 / 判断 / 用户偏好 / 工具 gotcha。每条只留「结论 + 何时适用 + 怎么做」，删过程、删版本编号堆叠。

**禁止写进 memory**（各有正确归属）：
- **版本快照 / 进度 / 状态** → 归 `states/v{N}.{M}/task-board.md`、项目过程文档
- **短期事实 / 只对某个版本有用的内容** → 归项目过程文档 / todo
- **子系统架构事实**（组件/接口/链路/数据流的「是什么」）→ 归 `specs/`
- **调试过程叙事** → 只留最终结论，删经过

**Why**：memory 索引会全量注入每个会话的上下文。版本进度进 memory = 污染索引信号 + 误导所有后续会话。

## 重要原则

1. task.json + task-board.md 双轨驱动
2. 每次启动必读最新版本 task.json + task-board.md
3. 状态变更必须同时更新两个文件
4. PRD/架构必须用户确认
5. 编码阶段全自动
6. **质量三关（MANDATORY）：coding → code-review → api/e2e 测试** — 每一关都不可跳过。AT = api-test-designer 设计 case + api-test-executor 执行；ET = e2e-test-executor 按 case.md + app-guide 真实玩 app（无 designer，case.md 由 PRD 维护）。verify-review 按需启用
7. **禁止查看截图** — 视觉判定一律走视觉判定工具；orchestrator/executor 都不用 Read 加载图片。ET executor 靠 snapshot（text accessibility tree）导航
8. **禁止在 AGENTS.md 中粘贴 agent 输出日志**
9. **禁止跳过测试** — 无论用户是否要求简化流程，API 测试始终是必须的
10. **先理解再动手（MANDATORY）** — 分析问题、设计方案时，必须先查看之前的 specs 和相关源码，了解清楚确切问题和上下文才可以开始工作。禁止凭印象或猜测做设计决策。核心设计原则必须记录在 specs 文档中
11. **从 specs 理解项目（MANDATORY）** — 所有 agent（包括 subagent）需要了解项目时，必须从 `specs/` 目录开始，而非从代码开始。specs 是项目的设计文档和功能规范的唯一权威来源。**需求/讨论开始前先读 spec（设计意图/契约），代码只少量读以确认关键事实——禁止大范围扒代码作为理解入口**
12. **功能完成后必须更新 specs + 验证代码-spec 一致（MANDATORY）** — 每个版本的功能开发完成后，必须通过 doc-modifier 同步更新 `specs/`，确保 specs 与代码保持一致。**doc-modifier 必须验证「代码实现 == spec 契约」**。代码静默偏离 spec 是最危险的
13. **发现 specs 不准确时立即修正（MANDATORY）** — agent 读完 specs 后再去读代码，如果发现 specs 信息不对、不全或过时，必须当即完善 specs，而不是忽略或绕过
14. **概念先行 + PRD 对齐 ui/tech spec（MANDATORY）** — `specs/ui/` + `specs/tech/` 是概念权威源。PRD 必须对齐已有概念；新概念先落 ui/tech spec 再进 PRD
15. **设计稿 = 视觉契约（MANDATORY）** — 版本带设计稿时，**功能 PASS ≠ 视觉还原**。必须有「视觉保真度比对」一关。无设计稿时本原则跳过
16. **变更计划书 = method 级 review 合同（MANDATORY）** — 架构期冻结于 `specs/tech/version_logs/v{N}.{M}/change_plan.md`，行=函数/符号，8 列（模块/文件/函数·符号/类型/变更内容/约束/参考/影响行）。它是编码前置硬阻断（不存在/不完整 → 禁止编码）
    - **coder 与 change_plan 的关系（参考 + 决策权 + 汇报偏离）**：coder **参考** change_plan + PRD + 设计（UI spec）+ 相关 tech spec 实现。coder 对**实现细节有最终技术决策权**：发现更优实现、约束已变时可合理偏离，**但任何偏离必须向 orchestrator 汇报**。**核心约束不可擅自偏离**：架构原则、invariants、PRD 关键用户路径、安全/契约约束——这些须先报 orchestrator 确认再实现
    - **spec↔code 双向对齐（spec 落后是常态，不是缺陷）**：coder 实现时按**代码实际**调整 + 汇报偏离 → orchestrator 记入待办 → **doc-modifier 统一修 spec 对齐到代码**。这是健壮弹性机制
    - **architect 落 change_plan 行前核对引用符号存在（预防性）**：写「调用 `X.Y()`」「引用 `enum.Z`」时，应 grep/读代码确认真实存在
17. **交付验证铁律（MANDATORY）** — coder 回报「完成」时**必须贴 `git diff --stat`**（列出每个改动文件），**禁止只说「全绿」**。UT 全绿 ≠ 业务代码改了（mock 可脱离业务代码独立跑通）。**diff stat 是交付凭证**。leader 验收时**必须 grep 关键改动确认代码真实存在 + 读 diff 确认逻辑正确**，不只看 UT 结果。

## 范围纪律 / 不越界（MANDATORY — 违反不可饶恕）

**只完成用户当前 query 明确要求的工作，其余一律不做：**
1. **只做 query 要求的**：用户没在当前 query 里要求的——哪怕「看起来相关 / 顺手 / 为了流程完整」——都不做。完成 query 条目即停、回报。
2. **不介入未 query 的需求与在途版本**：别的 worktree、别的会话正在做的版本，一律**不查看、不改、不跑测试、不盘算合并**。
3. **不擅自查看与修改其他 worktree 的工作**：动任何 worktree / 分支前，先确认它是本会话的、且用户授权动它。
4. **不猜测用户意图**：不确定用户要什么就**问**，不要凭「他大概想要 X」自行展开。
