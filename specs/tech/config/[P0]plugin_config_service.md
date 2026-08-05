---
type: spec
title: PluginConfigService（插件配置管理面，v0.0.67 起只读）
priority: P0
status: active
updated: 2026-07-26
since: v0.0.2
---

# PluginConfigService（插件配置管理面，v0.0.67 起只读）

## 1. 概述与定位

**管什么（v0.0.67 起只读化）**：插件/ext impl 的两级**管理状态的读视图**——inventory 全量树（含 `selected` 派生字段）/ scope 列表 / scope 激活的 EP 列表 / 单 scope 元信息。所有数据源 = 代码声明 `app/plugins/scopes/*.yaml`（经 `ScopeConfigProvider`）。
**不管什么**：发现/安装（→ `plugin_system/[P1]discovery_and_install_interface.md`）、生命周期（→ `plugin_system/[P1]plugin_lifecycle.md`）、注册表 getter（→ `plugin_system/[P0]plugin_manager_interface.md`）、两级 config 值的数据形状（→ `[P0]plugin_config.md`）、代码声明 schema 形状（→ `plugin_system/[P1]scopes_config_decl.md`）。
总览见 `[index.md`](index.md)。

PluginConfigService 是 PluginConfig 域的**管理面 / 全量视图服务**：在「登记的 ext impl 集合」与「实例化」之间插入一层策略，让运维决定**谁启用、谁生效、什么顺序**。它是运行时不沙箱的补偿（见 `plugin_system/[P1]isolation_and_threat_model.md`）——安全不靠隔离代码，靠「可控地选择信任谁、启用谁」。

**v0.0.67 重构（design §3 D2 + D4）**：
- **配置代码化**：所有 active 状态（impls 列表 membership）/ order（数组序）/ activatedPoints = 代码声明（`app/plugins/scopes/*.yaml`），不再读落盘 `plugin_policy/`。
- **写方法全删（D4）**：`setEnabled` / `setImplEnabled` / `setExclusive` / `setPointOrders` / `setOrder` / `setConfig` / `setImplConfig` / `createScope` / `deleteScope` / `activateEp` / `deactivateEp` / `persist` 全删。HTTP 层 `PUT /config/plugin` + scope 写端点同步删（返 405 Method Not Allowed，详见 `specs/api/overall/03-config-center.md`）。
- **v0.0.150 起 PluginPolicyStore + PluginScopeStore lazy migrate 已删**：原「保留实例化仅服务 lazy migrate 旧盘升级兼容（`migrateLegacyImplKeys` + `migrateLegacyExclusiveRecords`）」的策略在 v0.0.150 A 决策下整段删（`plugin-policy-migrate.ts` 文件删 + 调用点清理），落盘 record 运行时本就不读，删除零行为影响。
- **plugin 级 enabled**：恒 true（native 受信，代码声明不存 plugin 级开关，PRD OUT）。

### 读路径：PluginManager 与本服务共享 ScopeConfigProvider

PluginManager 与 PluginConfigService **同源**读 `ScopeConfigProvider`（代码声明视图，bootstrap 注入同一份 `LoadedScopeConfigProvider`）。两者分工：
- **PluginManager**：运行时 `getExtensionImpls(point, scopeId)` 投影 + 实例化 impl 类（详见 `plugin_system/[P0]plugin_manager_interface.md`）。
- **PluginConfigService（本服务）**：管理面 inventory（全量树 JOIN 数据，给 UI/HTTP 用）+ scope 元信息 + 激活 EP 列表。

## 2. 接口契约（v0.0.67 起只读）

