# Academy 培养 agent — 产品需求文档 [v0.0.210]

> version: 1.0 · 引入版本 v0.0.210 · 最后更新 2026-07-28
> 本文承载 academy 板块全量产品定义（v0.0.210 首版交付：教室 + 班主任 + 学生 + 教练 + 训练引擎 + 版本树 + 简单/多轮训练 + 学习式/训练式 + 评估 + 接受/拒绝 + squad derive + academy UI + 3 academy skill）。
> 增量见 `specs/prd/version_logs/v0.0.210.md`。
> 概念权威源：`specs/tech/academy/`（index.md + 8 个 spec）+ `specs/ui/components/academy-page/`（UI 组件契约，coder 编码前置落）。
> 视觉契约：`reqs/[working] v0.0.210.new_academy/demo/`（index.html 导航 11 页 + `_tokens.css`）。
> API 契约：`specs/api/overall/18-academy.md`（HTTP 端点）。
> 设计决策：`reqs/[working] v0.0.210.new_academy/design.md`（用户多轮拍板的全量决策清单）。

## 目录

| 章节 | 说明 |
|------|------|
| §12.1 产品概述 | academy 定位、核心价值、bizType 三分、nav-rail 第 3 入口 |
| §12.2 核心概念与角色 | 教室/班主任/学生/教练/优化评估 subagent + 会话关系 |
| §12.3 版本模型 | 五元组 + 正式版/过程版 + 接受拒绝语义 + 目录规范 |
| §12.4 训练两模式 | 简单/多轮 + 学习式/训练式 + 评估三要素 + 迭代策略 |
| §12.5 两类要求分流 | 训练内 directive 透传 vs 训练外资产演进 |
| §12.6 squad derive | 员工从教室学生版本派生（二级 select） |
| §12.7 UI / 视觉约束 | demo 视觉契约 + chat 复用 + 训练观察页 + 采纳对比 |
| §12.8 关键用户路径（MANDATORY） | UC-A ~ UC-G（7 条，design §8 case a-g 逐条） |
| §12.9 范围边界（IN / OUT） | v0.0.210 scope |
| §12.10 设计决策摘要 | 12 条用户拍板不变量 |
| §12.11 验收口径 | 功能 / 视觉保真门禁 / agent 侧 / 持续可打包护栏 |

---

## 12.1 产品概述 [v0.0.210]

**academy** = 培养专家 agent 的产品板块：围绕一个目标，通过「教室 + 班主任 + 教练 + 训练引擎」，把一个全空的初始学生版本，经多轮训练迭代，逐步打磨成可用的专家版本，最终可发起会话、可派生到团队。

一句话定位：用户在 academy 里走完「建教室 → 班主任对话建学生 → 备好数据集/评估器 → 发起训练（简单/多轮）→ 看教练进程与评估结果 → 接受为新正式版 → 用版本发起会话 / 派生到 squad」全流程。

### bizType 三分（UI 侧）

| tab | view | 数据源 | 列表隔离 |
|---|---|---|---|
| **Playground** | `currentView='playground'` | `GET /session?biz=playground` | 不含 academy/studio session |
| **Studio** | `currentView='studio'` | `GET /squad` + `GET /session?biz=studio` | 不含 academy session |
| **Academy** | `currentView='academy'` | `GET /academy/...` + `GET /session?biz=academy` | 不含 playground/studio session |

academy 是 nav-rail 顶部第 3 个业务入口（与 Playground / Studio 平级），🎓 图标。

---

## 12.2 核心概念与角色 [v0.0.210]

| 概念 | 说明 | 落点 |
|------|------|------|
| **教室 classroom** | 独立空间，所有其他概念挂在它上面；可建多个 | classroom record（`<DATA_DIR>/academy/<cid>/`）；教室级资产（数据集/评估器/skill）挂教室 |
| **班主任 head teacher** | 每班一个，创建教室自动带；正经 session 可对话；**备好环境（数据集/评估器/学生）+ 发起训练 + 看任务级状态**；会话入口长久在；管理教室资产 | `academy-head_teacher:parent:main` session |
| **学生 student** | 归属教室，一个教室多个学生；**学生 = 一棵版本树的容器**；**每个版本是一个 agent** | `student` record + N 个 `student_version` record |
| **教练 coach** | 每个训练任务对应一个 coach = 一个正经 session，可对话；**task 生产轴绝对主权 + 训练引擎的智能容错层**；通过 `manage-task` 工具完成训练（evaluate/revise/fork/adopt/pause/resume） | `academy-coach:parent:main` session（建任务时自动建） |
| **优化 / 评估 subagent** | coach 完成工作的基础；**只读观察**对象（用户不直接对话，但可看 session 内容） | coach 用 `agent.spawn` 派生（explorer / knowledge_learning_trainer 模板复用现有机制） |

> **训练引擎**（管状态：任务/轮次/过程版本树/评估记录，权威可续跑）是 academy 的核心，但属技术层（specs/tech/academy/[P0]training_engine.md），用户感知为「教练在按状态机推进」。

### 会话关系

- **head ↔ coach 可相互通信**（a2a inbox，`send_message` 拓扑，复用现有机制）。
- **student 异步工作**：不实时对话；产出落**文件**（工作区目录）或 **answer**（外部等待获取）；评估时由训练引擎**直调 LLM**（`LlmCaller.invoke` + pLimit(5)）模拟学生答题，**不起 session**（太贵 + 撞 subagent 并发上限）。
- **任务创建分工**：训练任务由 **head teacher 创建**（head 备好环境发起 → 引擎建任务 + 自动起 coach session 绑定接管）；**coach 不自建任务**，它是被引擎拉起来接管任务的。

