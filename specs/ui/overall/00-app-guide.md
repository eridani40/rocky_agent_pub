# Rocky Agent — App 布局手册（User Guide）

> 定位：**整个 app 的导航地图**——用户大体操作路径、功能从哪进、链路怎么走、页面怎么布局。
> 用途：① 用户上手手册；② **端到端真实跑（playwright）的导航底图**——照着本手册能从入口一路点到任意功能、看清每步落在哪个页面。
> 维护：**每个版本的功能开发完成后，doc-modifier 同步更新本手册**（新增/变更板块、入口、操作路径）。详见文末「维护规则」。
> 权威源：本手册是「导航总览」；每个板块的组件级视觉契约归 `specs/ui/components/<板块>/`，行为/路径归 `specs/prd/overall/`。

---

## 1. 整体布局（3 栏持久 chrome）

整个 app 是一个**持久 3 栏外壳**，切板块时只有最右「main 区」换内容，左两栏（nav-rail + 板块 sidebar）常驻不重渲染：

```
┌──────┬───────────────┬───────────────────────────────────┐
│      │               │                                   │
│ nav  │  板块 sidebar  │            main 区                │
│ rail │  （各板块自管）│   （按 currentView 路由到 page）   │
│ 56px │   宽度随板块   │                                   │
│      │               │                                   │
└──────┴───────────────┴───────────────────────────────────┘
```

- **nav-rail（最左 56px）**：app 全局导航，点图标切板块（=`currentView`）。
- **板块 sidebar**：每个板块自己的二级导航（squad 列表 / session 列表等），切板块时整个换掉。
- **main 区**：按 `currentView` 路由到对应 `page-*`，承载板块主体。

> 三栏外壳由 `app-shell` 提供；`currentView` 存在 zustand `view-store`，nav-rail 只转发点击、不持状态。

---

## 2. nav-rail 7 个入口（从哪进）

nav-rail 自上而下两组：

### 顶部业务区（3 项 — 主功能）

| 入口 | 管什么 | 落到哪个 page |
|------|--------|--------------|
| **Playground** 💬 | 个人对话（与 Rocky 一对一聊天 / 工具调用 / 多轮） | chat 页 |
| **Studio** 👥 | 团队（squad）管理与团队对话 | studio 页（squad 列表 + 首页[坐席+全景+token]/群聊/成员） |
| **Academy** 🎓 | 教室培养 agent（head/coach/student + 训练引擎打磨版本） | academy 页（教室列表 + 教室详情/学生详情/训练观察/版本会话） |

### 底部独立入口（4 项 — 配置/资源）

| 入口 | 管什么 |
|------|--------|
| **SKILLS** | 技能（skill）管理 — 给 agent 用的能力包 |
| **渠道** | 渠道管理 — 外部接入 |
| **连接器** | 连接器管理 — 外部系统/MCP/插件接入 |
| **应用设置** ⚙ | 合并页：app config + dev config + 插件 三 tab 合一 |

> brand「R」置顶（静态标识，不可点）。nav-rail 无齿轮子菜单，4 个底部入口都是独立图标。

---

## 3. 各板块操作路径速查

