# v0.0.47 PRD Change Log — Playground 会话名字可编辑 / 展开逻辑 / 设置入口三合一

> version: 1.0 · 2026-07-01
> 一句话定位：playground 三件 UI 优化——(1) session 名字**可编辑 + AI 自动起名**（首 query 并行 LLM 起名，不覆盖人起的名）；(2) conv-panel 名字**左对齐 + 行点击自动展开 running+分割线**（去 twisty）；(3) **设置入口三合一**——app config + dev config + 插件合为「应用设置」单入口（内部 app tabs + 「展开系统配置」分割线 + dev tabs + 插件 tab），SKILLS + 连接器 移到 nav 底部独立入口。
> 概念权威源：`specs/ui/components/chat-page/_overview.md`（conv-panel / conv-item）+ `component-subagent-tree.md`（三段展开）+ `framework/nav-rail.md`（nav）+ `app-dev-config-page/` + `plugin-config-page/`；`specs/api/overall/04-agent-session.md`（PUT /session/:id + session_meta 广播）；`specs/tech/agent/session/[P0]session_biztype.md`（playground scope）；`specs/tech/agent/llm_caller/`（LlmClient 机制层）。
> 设计稿：无（视觉保真度门禁跳过；E2E 仅做单图功能检查）。

---

## 1. 背景与目标

### 1.1 背景

playground 当前存在三处用户感知痛点（`reqs/v0.0.47.ui_opt/req.md`）：

1. **会话名字不可编辑**：`conv-item` 只读渲染 `s.title`（默认 `'新会话'`），用户改不了；新建会话后名字始终是默认值，列表里全是「新会话」无法区分。
2. **会话名字未左对齐 + 展开逻辑繁琐**：conv-item 左侧为统一预留 `conv-item-{id}-twisty`（占位 span）导致名字不贴左；展开 subagent 树须精准点 twisty 图标，点行（onSelect）不展开。
3. **设置入口分散**：nav 齿轮子菜单收纳 5 项（用户/插件/系统/Skill/连接器），三个配置页（app/dev/plugin）独立，用户在三个入口间来回切；SKILLS+连接器 在 v0.0.33.1 被折叠进齿轮后失去独立入口。

### 1.2 目标

1. **名字可编辑 + AI 起名**：激活 session 后点名字进入编辑；新建会话发首 query 时**并行**触发 LLM 起名，AI 名回来时仍为默认名才应用，否则作废；复用当前 session 的 LLM 配置。
2. **左对齐 + 行展开**：去掉左侧 twisty 占位，名字左对齐；点 conv-item 行自动展开 running subagents + 「非运行中」分割线，再点分割线才展开已终止段。
3. **三入口合一 + SKILLS/连接器 独立**：app+dev+插件 合为「应用设置」单入口；SKILLS、连接器 恢复为 nav 底部独立入口（自上而下 SKILLS、连接器、应用设置）。

---

## 2. 功能需求

### 2.1 session 名字可编辑 + AI 起名 [v0.0.47]

**描述**：playground session 的 title 从只读改为**可编辑**，且新建会话首次发出 query 时**后台并行**触发 LLM 起名；AI 起名结果回来时若 title 仍是默认名则应用、若已被人工改过则作废。

**优先级**：P0

**用户故事**：作为 playground 用户，我希望会话列表里的名字一眼区分得了（自己起或 AI 起），不用先看到一排「新会话」再点进去才知道是哪个。

**期望行为（用户可见）**：

