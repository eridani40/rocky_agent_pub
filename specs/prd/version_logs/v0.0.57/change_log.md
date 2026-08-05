# v0.0.57 PRD Change Log — squad 管理 UI 整理（4 处改动 · 纯前端重组）

> version: 1.0 · 2026-07-03
> 一句话定位：把 squad 管理 UI 整理成「侧栏看板独立页 + 面板 3 tab（管理 / 成员 / 自动工作）+ 成员每行 1 人 + 自主性归位到自动工作」——**纯前端组件重组**，零后端 API、零 schema 变化、零数据迁移。
> 概念权威源：`specs/ui/overall/06-studio.md` + `specs/ui/components/studio-page/`（`_overview` / `squad-panel` / `squad-board` / `studio-sidebar` / `member-card` / `squad-autonomy-toggle` / `budget-meter` / `auto-work-history`）。
> 设计稿（视觉契约）：`reqs/[working] v0.0.57.squad_ui_1/design/ui-demo.html`（4 scene demo，**用户已确认方向**，是视觉/交互权威源）。

---

## 1. 版本目标

整理 squad 管理 UI 的 4 处混乱：① 删「介绍」tab，description 并入「管理」；②「团队看板」从 squad-panel 的 goals tab 提升为侧栏树首节点（独立页）；③ 自主性开关 / budget / 调度历史 从「管理」tab 归位到「自动工作」tab；④ 成员 tab 横排网格 → 每行 1 人。再加 ⑤ panel 头部副标题去掉「团队看板」字样（与 ② 一致）。**纯前端组件重组**，零后端改动。

## 2. 范围

### 2.1 IN-SCOPE

| # | 项 | 摘要 |
|---|---|---|
| **S1** | 团队看板提升为侧栏独立节点 | 每个 squad 展开树新增首节点「团队看板」（排在「群聊」上），点击 → 主区切到 board 路由态（沿用 `component-squad-board` 三视图 Goals/Requirements/Tasks，只读） |
| **S2** | squad 面板 5 tab → 3 tab | 删「介绍」tab（description + charter 摘要并入「管理」）；删「目标」tab（看板搬家，S1）；保留并重排为：**管理 / 成员 / 自动工作** |
| **S3** | 管理 tab 瘦身 + 自动工作 tab 扩容 | 管理 tab 移除 `squad-autonomy-toggle` + `budget-meter`（挪到自动工作 tab）；自动工作 tab = 自主性开关 + 预算仪表 + 调度历史（`section-auto-work-history`）组合页 |
| **S4** | 成员 tab 单列展示 | members-tab 横排网格 → 单列每行 1 人（沿用 `component-member-card` 视觉 / token） |
| **S5** | squad-panel 副标题调整 | 头部副标题去掉「squad · 团队看板」中「团队看板」字样（看板已搬家），保留 mono 风格，具体文案 TBD designer |

### 2.2 OUT-OF-SCOPE（Non-goals）

- **看板编辑 / 创建入口**——`component-squad-board` 仍**只读**（沿用 v0.0.33.3 PRD §5 排除）；编辑走对话让 leader 调工具。
- **后端 API 变更 / 数据迁移**——零新 API、零 schema 变化、零 dev/test 数据迁移。
- **看板三视图视觉重做**——沿用 `squad-board.md §视觉基线`；本版本仅做位置 / 路由态搬迁。
- **侧栏其他节点改造**——群聊 / leader / mate 节点位置 / 语义不变（仅插入新的「团队看板」节点在群聊前）。
- **member 面板**（§4.5 心跳配置 section 等）——不动；本版本只动 squad 面板。
- **新建 squad wizard / hire 表单 / charter 编辑器本体**——不在本版本范围（仅 charter 编辑器嵌入位置仍在管理 tab，不变）。

---

## 3. 关键用户路径（MANDATORY — 测试最低覆盖）

> 每条路径 = 至少 1 个 E2E case（视觉契约 = ui-demo.html 4 scene，run_all vision_check 主判定 + DOM 交叉验证 + 视觉保真 compare）。

