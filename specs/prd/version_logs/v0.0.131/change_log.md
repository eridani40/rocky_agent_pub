# v0.0.131 — 会话区域 2 个升级（历史 query minimap + 右上悬浮菜单）

> 引入版本：v0.0.131 · 类型：纯前端 UI 升级（无后端 API 变更 / 无 schema 变更）· 测试范围：UT（minimap flatten 派生 + badge 计数 + 二级视图导航）+ ET（悬停/跳转/弹层二级视图/badge）；AT n/a（复用既有 `/memory/session` + `/session/:id/cron` CRUD，无接口变更）
>
> **概念权威源（MANDATORY 对齐）**——本 PRD 引用的组件/数据/接口 100% 来自下列已有 spec；本版本是「已有能力换承载壳 + 新增两个纯前端 UI 组件」，不发明后端概念：
> - `chat-page/_overview.md` §1（四栏布局）+ §2（message-flatten 视图模型：`user-text` / `agent-answer` 元素）+ §4.4（topbar-right = usage-panel + compact-btn + clear-btn）
> - `chat-page/component-workspace-panel.md` §2（ws-panel tab bar：workspace/memory/cron + `hideCronTab`）
> - `chat-page/section-memory-panel.md` + `component-memory-entry-card.md` + `component-memory-editor-modal.md`（session 长期记忆列表/卡/编辑表单，`/memory/session` CRUD）
> - `chat-page/component-cron-panel.md` + `component-cron-freq-picker.md`（session 定时任务列表/频率选择，`/session/:id/cron` CRUD）
> - `studio-page/section-right-tabs.md`（studio leader/mate/squad 右侧薄 wrapper → 透传 ws-panel tab；`showCronTab`）
> - `app-dev-config-page/section-user-memory.md`（app config 全局长期记忆——弹层内管理能力/视觉参考；数据结构与 session 记忆同构，仅 scope 不同）
>
> **对应 overall**：doc-modifier 阶段 5 同步 `specs/prd/overall/`（chat 体验章节新增 minimap + 悬浮菜单小节）+ 上述 UI component spec（新增 2 组件 spec + 3 处废弃 tab）。

## 目录

| 章节 | 说明 |
|------|------|
| §1 背景 + 目标 + 非目标 | 为什么做、改什么、明确不动项 |
| §2 升级 1：历史 query minimap | 竖排 bar + Dock 悬停 + 预览气泡 + 点击跳转 |
| §3 升级 2：右上悬浮菜单 + 弹层 | 菜单 + badge + 弹层二级视图（返回按钮）+ idle 空态 |
| §4 布局 | 两个新区域让出空间 + 布局稳定性 |
| §5 关键用户路径（MANDATORY） | 全部核心操作序列 = 测试最低覆盖 |
| §6 新概念清单 | architect 架构期落 `specs/ui/components/` |
| §7 废弃清单 | 彻底删干净的旧入口/组件用法 |
| §8 概念对齐声明 + 需裁决点 | 对齐自查 + 交 orchestrator 裁决 |
| §9 测试范围 | UT / ET / AT n/a 映射 |

---

## 1. 背景 + 目标 + 非目标

### 1.1 背景

聊天区右侧的「长期记忆」「定时任务」现以 tab 形式挂在 ws-panel（`component-workspace-panel` 的 tab bar，playground 直挂 / studio 经 `section-right-tabs` 透传）。两处诉求：
1. 长对话缺乏「历史 query 快速定位」手段——用户要回看某条过去提问只能手动上滚。
2. ws-panel tab 越堆越多（工作区 + 长期记忆 + 定时任务），记忆/任务是「弹层型管理」而非「常驻侧栏」，塞进文件树旁的 tab 语义别扭。

### 1.2 目标

- **升级 1**：聊天区右缘加一列历史 query minimap（竖排小 bar），悬停预览、点击跳转，帮助长对话快速定位过去提问。
- **升级 2**：聊天区右上角加悬浮菜单，把「长期记忆」「定时任务」从 ws-panel tab 迁入菜单 → 点开弹层管理；弹层内新增/编辑走同弹层二级视图（顶部返回按钮），不再弹层套弹层；菜单项带 badge 计数（记忆数 / active cron 数，=0 隐藏）。
- **布局**：给两个新区域让出空间，不与 ws-panel / topbar 操作区 / usage-panel 打架。