- **激活后可编辑**：用户在 conv-panel 选中一个 session（conv-item active）→ **再次点击 title 文本**（非整个行）→ title 变为 inline 可编辑输入框（聚焦 + 选中现有文本），原有 title 预填。Enter / 失焦 **保存**（PUT /session/:id `{title}`），Esc **取消**。未激活的 session 不可编辑（避免误触）。
- **保存即生效**：保存成功后 conv-item 立即显示新 title；列表其他 tab/客户端通过 `session_meta_update` 广播同步刷新（沿用 v0.0.27 列表订阅契约，**对齐权威源 `04-agent-session.md §4.2`**）。
- **AI 起名触发时机**：session 创建时 title = 默认名（`'新会话'`）；用户发出**首条 query**（POST /session/:id/messages 首次成功）→ 后台**并行**触发一次 LLM 起名调用（不阻塞主 agent run，主 run 流式回答照常）。**只触发一次**（后续 query 不再起名）。
- **AI 起名结果应用条件**：LLM 返回名字时，**当前 title 仍是默认名**（即用户没在此期间人工改过）→ 应用 AI 名；**当前 title 已不是默认名**（用户已人工改名 / 已应用过 AI 名）→ 作废 AI 名，不覆盖。
- **AI 起名 LLM 配置**：复用当前 session 的 provider/model 配置（与主对话同源，`agentManager.resolveConfigBySid(sid)`），非流式单次调用（对齐 `LlmClient.call` 机制层契约）。
- **AI 起名失败静默**：LLM 调用失败 / 超时 / 返回空 → 静默保留默认名，不打扰用户、不弹错。
- **scope 限定**：仅 `bizType === 'playground'` 的顶层 session 起名（对齐 `[P0]session_biztype.md`）。**studio 域（squad / leader / mate / studio subagent）不起名**（有 member 身份名字，PRD OUT）。playground 内的 subagent session 也不起名（type=subagent，由 parent 驱动）。
- **布局稳定性（MANDATORY）**：编辑态切回只读态 / 只读切编辑态，按钮/输入框出现消失**绝不导致相邻元素位移**——编辑输入框与只读 title 占据同一排版槽位（width 一致），禁 `display:none` 入常规流。

**关键机制（待 architect 落 tech spec）**：

- **「默认名 vs 已命名」区分机制**：title 字符串比对（`title === '新会话'`）不可靠（用户可能改名回「新会话」后又改回）。需引入**显式区分字段**（候选：`titleSource: 'default' | 'user' | 'ai'` 或 `titled: boolean`）。**tech spec 定义**——本 PRD 只描述用户可见行为（AI 名仅在「用户未改过」时应用），不发明字段名。
- **AI 起名 service**：后台非流式 LLM 调用 + 写 title + 触发 `session_meta_update` 广播（应用条件不满足时只写 `titleSource` 不写 title，或干脆 noop，由 architect 决定）。复用 `agentManager.resolveConfigBySid(sid)` 拿 config + `LlmClient.call` 单次调用。
- **PUT /session/:id 广播补强**：现状 `store.updateSession({title})` 不发广播（前端列表不刷新）——本版本须让 title 更新经 `SessionMetaBroadcaster.broadcast(sid)` emit `session_meta_update`（沿用 v0.0.27 机制，**tech spec 处理**）。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-2.1.1 | 选中 session（conv-item active）→ 点 title 文本 → 改名 → Enter | title 变可编辑输入框；改名后 conv-item 显示新 title；列表其他位置同步刷新 |
| UC-2.1.2 | 选中 session → 点 title → 改名 → Esc | 编辑取消，title 恢复原值；conv-item 仍是 active |
| UC-2.1.3 | 未激活 session → 点 title | 不进入编辑（保持只读） |
| UC-2.1.4 | 新建 session（默认名）→ 发首 query → 等待 | 主对话流式回答照常；后台 AI 起名；名字仍是默认名 → AI 名应用 → conv-item 显示 AI 起的名 |
| UC-2.1.5 | 新建 session → 发首 query 期间（AI 名未返回）人工改名 → AI 名返回 | 人工名保留；AI 名作废不覆盖 |
| UC-2.1.6 | 已应用 AI 名的 session → 再发 query | 不再触发 AI 起名（仅首条触发） |
| UC-2.1.7 | AI 起名 LLM 调用失败 | 静默保留默认名；不打扰用户 |

---

### 2.2 session 名字位置 + 展开逻辑 [v0.0.47]

**描述**：conv-item 名字**左对齐**（去左侧 twisty 占位）；点 session **行**自动展开 running subagents + 「非运行中」分割线，再点分割线才展开已终止段。