| ID | 路径 | 涉及功能 | 测试类型 |
|----|------|---------|---------|
| **P1** | **侧栏点「团队看板」节点 → 进看板页 → 切 sub-tab**：用户展开 squad → 点新「团队看板」节点（首节点） → 主区切到 board 路由态 → 默认 sub-tab「目标」展示 Objective + KR 卡片 → 切「需求」「任务」看到对应只读视图 | S1 | E2E（DOM 断言 `squad-board` 根 + `squad-board-tab-{goals,requirements,tasks}` 切换 + vision_check 看 board 卡片渲染） |
| **P2** | **点 squad 行 → 进 3-tab 面板（默认管理）→ 切成员 → 切自动工作**：用户点 squad 行（非展开箭头） → 主区进 squad 面板，头部显示 squad 名 + 新副标题，3 tab「管理 / 成员 / 自动工作」→ 默认「管理」展示元信息 + charter → 切「成员」单列每行 1 人 → 切「自动工作」展示自主性开关 + 预算仪表 + 调度历史 | S2 + S3 + S4 | E2E（DOM 断言 tab 数 = 3 + tab 顺序 + 各 tab 内容存在；vision_check 看 3-tab 头部 + 成员单列 + 自主性 toggle） |
| **P3** | **管理 tab 编辑 squad 元信息 / charter 保存**（原介绍 description 已并入）：用户进管理 tab → 改 name / description → 点保存 → refetch 后字段回灌新值；charter 编辑器改 4 字段之一 → 填 reason → 保存 → charter-history 折叠面板里出现新版本 | S2 + S3 | E2E（DOM 断言 `squad-name-input` 改值 + `squad-admin-save` 点击 + 重 GET 后 input 回灌新值；vision_check 看保存 toast） |
| **P4** | **自动工作 tab：自主性开关切换 + budget 仪表 + 调度历史**：用户进自动工作 tab → 点 `squad-autonomy-toggle-switch` → PATCH /squad/:id `{enableHeartBeat}` 成功 → toggle 态翻转（off↔on）+ 说明文案变 → budget-meter 显示 consumed/limit/remaining + 进度条 → 调度历史列表（`auto-work-list`）按时间倒序展示条目 | S3 | E2E（DOM 断言 toggle 二态切换 + budget 4 数字节点 + `auto-work-item-*` 字段；vision_check 看 toggle / budget-bar / history-list 视觉） |

---

## 4. UI 概念对齐 + 概念变更点

### 4.1 对齐（沿用现有 ui spec 概念，无重命名 / 无新建组件）

| 概念 | 引用 spec | 在本版本的角色 |
|---|---|---|
| `section-studio-sidebar` + squad 树 | `studio-sidebar.md` | 侧栏新增「团队看板」节点（沿用 `tree-node` / `squad-tree-session-*` 节点结构 + testid 命名族） |
| `component-squad-board`（三视图 Goals/Requirements/Tasks） | `squad-board.md` | **位置变更**（从 squad-panel goals tab → 侧栏独立页路由态），组件本身零改动 |
| `section-squad-panel` + `component-{admin,members}-tab` | `squad-panel.md` | tab 路由表缩减（5→3）+ 嵌入位置调整 |
| `component-member-card` | `member-card.md` | 视觉 / token / testid 零改；仅容器从网格布局 → 单列 flex column |
| `squad-autonomy-toggle` / `budget-meter` | 各自 spec | **嵌入位置变更**（管理 tab → 自动工作 tab），组件本身零改 |
| `section-auto-work-history` | `auto-work-history.md` | **从独立 tab 内容 → 与 toggle / budget 合并为「自动工作」组合页**（仍是 section，组合关系变） |
| `component-charter-editor` + charter-history | `charter-editor.md` | 沿用；description 字段编辑从 intro tab 并入 admin（由 `component-manage-tab` 接管） |