```typescript
interface PluginConfigService {
  /**
   * 全量树（v0.0.71 起 group → point → impl 三层嵌套 + scope 视图）。
   * 数据源 = ScopeConfigProvider（代码声明 scopes/*.yaml）+ GroupMetaProvider（groups.json）：
   *   - groups[]：按 groups.json 声明序聚合，每 group 下 points[]，每 point 下 impls[]
   *     （pluginId/pointId/implId/type/pluginEnabled/enabled/order/configSchema/config/
   *     description/pointDescription/pluginDescription/selected；v0.0.71 删 schemaConfig/pointActivated）
   *   - plugins[]：plugin-centric 平面（plugin 级 enabled 恒 true）
   *   - scope：当前查询 scope 元信息（id/name/description）
   *   - scopes：全部 scope 列表（供 UI 切换器，default 首位）
   *
   * scopeId 缺省 = 'default'（向后兼容）。
   * per-EP 回退：未激活 EP → 沿 extends 链回退，终点取 default 配置。
   * default 无特权（v0.0.206 删 plugin scope D6）：scopeId='default' 激活集 = default.yaml 声明集（不配 = 关）。
   */
  inventory(scopeId?: string): PluginInventoryTree;

  /** 列所有 scope（default 首位）。v0.0.67：从 ScopeConfigProvider 取（不读落盘）。 */
  listScopes(): PluginScope[];

  /** 取某 scope 元信息（代码声明优先；落盘 fallback 兼容历史动态 scope）。 */
  getScope(scopeId: string): PluginScope | undefined;

  /**
   * 查某 scope 的激活 EP 列表。
   * v0.0.67：从 ScopeConfigProvider 取（activatedPoints 字段）；default 返 default.yaml 声明集（v0.0.206 起无特权同路径）。
   */
  listActivatedPoints(scopeId: string): string[];
}
```

> **写方法已全删（D4）**：v0.0.66 前的 `setEnabled` / `setImplEnabled` / `setExclusive` / `setPointOrders` / `setImplConfig` / `setConfig` / `createScope` / `deleteScope` / `activateEp` / `deactivateEp` / `persist` 全部移除。HTTP 写端点同步返 405（详见 `specs/api/overall/03-config-center.md` §3.2/§3.4）。前端编辑控件 disabled + 隐藏（详见 `specs/ui/components/plugin-config-page/`）。
>
> **inventory group-centric vs enabled 门正交**：group（v0.0.71 起来自 groups.json，非 EP.group 字段）只决定 ext impl 在 UI 分区树中的位置（展示分区），enabled（plugin.enabled ∧ impl.enabled 两级，但 v0.0.67 plugin 级恒 true）决定该 ext impl 是否进运行时 active 投影（行为门）。一个 ext impl 可以在 `group="provider"` 分区但 `enabled=false`——它仍出现在 provider 分区，但不生效。两者正交，互不读。

### 2.1 inventory 树结构（PluginInventoryTree，v0.0.71 嵌套化）

> **v0.0.71 D3 破坏性 schema 变更**：`groups[]` 由扁平 `extImpls[]`（impl 跨 point 聚合）改为**嵌套** `groups[].points[].impls[]`（impl 显式归 point 节点下），对齐「scope → group → point → impl」用户心智。`ExtImplNode` 删 `schemaConfig?`（D7）+ 新增 `configSchema?`（D7）+ 删 `pointActivated`（信息上提到 `points[].activated`，同 point 共享避免冗余）+ `config` 始终 = JOIN(manifest default ⊕ scope configValues)（bug-A 修复）。详 `specs/api/version_logs/v0.0.71.md`。