**优先级**：P0

**用户故事**：作为 playground 用户，我希望会话名字一眼对齐看清，点会话行就能展开它的 subagents 看看在跑啥，不用精准点小三角。

**期望行为（用户可见）**：

- **去左侧 twisty 占位**：conv-item 移除左侧为对齐预留的 `conv-item-{id}-twisty`（chevronRight icon / placeholder span）——**整个左侧占位元素删除**，title 文本贴 conv-item 左侧（左 padding 后）。对齐权威源 `_overview.md §4.2` 视觉基线（修改其对齐规则）。
- **行点击自动展开**：点击 conv-item 行（onSelect）→ **同时触发两件事**：① 切到该 session（既有行为）+ ② **自动展开 subagent 树到「running + 分割线」段**（即 twisty 视觉展开 + subagent-tree 显示 running 段 + 「非运行中 (N)」分割线；terminated 段保持折叠）。
- **分割线点击才展开 terminated**：running 段始终展开；「非运行中 (N)」分割线（沿用 `subagent-tree-terminated-toggle` testid）默认折叠 terminated 段，**再点分割线**才展开 terminated 列表灰显。**这是二级展开动作，不被行点击触发**。
- **twisty 视觉移除**：conv-item 左侧不再有 chevronRight 图标（用户不再需要点 twisty）。「展开/折叠」状态由「行点击」与「分割线点击」表达，不再有显式 twisty toggle 按钮。
- **无 subagent 的 session**：行点击只切 session（无展开动作；subagent-tree 不渲染）。视觉与有 subagent 的 session 一致（左对齐 title 一致）。
- **布局稳定性（MANDATORY）**：subagent-tree 展开/折叠 / running 列表条数变化 / terminated 列表出现消失，**绝不导致 conv-panel 内其他 conv-item 位移**——通过 `visibility:hidden` 预留高度槽位或绝对定位吸收布局变化，禁 `display:none` 入常规流导致列表跳动。

**关键机制（待 architect 落 ui spec）**：

- `_overview.md §4.2 component-conversation-item` 修订：移除 `conv-item-{id}-twisty` testid + 左侧 twisty 占位；onSelect 触发自动展开 running + 分割线。
- `component-subagent-tree.md` 修订：渲染条件从「parent conv-item twisty 展开」改为「parent conv-item 行点击触发」；三段展开规则不变（running 始终 / 分割线 toggle / terminated 灰显）。
- `conv-item-{id}-twisty` testid **移除**（ET 锚点更新）。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-2.2.1 | 打开 conv-panel → 看任一 session 行 | title 文本左对齐（左侧无 twisty 占位/三角图标） |
| UC-2.2.2 | 点 parent session 行（有 running subagents） | 切到该 session + subagent-tree 自动展开到 running 段 + 「非运行中 (N)」分割线可见；terminated 段折叠 |
| UC-2.2.3 | 承上 → 点「非运行中 (N)」分割线 | terminated 段展开（灰显列表） |
| UC-2.2.4 | 承上 → 再点分割线 | terminated 段收起 |
| UC-2.2.5 | 点无 subagent 的 session 行 | 切到该 session（无 subagent-tree 渲染、无展开动作） |
| UC-2.2.6 | 点 parent session 行后 → 点另一个 session 行 → 再点回原 parent | 每次行点击都自动展开 running + 分割线（terminated 段保持上次状态 or 重置为折叠，由 architect 定；倾向「每次重置为折叠」保持一致行为） |

---

### 2.3 设置入口三合一（应用设置） [v0.0.47]

**描述**：nav 齿轮子菜单 5 项中 **app config + dev config + 插件 合并为单一「应用设置」入口**；SKILLS + 连接器 恢复为 nav 底部**独立**入口。nav 底部自上而下：**SKILLS、连接器、应用设置**。

**优先级**：P0

**用户故事**：作为用户，我希望设置入口收敛——「应用设置」一个地方管所有配置（app + 系统 + 插件），SKILLS 和连接器 是常用工具放外面独立进。

**期望行为（用户可见）**：

