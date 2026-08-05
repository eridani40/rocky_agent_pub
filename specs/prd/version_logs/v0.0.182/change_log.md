# v0.0.182 — chat/studio 三栏响应式布局修复

> 类型：用户可感知的 UI/交互变化（PRD 覆盖）
> 范围：chat 页（playground 三栏）+ studio 单聊/群聊页（右侧 section-right-tabs）统一响应式规则
> 前置概念权威源（已读对齐，不发明新组件）：
> - `specs/ui/components/chat-page/_overview.md` §1 布局（nav-rail 56 + conv-panel 220 + chat-detail flex-1 + ws-panel 232~560 / 收起 36）+ §4.1 conv-panel + §4.3 chat-detail
> - `specs/ui/components/chat-page/component-workspace-panel.md`（§4.2 拖宽契约 + §6 视觉基线 `.ws-resize` / `.ws-header` / `.ws-rail`）
> - `specs/ui/components/studio-page/section-right-tabs.md`（薄 wrapper，无条件渲染 SectionWorkspacePanel）+ `studio-page/_overview.md` §1（page-studio：studio-sidebar 224 + 主区四态）
> - `specs/ui/components/framework/app-shell.md`（nav-rail 56 + main flex-1，`h-screen overflow-hidden`）
>
> 用户三点决策（2026-07-20 确认，硬约束，本 PRD 直接采纳）：① 空间分配 = 中部保底 ≥480，窗口缩窄降级 右栏→232 ⇒ 左栏→180 ⇒ 中部→480 ⇒ 横滚兜底，任何宽度下板块/按钮完整不被裁；② 左栏 conv-panel 可拖 180~400、默认 220、localStorage 记忆、与右栏同套逻辑；③ 范围 = chat 页 + studio 统一（section-right-tabs 套用同一套规则）。

## 1. 问题定义 + 根因

**问题**（req.md）：右侧 workspace 板块 tab 经常只显示一半、header 右侧按钮（切目录/刷新/收起）消失；要求板块响应式且按钮完整、明确拖拽行为、左侧栏也可拖拽且逻辑一致、各种缩放考虑仔细。

**根因**（已核实）：

- 三栏均无语义化降级规则：conv-panel `w-[220px] shrink-0`、ws-panel `shrink-0` 固定宽，中部 chat-detail `flex-1 min-w-0` 无最小宽度保护。窗口缩窄时中部先被压到 0，三栏总宽超视口后 shrink-0 的 ws-panel **整栏被挤出视口右缘** → tab 露一半、按钮出视口。
- ws 拖宽手柄算法 `clamp(232, innerWidth − clientX, 560)` 是静态上限，与「中部还剩多少」解耦；到 clamp 边界后鼠标继续移动出现「脱手」死区。
- ws-panel header 内部在面板宽 ≥232 时本就放得下 tab + 3 按钮（tab `nowrap shrink-0` + `.ws-tabs overflow:hidden` + actions 26×26 shrink-0）——「按钮没了」是整栏被挤出视口所致，非 header 内部溢出。

## 2. 响应式空间分配模型 [v0.0.182]

### 2.1 槽位数值契约（chat 页 / playground）

| 槽位 | 组件 | 静态下限 | 默认 | 静态上限 | 收起态 |
|------|------|---------|------|---------|--------|
| nav-rail | app-shell 既有 | 56（固定，不参与） | — | — | — |
| 左栏 | conv-panel | 180 | 220 | 400 | — |
| 中部 | chat-detail | **480（保底，MANDATORY）** | 余量全占 | — | — |
| 右栏 | ws-panel | 232 | 272 | 560 | 36（ws-rail） |

- 右栏下限 232 的继承理由：既有视觉基线下 ws-header（tab + 3×26px actions）完整放下的最小宽度。
- 左栏 180 / 400 / 默认 220 为用户决策值；右栏 232 / 560 / 默认 272 沿用既有契约。

### 2.2 统一宽度模型（核心不变式）

每个侧栏：**渲染宽 = clamp(静态下限, min(设定宽, 动态上限), 静态上限)**。

