# v0.0.219 PRD — Academy 视图优化（academy_opt）

> 版本：v0.0.219 · 主题：Academy 学生详情/训练观察 5 问题修复 + coach 持续可达增强
> 创建：2026-07-29 · 需求源：`reqs/[working] v0.0.219.academy_opt/req.md`
> PRD 边界（用户裁决 2026-07-14）：本版以 bug 修复（让实现对齐 spec）为主，PRD 只覆盖 3 个用户可感知的产品逻辑/体验变化；纯技术修复（数据读取、字段写入、组件渲染门）属 spec 对齐，由 architect 落 change_plan，不进 PRD 详细方案。
> 概念权威源：`specs/ui/overall/12-academy.md` + `specs/ui/components/academy-page/` + `specs/tech/academy/`
> 本版无设计稿（req 内 1.png 为 bug 截图非设计稿）→ 无视觉保真门禁。

---

## 1. 版本主题（产品语义）

修复 Academy 学生详情/训练观察的 6 个体验问题，让既有 spec 描述的能力真正可用，并把「coach 持续可达」从 bug 修复升级为一个明确的产品不变量：**训练任务一旦创建，其 coach 就始终可被用户进入对话——不论任务在跑还是已终态**；同时让运行中训练**实时可见**（非 freeze 到结束）。

直接动因（用户反馈）：版本树过程版挂错位置 / formal 缺采纳溯源 / Memory 卡是死占位 / Tools 卡不该出现 / 训练发起 baseline 锁死 0.0 / 任务跑完后 coach 入口消失 / 多个任务都叫「任务 #1」难区分 / 训练中页面 freeze 到「结束后才出来」。

---

## 2. 功能需求（用户可感知）

### 2.1 「采纳自」溯源展示 [v0.0.219]

**优先级**：P0
**用户故事**：作为 academy 用户，我希望每个正式版本能看到「它是从哪个过程版本采纳来的」，以便理解版本演进脉络、回溯训练历史。

**描述**：学生详情版本树里，每个**正式版本**（formal）若由训练接受而产生，展示「采纳自 vX.Y.Z」徽章或副标题（X.Y.Z = 该 formal 被接受时来源的过程版本号）。

**产品规则**：
- 仅 formal 版本展示；过程版本（process）不展示。
- 初始版本 `0.0` 无此徽章（非训练产生）。
- 文案格式：「采纳自 v{过程版本号}」（如「采纳自 v1.2.3」）。
- 数据来源：新增 schema 字段 `adoptedFromProcessVersionId`（架构期落 `specs/tech/academy/[P0]data_model.md`），记录该 formal 由哪个 process 复制而来；UI 读取该 id 对应的过程版本号渲染。
- 视觉载体：在版本树节点 formal 副标题位（现「adoptedFrom {n:seq}」文案处）替换展示，样式沿用现有 `vb-formal` 体系副标题，不发明新组件。
- **代决（用户 afk 授权）**：视觉 = formal 副标题位（不发明新组件，简单直接），此项已定。

**概念落点（新概念，架构期落 ui spec）**：`specs/ui/overall/12-academy.md §4` 版本树节点 + `specs/ui/components/academy-page/component-version-tree.md` formal subtitle 字段。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 学生详情 → 看版本树 → 训练接受后的 formal（如 1.0） | 该 formal 显「采纳自 v1.2.3」徽章/副标题 |
| UC-2 | 学生详情 → 看初始 0.0 formal | 无「采纳自」徽章 |

---

### 2.2 移除 Tools 卡（五元组 → 四元组）[v0.0.219]

**优先级**：P0（用户拍板）
**用户故事**：作为 academy 用户，我希望学生详情的五元组卡片聚焦我真正会编辑的内容（System Prompt / Skills / Memory / 模型），不被我不需要直接操作的 Tools 卡干扰。

**描述**：学生详情 tuple-grid 移除 Tools 卡，由五元组变为**四元组**（System Prompt / Skills / Memory / 模型）。

**产品规则**：
- 仅 UI 去入口：`version.json.tools` 数据字段**保留**（装配链 `resolveToolSet` 仍消费，学生 agent 工具集不受影响），只是学生详情不再提供 Tools 的查看/编辑入口。
- 训练结果 diff 页本就无 Tools 段（diff 只组 4 卡），无需同步处理。
- 移除后 Skills / Memory / 模型卡布局不变（grid 自适应），不引入相邻元素位移。