- **nav 底部三入口（自上而下）**：
  1. **SKILLS**（testid `nav-skill`，沿用 v0.0.21 / v0.0.33.1 子菜单 testid）：独立入口，view id `'skill'` 路由到 `page-skill`。tooltip「SKILLS」。
  2. **连接器**（testid `nav-connector`，沿用 v0.0.23 / v0.0.33.1 子菜单 testid）：独立入口，view id `'connector'` 路由到 `page-connector`。tooltip「连接器」。
  3. **应用设置**（testid `nav-settings-app`，沿用 v0.0.33.1 子菜单 testid）：合并入口，view id `'settings-app'` 路由到新「应用设置」页。tooltip「应用设置」。
- **移除齿轮子菜单**：原 v0.0.33.1 齿轮按钮（`nav-settings-group` / `nav-settings-group-menu` / `nav-settings-mask`）+ 5 项收纳**整体删除**。SKILLS / 连接器 / 应用设置 直接以独立图标出现在 nav 底部（无展开子菜单）。
- **「应用设置」页结构**（合并页，新 view id `'settings-app'`）：
  - **顶部 tab 栏**：默认展示 **app config 的 tabs**（如 `appearance` / `providers`，沿用 `page-app-config` 现有 group 集合）。
  - **分割线「展开系统配置」**：tab 栏中部插入一条**可点击的分割线**（testid `app-settings-expand-dev`），文案「展开系统配置」。点击 → 展开下方 **dev config tabs + 插件 tab**。
  - **dev config tabs**（折叠态隐藏）：展开后显示 dev config 的 group tabs（如 `llm_request` / `observability` / `logs`，沿用 `page-dev-config`）。
  - **插件 tab**（折叠态隐藏）：dev config tabs 之后追加一个 **`插件` tab**（testid 沿用 `tab-plugin`），点击切到插件配置 UI（沿用 `page-plugin-config` 的插件/扩展点 两 tab 结构，作为「应用设置」页内的一级 tab）。
  - **折叠态**：「展开系统配置」分割线折叠 → 页面只显示 app config tabs（用户视角 = 简单配置页）。展开态 → 显示 app tabs + dev tabs + 插件 tab。
  - **默认 tab**：打开「应用设置」默认选中 app config 首个 tab（如 `appearance`）。
- **各 tab 内容渲染**：app config tabs / dev config tabs 的内容**沿用现有 `section-config-layout` 三栏（功能导航在 app-shell，本页是 group 列表 + 配置区）+ `component-key-card`**，零修改。插件 tab 内容沿用 `page-plugin-config` 的两 tab（插件 / 扩展点）结构。
- **路由**：`app-shell` routing 表更新——`'settings-app'` 路由到新的「应用设置」合并页（替代原 `page-app-config`）；`'settings-dev'` / `'settings-plugin'` view id **废弃**（合并入 `'settings-app'`）。`'skill'` / `'connector'` view id 沿用。
- **布局稳定性（MANDATORY）**：「展开系统配置」分割线展开/折叠导致 dev tabs + 插件 tab 出现/消失，**绝不导致已选中 tab 内容位移**——tab 栏预留 dev tabs + 插件 tab 的空间（折叠态 `visibility:hidden` 或高度坍缩但顶部锚点稳定），禁 `display:none` 入常规流导致 app tabs 跳动。

**关键机制（待 architect 落 ui spec）**：

