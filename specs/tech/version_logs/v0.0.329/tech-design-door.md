# v0.0.329 技术设计 — 区域2(chat)/区域3(preview) 门模型（可横向滑动的门）

> 版本：v0.0.329 | 日期：2026-08-11
> PRD 权威：`specs/prd/version_logs/v0.0.329-region23-door.md`（老板亲自敲定门模型）
> worktree：`worktrees/v0.0.329-region23-door`（分支基于 dev1 0.0.328）
> **替代**：`v0.0.329/change_plan.md` 旧菱形/focusMode 方案（老板推翻，本设计全面重写）

## 0. 一句话方案

门 = 2/3 分隔的「显隐控制器」。三态（center/left/right）只决定**门在门框内的横向位置**（=谁被遮、谁露出），2+3 门框总宽位置永不变。实现 = **复用现有 preview.collapsed 收起机制 + 引擎最小扩展一个 `chatCollapsed` 分支**，不重写布局引擎、零新造组件。

## 1. 门状态机 → 引擎/渲染映射（核心）

### 1.1 三态定义与引擎输入映射

| 门态 | 语义 | 引擎 `preview` 槽 | 引擎 chat(middle) 槽 | 渲染物 |
|------|------|------------------|---------------------|--------|
| `center`（默认） | 2/3 共存 | `collapsed=false`（现状） | 剩余宽（现状） | 细线 `.pv-resize-left` + 双把手（左◀ 右▶） |
| `right`（遮3露2） | chat 占满门框 | `collapsed=true`（**现状收起路径原样**） | `available − left − right`（自动吞并 previewWidth=0） | 右缘粗线 `pv-collapsed-rail` + 左把手 ◀ |
| `left`（遮2露3） | preview 占满门框 | `collapsed=false` + **新增 `chatCollapsed=true`** | **0 宽不渲染** | 左缘粗线 `pv-collapsed-rail` + 右把手 ▶ |

### 1.2 关键不变量（PRD §4 三个不变 → 技术保证）

| 红线 | 技术保证 |
|------|---------|
| ① 粗线形态逻辑不动 | `pv-collapsed-rail` + `ComponentPreviewCollapseToggle` **零样式/零交互改动**，只在 left 态换「贴左缘」摆放位置（right 态 = 现状位置原样） |
| ② 门框（2+3）总宽位置不动 | 门框宽 = `available − leftWidth − rightWidth`，三态下 `left`/`right` 槽换算**完全不变**；门态只改「门框内部 chat/preview 怎么分」 |
| ③ 内容不移位 | 槽序 `left | chat | preview | right` 永不变；`chat` 永在 `preview` 左；隐藏态宽 0 不产生空白（另一侧吞并剩余） |

### 1.3 状态机（PRD §3.4，禁直接互跳）

```
center ─点◀→ left     center ─点▶→ right
center ←点粗线/▶─ left   center ←点粗线/◀─ right
left ╳ right（禁直接互跳，必须经 center 中转）
```

**实现**：`setDoor('left' | 'right' | 'center')`；UI 层只暴露相邻转换入口（center 态双把手各指向一端；left/right 态只有「回 center」入口），结构上无 left↔right 直达按钮。

## 2. 布局引擎最小扩展（唯一改动点）

### 2.1 为什么必须动引擎

- `door=right`：`preview.collapsed=true → previewWidth=0`，`middleWidth = available − left − 0 − right`，chat 自动占满门框 —— **现有路径已支持，零改**。
- `door=left`：需要 `chat(middle) = 0` 且 `preview` 占满门框。但引擎 4 槽场景B 中 `previewWidth` 被 `CHAT_WIDTH_MIN=320` 钳住（`clampSidebar(pvSetting, available − leftStatic − rightWidth − CHAT_WIDTH_MIN, 'preview')`），**永远给 chat 留 320**。这是唯一必须突破的点。

### 2.2 扩展设计：`chatCollapsed?: boolean`（可选，向后兼容）

**文件**：`app/web/src/lib/layout-width-engine.ts`

- `ThreeColLayoutInput` 新增可选 `chatCollapsed?: boolean`（**缺省 `false` = 旧路径一字不动，旧 UT 全绿**）。
- 仅 4 槽场景B（`dragging===null` 且 `preview != null`）新增前置分支：
  ```
  if (chatCollapsed === true) {
    previewWidth = available − leftWidth − rightWidth   // preview 吞并整个门框
    middleWidth  = 0                                     // chat 宽 0
    // 无 scrollX（chat 宽 0 是显式门态，非宽度不足）；minRowWidth = left + 0 + previewWidth + right
  }
  ```
- `door=right` / `center` 走既有路径（`chatCollapsed` 恒 false，引擎行为与现状逐字段相等）。