### academy session 与 playground/studio 平级

`BizType` 加 `academy`；academy session 不进 playground/studio 列表（`?biz=academy` 独立过滤）。

---

## 12.3 版本模型 [v0.0.210]

### 五元组定义一个 agent 版本（落在一个目录）

> **[v0.0.219] UI 四元组注**：五元组是**数据/装配层**概念（a/b/c/d/e 全在 `version.json` + 工作区目录里，装配链 `resolveToolSet` 仍用 tools 字段）；**UI 学生详情 tuple-grid 只展示四元组**（System Prompt / Skills / Memory / 模型，Tools 卡移除——见 §12.13.2）。下表语义不变，Tools 仅不在 UI 展示。

| 变量 | 载体 | 说明 |
|---|---|---|
| a 模型 | `version.json`（用户设置快照） | 用户指定，不需模型自己探索 |
| b system prompt | `AGENTS.md` | workspace 自动加载 |
| c memory | `.rocky/memory/`（session 级） | workspace 自动加载 |
| d skills | `.rocky/skills/` | workspace 自动加载 |
| e tools | `version.json.tools`（可选白名单） | 缺省 = academy-student profile bound 全集；**[v0.0.219] 仅装配层保留，UI 不展示**（学生详情 Tools 卡移除） |

**启动一个版本的 agent = 用该目录 + `academy-student` session-kind 建会话**（同构 squad member workspace）。

### 版本编号

- **初始版本 = `0.0`**：内容全空，也是正式版本。
- 其他**正式版本**：`1.0` / `2.0` / `3.0` …（用户可编辑，编辑后版本号不变）。
- **过程版本** = `{base正式版}.{任务序号}.{轮次}`（如 `1.2.3` = 基于 `1.0` / 第 2 个训练任务 / 第 3 轮）。
- 一个训练任务（coach）在 base 下占固定「任务序号」，其内部第 N 轮 candidate = 过程版本 `base.任务号.N`。

### 接受 / 拒绝语义（不变量）

- **接受** = 把临时基线**复制为一个全新正式版**（按 seq 找下一个空正式版号分配，如 1.0 → 2.0）并**标记「已采纳」**；**原 base 不动**。
- **拒绝不删除任何数据**：过程版本保留可回看，但不转正。

### 目录规范（产品层可见）

- 正式版目录：`student/versions/{0.0,1.0,…}/ws/`
- 过程版工作区（隐藏）：`student/versions/.work/{base}.{taskSeq}/{round}/ws/`
- **过程版本 = 训练中的临时区**：训练未完成的 candidate 都在 `.work/` 下，不进正式版列表；训练接受后才转正为新正式版目录。

---

## 12.4 训练两模式（能力模型 = 一切出发点） [v0.0.210]

| | **简单模式** | **多轮模式** |
|---|---|---|
| 本质 | **单轮**，优化 skill 直接改 | **带评估**，类似 skillopt 的迭代优化 |
| 前置 | **无**（零依赖兜底） | **需评估能力**（数据集 + 评估器） |
| 优化方式 | 学习式 | 学习式 或 训练式 |
| 流程 | skill 优化 → 新版本 → adopt 归档 | 多轮[生成→评估→决策] → adopt 归档 |
| 评估 | 无（优化 agent 内部可迭代，产品流程无） | 每轮评估判进化/退化 |
| 人工确认 | 接受/拒绝 | 每轮可看 + 最终接受/拒绝 |

- 教室没数据集+评估器 → 只能简单模式；有 → 解锁多轮模式（简单模式仍可用）。
- **简单/多轮都走双引擎，架构统一**。
- **任务由 head teacher 创建**：head 备好环境发起 → 引擎建任务 + 自动起 coach session 绑定接管。

### 12.4.1 优化方式两种（各做成一个 skill）

- **a 学习式**（`learn-skill`）：上网收集人类专家如何解决此类问题——分类细化、找书籍/论文提取方法、查典型正负案例与用户评价、总结常见模式。
- **b 训练式**（`train-skill`）：用训练集模拟学生生成 → 提取结果 → 评估 → 整理正负例 → 反思迭代。

### 12.4.2 评估（Evaluation）

- **数据集** = 训练集 + 评估集；元素 = 问题 case（可带每 case 独立评估标准 + 期望答案）。**挂教室**（不挂学生/任务）。
- **评估器** = 对一道题的打分方法；闭合枚举 `llm-judge`（每 case 独立调 LLM，**不可一个 agent 给多 case 打分**）或 `em`（程序性精确匹配）。**挂教室**。
- **评估结果三要素**：分级（正/反/中性 → 反思）+ 分数（用户视角 → 判进化退化）+ 理由（→ 反思，**必填**）。

### 12.4.3 迭代策略（用户可指定，系统给默认值）

| 策略 | 默认 | 说明 |
|------|------|------|
| 最大轮次 maxTurns | 5（demo）/ 可调 | 硬上限防失控 |
| 早停 earlyStop | 连续 3 轮无提升则停 | 临时基线未更新触发收敛 |
| 接受决策 acceptRule | 新版评估分 > 当前临时基线分 → 替换 | 纯函数 gate（借鉴 skillopt），可扩展「持平不替换」 |

---

## 12.5 两类要求分流（用户补充的关键边界） [v0.0.210]