- 「设定宽」= 用户拖拽意图值（localStorage 记忆）；窗口压缩**不改写**它。
- 「动态上限」的防守基准按场景区分（MANDATORY，两场景语义清晰分离）：
  - **场景 A · 拖拽（用户主动，§3）**：基准 = **中部底线 480**。`dynR = W − 56 − L渲染 − 480`、`dynL = W − 56 − R渲染 − 480`——拖侧栏 = 中部让路，中部触 480 侧栏即达动态上限（用户决策①）。
  - **场景 B · 窗口缩窄（被动，§2.3）**：基准 = **中部防守宽 C_defend = clamp(480, 中部当前宽, 舒适宽 932)**。`dynR = W − 56 − L渲染 − C_defend`、`dynL = W − 56 − R渲染 − C_defend`，解析顺序先 R 后 L（= 降级顺序 右⇒左）——侧栏先紧凑化、最大化保中部。C_defend 初始值（中部未被拖拽压缩过）= 932。
- **舒适宽 932** = 消息内容列 max-w-820 + 左 padding 32 + 右 overlay reserve 80（派生自既有 spec `_overview.md §4.5`，非新视觉规格）。中部宽 ≤932 时内容列完整舒适；>932 部分仅为内容列两侧空白。
- 不变式：**C渲染 = W − 56 − L渲染 − R渲染 ≥ 480**；无法满足时走 §2.4 横滚兜底，绝不突破 480。
- 左右栏同一套公式（用户决策②的一致性要求）；W = 视口 CSS px 宽。

### 2.3 窗口缩窄降级序列（用户字面顺序：侧栏先让，裁决 P1）

窗口缩窄时按 **右栏→232 ⇒ 左栏→180 ⇒ 中部→480 ⇒ 横滚** 的字面顺序降级——侧栏在 232/180 底线仍是设计可用宽，先紧凑化、最大化保中部聊天区。以设定宽 220 / 272 为例（触发点由 §2.2 场景 B 公式决定、不硬编码）：

| 相位 | W 区间（示例） | 表现 |
|------|---------------|------|
| P0 宽裕 | ≥ 1480 | 侧栏设定宽（220/272）；中部 ≥932，超出部分为内容列两侧空白（从更宽收窄至 1480 仅空白减少，非降级） |
| P1 右栏降级 | 1440 ~ 1480 | 中部守 932；右栏 272→232；左栏 220 不动 |
| P2 左栏降级 | 1400 ~ 1440 | 中部守 932；右栏触底 232；左栏 220→180 |
| P3 中部降级 | 948 ~ 1400 | 侧栏双触底（180/232）；中部 932→480 |
| P4 横滚兜底 | < 948 | 见 §2.4 |

- 若用户曾拖拽把中部压到 932 以下（如拖宽侧栏至底线 480），此后缩窄时防守其当前宽（C_defend = 当前宽，仍 ≥480）：侧栏继续向底线紧凑化，为中部让出空间。
- 整个序列中**任何板块/按钮完整可见，绝不裁出视口**。

### 2.4 横滚兜底

W < 56+180+480+232 = **948**（右栏收起时 752）→ chat 页根容器横向滚动（内部行 min-width = 最小内容总宽），三栏全部可滚动到达。app-shell 自身 `overflow-hidden` 不变，滚动发生在页容器层。

### 2.5 窗口拉宽自动恢复

W 增大 → 动态上限回升 → **侧栏先自动恢复各自设定宽、余量再归中部**（无需用户重拖）；拉回原宽度 = 布局完全复原，无滞后残留。

## 3. 拖拽交互契约 [v0.0.182]

### 3.1 手柄（复用 ws-resize 模式扩展，非新概念）

左栏 conv-panel 右缘新增拖拽手柄，**复用既有 `.ws-resize` 手柄模式**（概念权威 `component-workspace-panel.md §6.2`）：

- 6px 宽绝对定位手柄贴栏缘（右栏在面板左缘、左栏在面板右缘），`cursor: col-resize`；
- hover / 拖拽中显示 1px accent 竖线（`::after`）；
- 拖拽中 `document.body.userSelect='none'` + cursor 锁定，mouseup 恢复。

### 3.2 拖拽算法（消除脱手，MANDATORY）

- 拖拽改的是「设定宽」，经 §2.2 **场景 A** 公式（防守基准 = 中部底线 480）得渲染宽：拖宽 = **中部让路**（C 实时缩小）；C 到达 480 → 该栏即达动态上限，继续同向拖宽度不变。（窗口缩窄的被动降级走场景 B，见 §2.3，两场景语义分离。）
- **无死区（消除脱手）**：到达任一边界（静态 min/max 或动态上限）后**反向拖动立即响应**——宽度随反向移动立刻变化，不要求鼠标先走完整段越界位移。实现方式（如 delta 跟踪：记录 mousedown 起始宽 + 起始鼠标位，width = clamp(起始宽 ± Δ)）交 architect/coder，PRD 只锁定可感知行为。
- 右栏手柄算法同步从 `clamp(232, innerWidth − clientX, 560)` 升级为同一模型（静态 max 560 保留）。

