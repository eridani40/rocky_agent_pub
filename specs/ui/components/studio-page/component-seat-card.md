# component-seat-card

> 层级: component
> 文件: app/web/src/components/studio-page/component-seat-card.tsx

## 职责
**队长 mini 卡**（C 指挥台左列首张卡）：seclabel「队长」+ mini 行+ 操作行。
**群聊入口**：从 TeamEntryRow 挪到队长卡操作行中档——「进入对话」占一半（flex-1 主色 solid）、「群聊」占一半（flex-1 灰色 outline，不抢主按钮视觉）；群聊按钮右键上抛父级浮层菜单（复制 squadChat sessionId，与 TeamEntryRow 群聊 link 原右键行为同源）。**[v0.0.270] 群聊按钮受 enableGroupChat 控制**：`onOpenGroupChat` / `onGroupChatContextMenu` 不传（undefined）→ 群聊按钮 + 右键菜单**缺省隐藏**（`component-seat-card.tsx:143` 已支持）——SeatsBody 在 `detail.enableGroupChat !== false` 时才传双 prop（关时不传），零新增渲染分支。
「坐席卡」概念 = 队长卡（本就是卡形态，保留文件名/spec/UT 历史连续）；mate 列表形态见 `component-seat-row.md`。
菜单项规则不变：编辑（总存）+ bench（mate+deployed）/ deploy（benched）；**leader 菜单无 bench 项**（硬规则，双层拒：UI 不渲染 + API 403）——队长卡由 seats-body 不传 `onBench` 达成。
菜单机械与 mate 行共享：开关/定位/flip-up/延迟监听全在 `use-seat-menu.ts`；呈现共享（脉冲点/状态文案）在 `seat-present.ts`；弹层走 `component-seat-card-menu` portal body。

## Props
- row: SeatRow
- onEnter: () => void
- onOpenGroupChat?: () => void
- onGroupChatContextMenu?: (x: number, y: number) => void
- onEdit?: (member: Member) => void
- onBench?: (member: Member) => void
- onDeploy?: (memberId: string) => void
- onContextMenu?: (sessionId: string, x: number, y: number) => void

## 状态 / 交互
- **布局稳定**（CLAUDE.md MANDATORY / regulation 03）：卡无 hover 位移/阴影变化，不改内边距/字号（设计稿左列卡为静态展示）
- **offline 卡**：根 `opacity-75`；「进入对话」降 secondary 型（白底灰边黑字），不用 primary solid
- **leader 标识（形式）**：行内 LEADER badge（名后 inline，amber 浅底）——**旧 border-strong 描边 / shadow-sm 常态 / border-t-2 顶端强调条已废**（C 风格左列卡统一白卡，队长身份由 seclabel「队长」+ 行内 badge 表达）
- **running spinner**：`row.isRunning=true` → LEADER badge 后（名行最末）挂 `<SpinnerRing size="sm">`（复用 `common/spinner-ring.tsx`，10×10， 占位防位移 INV-9）。**`isRunning` = `isRunningState(sessionState)` = `state ∈ {running, interrupting}`，deliberately 排除 suspended**。**区别于 `presence='busy'`**：busy 含 suspended（用于 inProgressCount 统计 + 脉冲点颜色），isRunning 不含——两概念有意分离，禁合并。派生源：`use-seats-data.ts` 的 `isRunningState`（export 纯函数），stateMap 来自 `useStudioUnreadMeta`。
- **脉冲点**：CSS-only 静态 `box-shadow`（**无 @keyframes**——INV-3），颜色随 presence 三态映射 `--presence-*`（`seat-present.pulseStyle`）
- **「更多」菜单**（机械不变，宿主从卡片内部 state 改 `use-seat-menu` hook）：
  - 打开：触发按钮 click → `getBoundingClientRect` 定位（右对齐按钮右边缘，fixed `--z-popover`）
  - 菜单项渲染规则：编辑=`onEdit` 提供；bench=仅 !isLeader && deployed && `onBench`；deploy=仅 benched && `onDeploy` - 点菜单项 → 触发回调 + 关菜单；卸载时 portal 节点随组件清理

## 视觉基线
- seclabel：Inter 11px/600 uppercase letter-spacing .5px muted-2，margin-bottom 10px（文案 i18n `seats.sectionLeader`）
- 名：Inter 14px/600 fg truncate；名行 =  容器（gap-1.5 统一间距防挤）内顺序：名 → LEADER badge（若队长）→ 可选 running spinner；**LEADER badge 行内**  + `background:var(--hue-amber-bg)` + `color:var(--hue-amber)` +
- meta 行：mt-0.5， Inter 12px muted 单行 truncate = 脉冲点  + `statusText · state`
- **群聊按钮右键**：`stopPropagation + preventDefault` 后上抛 `onGroupChatContextMenu(x, y)`——stopPropagation 必需（否则冒泡到根卡右键 handler 触发 leader sessionId 浮层，双重弹层）