### 3.1 Playground（个人对话）
- **路径**：nav-rail「Playground」→ 左侧 session 列表 → 选/建会话 → 右侧 chat 区发消息。
- **功能链路**：发消息 →（LLM 回复 / 工具调用 / 多轮）→ 上下文超阈值自动压缩。
- **聊天消息链接点击分发（三处 chat 页共享：playground / studio 单聊·群聊 / academy 版本会话）**：agent 回复气泡里的 markdown 链接 `[文本](target)` 可点击，按 target 类型分流——`http(s)`/`mailto:` 等 web scheme → **系统默认浏览器**打开（不在 app 内导航）；本地路径且扩展名属 12 种内置格式（`.md`/`.json`/`.jsonl`/`.yaml`/`.xml`/`.toml`/`.csv`/`.tsv`/`.txt`/`.ini`/`.env`/`.log`）→ **app 内弹只读 viewer**（modal，无「编辑/保存」按钮；workspace 相对路径读 workspace 文件，绝对路径/`~`/`file://` 直接读；文件不存在时聊天区底部给一行「文件未找到」提示）；图片/pdf/代码等其它本地路径 → **系统默认应用**打开；`javascript:` 等危险协议降级纯文本不可点。LLM 已被 system prompt 引导用链接语法输出路径/URL，故 agent 提到的文件一般都能直接点开。组件契约 `chat-page/component-chat-link-viewer.md` + `common/component-modal-md-editor.md`。
- **会话列表排序 + 置顶（v0.0.231）**：列表 = 置顶组在前、非置顶组在后，**同组内按更新时间倒序**（最新在上）；新建会话 / 发消息对话 / 置顶切换后列表**立即自动归位**，无需手动刷新。**置顶操作**：右键会话项 → 菜单「置顶」（在「复制 Session ID」之上；已置顶则显示「取消置顶」）→ 该会话进列表顶部置顶组，item 最右侧常驻 pin 图标 + 背景加重区分；取消置顶 → 回到非置顶组按原对话时间归位（可能不在顶部）。置顶状态跨 app 重启保留。
- **右侧 workspace 面板（ws-panel，3 处 chat 页共享：playground / academy 版本会话 / studio 单聊）**：文件树浏览（**文件按自然序排列——文件夹置顶 + 同组内数字段按数值比较，如 `90.txt` 排在 `100.txt` 前；顶层与子目录同规则；SSE 文件变化刷新后顺序不变**）+ 切换工作目录 + 刷新；点文件分流——**`.json`/`.yaml`/`.yml`/`.xml`/`.toml`/`.csv`/`.tsv`/`.jsonl`/`.txt`/`.ini`/`.env`/`.env.*`/`.log`/`.md` 点开 → 内置 viewer/editor 弹层**（modal：默认查看渲染——`.md` 走 markdown 渲染 / 其余走 `<pre>` 朴素预览；切「✏️ 编辑」改文本；**结构化 7 格式**（json/jsonl/yaml/xml/toml/csv/tsv）edit 模式显「格式化」「校验」两按钮——格式化成功替换内容 + ✓ 提示、校验失败显「第 N 行: 错误」，**不阻塞保存** last-write-wins；点「保存」落盘 + 底部 toast「已保存」）；其它扩展名（`.py`/`.js`/`.png` 等编程语言/二进制） / 文件夹仍走 `POST /workspace/open` 系统默认应用打开 / 展开-收起（行为不变）。组件契约 `component-workspace-panel.md §4.4/§4.5` + `common/component-modal-md-editor.md`。
- **chat 区右上悬浮菜单**（纵排 4 图标，三处 chat 页统一）：**长期记忆**（session memory 列表/新建/编辑/归档）→ **定时任务**（cron 列表/新建/开关/删除）→ **skills**（只读弹层，3 tab「会话/团队/全局」展示当前会话可见 skills 卡片：渐变星形 logo + name + desc + 来源徽标；playground 无团队 →「团队」tab 空态）→ **待办 todo**（只读弹层，当前 session 的 agent 双层待办树：主 item 状态徽章 + desc + 步骤进度 N/M，悬停**主 item 行**在其正下方展开来源/输出/备忘详情（步骤行悬停不触发）；badge=未完成主 item 数；**SSE 实时**——agent 写 todo 后 badge 与已开弹层秒级自动刷新（`session_todo_changed` 推送，无轮询），**每次打开弹层即拉最新**；弹层宽 720px 档（窄窗 92vw 兜底）、高 ≤88vh；done 徽章绿色与未开始灰色一眼可辨；agent 自主维护，用户只读）。组件契约 `specs/ui/components/chat-page/component-chat-float-menu.md` + `component-skills-modal.md` + `component-todo-modal.md`。
- 数据隔离：bizType=`playground`，不与 Studio 混。