```typescript
/**
 * inventory 返回的全量树（v0.0.71：group → point → impl 三层嵌套 + scope 维度）。
 * v0.0.67：scopes 类型从 PluginScope（含 createdAt 落盘信封）改为 ScopeMeta（代码声明视图）。
 * v0.0.71 D3：groups[].extImpls[]（扁平）→ groups[].points[].impls[]（嵌套，破坏性）。
 */
interface PluginInventoryTree {
  /** 顶层 scope 元信息（当前查询的 scope） */
  scope: { id: string; name: string; description: string };
  /** 全部 scope 列表（供 UI 切换器；default 首位） */
  scopes: ScopeMeta[];
  /** plugin-centric 平面列表（插件 tab UI 用）。v0.0.67：plugin 级 enabled 恒 true（无落盘开关）。 */
  plugins: {
    pluginId: string;
    /** 来自 PluginManifest.label（无则 = pluginId） */
    label: string;
    /** 来自 PluginManifest.description（无则 = ""） */
    description: string;
    /** plugin 级 enabled（v0.0.67 起恒 true，native 受信） */
    enabled: boolean;
  }[];
  /**
   * group-centric 嵌套结构（v0.0.71 D3）。
   *   - groups 顺序 = groups.json 声明序（GroupMetaProvider.listGroups()，D5 七组固定排序）
   *   - 每 group 下 points[] = 该 group 的 EP（GroupMeta.extPoints）
   *   - 每 point 下 impls[] = 该 EP 的 impl（per-point sourceScope 解析后取 effective 配置）
   */
  groups: {
    /** 分区 id = GroupMeta.id（来自 groups.json 声明，snake_case 字符串，如 "provider"/"context-compact"/"web"） */
    groupId: string;
    /** 该 group 下每个 point 节点（含激活状态 + impls[]） */
    points: {
      pointId: string;
      /** 该 point 在当前 scope 的激活状态（同 point 所有 impl 共享，per-EP 回退时不激活=false） */
      activated: boolean;
      /** 该 point 的 impl 节点（per-point effective order 排序 + (pluginId, implId) 稳定尾序） */
      impls: ExtImplNode[];
    }[];
  }[];
}

/**
 * 单条 ext impl 节点（v0.0.71 嵌套在 groups[].points[].impls[] 下）。
 *   - 删 `schemaConfig?`（D7：单一 configSchema 源）
 *   - 加 `configSchema?`（D7：透传 manifest configSchema，让前端 modal 可读 JSON Schema 形状）
 *   - 删 `pointActivated`（信息上提到 points[].activated，同 point 共享避免冗余）
 *   - `config` 始终 = JOIN(manifest default ⊕ scope configValues)（bug-A 修复，之前裸 configValues 在
 *     default.json 未声明时为 undefined）
 */
interface ExtImplNode {
  pluginId: string;
  implId: string;
  pointId: string;
  /** cardinality → type（值不变 exclusive/list/ordered，对齐 UI type 路由） */
  type: "exclusive" | "list" | "ordered";
  /** plugin 级 enabled（v0.0.67 恒 true）。保留字段供前端兼容。 */
  pluginEnabled: boolean;
  /** impl 级 enabled = membership（`getImplConfig(sourceScope, implId) !== undefined`，
   *  与运行时 plugin-manager.isActive 同口径；在 impls 列表 = true，不在 = false，无默认 true 兜底） */
  enabled: boolean;
  /**
   * effective order = ScopeConfig.impls[implId].order（YAML 数组序） ?? 末尾补位（§3.1）。
   * 仅 ordered 点；per-point 连续 1..n（从 1 开始）。
   */
  order?: number;
  /**
   * selected 派生字段（不入库，inventory 算出来）：该 impl 是否是当前 point 的「选中项」。
   *  - exclusive point：`selected = active（membership）中 effective order 最小者`
   *    （与运行时统一 getExtensionImpls 同口径，前端 radio 直接读不再自算）
   *  - list/ordered point：`selected = false`（无单选语义）
   * 详 §3.2。
   */
  selected?: boolean;
  /** 三级 description 透传（代码硬编码，缺省空串；UI 只读呈现）：
   *  - description = ExtImpl.description（impl 自己的）
   *  - pointDescription = ExtensionPoint.description（同 point 所有 impl 共享）
   *  - pluginDescription = PluginManifest.description（同 plugin 所有 impl 共享） */
  description: string;
  pointDescription: string;
  pluginDescription: string;
  /** D7 新增：manifest configSchema 透传（单一 schema 源；UI modal 控件路由源；无则 UI 不出齿轮） */
  configSchema?: JsonSchema;
  /** bug-A 修复（v0.0.71）：始终 = JOIN(extractConfigDefaults(configSchema) ⊕ implCfg.configValues)。
   *  manifest default 底座 ⊕ scope configValues overlay（per-domain 默认表对齐 spec）。
   *  secret 不入代码声明（D1），由 dev config/env 注入；inventory 此字段不含 secret。 */
  config: Record<string, unknown>;
}

interface ScopeMeta {
  scopeId: string;
  name: string;
  description: string;
}
```

> **groups 顺序来源（v0.0.71 D1）**：groups 顺序按 `GroupMetaProvider.listGroups()` 声明序（来自 `app/plugins/groups.json`，详 `plugin_system/[P1]groups_meta_decl.md`），不再按 registry 注册序。inventory JOIN `GroupMetaProvider.getGroupByPoint(pointId)` 取 groupId（不再读已删的 `ExtensionPoint.group` 字段）。缺 group 视为 misconfig → 启动校验 throw（D6 不变量）+ inventory 构建期防御 throw。

