# v0.0.329 变更计划书 — 区域2(chat)/区域3(preview) 门模型（可横向滑动的门）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> PRD 权威：`specs/prd/version_logs/v0.0.329-region23-door.md`（老板亲自敲定门模型）
> 技术设计：`specs/tech/version_logs/v0.0.329/tech-design-door.md`
> **本文件替代**：旧 `v0.0.329/change_plan.md`（菱形/focusMode 三态移位方案，老板推翻，全面重写。旧方案未落地到代码，无代码残留）。

## 0. 方案一句话

门 = 2/3 分隔的显隐控制器。三态（center/left/right）只决定门在门框内的横向位置。实现 = **复用现有 `preview.collapsed` 收起机制 + 引擎最小扩展一个 `chatCollapsed` 可选分支**，不重写布局引擎、零新造组件。门状态挂 `usePreviewCollapsed` 扩展（Context 下传，page-chat/studio-router 两处自动覆盖）。

## 1. 架构判断（已核实源码）

| 判断项 | 结论 | 核实依据 |
|--------|------|----------|
| 门状态挂载层级 | **扩展 `use-preview-collapsed.ts`**（方案 A），Provider context 下传，**不选顶层 state 分散两处** | `use-preview-collapsed.ts` L35-44；`preview-area-provider.tsx` 已在 page-chat L82 + studio-router L74/L112 顶层包裹 |
| 三态→引擎映射 | center→`preview.collapsed=false`；right→`preview.collapsed=true`（现状收起原样）；left→`preview.collapsed=false` + 新增 `chatCollapsed=true` | `layout-width-engine.ts` L190 `pvSetting=collapsed?0:setting`；L219-223 场景B preview 被 CHAT_WIDTH_MIN 钳住 |
| 引擎唯一改动 | 加可选 `chatCollapsed?: boolean`（缺省 false=旧路径逐字段相等，旧 UT 全绿）；仅 4 槽场景B 加前置分支让 middleWidth=0、preview 吞并门框 | `layout-width-engine.ts` L207-226 场景B；L228 `middleWidth=available−left−preview−right` |
| door=right 复用 | **= 现状 `collapsed=true` 路径零改**（section-preview-area L142-144） | `section-preview-area.tsx` L142-144 `ComponentPreviewCollapseToggle collapsed onToggle` |
| 把手复用 | `ComponentPreviewCollapseToggle` 本体零改；center 态渲 2 实例（细线左◀/右▶）、left/right 态各 1 实例 | `component-preview-collapse-toggle.tsx` L39-78（floating/rail 两形态、chevron 由 collapsed 决定） |
| 粗线复用 | `pv-collapsed-rail` 渲染物零改；right 态=现状位置（贴右缘）、left 态=新增「贴左缘」摆放 | `component-preview-collapse-toggle.tsx` L46-48 rail 结构 |
| chat 槽隐藏 | door=left 时 chat 不渲染（middleWidth=0）；**卸载 vs display:none 见 §3 D5 约束** | `page-chat.tsx` L109-117 SectionChatSession；studio-router L119-125 SectionStudioChat |
| 旧 localStorage 迁移 | `pv-collapsed-<sid>='1'`→door=right；'0'/缺省→center（用户无感，PRD §10 授权） | `use-preview-collapsed.ts` L10-28 读写模式 |

## 2. 三态渲染铁律（review 卡这几点）

1. **把手位置**：左把手永贴线左、右把手永贴线右（任何态不得异侧）。
2. **三个不变**：①粗线+把手形态逻辑与现状完全一致（视觉零改）②门框（2+3）总宽位置三态恒定 ③内容不移位（chat 永在门左、preview 永在门右，无跑位无空白）。
3. **状态机**：left↔right 禁直接互跳，必须经 center 中转（UI 只暴露相邻转换入口）。
4. **禁止**：菱形/clip-path/focusMode 三态移位/region-switcher/布局引擎大改。

## 3. 设计决策（D 编号，method 级契约）

### D1: 门三态 hook — use-preview-collapsed.ts（修改）

**文件**：`app/web/src/components/chat-page/use-preview-collapsed.ts`（修改，44 行 → ~70 行）