### 4.2 概念变更点（PRD 仅描述；ui spec 落地在 architect / coder 阶段）

> 以下 5 项是 ui spec 待落地的概念变更。PRD 描述**用户可感知的形态变化**，**字段 / testid / 嵌入位置细节由 architect / coder 阶段更新 `specs/ui/overall/06-studio.md` + `specs/ui/components/studio-page/`**。

| # | 变更点 | 当前 spec 描述 | 目标形态 | 影响文件 |
|---|---|---|---|---|
| **C1** | 「团队看板」提升为侧栏树首节点（群聊上） | `squad-board.md §被组合`：「嵌入 `section-squad-panel` 的 goals tab，替换占位 banner」 | 树展开第 1 节点 = 「团队看板」（testid 命名 TBD architect，候选 `squad-tree-board-{squadId}` 或复用 `squad-tree-session-*`），点击 → page-studio 主区切到 board 路由态（独立页，非 squad-panel 子 tab）；squad-panel「目标」tab 删除（C2）；点 squad 行仍进 squad 面板 | `studio-sidebar.md`（树节点新增）+ `_overview.md`（主区路由态增加 board 态）+ `squad-board.md`（被组合关系改） |
| **C2** | squad-panel 5 tab → 3 tab | `squad-panel.md`：tab 路由表 `intro\|goals\|members\|admin\|autowork`（5 个） | tab 路由表缩为 `admin\|members\|autowork`（3 个，**按此顺序**）；删 `intro`（description + charter 摘要并入 admin，由 `component-manage-tab` 接管 description 字段编辑）；删 `goals`（看板搬家，C1）；autowork 从「纯 history」→「组合页」（C3）；members 容器改单列（C4） | `squad-panel.md`（tab 路由表 + `Props.tab` 类型）+ `_overview.md` + `06-studio.md §3` |
| **C3** | 自动工作 tab 扩成组合页（自主性开关 + 预算 + 调度历史） | 各组件 spec：toggle / budget 嵌入 `component-manage-tab`；auto-work-history 是独立 tab 内容 | `component-manage-tab` 移除 toggle + budget（仅留 squad 元信息 + charter + description）；新建 / 扩展 `component-autowork-tab`（或扩 `section-auto-work-history`）组合 toggle + budget-meter + history 三块；testid 嵌入关系更新 | `squad-autonomy-toggle.md`（嵌入位置）+ `budget-meter.md`（嵌入位置）+ `auto-work-history.md`（组合关系）+ `squad-panel.md` |
| **C4** | members-tab 横排网格 → 单列每行 1 人 | `squad-panel.md` / `member-card.md`：members-tab 用「网格布局」（具体多列网格 TBD designer） | members-tab 容器改单列 flex column（每行 1 张 member-card，纵向堆叠）；member-card 本身视觉 / token 零改 | `squad-panel.md §视觉基线` + `06-studio.md §3.3` |
| **C5** | squad-panel 头部副标题去掉「团队看板」字样 | `squad-panel.md §视觉基线`：副标题「squad · 团队看板」`font-mono text-xs text-muted` | 副标题保留 mono 风格，去掉「团队看板」字样（具体替换文案 TBD designer，候选「squad · 管理面板」或仅「squad」）；与 C1 一致（看板搬家后 panel 头部不再提看板） | `squad-panel.md §视觉基线` + `06-studio.md §3` |

---

## 5. 数据 / API

### 5.1 零新 API（明确声明）

本版本**零新端点、零 schema 变化、零字段增删**。所有数据来源沿用现有 API。

### 5.2 现有端点复用清单