### 3.2 Studio（团队 squad）
- **路径**：nav-rail「Studio」→ 左 sidebar squad 单行列表 → 「+ 新建」建团队 → 选 squad 落**首页面板**。
- **首页三 tab**（内联切换）：首页（队长 mini 卡 + TokenWidget 图文 + 学生 roster + 第二栏内嵌全景）/ 管理 / 自动工作。
- **seats roster 视图筛选（v0.0.244）**：首页 roster 头有「在岗 / 全部」视图筛选 toggle（segmented 两态，默认「在岗」）——在岗视图只显 deployed mate（benched 隐藏），roster 头计数「成员·N」的 N = 当前视图行数（显示几个就是几个）；切「全部」显全量 mate（含视觉弱化的 benched 行——opacity-75 + `mate · benched` meta），可在该视图下点 benched 行「更多」菜单 deploy 项恢复回在岗（SSE 推送自动刷新）。
- **功能链路**：坐席卡「进入对话」→ 单聊页；队长卡「群聊」按钮（操作行中档）→ 群聊页；左列 TokenWidget 整卡点击 → token 统计；坐席卡菜单 → 编辑成员 / bench / deploy。
- **业务全景（首页第二栏内嵌，v0.0.240 / v0.0.243）**：首页底部追加「项目全景」栏（标题 + tab 条 + 工作面板），内嵌 `<PanoramaRoute>`（无独立路由 / 无返回键头部）。tab 装配 = **task「任务」首 tab**（v0.0.243 起 task 普通 entity + system 标记，落盘进 squad schema，kanban 4 列 todo/waiting/in_progress/done）+ DSL 动态 views 顺延 + **固定「更多」tab 永远在最右**（v0.0.243 恢复，点击渲 PanoramaIdle 引导卡——点「找 leader 搭看板」按钮跳 leader 单聊 + composer 预填「帮我搭建一个看板，展示…」模板文本，用户补完发送，v0.0.248）。task 看板支持拖拽改状态 + 卡片归档按钮 + 「活跃/含归档」开关；leader 也可在 DSL 加自定义 view（kanban/table/bar_chart + filter）。详细路径见 `06-studio.md §4`。
- **Token 统计入口（v0.0.240）**：首页左列 `<TokenWidget>` 整卡点击 → 进入 token-stats 独立路由（头部返回键退出回首页）。功能 = 团队/member 级 LLM token 流量可视化：4 维度切换（粒度 day/hour × 范围 team/member × 类型 total/input/output/cache/cacheRate × 视图 calendar/timeline）+ model 筛选 + 日期选择（仅 hour 粒度）+ 日历热力 + 时间轴堆积图 + hover 明细 + 汇总条 + 团队口径说明。数据来自 `GET /squad/:id/token-stats`（异步事件写入 sqlite 时序表，不阻塞主流程）。详细路径见 `06-studio.md §5`。
- 数据隔离：bizType=`studio`。

### 3.3 Academy（教室培养）