### 3.3 持久化

- 右栏：沿用既有 `ws-width-<sid>` + `ws-collapsed-<sid>`（per session），语义不变——存设定宽，窗口压缩不改写。
- 左栏：新增 localStorage 记忆，默认 220；**全局 key**（如 `conv-panel-width`，裁决 P2——conv-panel 跨会话是同一列表，区别于右栏 per-session）。
- 松手（mouseup）时写入；写入值 = 拖拽实际到达的渲染宽。

### 3.4 收起态与拖拽共存

- 右栏收起（36 rail）时不参与拖拽；其槽位按 36 计入动态上限换算（左栏因此获得更大 dynL）。
- 展开恢复 `min(设定宽, 当前动态上限)`；记忆的原设定宽不变，空间宽裕后自动恢复（§2.5）。

## 4. ws-panel 板块内部响应式 [v0.0.182]

- **header 完整性保证（req①）**：任一渲染宽（≥232 展开态 / 36 收起态）下，ws-header 的「工作区」tab + 3 个 action 按钮（切目录/刷新/收起）**完整可见**。
- 手段：面板整栏永不被挤出视口（§2 模型）+ header 内部既有规则不变（tab `nowrap shrink-0`、`.ws-tabs overflow:hidden`、actions shrink-0）——232 下限即 header 完整性下限。
- 文件树 item name ellipsis 等内部行为照旧，本版本不改。

## 5. studio 统一规则 [v0.0.182]

studio 单聊（section-member-chat）/ 群聊（section-squad-chat）页槽位映射：

| 槽位 | studio 组件 | 规则 |
|------|------------|------|
| 左 | studio-sidebar（224 固定） | 本版本不动：不加拖拽、不参与降级压缩（裁决 P3） |
| 中 | chat 主区 | 保底 ≥480 / 舒适宽 932，同 §2.2（消息流同一 ComponentMessageStream，820 内容列 + 80 reserve 一致） |
| 右 | section-right-tabs → SectionWorkspacePanel | 与 chat 页右栏同一模型（232/272/560/收起36；拖拽 `dynR = W − 56 − 224 − 480`，缩窄 `dynR = W − 56 − 224 − C_defend`） |

- 降级序列（sidebar 固定不参与，无 P2）：P0 ≥1484 宽裕 ⇒ P1 右栏 272→232（中部守 932）⇒ P3 中部 932→480 ⇒ P4 横滚。
- 横滚兜底：W < 56+224+480+232 = **992**（右栏收起时 796 = 56+224+480+36）→ studio 页主区容器横向滚动。（修正：原 808 为算术误差，实为 796；引擎不硬编码、由公式涌现。）
- 响应式规则落在 chat 页消费方包装层，不动 base-chat-page（base 只管 chat 主区骨架）。

## 6. 窗口 resize + 浏览器 zoom

- 窗口 resize：走 §2 全模型（降级序列 + 横滚 + 拉宽自恢复）。
- 浏览器 zoom：zoom 放大等效 W（CSS px）变窄，**同一套规则**、无特例。例：1200px 屏 zoom 150% → W=800 → 已进入横滚兜底区间。
- 窗口缩到极小（< 最小内容宽）时所有板块经横滚可达，无裁切。

## 7. 关键用户路径（MANDATORY — 测试最低覆盖要求）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | chat 页拖 ws-resize 手柄向左 → 拖到中部=480 → 继续左拖 → 反向右拖 → 松手 → 刷新页面 | 右栏变宽、中部让路；中部 480 时右栏停止增长（动态上限生效）；反向立即变窄（无死区）；刷新后宽度 = 拖拽值 |
| UC-2 | 拖 conv-panel 右缘手柄向右 220→400 → 松手 → 刷新 | 左栏跟随变宽、中部让路、≤400 且受动态上限约束；刷新后宽度记忆 |
| UC-3 | 窗口从宽（≥1480）逐步拖窄 → 观察各栏 → 继续拖至极窄 | 依序：右栏 272→232（中部保持 932）→ 左栏 220→180 → 中部 932→480 → 出现横向滚动条；全程 tab/按钮/板块完整无裁切 |
| UC-4 | UC-3 后把窗口重新拉宽至原宽度 | 侧栏先自动恢复各自设定宽、余量再归中部；拉回原宽度 = 布局完全复原（无需重拖） |
| UC-5 | 收起 ws-panel（36 rail）→ 拖宽左栏 → 展开 ws-panel | 收起时左栏动态上限更宽；展开恢复原设定宽（空间不足按动态上限截断，记忆值不变） |
| UC-6 | studio 单聊/群聊页拖窄窗口至极窄 | right-tabs 同规则降级（→232）；sidebar 224 不变；中部 ≥480；横滚出现，header 按钮完整 |
| UC-7 | 浏览器 zoom 放到 150% → 观察 chat 页 | 等效窗口变窄，走同一降级序列，无板块被裁 |
| UC-8 | 右栏处于 232 下限（窗口窄）时查看 ws-header | 「工作区」tab + 切目录/刷新/收起 3 按钮完整可见 |