| 端点 | 用途 | 在本版本的位置 |
|---|---|---|
| `GET /squad/:id/board?view=all`（11b §2） | 看板三视图数据（goals / requirements / tasks） | **看板页**（侧栏「团队看板」节点，C1）— 沿用，调用方从 squad-panel goals tab → 独立 board 路由态 |
| `GET /squad/:id/budget/usage`（v0.0.33.4 §4） | budget-meter 实时数据（consumed / limit / remaining / windowEnd） | **自动工作 tab**（C3）— 嵌入位置从 manage-tab → autowork-tab |
| `GET /squad/:id/scheduler/history?limit=N`（11a §4.4） | auto-work-history 历史条目 | **自动工作 tab**（C3）— 与 toggle / budget 同 tab |
| `PATCH /squad/:id` body `{enableHeartBeat: boolean}`（v0.0.33.4 §2） | squad-autonomy-toggle 写入 | **自动工作 tab**（C3）— toggle 嵌入位置变更 |
| `GET /squad/:id` | squad detail（name / description / modelDefault / enableHeartBeat / budget 等） | **管理 tab**（沿用） |
| `PATCH /squad/:id`（name / description / modelDefault） | squad 元信息保存 | **管理 tab**（沿用 + 接收原 intro tab 的 description 编辑，C2） |
| `GET /squad/:id/charter` + `PUT /squad/:id/charter` | charter 4 字段读写 | **管理 tab**（沿用，charter-editor 嵌入位置不变） |
| `GET /squad/:id/charter/history` | charter 版本历史 | **管理 tab**（沿用） |

---

## 6. 验收标准

### 6.1 功能验收

- **C1 看板搬家**：侧栏展开 squad → 第 1 节点是「团队看板」（在群聊前），点击 → 主区切到 board 路由态，3 sub-tab 切换正常，数据来自 `GET /squad/:id/board`。
- **C2 3-tab 面板**：squad 面板 tab 栏只有 3 tab（管理 / 成员 / 自动工作，按此顺序）；点 squad 行默认进「管理」tab；无「介绍」「目标」tab。
- **C3 自主性归位**：管理 tab **无** `squad-autonomy-toggle` 和 `budget-meter`；自动工作 tab **有** toggle + budget-meter + auto-work-history 三块。
- **C4 成员单列**：成员 tab 的 member-card 纵向单列堆叠（无横排网格）；每行 1 人；leader 卡片视觉强调（border-accent）不变。
- **C5 副标题调整**：squad 面板头部副标题不含「团队看板」字样。

### 6.2 行为保持（回归守护）

- 看板三视图渲染逻辑、refresh 策略、testid 命名（`squad-board-*`）零变化（仅位置搬迁）。
- toggle / budget / history 组件 props、testid（`squad-autonomy-toggle-*` / `budget-*` / `auto-work-*`）零变化（仅嵌入位置变更）。
- member-card 视觉、testid（`member-row-{memberId}-*`）零变化（仅容器布局改）。
- charter 编辑器、hire 表单、新建 squad wizard、member 面板**完全不动**。
- 所有 PATCH / GET / PUT 调用签名零变化。

### 6.3 测试 / 视觉保真门禁

- **E2E**：P1-P4 关键路径全 pass（hard_fail = 0；PRD 关键路径 case 不豁免）。
- **API**：本版本零新 API，回归 AT 跑现有 squad / board / budget / scheduler case（增量验证嵌入位置变更不破坏 API 契约）。
- **视觉保真 compare（MANDATORY — 有设计稿）**：对 ui-demo.html 4 scene 跑 `vision_check.py compare` 逐维度（layout / font / border / color）比对实现截图；明显偏差建 BUG。
  - scene ①：侧栏新节点 + 看板页三视图
  - scene ②：3-tab 头部 + 管理 tab 字段
  - scene ③ 上：成员单列
  - scene ③ 下：自动工作组合页（toggle + budget + history）
  - scene ④：5-tab → 3-tab 前后对比（视觉验证用，非实现）
- **代码质量**：`bun run typecheck` 通过；删 `intro` / `goals` tab 后 grep `squad-tab-intro\|squad-tab-goals` 仅遗留注释 / 历史 log（生产路径零命中）。

---

## 7. 与现有 ui / tech spec 的对齐

### 7.1 ui spec 改动清单（architect / coder 阶段的 ui spec 更新，本 PRD 仅枚举）

