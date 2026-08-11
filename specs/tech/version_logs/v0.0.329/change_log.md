# v0.0.329 tech change log — 区域2/3 门模型（三态 center/left/right）

> 对应需求：`specs/prd/version_logs/v0.0.329-region23-door.md`。
> 权威契约：`specs/tech/version_logs/v0.0.329/change_plan.md`（D1-D7 method 级契约，frozen）。
> 技术设计：`specs/tech/version_logs/v0.0.329/tech-design-door.md`。

## 变更摘要

### 需求与动机

预览区（v0.0.320 引入）只有「展开/收起」二态（收起=preview 被遮、chat 占满），老板需要**门三态**：
- **center**（默认）：2/3 共存（chat | preview 各自宽），现状路径
- **right**：门滑最右，preview 被遮、chat 占满门框（= 旧 collapsed=true 路径，复用现状收起）
- **left**：门滑最左，chat 被遮、preview 占满门框（新增 chatCollapsed 引擎分支）

### 方案（D1-D7 实现）

1. **三态 hook（D1）**：`use-preview-collapsed.ts` 重写——新增 `DoorState = 'center'|'left'|'right'`、`readPvDoor`/`writePvDoor`（localStorage `pv-door-<sid>`）；**旧 `pv-collapsed-<sid>` 迁移**：pv-door 缺省时读旧 key，'1'→'right'，坏值兜底 center；写入时同步旧 key（door!=='center'→'1'）保旧消费方兼容。`collapsed` 派生 = door!=='center'；`setCollapsed(v)` 桥接 `setDoor(v?'right':'center')`——**旧 collapsed 消费方零改**。
2. **引擎扩展（D2）**：`layout-width-engine.ts` `ThreeColLayoutInput` 加可选 `chatCollapsed?: boolean`（缺省=undefined → 旧路径逐字段相等，旧 UT 全绿回归保护）。door=left（场景 B）分支：**先走 4 槽场景 B 完整换算**（R→preview→L，防守链与缺省路径一字不差——左右槽位置/门框总宽不动，PRD 三个不变②），再门态重分配：chat(middle) 置 0、preview 吞并门框剩余全部（不被 CHAT_WIDTH_MIN 钳）、scrollX=false（显式门态非宽度不足）。场景 A 拖拽不受影响（chatCollapsed 仅场景 B 生效）。
3. **布局 hook 透传（D3）**：`use-three-col-layout.ts` 加 `chatCollapsed?: boolean` 输入透传 + 返回 `chatRenderWidth: layout.middleWidth`。
4. **三态渲染（D4）**：`section-preview-area.tsx`——door 从 context 读（`preview?.door ?? 'center'`）；onLayoutChange 上报 `collapsed: door==='right'`（left/center 均 false）：
   - **right 态**：`ComponentPreviewCollapseToggle collapsed={true}` 原样（粗线 rail + ◀贴左回居中，现状零改）
   - **left 态**：粗线 rail（`pv-collapsed-rail` 形态零改）+ ▶贴粗线右（direction='right'）+ aside 无 border-l、无 resizer（门滑到边后不可拖拽调宽，PRD §13）
   - **center 态**：aside 内双把手——左 ◀（direction='left'，→`setDoor('left')`）+ 右 ▶（direction='right'，→`handleCollapseClick` 走 edit 守卫）
5. **消费方顶层隐藏（D5）**：`page-chat.tsx` 重构为 PageChat（store/actions）+ PreviewAreaProvider + PageChatRow（读 door，`chatCollapsed=door==='left'` 传 useThreeColLayout，`!chatCollapsed && <SectionChatSession/>`）；`component-studio-chat-router.tsx` 同构重构为 StudioChatRouterImpl + StudioChatRow。类型用 `./types`（Session/ChildrenView）。
6. **Context 下传（D6）**：`preview-area-context.ts` value 加 `door/setDoor`；`use-preview-tabs.ts` 解构透传；`preview-area-provider.tsx` 接线。
7. **i18n（D7）**：zh-CN/en chat.json 加 `workspace.preview.doorLeft/doorRight/doorCenter`。