### 1.3 非目标（明确不做）

| 项 | 不做原因 |
|---|---|
| 后端 API 变更 | 记忆/任务复用既有 `/memory/session` + `/session/:id/cron` CRUD；minimap 纯前端派生自已加载 messages，无新端点 |
| memory/cron 数据结构变更 | entry / CronJobSummary schema 不动；仅换 UI 承载壳（tab → 弹层） |
| app config 全局长期记忆（`section-user-memory`） | 保持 settings 页内介质不变（仅作本版本弹层的视觉/管理能力参考，不迁不动） |
| 全文预览 | minimap 预览气泡只截断展示（定位用途，非全文阅读） |
| minimap 持久化/后端存储 | bar 列表纯前端从当前会话 messages 派生，切会话即重算 |

---

## 2. 升级 1：历史 query minimap

### 2.1 定位

聊天区（chat-detail）右缘一列纵向堆叠的小横条（bar），每条对应会话中一条「渲染为 user 气泡的历史消息」。悬停放大 + 左侧预览，点击滚动跳转。仅作定位辅助，不展全文。

### 2.2 数据来源（对齐 message-flatten `user-text` — MANDATORY）

- **一条 bar = 一个 `user-text` 视图元素**：与 `_overview.md §2` + `message-flatten.ts` **同源判定**——凡 flatten（`flattenMessages`）产出 `kind:'user-text'` 元素的消息算一条 bar。
  - **content block 过滤天然覆盖**：`DEFAULT_BLOCK_FILTER` 已滤掉 `isSystemReminder` text block，不产 user-text → 不生成 bar（无需 minimap 层重复过滤）。
  - **IM 渠道入站 user 消息也算**：飞书等 channel 入站 user 消息仍是 `role:'user'` → flatten 产 user-text（`name` 字段带 channel type）→ 算一条 bar（与气泡一致）。
  - **squad 群聊**：沿用群聊 `messageFilter = m => isUser(m) || isA2aInbox(m)`。**判定按 side 而非裸 kind**（实现修正，见 `component-history-minimap.md §2`）：a2a inbox 消息 `role:'user'` **确会产 `user-text` 元素**，但群聊里由 `sideOfMessage`（`sender.source==='agent'`→'assistant'）判为**左侧气泡**；minimap 只对 `side==='user'`（右侧气泡）产 bar，故 a2a inbox 被 side 判定排除 → bar = 用户自己的提问。单聊传 `memberSideResolver` 时 a2a inbox 判右侧 → 产 bar。（原表述「a2a inbox 不产 user-text」不准确，已按 side 判定口径修正。）
- **最多 10 个**：bar 数量上限 10；超过取**最近 10 条**（时间序末尾 10 个 user-text）。
- **每个 bar 锚定**：`user-text.messageId`（= 消息 ULID）→ 点击时据此定位消息 DOM（`msg-user-{messageId}`）。

### 2.3 交互

- **常态**：bar 竖排（时间序上→下 = 旧→新），等高等宽小横条。
- **悬停 Dock 放大**：悬停某 bar 该 bar 拉最长，相邻 bar 梯度递减（示意比例：悬停处 5 / 相邻 4 / 次相邻 3 / 再次 2 / 常态 1，非精确值，orchestrator 定视觉曲线）。移开恢复常态。
- **悬停预览气泡**（bar 左侧弹出白色圆角卡片，对齐截图形态）：
  - 第一行（黑色加粗，单行 ellipsis）：该条 query 内容（= `user-text.text`）。
  - 第二行（灰色小字，单行 ellipsis）：其下回答头部（= flatten 序列中该 user-text **之后第一个 `agent-answer` 元素**的 `text` 头部）；若该 query 尚无 answer 文本（回答未生成 / 仅工具调用未出文本）→ 显示占位文案（如「暂无回复」）。
  - 均截断，仅供定位不展全文。