| 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|-----------|------|---------|------|------|--------|
| `DoorState` | 新增 | `export type DoorState = 'center' \| 'left' \| 'right'` | MUST 导出供 context/消费方复用 | tech-design §3.2 | +3 |
| `doorLsKey` | 新增 | `(sid)=>`pv-door-${sid}`` | MUST per-session key，对齐 pvLsKey 模式 | PRD §3.5 | +3 |
| `readPvDoor` | 新增 | 读 `pv-door-<sid>`；**迁移**：缺省时读旧 `pv-collapsed-<sid>`，`'1'`→`'right'`，否则→`'center'` | MUST 用户无感迁移；坏值兜底 'center' | PRD §3.5/§10 | +12 |
| `writePvDoor` | 新增 | 写 `pv-door-<sid>`；**同步写** `pv-collapsed-<sid>`（door!=='center'→'1'）保旧消费方兼容 | MUST 异常静默（隐私模式） | tech-design §3.2 | +8 |
| `usePreviewCollapsed` | 修改 | 返回扩展 `{ collapsed, setCollapsed, door, setDoor }`；`collapsed` 派生=`door!=='center'`；`setDoor` 含持久化；`setCollapsed(v)` 保留=语义桥接 `setDoor(v?'right':'center')` | MUST `collapsed`/`setCollapsed` 旧签名行为兼容（use-preview-tabs L53/L93 调用零改语义）；MUST setDoor 写 localStorage | tech-design §3.2 | ~25 |

### D2: 引擎 chatCollapsed 分支 — layout-width-engine.ts（修改）

**文件**：`app/web/src/lib/layout-width-engine.ts`（修改，237 行 → ~250 行）

| 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|-----------|------|---------|------|------|--------|
| `ThreeColLayoutInput.chatCollapsed` | 新增 | 可选 `chatCollapsed?: boolean`（缺省 false） | MUST 可选，缺省=旧路径逐字段相等（回归保护） | tech-design §2.2 | +2 |
| `computeThreeColLayout` | 修改 | 仅 4 槽场景B（`dragging===null` 且 `preview!=null`）加前置分支：`chatCollapsed===true` → `previewWidth=available−leftWidth−rightWidth`、`middleWidth=0`、`scrollX=false`、`minRowWidth=leftWidth+previewWidth+rightWidth`（chat 占位 0） | MUST 缺省/undefined 时输出与现状逐字段相等；MUST NOT 改 center/right 既有换算（dragging 三分支 + 场景B 非 chatCollapsed 路径一字不动）；MUST leftWidth/rightWidth 用本帧已换算值 | tech-design §2.2 | +12 |

### D3: 布局 hook 透传 — use-three-col-layout.ts（修改）

**文件**：`app/web/src/components/chat-page/use-three-col-layout.ts`（修改，210 行 → ~220 行）

| 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|-----------|------|---------|------|------|--------|
| `UseThreeColLayoutOpts.chatCollapsed` | 新增 | 可选 `chatCollapsed?: boolean` | MUST 可选，缺省 false | tech-design §4.1 | +2 |
| `useThreeColLayout` | 修改 | 构造引擎输入时透传 `chatCollapsed`；返回新增 `chatRenderWidth: layout.middleWidth`（供 chat 槽隐藏判断） | MUST 其余字段/返回值零改；MUST chatCollapsed 进 computeThreeColLayout 输入 | tech-design §4.1 | +6 |

### D4: 门渲染 + chat 槽隐藏 — section-preview-area.tsx（修改）

**文件**：`app/web/src/components/chat-page/section-preview-area.tsx`（修改，244 行 → ~290 行）

| 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|-----------|------|---------|------|------|--------|
| `SectionPreviewArea`（render） | 修改 | 从 context 读 `door`（`preview?.door ?? 'center'`）；三态分支渲染（见下） | MUST 无 Provider/tabs=0 时仍 `return null`（L133/L137 现状）；MUST 把手位置铁律（左贴左/右贴右） | tech-design §5 | ~40 |
| center 分支 | 修改 | 现状展开分支（L146-167）保留细线 `.pv-resize-left`；**加右把手**：细线右侧贴 1 个 ▶ 把手实例（→`setDoor('right')`）；左把手=现状 L165 floating toggle（→`setDoor('left')`，chevron 朝左） | MUST 细线形态/拖拽零改；MUST 左把手贴细线左、右把手贴细线右 | tech-design §5.1 | +15 |
| right 分支 | 复用 | = 现状 collapsed 分支（L142-144）原样，`onToggle`→`setDoor('center')` | MUST 视觉零改（粗线贴右缘+◀贴左）；MUST edit 态守卫复用现 collapseGuard | tech-design §5.2 | ~3 |
| left 分支 | 新增 | 粗线 `pv-collapsed-rail` 贴**门框左缘**+▶贴粗线右（→`setDoor('center')`）；chat 槽由顶层不渲染 | MUST 复用同一 rail 渲染物（形态零改，仅摆放左缘）；MUST ▶贴粗线右侧 | tech-design §5.3 | +18 |

> **chevron 方向实现（coder 定，落 change_log）**：`ComponentPreviewCollapseToggle` 现 chevron 由 `collapsed`+`floating` 决定（floating→▶，rail→◀）。center 态需「同线两侧一◀一▶」、left 态需 rail 形态但 ▶。coder 优先**不加 prop**，用 `floating`/`collapsed` 组合 + 外层定位凑出方向；若凑不出 → 给组件加**可选** `direction?: 'left'|'right'` prop（覆盖 chevron，默认 undefined=现行为，组件形态零改）。**二选一并汇报 leader**。

