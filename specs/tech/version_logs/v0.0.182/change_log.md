# v0.0.182 change_log — chat/studio 三栏响应式布局引擎（纯前端零后端）

> 跨版本发布说明（版本轴）。位置轴见 `specs/tech/app/frontend/log.md`。method 级 review 合同见 `change_plan.md`。
> 产品依据：`specs/prd/version_logs/v0.0.182/change_log.md`（统一宽度模型 + 相位表 P0~P4 + 双场景语义 + UC-1~8）。
> 验证形态：UT-only（用户裁决豁免 AT/ET——纯前端零 API 契约变更；memory `ui-only-ut-skip-at-et`）。

## 1. 范围（零后端 / 零 API / 零 SSE / 零新依赖）

chat 页（playground 三栏）+ studio 单聊/群聊页（右侧 section-right-tabs）统一三栏响应式规则：侧栏可拖 + 窗口缩窄降级 + 中部保底 ≥480 + 横滚兜底；任何宽度下板块/按钮完整不被裁。`base-chat-page` / `app-shell` / `nav-rail` / `studio-sidebar`（224 固定，裁决 P3）不动。

## 2. 架构要点

### 2.1 纯函数换算引擎（`app/web/src/lib/layout-width-engine.ts`，UT 主战场）

零 React 依赖，输入（available、左右槽位设定宽/收起态、上一帧 L/R/C 渲染宽、dragging 标志）→ 输出（L/R/C 渲染宽 + minRowWidth + scrollX + cDefend）。

- **统一宽度模型**：侧栏渲染宽 = `clamp(静态min, min(设定宽, 动态上限), 静态max)`；解析顺序先 R 后 L（= 降级 右⇒左）；中部不变式 `C = available − L − R ≥ 480`，破 480 → 内行 `min-width = L+480+R` + 页根容器 `overflow-x-auto` 横滚兜底。
- **双场景语义分离**（核心 invariant）：
  - **场景 A 拖拽**（`dragging ≠ null`）：防守基准 = 中部底线 480；被拖栏 dynMax = `available − 对侧Current − 480`；**对侧栏 hold 上一帧渲染宽不动**。
  - **场景 B 窗口缩窄**（`dragging === null`）：防守基准 = `C_defend = clamp(480, middleCurrent, 932)`；解析先 R 后 L（dynR 用左栏静态 clamp 设定宽防循环依赖、dynL 用 R 渲染宽）；侧栏先紧凑化、最大化保中部。
- **相位表 P0~P4 零硬编码**——边界（1424/1384/1344/892；studio 712）全由公式涌现，UT 钉死。
- **宽度常量唯一权威源**（9 个）：`WS_WIDTH_MIN/MAX/DEFAULT` = 232/560/272、`WS_RAIL_WIDTH` = 36、`CONV_WIDTH_MIN/MAX/DEFAULT` = 180/400/220、`MIDDLE_MIN` = 480、`MIDDLE_COMFORT` = 932。前两个从 `component-ws-resize-handle.tsx` 迁入、272/36 从 `workspace-storage.ts` 迁入；`workspace-storage.ts` 改 re-export 保对外 surface 不变。

### 2.2 React 接线（`use-three-col-layout.ts`）

- **available**（页容器 clientWidth）：`useLayoutEffect` 首测 + `ResizeObserver` 续测 + `window resize` fallback（`typeof ResizeObserver !== 'undefined'` 守卫，jsdom 无 RO 走 fallback）。
- **convWidth state**（左栏设定宽）：全局 localStorage key `conv-panel-width`（非 per-session，裁决 P2）。
- **rightReport state**（ws-panel 上报 `{settingWidth, collapsed}`）+ **dragging state**（null=场景 B / `'left'|'right'`=场景 A）+ 三 ref 每帧 effect 回填上一帧渲染宽。
- **derive computeThreeColLayout**（引擎纯函数，无状态——同输入同输出，拉宽自恢复无滞后残留）。
- **页根结构**：外层 scroll 容器（`overflow-x-auto`，挂 containerRef）+ 内行 `flex h-full w-full` + `style={{minWidth: rowMinWidth}}`；studio router 补 `min-w-0`（现状缺失是挤压根因之一）。

### 2.3 ws-panel 「状态在下、算术在上」

ws-panel 宽度 state + per-session 持久化（`ws-width-<sid>` / `ws-collapsed-<sid>`）**仍自管**；父引擎经 `renderWidth` prop clamp 渲染宽、`onLayoutChange` 回收设定宽、`onDragModeChange` 切场景 A。SectionWorkspacePanel 加 4 可选 props（`renderWidth / dragMaxWidth / onLayoutChange / onDragModeChange`），全可选（既有 UT/studio 消费零破坏）。

### 2.4 通用拖拽手柄（`component-col-resize-handle.tsx`）

delta 算法消除「脱手」死区：mousedown 捕获 `startRef={startX, startWidth=currentWidth}`（mid-drag 不重捕获）；mousemove 算 `dx = e.clientX − startX`、`raw = side==='right' ? startWidth−dx : startWidth+dx`，clamp 到 `[minWidth, maxWidth]` → onResize；mouseup 恢复 cursor/userSelect + onResizeEnd。到边界后反向拖立即响应（无死区）。视觉复用 `.ws-resize` 模式：6px 手柄贴栏缘（`side='right'`→左缘 / `'left'`→右缘）+ hover accent 1px 竖线 + body cursor/userSelect 锁定。