- **点击跳转**：点 bar → 聊天区滚动到该条 query 消息（`msg-user-{messageId}` 滚入视口）+ 短暂高亮该消息（视觉提示，可选，orchestrator 定）。

### 2.4 界面要素 + 布局稳定性

- minimap 容器绝对定位于 chat-detail 右缘（messages 区右侧留白 gutter，不遮居中 `max-w-[820px]` 正文）。
- **布局稳定性（MANDATORY）**：bar 悬停拉长（Dock 效果）+ 预览气泡出现/消失，均为**绝对定位 overlay**——绝不推动 topbar / messages / ws-panel 位移。bar 常态与放大态占位由 overlay 承载，不进常规流。

### 2.5 适用范围

playground chat（`page-chat`）+ studio leader/mate（`member-chat-page`）+ squad chat 群聊（`squad-chat-page`）**统一都有**。

### 2.6 E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-M1 | 打开一个有多条历史 query 的会话 → 观察聊天区右缘 | 出现竖排 minimap bar，条数 = 历史 user-text 数（≤10；>10 只显最近 10 条） |
| UC-M2 | 悬停某个 bar | 该 bar + 相邻 bar Dock 式梯度拉长；bar 左侧弹出预览气泡（第一行 query 摘要加粗、第二行回答头部灰字，均单行截断）；其他元素无位移 |
| UC-M3 | 悬停 bar → 点击该 bar | 聊天区滚动跳转，对应 `msg-user-{messageId}` query 消息滚入视口 |
| UC-M4 | 悬停「回答尚未生成」的最新 query bar | 预览气泡第二行显示占位文案（不报错、不空白） |
| UC-M5 | squad chat 群聊打开有历史提问的会话 | minimap 出现，bar = 用户自己的提问（a2a inbox 不产 bar） |

---

## 3. 升级 2：右上悬浮菜单 + 弹层

### 3.1 定位

聊天区右上方（贴 chat-detail 与 ws-panel 分界处）一个竖向圆角白色悬浮工具条（形态参考截图），内含纵排小图标菜单项。收纳原 ws-panel 的「长期记忆」「定时任务」两项——点菜单项弹出对应弹层管理。

### 3.2 菜单项 + badge

| 菜单项 | 点击行为 | badge 数字 | badge=0 |
|---|---|---|---|
| 长期记忆 | 弹「session 长期记忆」弹层 | 记忆条数（GET `/memory/session` 非归档 entry 数） | 隐藏 |
| 定时任务 | 弹「定时任务」弹层 | active 任务数（GET `/session/:id/cron` 中 `enabled=true` 数） | 隐藏 |

- **badge 实时变化**：用户在弹层内新增/编辑/归档记忆、新建/删除/toggle 任务 → CRUD 成功后 refetch → badge 计数即时更新（=0 时隐藏 badge，非渲 0）。
- **badge 布局稳定性（MANDATORY）**：badge 出现/消失（0↔非0）用绝对定位角标或预留固定槽位，不推动菜单项/图标位移。

### 3.3 弹层：列表 ↔ 二级视图（返回按钮）

**核心交互模式（新概念）**——弹层内二级视图导航，不弹层套弹层：

- **列表态（默认一级视图）**：
  - 长期记忆弹层：复用 `component-memory-entry-card` 渲染 entry 列表（session scope），视觉/管理能力参考 app config `section-user-memory`（数据结构同构）。空列表 → **idle 空态图**。
  - 定时任务弹层：复用 `component-cron-job-card` 渲染 cron 列表。空列表 → **idle 空态图**（沿用/升级 `cron-empty`）。
- **二级视图（新建/编辑）**：点「新建」或某条「编辑」→ **在同一弹层内切到二级视图**（编辑表单：记忆复用 `component-memory-editor-modal` 的表单字段；任务复用 `component-cron-freq-picker` + prompt），**顶部保留返回按钮** → 点返回回到列表态。**不再叠加一层 modal**（原「记忆列表在 tab、编辑弹独立 modal」的模式在此弹层内被二级视图取代）。
- **保存**：POST/PATCH（记忆 `/memory/session`，任务 `/session/:id/cron`）→ 成功回列表态 + refetch + badge 更新；失败 → toast + 留在二级视图。
- **归档/删除**：记忆 DELETE 归档 / 任务 DELETE → refetch + badge 更新。