| 类型 | 例子 | 流向 |
|---|---|---|
| **训练内要求** | 「这次去学《旧猫咪》这本书」「重点优化开头」 | **透传**进训练链路：head → coach → 训练任务（任务加 `directive` 训练目标字段）→ 优化 skill 消费。简单/多轮都有 |
| **训练外要求** | 「评估器怎么迭代」「数据集补 case」 | **head 提前备好**，不进训练任务。head 用工具自己解决（迭代评估器/补数据集/装 skill），属教室资产演进 |

- **点击开始训练就必须能 work**——评估器/数据集是任务输入前提，必须先备好。
- **head 工具集独有「管理教室资产」能力**（`manage-classroom` 工具：增改数据集/迭代评估器/装 skill），coach/student 没有。
- **训练中可注入指导**：训练引擎可接收「指导消息」，下轮反思时纳入上下文（head/用户注入引导，不打断程序推进）。

---

## 12.6 打通 Studio：员工 derive from 教室学生 [v0.0.210]

- squad 员工可 **derive from 任一教室任一学生**（二级选择：教室 → 学生 → 版本）。
- 派生 = **复制该学生版本的工作区相关内容**（AGENTS.md / `.rocky/memory/` / `.rocky/skills/`）作为新成员初始工作区内容。新成员独立演化，不影响教室里的学生。
- **限制**：只能从**正式版本 + active**派生（过程版本 = 训练中临时区，不可派生；rejected 版本不可派生）。
- **UI 形态：复用创建 member 的地方做二级 select**，融入现有 member-create 流程（Fresh / Derive / **From Classroom** choice-cards 里加第三项），**非独立大页面**。

---

## 12.7 UI / 视觉约束（用户 review demo 后定稿） [v0.0.210]

> demo 见 `reqs/[working] v0.0.210.new_academy/demo/`（index.html 导航 11 页互通：01-classroom-list / 02-classroom-detail / 03-student-detail / 04-training-observe / 05-training-create / 06-training-result / 07-squad-derive / 08-coach-readonly / 09-version-edit / 10-version-chat）。**设计稿 = 视觉契约**，功能正确 ≠ 视觉还原，二者都是验收门槛。

1. **所有 chat 一律经统一 chat 组件接入（`section-chat-session`），不创新，只能微调**：coach/学生/head 对话全用现有 chat 页布局（会话列表 + topbar + 消息流 + 输入框），内容微调、结构不发明。**能力与主聊天同等（全开）**：提问卡/审批卡（HITL）、停止按钮、effort/审批模式两 picker、model picker、排队区、usage 三件套、minimap、右上悬浮菜单——academy 侧不做降级变体（来龙去脉见 `specs/prd/version_logs/v0.0.216.md`）。
2. **Markdown 查看/编辑 = 统一弹层（modal）**：view/edit 两种 mode 切换；未来做成统一 md 编辑器组件保持全站一致。**版本编辑从整页改为弹层**。
3. **学生会话 = 完全复用 playground-rocky**：usage 等组件复用；右侧就是 ws（workspace）面板，memory 等入口放 playground 对应位置（右上悬浮菜单）。去掉自定义右侧面板。
4. **训练观察页**：**coach 对话在中间**（复用 chat 设计），**训练视图在右侧**（更大）。
5. **右侧训练视图是复杂页面，要体现**：当前**临时版本**（哪些基于临时 base 已变化；可切「vs 临时 base」/「vs 训练 base」对比）；已评估版本**是否通过成为新临时基线** + **每题分数**；**当前迭代状态 + 训练任务状态**。
6. **优化类型分详略**：学习 = agent + 结果即可（轻）；训练 = 每 case 结果 + 评估结果 + 反思（深）。
7. **coach 可对话**（非只读）；**只读的是优化/评估 subagent**。要和 subagent 沟通 → 跟 coach 说，coach 用 `send_message` 转达。
8. **subagent 观察入口**：**只在进行中可点**——优化/评估正在跑时那个 step 的 working 状态可点进去看（只读 transcript），看完可返回；**跑完就没有入口**（看过程非查历史）。
9. **采纳对比**：system/memory/skills **逐项左右 diff**，同 item 对比，**可展开/关闭**；skill 支持**整体新增**或**单文件改变（文件级 diff）**；memory 逐条对照。
10. **派生 = 复用创建 member 处做二级 select**（见 §12.6）。

---

## 12.8 关键用户路径（MANDATORY — 测试最低覆盖）

每条路径 = 至少一个 API/E2E case（对齐 design.md §8 case a-g）。