### 两个 coder 二选一决策（change_plan §3，落档 + 已报 leader）

1. **chevron 方向：加可选 `direction?: 'left'|'right'` prop**（`component-preview-collapse-toggle.tsx`）。
   凑不出理由：center 态需「同线两侧一◀一▶」——floating 形态 chevron 固定 ▶（贴线左），rail 形态固定 ◀；「细线左◀」（floating 但朝左）与「粗线右▶」（rail 但朝右）两组组合现有 floating/collapsed 凑不出 → 加 prop 显式覆盖。组件形态零改（尺寸/hover/rail 结构不动），仅 chevron 方向 + 贴线侧由 prop 决定：'right'→▶+贴线右（floating→left-0 / rail→-right-[8px]）、'left'→◀+贴线左（-left-[8px]，现行为；贴线偏移=handle 宽 8px 同步）。缺省 undefined = 现行为。
   另加可选 `tooltipKey`（door 三态 tooltip）与 `testid`（center 双把手锚点区分，缺省现行为）prop。
2. **chat 槽隐藏：条件不渲染**（`door==='left' && null`，middleWidth 仍 0）。
   实测验证（worktree dev 8793）：left 态 chat 消息 DOM 完全消失（`chatMsgInDom=false`）；回 center 后消息完整恢复（SSE 重拉不丢，PRD §13「恢复居中后可见」成立）→ 无需 display:none。**条件不渲染为最终方案**。

### code-review 补修记录（CONDITIONAL PASS → 已修）

1. **Major 1（已修）**：`section-preview-area.tsx` 抽公共渲染函数 `renderPanelBody`（TabBar + pv-content 内容区 + FloatingActions）与 `renderModals`（dirty/conflict modal），left/center 两分支共用，DOM 结构零变化（testid 全保留）。文件 335 行 → **290 行**（≤300 硬线达标）。
2. **Minor 2（裁决：保留接口+补记）**：D3 契约 `chatRenderWidth`（=`layout.middleWidth`）当前**零消费方**——实现实际用 `chatCollapsed` 布尔判断（引擎已由 door 态驱动）。**保留接口**（引擎契约完整性），待后续消费方（如 chat 宽度感知 UI）接入。
3. **Minor 3（裁决：不修）**：left 态 `collapsed={true}` 语义轻微混淆（left 态 preview 实际显示、但上报 collapsed=true 因 onLayoutChange 契约），可接受。

### 边界与铁律落实情况

- 把手位置铁律：center 左 ◀ 骑细线左（实测 x=642..649，线 647..653）、右 ▶ 骑线右（x=649..656）；left ▶ 贴粗线右（x=282..289，rail 276..282）；right ◀ 贴粗线左（x=997..1004，rail 1002..1008）
- 三个不变：粗线形态零改（rail 结构/border-left 2px 未动）、门框总宽位置不动（left 态 preview 282..1014 + ws 1014..1286，总宽守恒）、内容不移位
- left↔right 禁直接互跳：left 态仅 ▶ 回 center、right 态仅 ◀ 回 center（无跨态按钮）
- 禁项：无菱形/clip-path/focusMode/region-switcher/引擎大改（引擎仅加可选分支，缺省逐字段相等）

## 关键文件变更

### 前端（门模型）

| 文件 | 类型 | 说明 |
|------|------|------|
| `app/web/src/components/chat-page/use-preview-collapsed.ts` | 修改 | 三态 hook + 持久化 + 旧 collapsed 迁移/桥接 |
| `app/web/src/lib/layout-width-engine.ts` | 修改 | `chatCollapsed?` 可选分支（缺省回归） |
| `app/web/src/components/chat-page/use-three-col-layout.ts` | 修改 | chatCollapsed 透传 + chatRenderWidth |
| `app/web/src/components/chat-page/section-preview-area.tsx` | 修改 | 三态渲染 + 双把手 + 上报 door==='right' |
| `app/web/src/components/chat-page/component-preview-collapse-toggle.tsx` | 修改 | `direction/tooltipKey/testid` 可选 prop |
| `app/web/src/components/chat-page/preview-area-context.ts` | 修改 | value 加 door/setDoor |
| `app/web/src/components/chat-page/use-preview-tabs.ts` | 修改 | door/setDoor 解构透传 |
| `app/web/src/components/chat-page/preview-area-provider.tsx` | 修改 | door 接线 |
| `app/web/src/components/chat-page/page-chat.tsx` | 修改 | PageChatRow 读 door + chatCollapsed + 条件渲染 |
| `app/web/src/components/studio-page/component-studio-chat-router.tsx` | 修改 | StudioChatRow 同构 |
| `app/web/src/i18n/locales/{zh-CN,en}/chat.json` | 修改 | doorLeft/doorRight/doorCenter |