**约束**：MUST `chatCollapsed` 缺省/undefined 时输出与现状逐字段相等（回归保护）；MUST NOT 改 `computeThreeColLayout` 的 center/right 既有换算（老板禁大改）；MUST NOT 新增 chat 设定宽持久化（chat 仍是「剩余宽」语义，只在 left 态被压成 0）。

> **备选（不取）**：给 `PreviewSlotInput` 加字段。否决——语义上「chat 被遮」属于 chat 槽状态，挂在 `preview` 输入上概念错位；`chatCollapsed` 挂顶层 input 更清晰。

## 3. 门状态管理（挂载层级决策）

### 3.1 决策：扩展 `use-preview-collapsed.ts`（方案 A，非顶层 state）

沿用旧 change_plan 的方案 A 判断（已核实源码），**不选 page-chat/studio-router 顶层 state 分散两处**：

| 维度 | Context 扩展 ✅ | 顶层 state + props |
|------|----------------|-------------------|
| 状态归属 | `usePreviewCollapsed` 已管 collapsed，天然扩展三态 | 两处各自管一份 |
| 持久化 | `use-preview-collapsed.ts` 已有 localStorage 读写，扩 key 即可 | 两处各接 localStorage |
| 双消费方覆盖 | `PreviewAreaProvider` 已在 page-chat + studio-router 顶层包裹，**两处自动生效** | 需同步改两个文件 |
| 改动集中度 | 改 hook + context + provider（集中），消费方只读 context | 分散到 page-chat + studio-router |

### 3.2 三态 hook：`use-preview-collapsed.ts` → 三态门 hook

- 现状 `usePreviewCollapsed(sessionId)` 返回 `{ collapsed: boolean, setCollapsed }`，per-session `pv-collapsed-<sid>`（`'1'/'0'`）。
- **扩展为门三态**：新增 `door: 'center' | 'left' | 'right'` + `setDoor(v)`，per-session **`pv-door-<sid>`**（PRD §3.5，缺省 `'center'`）。
- **语义桥接（保持现状 collapsed 消费方零改）**：
  - `collapsed` 派生 = `door !== 'center'`（preview 被遮=right 时等价旧 collapsed=true）。
  - `pv-collapsed-<sid>` 旧 key **迁移**：读到旧 `'1'` 且 `pv-door-<sid>` 缺省 → 视为 `door='right'`（用户无感，PRD §10 授权 architect 定迁移）。
  - `usePreviewTabs` 的 `openTab/activateTab` 自动 `setCollapsed(false)` → 改 `setDoor('center')`（打开文件回居中，语义对齐）。

### 3.3 Context 下传

- `PreviewAreaContextValue` 新增 `door: DoorState` + `setDoor(v: DoorState): void`。
- `preview-area-provider.tsx` 从 `usePreviewTabs` 解构 `door/setDoor` 加入 Provider value（其余字段不动）。
- 消费方：`section-preview-area.tsx`（容器读 door 决定渲染哪态）+ 布局接线（见 §4）。

## 4. 布局接线（useThreeColLayout + 消费方）

### 4.1 chat 槽隐藏的传播

`chatCollapsed` 需从「门状态」传到「引擎输入」。路径：

```
usePreviewCollapsed(door)  →  PreviewAreaContext.door
  → 消费方容器（SectionPreviewArea）onLayoutChange 上报 / 顶层读 door
  → useThreeColLayout 构造引擎输入 chatCollapsed = (door === 'left')
  → computeThreeColLayout 输出 middleWidth=0 / previewWidth=门框
```

### 4.2 两个消费方（page-chat / studio-router）改动

| 文件 | 改动 |
|------|------|
| `use-three-col-layout.ts` | 新增可选入参 `chatCollapsed?: boolean`；构造引擎输入时透传；返回新增 `chatRenderWidth`（= `layout.middleWidth`，供 chat 槽隐藏判断） |
| `page-chat.tsx` | 读 context `door`，`chatCollapsed = door==='left'` 传入 `useThreeColLayout`；`door==='left'` 时 `SectionChatSession` **不渲染**（middleWidth=0） |
| `component-studio-chat-router.tsx` | 同上（hasLeft=false 路径，`door==='left'` 时不渲染 `SectionStudioChat`） |

> **chat 槽隐藏方式**：door=left 时**不渲染 chat 组件**（而非 width=0 保留 DOM）。理由：消息流 SSE 订阅与组件生命周期对齐，不渲染=卸载——但 PRD §13「区域2被遮时新消息 SSE 仍到达、恢复居中后可见」。**验证点**：若卸载导致消息丢失，则改为 `display:none`/`width:0` 保留挂载。**此点列入 change_plan 约束，coder 二选一并汇报**。

