---
type: spec
title: ExtImpl Scope（ext-impl 配置层 scope 维度，代码声明）
priority: P0
status: active
updated: 2026-07-26
since: v0.0.26
---

# ExtImpl Scope（ext-impl 配置层 scope 维度，代码声明）

## 1. 概述：scope 是什么

**管什么**：ext impl **配置层**正交维度 `scope` 的数据模型 / 加载 / 校验 / 读视图接口（PluginManager + PluginConfigService）/ inventory 扩展。
**不管什么**：scope 选择逻辑（调用方自决，PRD 已 OUT）、plugin 级配置加 scope（PRD 已 OUT，plugin.enabled 全局）、scope 多级继承（PRD 已 OUT，只 default 一级）、scope 模板（OUT）。
本文是 `[P0]plugin_config.md` + `[P0]plugin_config_service.md` 的 scope 维度补充（不重写既有，只增量）。
**PRD**：`specs/prd/version_logs/v0.0.26/change_log.md`（语义权威，严禁改动）；**v0.0.67 设计**：`reqs/[working] v0.0.67.plugin_config_refactor/design.md`（代码化 + 删流氓）。

`scope` = ext impl **配置层**正交维度（agent loop 风格），与 `group`（功能分区，v0.0.71 起在 `app/plugins/groups.json` 唯一源，原 `ExtensionPoint.group` 字段已删）正交。引入动机：未来不同 agent loop 风格（如「快速对话」vs「深度推理」）可通过 scope 切换不同 impl 配置（开关/顺序/configValues），单一配置无法支撑。