## 3. 核心原则：overlay 模型（树来自 registry，叶子来自代码声明）

**有效状态 = 代码默认 ⊕ 代码声明（scopes/*.yaml 全量列表）。**

- **树永远满、来自 registry（代码）**：有哪些 plugin / ext impl **100% 来自 plugin registry**（manifest + EP 定义）。**代码新增 plugin/EP/ext impl → 自动出现在树里、带代码默认。**
- **active 状态来自代码声明 `scopes/*.yaml`**：每个 scope 文件的 `groups→points→impls` 树声明该 scope 各 EP 的**完整 active 列表**（全量替换，零 delta）——EP 节点不出现 = 继承 default 全量；出现 = 用自己的列表。impl 在数组 = active（membership），不在 = inactive；数组序 = order；`configValues` 覆盖 manifest 默认。
- **无声明兜底已废**：注册但未列进 scope impls 列表的 impl = **inactive**（旧 `?? true` 默认 active 兜底已删）——「新增 impl 必须同步加进 default.yaml」，否则功能静默不生效（详 `plugin_system/[P1]scopes_config_decl.md §4` 强约定）。
- **配置 = 代码 = 唯一源（D2）**：运行时不读落盘 `plugin_policy/`（读路径只走 `ScopeConfigProvider`；v0.0.150 起 lazy migrate 也删，落盘 record 不再被任何路径读）。

### per-domain 默认表

| 项 | 无声明时的默认来源 |
|---|---|
| plugin 级 enabled | **恒 true**（native 受信，无 plugin 级开关；代码声明不存） |
| impl 级 enabled | **membership**：在 scope impls 列表 = true，不在 = false（无默认 true 兜底） |
| order（ordered 点） | YAML 数组序；**末尾补位**仅服务 inventory 展示连续化（按 manifest 登记序接到已知 order 之后，§3.1） |
| config 值 | manifest `configSchema` 的 `default`（+ 载体自带 `config` 块）；secret 移 dev config / env（D1） |

### 3.1 effective order 算法（末尾补位，不变）

某 ext point P 的所有 ext impl 集合 S（来自 registry 代码）的 effective order 求值（inventory 与运行时 `getExtensionImpls` 共用，抽公共函数避免漂移）：

```
known   = S 中 ScopeConfig.impls[implId].order 存在的 impl（取其声明的 order）
unknown = S 中无 order 声明的 impl（按 manifest 登记序排列）
# 1. known 按其声明 order 排（允许稀疏，保留原值）
# 2. unknown 全部接到末尾，补位 order = (known orders 上界) + 1, +2, … 递增
effective_order(impl) =
  ScopeConfig.impls[implId].order    if 该字段存在
  else <末尾补位序号（按登记序分配）>
```

**关键性质**：
- 新增代码 impl（无声明）→ 自动排末尾，不抢前位。
- 全组从未声明 order → 全按 manifest 登记序。
- 同 point 内 effective order 唯一。

### 3.2 exclusive EP 选中项（`selected` 派生）

exclusive EP 的「选中 impl」= 该 scope impls 列表中**恰好 1 个** active impl（membership 模型，无 `exclusivePicks` 字段）：
- `selected = active（membership）中 effective order 最小者`（与运行时统一 `getExtensionImpls` 同口径；validator 保证 exclusive 恰好 1 active → 正常情形即唯一 active 项）。
- 换选中 = 直接改 YAML 该 EP 的 impls 数组项（数组恰好 1 项，详 `plugin_system/[P1]scopes_config_decl.md §4`）。
- 0 个或多于 1 个 active → 启动校验失败（D3 硬失败，详 §4.2）。

## 4. 设计决策

### 4.1 管理面是独立管控面，运行时沙箱的替代

**结论**：单设管理面管「启用/选择/排序」，而非散在 discovery/activation 各处。
**理由**：运行时不沙箱（见威胁模型），安全靠可控选择信任谁；集中管控面让策略可审、可版本化（代码声明）、可被运维 UI 直接查看。
**不这样会怎样**：状态散在各 impl 内部、配置无单一权威源、改一个开关要在多处协调。

### 4.2 启动校验（D3 硬失败）

**结论**：bootstrap 加载 `scopes/*.yaml` 后立即由 `ScopeConfigValidator.validateAll` 跑校验，任一失败 throw（不静默 fallback，对齐 v0.0.64 P1 教训「静默 degradation 难定位」）。

校验项（详见 `plugin_system/[P1]scopes_config_decl.md` §3.2）：
1. **pointId 存在**：`activatedPoints` 必须在 registry 已登记。
2. **implId 存在 + 归属 point 已激活**：`impls.keys` 必须在 registry 已登记；且 impl 实际归属的 point 必须在该 scope `activatedPoints` 中（防跨 point 误列）。
3. **exclusive EP active 数恰好 1**：`activatedPoints` 中每个 cardinality=exclusive 的 EP，其 active（membership）impl 数量必须恰好 1（0 个或多于 1 都 throw）。

另先跑 `validateGroups`（registry ↔ groups.json 双向一致，详 `plugin_system/[P1]groups_meta_decl.md`）。

**实现位置**：`app/server/src/plugin/scope-config-validator.ts`（bootstrap 在 `loadScopeConfigs` 后立即调）。

**理由**：
1. **fail-fast**：misconfig 启动即崩，比运行时静默用错 impl 安全。
2. **代码声明 = 唯一源**：声明错误必须启动暴露（vs 数据落盘可以静默 drift）。
3. **不静默 fallback**：v0.0.64 P1 教训「静默 degradation 难定位」——错误必须显式 throw。

### 4.3 信任策略属 P1/future，P0 默认全开

**结论**：P0 全是 native 受信插件 → **plugin 级恒 enabled=true**。origin 来源标签、TrustPolicy（bundled/market 开、npm/git/local 关）是 **P1/future**，不在 P0 落地。
**理由**：P0 是静态内核（native 代码注册），无 discovery/install/三方插件来源——全是宿主自带受信代码，恒 enabled 合理；origin 策略随 P1 的 discovery/install 一起引入才有意义。

### 4.4 lazy migrate 旧盘（v0.0.150 起 A 决策已删）

**历史结论**：v0.0.67-v0.0.149 期间 `PluginConfigService` constructor 仍实例化 `PluginPolicyStore` + `PluginScopeStore`，bootstrap 调 `migrateLegacyImplKeys` + `migrateLegacyExclusiveRecords`（lazy migrate 旧盘升级兼容，运行时读路径不读）。

**v0.0.150 起**：无真实用户，A 决策下整段 lazy migrate 删——`plugin-policy-migrate.ts` 文件删 + `PluginPolicyStore.migrateLegacyImplKeys/migrateLegacyExclusiveRecords` 两方法删 + `PluginConfigService` constructor 调用点删。落盘 `plugin_policy/` record 运行时本就不读（读路径只走 `ScopeConfigProvider`），删除零行为影响；旧盘 record 仍在但不再被任何路径读。详见 `specs/tech/version_logs/v0.0.150/change_log.md`。

### 4.5 secret 不进代码声明（D1）

**结论**：zhipu apiKey 等 secret 移 dev config / env，不放 `scopes/*.yaml`。
**理由**：代码声明进版本库，secret 进版本库 = 泄漏。`scopes/*.yaml` 只存非 secret 配置（impls 列表 membership/order/non-secret configValues）；secret 由 dev config / env 注入，实例化时 deepMerge。

## 5. 边界

| 零件 | 归属 |
|---|---|
| inventory / listScopes / listActivatedPoints / getScope（v0.0.67 起全部只读） | 本文件 ✅ |
| 两级 config 值的数据形状（PluginConfigRecord / ExtImplConfigRecord） | `[P0]plugin_config.md` |
| 代码声明 schema（scopes/*.yaml 字段语义 + 加载/校验链路） | `plugin_system/[P1]scopes_config_decl.md` |
| 来源标签的产生（discovery/install，P1） | `plugin_system/[P1]discovery_and_install_interface.md` |
| 策略如何被生命周期消费 | `plugin_system/[P1]plugin_lifecycle.md` |
| exclusive/list/ordered 解析（消费策略） | `plugin_system/[P0]plugin_manager_interface.md` |
| 信任模型为何不靠沙箱 | `plugin_system/[P1]isolation_and_threat_model.md` |
| HTTP 端点契约（GET 保留 / PUT 写端点返 405） | `specs/api/overall/03-config-center.md` |

> 变更历史见 [`log.md`](log.md)；跨版本发布说明见 [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)。
