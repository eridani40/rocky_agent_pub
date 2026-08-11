# page-app-settings-merged（应用设置合并页）

> 文件: app/web/src/components/app-dev-config-page/page-app-settings-merged.tsx

## 职责
应用设置合并页根（薄壳，~200 行）。**左侧 tab 竖排导航树**（通用区 6 tab + 系统设置收起区 2 tab）+ **右侧按选中 tab 渲染对应 group 集合**（上下排列，每 group title + 区域间隔）+ **底部 page-tab 级 sticky save-bar**（dirty 检测 + 保存/取消）。

> **[v0.0.318] 配置同步 tab**：通用区新增 `config_sync`（memory 紧邻下方），自渲染 `section-config-sync`（导入导出即时操作，**不进 page-tab dirty / 不走 SaveBar**）。tab 注册见 `app-settings-config-defs.ts`（`TabId` union + `APP_SETTINGS_TABS` memory 后插入 + `TAB_KV_GROUPS.config_sync=[]`）；路由见 `section-tab-panel.tsx` `case 'config_sync'`。
> **[v0.0.319] 团队同步 tab**：通用区新增 `team_sync`（config_sync 之后），自渲染 `section-team-sync`（导入导出即时操作，**不进 page-tab dirty / 不走 SaveBar**）。tab 注册见 `app-settings-config-defs.ts`（`TabId` union + `APP_SETTINGS_TABS` config_sync 后插入 + `TAB_KV_GROUPS.team_sync=[]`）；路由见 `section-tab-panel.tsx` `case 'team_sync'`。

## 保存交互（page-tab 级）
**数据源**：REST CRUD 无 SSE——挂载 `useAppSettingsConfig` 并发 `GET /config/app?group=<g>&key=default`（5 个 KV group：default_models/llm_request/session/consolidation/logs）+ 自渲染 group（observability/web_search/see_image/web/providers/user_memory）各自加载；保存走 `PUT /config/app` body={group,key,data}（`app-settings-persist.ts`）。locale 走 `PUT /config/app` 整组（`locale` group）。
- **保存粒度**：当前 tab 内**所有 KV group** 的 draft 原子提交（多 group 时按顺序 PUT）
- **dirty 检测**：tab 内任一 KV group 有改动 → save-bar dirty 高亮
- **取消**：重置 draft 到 snapshot
- **切 tab**：dirty 未保存时切 tab → 弹确认 modal「丢弃改动 / 取消」（不静默丢）

> **[v0.0.316] 工具 tab / 可观测性 tab 统一保存**：引入 `useTabDirtyAggregator` hook + section `forwardRef` 受控化。工具 tab 4 个 section（web_search / web_fetch / see_image / bash）去掉独立 save/reset toolbar，注册到 tab 级聚合器（声明式 `onDirtyChange` callback 上报 dirty + ref save/reset）；可观测性 tab observability section 同理。tab 级 dirty = aggregator `dirtyMap` OR KV group dirty；tab 级 save = `aggregator.saveAll()`（Promise.allSettled 并行）+ KV group save。详见 `specs/tech/version_logs/v0.0.316/change_plan.md` D1-revised / D3 / D4-revised / D5。

- **例外（不进 page-tab dirty）**：
  - provider 编辑器（走独立 diff-save，provider-save）
  - user_memory（保持 saveMode='item'）
  - config_sync（[v0.0.318] 配置同步 tab，自渲染即时操作，无 dirty/save）
  - team_sync（[v0.0.319] 团队同步 tab，自渲染即时操作，无 dirty/save）

## 状态

## 视觉基线
- 左栏 sidebar ：通用区 section label+ 4 tab item + 分割线 + system-toggle + 收起区 2 tab
- 右栏：当前 tab 的 group 上下排列；每 group title （首）或 （后续 group）
- 字体 weight 仅 400/600（收敛，禁 serif/mono/bold 混用）
- 清硬编码 hex：`#26241f`/`#4a4640`/`#e3dccd`/`#fbfaf6`/`#3a3733`/`#ebe5d8` 全替 token（**主题预览卡 ThemeSwatch 例外**，demo 视觉契约保留 hex 模拟深浅底色）

## 复用关系
- 组合：`component-tab-tree-item`（tab 单项）/ `component-tab-save-bar`（page save bar）/
- 状态：`useAppSettingsConfig` hook（page-tab 级 dirty 跟踪）