| spec 文件 | 章节 | 改动类型 | 改动 |
|---|---|---|---|
| `specs/ui/components/studio-page/_overview.md` | §1 布局（主区路由态） | 改 | 主区新增 board 路由态（与 squad-panel / member-panel / chat 平级）；删除 squad-panel 的 goals tab 描述 |
| `specs/ui/components/studio-page/studio-sidebar.md` | Props + 树节点 | 改 | 新增 board 节点类型（testid + 行为）；`onOpenChat` 或新 `onOpenBoard` 回调（architect 定） |
| `specs/ui/components/studio-page/squad-board.md` | §被组合 | 改 | 「嵌入 squad-panel goals tab」→「嵌入 page-studio 主区 board 路由态（侧栏新节点进入）」 |
| `specs/ui/components/studio-page/squad-panel.md` | `Props.tab` 类型 + tab 路由表 + 视觉基线（副标题） | 改 | tab 类型 `intro\|goals\|members\|admin\|autowork` → `admin\|members\|autowork`；副标题文案调整（C5） |
| `specs/ui/components/studio-page/squad-autonomy-toggle.md` | §被组合 | 改 | 「嵌入 `component-manage-tab`」→「嵌入 `component-autowork-tab`」 |
| `specs/ui/components/studio-page/budget-meter.md` | §被组合 | 改 | 同上 |
| `specs/ui/components/studio-page/auto-work-history.md` | §被组合 + §职责 | 改 | 从「独立第 5 tab」→「与 toggle + budget 组合为 autowork-tab」 |
| `specs/ui/components/studio-page/member-card.md` | — | **不改** | 视觉 / token / testid 零改 |
| `specs/ui/overall/06-studio.md` | §3 Squad 面板（5 tab → 3 tab）+ §2 侧栏（新节点） | 改 | tab 列表 3 项；侧栏 testid 表加 board 节点 |

### 7.2 tech spec / api spec 改动

**零改动**——本版本是纯前端组件重组，不涉及任何 tech spec（无新机制 / 无新数据流）或 api spec（无新端点 / 无 schema 变化）。`specs/api/version_logs/v0.0.57/change_log.md` 可写「零 API 变化，沿用 v0.0.33.4 §2 / §4 / §5 + 11a / 11b 现有端点」（由 doc-modifier 阶段判定是否需要）。

---

## 8. 待 architect / coder 落地的细节（PRD 不发明）

PRD 描述用户可感知行为，**具体 testid / 字段 / 路由态命名由 architect / coder 阶段落 ui spec**：

1. **侧栏新 board 节点 testid** — `squad-tree-board-{squadId}` vs 复用 `squad-tree-session-{boardVirtualSessionId}`（看板无 sessionId，故 architect 决策）。
2. **page-studio 主区路由态扩展** — 新增 `view='board'` 状态 vs 复用 chat 态用 `squadBoardId` 区分。
3. **autowork-tab 组件结构** — 新建 `component-autowork-tab.tsx`（容器，组合 toggle + budget + history）vs 扩 `section-auto-work-history` 充当容器。
4. **description 编辑嵌入位置** — 从 intro-tab 拿出后并入 manage-tab 的哪个字段区（name / modelDefault / description 三字段统一编辑 vs description 单独 charter 摘要区）。
5. **副标题具体文案** — 「squad · 管理面板」/「squad」/「squad · admin & members」等候选，TBD designer。

---

## 9. 与现有 overall PRD 的关系

本版**改变 squad 管理 UI 形态**（squad 面板 + 侧栏节点），按 prd-spec-rules「增量更新规则 3」**UI 变更必须更新 §2**——阶段 5 由 doc-modifier 同步 `specs/prd/overall/08-squad-studio.md` 加 `[v0.0.57 modified]` 标注（5 tab → 3 tab + 看板搬家 + 自主性归位 + 成员单列 + 副标题调整）；其他 overall 文件不受影响。