- **路径**：nav-rail「Academy」🎓 → 左 sidebar 教室单行列表 → 「+」新建教室（**默认模型必选**，自动带班主任）→ 选教室落**教室详情页**。
- **教室详情页**（默认 landing，左 head 对话 + 右 content-col）：左 400px 与班主任对话（备环境 / 发起训练 / 看任务状态）；头部含**教室默认模型 picker**（群体级必选具体模型，无「跟随应用默认」继承项）；右头部 3 tab——「学生」（学生卡片网格 + 「+ 添加学生」）/「数据集」/「评估器」。点学生卡 → 学生详情页。
- **学生详情页**（左版本树 + 右四元组）：左 300px 版本树（正式版 0.0/1.0/2.0… + 过程版 v1.1/v1.2/v1.2.3 缩进，formal 副标题显「采纳自 v{过程版号}」）；右版本 hero（**正式版无编辑按钮——编辑走下方四元组卡 item 如 System Prompt；过程版 ver-hero 显「进入观察」按钮 → 训练观察 coach 页**）+ 四元组卡片（System Prompt / Skills / Memory · 查看 / 模型）；顶部操作行「💬 发起会话」「⇪ 派生到团队」「＋ 发起训练」。
- **功能链路**：发起训练 modal（模式卡：简单/多轮，多轮需教室有数据集+评估器；基线/数据集/评估器 picker + 训练目标 textarea + 迭代策略）→ `POST /academy/classroom/:cid/student/:sid/training-task`（产品 UI 入口）。后端走 `createTrainingTaskAndCoach` 统一核心（建 task + fork 初始 candidate + 建专属 coach session[workspaceDir=candidate ws] + 投递任务书 initial user message 触发 coach 自主训练）→ 跳训练观察页。**两入口统一**：产品 UI + head teacher 聊天内 `manage-classroom.start_task` 都走同一后端核心（head 入口的 directive 由 head 提炼用户意图）。
- **head 聊天内学生/任务管理**：head 在左侧对话里通过 `manage-classroom` 工具（head 专属，20 action：原 dataset/grader/skill CRUD + 学生 CRUD 7 [list_students/get_student/create_student/update_student/delete_student/list_versions/get_version] + 任务监督 4 [start_task/list_tasks/get_task/update_task]）完成学生 CRUD、版本五元组读取、发起训练、查训练看板、patch maxTurns/directive——**非 UI 按钮**，是 LLM 工具调用（head 决策链：system prompt 有 `academy_classroom_students` + `academy_classroom_assets` + `academy_task_status` + `academy_head_role` mapper 注入名单/资产/任务看板/行为指引，head 据此自主决策调哪个 action）。产品 UI 的「+ 添加学生」按钮是 HTTP API 入口（`POST /academy/classroom/:cid/student`，后端走 `createStudentWithInitialVersion` 统一核心），与 head 聊天内 `manage-classroom.create_student` 同后端核心（两入口模式）。本版本无新增 nav-rail 入口、无新 UI 板块——「照手册从 nav-rail 点到任意功能」仍然成立（academy 板块入口已在 §3.3 开头）。
- **训练观察页**（最复杂页，中 coach 对话 + 右 520px 训练视图）：topbar 任务名/状态/暂停（v0.0.221 去「停止」按钮——停止由对话或 update_task directive 完成）；中 coach 对话（可注入指导，透传给 coach 作 advisory）；右训练视图 = 4 状态格（任务状态/当前轮次/临时基线/最高分）+ 倒序迭代 timeline（gate tag 三色 ✓/✗/进行 + 每题 case 表 + 反思盒 + subagent working-link「👁 观察 →」仅进行中可点）。task 三态机：pending/running/paused+pausedReason（maxturns/completed/stopped/earlystop）。
- **subagent 只读 transcript**：训练观察右栏 working-link 点入 → 复用 chat-page readOnly 分支看优化/评估 subagent 完整 transcript（无输入框）。跑完入口消失（只看过程不查历史）。
- **采纳入口（v0.0.221 inline）**：采纳 = 把过程版本复制为新正式版（原 base 不动；可重复调，同一 task 产多个 formal 2.0/3.0/4.0…）。**入口位置**：学生详情 → 版本树 → 过程版行尾「采纳」按钮（POST `/academy/training-task/:tid/adopt` body `{versionId}`；`data-action-key="academy.version.adopt"`）；点击不触发 select（stopPropagation）；formal 行不显按钮（formal 已是归档产物）。采纳成功 → 新 formal 自动出现在版本树（formal 副标题显「采纳自 v{过程版号}」）+ 学生指针 `currentFormalVersionId` 同步。**不再有独立训练结果页**（原 propose→accept/reject 流程已废弃；采纳改旁路 inline）。
- **续训态（v0.0.221）**：task 到 maxTurns 硬上限 → status='paused' + pausedReason='maxturns'（终态，不可 resume 越过）。续训路径：用户在训练观察页让 head 调 `manage-classroom.update_task` 调大 maxTurns（如 5→8），再让 coach `manage-task resume` 继续迭代（或 UI 自动轮询发现可 resume）。其他 pausedReason（completed/stopped/earlystop）→ 直接 `manage-task resume` 即可续训。
- **versionLabel 显示**：版本树 + 任务名 + 训练观察 topbar 统一显 3 段 versionLabel `{major}.{taskSeq}.{round}`（如 v1.2.3 = 基于 1.0 / 任务 2 / 第 3 轮）；formal 版显 x.0（如 2.0）；formal 副标题显「采纳自 v{label}」（若有 `adoptedFromProcessVersionId`）。
- **版本会话**：学生详情「发起会话」→ 基于该版本工作区建 academy-student session → **完全复用 playground-rocky 设计**（conv-panel + chat-col + 右 ws-panel + 右上悬浮菜单 memory/cron/skills/todo），不发明新结构。
- **派生到 Studio**：学生详情「派生到团队」或 Studio 新建成员「从教室派生」→ 二级 select（教室 → 学生·版本）→ **继承预览面板**（列 AGENTS.md + skills + memory 清单 + 标 squad 团队盘同名项，同名默认保留原 squad 可逐项打开覆盖）→ 复制为新成员初始工作区（AGENTS.md → `.rocky/agents/{名字}-{memberId}.md` 个人差异；skills / memory → 团队盘全队共享）。
- 数据隔离：bizType=`academy`。