| # | 路径名 | 用户操作链路 | 预期结果 |
|---|---|---|---|
| **UC-A** | 创建教室 | 进入 Academy → 点「新建教室」→ 填名字 + **选默认模型**（必选，[v0.0.230 modified]）→ 确认 | 教室创建 + 自动建班主任 session + 教室列表新增条目 + 进入教室详情见班主任对话入口 |
| **UC-B** | 创建学生 | 在教室对话中告诉班主任「建一个学生，名字 X」或点产品入口「新建学生」→ 填名/logo → 确认 | 学生 record + 初始 0.0 正式版本目录建立 + 学生列表/树显示 + 0.0 版本工作区全空可编辑 |
| **UC-C** | 编辑版本内容 | 进学生详情 → 选正式版本 → 四元组卡 item（如 System Prompt 卡）「编辑」→ 弹层 md 编辑器（view/edit 切换）→ 编辑（AGENTS.md / 装载 skill / memory / model）→ 保存 | 版本目录内容更新；版本号不变；启动该版本 session 反映新内容 |
| **UC-D** | 发起简单学习训练 [v0.0.221 modified] | 进学生详情 → 点「发起训练」→ 选「简单模式 + 学习式」+ 填 directive（训练目标）→ 提交 → 等候 → 看结果 | 任务创建 + coach session 自动建 + coach 跑完一轮学习；**v0.0.221 起**：去 `propose → 接受/拒绝`，coach 自主迭代 → 可 `adopt(versionId)` 定稿为新 formal（用户/UI 点采纳走同一 action）；task 一旦建就长期存活，不随单轮结束（参 §12.14.1/2） |
| **UC-E** | 发起多轮训练式训练 [v0.0.221 modified] | 进学生详情 → 「发起训练」→ 选「多轮模式 + 训练式」+ 选 dataset/grader + maxTurns + directive → 提交 → 观察每轮 → 看最终 propose | 每轮自动 sample→grade→decide；右侧训练视图显示每 case 分数 + 临时基线 + 决策；**v0.0.221 起**：去最终 propose；多轮中任何时刻可 `adopt` 某版定稿；task 不结束，round 可继续递增（受 maxTurns 上限，到顶需 `update_task` 调大续训，参 §12.14.1） |
| **UC-F** | 训练中对话 + subagent 只读观察 [v0.0.221 modified] | 训练进行中 → 进训练观察页（coach 对话中间 + 训练视图右侧）→ 用户↔head 对话 / 用户↔coach 对话；点 subagent working 状态 → 只读 transcript（无输入框） | head/coach 可对话；优化/评估 subagent 只读可见；跑完后入口消失；**v0.0.221 起**：head 不再有只读 `evaluate` 工具，要看 task 内部细节 → `send_message` coach（参 §12.14.4） |
| **UC-G** | 正式版本发起会话 | 进学生详情 → 选某正式版本 → 点「发起会话 / Open Playground」 | 用该版本目录 + `academy-student` kind 建会话 → 进 chat 页（复用 playground-rocky）正常聊天，行为反映该版本五元组 |

### E2E Use Cases 表（每功能章节末尾 MANDATORY）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 打开 academy 页 → 点新建教室 → 填名字 + 选默认模型 → 确认 → 教室列表新增 → 进教室详情 | 自动建班主任 session；班主任对话入口可用 |
| UC-2 | 教室详情 → 对话/产品入口创建学生 → 填名 → 确认 → 学生列表新增 → 0.0 版本自动建立 | 学生 record + 初始 0.0 版本工作区全空可编辑 |
| UC-3 | 学生详情 → 选正式版本 → 四元组卡（如 System Prompt）「编辑」→ 弹层 md 编辑器（view/edit 切换）→ 改 AGENTS.md → 保存 | 版本目录内容更新；版本号不变；启动 session 反映新内容 |
| UC-4 | 学生详情 → 发起训练（simple+learning+directive）→ 等候 → 看 coach 跑完 → **[v0.0.221 modified]** coach 可 `adopt(versionId)` 定稿为新 formal | coach 自动跑完一轮学习；**v0.0.221 起**：去 propose→接受，改为 coach 自主迭代 → adopt 定稿（用户/UI 点采纳走同一 action）；task 长期存活可续训 |
| UC-5 | 学生详情 → 发起训练（multi+training+dataset/grader+maxTurns）→ 观察每轮 → **[v0.0.221 modified]** 任何时刻可 `adopt` 某版定稿 | 每轮自动 sample→grade→decide；右侧训练视图可见；**v0.0.221 起**：去最终 propose；可多次 adopt；task 不结束，round 可续递增（受 maxTurns 上限，到顶需 update_task 调大） |
| UC-6 | 训练观察页 → head↔coach 对话；用户↔head/coach 对话；subagent working 时只读入口可点；**[v0.0.221 modified]** head 看内部细节 → `send_message` coach | 对话通；subagent 无输入框；跑完入口消失；**v0.0.221 起**：head 无只读 evaluate，要看 task 内部 → send_message 驱动 coach |
| UC-7 | 学生详情 → 选正式版本 → 发起会话 → 进 chat 页 → 聊天 | 版本 agent session 启动；行为反映版本内容 |

---

## 12.9 范围边界（IN / OUT）

### IN SCOPE（v0.0.210）

- 教室/学生/版本/训练任务/轮次/数据集/评估器全实体 CRUD + academy 域 store。
- 3 新 session-kind（`academy-head_teacher` / `academy-coach` / `academy-student`）+ 9 profile/scope yaml 矩阵 + `manage-task` 工具（coach 专属，13 action）+ `manage-classroom` 工具（head 专属，20 action）。
- 训练引擎：状态机 + runTurn + 评估 fan-out + 接受拒绝 + 断点续跑 + 事件回推 inbox。
- 3 个 academy skill（`learn-skill` / `train-skill` / `judge-skill`）。
- academy 域观察 UI（教室列表/详情/学生详情/训练观察/版本编辑/版本会话）+ squad-derive 入口（member-create 加「From Classroom」选项）。
- nav-rail 第 3 业务入口（Academy 🎓）+ bizType 三分隔离。
- 训练中指导消息注入 + subagent 只读观察入口（仅 working 时）。

### OUT OF SCOPE（显式不做）

| 排除项 | 理由 |
|---|---|
| 旧 academy（v0.0.183）兼容 | 旧版已于 v0.0.208 删除，本版当全新功能设计 |
| 评估器类型扩展（regex/contains/rubric） | 首版只 `llm-judge` + `em`，按需扩 |
| 学习式自动 revise | 学习式走 simpleModeFlow（coach 自由发挥），引擎不自动推进；revise 仅训练式用 |
| 训练任务跨教室共享 | 任务挂在教室内（classroomId 外键） |
| squad member 反向 import 回 academy | 派生单向（学生 → member） |
| DELETE classroom / hard delete 学生 | 与 squad 一致，软删/归档兜底 |

