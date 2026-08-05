# v0.0.196 变更计划书 — 团队看板并入业务全景（多 tab 重构）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 需求权威：`reqs/[working] v0.0.196.board_into_panorama/req.md`（纯前端 UI 重构，零后端/零 API/零 schema 变化；核心=合并入口，固定 3 tab 数据源/展示逻辑原封保留）。

## 核心设计决策（架构冻结）

- **D1 统一 tab 条落 route 层**：`component-panorama-route.tsx` 升级为统一 tab host——持 `activeTab` state、渲统一 tab 条（testid `panorama-tabs`）、按 tab 类型分发内容。装配顺序契约：**固定 3（goals/requirements/tasks，恒渲染不依赖 schema）→ DSL `views` 动态 tab → 「更多」tab（仅动态 views 为空时）**。tab 条视觉统一沿用现 panorama-view tab 按钮样式（`-mb-px border-b-2` + 激活 `border-b-fg font-semibold text-fg`），一套样式覆盖全部 tab。
- **D2 看板三视图 = 整组件复用 SquadBoard + 受控 tab 改造**（不拆子视图、不重写）：SquadBoard 的 sub-tab 上提为受控 prop `tab: BoardTab`，**删除自带 sub-tab 栏**（唯一 consumer 已是嵌入全景，死代码）；`useLifecycle(getBoard(squadId,'all',zone), deps:[squadId,zone])` 数据链、zone/taskFilter/editing/creating/弹层/归档恢复/三视图渲染**零改动**；`squad-board-refresh` 移入 BoardToolbar 右组（testid 不变）。
- **D3 PanoramaView 受控 view 改造**：删内部 `activeTab` state + tab 条 JSX（上提 route），新增必填 prop `activeViewId: string`；toolbar（+新建/刷新）、三原语装配、事件流、弹层、SSE 乐观更新零改动。
- **D4 单实例语义**：固定 3 tab 间切换 = 同一 SquadBoard 实例受控 tab 变更（zone/taskFilter/board 缓存保持，同迁移前 sub-tab 切换）；固定↔动态切换各自卸载/重挂（重挂 refetch，与迁移前「离开页面再回来 refetch」行为一致）。
- **D5 保留 id 约束**：`goals|requirements|tasks|more` 为保留 tab id；DSL view id 撞保留 id 时被固定 tab 遮蔽（已知约束，落 spec 不防错）。
- **D6 testid 变更**：新增 `panorama-tabs` / `panorama-tab-{goals,requirements,tasks,more}`；保留 `panorama-tab-{viewId}`（动态）+ 全部 `squad-board-*`（除 sub-tab）+ 其余 `panorama-*`；废弃 grep 归零 `squad-board-tab-*` / `seat-team-entry-board(-icon)` / `board-topbar-back-btn` / `studio-main`（BoardRoute 根 testid，随文件删除）。
- **D7 i18n**：删 `seats.team.boardTitle` + `boardRoute` 组（中英）；增 `panorama.tabs.{goals,requirements,tasks,more}`（zh 目标/需求/任务/更多，en Goals/Requirements/Tasks/More）——中英两份都加（memory `i18n-key-add-checklist`）。

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-studio | app/web/src/components/studio-page/component-panorama-route.tsx | `PanoramaRouteProps` | 修改 | 新增 `members: Member[]`（看板 owner/assignee 字典）+ `onCreate?: (kind: BoardEntityKind, parentGoalId?: string) => void` + `onAtMention?: (payload: BoardMentionPayload) => void`（透传看板 +新建/@ 能力） | MUST 类型复用现成导出：`Member`（squad-types）、`BoardEntityKind`（board-types）、`BoardMentionPayload`（component-board-at-button） | req §2；specs/ui/components/studio-page/component-panorama-route.md | +8/-0 |
| ui-studio | app/web/src/components/studio-page/component-panorama-route.tsx | `PanoramaActiveTab` | 新增 | tab id 联合类型：`BoardTab \| 'more' \| (string & {})`（BoardTab 自 component-squad-board 导入） | 保留 id 约束见 D5 | req §2 | +3 |
| ui-studio | app/web/src/components/studio-page/component-panorama-route.tsx | `FIXED_TABS` | 新增 | 固定 3 tab 元数据数组：`{id: BoardTab, labelKey, testid}` = goals/requirements/tasks → `panorama-tab-{id}`，label 走 i18n `studio:panorama.tabs.{id}` | testid 模式 MUST 为 `panorama-tab-{goals,requirements,tasks}`（不沿用 squad-board-tab-*） | req §2；06-studio.md §2.2a | +8 |
| ui-studio | app/web/src/components/studio-page/component-panorama-route.tsx | `PanoramaRoute()` | 修改 | 升级为统一 tab host：① `activeTab` state（默认 `'goals'`）；② tab 装配 = FIXED_TABS + `schema?.views ?? []` +（动态 views 为空时）'more'；③ 统一 tab 条 JSX（`panorama-tabs` 容器，按钮样式沿用现 panorama-view tab 样式）；④ 内容分发：固定 tab→`<SquadBoard tab={activeTab}>`（外包 `max-w-[920px] px-8 pb-10 pt-5` 容器，同迁移前 BoardRoute 主体约束）、'more'→`<PanoramaIdle>`、动态→`<PanoramaView activeViewId={activeTab}>`；⑤ schema 变化后校验 activeTab 仍合法否则回落 'goals' | MUST NOT 改 schema 加载/SSE 订阅/loading/error 逻辑（loading/error 仍整区渲染）；SquadBoard 仅固定 tab 激活时挂载；PanoramaView 仅动态 tab 激活时挂载 | req §2/迁移语义；D1/D4/D5 | +85/-12 |
| ui-studio | app/web/src/components/studio-page/component-panorama-view.tsx | `PanoramaViewProps` | 修改 | 新增必填 `activeViewId: string`（route 保证合法 view id） | MUST NOT 再自持 activeTab | component-panorama-view.md | +2/-0 |
| ui-studio | app/web/src/components/studio-page/component-panorama-view.tsx | `PanoramaView()` | 修改 | 删 `activeTab` state + tab 条 JSX（`schema.views.map` 按钮行）；`view = schema.views.find(v => v.id === activeViewId)`；toolbar 行独立渲染（右对齐） | MUST NOT 动 toolbar 按钮/三原语装配/事件流/弹层/SSE 乐观更新/拖拽 transition；`panorama-tab-{viewId}` testid 随 tab 条上提 route（本组件不再渲） | req §2（动态 tab 内容保留迁移前风格）；D3 | +8/-35 |
| ui-studio | app/web/src/components/studio-page/component-squad-board.tsx | `SquadBoardProps` | 修改 | `initialTab?: BoardTab` → `tab: BoardTab`（受控必填） | 调用方仅 route（嵌入全景）；MUST 保持 `members`/`onCreate`/`onAtMention` 签名不变 | squad-board.md §Props；D2 | +2/-2 |
| ui-studio | app/web/src/components/studio-page/component-squad-board.tsx | `TABS` | 删除 | sub-tab 元数据数组删除（上提 route FIXED_TABS，testid 改 panorama-tab-*） | `squad-board-tab-*` testid 随删除 grep 归零 | D2/D6 | +0/-8 |
| ui-studio | app/web/src/components/studio-page/component-squad-board.tsx | `SquadBoard()` | 修改 | 删内部 `tab` state + sub-tab 栏 JSX（TABS 按钮行 + 行内 refresh 按钮）；改用受控 `tab` prop 分发三视图；`reload`/`loading` 透传 BoardToolbar（refresh 按钮迁入） | MUST NOT 动 useLifecycle 数据链（onInit getBoard(squadId,'all',zone)、deps [squadId,zone]、signal.aborted 校验）、zone/taskFilter state、handleSave/handleArchive/handleRestore/duplicate/create、BoardEntityModal、三视图 props | req 核心一句话（数据源/展示逻辑原封保留）；D2 | +6/-28 |
| ui-studio | app/web/src/components/studio-page/component-board-toolbar.tsx | `BoardToolbarProps` | 修改 | 新增可选 `onRefresh?: () => void` + `refreshing?: boolean` | 缺省 → 不渲 refresh 按钮（向后兼容） | D2 | +4/-0 |
| ui-studio | app/web/src/components/studio-page/component-board-toolbar.tsx | `BoardToolbar()` | 修改 | 右组 ZoneSwitch 前渲 refresh 按钮（testid `squad-board-refresh`，`disabled={refreshing}`，icon+`common:action.refresh`，样式对齐原 squad-board 行内版） | MUST 保持左组 +新建/task filter、右组 zone switch 布局不变；三控件 h-7 基准不变 | squad-board.md §toolbar；D2 | +13/-1 |
| ui-studio | app/web/src/components/studio-page/component-studio-board-route.tsx | 整文件（`BoardRoute`） | 删除 | `mv` 至 `soft_deleted/v0.0.196/component-studio-board-route.tsx`（软删，不 rm） | 无 consumer 残留（page-studio 分支同删）；`board-topbar-back-btn`/`studio-main` testid 随删 | req 迁移语义（彻底删，不 @deprecated）；memory `soft-delete-instead-of-rm` | +0/-69 |
| ui-studio | app/web/src/components/studio-page/page-studio.tsx | `MainView` | 修改 | 删除 `{ kind: 'board'; squadId: string }` 变体 | 无其他 kind:'board' 赋值残留 | req §迁移语义 | +0/-1 |
| ui-studio | app/web/src/components/studio-page/page-studio.tsx | `PageStudio()` | 修改 | ① 删 `import BoardRoute` + `mainView.kind==='board'` 分支；② SeatsPanel 删 `onOpenBoard` prop；③ PanoramaRoute 增 `members={detail?.id===panoSquadId ? detail.members : []}` + `onCreate={handleBoardCreate}` + `onAtMention={handleBoardAtMention}`（复用 useBoardAtMention 既有 handler） | MUST NOT 动 useBoardAtMention hook 本身；chat/token-stats/member 分支零改动 | req §1/§2；06-studio.md §2 | +4/-16 |
| ui-studio | app/web/src/components/studio-page/component-seats-panel.tsx | `SeatsPanelProps` + `SeatsPanel()` | 修改 | 删 `onOpenBoard` prop 声明、解构、透传 SeatsBody | 其余 props 不变 | req §1；component-team-entry-row.md | +0/-4 |
| ui-studio | app/web/src/components/studio-page/component-seats-body.tsx | `SeatsBodyProps` + `SeatsBody()` | 修改 | 删 `onOpenBoard` prop 声明、解构、TeamEntryRow 传递 | 其余 props 不变 | req §1 | +0/-4 |
| ui-studio | app/web/src/components/studio-page/component-team-entry-row.tsx | `TeamEntryRowProps` | 修改 | 删 `onOpenBoard: () => void`（必填 prop 移除） | `onOpenPanorama?`/`onOpenTokenStats?` 保持可选 | req §1；component-team-entry-row.md | +0/-2 |
| ui-studio | app/web/src/components/studio-page/component-team-entry-row.tsx | `BoardIcon` | 删除 | 看板 icon svg 常量删除（唯一消费者消失） | 无残留引用 | req §1 | +0/-7 |
| ui-studio | app/web/src/components/studio-page/component-team-entry-row.tsx | `TeamEntryRow()` | 修改 | 删看板 EntryLink（`seat-team-entry-board` + `-icon`）；容器收敛为 业务全景 + token 统计 两 link | `seat-team-entry-board` grep 归零；其余 link 视觉/testid 不变 | req §1；D6 | +0/-8 |
| ui-studio | app/web/src/i18n/locales/zh-CN/studio.json | `seats.team.boardTitle` / `boardRoute` / `panorama.tabs` | 修改 | 删 `seats.team.boardTitle` + `boardRoute` 组（死 key）；增 `panorama.tabs.{goals:目标, requirements:需求, tasks:任务, more:更多}` | MUST 走 t() 渲染（route FIXED_TABS labelKey）；禁只改一个语言 | memory `i18n-key-add-checklist`；D7 | +5/-4 |
| ui-studio | app/web/src/i18n/locales/en/studio.json | `seats.team.boardTitle` / `boardRoute` / `panorama.tabs` | 修改 | 同上（en：Goals/Requirements/Tasks/More） | 同上 | D7 | +5/-4 |
| ui-studio-ut | app/web/src/components/studio-page/__tests__/component-panorama-route.test.tsx | 全 describe | 修改 | 改写为统一 tab host 契约：① dsl=null → 固定 3 tab（`panorama-tab-goals/requirements/tasks`）+「更多」tab（`panorama-tab-more`），点「更多」→ `panorama-idle`；② dsl 有值 → 固定 3 + 动态 tab（`panorama-tab-item_table`），无「更多」；③ 装配顺序断言（固定前 3 → 动态）；④ 点固定 tab → 内嵌 `squad-board` 渲染；⑤ SSE schema_update 重建；⑥ 返回键不变。新增 mock `../../../lib/squad-api`（getBoard 等 13 export，fixture board） | MUST 沿用 vi.mock 绝对路径（memory `test-vitest-mock-absolute-path`）；MUST NOT 真 fetch | req §2；D1/D6 | +95/-35 |
| ui-studio-ut | app/web/src/components/studio-page/__tests__/component-panorama-view.test.tsx | 全 describe | 修改 | ① 所有 render 传 `activeViewId`；② 切 tab 用例改 `rerender(<PanoramaView activeViewId="run_table" .../>)`；③ tab 条 label/数量断言删除（迁 route 测试） | 三原语装配/弹层/transition 用例保持 | D3 | +15/-40 |
| ui-studio-ut | app/web/src/components/studio-page/__tests__/component-squad-board.test.tsx | 全 describe | 修改 | ① render 传受控 `tab` prop（缺省用 `tab="goals"`）；② `fireEvent.click(squad-board-tab-*)` 切 tab 用例改 `rerender` 传新 tab prop；③ sub-tab 栏 data-active 断言删除；④ refresh 按钮断言改在 toolbar 内（testid 不变） | 三视图/toolbar/zone/filter/弹层/归档恢复用例保持 | D2/D6 | +25/-70 |
| ui-studio-ut | app/web/src/components/studio-page/__tests__/component-team-entry-row.test.tsx | 全 describe | 修改 | 删看板 link 用例（渲染/点击/icon hue/size）；props 不再传 `onOpenBoard`；保留业务全景 + token 统计 link 用例 | `seat-team-entry-board` 断言归零 | req §1；D6 | +8/-42 |
| ui-studio-ut | app/web/src/components/studio-page/__tests__/component-seats-panel.test.tsx | mkProps + 2 用例 | 修改 | ① mkProps 删 `onOpenBoard: vi.fn()`；②「点看板 link」用例删 board 断言（保群聊按钮断言）；③「右键看板入口卡」用例删除（入口已删） | 其余 seats-panel 用例保持 | req §1；D6 | +4/-28 |
| ui-studio-ut | app/web/src/components/studio-page/__tests__/page-studio-board-route.test.tsx | 整文件 | 删除 | `mv` 至 `soft_deleted/v0.0.196/`（board 路由态删除，返回键契约已由 panorama-route 测试覆盖） | 无残留 import | req 迁移语义 | +0/-127 |
| ui-studio-ut | app/web/src/components/studio-page/__tests__/page-studio.test.tsx | — | 修改 | 仅核对无 board 依赖（现仅注释提及，预期零改或删注释） | 不动其他用例 | — | +0/-2 |