`component-ws-resize-handle.tsx` 改薄 wrapper：保 testid `ws-resize` + i18n `workspace.resize.*`（ET 锚点不变）。conv-panel 右缘挂同款手柄（**不带 testid**——用户裁决 2026-07-20；i18n 走 `convPanel.resize.*` 双语）。

## 3. 改动清单（method 级，详见 `change_plan.md` §3）

| 模块 | 文件 | 操作 | 关键约束 |
|---|---|---|---|
| layout-engine | `app/web/src/lib/layout-width-engine.ts` + `__tests__/layout-width-engine.test.ts` | NEW | 9 常量唯一权威源 + 4 纯函数（clampMiddleDefend/clampSidebar/dragDynMax/computeThreeColLayout）+ UT 15 case 覆盖相位边界/拖拽 hold/C_defend/collapsed/studio 槽位组合 |
| layout-hook | `app/web/src/components/chat-page/use-three-col-layout.ts` | NEW | `useThreeColLayout({hasLeft, rightPresent})` 返回 12 字段；RO 守卫；dragMax 用 dragDynMax 同源 |
| resize-handle | `app/web/src/components/chat-page/component-col-resize-handle.tsx` | NEW | delta 算法无死区；i18n 由调用方注入（本组件不 useTranslation）；testid 可选 |
| resize-handle | `app/web/src/components/chat-page/component-ws-resize-handle.tsx` | MODIFY | 改薄 wrapper；保 testid ws-resize + i18n key |
| ws-panel | `app/web/src/components/chat-page/workspace-storage.ts` | MODIFY | 常量 import 源切引擎 + re-export；对外 surface 不变 |
| ws-panel | `app/web/src/components/chat-page/use-workspace-event-effect.ts` | NEW | 从 section-workspace-panel 抽出 lastWorkspaceEvent effect（panel ≤300 行硬约束） |
| ws-panel | `app/web/src/components/chat-page/section-workspace-panel.tsx` | MODIFY | 加 4 props + report effect + aside width 受控 + 手柄接线；保全部 ws-* testid |
| conv-panel | `app/web/src/components/chat-page/section-conv-panel.tsx` | MODIFY | 去 `w-[220px]` + 5 可选 props + 右缘手柄挂载（仅 onConvResize 注入时渲染） |
| page 接线 | `app/web/src/components/chat-page/page-chat.tsx` | MODIFY | 接 useThreeColLayout + 根 scroll 容器结构 + 三栏接线 |
| studio | `app/web/src/components/studio-page/section-right-tabs.tsx` | MODIFY | 加 4 可选 props 原样透传 |
| studio | `app/web/src/components/studio-page/component-studio-chat-router.tsx` | MODIFY | 接 useThreeColLayout + 两分支根 scroll 容器 + 补 min-w-0 |
| i18n | `app/web/src/i18n/locales/{zh-CN,en}/chat.json` | MODIFY | 加 `convPanel.resize.ariaLabel / title`（双语对齐） |

## 4. 横滚兜底触发点（doc-modifier 修正：PRD §5 数字偏差）

- **chat 页**：`W < 56+180+480+232 = 948`（右栏收起时 752 = 56+180+480+36）。
- **studio 页**：`W < 56+224+480+232 = 992`（右栏收起时 **796** = 56+224+480+36；**原 PRD 写 808 为算术误差，已修正**）。
- 引擎不硬编码触发点、由公式涌现（PRD §5 开放点 1）。

## 5. spec 同步

- **tech KB（OKF）**：`specs/tech/app/frontend/[P0]component_architecture.md` 新增 §3.13（三栏响应式布局引擎设计原则）+ `index.md` 概念行 + `log.md` v0.0.182 倒序条目 + frontmatter `updated: 2026-07-20`。
- **UI 组件 spec 三份**（coder 编码前置更新）：`chat-page/_overview.md §4.1`（conv-panel 可拖）+ `chat-page/component-workspace-panel.md §2/§4.2`（拖宽算法升级）+ `studio-page/section-right-tabs.md §3/§5/§6/§8`（透传 + router 接线）。
- **prd / ui version_logs**：`specs/prd/version_logs/v0.0.182/change_log.md`（§5 修正 808→796）+ `specs/ui/version_logs/v0.0.182/change_log.md`（UI 变更总账 + testid 增删 + i18n key 增删）。
- **api**：零变更。

## 6. 验证（UT-only）

- `app/web/src/lib/__tests__/layout-width-engine.test.ts` 15 case 覆盖：P0~P4 相位边界 + 拖拽 hold（含 collapsed 收起态）+ C_defend clamp + 拉宽自恢复 + studio 槽位（left=null）+ chat 无右栏（right=null）+ clampSidebar 静态界 + readConvWidth 兜底。
- `bun run typecheck` + `bun run test` 全绿。
- 用户裁决豁免 AT/ET（纯前端无 API 契约变更；memory `ui-only-ut-skip-at-et`）。