- `nav-rail.md` 大改：移除「底部设置组折叠」+ 齿轮按钮 + 子菜单；改为「底部三项独立 nav」SKILLS / 连接器 / 应用设置。testid `nav-settings-group` / `nav-settings-group-menu` / `nav-settings-mask` / `nav-settings-dev` / `nav-settings-plugin` 移除（dev/plugin 合并到 settings-app 页内）。
- 新增「应用设置合并页」spec（新文件 `page-app-settings-merged.md` 或扩展 `page-app-config.md`）：定义顶部 tab 栏 + 「展开系统配置」分割线 + dev tabs + 插件 tab 结构。coder 编码前置补 spec。
- `page-dev-config.md` / `page-plugin-config.md` 作为独立页**废弃**，其内容作为 tab 内嵌进合并页（spec 文件保留作内容描述，路由层废弃独立 view id）。
- `view-store.tsx` / `app-shell.tsx` ViewId 调整：删 `'settings-dev'` / `'settings-plugin'`，`'settings-app'` 路由到合并页。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-2.3.1 | 打开应用 → 看 nav 底部 | 自上而下三项：SKILLS / 连接器 / 应用设置（无齿轮子菜单） |
| UC-2.3.2 | 点 nav 底部「SKILLS」 | 切到 skill 页（view='skill'） |
| UC-2.3.3 | 点 nav 底部「连接器」 | 切到 connector 页（view='connector'） |
| UC-2.3.4 | 点 nav 底部「应用设置」 → 默认看到 app config tabs（如 appearance / providers） | 默认选中 appearance tab，配置区域渲染 |
| UC-2.3.5 | 应用设置页 → 点「展开系统配置」分割线 | 分割线下方显示 dev config tabs + 插件 tab；布局无位移（tab 栏锚点稳定） |
| UC-2.3.6 | 承上 → 点 dev config 的 `llm_request` tab | 配置区域切换到 llm_request 的 key-card 列表（沿用 page-dev-config 行为） |
| UC-2.3.7 | 承上 → 点插件 tab | 配置区域切换到插件配置（沿用 page-plugin-config 的插件/扩展点 两 tab） |
| UC-2.3.8 | 应用设置页（展开态）→ 再点「展开系统配置」分割线 | dev tabs + 插件 tab 收起；只显示 app config tabs |
| UC-2.3.9 | 应用设置页改某 app key → 保存 → 重启 → 再打开应用设置 | 改动持久化（沿用 §3.9.2 行为） |

---

## 3. 关键用户路径（MANDATORY — 测试最低覆盖要求）

每条路径 = 至少一个 AT/ET case。

| 路径 | 链路 | 涉及 | 最低 case |
|------|------|------|----------|
| **路径 A：激活 → 编辑 → 保存 → 列表实时刷新** | 选中 session（conv-item active）→ 点 title → 改名 → Enter 保存（PUT /session/:id `{title}`）→ 后端 updateSession + emit `session_meta_update` → 列表 reducer 整条替换 → conv-item 显示新 title | conv-item 编辑态 · `PUT /session/:id` · `session_meta_update` 广播 · 列表订阅 `(session_meta, _all)` | AT（PUT /session/:id title 字段 + session_meta 广播）+ ET（UC-2.1.1） |
| **路径 B：新建 → 首 query → 并行 AI 起名 → 名字仍默认 → 应用** | 新建 session（title='新会话'）→ 发首 query（POST /session/:id/messages）→ **后台并行**触发 LLM 起名（复用 session provider/model + LlmClient.call 非流式）→ 主 agent run 流式回答照常 → AI 名返回时 title 仍是默认名 → 应用 AI 名 → session_meta 广播 → conv-item 显示 AI 名 | `POST /session/:id/messages`（首条触发）· AI 起名 service · `LlmClient.call` · `session_meta_update` 广播 · 「默认名 vs 已命名」区分机制（tech spec 定义） | AT（AI 起名 service 触发 + 应用条件 + session_meta 广播）+ ET（UC-2.1.4） |
| **路径 C：新建 → 首 query 期间人工改名 → AI 名返回 → 作废** | 新建 session → 发首 query（AI 起名并行触发）→ **AI 名未返回期间** 人工改名（PUT /session/:id）→ AI 名返回 → 当前 title 已不是默认名 → 作废不覆盖 | AI 起名应用条件 · 人工改名 vs AI 改名竞态 · `session_meta_update` | AT（AI 起名作废路径）+ ET（UC-2.1.5） |
| **路径 D：行点击自动展开 running + 分割线** | 点 parent session 行（有 subagent）→ onSelect 切 session + 自动展开 subagent-tree 到 running 段 + 「非运行中 (N)」分割线可见（terminated 折叠）→ 点分割线 → terminated 段展开灰显 | conv-item 行点击 · subagent-tree 三段展开规则 · `subagent-tree-terminated-toggle` | ET（UC-2.2.2 + UC-2.2.3） |
| **路径 E：应用设置 → app tabs → 展开系统配置 → dev tabs + 插件 tab** | nav 底部点应用设置 → 默认看到 app config tabs → 点「展开系统配置」分割线 → dev config tabs + 插件 tab 显示 → 点 dev tab 切到 dev 配置 → 点插件 tab 切到插件配置 | nav 底部独立入口 · 应用设置合并页结构 · 分割线 toggle · tab 切换 | ET（UC-2.3.4 + UC-2.3.5 + UC-2.3.6 + UC-2.3.7） |
| **路径 F：nav 底部独立点 SKILLS / 连接器 / 应用设置** | nav 底部自上而下依次点 SKILLS → 连接器 → 应用设置 | 每次点击切到对应 view（skill / connector / settings-app） | ET（UC-2.3.1 + UC-2.3.2 + UC-2.3.3） |