---

## 12.10 设计决策（用户拍板 + design.md 锁定）

1. **一个 agent 的一个版本 = 一个工作区目录**（五元组全在目录里）；启动版本 agent = 用目录 + `academy-student` kind 建会话。
2. **版本模型**：初始 = 0.0 正式版；正式版用户可编辑号不变；过程版 `base.任务号.轮次`；接受 = 复制为新正式版（原 base 不动）；拒绝不删除任何数据。
3. **双引擎架构**：agent 引擎（head/coach/student 正经 session，可对话）+ 训练引擎（结构化状态机，权威/可续跑）；咬合 = 工具操纵 + 事件回推 inbox。
4. **状态机推进权归程序，不归 agent**（agent 自觉靠不住；async 结果送达是语义合同非机制）。
5. **coach = 训练引擎的智能容错层**：必须通过 `manage-task` 工具完成训练；脏活（数据格式错/case 为空/评估 JSON 解析失败）coach 自己用智能解决（多耗 token 换可靠性），引擎保持干净。
6. **两工具拆分（v0.0.221）**：`manage-task`（coach 专属，13 action = evaluate/revise/fork/sample/grade/adopt/pause/resume/status/turn_result/history/read_dataset/read_grader）+ `manage-classroom`（head 专属，20 action = 教室资产 9 + 学生 CRUD 7 + 任务监督 4）。
7. **评估 fan-out 走直调 LLM（`LlmCaller.invoke` + pLimit(5)），不起 session**（subagent 并发上限 per-parent=4/global=8 + 不可再派生）；**每 case 独立 LLM 打分是硬要求**。
8. **两类要求分流**：训练内 directive 透传；训练外要求 head 提前备好；**点击开始训练就必须能 work** = 评估器/数据集前提。
9. **并行任务隔离**：head 只管备环境+发起+看任务级状态，不碰任务内部脏活；每任务一个专属 coach 兜底细节。
10. **squad 派生 = 复制版本工作区内容**；只允许 formal + active；process / rejected 不可派生。
11. **academy session 与 playground/studio 平级**（bizType 三分；nav-rail 第 3 入口）。
12. **完整实现不分期**：一个版本内交付完整功能（内部分任务切片；不做空架子分期）。

---

## 12.11 验收口径

- **功能**：UC-A ~ UC-G 全 PASS（API + E2E 覆盖；版本冒烟集 + UT 共同满足最低覆盖，参 CLAUDE.md「持久化测试用例库」）。
- **视觉保真（有设计稿 MANDATORY）**：11 页 demo `vision_check.py compare` 逐维度（layout/font/border/color）比对；明显偏差建 BUG 待修（规范见 `specs/ui/components/_conventions.md §9`）。
- **agent 侧**：head/coach 可对话；优化/评估 subagent 只读；训练引擎状态机推进 + 断点续跑 + 评估 fan-out 真调 LLM。
- **持续可打包护栏（MANDATORY）**：新 session-kind yaml/skill 资源进 asar（build-plugins `copyResources` 覆盖）；新依赖归属正确 workspace `package.json`；无字面 `~`/相对路径（走 `resolveDataDir`）。

---

## 12.12 版本

**v0.0.210** — academy 板块首版（教室 + 班主任 + 学生 + 教练 + 训练引擎 + 版本树 + 简单/多轮训练 + 学习式/训练式 + 评估 + 接受拒绝 + squad derive + academy UI + 3 academy skill + nav-rail 第 3 入口 + bizType 三分）。详见 `specs/prd/version_logs/v0.0.210.md` + 概念 spec（`specs/tech/academy/`）+ 视觉契约（demo 11 页）。

---

## 12.13 v0.0.219 变更（academy_opt — bug 修复 + coach 持续可达）[v0.0.219]

> 增量详见 `specs/prd/version_logs/v0.0.219/prd.md`。本节只列用户可感知的产品点；纯技术 bug 修复（spec 对齐）不展开。

### 12.13.1 「采纳自」溯源展示
学生详情版本树 formal 版本副标题展示「采纳自 v{过程版号}」（数据源新 schema 字段 `adoptedFromProcessVersionId`，架构期落 tech spec）。初始 0.0 不显。

### 12.13.2 移除 Tools 卡（五元组 → 四元组）
学生详情 tuple-grid 由五元组变为四元组（System Prompt / Skills / Memory / 模型），Tools 卡 UI 入口移除；`version.json.tools` 数据字段保留供装配链使用。§12.3 五元组表语义不变（Tools 仍在装配层），仅 UI 不展示。

