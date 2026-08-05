# page-app-settings-merged（应用设置合并页）

> 文件: app/web/src/components/app-dev-config-page/page-app-settings-merged.tsx

## 职责
应用设置合并页根（薄壳，~200 行）。**左侧 tab 竖排导航树**（通用区 5 tab + 系统设置收起区 2 tab）+ **右侧按选中 tab 渲染对应 group 集合**（上下排列，每 group title + 区域间隔）+ **底部 page-tab 级 sticky save-bar**（dirty 检测 + 保存/取消）。

## 保存交互（page-tab 级）
**数据源**：REST CRUD 无 SSE——挂载 `useAppSettingsConfig` 并发 `GET /config/app?group=<g>&key=default`（5 个 KV group：default_models/llm_request/session/consolidation/logs）+ 自渲染 group（observability/web_search/see_image/web/providers/user_memory）各自加载；保存走 `PUT /config/app` body={group,key,data}（`app-settings-persist.ts`）。locale 走 `PUT /config/app` 整组（`locale` group）。
- **保存粒度**：当前 tab 内**所有 KV group** 的 draft 原子提交（多 group 时按顺序 PUT）
- **dirty 检测**：tab 内任一 KV group 有改动 → save-bar dirty 高亮
- **取消**：重置 draft 到 snapshot
- **切 tab**：dirty 未保存时切 tab → 弹确认 modal「丢弃改动 / 取消」（不静默丢）
- **例外（不进 page-tab dirty）**：
  - provider 编辑器（走独立 diff-save，provider-save）
  - observability list+detail（保持独立 save-bar）
  - user_memory / web_search（保持 saveMode='item'）

## 状态

## 视觉基线
- 左栏 sidebar ：通用区 section label+ 4 tab item + 分割线 + system-toggle + 收起区 2 tab
- 右栏：当前 tab 的 group 上下排列；每 group title （首）或 （后续 group）
- 字体 weight 仅 400/600（收敛，禁 serif/mono/bold 混用）
- 清硬编码 hex：`#26241f`/`#4a4640`/`#e3dccd`/`#fbfaf6`/`#3a3733`/`#ebe5d8` 全替 token（**主题预览卡 ThemeSwatch 例外**，demo 视觉契约保留 hex 模拟深浅底色）

## 复用关系
- 组合：`component-tab-tree-item`（tab 单项）/ `component-tab-save-bar`（page save bar）/
- 状态：`useAppSettingsConfig` hook（page-tab 级 dirty 跟踪）