### 3.4 数据来源（复用既有 CRUD — 无后端变更）

- 长期记忆：`/memory/session` CRUD（GET/POST/PATCH/DELETE），entry schema 见 `section-memory-panel.md §3`。
- 定时任务：`/session/:id/cron` CRUD（6 端点），CronJobSummary 见 `component-cron-panel.md §3`。
- **badge 计数**：从上述 GET 列表结果派生（记忆 = `entries.length`；cron = `items.filter(enabled).length`），无独立 count 端点。架构期定「chat 挂载即取两列表算 badge」vs「懒取」（见 §8 裁决点）。

### 3.5 适用范围（含 squad chat）

| 承载页 | 长期记忆项 | 定时任务项 |
|---|---|---|
| playground chat（`page-chat`） | ✅ | ✅ |
| studio leader/mate（`member-chat-page`） | ✅ | ✅ |
| squad chat 群聊（`squad-chat-page`） | ✅（群聊 team 语义 memory，对齐 `section-right-tabs.md §1` 表） | ❌ 隐藏（继承 `hideCronTab`/`showCronTab=false` 语义——群聊 cron 无主，`component-cron-panel.md §9`） |

> squad 群聊菜单沿用现有 hideCron 语义：定时任务项**不渲染**（非 disabled），长期记忆项正常。badge=0 时该项隐藏与常规逻辑一致。

### 3.6 E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-F1 | 点悬浮菜单「长期记忆」项 | 弹出记忆弹层，列表态渲染 session entry（空则显 idle 空态图） |
| UC-F2 | 记忆弹层列表态 → 点「新建」→ 填字段 → 保存 | 弹层内切二级视图（顶部有返回按钮）→ 保存后回列表态 → 列表新增该条 → 菜单「长期记忆」badge +1 |
| UC-F3 | 记忆弹层 → 编辑已有 entry → 二级视图改内容 → 保存 / 或点返回 | 保存回列表显新值；点返回不改数据回列表（二级视图始终有返回按钮，无二层 modal 遮罩） |
| UC-F4 | 记忆弹层 → 归档某 entry | 列表移除该条 → badge -1；归档到 0 时 badge 隐藏 |
| UC-F5 | 点悬浮菜单「定时任务」项 → 新建任务（二级视图 + 返回）→ enable 保存 | cron 弹层列表新增任务；「定时任务」badge = active 任务数（空态显 idle 图） |
| UC-F6 | squad chat 群聊打开悬浮菜单 | 只见「长期记忆」项，无「定时任务」项 |
| UC-F7（回归-废弃） | 打开 chat / studio 右侧 ws-panel tab bar | 只剩「工作区」tab；无「长期记忆」「定时任务」tab（旧入口彻底移除） |

---

## 4. 布局（让出空间 + 稳定性）

- **两个新区域定位**（均绝对定位 overlay 于 chat-detail，anchor 右缘）：
  - 悬浮菜单：chat-detail 右上角贴 ws-panel 分界处，**位于 topbar 下方**——不与 topbar-right（usage-panel + compact-btn + clear-btn，`_overview.md §4.4`）重叠。
  - minimap：chat-detail 右缘竖排，位于悬浮菜单下方沿右缘延伸；利用 messages 居中 `max-w-[820px]` 后的右侧留白 gutter，不遮正文、不与 ws-panel 重叠。
- **不与既有元素打架**：ws-panel（可收起/拖宽，右侧独立栏）不受影响；topbar-right 操作区不位移；usage-panel 展开面板层级高于两新 overlay（避免遮挡）。
- **布局稳定性（MANDATORY，全局）**：minimap bar Dock 放大 / 预览气泡 / badge 0↔非0 / 菜单 hover 态，一律绝对定位或预留固定槽位（`visibility/opacity` 切换），**绝不导致相邻元素位移**。禁止 `display:none` + 常规流导致跳动。

---

## 5. 关键用户路径（MANDATORY — 测试最低覆盖）