### 12.13.3 coach 持续可达（产品不变量）+ 实时可见
训练任务一旦创建，其 coach 始终可进入对话：① 任务卡「进入观察」入口不再仅限活跃态（running/pending/awaiting_confirm），终态（done/rejected/**aborted**）后仍可进训练观察页与 coach 对话（aborted 亦有复盘价值，用户「总是可以进去」）；② 运行中任务卡 + 版本树训练中过程版**实时可见**——修复训练中页面 freeze 到「结束后才出来」的实时性 bug：后端 training.\* SSE 未落地（spec `18-academy §6` 声明但代码缺），本版以**前端 ~4-5s 轮询兜底**（检测 active task 时周期 reload detail），SSE 后置。

### 12.13.4 任务名版本挂钩
任务显示名由通用「任务 #N」改为版本前缀「v{baseMajor}.{taskSeq} 训练任务」（如 base 1.0 + taskSeq=2 →「v1.2 训练任务」），过程版节点显 3 段 versionLabel（如 1.2.3）。后端 taskSeq 分配正确（per-base 递增），「都叫 #1」源于 base 轮换 + 显示用裸 taskSeq，非后端 bug；仅改显示文案 + 后端 task DTO 反规范化 `baseVersionLabel`。

### 12.13.5 Bug 修复（spec 对齐，提及不展开）
版本树过程版挂对父 formal（§12.7 视觉约束既有规则）、Memory 卡展示真实条目（对齐 chat-page memory modal）、训练发起 baseline picker 可选任一 formal（§12.7 训练发起弹层既有概念）。

> spec 细节对齐（§12.3 五元组措辞 / §12.7 tuple-grid 四元组 / 任务卡渲染门 / 版本树 formal 副标题规则 / 任务名文案 / `18-academy §6` SSE 章节标轮询兜底 / task DTO 反规范化 `baseVersionLabel`）由 doc-modifier 阶段 5 统一同步。

---

## 12.14 v0.0.221 变更（coach_enhance — coach 主权 + 两轴模型）[v0.0.221]

> 增量详见 `specs/prd/version_logs/v0.0.221.md`。本节列用户可感知的产品点；纯技术（工具改名 train-student→manage-task / mapper impl / 状态机字段名 / 目录路径段数方案）不展开，归 architect。

**核心模型重构**：把绑死的「task → propose → accept → done → 新 formal」一根线，拆成两根**正交轴**：
- **生产轴（task）**：coach 绝对主权、长期存活、可续训（round 在同一 task 内递增，不需新建 task）。
- **归档轴（采纳）**：`adopt(versionId)` 任意 process 版定稿为新 formal，可重复，**不改 task 状态**。

### 12.14.1 coach 绝对主权 + task 可续训 [v0.0.221]
- task **非终态**：原 `done / aborted / stopped` 统一为 `paused(reason)`（`maxturns / completed / stopped / earlystop`）。coach 可 `resume` 续训起 round N+1。
- **maxTurns 硬上限不可越过**：到顶（reason=maxturns）即终态、不可 resume 越过；要继续须先 head/用户 `update_task(maxTurns=N+x)` 调大现有 task 的 maxTurns 再 resume——**不开新 task / 不产新 formal**（maxTurns 默认设大避免过早触顶）。
- `propose` action **取消**（采纳解耦，coach 直接 adopt）；原 task 级 `awaiting_confirm / rejected` 去除。单个 process 版本仍可有 `status='rejected'`（coach `fork` 丢弃的**版本级**状态，非 task 级）。
- **directive 语义调整**：从「透传消费的硬命令」改为「advisory 输入」——coach 主权下，directive 是主要参考，非必须执行。

### 12.14.2 采纳解耦（任意版本 / 可重复 / 不杀 task） [v0.0.221]
- coach `adopt(versionId)` 把**任意** process 版定稿为新 formal（x.0 递增）；原 base 不动；记 `adoptedFromProcessVersionId` 溯源（§12.13.1 已落字段）。
- **可多次 adopt**（1.1.2→2.0，续训，1.1.5→3.0）；**adopt 不改 task 状态**，task 仍在产——一个 task 一生可产出多个 formal 版本。
- UI「点采纳」走同一 engine action（人触发口，不阻塞 coach）。

### 12.14.3 临时基线可干预（fork 切任一历史版本作起点） [v0.0.221]
- **默认自动接续**：`revise` acceptGate 判 improve → candidate 晋升为临时基线，下轮自它 fork。
- **可干预（分叉 / 回退）**：coach `fork(baseVersionId=<任一历史版本>)` 切临时基线（如「基于 1.1.1 续一个 iteration」）；下轮自指定版本起、acceptGate 也对比它。user/head 可建议；UI 可让用户点某版本 → 路由到 coach 的 fork。
- **versionLabel = `{major}.{taskSeq}.{round}`**（3 段，task 身份 + iteration 序）——不强制线性链，允许分叉与回退。

### 12.14.4 head 退教室层 + 不进 task 内场 [v0.0.221]

| 维度 | head_teacher | coach |
|---|---|---|
| 作用域 | 教室（classroom）全局 | **单个 task**（1:1 绑定） |
| 访问粒度 | 实体级（Id） | 文件级（workspace 路径） |
| 任务 | `start_task` / 监督看板（`list_tasks` / `get_task` / `update_task`） | **全权推进 + 定稿 + 生命周期** |
| task 内部动作 | ❌ 一律不执行 → `send_message` 给 coach | ✅ 全部（evaluate/revise/fork/adopt/pause/resume） |

- head 工具**没有**任何 task 内部 action（evaluate/revise/fork/adopt/pause/resume/propose 全交还 coach）；仅有的 task 相关 action：`start_task / list_tasks / get_task / update_task(maxTurns?, directive?) / send_message`（监督级，不下钻 per-case）。
- `update_task` 仅调 `maxTurns / directive` 两字段——让 coach 续训越过原 maxTurns 上限（§12.14.1），或调整 directive 给建议。
- **head ∩ coach = task 客观事实**（元数据 + 状态 + 版本集 + 轮次历史摘要）；差异仅在访问粒度与动作权——这是 send_message 协作的契约锚点。

### 12.14.5 版本号修复 + 信息供给完善 [v0.0.221]
- **versionLabel 写正确（BUG）**：用户看到的「1.1.x」不再混乱——`version.json.versionLabel` 之前恒 "0.0"（写侧 bug），本版 fork/adopt 写侧补写正确 `{major}.{taskSeq}.{round}`；**UI 显 versionLabel 字段、不显目录名**（过程版目录段数为隐藏实现细节）。过程版目录路径段数简化列 follow-up，不在本版。
- **coach 信息供给完善**：mapper `academy_iteration_state` 扩充常驻注入——candidate/base **workspace 绝对路径** + 版本谱系（本 task 全部 process 版）+ 已采纳 formal 列表 + 生命周期态（resumable）+ maxTurns 软提示 → coach 永远不需要 `ls`/猜目录（修 messages.log 里 coach `bash ls .work` 摸目录的病）。
- **head 信息供给完善**：mapper `academy_task_status` 补每 task 的 `coachSessionId`（head send_message 目标）；**新增 `academy_head_role` mapper** 注入「task 内部要效果 → send_message 给该 task 的 coach，别自己伸手」指引。
- **附 BUG（随本版修，技术细节归 architect）**：① versionLabel 恒 "0.0"（写侧未写）；② 过程版目录 major 算错（污染源于 ①）；③ adopt 不同步 `student.currentFormalVersionId` 指针（pre-existing BUG-001，adopt 改造时一并修）。

### 12.14.6 E2E Use Cases（v0.0.221 新增/变更路径）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-221-1 续训 | coach 任务 paused（reason≠maxturns）→ coach `resume` → round N+1 | 不开新 task / 不产新 formal；round 递增；task 状态回 running |
| UC-221-2 到顶调大 | task paused(reason=maxturns) → head `update_task(maxTurns=N+5)` → coach `resume` | maxTurns 调大后续训，**不开新 task / 不产新 formal**；硬上限不可越过 |
| UC-221-3 采纳任意版 | coach/UI 点某 process 版「采纳」→ adopt(versionId) → 新 formal（x.0 递增） | task 状态不变（仍在产）；可多次 adopt；`adoptedFromProcessVersionId` 溯源正确 |
| UC-221-4 head 驱动内场 | head 在教室对话 → `send_message` 给该 task 的 coach → coach 在 task 内做事 | head 不直接伸手 task 内场；coach 收到建议自主决策执行 |
| UC-221-5 切基线 | coach `fork(baseVersionId=<历史版本>)` → 下轮自该版本起 + acceptGate 对比它 | 临时基线切到指定历史版（分叉/回退），不开新 task；round 递增 |
| UC-221-6 版本号正确 | 训练产过程版 / adopt 产 formal → UI 查看 | versionLabel 正确（`{major}.{taskSeq}.{round}` / `{x}.0`）；UI 不显目录名（不出现 4+ 段） |
| UC-221-7 信息供给 | 新建/续训 task → coach system prompt iteration_state | 含 candidate/base ws 路径 + 版本谱系 + 已采纳 formal + resumable + maxTurns |

> §12.8 原 UC-D / UC-E 已标 `[v0.0.221 modified]`：去 `propose → 接受/拒绝` 尾段，改为 `coach 自主迭代 → adopt 定稿`；task 一旦建就长期存活，可续训。详细路径→case 映射见 `specs/prd/version_logs/v0.0.221.md §3`。

> spec 细节对齐（§12.2 角色表 / §12.3 版本模型 / §12.4 训练两模式去 propose / §12.5 directive advisory / `specs/tech/academy/index.md §④` 不变量 2 / `specs/api/overall/18-academy.md` adopt+resume+update_task+去 propose 路由+task DTO 反规范化 coachSessionId）由 doc-modifier 阶段 5 统一同步。

---

## 12.15 v0.0.233 变更（derive_conflict_resolve — 派生升级：继承预检 + 同名裁决）[v0.0.233]

> 增量详见 `specs/prd/version_logs/v0.0.233/change_log.md`。本节列用户可感知的产品点；预检 API 形态 / 裁决 body schema / seed 补偿等纯技术契约归 architect（落 `11a-squad-endpoints.md` + `[P1]squad_derive.md`）。
> 概念权威源已读对齐：`specs/tech/academy/[P1]squad_derive.md`（v0.0.233 reframe 到预检+裁决终态）+ `specs/api/overall/11a-squad-endpoints.md §2.1` + `specs/ui/components/academy-page/component-derive-academy-picker.md` + `specs/prd/overall/13-agent-definition.md`（v0.0.232 团队 ws 简化后 seed 落点）。

### 12.15.1 背景（v0.0.232 后浮现）[v0.0.233]

v0.0.232 把 squad session `workspaceDir` 统一团队盘后，derive_academy（§12.6）的 seed 落点重映射：学生 `AGENTS.md` → `squads/{sid}/.rocky/agents/{名字}-{memberId}.md`（member 私有个人差异）；学生 `.rocky/skills` / `.rocky/memory` → `squads/{sid}/.rocky/skills` / `.rocky/memory`（**团队盘，全队共享**）。现状「一次性自动 copy + 同名覆盖」在多个 member 各自从不同学生派生、带同名 skill/memory 时**静默覆盖**前者，用户无感知；学生 memory 直接变团队共享记忆可能污染其他 mate 行为。本版本把派生升级为「继承预检 → 同名裁决 → 执行」。

### 12.15.2 继承预检（派生前一步）[v0.0.233]

From Classroom 选定 classroom/student/version 后、**派生前**展示「将带过去的东西」清单（学生的 AGENTS.md / skills / memory），并对每项 skill/memory 预检 squad 团队盘（`squads/{sid}/.rocky/skills` + `squads/{sid}/.rocky/memory`）是否已有同名，把同名项标出来。AGENTS.md 是个人差异文件（文件名带 memberId），天然无同名概念，仅标「将带入」。

### 12.15.3 同名裁决（默认不覆盖 + 可选覆盖）[v0.0.233]

- **同名项默认不覆盖**（保留 squad 团队盘原有的）
- 用户可在继承预览面板**逐项**打开「覆盖」开关
- **不同名项直接 merge**（带过去）
- 裁决结果传 hire body，seed 按裁决结果 per-item 执行 skip / overwrite

**默认不覆盖的产品理由**：squad 团队盘已有的 skills/memory 是团队现行运作的资产（可能已被其他 mate 使用 / 依赖），静默覆盖会破坏现行行为且用户无感知；默认保留 = 保护存量；用户明确想用学生版本时手动打开覆盖 = 显式意图。用户可感知行为：同名项默认不被覆盖（squad 原文件不动），预览面板清晰标出「同名 N 项默认保留原 squad」，用户逐项改为覆盖时显式确认。

### 12.15.4 memory 走同一套裁决（落点不变，只加同名保护）[v0.0.233]

memory 与 skill 走**同一套**同名裁决（不单独排除）：默认保留 squad 团队盘同名 memory，用户可逐项打开覆盖。**memory 落点不变**（仍团队盘 group scope，全队共享——v0.0.232 既定，本版本不改）：派生来的 memory 落团队盘 group scope，其他 mate 共享读这些 memory；本版本**只加同名保护**（默认不覆盖 squad 现有同名 memory），不改落点 / 不改共享语义。这是用户接受的「继承融合」语义。

### 12.15.5 继承预览面板交互形态 [v0.0.233]

对齐 `component-derive-academy-picker`（现有 grid 2 列 ① 教室 + ② 学生·版本 + copy-note + foot 取消/派生）扩展：选定 classroom/student/version 后，在派生按钮上方插入**继承预览面板**，形态：

- **清单分组**：AGENTS.md（1 项，无同名开关，标「将带入」）/ skills（N 项）/ memory（N 项）
- **每项一行**：名称 + 状态徽章（不同名 = 「新增」sage 色；同名 = 「同名 · 保留原 squad」amber 色 + 右侧覆盖开关 off 态）
- **覆盖开关**：仅同名项有（不同名项无开关——直接 merge，无决策空间）；默认 off = 保留 squad 原有，用户点开 on = 该项将被学生版本覆盖；开关出现/消失不导致其他项位移（预留固定空间）
- **同名计数提示**：面板顶部 summary「将带入 X 项 · 其中 Y 项同名默认保留原 squad」（用户可一眼看清需不需要逐项裁决）
- **派生按钮**：底部保留现有「取消 / 派生为成员 →」（裁决结果随派生提交）

视觉基线（无设计稿，在组件 spec 内定，遵循 `specs/ui/components/_conventions.md`）：状态徽章用现有 `status-badge` 风格；覆盖开关用现有 toggle 风格；面板容器沿用 derive-panel 的 border + rounded-xl + bg-surface。具体尺寸 / 字号 / 间距由 coder 编码前置落 `component-derive-academy-picker.md` 视觉基线字段。

### 12.15.6 E2E Use Cases（v0.0.233 新增路径）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-233-1 全不同名一键派生 | From Classroom 选 classroom/student/version → 预览面板全项标「新增」（无同名）→ 点「派生为成员」 | AGENTS.md 落个人差异文件；skills/memory 全部 merge 进团队盘；新 member session 启动能读到 |
| UC-233-2 同名默认不覆盖 | 选 version（学生带的某 skill/memory 与 squad 团队盘同名）→ 预览同名项默认「保留原 squad」→ 不改开关 → 派生 | 同名项跳过（团队盘原文件不动），不同名项 merge；派生后团队盘原内容未变 |
| UC-233-3 同名逐项覆盖 | 选 version（有同名）→ 预览同名项默认「保留」→ 用户打开某项「覆盖」开关 → 派生 | 打开覆盖的项被学生版本替换；未打开的保留；团队盘对应项已变为学生版本 |
| UC-233-4 memory 同名裁决 | 选 version（学生 memory 与 squad 团队盘同名）→ 预览该 memory 默认「保留」→ 打开覆盖 → 派生 | memory 走与 skill 同套裁决；落团队盘 group scope 其他 mate 共享读；同名默认不覆盖保护现行团队记忆 |
| UC-233-5 AGENTS.md 无冲突直接带 | 选 version（学生有 AGENTS.md）→ 预览 AGENTS.md 项标「将带入」（无同名开关）→ 派生 | AGENTS.md 落 `.rocky/agents/{名字}-{memberId}.md`（带 memberId 无同名）；新 member prompt 含该正文（叠加团队 AGENTS.md 之上） |

> §12.6 squad derive 段维持「派生 = 复制版本工作区内容」的总语义不变；本版本只把「一次性 copy」升级为「预检 + 裁决 + 执行」，落点 / 共享语义 / 单向不变量均沿用 v0.0.232。

> spec 细节对齐（`specs/tech/academy/[P1]squad_derive.md` reframe：删 §5.2「独立演化」对 skills/memory 的旧约束 + 描述新预检/裁决机制 + 入参签名对齐 v0.0.232 现状 + 本版本新契约；`specs/api/overall/11a-squad-endpoints.md` 加预检 API + hire body 扩展裁决结果；`specs/ui/components/academy-page/component-derive-academy-picker.md` 加继承预览面板 + 视觉基线）由 doc-modifier 阶段 5 统一同步。