| 维度 | `group`（v0.0.71 起迁 groups.json） | `scope`（本文） |
|------|--------------------------------|------------------------|
| 归属 | UI 分区元数据（groups.json `GroupMeta.extPoints[]`，v0.0.71 D1 删 EP.group 字段） | ext impl 配置层维度（代码声明 + per-EP 激活） |
| 语义 | 功能分类（provider/context-compact/web…） | agent loop 风格（default/forked/test…） |
| 取值 | groups.json 声明（id/label/description/extPoints） | **代码声明**（scopes/*.yaml：scopeId/name/description + groups→points→impls 树；loader 转扁平 activatedPoints/impls） |
| 默认 | groups.json 声明即定 | `default` 常驻基线（不可删），其他 scope 代码声明 |
| 运行时 | 不读 group（仅 UI 分区） | `getExtensionImpls(point, scopeId)` per-EP 按 scope 取配置 |
| 正交 | 与 impl 列表/order 无关 | 与 group 正交，与 impl 列表/order/configValues **绑定**（每 scope 独立一份） |

**核心模型（代码声明）**：
- **per-EP 继承 + 激活**：激活态由 YAML point 节点存在性声明（loader 转成 `ScopeConfig.activatedPoints`，不再写 activation record 落盘），按 **EP 粒度**；**`default` scope 无特权**（v0.0.206 删 plugin scope D6 default 短路）——default 激活集 = default.yaml 声明集，不配某 EP = 该 EP 对 default 关；其他 scope 每 EP **默认未激活**（运行时沿 extends 链回退，终点 default 配置）。
- **per-EP 全量替换（零 delta）**：一个 EP 在某 scope 的 YAML **不出现 = 继承 default 全量列表；出现 = 用自己声明的完整列表**（全量替换）。`impls: []` = 显式 0 个 active impl（不是继承占位）。
- **membership 即 active**：impl 在 scope 的 impls 列表中 = active，不在 = inactive（无 `enabled` 字段、无 `?? true` 兜底）；数组序即 order（无 `order` 字段）；exclusive EP 选中 = 列表唯一项（无 `selected`/`exclusivePicks`，validator 保证恰好 1）。
- **运行时 per-EP 回退**：`getExtensionImpls(point, scopeId)` 对该 EP：激活 → 取 scope 自己的全量列表；未激活 → 沿 extends 链逐级回退（链终点 default 全量列表）。
- **scope 元信息代码声明**：scopeId / name / description 由 `scopes/*.yaml` 声明（不依赖落盘 plugin_scope entity）。default 常驻不可删。
- **调用方自决 scope**：调用方决定用哪个 scopeId（PRD OUT scope 选择逻辑）。

> **v0.0.67 重构（design §3 D2）**：scope 元信息 + activatedPoints + impl 配置全部移到代码声明 `app/plugins/scopes/*.yaml`（schema 详 `plugin_system/[P1]scopes_config_decl.md`）。运行时读路径只读 `ScopeConfigProvider`（代码声明视图），不读 `plugin_scope` / `ext_impl_scope_activation` / `plugin_policy` 落盘。落盘 SchemaDef 保留实例化仅服务 lazy migrate 旧盘兼容。

---

## 2. scope 元信息 SchemaDef（落盘，v0.0.67 起 deprecated 读路径）

> **v0.0.67 起 deprecated 读路径**：scope 元信息（id/name/description）运行时从 `scopes/*.yaml` 取（`ScopeConfigProvider.listScopes`/`getScope`）。本节 SchemaDef 仅 lazy migrate 旧盘兼容 + 兼容历史动态 scope。

落盘 SchemaDef（保留兼容，新装无落盘 record）：

```typescript
const PluginScopeSchema = {
  entity: 'plugin_scope',
  engine: 'file',
  fs: {
    sharding: { shardKeyField: 'id', dirTemplate: 'plugin_scope/' },
    format: 'json',
  },
  fields: {
    id:        { type: 'string', required: true },
    name:      { type: 'string', required: true },
    description: { type: 'string', required: false },
    createdAt: { type: 'string', required: true },
  },
} as const satisfies SchemaDef;
```

**`default` scope**：在 `app/plugins/scopes/default.yaml` 声明（id='default', name='Default', description='默认基线 scope'）。落盘 PluginScopeStore.bootstrap 仍调（确保 lazy migrate 兼容），但运行时 inventory 不读它。

---

## 3. scope 激活记录模型（落盘，v0.0.67 起 deprecated 读路径）

> **v0.0.67 起 deprecated 读路径**：scope 的 per-EP 激活态从 `ScopeConfig.activatedPoints` 取（`ScopeConfigProvider.isPointActivated`/`listActivatedPoints`/`resolveSourceScope`）。本节 SchemaDef + 落盘 entity 保留实例化仅服务 lazy migrate 兼容；新装无 activation record，行为完全等同。

历史落盘形态（保留兼容）：
- **独立 entity `ext_impl_scope_activation`**（按 scopeId 分片），key=(scopeId, pointId)，data={activatedAt}。
- **default 短路（plugin scope D6，v0.0.206 已删）**：历史上 default scope 不写 activation record，运行时 `scopeId==='default'` 直接视为全 EP 激活；v0.0.206 起该短路删除——default 激活态同由 default.yaml point 节点声明（见 §4.2）。
- **cascade 删除语义（写端点 v0.0.67 已删）**：`deleteScope(scopeId)` 历史会 cascade 清 activation + plugin_policy impl record；v0.0.67 起 deleteScope 写端点返 405（详 §6）。

---

## 4. ExtImplConfigRecord 加 scope 维度（v0.0.67 起代码声明）

### 4.1 逻辑 key 改造：`(scopeId, implId)`

`ExtImplConfigRecord`（见 `[P0]plugin_config.md` §2）逻辑 key 由 `implId` 扩展为 `(scopeId, implId)`。同一 impl 在不同 scope 下可有不同的 active 状态（membership）/order/configValues。

### 4.2 代码声明机制

**active 列表/order/configValues 数据源 = `app/plugins/scopes/*.yaml`**（每 scope 一文件，groups→points→impls 树格式）。Loader 把 YAML 树转成扁平 `ScopeConfig`：
- `scopeId` / `name` / `description`：scope 元信息
- `activatedPoints: string[]`：point 节点存在 = 该 scope 配置此 EP（per-EP 继承判定用）
- `impls: Record<implId, ScopeImplConfig>`：implId → `{ order?, configValues? }`；**key 存在 = active impl（membership，全量列表，无 delta merge）**

**Loader**：`ScopeConfigLoader.loadAll()`（`app/server/src/plugin/scope-config-loader.ts`）扫 `scopes/` 目录所有 `*.yaml` → `ScopeConfig[]`。Loader 做形状校验（scopeId/name/groups 必填 + 类型对），不做语义校验（impl 在 manifest 注册、point 在 registry、exclusive 恰好 1）——那是 `ScopeConfigValidator` 的职责。YAML 中旧字段 `selected`/`enabled` loader 不读、不 throw、不 warn（解析分支已删）。

**Provider**：`LoadedScopeConfigProvider`（`scope-config-provider.ts`）实现 `ScopeConfigProvider` interface，把 `ScopeConfig[]` 暴露为运行时读视图（`listScopes`/`getScope`/`isPointActivated`/`listActivatedPoints`/`resolveSourceScope`/`getImplConfig`）。`getImplConfig(sourceScope, implId)` 返 `undefined` = 该 impl 不在 sourceScope active 列表（membership 判定，**不再 default true**）。bootstrap 注入同一份给 PluginManager + PluginConfigService。

**default 无特权（v0.0.206 删 plugin scope D6）**：Provider 对 default 与非 default 同路径——`isPointActivated('default', pointId)` = default.yaml 是否声明该 point（不配 = 关）；`listActivatedPoints('default')` 返 default.yaml 声明集（签名无 `allPointIds` 参）。「membership 即启用」对 default 同效：default.yaml 不配某 EP → `getExtensionImpls(point, 'default')` 拿不到任何 impl（v0.0.206 channel EP 接入后此语义 load-bearing）。

> **default.yaml 满基线**：default scope 显式列出全部期望 active 的 impl（membership 全量；含 `threshold_should_compact.compactRatio=0.6` 非默认 configValues）。**新模型无「注册未声明 → 默认 active」兜底**——注册但未列进 default 任何 EP 列表的 impl = inactive（旧 `?? true` fallback 已废）；漏列 = 功能静默不生效，故「新增 impl 必须同步加进 default.yaml」（详 `plugin_system/[P1]scopes_config_decl.md §4` 强约定）。
>
> **test-env fallback**：bootstrap 在 test 环境动态收 fixture EP 进 `_test_fixtures` group（不污染生产 inventory），见 `app/server/src/bootstrap.ts` 注释。

> **plugin 级 policy 不加 scopeId**（PRD OUT：plugin.enabled 是全局开关，scope 只影响 impl 选择）。plugin 级恒 enabled=true（代码声明不存 plugin 级开关）。

### 4.3 exclusive EP 恰好 1 active（无 exclusivePicks 字段）

exclusive EP 的「选中项」= 该 scope impls 列表中**恰好 1 个** active impl：
- YAML 写法：exclusive EP 的 impls 数组只列 1 项（要换选中 = 直接改数组项）。
- 启动校验（D3 硬失败）：`activatedPoints` 中每个 cardinality=exclusive 的 EP，其注册 impl 在该 scope `impls` 字典中 active 的数量必须恰好 1（0 个或多于 1 都 throw，详 `[P1]scopes_config_decl.md §3.2`）。
- 运行时无 exclusive 分支：统一 filter membership + 按 order 排序后，validator 保证的恰好 1 项自然成为 `[0]`。

### 4.4 lazy migrate 策略（v0.0.150 起 A 决策已删）

历史上 `PluginPolicyStore.migrateLegacyImplKeys`（v0.0.26 起）+ `migrateLegacyExclusiveRecords`（v0.0.55 起）启动时调，幂等：
1. 扫 `plugin_policy` kind='impl' shard，key 不含 `::` 的重写为 `default::${implId}`（保留 data 不变）。
2. 清 data 含 `exclusive: true` 字段（v0.0.55 删 exclusive 字段）。
3. 已 migrate 的 record 跳过（幂等）。

**v0.0.150 起 A 决策**：无真实用户，旧 ad-hoc 迁移文件（`plugin-policy-migrate.ts`）整段删，`PluginPolicyStore.migrateLegacyImplKeys` / `migrateLegacyExclusiveRecords` 两方法 + `PluginConfigService` constructor 调用点全删。落盘 `plugin_policy/` record 仅运行时**不读**（v0.0.67 起读路径只走 `ScopeConfigProvider` 代码声明），删 lazy migrate 不影响新装实例；旧盘 record 仍在但不被读。详 `specs/tech/version_logs/v0.0.150/change_log.md`。

---

## 5. PluginManager 接口（per-EP 回退，统一 getExtensionImpls 无 cardinality 分支）

### 5.1 TS 重载签名（不变）

```typescript
interface PluginManager {
  /** 单参重载：≡ getExtensionImpls(point, 'default')，向后兼容 */
  getExtensionImpls<T>(point: ExtensionPoint<T>): T[];
  /** 带 scopeId 重载：per-EP 回退（激活→scope 配置，未激活→default 配置） */
  getExtensionImpls<T>(point: ExtensionPoint<T>, scopeId: string): T[];
}
```

### 5.2 per-EP 回退解析（membership active + 统一排序）

`getExtensionImpls(point, scopeId)` 解析（`plugin-manager.ts`，类型无关统一路径）：

```
entries = registry.getByPoint(point.id)
sourceScope = scopeConfigs.resolveSourceScope(scopeId, point.id)
  // 激活 → scopeId 自己（取该 scope 全量列表）；未激活 → 沿 extends 链逐级回退，终点 'default'（继承 default 全量列表）