> 每条路径至少一个 ET case（AT n/a：无接口变更）。路径 = ET designer 设计 case 的依据。

- **路径 1（minimap 定位）**：打开长会话 → 右缘出现 ≤10 个 bar → 悬停 bar → Dock 放大 + 预览气泡（query + 回答头部截断）→ 点击 → 滚动跳转到该 query（UC-M1/M2/M3）。
- **路径 2（minimap 边界）**：>10 条 query 只显最近 10；回答未生成时预览第二行占位（UC-M1/M4）。
- **路径 3（minimap 全渠道）**：playground / studio leader-mate / squad 群聊都出现 minimap，群聊 bar = 用户提问（UC-M5）。
- **路径 4（悬浮菜单 → 记忆弹层 → 二级视图）**：点菜单「长期记忆」→ 列表态（空显 idle）→ 新建（二级视图 + 返回按钮）→ 保存 → 回列表 + badge +1（UC-F1/F2）。
- **路径 5（记忆编辑/归档 + badge 实时）**：编辑（二级视图返回）/ 归档 → 列表更新 → badge 随增删实时变化、=0 隐藏（UC-F3/F4）。
- **路径 6（定时任务弹层同类路径）**：点菜单「定时任务」→ 列表态（空显 idle）→ 新建/编辑（二级视图 + 返回）→ 保存 → active 任务 badge 更新（UC-F5）。
- **路径 7（squad 群聊菜单收敛）**：群聊菜单只显「长期记忆」，隐「定时任务」（UC-F6）。
- **路径 8（旧 tab 入口废弃回归）**：chat / studio 的 ws-panel tab bar 只剩「工作区」tab，长期记忆/定时任务 tab 不再存在（UC-F7）。

---

## 6. 新概念清单（architect 架构期落 `specs/ui/components/`）

> 本版本引入 3 个新前端 UI 概念，**概念 spec 由 architect 在架构阶段落 `specs/ui/components/`**（先 spec 后实现）。命名建议（与现有命名风格一致，architect 可斟酌）：

| 新概念 | 建议命名 | 归属页 | 职责 |
|---|---|---|---|
| 历史 query minimap | `chat-page/component-history-minimap.md` | chat-page（三处 chat 复用） | 从 flatten `user-text` 派生 bar（≤10 最近）+ Dock 悬停放大 + 左侧预览气泡 + 点击滚动跳转；testid（如 `history-minimap` / `history-minimap-bar-{messageId}` / `history-minimap-preview`）由 architect 定 |
| 聊天区右上悬浮菜单 | `chat-page/component-chat-float-menu.md` | chat-page（三处复用） | 竖向悬浮工具条 + 记忆/任务菜单项 + badge 计数（=0 隐藏）+ 点击开弹层；squad 群聊 `hideCron` 收敛 |
| 弹层二级视图导航模式 | 并入上条弹层组件 spec（或 `component-memory-modal` / `component-cron-modal` 视 architect 拆分） | chat-page | 弹层内「列表 ↔ 新建/编辑」二级视图切换 + 顶部返回按钮 + idle 空态图；复用 `component-memory-entry-card` / `component-memory-editor-modal` 表单 / `component-cron-freq-picker` |

> 复用既有组件（不新造）：`component-memory-entry-card`、`component-memory-editor-modal`（表单字段）、`component-cron-job-card`、`component-cron-freq-picker`。新弹层是「换承载容器 + 二级视图导航」，内部零件复用。

---

## 7. 废弃清单（彻底删干净 — 遵循「替换旧路径不留僵尸」）

| 废弃项 | 出处 spec | 处置 |
|---|---|---|
| ws-panel「长期记忆」tab（`ws-tab-memory`） | `component-workspace-panel.md §2/§5` | 从 `component-ws-tab-bar` 移除；ws-panel tab bar 仅剩「工作区」 |
| ws-panel「定时任务」tab（`cron-tab` 入口） | `component-workspace-panel.md §2/§5` + `component-cron-panel.md §5` | 从 `component-ws-tab-bar` 移除；`hideCronTab` prop 在 ws-panel 侧失去意义（cron 不再是 ws-panel tab） |
| studio `section-right-tabs` 的 memory/cron tab | `section-right-tabs.md §1 表` | 因 section-right-tabs 透传 ws-panel tab bar，随 ws-panel 移除 memory/cron 自动只剩「工作区」；`showCronTab` 语义迁移到悬浮菜单侧 |
| session-scope 记忆的独立 editor-modal 叠加用法 | `component-memory-editor-modal.md §1` | chat/studio session 记忆的「列表在 tab + 编辑弹独立 modal」模式废弃 → 改弹层内二级视图。**注意**：app config `section-user-memory`（global scope）仍用独立 modal，**不废弃**（settings 页非 modal，无套弹层问题） |