**概念落点（spec 更新，doc-modifier 阶段 5 做）**：`specs/ui/overall/12-academy.md §4` tuple-grid 描述（五元组→四元组，Tools 行删）+ `specs/ui/components/academy-page/component-tuple-cards.md`（Tools 卡 spec 删）。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3 | 学生详情 → 看 right-col tuple-grid | 只见 System Prompt / Skills / Memory / 模型 4 卡，无 Tools 卡 |

---

### 2.3 coach 持续可达（产品不变量升级）[v0.0.219]

**优先级**：P0
**用户故事**：作为 academy 用户，我希望训练任务跑完后仍能进入训练观察页和 coach 聊几句（复盘/追加指导），并且运行中的训练任务及其过程版本实时可见——而不是任务一终态入口就消失、训练中页面 freeze 到「结束后才出来」。

**用户原话**：「运行中这个版本好像整个都没展示，而且我希望这个版本的 coach 总是可以进去聊几句」。

**根因（实时性核心，第 2 轮调查实证）**：用户印证「训练中只在结束后才出来」——非仅 activeTask 渲染门问题，而是**实时性 bug**：
- 后端**零 training.\* SSE**（spec `18-academy §6` 声明了但代码未落地，`use-academy-data.ts` / `use-training-task.ts` 双注释自认「T1 未落地」）。
- `student-detail` / `classroom-detail` = **一次性 fetch**（`useLifecycle` deps `[cid,sid]`，无 timer/SSE）→ 停留期间页面 freeze，running 中新 fork 的 round2+ 过程版不可见。
- 唯一轮询 `useTrainingTask`（4s）只刷单 taskDetail，不级联刷 versions/tasks。
- 用户训练后回 student-detail 触发 re-fetch → 累积过程版一次性涌现 = 「结束后才出来」观感。

**修复选型（架构期定，orchestrator 代决 = 前端轮询）**：
- **前端轮询兜底**：student / classroom detail 检测到 active task 时起 ~4-5s timer 周期 reload（复用 `useTrainingTask` polling 模式，新建 `useActiveTrainingWatcher` 或给 detail hook 加 active 轮询分支）。小、无后端改、足够实时。
- 后端 SSE（spec §6 落地，emit fork/status 事件 + 前端订阅）后置——本版不做。
- spec `18-academy §6` 由 doc-modifier 标注「**前端轮询兜底，SSE 后置**」。

**产品规则（两个子诉求）**：

**① coach 入口持续可见**：
- 学生详情任务卡的「进入观察 →」入口**不再仅限任务活跃态**（`running / pending / awaiting_confirm`）。
- 任务进入终态（`done / rejected / aborted`）后，**任务卡 + 「进入观察」入口保留**——**含 `aborted`**（异常终止的 coach 仍有复盘价值；代决：用户 afk 授权「总是可以进去」）。
- 训练观察页 coach 列（`SectionChatSession`）对终态任务保持可输入（caps 不降级）。

**② 运行中任务及其过程版本实时可见**：
- 学生详情任务卡渲染门从 `activeTask`（活跃态）改为**「该学生最近 N 条任务（含终态）」**——架构期定 N 与排序。
- 版本树显示**训练中的过程版本**（gold「训练中」tag，挂对父 formal——依赖 bug 修复 §2.4），且随训练推进（round2+ fork）**实时涌现**（前端轮询驱动），非仅 re-fetch 后才出现。
- 运行时不得出现「task detail 拉取失败 → LoadingHint 永挂 → coach 列不显」。

**概念落点（spec 更新，架构期 + doc-modifier 做）**：`specs/ui/overall/12-academy.md §4`（任务卡渲染门 + 版本树实时性）+ §5（训练观察页入口语义扩至终态任务）+ `specs/api/overall/18-academy.md §6`（SSE 章节标「前端轮询兜底，SSE 后置」）。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-4 | 学生详情 → 训练任务 done / aborted 后 → 任务卡仍在 → 点「进入观察」→ 训练观察页 → 与 coach 对话 | coach 列可输入，对话正常往返（含 aborted 任务） |
| UC-5 | 学生详情 → 训练运行中 → 停留页面观察 → 任务卡 + 版本树训练中过程版**实时涌现**（非 re-fetch 后）→ 点「进入观察」 | 轮询驱动 ~4-5s 内过程版/状态更新可见；训练观察页正常加载，不永挂 LoadingHint |

---

### 2.4 Bug 修复（spec 对齐，PRD 仅提及不展开）[v0.0.219]

以下属「让实现对齐既有 spec」的 bug 修复，产品语义已在既有 spec 中定义，本 PRD 不重复展开方案，由 architect 落 change_plan：

