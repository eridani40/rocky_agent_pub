# v0.0.26 技术变更日志

> 概述：ext-impl 配置层加 `scope` 维度（plugin-by-scope）。给 ext impl 配置层引入正交维度 scope（agent loop 风格），per-EP 继承 + 激活模型（default 全激活基线，其他 scope 按 EP 激活，激活初始值复制 default snapshot 后独立），保留 `getExtensionImpls(point)` 兼容 + 新增带 scopeId 重载（per-EP 回退），scope 一等实体 CRUD，ExtImplConfigRecord key 改 `(scopeId, implId)` + migrate default，UI 扩展点 tab 顶层加 scope 切换器。
> PRD：`specs/prd/version_logs/v0.0.26/change_log.md`（语义权威）；对齐决策：`states/user_query.md` v0.0.26 段。
> 新概念 scope 完整技术 spec：`specs/tech/config/[P0]ext_impl_scope.md`（架构产出，权威）。

## 1. 锁定决策（架构师定，对齐 PRD/user_query）

| # | 决策点 | 选定 | 落地 |
|---|--------|------|------|
| D1 | scope 激活记录模型 | 独立 entity `ext_impl_scope_activation`（按 scopeId 分片） | `ext_impl_scope.md` §3 + `schema_defs/scope_activation.ts` |
| D2 | ExtImplConfigRecord 复合 key 实现 | 编码进 `plugin_policy.key` 为 `${scopeId}::${implId}`，SchemaDef 不变 | `ext_impl_scope.md` §4.2 + `plugin-policy-store.ts` 改 API 签名 |
| D3 | migrate 策略 | 启动时 lazy（扫 kind='impl' shard，key 不含 `::` 的重写为 `default::${implId}`），幂等 | `ext_impl_scope.md` §4.3 + `plugin-policy-store.ts` migrateLegacyImplKeys + bootstrap 调用 |
| D4 | 写未激活 EP 语义 | 自动激活 + 复制 default snapshot + 应用写入（PRD 倾向） | `ext_impl_scope.md` §6.3 + PluginConfigService 写 op 入口自动激活 |
| D5 | scope entity 分片 | 不分片（单目录 plugin_scope/，scope 总数有限） | `schema_defs/plugin_scope.ts` |
| D6 | default scope activation | 不写 activation record，运行时 scopeId==='default' 视为全激活 | PluginManager + PluginConfigService 短路逻辑 |
| 命名 | scope（避撞 EP.group） | user_query v0.0.26 |
| 继承粒度 | per-EP（每 EP 独立激活/继承） | user_query v0.0.26 |
| 激活初始值 | 复制 default 当前快照（snapshot 后独立） | user_query v0.0.26 |
| 回退语义 | 取消激活 → 该 EP 回退继承 default | user_query v0.0.26 |
| 双接口 | 保留 getExtensionImpls(point) ≡ default + 新增带 scopeId | user_query v0.0.26 |
| scope 删除 | 非 default 可删 cascade；default 不可删 | user_query v0.0.26 |
| scope 选择逻辑 | OUT（调用方自决） | user_query v0.0.26 |

## 2. tech spec 改动清单

| spec | version | 改动摘要 |
|------|---------|---------|
| `config/[P0]ext_impl_scope.md` | 新增 1.0 | scope 完整技术模型（一等实体 / 激活记录 / 复合 key / migrate / PluginManager + PluginConfigService 扩展 / inventory / 激活快照事务语义 / 文件清单 / 决策汇总） |
| `config/[P0]plugin_config.md` | 3.0 → 3.1 `[v0.0.26 corrected]` | §5 持久化按实现修正（单 entity `plugin_policy` 按 kind 分片，非原「plugins.policy.json 单文件」） |
| `config/[P0]plugin_config_service.md` | 3.0 → 3.1 `[v0.0.26 corrected]` | §4.4 持久化按实现修正（同上） |
| `plugin_system/[P0]plugin_manager_interface.md` | （doc-modifier 同步） | §2 加 getExtensionImpls 双接口重载说明；§3 加 per-EP 回退解析 |
| `api/overall/03-config-center.md` | 1.3 → 1.4 `[v0.0.26 modified]` | §3 加 scope CRUD + EP 激活端点；GET /config/plugin 加 scopeId query + scope/scopes/pointActivated 字段；PUT op 加 scopeId? |
| `ui/components/plugin-config-page/component-scope-switcher.md` | 新增（架构总纲） | scope 切换器组件 spec（Props/testid/视觉方向/布局稳定性） |
| `ui/components/plugin-config-page/section-ext-point-area.md` | modified | Props 加 currentScopeId/activatedPoints/onActivateEp/onDeactivateEp；EP header 激活/取消激活按钮 + 灰显；testid 加 |
| `ui/components/plugin-config-page/page-plugin-config.md` | modified | scope 维度状态（currentScopeId/切换/激活/创建/删除）；scope-switcher 挂载位置；testid 加 |

## 3. 核心设计原则（doc-modifier 须同步进 overall）

