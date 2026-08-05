# v0.0.182 变更计划书 — chat/studio 三栏响应式布局修复

> method 级 review 合同（架构期冻结）。planner 按它切 task，coder 按它实现，reviewer 按它查偏离。
> 产品依据：`specs/prd/version_logs/v0.0.182/change_log.md`（统一宽度模型 + 相位表 P0~P4 + 双场景语义 + UC-1~8）。
> 纯前端布局改动：零后端 / 零 API / 零 SSE / 零新依赖。验证倾向 UT-only（test-plan 阶段请用户确认）。

## 1. 架构要点

### 1.1 统一宽度换算引擎（纯函数，零 React，UT 主战场）

新文件 `app/web/src/lib/layout-width-engine.ts`：

```ts
// 输入（available = 页容器 clientWidth，已不含 nav-rail；studio 场景也不含 224 sidebar——它是容器外兄弟）
interface ThreeColLayoutInput {
  available: number;
  left: { setting: number } | null;                    // chat: conv-panel；studio: null
  right: { setting: number; collapsed: boolean } | null; // chat 无 active session 时 null
  middleCurrent: number;   // 上一帧中部渲染宽（C_defend 数据源；初值 932）
  leftCurrent: number;     // 上一帧左栏渲染宽（拖拽时 hold 用）
  rightCurrent: number;    // 上一帧右栏渲染宽（拖拽时 hold 用）
  dragging: 'left' | 'right' | null;  // 非 null = 场景 A（拖拽）；null = 场景 B（缩窄）
}
// 输出
interface ThreeColLayoutResult {
  leftWidth: number; rightWidth: number; middleWidth: number;
  minRowWidth: number;  // = leftWidth + 480 + rightWidth（内行 min-width）
  scrollX: boolean;     // available < minRowWidth
  cDefend: number;      // 本帧防守宽（UT 断言锚点）
}
```

- 渲染宽 = `clamp(静态min, min(设定宽, 动态上限), 静态max)`；解析顺序**先 R 后 L**（降级 右⇒左）。
- 场景 A（dragging≠null）：防守基准 480；被拖栏 dynMax = `available − 对侧Current − 480`；**对侧栏保持上一帧渲染宽（*Current）不动**。
- 场景 B（dragging=null）：`C_defend = clamp(480, middleCurrent, 932)`；dynR 用左栏**静态 clamp 设定宽**、dynL 用 R 渲染宽（相位表由此涌现）。
- scrollX：`middleWidth < 480` → middle 定 480 + scrollX=true；绝不突破 480。
- 相位表 P0~P4 **零硬编码**——边界（avail 1424/1384/1344/892；studio 712）全由公式涌现，UT 钉死。

### 1.2 React 接线

- **新 hook `useThreeColLayout`**（`chat-page/use-three-col-layout.ts`）：`available`（useLayoutEffect 首测 + ResizeObserver，`typeof ResizeObserver` 守卫 + window resize fallback）+ `convWidth` state（localStorage 全局 key `conv-panel-width`，默认 220）+ `rightReport` state（ws-panel 上报 `{settingWidth, collapsed}`）+ `dragging` state + 三 ref（effect 每帧回填上一帧 L/R/C 渲染宽）。
- **page-chat / StudioChatRouter 根结构**：外层 scroll 容器（`h-full min-h-0 overflow-x-auto`，挂 containerRef）+ 内行 `flex h-full min-h-0 w-full` + `style={{minWidth: minRowWidth}}`。三栏 children 不变（L 固定宽 + 中 flex-1 min-w-0 + R 固定宽）。router 根补 `min-w-0`（现状缺失 = 挤压根因之一）。
- **SectionWorkspacePanel**：加 4 可选 props（`renderWidth/dragMaxWidth/onLayoutChange/onDragModeChange`）——宽度 state 仍自管（= 设定宽 + per-session 持久化），渲染宽被父引擎 clamp。
- **SectionConvPanel**：去 `w-[220px]` 改 style width 受控 + `relative` + 右缘挂通用拖拽手柄（testid `conv-resize`）。
- **通用拖拽手柄 `ComponentColResizeHandle`**（新）：delta 算法（mousedown 捕获 startWidth+startX，raw = start ± Δ，clamp 到动态上限）——到边界反向立即响应，无死区；`ComponentWsResizeHandle` 改薄 wrapper（保 testid `ws-resize` + i18n `workspace.resize.*`）。
- **不动**：base-chat-page / app-shell / nav-rail / ws-panel 内部功能（tab/文件树/切目录/懒监听）/ studio-sidebar（224 固定，P3）。