| Bug | spec 对齐点 | 用户感知 |
|---|---|---|
| 版本树过程版归属（1a/1b） | `12-academy.md §4` 版本树（过程版缩进+左竖线挂对父 formal） | 过程版（如 1.2）不再脱离 base formal 飘到列表尾 |
| 学生详情 Memory 卡展示真实条目（问题3） | `12-academy.md §4` tuple-grid Memory 卡 + `§7` float-menu memory（对齐 chat-page memory modal 样式） | Memory 卡不再恒显「加载中」死占位，可查看真实条目 |
| 训练发起 baseline picker 可选任一 formal（问题5） | `12-academy.md §9` baseline picker | picker 不再锁死 currentFormal，可切任意 formal 版本 |

---

### 2.5 任务名版本挂钩（问题6）[v0.0.219]

**优先级**：P0
**用户故事**：作为 academy 用户，我希望每个训练任务的名字能体现它基于哪个版本、第几号任务，以便区分同一学生的多次训练，而不是看到一堆都叫「任务 #1」。

**背景（非后端 bug）**：`taskSeq` 后端分配正确（per-base 递增，`data_model §8.4` 满足）。「都叫 #1」是 **base 轮换**（训练 done→adopt→新 formal→下次换 base→sameBase 空→taskSeq 重置回 1）+ 显示用裸 taskSeq 所致，**非分配 bug，不动后端分配逻辑**。

**产品规则**：
- 任务显示名改为**版本前缀**格式「v{baseMajor}.{taskSeq} 训练任务」（如 base `1.0` + taskSeq=2 →「v1.2 训练任务」），不再用通用「任务 #N」。
  - `baseMajor` = 该任务 base 版本号的主段（base=`1.0` → major=`1`）；taskSeq = per-base 任务序号（既有字段）。
- **过程版节点**直接显其 3 段 `versionLabel`（如 `1.2.3`，已是版本记录字段）。
- 数据可得性：task record 已有 `baseVersionId + taskSeq`，前端按 base 版本号拼前缀；后端反规范化 `baseVersionLabel` 进 task DTO（教室训练 tab 无 versions 上下文，统一反规范化）。

**概念落点**：复用既有版本号语义（`12-academy.md §4` 版本树 + `[P0]data_model.md §6` label 3 段规则 + §8.4 taskSeq per-base 唯一），无新概念；仅任务**显示文案**变更 + 后端 task DTO 反规范化 `baseVersionLabel`（架构期落 api `18-academy`）。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-6 | 同一学生基于 1.0 发起 2 次训练 → 看任务卡 / 训练观察 / 训练结果 / 教室训练 tab | 任务名显「v1.1 训练任务」「v1.2 训练任务」可区分，不再都叫 #1 |
| UC-7 | 版本树展开过程版节点 | 节点显 3 段 versionLabel（如 1.2.3） |

---

## 3. 关键用户路径（MANDATORY — 测试最低覆盖）

| # | 路径 | 对应 UC | 验证层 |
|---|------|---------|--------|
| 路径1 | 学生详情 → 版本树【全部 formal 主干 + 过程版挂对父 formal + formal 显「采纳自 vX.Y.Z」】 | UC-1、UC-2 + bug 1b | ET + UT |
| 路径2 | 学生详情 → 任务卡「进入观察」→ 训练观察页 coach 对话【含任务 done 后仍可进】 | UC-4、UC-5 | ET + AT |
| 路径3 | 学生详情 → Memory 卡「查看」→ memory 条目展示（对齐 session 长期记忆样式） | bug 3 | ET + UT |
| 路径4 | 学生详情 → 「发起训练」→ baseline picker 可切任一 formal 版本 | bug 5 | ET + UT |
| 路径5 | 学生详情 tuple-grid【无 Tools 卡，四元组】 | UC-3 | ET + UT |
| 路径6 | 同一学生发起多次训练 → 任务名 v1.1/v1.2/v2.1… 可区分（不再都叫 #1）+ 过程版节点显 3 段 versionLabel | UC-6、UC-7 | ET + UT |

> 覆盖方式遵循「核心冒烟集 + UT」原则（CLAUDE.md 持久化测试用例库铁律）：普通 feature 不逐路径新建持久 AT/ET case；本版以既有 academy 冒烟集回归 + UT 覆盖为主，仅当 §2.1「采纳自」引入全新断言场景时评估入选 AT。

---

## 4. 概念对齐（PRD ↔ ui/tech spec，不发明新概念）