## 影响面评估

- **范围**：纯前端 `app/web/`（studio-page 组件 8 改 1 删 + i18n 2 + UT 6 改 1 删）；零后端 / 零 API / 零 schema / 零打包相关改动（无新依赖、无 plugin、无 runtime env、无路径展开——打包护栏四项均不触及）。
- **破坏性变更**：`SquadBoardProps.tab` 受控必填化 + `TeamEntryRowProps.onOpenBoard` 移除 + `MainView` board 变体删除——三者 consumer 均在本表内同步改（route / seats 链 / page-studio），无表外 consumer（已 grep 核实：SquadBoard 仅 board-route（删）与 route（改）消费；PanoramaView 仅 route 消费；`seat-team-entry-board` 仅 entry-row + 两测试文件）。
- **依赖顺序**：同组件内符号先行（props/type → 组件体），route 最后接线；UT 与代码同 task 同步改（vitest 必须全绿）。
- **风险点**：① route 文件涨至 ~210 行（<300 上限）；② SquadBoard 嵌入后滚动容器 = route 根 `main overflow-y-auto` + `max-w-[920px]` 外包（同迁移前 BoardRoute 主体约束，视觉不变）；③ 固定↔动态 tab 切换各自卸载重挂会 refetch（与迁移前离开/回来行为一致，D4）；④ `component-squad-board.test.tsx` 865 行大批量改 tab 切换方式——按「rerender 受控 prop」机械替换，禁止顺手重写用例语义。
- **组件 spec 前置（coder 编码前更新，标准见 _conventions.md）**：`component-panorama-route.md`（统一 tab host + 装配顺序契约 + 新 testid）、`component-panorama-view.md`（受控 activeViewId，tab 条上提）、`squad-board.md`（受控 tab prop + sub-tab 栏删除 + refresh 迁 toolbar + 宿主改全景）、`component-team-entry-row.md`（看板 link 删，收敛两 link）。doc-modifier 阶段 5 同步 `06-studio.md`（§2.2 board 并入 §2.2a）+ `00-app-guide.md`。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