### 测试

| 文件 | 类型 | 说明 |
|------|------|------|
| `app/web/src/lib/__tests__/layout-width-engine.test.ts` | 修改 | chatCollapsed 分支 5 用例（吞并/缩窄/回归相等/preview.collapsed 互斥/拖拽不受影响） |
| `app/web/src/components/chat-page/__tests__/use-preview-collapsed.test.ts` | 新增 | 三态读写、迁移（'1'→right/'0'→center/已有 pv-door 优先）、坏值兜底、per-session 隔离、setCollapsed 桥接、旧 key 同步 |
| `app/web/src/components/chat-page/__tests__/section-preview-area.test.tsx` | 修改 | 三态渲染把手位置 5 用例（center 双把手 chevron+贴线侧 / left rail+▶ / right ◀）+ 旧用例适配 door 驱动 |

## 验证结论

- UT：6 files / 122 tests 全绿（引擎 30 + section-preview-area + use-preview-collapsed + use-preview-tabs + use-three-col-layout + page-chat-three-col-layout；视觉修复同步 UT 断言 + blocking 修复补 4 用例）
- tsc：0 error
- dev 实测（worktree 独立环境 3713/8793，未动 dev1）：
  - center → 点左◀ → left：rail 粗线贴门框左缘 + ▶ 贴 rail 右 + preview 占满门框 + chat 条件不渲染（消息 DOM 消失）+ localStorage `pv-door=left`/`pv-collapsed=1`
  - left → 点▶ → center：chat 消息完整恢复（SSE 重拉不丢）+ 双把手回位 + `pv-door=center`
  - center → 点右▶ → right：rail 贴 ws 左缘 + ◀ 贴 rail 左 + chat 占满 + `pv-door=right`；点 ◀ 回 center ✓
  - 刷新持久化：`pv-door=left` 恢复（重新打开文件后 openTabDirect 自动展开回 center——预期行为，PRD §3.5）

## 视觉修复 3 轮（老板验收，合并前补记）

> 全部落在 `component-preview-collapse-toggle.tsx`，未动三态逻辑/把手位置铁律。

1. **cb9645b81 视觉修复 1（方案 A）**：收起态 rail 完整粗条——本体 `bg-bg-warm`（深一档，与 preview `bg-surface` 拉开，不再被吞）+ 左右双 border（`border-l-[2px] border-r-[2px]`）；hover 升 `bg-surface-3`（保持 hover 变深）。handle 保持 `bg-surface` 白底（对比深色 rail 更清晰）。
2. **f7ab1e95e 视觉微调 2**：rail 加粗 20%（6→7px）+ handle 水平加粗 20%（7→8px，`HANDLE_BASE` w-[8px]）。
3. **b226ed7f1 视觉修复 3**：`stickCls` 贴线偏移 7→8px 同步 handle 加粗（`-left-[8px]` / `-right-[8px]`，消除 1px 重叠）+ UT 断言同步。

## blocking 修复（老板拍板不再复测，合并前补记）

- **c6d08e9a9**：门态持久化刷新不恢复——`usePreviewCollapsed` 加 `useEffect([sessionId])`：sessionId 变化 → 重读对应会话 `pv-door-<sid>`（root 挂载 sid='' → 点进会话 sid 变化；若不用 effect 重读，门态固化为 root 的 center，切会话不恢复各自持久化门态）。UT 补 4 用例（sessionId 变化重读）。