- **scope 是配置层正交维度（非 EP.group）**：group = EP 固有属性（功能分类，声明期）；scope = ext impl 配置层维度（agent loop 风格，运行时可切）。两者正交：group 不读运行时（仅 UI 分区），scope 绑定 enabled/order/configValues（每 scope 独立一份）。
- **per-EP 继承 + 激活模型**：default 全 EP 永远激活（基线）；其他 scope 每 EP 默认未激活（运行时回退取 default 配置）；激活初始值复制 default snapshot（之后独立，default 改动不传导）；取消激活清配置回退继承 default。
- **scope 一等实体 + cascade 删除**：scope 独立存储（plugin_scope entity），删除非 default scope 时 cascade 清 activation record（整 shard）+ plugin_policy impl record（按 scopeId 过滤）。
- **复合 key 编码 `${scopeId}::${implId}`**：plugin_policy SchemaDef 不变，复合 key 编码进 key 字段；零 schema 迁移成本。
- **启动 lazy migrate**：bootstrap 扫 kind='impl' shard，旧 key（不含 `::`）重写为 `default::${implId}`；幂等；数据零损失。
- **写未激活 EP 自动激活**：setImplEnabled/setExclusive/setPointOrders/setImplConfig 在未激活 EP 上调用时，自动 activateEp（复制 default snapshot）+ 应用写入（原子）。API 幂等可预测，UI 顺畅。
- **default 短路**：scopeId==='default' 不查 activation 表（永远全激活基线），与单参 getExtensionImpls 行为完全一致（向后兼容）。

## 4. 文件级变更清单（planner/coder 依据）

### 后端（app/server/）

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `src/plugin/schema_defs/plugin_scope.ts` | 新增 | `PluginScopeSchema`（entity=plugin_scope，id/name/description/createdAt，不分片单目录） |
| `src/plugin/schema_defs/scope_activation.ts` | 新增 | `ScopeActivationSchema`（entity=ext_impl_scope_activation，按 scopeId 分片，ULID + scopeId + pointId + activatedAt） |
| `src/plugin/plugin-scope-store.ts` | 新增 | `PluginScopeStore`（list/get/create/delete + `ensureDefault()` bootstrap） |
| `src/plugin/scope-activation-store.ts` | 新增 | `ScopeActivationStore`（has(scopeId,pointId)/set/delete/listByScope/deleteAllByScope cascade） |
| `src/plugin/plugin-policy-store.ts` | 修改 | impl 级 API 加 scopeId（getImpl/setImpl/deleteImpl/listImpls/listImplsByPoint 签名改）；key 编码 `${scopeId}::${implId}`；新增 `migrateLegacyImplKeys()` |
| `src/plugin/plugin-config-service.ts` | 修改 | 写 op 加 scopeId?（缺省 default）；新增 listScopes/createScope/deleteScope（cascade）/activateEp（snapshot 复制 + activation 写）/deactivateEp（清 activation + impl record）/listActivatedPoints；inventory 加 scopeId? 参数 + scope/scopes/pointActivated 字段；写未激活 EP 自动激活逻辑 |
| `src/plugin/plugin-manager.ts` | 修改 | getExtensionImpls 加 scopeId 重载；isActive/resolveByCardinality/instantiate 按 scopeId 取源（激活取 scope，未激活取 default）；抽 `resolveScopeSource(scopeId, pointId)` helper；default 短路 |
| `src/plugin/order-utils.ts` | 修改（小） | computeEffectiveOrders 的 getImplPolicy 回调签名按源 scope 取 order record |
| `src/plugin/index.ts` | 修改 | 导出新 store/类型；bootstrap 调 migrateLegacyImplKeys + PluginScopeStore.ensureDefault |
| `src/handlers/config.ts` | 修改 | 新增 handlePluginScopes（GET/POST/DELETE scope）+ handleScopeActivation（POST/DELETE/GET activate）；handlePluginConfig GET 加 scopeId query；PUT 现有 op body 加 scopeId 透传 |
| 路由注册处（`src/index.ts` 或 `src/handlers/routes.ts`） | 修改 | 注册 `/config/plugin/scopes` + `/config/plugin/scopes/:id` + `/config/plugin/scopes/:id/activate/:pointId` + `/config/plugin/scopes/:id/activations` |
| `src/plugin/__tests__/` | 新增 | scope/activation/migrate/自动激活 UT case |

### 前端（app/web/）

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `src/lib/api-client.ts` | 修改 | 新增 listScopes/createScope/deleteScope/activateEp/deactivateEp/listActivations 函数；getPluginInventory 加 scopeId 参数；PluginPutOp 联合各 op 加 scopeId?；PluginInventory 类型加 scope/scopes + extImpl 加 pointActivated |
| `src/components/plugin-config-page/component-scope-switcher.tsx` | 新增 | scope 切换器组件（实现 component-scope-switcher.md spec） |
| `src/components/plugin-config-page/page-plugin-config.tsx` | 修改 | scope 状态（currentScopeId + 切换/激活/创建/删除 handlers）；扩展点 tab 顶层挂 component-scope-switcher；impl 写 op 携带 scopeId |
| `src/components/plugin-config-page/section-ext-point-area.tsx` | 修改 | Props 加 currentScopeId/activatedPoints/onActivateEp/onDeactivateEp；EP header 激活/取消激活按钮 + 灰显态 + 「继承 default」提示；impl 组件传 disabled |
| `src/components/plugin-config-page/component-ext-impl-{radio,checkbox,ordered}.tsx` | 修改（小） | 加 disabled prop（灰显开关/拖拽/配置入口） |

## 5. 不在范围（PRD OUT 重申）

- scope 选择逻辑（调用方按什么规则决定 scopeId）— 调用方自决
- scope 级 plugin 级配置（PluginConfigRecord 加 scope）— plugin.enabled 全局开关
- scope 模板 / 多级继承（scope A 继承 scope B）— 只 default 一级继承
- scope 跨 EP 批量激活 — 激活是 per-EP 粒度
- 视觉保真度比对 — 本版本无设计稿（hasDesign=false），E2E 仅单图功能检查
