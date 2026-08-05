# v0.0.196 — UI Change Log（团队看板并入业务全景：多 tab 重构）

> 增量变更。全量权威：`specs/ui/overall/06-studio.md` v1.14 + `specs/ui/components/studio-page/{component-panorama-route,component-panorama-view,squad-board,component-team-entry-row}.md`。
> 权威输入：`reqs/[working] v0.0.196.board_into_panorama/req.md`（纯前端 UI 重构，零后端/零 API/零 schema）。
> **纯前端零后端**（零 API/零 schema/零落库变更）；**看板数据源/展示逻辑原封保留**（只合并入口与 tab 条外壳）。**验证**：UT + typecheck（用户裁决豁免 AT/ET——纯前端无 API 契约变更；ET 由用户本人进行）。

## §1 主 spec overall 更新

### 1.1 `specs/ui/overall/06-studio.md` v1.14

- **§1 概述一句话**：主区态从「四态 seats/board/chat/member」改「五态 seats/panorama/token-stats/chat/member」（board 删、panorama 升级）；「目标/需求/任务查看唯一入口 = 业务全景」。
- **§2 布局图 + 右主区态列表**：删 board 态；panorama 改述为「统一 tab host（固定 3 + DSL 动态 + 更多）」。
- **§2.1 结构表**：`squad-tree-board-{squadId}` 标注「v0.0.196 真正归零」（`seat-team-entry-board` 亦废）；`studio-main` 行修正——v0.0.168 称已废但实际仍挂 BoardRoute 根（spec 落后），本版随 BoardRoute 软删真正归零。
- **§2.3 SeatsPanel**：TeamEntryRow compact links 收敛为「业务全景 + token 统计 两 link」（删看板 link）；testid 段 `seat-team-entry-{board|panorama|token-stats}` → `seat-team-entry-{panorama|token-stats}`，新增 `[v0.0.196 已废] seat-team-entry-board(+{-icon})`。
- **§2.2 团队看板页** → 改写为短指针：独立 board 路由态删除、看板三视图整组件受控并入 §2.2a 前 3 固定 tab、数据链零改动；保留 `[v0.0.196 已废]` testid 清单（`seat-team-entry-board` / `squad-board-tab-*` / `board-topbar-back-btn`）+ 历史入口沿革。
- **§2.2a 业务全景页** → 扩写为统一 tab host 架构：装配顺序契约 D1（固定 3 恒渲染 → DSL 动态 → 更多仅动态为空时）+ 单实例语义 D4 + 保留 id 约束 D5 + schema 变化校验 + 动态 tab 工作面板（PanoramaView 受控化）+ 固定 tab label 走 i18n；testid 段加 `panorama-tabs` / `panorama-tab-{goals,requirements,tasks,more}` / `panorama-tab-{viewId}`（自 view 上提）。
- **§3 解体**：修正 `studio-main` 归零说明（v0.0.196 才真正归零）。
- **§12 版本**：加 v1.14 条目。

### 1.2 `specs/ui/overall/00-app-guide.md`

- **§3.2 Studio 功能链路**：团队入口卡 → 业务全景 / token 统计（删看板，注 v0.0.196 并入业务全景）。
- **新增 §3.2 业务全景入口（v0.0.196 升级为多 tab）**：操作路径 = 业务全景 link → 统一 tab 条（前 3 固定 目标/需求/任务 + DSL 动态 + 更多）。「照手册能从 nav-rail 点到任意功能」仍成立——目标/需求/任务查看入口改为业务全景内。

## §2 组件 spec 更新（coder 编码前置已更新，doc-modifier 核对一致）

| 组件 spec | 版本 | 主要变化 |
|---|---|---|
| `component-panorama-route.md` | v2.0 | 升级为统一 tab host：持 `activeTab` + 装配（固定 3 → 动态 → 更多）+ 统一 tab 条 + 受控分发；Props 加 `members`/`onCreate`/`onAtMention`；新增 testid `panorama-tabs`/`panorama-tab-{goals,requirements,tasks,more}` |
| `component-panorama-view.md` | v2.0 | 受控化：删内部 `activeTab` state + tab 条 JSX（上提 route）；Props 加必填 `activeViewId`；toolbar/三原语/事件流/弹层/SSE 零改动 |
| `squad-board.md` | v7.0 | 受控 tab 改造 + sub-tab 栏删除：`initialTab` → 受控必填 `tab`；删 `TABS` 元数据 + sub-tab 栏 JSX（`squad-board-tab-*` 废）；refresh 迁 BoardToolbar 右组（`squad-board-refresh` 不变）；useLifecycle 数据链零改动 |
| `component-team-entry-row.md` | v1.4 | 看板 link 删除：props `onOpenBoard` 删 + BoardIcon svg 删；收敛为 业务全景 + token 统计 两 link |

## §3 实现关键事实（spec↔code 一致性核对结果）

- **统一 tab host 装配顺序**：`component-panorama-route.tsx` `FIXED_TABS`（goals/requirements/tasks）→ `dynamicViews = schema?.views ?? []` → `showMoreTab = dynamicViews.length === 0`；受控分发 `isFixedTab ? <SquadBoard tab={activeTab}> : activeTab==='more' ? <PanoramaIdle> : <PanoramaView activeViewId={activeTab}>`。与 spec D1 一致。
- **SquadBoard 受控 tab**：`SquadBoardProps.tab: BoardTab`（受控必填，原 `initialTab` 删）；BoardToolbar 新增 `onRefresh`/`refreshing` + `squad-board-refresh` testid。与 spec D2 一致。
- **入口收敛彻底**：`MainView` type 无 `{kind:'board'}` 变体；`BoardRoute` 整文件软删（`soft_deleted/v0.0.196/`）；`seat-team-entry-board` / `squad-board-tab-*` / `board-topbar-back-btn` / `studio-main` 在 active 代码 grep 归零（仅 soft_deleted + 注释残留）。与 spec 一致。
- **i18n 中英两份**：`panorama.tabs.{goals,requirements,tasks,more}` zh 目标/需求/任务/更多、en Goals/Requirements/Tasks/More；死 key `seats.team.boardTitle` + `boardRoute` 组两份均删。与 spec D7 一致。
- **PanoramaRoute 接线**：`page-studio.tsx` 增 `members={detail?.id===panoSquadId ? detail.members : []}` + `onCreate={handleBoardCreate}` + `onAtMention={handleBoardAtMention}`（复用 `useBoardAtMention` 既有 handler，hook 本身不动）。

## §4 已知约束（落 spec 不防错）

- **保留 tab id（D5）**：`goals|requirements|tasks|more` 为保留 tab id；DSL view id 撞保留 id 时被固定 tab 遮蔽。
- **固定↔动态 tab 切换 refetch（D4）**：固定 3 间切换 = 同一 SquadBoard 受控变更（缓存保持）；固定↔动态切换各自卸载重挂（refetch，同迁移前离开/回来行为）。
