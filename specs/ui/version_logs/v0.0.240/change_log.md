# v0.0.240 ui change_log — Studio 首页 IA 改造 + panorama 内嵌 + TokenWidget

> 类型：UI 契约扩展（首页 IA 重排 + panorama 嵌入 + 新组件 + 组件废）。无新独立路由（panorama 从独立路由态改为首页第二栏内嵌）。
> UI 权威：`specs/ui/overall/06-studio.md`（首页 IA + §3.1/§4/§5 改写）+ `specs/ui/overall/00-app-guide.md`（§3.2 studio 入口）。组件 spec：`specs/ui/components/studio-page/`。

## 改动文件

| 文件 | 改什么 |
|------|--------|
| `specs/ui/overall/06-studio.md` | §1 概述（tab「坐席」→「首页」+ 全景内嵌 + TokenWidget + 成员·N）；§2 主页布局 ASCII（首页 IA）；§3.1 首页 tab（左列 TokenWidget 替代 SeatStats+TeamEntryRow / roster 成员·N 减队长 / 第二栏内嵌 PanoramaRoute）；§4 业务全景（独立路由 → 内嵌 + builtin task 首 tab + ArchiveSwitch + 无 PanoramaIdle）；§5 token-stats 入口（TokenWidget 整卡点击） |
| `specs/ui/overall/00-app-guide.md` | §3.2 Studio 路径（首页三 tab / TokenWidget / 业务全景第二栏内嵌 / Token 统计入口）+ 表格 Studio 行 |
| `specs/ui/components/studio-page/component-panorama-route.md` | 整文件重写：删 FIXED_TABS/isFeatureOkrOn/SquadBoard（v0.0.237 已删残留）+ 删 onBack 头部（内嵌）+ 删 showMoreTab/'more'/PanoramaIdle（builtin task 恒在首 tab，schema 永不空）；tab 装配 = builtin task 首项 + DSL 动态顺延；所有 tab 走统一 PanoramaView |
| `specs/ui/components/studio-page/component-team-entry-row.md` | 整组件标 DEPRECATED（v0.0.240 废，mv soft_deleted）；业务全景入口由第二栏内嵌 PanoramaRoute 取代，token 统计入口由 TokenWidget 取代 |
| `specs/ui/components/studio-page/component-panorama-view.md` | toolbar 加 ArchiveSwitch 槽位（仅 view.filter.archived 时）+ view.filter 透传 fetch + 卡片 hover 归档按钮（PATCH archived:true）+ 已归档 opacity 0.55 + source=system SSE 乐观更新 |
| `specs/ui/components/studio-page/component-token-widget.md` | **新增**（T2 产出）：首页左列 Token 用量图文小组件——今日三色比例条 + 7 日迷你柱 + 累计/预算进度条 + 整卡点击切 token-stats；复用 token-stats hue 配色；hover box-shadow（无位移） |
| `specs/ui/components/studio-page/component-seats-body.md` | 左列 SeatStats 2×2 + TeamEntryRow 删除 → TokenWidget；roster 头计数「坐席·N」→「成员·N」（N 减队长）；第二栏内嵌 PanoramaRoute；props 删 stats/onOpenBoard/onOpenPanorama，加 onOpenTokenStats/onAtLeader；i18n 路径标注 |

## i18n 同步

- `app/web/src/i18n/locales/{zh-CN,en}/studio.json`：tabs.seats「坐席」→「首页」；roster.count；新增 tokenWidget.* + task.status_labels（中文配死：todo→未开始 / waiting→等待中 / in_progress→进行中 / done→已结束）；删 teamEntry.*（中英同步）
- `app/web/src/i18n/locales/{zh-CN,en}/plugin-config.json`：squad_task.description（中英同步）

## 组件删除清单（mv soft_deleted/v0.0.240/）

- `component-team-entry-row.tsx`（整组件废）
- `component-panorama-idle.tsx`（v0.0.240 删——builtin task 恒在，无 idle 入口）

## 新组件清单

- `component-token-widget.tsx`（图文小组件）
- `component-panorama-archive-switch.tsx`（toolbar 归档 segmented 开关）