> **单一来源护栏**：ws-panel tab bar 是 playground + studio 共用的唯一 tab bar（`section-right-tabs` v0.0.63 已退化为薄 wrapper 透传）——移除 memory/cron tab 一处即两处生效，无重复删除点。architect 需确认移除后 `hideCronTab`/`showCronTab` 相关 prop 链是否整条清理或转义到悬浮菜单。

---

## 8. 概念对齐声明 + 需 orchestrator 裁决点

### 8.1 概念对齐声明（MANDATORY 自查）

本 PRD 引用的组件/数据/接口 **100% 对齐**已有 spec，无与 spec 矛盾：

| 概念 | PRD 引用 | spec 权威源 | 对齐 |
|---|---|---|---|
| minimap bar 判定 = `user-text` | §2.2 | `_overview.md §2` + `message-flatten.ts`（`kind:'user-text'`） | ✅ 一致 |
| 回答头部 = 下一个 `agent-answer` | §2.3 | `message-flatten.ts`（`kind:'agent-answer'`） | ✅ 一致 |
| 记忆/任务数据 + CRUD | §3.4 | `/memory/session` + `/session/:id/cron`（`section-memory-panel.md` / `component-cron-panel.md`） | ✅ 无接口变更 |
| 群聊无 cron | §3.5 | `component-cron-panel.md §9` + `section-right-tabs.md §1 表` | ✅ 一致 |
| topbar-right 元素 | §4 | `_overview.md §4.4`（usage/compact/clear） | ✅ 避让 |

### 8.2 需 orchestrator / architect 裁决点（PRD 不擅自定夺）

1. **badge 计数取数时机**：badge 需要记忆/cron 计数在**弹层未打开时**也可见 → chat 挂载即 GET 两列表算 badge（多两次请求）vs 懒取（首次打开菜单/弹层才有数）。倾向「挂载即取」（badge 才有意义），但增两次 GET，交 architect 定。
2. **badge 对 agent 侧写入的实时性**：记忆可被 agent（`memory_manage` 工具 / evolvable 自动进化）写入，**当前无 memory SSE 事件**（仅 `/memory/session` 轮询/refetch）。用户自己在弹层的 CRUD → badge 即时更新；agent 侧写入 → 下次弹层打开/chat 重挂载才反映（非实时）。**是否需要为 badge 引入 memory SSE = 超出本版本纯前端范围**，建议本版本 badge 实时性只保证「用户 CRUD 即时」，agent 侧写入非实时（标注已知边界）。请 orchestrator 确认此口径。
3. **minimap 与悬浮菜单是否同容器**：两者都贴右缘，architect 定是否合并为一个右侧 overlay 层（统一 z-index / 避让 usage-panel 展开面板）还是两个独立 overlay。
4. **studio/squad 承载页接线**：`member-chat-page` / `squad-chat-page` 目前经 `section-right-tabs` 挂 ws-panel；悬浮菜单 + minimap 是挂在各 chat 页主区（topbar/messages 层）还是 ws-panel 外层，architect 定接线点（3 处 chat 页统一复用同组件）。
5. **视觉设计**：无设计稿（用户裁决「视觉 orchestrator 定，跳过 compare」）——Dock 放大曲线、预览气泡样式、悬浮菜单/图标/badge、idle 空态图，由 orchestrator 给视觉 brief，ET 不跑 `vision_check.py compare`。

---

## 9. 测试范围

