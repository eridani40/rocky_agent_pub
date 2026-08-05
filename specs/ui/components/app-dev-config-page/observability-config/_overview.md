# observability-config 可观测性配置（概念权威源）

> 文件: app/web/src/components/app-dev-config-page/observability-config/*.tsx
> 视觉契约: reqs/v0.0.11/easy-opc-config-v10.html（ObservabilityGroup ~L387-474 + ObsDetailEditor ~L476-553）+ reqs/v0.0.11/list.png + detail.png
> 数据权威: specs/tech（observability manager / config store — 本 UI 只管「长什么样 / 怎么交互」，概念归 tech）

## 1. 概念定位
可观测性是 **dev config 页内的一个特殊 group**（不是普通 key-card group）：
- 普通 group（debug / storage）：一组 `{key,value}`，由 `section-config-layout` 右侧 key-card 列表渲染。
- **observability group**：一组**后端实例配置**（list-of-objects），结构 `{id,name,type,baseUrl,publicKey,secretKey,enabled,desc,logPhysical}`，右侧渲染为 provider-card 列表，点项进入二级详情编辑视图。
> 本 group 在 `section-group-list`（左栏）表现为一个普通可选项 `observability`，选中后 `section-config-layout` 右侧**不渲染 key-card 列表，而是渲染本组件**（路由分支）。tech 侧：observability manager 对 `enabled === true` 的项依次调用，异步、容错、不影响 agent loop。

## 2. 数据模型（UI 侧契约）
> 「列表（多 backend）」是用户明确决策（req）：每项独立 id，独立启停，独立删除。