## 5. 门渲染（section-preview-area.tsx 重构渲染分支）

容器从 context 读 `door`，按三态渲染。`ComponentPreviewCollapseToggle` 复用（零改组件本体）。

### 5.1 center 态（细线 + 双把手）
- 细线 = 现状 `.pv-resize-left`（`ComponentColResizeHandle`，拖拽调宽保留）。
- 双把手：细线**左缘**贴 ◀（→ setDoor('left')）、细线**右缘**贴 ▶（→ setDoor('right')）。
- **新需求**：现 `ComponentPreviewCollapseToggle` 只渲 1 个 chevron。center 态需 2 个把手分贴细线两侧。**实现**：复用组件渲染 2 个实例，通过 `floating` + 定位 className 分置左右；chevron 方向由 `collapsed` prop 现逻辑决定（floating 展开态=▶，rail 收起态=◀）——**需在 change_plan 明确**：是否给组件加可选 `direction?: 'left'|'right'` prop 以显式控制 chevron（**最小改动**，老板要求组件形态零改 → 倾向不加 prop，用两个实例的摆放位置 + 现 collapsed/floating 组合凑出 ◀/▶，coder 落 change_plan 时定）。

### 5.2 right 态（右缘粗线 + 左把手 ◀）
- **= 现状 `collapsed=true` 路径原样**：`section-preview-area.tsx` L142-144 现逻辑（`ComponentPreviewCollapseToggle collapsed onToggle`）零改，onToggle → setDoor('center')。
- 粗线贴门框右缘（现状收起那条位置/形态），◀ 贴粗线左侧（组件内 `-left-[7px]` 已满足铁律）。

### 5.3 left 态（左缘粗线 + 右把手 ▶）
- 新增渲染分支：粗线 `pv-collapsed-rail` **贴门框左缘**（区域1右边界处），▶ 贴粗线右侧。
- 复用同一 `ComponentPreviewCollapseToggle` 的 rail 形态，但摆放位置在**门框左端**（chat 槽左缘），chevron 朝右（▶，点击回 center）。
- chat 槽宽 0 不渲染 → 粗线自然落在门框左缘。

### 5.4 把手位置铁律（PRD §2.3）落实
- center：左把手 ◀ 贴细线左、右把手 ▶ 贴细线右（两个实例分置）。
- left：▶ 贴左缘粗线右侧。
- right：◀ 贴右缘粗线左侧（现状 `-left-[7px]`）。
- **验收**：任何态下把手不得跑到线的异侧。

## 6. i18n（PRD §11）

复用 `workspace.preview.collapse`/`expand`。如需方向 tooltip 新增 3 key（`chat` 命名空间，zh-CN + en）：
- `workspace.preview.doorLeft`：文档区占满（门滑至左）/ Slide door left: focus document
- `workspace.preview.doorRight`：对话区占满（门滑至右）/ Slide door right: focus chat
- `workspace.preview.doorCenter`：恢复分栏（门回居中）/ Restore split view

> 具体 key 取舍由 coder 按既有模式落地，不新增命名空间。

## 7. 影响面与回归保护

| 关注点 | 结论 |
|--------|------|
| 引擎 | 仅加可选 `chatCollapsed` 分支，缺省=旧路径逐字段相等，旧 UT 全绿 |
| 拖拽 | center 态 `.pv-resize-left` 拖拽保留；left/right 态粗线不可拖（=现状 collapsed 行为） |
| 旧 localStorage 迁移 | `pv-collapsed-<sid>='1'` → `door='right'`；`'0'`/缺省 → `'center'` |
| academy 无预览区 | 无 Provider → `usePreviewArea()` 返 null → 无门（回归保护，PRD §12.11） |
| dirty 守卫 | 门切换只显隐区域，不触发 tab 开关/切换 → 不触发 dirty modal（PRD §13）。**例外**：center→right 若活动 tab 在 edit 态，复用现状「收起守卫」（section-preview-area 已有 collapseGuard）；center→left 不动 preview → 无守卫 |
| 不碰清单 | 区域1/4 显隐宽度、preview 内部组件、chat 内部组件、引擎 center/right 换算、ComponentPreviewCollapseToggle/pv-collapsed-rail 形态 |

## 8. 旧方案残留清查（PRD §12.12）

- 旧 PRD `v0.0.329-region23-layout.md` **已不存在**（grep 仅 door 版）。
- 旧 `change_plan.md`（focusMode/菱形）**本设计重写覆盖**。
- 代码层 focusMode/region-switcher/菱形/clip-path：grep 确认 **零残留**（当前代码无这些符号，旧方案未落地到代码）。