> 本版本纯前端布局改动、无 API/落库变更，验证形态（UT-only 豁免 AT/ET 与否）由 test-plan 阶段请用户确认（memory `ui-only-ut-skip-at-et`）。

## 8. 边界 / 不做什么

- 不改 nav-rail（56）、app-shell 结构、base-chat-page 骨架。
- 不改 ws-panel 内部功能（tab / 文件树 / 切换目录 / 懒监听）。
- 不给 studio-sidebar 加拖拽、不让其参与降级（固定 224）。
- 不改中部消息流 / 输入区内部布局（max-w-820、右缘 overlay 80px reserve 等照旧）。
- 无后端、无 API、无 SSE 变更；无新组件概念（左栏手柄 = ws-resize 模式扩展）。

## 9. 对齐检查（PRD ↔ 现有 ui spec）

已对齐（引用现有概念，无矛盾）：

- 布局四栏模型、ws-panel 宽域 232~560 / 默认 272 / 收起 36 → `_overview.md §1` + `component-workspace-panel.md §6`。
- 手柄视觉/交互模式（6px、col-resize、accent 竖线、body userSelect）→ `component-workspace-panel.md §6.2`（左栏为其复用扩展，非新发明）。
- studio 右侧 = 薄 wrapper 内 SectionWorkspacePanel → `section-right-tabs.md`；响应式落消费方包装层不动 base-chat-page。
- 持久化键 `ws-width-<sid>` / `ws-collapsed-<sid>` → `component-workspace-panel.md §4.1/§4.2`。

待落 spec（编码前置由 coder 更新，PRD 不自行改）：conv-panel 可拖契约（`_overview.md §4.1` 改）+ ws 拖宽算法升级（`component-workspace-panel.md §4.2` 改）——本 PRD 为产品层依据。

## 10. 裁决记录 + spec 偏差

**裁决记录（2026-07-20，orchestrator 代用户裁决，AFK 授权）**：

- **P1 = 用户字面降级顺序（侧栏先让）**：窗口缩窄时 右栏先从设定宽压向 232 ⇒ 左栏再从设定宽压向 180 ⇒ 中部最后触 480 底线 ⇒ 横滚兜底（**推翻**初版「中部先弹性收窄至 480」相位模型）。理由：与「中部保底」精神自洽——侧栏在 232/180 底线仍是设计可用宽，先紧凑化最大化保中部聊天区。已落 §2.2（场景 A/B 防守基准分离）/ §2.3（P0~P4 相位表）/ UC-3；形式化引入「中部防守宽 clamp(480, 当前宽, 932)」，舒适宽 932 派生自既有 spec 数值（`_overview.md §4.5`：820 内容列 + 32 左 padding + 80 右 overlay reserve），非新视觉规格。
- **P2 = 接受**：左栏宽度记忆 = 全局 key（如 `conv-panel-width`），区别于右栏 per-session `ws-width-<sid>`——conv-panel 内容跨会话不变。已落 §3.3。
- **P3 = 接受**：studio-sidebar 224 固定，不加拖拽、不参与降级，窄窗靠横滚。已落 §5 / §8。
- **P4 = 接受**：横滚触发点 chat 948px / studio 992px（右栏展开时）。已落 §2.4 / §5。

**spec 偏差（仅记录，不自行改 spec）**：

- `_overview.md §4.1` 现状 `w-[220px] shrink-0` 固定宽 → 本版本改为可拖 180~400，spec 需随编码更新。
- `component-workspace-panel.md §4.2` 现状拖宽算法 `clamp(232, innerWidth − clientX, 560)` → 本版本升级为动态上限模型。
- studio chat 页三栏 DOM 包装细节（SectionRightTabs 与 member/squad chat 根的 flex 关系）spec 未细化，architect 阶段以代码实际核对。