---

## 4. 范围 / 非目标（IN / OUT）

### IN（本版本交付）

- playground session title 可编辑 + AI 自动起名（仅 bizType='playground' 顶层 session）。
- conv-item title 左对齐 + 行点击展开 subagent-tree。
- nav 入口重组：齿轮子菜单删除；SKILLS / 连接器 / 应用设置 三独立底部入口。
- 应用设置合并页：app config tabs + 「展开系统配置」分割线 + dev config tabs + 插件 tab。
- title 更新触发 session_meta 广播（前端列表实时刷新）。

### OUT（本版本不做）

- **studio 域 session 起名**：squad / leader / mate / studio subagent session 不起名（有 member identity / 模板名，scope OUT）。
- **playground subagent session 起名**：type=subagent 的 session 不起名（由 parent 派生逻辑驱动）。
- **AI 起名 UI 可观测性**：不在前端显示「AI 正在起名…」之类的进度提示（静默后台；用户感知只是 title 突然从「新会话」变成有意义的名字）。
- **AI 起名 LLM 模型/温度等参数调优 UI**：复用当前 session 配置即可，不暴露独立配置项。
- **设计稿视觉还原门禁**：本版本无设计稿，视觉保真度门禁跳过（E2E 仅做单图功能检查）。
- **「展开系统配置」分割线的复杂动画/视觉定制**：用既有 divider 视觉风格（沿用 `component-subagent-tree` 分割线 + chev 图标风格），不引入新设计语言。
- **配置数据/字段的迁移**：app config / dev config / 插件 配置数据结构零修改（仅入口合并）。

---

## 5. 对齐说明（PRD ↔ 已有 ui/tech spec）

| PRD 引用概念 | 权威 spec 文件 | 状态 |
|---|---|---|
| conv-item（会话列表项）+ conv-panel | `specs/ui/components/chat-page/_overview.md §4.1 §4.2` | 已有（本版修订：§4.2 去 twisty + 行点击展开） |
| subagent-tree（三段展开） | `specs/ui/components/chat-page/component-subagent-tree.md` | 已有（本版修订：渲染条件从 twisty 改为行点击触发） |
| nav-rail（导航栏） | `specs/ui/components/framework/nav-rail.md` | 已有（本版大改：删齿轮子菜单 + 底部三独立入口） |
| app config 页 / dev config 页 / 插件配置页 | `specs/ui/components/app-dev-config-page/` + `plugin-config-page/` | 已有（本版作为 tab 内嵌进合并页；独立页路由废弃） |
| Session.title + PUT /session/:id + session_meta 广播 | `specs/api/overall/04-agent-session.md §2.1 §2.5 §4.2` | 已有（本版补强：PUT 触发广播 + AI 起名 service 新增） |
| bizType = playground \| studio（起名 scope） | `specs/tech/agent/session/[P0]session_biztype.md` | 已有（直接引用，本版只限定 playground scope） |
| LlmClient 机制层（AI 起名复用） | `specs/tech/agent/llm_caller/` + `providers_and_models/[P0]llm_client_interface.md` | 已有（直接复用，本版不新增概念） |
| agentManager.resolveConfigBySid(sid)（拿 session LLM config） | `specs/tech/agent/agent_interface_and_loop/[P0]agent_manager.md` | 已有（直接调用） |