### 1.3 横滚兜底

页根外层容器 `overflow-x-auto`；内行 min-width = minRowWidth（chat 展开 892 / 收起 696；studio 展开 712 / 收起 516）。app-shell `overflow-hidden` 不变，滚动发生在页容器层。

### 1.4 组件 spec 清单（coder 编码前置更新，spec-before-implement）

| spec | 操作 | 内容 |
|------|------|------|
| `specs/ui/components/chat-page/_overview.md` §4.1 | 修改 | conv-panel 可拖契约（180~400 默认 220、全局 key `conv-panel-width`、右缘手柄 testid `conv-resize`、去 220 固定宽） |
| `specs/ui/components/chat-page/component-workspace-panel.md` §4.2 + §2 resize-handle 行 | 修改 | 拖宽算法升级（delta + 场景 A 动态上限 + 无死区）+ 手柄 props 契约 |
| `specs/ui/components/studio-page/section-right-tabs.md` §3/§5/§6 | 修改 | 4 透传 props + router scroll 容器结构 |

## 2. 文件级变更清单

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/web/src/lib/layout-width-engine.ts` | 新增 | 宽度常量组 + 类型组 + clampMiddleDefend/clampSidebar/dragDynMax/computeThreeColLayout（~130 行） |
| `app/web/src/lib/__tests__/layout-width-engine.test.ts` | 新增 | 相位边界 + 拖拽 hold + C_defend + collapsed + studio/chat 槽位组合 UT（~120 行） |
| `app/web/src/components/chat-page/use-three-col-layout.ts` | 新增 | useThreeColLayout hook + conv 宽度 localStorage 辅助（~170 行） |
| `app/web/src/components/chat-page/component-col-resize-handle.tsx` | 新增 | 通用拖拽手柄（side/currentWidth/min/max + delta 算法，~85 行） |
| `app/web/src/components/chat-page/component-ws-resize-handle.tsx` | 修改 | 改薄 wrapper（~40 行）；删旧 innerWidth−clientX 算法 + WS_WIDTH_MIN/MAX 常量（迁引擎） |
| `app/web/src/components/chat-page/workspace-storage.ts` | 修改 | 常量 import 源切换引擎 + re-export（对外 surface 不变） |
| `app/web/src/components/chat-page/use-workspace-event-effect.ts` | 新增 | 从 section-workspace-panel 抽出 lastWorkspaceEvent effect（~30 行；panel 保 ≤300 行硬约束） |
| `app/web/src/components/chat-page/section-workspace-panel.tsx` | 修改 | 加 4 props + report effect + aside width 受控 + 手柄接线（295→~286 行） |
| `app/web/src/components/chat-page/section-conv-panel.tsx` | 修改 | 去 220 固定宽 + 5 可选 props + 右缘手柄挂载 |
| `app/web/src/components/chat-page/page-chat.tsx` | 修改 | 接 useThreeColLayout + 根 scroll 容器结构 + 三栏接线 |
| `app/web/src/components/studio-page/section-right-tabs.tsx` | 修改 | 4 可选 props 透传 SectionWorkspacePanel |
| `app/web/src/components/studio-page/component-studio-chat-router.tsx` | 修改 | 接 useThreeColLayout（left=null）+ 两分支根 scroll 容器 + 补 min-w-0 |
| `app/web/src/i18n/locales/zh-CN/chat.json` | 修改 | convPanel.resize.{ariaLabel,title} 新增 |
| `app/web/src/i18n/locales/en/chat.json` | 修改 | 同上（keys-aligned.test 门禁） |

## 3. method 级变更契约

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 预计影响行 |
|---|---|---|---|---|---|---|---|
| layout-engine | app/web/src/lib/layout-width-engine.ts | 宽度常量组（WS_WIDTH_MIN/MAX/DEFAULT、WS_RAIL_WIDTH、CONV_WIDTH_MIN/MAX/DEFAULT、MIDDLE_MIN、MIDDLE_COMFORT） | 新增 | 9 常量唯一权威源：232/560/272/36/180/400/220/480/932（前 2 个从 component-ws-resize-handle 迁入，272/36 从 workspace-storage 迁入） | MUST 数值与 PRD §2.1 槽位表一致；MUST NOT 分散定义 | PRD §2.1/§2.2 | +12 |
| layout-engine | app/web/src/lib/layout-width-engine.ts | 类型组（DragSide、SidebarSlotInput、ThreeColLayoutInput、ThreeColLayoutResult） | 新增 | 引擎输入/输出契约（签名见 §1.1） | 零 React 依赖，纯 type | PRD §2.2；arch §1.1 | +20 |
| layout-engine | app/web/src/lib/layout-width-engine.ts | clampMiddleDefend() | 新增 | `clamp(480, middleCurrent, 932)` | 纯函数；middleCurrent≤480 → 480，≥932 → 932 | PRD §2.2 场景 B | +5 |
| layout-engine | app/web/src/lib/layout-width-engine.ts | clampSidebar() | 新增 | `max(min, min(max, min(setting, dynMax)))`；side=left→[180,400]、right→[232,560] | 静态 min 永远赢过 dynMax（宁挤中部/横滚不破侧栏下限…下限之上才守中部） | PRD §2.2 | +6 |
| layout-engine | app/web/src/lib/layout-width-engine.ts | dragDynMax() | 新增 | `available − otherWidth − 480`（场景 A 动态上限唯一公式，供引擎与手柄 props 同源） | MUST 与引擎内部计算同源，禁第二份公式 | PRD §2.2 场景 A | +4 |
| layout-engine | app/web/src/lib/layout-width-engine.ts | computeThreeColLayout() | 新增 | 主解析：cDefend=dragging?480:clampMiddleDefend(middleCurrent)；先 R 后 L；dragging='right' 时 L=leftCurrent hold（对称 left）；right.collapsed→36；middle<480→middle=480+scrollX+minRowWidth=L+480+R | MUST NOT 硬编码相位边界（P0~P4 由公式涌现）；MUST 输出 cDefend 供 UT 断言 | PRD §2.2/§2.3/§2.4/§3.4 | +45 |
| layout-hook | app/web/src/components/chat-page/use-three-col-layout.ts | CONV_WIDTH_LS_KEY + readConvWidth()/writeConvWidth() | 新增 | 全局 localStorage `conv-panel-width`：读 clamp[180,400] 缺省 220；写 try/catch | 模式对齐 workspace-storage.ts（全局 key 非 per-session，裁决 P2） | PRD §3.3 | +20 |
| layout-hook | app/web/src/components/chat-page/use-three-col-layout.ts | useThreeColLayout() | 新增 | 主 hook：available（useLayoutEffect 首测 clientWidth + ResizeObserver 续测 + window resize fallback）+ convWidth/rightReport/dragging state + 三 ref 每帧 effect 回填 + derive computeThreeColLayout；返回 { containerRef, rowMinWidth, layout, convWidth, handleConvResize, handleConvResizeEnd, convDragMaxWidth, reportRightPanel, rightRenderWidth, rightDragMaxWidth, setDragging } | MUST 守卫 `typeof ResizeObserver !== 'undefined'`（jsdom 无 RO，fallback window resize）；MUST NOT 节流外的额外 state；dragMax 用 dragDynMax 同源 | PRD §2/§3；arch §1.2 | +130 |
| resize-handle | app/web/src/components/chat-page/component-col-resize-handle.tsx | ColResizeHandleProps | 新增 | props：side/currentWidth/minWidth/maxWidth/onResize/onDragStart?/onResizeEnd?/testid/ariaLabel/title | i18n 文案由调用方注入（本组件不 useTranslation） | PRD §3.1 | +15 |
| resize-handle | app/web/src/components/chat-page/component-col-resize-handle.tsx | ComponentColResizeHandle | 新增 | delta 算法：mousedown 捕获 startRef{startX, startWidth=currentWidthRef.current} + onDragStart；mousemove raw = side==='right' ? start−dx : start+dx → clamp[minWidth,maxWidth] → onResize；mouseup 恢复 cursor/userSelect + onResizeEnd。视觉复用 .ws-resize 模式：6px 手柄贴栏缘（right→左缘 / left→右缘）+ hover accent 1px 竖线 + body cursor/userSelect 锁定 | MUST 边界后反向立即响应（startRef 仅 mousedown 捕获，mid-drag 不重捕获）；MUST NOT 用 innerWidth−clientX 旧绝对算法 | PRD §3.1/§3.2；§6.2 视觉基线 | +70 |
| resize-handle | app/web/src/components/chat-page/component-ws-resize-handle.tsx | ComponentWsResizeHandle | 修改 | 改薄 wrapper：渲染 ComponentColResizeHandle（side=right、minWidth=WS_WIDTH_MIN、maxWidth=min(WS_WIDTH_MAX, maxWidth??WS_WIDTH_MAX)、testid=ws-resize、aria/title=t('workspace.resize.*')）；props 加 currentWidth/maxWidth?/onDragStart? | MUST 保 testid `ws-resize` + i18n key 不变（ET 锚点） | PRD §3.1；component-workspace-panel.md §6.2 | +30/−45 |
| resize-handle | app/web/src/components/chat-page/component-ws-resize-handle.tsx | WS_WIDTH_MIN / WS_WIDTH_MAX | 删除 | 常量迁引擎（已 grep 确认外部 importer 仅 workspace-storage.ts，同步改 import） | 无 re-export 残留（arch 原则#2 无死代码） | arch §1.1 | −3 |
| ws-panel | app/web/src/components/chat-page/workspace-storage.ts | 常量 import 源 + re-export | 修改 | WS_WIDTH_MIN/MAX import 改自 `../../lib/layout-width-engine`；WS_WIDTH_DEFAULT/WS_RAIL_WIDTH 删本地定义改 re-export 引擎 | 对外 surface 不变（section-workspace-panel 仍由此 import WS_RAIL_WIDTH）；readWsWidth clamp 行为不变 | arch §1.1 | +4/−4 |
| ws-panel | app/web/src/components/chat-page/use-workspace-event-effect.ts | useWorkspaceEventEffect() | 新增 | 从 section-workspace-panel 抽出 lastWorkspaceEvent 订阅 effect（file-changed / dir-changed + watchPath('') + dir_changed 兜底 GET tree + tree-loaded dispatch），行为 100% 平移 | 抽出理由 = panel ≤300 行硬约束（295+新增会超限）；MUST NOT 改事件语义 | CLAUDE.md 文件体量；panel 现状 215-238 行 | +30 |
| ws-panel | app/web/src/components/chat-page/section-workspace-panel.tsx | SectionWorkspacePanelProps | 修改 | 加 4 可选 props：renderWidth?/dragMaxWidth?/onLayoutChange?/onDragModeChange? | 全可选（既有 UT/studio 消费零破坏） | arch §1.2 | +8 |
| ws-panel | app/web/src/components/chat-page/section-workspace-panel.tsx | report effect | 新增 | `useEffect([width, collapsed])` → `onLayoutChange?.({settingWidth: width, collapsed})` | 仅值变化时上报；切 session 不重报（width 不变，与现状 quirk 一致，见 §5 开放点 2） | arch §1.2 | +5 |
| ws-panel | app/web/src/components/chat-page/section-workspace-panel.tsx | 展开态 aside + 手柄接线 + lastWorkspaceEvent effect 抽离 | 修改 | aside `style={{width: renderWidth ?? width}}`；手柄传 currentWidth=renderWidth??width / maxWidth=dragMaxWidth / onDragStart→onDragModeChange?.(true)；onResizeEnd 包 persistWidth+onDragModeChange?.(false)；lastWorkspaceEvent effect 迁出（见上行新文件） | collapsed rail 分支不动（仍 WS_RAIL_WIDTH）；MUST 保全部 ws-* testid | PRD §3.4/§4 | +8/−30 |
| conv-panel | app/web/src/components/chat-page/section-conv-panel.tsx | ConvPanelProps | 修改 | 加 5 可选 props：renderWidth?/dragMaxWidth?/onConvResize?/onConvDragStart?/onConvResizeEnd? | 全可选（既有 UT 零破坏） | arch §1.2 | +10 |
| conv-panel | app/web/src/components/chat-page/section-conv-panel.tsx | aside 根 + 手柄挂载 | 修改 | 去 `w-[220px]` → `style={{width: renderWidth ?? CONV_WIDTH_DEFAULT}}` + class 加 `relative`；右缘挂 ComponentColResizeHandle（side=left、testid=conv-resize、min=180、max=min(400,dragMaxWidth??400)、i18n convPanel.resize.*），仅 onConvResize 存在时渲染 | MUST 保 conv-panel/conv-new-btn/conv-list/conv-context-menu* testid 不动 | PRD §3.1/§3.3 | +16/−1 |
| page 接线 | app/web/src/components/chat-page/page-chat.tsx | PageChat 根结构 | 修改 | 根 `<div className="flex h-full min-h-0">` → 外层 scroll 容器 `<div ref={containerRef} className="h-full min-h-0 overflow-x-auto">` + 内行 `<div className="flex h-full min-h-0 w-full" style={{minWidth: rowMinWidth}}>` | 外层无 testid（保持现状，chat-page testid 在 SectionChatDetail）；MUST NOT 动 SectionChatDetail props 链 | PRD §2.4；arch §1.2 | +10/−3 |
| page 接线 | app/web/src/components/chat-page/page-chat.tsx | useThreeColLayout 接线 + 三栏 props | 修改 | `useThreeColLayout({hasLeft:true, rightPresent:!!activeSessionId})`；SectionConvPanel 传 renderWidth+4 拖拽回调（onConvResize=handleConvResize / onConvDragStart=setDragging('left') / onConvResizeEnd=persist+setDragging(null)）；SectionWorkspacePanel 传 renderWidth/dragMaxWidth/onLayoutChange=reportRightPanel/onDragModeChange | rightPresent=false 时 ws panel 不挂载（现状保留）；viewedSessionId 等既有逻辑零改 | arch §1.2 | +18/−2 |
| studio | app/web/src/components/studio-page/section-right-tabs.tsx | SectionRightTabsProps + 透传 | 修改 | 加 4 可选 props（renderWidth/dragMaxWidth/onLayoutChange/onDragModeChange）原样透传 SectionWorkspacePanel | wrapper aside `flex shrink-0 min-w-0` + testid squad-right-tabs + data-workspace-semantic 不动 | section-right-tabs.md §3/§5 | +12/−2 |
| studio | app/web/src/components/studio-page/component-studio-chat-router.tsx | useThreeColLayout + 两分支根结构 | 修改 | hook({hasLeft:false, rightPresent:true})；loading 分支 + 正常分支根 `<div className="flex flex-1 min-h-0">` → 外层 `<div ref className="flex-1 min-w-0 min-h-0 overflow-x-auto">` + 内行 `flex h-full w-full` + minWidth；SectionRightTabs 传 4 props | MUST 补 `min-w-0`（现状缺失 = 挤压根因）；chatPage `key={node.sessionId}` remount 语义不动；hook 在 early return 前调用（hooks 规则） | PRD §5；arch §1.2 | +16/−6 |
| i18n | app/web/src/i18n/locales/zh-CN/chat.json | convPanel.resize.ariaLabel / convPanel.resize.title | 新增 | 「拖拽调整会话列表宽度」/「拖拽调整宽度」（coder 可微调措辞） | MUST 双语同步（keys-aligned.test 门禁；t() 渲染禁 defaultValue） | memory i18n-key-add-checklist | +3 |
| i18n | app/web/src/i18n/locales/en/chat.json | convPanel.resize.ariaLabel / convPanel.resize.title | 新增 | "Resize session list" / "Drag to resize" | 同上 | 同上 | +3 |
| UT | app/web/src/lib/__tests__/layout-width-engine.test.ts | 引擎 UT 套件 | 新增 | 见 §4 清单（纯函数断言，零 DOM） | MUST 覆盖全部相位边界值 + 双场景语义 | PRD §2.3/§7 UC-1~8 | +120 |

## 4. UT 覆盖计划（layout-width-engine.test.ts，验证主力）

| # | 用例 | 输入要点 → 断言 |
|---|------|----------------|
| 1 | P0 宽裕边界 | avail=1424, 设定 220/272, middleCurrent=1500 → L=220/R=272/middle=932/scrollX=false/cDefend=932 |
| 2 | P1 右栏降级 | avail=1400 → R=248（272→232 连续）、L=220、middle=932 |
| 3 | P1→P2 边界 | avail=1384 → R=232 触底、L=220 |
| 4 | P2 左栏降级 | avail=1364 → R=232、L=200、middle=932；avail=1344 → L=180 触底 |
| 5 | P3 中部降级 | avail=1000 → L=180/R=232/middle=588 |
| 6 | P4 横滚边界 | avail=892 → middle=480 恰好不 scroll；avail=891 → scrollX=true、minRowWidth=892、middle=480 |
| 7 | 拖右栏 hold 左栏 | dragging='right', leftCurrent=220, 设定 R=400 → L=220 不动、R=min(400, dragDynMax)、middle=avail−220−R |
| 8 | 拖左栏 hold 右栏（含收起态） | dragging='left', rightCurrent=36（collapsed）→ R=36 不动、dynL=avail−36−480 |
| 9 | C_defend clamp | middleCurrent=700→cDefend=700；=1500→932；=300→480 |
| 10 | 拖拽压过 932 后缩窄防守当前宽 | middleCurrent=700, avail 缩 → 侧栏先触底、middle 守 700 直到双触底 |
| 11 | 拉宽自恢复（无状态公式） | 窄→宽同输入 → 输出 = 宽态输出（无滞后残留） |
| 12 | studio 槽位（left=null） | avail=712 → middle=480 不 scroll；avail=711 → scrollX、minRowWidth=712；collapsed → R=36、minRowWidth=516 |
| 13 | chat 无右栏（right=null） | middle=avail−L；无 scroll 概念直到 L+480 触底 |
| 14 | clampSidebar 静态界 | setting=999→560（right）/400（left）；setting=100→232/180；dynMax<min → min 赢 |
| 15 | readConvWidth | 缺省 220 / 非法值 220 / 越界 clamp[180,400]（可选，放 hook 文件同级 UT 或并入本文件 import） |

## 5. 偏差 / 开放点

1. **PRD §5 数字偏差**：studio 右栏收起横滚点 PRD 写 808，按槽位常量推导 = 56+224+480+36 = **796**（容器内 avail < 516 触发）。引擎不硬编码该值、由公式涌现，实现落地 796；doc-modifier 阶段修 PRD §5 数字（不改公式语义）。
2. **既有 quirk（本版本不改，行为与现状一致）**：SectionWorkspacePanel 的 width/collapsed `useReducer` 仅 mount 时按 sessionId init（page-chat 无 key remount），切 session 时内存宽不切、持久化写永远落当前 session key。PRD 未提及，如需修复另立版本。
3. **PRD §10 待核对项（已核实）**：studio 三栏 DOM = page-studio 根（`flex h-full min-h-0`）→ StudioSidebar（`w-56`=224，`shrink-0`，router 容器**外兄弟**）+ StudioChatRouter 根（`flex flex-1 min-h-0`，内包 chatPage=BaseChatPage `flex-1 min-w-0` + SectionRightTabs）。故 studio 布局上下文 = 中+右两槽（引擎 left=null）；router 根缺 `min-w-0` 是挤压根因之一，本版本补上。
4. **验证路线**：纯前端布局、零 API/落库变更 → 倾向 UT-only 豁免 AT/ET（memory `ui-only-ut-skip-at-et`），test-plan 阶段请用户确认。新 testid 仅 `conv-resize`；`ws-resize`/`ws-panel`/`conv-panel`/`squad-right-tabs` 等锚点全保留。
5. **首帧 available=0**（jsdom / 未测量）：引擎 clamp 到静态下限（L=180/R=232），useLayoutEffect 首测后同帧校正（浏览器 paint 前），无可见闪烁；既有 jsdom 组件 UT 不断言宽度，零破坏（已 grep 确认）。
6. **tech spec 同步**：本版本由 architect 在 `specs/tech/app/frontend/[P0]component_architecture.md` 新增 §3.13（三栏响应式布局引擎设计原则）+ log.md 条目 + frontmatter updated；UI 组件 spec 三份由 coder 编码前置更新（§1.4 清单）；doc-modifier 阶段 5 终验 code↔spec 一致。