active = entries.filter(e => scopeConfigs.getImplConfig(sourceScope, e.implId) !== undefined)
  // membership active：key 在 impls 字典 = active；无 ?? true 兜底
sorted = [...active].sort((a,b) =>
  (getImplConfig(sourceScope, a.implId)?.order ?? Infinity) - (getImplConfig(sourceScope, b.implId)?.order ?? Infinity))
  // 统一按 YAML 数组序升序（list 不关心顺序但 unified 跑，无害）；同 order 按 registry 登记序
instantiate（按 sourceScope 取 configValues）：
  merged = deepMerge(extractDefaults(configSchema), getImplConfig(sourceScope, implId)?.configValues ?? {})
```

**无 cardinality 分支**：运行时不按 exclusive/list/ordered 分路——exclusive 由 validator 保证恰好 1 active，统一排序后 `[0]` 即唯一项；ordered 按数组序；list 全返。`resolveByCardinality` switch 与 `exclusivePick` 函数已删。

**default 无特权（v0.0.206 删 plugin scope D6）**：`resolveSourceScope('default', pointId)` 无短路特判——default 是 extends 链 root 终点，循环走到 `'default'` 自然返回（行为不变但语义改变：default 激活集 = default.yaml 声明集，非「永远全激活」）。

channel impl（如 `channel.feishu`）v0.0.206 起**经本路径**——`ChannelManager` 调 `getExtensionImpls(ChannelPoint, 'default')` 取无状态 impl（构造签名 `(implId, cfg)` 标准 EP 投影），scope 门在此物化：feishu 未在 default.yaml 激活 → 拿不到 impl → 配置连不上（详 `../channel/[P0]channel_manager.md`）。

### 5.3 cardinality 的消费方（validator + UI，运行时不分支）

EP 的 cardinality（ordered/list/exclusive）是 intrinsic 属性（`extension-point.ts` 声明，保留不动），但**运行时读取类型无关**（§5.2 统一路径）。cardinality 只剩两个消费方：
- **validator**：exclusive EP 在 activatedPoints → impls 列表恰好 1 active（启动硬失败，详 `[P1]scopes_config_decl.md §3.2`）。
- **UI / inventory**：inventory API 的 `type` 字段透传 cardinality，前端按 type 渲染 radio/checkbox/ordered；`selected` 派生 = exclusive EP active 中 order 最小者（详 `[P0]plugin_config_service.md §3.2`）。

---

## 6. PluginConfigService 接口（v0.0.67 起只读）

> **v0.0.67 起 PluginConfigService 写方法全删（design §3 D4）**：v0.0.66 前的 `setImplEnabled` / `setExclusive` / `setPointOrders` / `setImplConfig` / `setEnabled` / `setConfig` / `createScope` / `deleteScope` / `activateEp` / `deactivateEp` / `persist` 全部移除。HTTP 写端点同步返 405 Method Not Allowed（详 `specs/api/overall/03-config-center.md`）。

保留的只读方法（数据源 = `ScopeConfigProvider`）：
- `inventory(scopeId?): PluginInventoryTree` — 全量树（按 scope 视图）。
- `listScopes(): PluginScope[]` — 全部 scope（default 首位）。
- `getScope(scopeId): PluginScope | undefined` — 单 scope 元信息（代码声明优先；落盘 fallback 兼容历史）。
- `listActivatedPoints(scopeId): string[]` — 激活的 EP 列表（= 该 scope yaml 声明集；default 同路径，返 default.yaml 声明集）。

详细签名 + inventory 树结构见 `[P0]plugin_config_service.md §2`。

---

## 7. inventory 扩展（按 scopeId 视图）

`PluginConfigService.inventory(scopeId)` 返回该 scope 视图 + 每 EP 激活状态。详细字段结构见 `[P0]plugin_config_service.md §2.1`，算法要点：

1. 对每个 point，查 `ScopeConfigProvider.isPointActivated(scopeId, pointId)` → activated（= 该 scope yaml 是否声明此 point；default 无特权同路径）。
2. 对该 point 的每个 impl，取配置源 = `ScopeConfigProvider.resolveSourceScope(scopeId, pointId)`（激活→scopeId；未激活→'default'）。
3. effective order 算法按「取配置源 scope」跑（computeEffectiveOrders 的 getImplPolicy 回调按源 scope 取代码声明 order）。
4. ext impl 节点的 `enabled` = membership（`getImplConfig(sourceScope, implId) !== undefined`）；`order`/`config` = 源 scope 的代码声明值（config = JOIN manifest default ⊕ configValues）；`pointActivated` 字段 = 该 point 的 activated；`selected` 派生 = exclusive EP active 中 order 最小者（详 `[P0]plugin_config_service.md §3.2`）。

---

## 8. subagent scope drift 清理（v0.0.67 D6）

**问题**：dev/test 落盘 `plugin_scope/subagent` 是历史 drift（无代码创建者，由旧版 subagent 流程遗留）。该 scope 在代码声明中**不存在**（`scopes/*.yaml` 只有 default/forked 两个；test scope 由 `buildTestScopeConfig()` 代码构造）。

**清理策略**：
1. v0.0.67 起运行时读路径不读落盘 `plugin_scope/`，drift 不影响新装实例。
2. dev/test 环境的 drift record 由一次性清理脚本删（`rm -rf {dataDir}/plugin_scope/subagent.json` + `plugin_policy/impl/{subagent records}`）。
3. 不写自动 migration（drift 是 dev 数据，不是 schema 升级）。

---

## 8.5 zhipu configSchema 删 apiKey 的 scope 影响（v0.0.72 核对）

**核对结论**：zhipu `web_search_provider` impl 删 `plugin.json` 的 `configSchema.apiKey`（凭证迁 `app_config.web_search`，见 `specs/tech/config/[P0]app_config.md §3.6`）——**对 scope 配置层无影响**：

- **scope configValues**：`scopes/*.yaml` 不含 zhipu apiKey（D1 secret 不进代码声明早已排除），删 `configSchema.apiKey` 不影响 `scopes/*.yaml` 的 zhipu impl 条目（其 `configValues` 本就为空或不包含 apiKey）。
- **PluginManager 实例化**：`(implId, cfg)` 仍按 `merge = {...extractDefaults(configSchema), ...scopeConfigs.getImplConfig(scope, implId)?.configValues}` 构造 impl cfg——删 apiKey 后 `extractDefaults` 不再产出 `apiKey` 默认值，`cfg.apiKey` 来源只剩 `scopeConfigs.configValues`（v0.0.67 已不声明，即恒为空）。
- **运行时凭证**：v0.0.72 起 impl 不再从构造器 `this.cfg` 读凭证，改从 `search`/`isAvailable` 入参 cfg 读（tool 从 `app_config.web_search.credentials[type]` 构造传入）。详见 `specs/tech/agent/tools/[P1]web_search_tool.md §2 末段「impl 构造器 cfg 与运行时 cfg 的语义关系」+ §7`。
- **scope 激活/选中**：不受影响（`web_search_provider` EP 的 default scope 激活 impl 为 `[zhipu_coding_plan, zhipu_api]` 两 impl 均 active；EP 为 list 类型，无单选语义，运行时由 tool 按 `app_config.web_search.type` 精确路由，详见 v0.0.72 EP 修订）。

> 即：删 zhipu `configSchema.apiKey` 仅清空 `extractDefaults` 的 apiKey 默认值（本就无用，secret 不进代码声明），不影响 scope 配置层任何链路。impl 凭证读取链路从「构造器 cfg / env 回退」迁移到「运行时入参 cfg」，与 scope 层正交。

## 9. 边界

| 零件 | 归属 |
|---|---|
| scope 代码声明 schema（scopes/*.yaml 字段语义 + 加载/校验链路） | `plugin_system/[P1]scopes_config_decl.md` ✅ |
| scope 元信息 + 激活记录落盘 SchemaDef（deprecated 读路径） | 本文件 §2/§3 |
| ExtImplConfigRecord 数据形状（enabled/order/configValues） | `[P0]plugin_config.md` §2 |
| getExtensionImpls 统一投影（membership filter + 数组序排序） | 本文件 §5 + `plugin_system/[P0]plugin_manager_interface.md` |
| channel impl 组合（v0.0.206 起经 getExtensionImpls scope 解析 + per-config connect） | `../channel/[P0]channel_manager.md` |
| effective order 末尾补位算法（inventory 展示） | `[P0]plugin_config_service.md` §3.1 |
| inventory 树结构 + enabled/selected membership 派生 | `[P0]plugin_config_service.md` §2/§3.2 |
| HTTP 端点契约（GET 保留 / PUT 写端点返 405） | `specs/api/overall/03-config-center.md` |
| scope 选择逻辑（调用方按什么规则决定 scopeId） | **OUT**（PRD 明确排除） |
| scope 模板 / 多级继承 / 跨 EP 批量激活 | **OUT** |

> 变更历史见 [`log.md`](log.md)；跨版本发布说明见 [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)。