### 5.1 新增概念（需 architect 先落 ui/tech spec，PRD 不发明）

| 新概念 | 落地位置 | 说明 |
|---|---|---|
| **「默认名 vs 已命名」区分机制** | `specs/tech/agent/session/`（新增 spec 文件 or 扩 `[P0]session_store.md`） | 显式字段区分「title 是默认占位还是已被命名」（候选 `titleSource: 'default'\|'user'\|'ai'` 或 `titled: boolean`）；AI 起名应用条件 + PUT 不被默认名覆盖均依赖此机制。**architect 决定字段名 + 落库语义**。 |
| **AI 起名 service** | `specs/tech/agent/` 新增（候选位置 `agent/auto_naming/` 或扩 `session/`） | 后台非流式 LLM 调用 + 应用条件判定 + 触发 session_meta 广播。复用 `resolveConfigBySid` + `LlmClient.call`。**architect 定义模块边界 + 错误处理 + 触发时机 hook 点（首 query POST /session/:id/messages handler）**。 |
| **PUT /session/:id 触发 session_meta_update 广播** | `specs/tech/agent/session/[P0]session_event.md §3a` + `session-meta-broadcast-decision.md` | 现状 store.updateSession 不发广播；本版要求 title 更新经 `SessionMetaBroadcaster.broadcast(sid)` emit。**architect 在 tech spec 补广播触发点**。 |
| **应用设置合并页 layout** | `specs/ui/components/app-dev-config-page/` 新增 spec（如 `page-app-settings-merged.md`） | 顶部 tab 栏 + 「展开系统配置」分割线 + dev tabs + 插件 tab 结构。**coder 编码前置补 spec**（按 `_conventions.md` 规范）。 |
| **nav-rail 底部三独立入口结构** | `specs/ui/components/framework/nav-rail.md` 改版 | 删齿轮子菜单 + 三独立 nav item。**architect 落 ui spec 框架，coder 实现细化**。 |

---

## 6. 版本

```yaml
version: 1.0
intro_version: v0.0.47
note: |
  playground 三件 UI 优化：
  (1) session 名字可编辑 + AI 起名（首 query 并行 LLM 起名，不覆盖人起的名；复用当前 LLM 配置；scope=playground 顶层 session）。
  (2) 名字位置 + 展开逻辑（去 twisty 占位使名字左对齐；行点击自动展开 running subagents + 分割线，点分割线才展开已终止段）。
  (3) 设置入口三合一（app+dev+插件 合为「应用设置」单入口，内部 app tabs + 「展开系统配置」分割线 + dev tabs + 插件 tab；SKILLS+连接器 移到 nav 底部独立入口）。
  无设计稿 → 视觉保真度门禁跳过。
  对齐概念：conv-item / subagent-tree / nav-rail / app-dev-config-page / plugin-config-page（ui spec 已有，本版修订）；
  Session.title + PUT /session/:id + session_meta 广播（api spec 已有，补强）；session_biztype（限定 playground scope）；LlmClient（AI 起名复用）。
  新增概念（architect 落 tech/ui spec）：默认名 vs 已命名区分机制 / AI 起名 service / 应用设置合并页 layout / nav 底部三独立入口。
```

---

## 7. Follow-up（Bug A + Bug B，2026-07-02）

> v0.0.47 主版本验收后的两件 follow-up（code-review PASSED + typecheck 0 + 54 UT 绿 + ET 5/5 pass）。无 API/后端架构变更（纯前端）。

### 7.1 Bug A — conv-item 切走自动收起 subagent-tree

**问题**：v0.0.47 主版本 conv-item 行点击幂等置 `expanded=true`（无 collapse 入口），但 `expanded` 是每行局部 state——点别的会话后，原会话的 subagent-tree **保持展开**残留，且 BUG-001 refresh 轮询持续跑（浪费）。