### 3.4 SKILLS / 渠道 / 连接器 / 应用设置（底部 4 入口）
- **SKILLS**：两 tab「我的 (manage) / 市场 (market)」。
  - **我的**：tab 栏最右「+」按钮 [v0.0.198] → 展开安装弹层（拖拽/选择文件·文件夹·zip 调 `POST /skill/install`）→ 安装成功自动收起；列表上方**来源筛选条**（全部/内置/市场/Rocky）[v0.0.198] 切换过滤；单卡 = 渐变星形 logo + 名称 + 来源徽标 + 状态 badge + 描述 + 启用开关 + 自进化开关 + 预览 + 删除。
  - **市场**：搜索 → 点卡看详情 → 一键安装（capabilities 门控，详见 §06-skill §6.2.1b）。
  - **编辑 skill 内容**：预览按钮 → modal 看文件树（只读）；治理（scope/evolvable）走 toggle 开关，非文本编辑。
  - **与 chat 悬浮菜单 skills 入口的关系**：本页 = **管理**（安装/启停/删除/治理，全局视角 app+workspace 层）；chat 悬浮菜单 skills 弹层（§3.1）= **观测**（只读无开关，当前会话实际生效集合，按 会话/团队/全局 3 tab 分组）。在「我的」装完新 skill 后，回会话重开 skills 弹层即可在「全局」tab 看到（弹层每次打开刷新一次）。
- **渠道**：外部 IM 接入配置（凭证 / 启用）。渠道列表（5s 轮询 connection 实况）→「+ 新建渠道」→ 类型下拉（**options 由后端 scope 激活集合派生**——mount 一次性 `GET /config/channels/impl-types`，非前端硬编码；channel impl 未在 default.yaml 激活 → 空态禁用下拉+提交并提示）→ 填凭证（appId/appSecret mask）→ 建完即连。详见 `06-channel.md`。
- **连接器**：外部系统/MCP/插件接入（凭证 / 端点 / 启用）。
- **应用设置**：三 tab — app config（外观/语言/模型默认）/ dev config（开发态）/ 插件（builtin/ext 启用与配置）。**模型 provider 在此配**。

---

## 4. 通用交互约定（跨板块）

- **布局稳定性（INV）**：按钮出现/消失用 `opacity` 不用 `display:none`，绝不导致相邻元素位移。
- **弹层（modal/drawer）**：新建/编辑/详情多用居中 modal 或右侧 drawer，遮罩点击关闭。
- **i18n**：全中文界面（可切英文），缺 key 会渲染成「【资源 X 不存在】」（新增功能必须补全中英两份 locale）。
- **三环境隔离**：test（3700/8787）/ dev（3710/8788）/ prod（3720/8789），数据目录 `~/.rocky_agent_{env}` 互不污染。真实跑用 test 环境。

---

## 5. 维护规则（MANDATORY — 每个 version doc-sync 更新）

本手册是**活文档**，随版本演进：

1. **新增板块**（如未来加新 nav 入口）→ §2 表加行 + §3 加操作路径小节。
2. **板块内新增功能** → 该板块小节加操作链路（参考 §3 模板：入口→建资源→发起→看过程→采纳）。
3. **入口/路径变更**（nav 改造、IA 收敛）→ 同步改 §2 表 + 对应板块路径。
4. **维护时机**：每个版本 doc-modifier 阶段（功能完成后、合并前），除同步 `specs/` 各 KB 外，**检查并更新本手册**——让「照手册能从入口点到任意功能」始终成立。
5. **保持简洁**：本手册只写「操作路径 + 功能链路 + 页面布局」骨架，不堆视觉细节（那些归组件 spec）；每个板块小节 ≤ 1 屏。

> **本手册的验收口径**：一个从未见过本 app 的人（或一个 playwright agent），照本手册能从 nav-rail 一路点到任意功能、说清每步在哪个页面、链路怎么走。端到端真实跑 = 把本手册的操作路径用 playwright-cli 走一遍、遇使用问题即修。
