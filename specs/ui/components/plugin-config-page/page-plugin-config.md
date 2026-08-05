# page-plugin-config

> 文件: app/web/src/components/plugin-config-page/page-plugin-config.tsx

## 职责
插件配置页根。顶部 2 个 tab（**插件** / **扩展点**），切换 tab 渲染对应 section。挂载时 `GET /config/plugin` 取 inventory。
边界：不在此页管理 provider/model（已在 app config）；ext impl 的启用/排序在扩展点 tab 内。
：**配置只读化**——所有 ext impl 配置 + plugin 启停均代码声明（`app/plugins/scopes/*.yaml`），界面只读。
- 5 个写 handler改 noop
- plugin tab：传 `disabled` 给 section-plugin-list（plugin toggle 全 disabled）

## 状态 / 交互
- 挂载 `GET /config/plugin`（默认 scopeId=default）取 groups（含 plugins 与 extPoints）+ scopes 列表
- 点 tab 切换，主区换 section
-  ordered 拖拽 `handleReorder(pointId, from, to)`：v0.0.67 noop（drag handle disabled）但 ABC 三连 bug 修复逻辑保留在源码注释中
-  scope 维度状态（拆到 use-plugin-scope.ts）：
  - `handleSelectScope` 是唯一保留的实际功能 handler
- **plugin tab 不受 scope 影响**（plugin 级配置不分 scope，PRD OUT）；scope 切换器仅在扩展点 tab 顶层显示

## 复用关系
- 组合：`section-plugin-list`（插件 tab，传 disabled）、`component-scope-switcher`（扩展点 tab