**修复**（`component-conversation-item.tsx`）：conv-item 加 `useEffect([active])`——active 从 true→false 时 `setExpanded(false)` + `stopPolling()`。即点别的会话 → 当前会话的 subagent-tree 自动收起、轮询停止。保留 `expandOnce` 的「点击展开」语义（点 session 行仍展开自己的 running subagents）。

**spec 同步**：`specs/ui/components/chat-page/_overview.md §4.2`（加 active→false 自动收起 + 停轮询）+ `§5 交互8`（修订「切别的 session」语义：从「显那棵残留」改为「自动收起」）。testid 无变更。

### 7.2 Bug B — 应用设置页重构为统一 sidebar

**视觉契约**：`reqs/v0.0.47.ui_opt/app-settings-layout-mockup.html`（**新引入**，布局权威源）。

**问题**：v0.0.47 主版本 task3 把应用设置做成「顶部横排 tab 栏 + flex-1 spacer + 分割线 toggle」结构，与 mockup 不符（mockup 是统一左侧 sidebar，无顶部 tab 栏）。

**重构**（`page-app-settings-merged.tsx` 重写为薄壳 ~110 行 + `section-config-layout.tsx` 扩展 + 新 hook/defs）：
- ONE `SectionConfigLayout`，**删顶部横排 tab 栏**。左 sidebar = 统一 group 列表：`appearance`/`providers`（常驻）→「展开/收起系统配置」分割线 toggle（默认收起，testid `app-settings-system-toggle`）→ 展开后 `llm_request`/`observability`/`logs` + 插件（特殊，最后）。
- 右栏 = 当前选中 group 的配置区；**插件 group 选中 → 右栏渲染完整 `<PagePluginConfig/>`**（保留其内部 插件/扩展点 子 tab + scope 切换，不拆散）。
- `section-config-layout`：`GroupInfo` 加 `entryKind?: 'group'|'system-toggle'`（默认 group）+ system-toggle 项的 `systemExpanded?`/`onSystemToggle?`；导出 sentinel `SYSTEM_TOGGLE_GROUP_ID`；`current` 回退跳过 sentinel。补齐 `saveMode`/`renderGroupArea`/`dirtyOf`/`savingOf`/`savedOf` Props。向后兼容。
- 新 hook `use-app-settings-config.ts`（app+dev KV 状态合并：appearance theme / llm_request / logs）+ `app-settings-config-defs.ts`（KV_GROUPS 静态定义 + 纯函数）——从已删的 page-app-config/page-dev-config 抽出合并。
- 死代码删除：`page-app-config.tsx` / `page-dev-config.tsx` / `__tests__/page-dev-config.test.tsx`（独立页路由早已废弃）。`page-plugin-config.tsx` 保留（被合并页 import 内嵌）。

**testid 契约变更**：
- **删**：`app-settings-tab-bar` / `app-settings-tab-{groupId}` / `app-settings-expand-dev` / 合并页顶层 `tab-plugin`（task3 引入、Bug B 移除）。
- **加**：`app-settings-system-toggle`（sidebar 内分割线 toggle，`data-expanded`）。
- **沿用**：`page-app-settings`（页根）/ `group-item-{groupId}`（sidebar 列表项，section-config-layout 既有）/ PagePluginConfig 内部 `tab-plugin`/`tab-extpoint` 等（不变）。

**spec 同步**：`page-app-settings-merged.md`（按 Bug B 重写）+ `section-config-layout.md`（GroupInfo entryKind 扩展 + system-toggle 渲染 + 补齐 Props）+ `page-app-config.md`/`page-dev-config.md`（标记已并入合并页）+ `prd/overall/04-config-center-ui.md §3.9.10`（结构改为统一 sidebar）。

### 7.3 验证结果

ET 5/5 pass（`settings/app_settings_merged_tc1` 覆盖统一 sidebar + system-toggle 展开/收起 + 插件 group 内嵌整页）。54 UT 绿（含 Bug A `component-conversation-item.test.tsx` active→false 收起单测）。无 API 变更。