| PRD 引用 | 权威 spec |
|---|---|
| 版本树（formal 主干 + process 缩进挂父 + 徽章） | `specs/ui/overall/12-academy.md §4/§11` + `specs/ui/components/academy-page/component-version-tree.md` |
| tuple-grid（四元组，原五元组） | `12-academy.md §4` + `component-tuple-cards.md` |
| 训练观察页（coach chat-col）+ 任务卡入口 | `12-academy.md §4/§5` + `section-student-detail.md` / `section-training-observe` |
| baseline picker（训练发起弹层） | `12-academy.md §9` + `component-training-create-modal.md` |
| memory modal 样式（对齐 chat-page） | `specs/ui/components/chat-page/component-memory-modal.md` |
| 版本 schema / adopt 语义 | `specs/tech/academy/[P0]data_model.md §3/§6` |
| 任务状态机（活跃/终态） | `specs/tech/academy/[P0]training_engine.md` |
| 训练任务名（版本前缀）+ 过程版 3 段 label | `12-academy.md §4` + `[P0]data_model.md §6/§8.4` + api `18-academy` task DTO（反规范化 `baseVersionLabel`） |

**新概念（架构期落 spec）**：
- **「采纳自」溯源徽章**：PRD 描述产品语义（formal 副标题显「采纳自 v{过程版号}」+ 数据源 `adoptedFromProcessVersionId`），架构期落 ui spec（`12-academy.md §4` + `component-version-tree.md`）+ tech spec（`[P0]data_model.md` 加字段 + api `18-academy §1.8` 返回该字段）。

**与既有 spec 的已知差异（doc-modifier 阶段 5 待同步）**：
- `12-academy.md §4` tuple-grid 现描述五元组含 Tools 卡 → 改四元组（Tools 行删）。
- `12-academy.md §4` 任务卡渲染门现隐含 activeTask → 改「该学生最近任务（含终态）」。
- `12-academy.md §5` 训练观察页入口现隐含活跃态 → 扩至终态任务可进。
- `12-academy.md §4` 版本树 formal 副标题位 → 加「采纳自」展示规则。
- `component-tuple-cards.md` Tools 卡 spec → 删除。
- `prd/overall/12-academy.md §12.3` 五元组表 → 注明 Tools 仅装配层、UI 不展示（或调措辞）。
- `specs/api/overall/18-academy.md §6` SSE 章节 → 标「前端轮询兜底，SSE 后置」（本版前端 ~4-5s 轮询，后端 SSE 未落地）。
- `specs/api/overall/18-academy.md` task DTO → 反规范化 `baseVersionLabel`（供前端拼「v{major}.{taskSeq}」任务名）。
- `12-academy.md §4/§5` 任务卡 / 训练观察 / 训练结果 / 教室训练 tab 任务名文案 → 改版本前缀（7 处「任务 #N」+ i18n）。

---

## 5. 验收口径

- **功能**：路径 1-5 全 PASS（API + E2E 覆盖；核心冒烟集 + UT 共同满足最低覆盖）。
- **coach 持续可达不变量**：任务 done 后入口仍在 + coach 可对话（UC-4 实测）；运行中任务卡 + 训练中过程版可见（UC-5 实测）。
- **「采纳自」溯源**：训练接受产生的 formal 显徽章，0.0 不显（UC-1/UC-2）。
- **Tools 卡移除**：tuple-grid 四元组（UC-3）；`version.json.tools` 装配链不受影响（学生 agent 工具集行为不变，UT 覆盖）。
- **Bug 修复**：版本树过程版挂对父 formal、Memory 卡显真实条目、baseline picker 可切任一 formal（UT + ET 冒烟）。
- **任务名版本挂钩**：同 base 多任务显 v1.1/v1.2 可区分（UC-6）；过程版节点显 3 段 label（UC-7）。
- **coach 实时性**：running 中过程版/状态 ~4-5s 内（轮询周期）涌现可见，非仅 re-fetch 后（UC-5）。
- **无视觉保真门禁**（本版无设计稿）。
- **持续可打包护栏**：本版无新依赖/新 session-kind/新 plugin 资源，护栏自检 N/A（纯 UI + 后端字段调整）。

---

## 6. 版本

**v0.0.219** — Academy 学生详情/训练观察 5 问题修复 + coach 持续可达增强（采纳自溯源 + 移除 Tools 卡 + coach 终态可达 + 版本树归属 / memory / baseline picker 修复）。详见本 PRD + change_plan（`specs/tech/version_logs/v0.0.219/change_plan.md`）。