| 层 | 范围 | 覆盖点 |
|---|---|---|
| **UT**（coder 白盒） | minimap 派生 + badge 计数 + 二级视图状态 | flatten `user-text` → bar 列表（≤10 取最近 10 / content filter 天然覆盖 / IM 入站算一条 / 群聊 messageFilter）；「回答头部 = 下一个 agent-answer / 无则占位」派生；badge 计数（entries.length / enabled cron 数，=0 隐藏）；弹层列表↔二级视图切换 + 返回 state |
| **ET**（黑盒 Playwright，dom 主判定） | §2.6 + §3.6 全部 UC | minimap 悬停/放大/预览/点击跳转（UC-M1~M5）；悬浮菜单开弹层/二级视图/返回/badge 增减/群聊收敛/旧 tab 废弃（UC-F1~F7）。testid 从架构期落的组件 spec 读 |
| **AT** | **n/a** | 无后端 API 变更（复用既有 `/memory/session` + `/session/:id/cron` CRUD，已有 AT 覆盖）；纯前端承载壳变更。用户裁决可按 `ui-only-ut-skip-at-et` 口径豁免 AT（orchestrator 核实确无接口/落库/后端逻辑变更后确认） |

> **测试最低覆盖**：§5 的 8 条关键用户路径每条至少一个 ET case（无设计稿 → 不跑视觉保真 compare）。

---

## 10. 实现偏差记录（编码期 vs change_plan，doc-modifier 阶段 5 汇总）

change_plan 冻结不改；以下为编码期相对 change_plan / PRD 的合理偏离（均已 orchestrator 裁决，spec 已对齐代码实际）：

- **[勘误] change_plan 前置 spec 路径笔误**：coder 前置组件 spec 写成 `app/web/...md` → 实际位于 `specs/ui/components/chat-page/`（planner 确认，不影响契约）。
- **[T1] `deriveMinimapBars` 签名**：change_plan 宽表述 `(elements, opts)` → 实际 `deriveMinimapBars(elements, messages, sideResolver?, max=10)`——需 `messages` 按 messageId 查 side，D 组 3 处 root 按位置参调用。属口径统一，非核心偏离。
- **[T2] `component-chat-right-overlay` children 插槽**：change_plan B 组原定 overlay 内部直接 import 渲染 `ComponentChatFloatMenu`；因 T2/T3 并行编码时 float-menu 未产出，加 `children?: ReactNode` 插槽承接（`sessionId`/`hideCron` props 保留）。3 处 root 按 `<Overlay …><FloatMenu …/></Overlay>` 形态调用（见 `component-chat-right-overlay.md §7`）。
- **[T4] `memberSideResolver` 类型适配**：`memberSideResolver(msg: Message)` 不接受 undefined，而 `SideResolver` 类型含 undefined 防御分支——section-member-chat / UT 内联适配器 `(msg)=>msg?memberSideResolver(msg):'assistant'` 包一层满足类型，不改行为。
- **[T4] `section-squad-chat` 根容器补 `relative`**：群聊根 `<main>` 原无 `position:relative`，按 overlay spec §3 补上（否则 `absolute` overlay 定位基准错乱）。
- **[T5] 超字面删 plumbing**：change_plan E 组字面「删 memory/cron tab 分支」→ 进一步删 `WsTab` type + `activeTab`/`onTabChange` props（单 tab 后切换 state 是死权重，遵「不留僵尸」），`ws-tab-workspace` 从 `<button onClick>` 改静态 `<div>`；testid 契约不变。
- **[T5] cron-modal 重复标题修复**：去 `component-cron-new-form` 内部重复标题 + 外层 `border-t`/`bg-surface`/padding 容器（弹层 head 已渲同 key `cron.form.newTitle`，否则弹层内标题×2）；`NewFormState` import 迁 `./use-cron-crud`。
- **[T3/T6] i18n 零新增业务 key（超预期精简）**：memory-modal/cron-modal/editor-fields 全复用既有 key；本版仅新增 `minimap.noReply` / `floatMenu.memory` / `floatMenu.cron` 中英双语（菜单 aria-label/title + 空占位）。
- **[T6] 孤儿 key 清理**：删 `workspace.tab.cron`（cron tab 删除后全库零 `t()` 引用）。