### D5: 顶层 chat 槽隐藏 — page-chat.tsx + component-studio-chat-router.tsx（修改）

**文件**：`app/web/src/components/chat-page/page-chat.tsx`（修改）+ `app/web/src/components/studio-page/component-studio-chat-router.tsx`（修改）

| 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|-----------|------|---------|------|------|--------|
| `PageChat` | 修改 | 读 context `door`（`usePreviewArea()`，Provider 在 L82 已包裹）；`chatCollapsed=door==='left'` 传入 `useThreeColLayout`（L74）；`door==='left'` 时 `SectionChatSession`（L109-117）按 D4 方式隐藏 | MUST hooks 规则（useThreeColLayout 在 early return 前）；MUST door 从 context 读非新建 state | tech-design §4.2 | +8 |
| `StudioChatRouterImpl` | 修改 | 同上：`chatCollapsed` 传入 useThreeColLayout（L68）；`door==='left'` 时 `SectionStudioChat`（L119-125）隐藏 | 同上；MUST loading 分支（L83-89）与正常分支一致处理 | tech-design §4.2 | +8 |

> **chat 槽隐藏方式（coder 定，落 change_log）**：优先**条件不渲染**（`door==='left' && null`）；**验证点**：若卸载导致消息流 SSE 重订阅丢消息（PRD §13 要求恢复居中后可见），则改 `display:none` 保留挂载（middleWidth 仍 0）。二选一并汇报 leader。

### D6: Context 字段下传 — preview-area-context.ts + preview-area-provider.tsx + use-preview-tabs.ts（修改）

**文件**：`preview-area-context.ts`（修改）+ `preview-area-provider.tsx`（修改）+ `use-preview-tabs.ts`（修改）

| 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|-----------|------|---------|------|------|--------|
| `PreviewAreaContextValue.door/setDoor` | 新增 | context value 加 `door: DoorState` + `setDoor(v: DoorState): void` | MUST 类型复用 D1 的 DoorState | tech-design §3.3 | +4 |
| `usePreviewTabs` return | 修改 | 从 `usePreviewCollapsed` 解构 `door/setDoor`，加入 return（L276-296）；L53/L93 `setCollapsed(false)` 语义保留（桥接 setDoor('center')，打开文件回居中） | MUST openTab/activateTab 自动回 center 语义不变 | tech-design §3.2 | +4 |
| `PreviewAreaProvider` | 修改 | 从 usePreviewTabs 解构 `door/setDoor` 加入 Provider value | MUST 其余字段透传零改 | tech-design §3.3 | +4 |

### D7: i18n — chat.json（zh-CN + en）（修改）

**文件**：`app/web/src/i18n/locales/zh-CN/chat.json` + `en/chat.json`（修改）

| key | 类型 | zh-CN | en | 影响行 |
|-----|------|-------|-----|--------|
| `workspace.preview.doorLeft` | 新增 | 文档区占满（门滑至左） | Slide door left: focus document | +1+1 |
| `workspace.preview.doorRight` | 新增 | 对话区占满（门滑至右） | Slide door right: focus chat | +1+1 |
| `workspace.preview.doorCenter` | 新增 | 恢复分栏（门回居中） | Restore split view | +1+1 |

> 约束：MUST 复用 `chat` 命名空间，不新增命名空间；MUST 既有 `workspace.preview.collapse`/`expand` 保留。

## 4. 回归保护（review 必查）

| 项 | 保护 |
|----|------|
| 引擎旧路径 | `chatCollapsed` 缺省时 `computeThreeColLayout` 输出与现状逐字段相等；既有 `layout-width-engine.test.ts` 全绿不改断言 |
| 旧 collapsed 消费方 | `collapsed`/`setCollapsed` 签名行为兼容（use-preview-tabs L53/L93 零改语义） |
| academy 无预览区 | 无 Provider → door 缺省 'center' → 无门（PRD §12.11） |
| 旧方案残留 | 代码层 focusMode/菱形/clip-path/region-switcher grep 零残留（未落地到代码） |

## 5. 验证（三层）

- **UT**（MANDATORY）：`use-preview-collapsed` 三态读写 + 迁移；`layout-width-engine` chatCollapsed 分支（middleWidth=0/preview 吞并）+ 缺省回归相等；`section-preview-area` 三态渲染把手位置。
- **AT**：纯前端 UI 改动，无 API 契约变化 → 不新增 AT（test-plan 写明理由）。
- **ET**：UI 改动，默认看一眼 ET——三态切换 + 把手位置 + 持久化恢复（PRD §7 用户路径 1-10）。
