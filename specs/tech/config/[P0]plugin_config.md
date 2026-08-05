---
type: spec
title: PluginConfig Schema（插件配置，代码声明值源）
priority: P0
status: active
updated: 2026-07-19
since: v0.0.2
---

# PluginConfig Schema（插件配置，代码声明值源）

## 1. 概述

**管什么**：**两级 config 值的数据形状**（plugin 级 + ext impl 级）+ 按 group（tab）组织的**聚合视图**。
**不管什么**：各 configSchema 本身的形状定义（→ 各代码载体：manifest / ExtImpl）、代码声明 schema 形状（→ `plugin_system/[P1]scopes_config_decl.md`）、管理面契约（→ `[P0]plugin_config_service.md`）。
**管理面（启用/选谁/排序/inventory）**：由本模块的 `PluginConfigService` 提供，见 `[P0]plugin_config_service.md`（v0.0.67 起只读）。
总览见 `[index.md`](index.md)。

**v0.0.67 重构（design §3 D2）**：
- **配置代码化**：所有 active 状态 / order / activatedPoints = 代码声明 `app/plugins/scopes/*.yaml`（每 scope 一文件），运行时不读落盘 `plugin_policy/`。
- **两级 config 值的数据形状不变**：`PluginConfigRecord` / `ExtImplConfigRecord` 接口形状保持（向后兼容）；只是**值源**从落盘 record 改为代码声明。
- **secret 不进代码声明（D1）**：zhipu apiKey 等 secret 移 dev config / env，不放 `scopes/*.yaml`；非 secret configValues 走 manifest schema 默认。

**impl 列表模型（membership 值源）**：`ExtImplConfigRecord.enabled`/`order` 的运行时值源 = `scopes/*.yaml` 对应 EP 的 impls 数组——**在数组 = enabled，不在 = disabled**（membership，无 `enabled` 字段、无 `?? true` 兜底）；**数组序 = order**（loader 填 1-based 序号）。EP 节点不出现 = 继承 default 全量列表；出现 = 全量替换（零 delta）。

**v0.0.71 重构（D7+D8）**：
- **plugin 级 configSchema/config 死字段删除**（D8）：`PluginManifest.configSchema?` + `config?` 删除（0 builtin 使用 + 0 代码读）。§2 `PluginConfigRecord` 的 plugin 级记录仍保留 schema 形状（lazy migrate 兼容），但**运行时不再有 plugin 级 config 值需要校验**——所有 config 都在 ext impl 级（`ExtImpl.configSchema` 单一源）。
- **schemaConfig 删除**（D7）：`ExtImpl.schemaConfig?` + `SchemaConfigEntry` 删除，configSchema 是唯一 schema 源（校验 + UI 控件路由 + default 底座同源，见 `plugin_system/[P0]ext_impl_and_manifest_interface.md §3.7`）。
- **group 来源切换**（D1）：§3 tab 聚合的 group 来源从 `ExtensionPoint.group`（已删字段）改为 `app/plugins/groups.json` 的 `GroupMeta`（唯一源，见 `plugin_system/[P1]groups_meta_decl.md`）。

PluginConfig 把「配置一个插件/ext impl」拆成几块，各归其主，本文只做**值的存储 schema** + **group 聚合视图**；管理面（启用/选谁/排序/inventory）由 `PluginConfigService` 提供（见 `[P0]plugin_config_service.md`）：

| 关注点 | 归属 | 本文角色 |
|--------|------|---------|
| 各级值长什么样 | 各代码载体的 `configSchema`（manifest / ExtImpl） | **引用**，不重定义 |
| 启用/选谁/排序（两级 enabled 门 + ordered 排序） | `PluginConfigService`（见 `[P0]plugin_config_service.md`） | **引用**，不重定义 |
| 插件分到哪个 tab | groups.json `GroupMeta`（v0.0.71 起唯一源，原 `ExtensionPoint.group` 字段已删） | **聚合**成视图 |
| 用户填的配置值存哪 | **本文** ✅ | 定义两级值记录 schema |

---

## 2. 两级 config 值记录（plugin + ext impl）

配置值按**代码身份**分两级，全部并存（plugin 级 + ext impl 级）。每级定义一份存储记录，值内容本身是不透明 json（因各载体形状不同）。身份是 string（`pluginId` / `implId`）作逻辑 key；ULID 物理主键可选（跟 app_config 的 `(group,key)→data` 一套）：

```typescript
/** plugin 级配置值记录（保留现状，不动） */
interface PluginConfigRecord {
  /** 主键（ULID，可选——persistence 保留名 `id`；与 app_config 的 KV 形态一致） */
  id?: string;
  /** 逻辑 key，对应 PluginManifest.id */
  pluginId: string;
  /** 是否启用（plugin 级总开关） */
  enabled: boolean;
  /** 配置值，必须通过该插件 manifest.configSchema 校验 */
  configValues: Record<string, unknown>;
}

/** ext impl 级配置值记录（原 ImplConfigRecord 改名，去复合 key） */
interface ExtImplConfigRecord {
  /** 主键（ULID，可选） */
  id?: string;
  /** 逻辑 key，对应 ExtImpl.implId（单 string，无 pointId/pluginId 复合 key） */
  implId: string;
  /** 是否启用（impl 级单条开关）。
   *  运行时值源 = scopes/*.yaml 对应 EP impls 数组 membership：在数组 = true，不在 = false
   *  （落盘 record 已无此字段写入路径，见 §5）。 */
  enabled: boolean;
  /** 排序：per ext point 组内连续 1..n（从 1 开始）；仅 ordered 点用。
   *  运行时值源 = scopes/*.yaml impls 数组序（loader 填 1-based）；
   *  无声明 → 末尾补位（按 manifest 登记序，见 plugin_config_service §3.1）。 */
  order?: number;
  /** 配置值，必须通过该 ext impl 的 configSchema 校验（见 plugin_system/[P0]ext_impl_and_manifest_interface.md §3.5） */
  configValues: Record<string, unknown>;
}
```

> 校验由宿主在写入前用对应载体的 `configSchema` 跑（免代码校验，见 `plugin_system/[P0]ext_impl_and_manifest_interface.md` §3.2）：plugin 级用 manifest configSchema、ext impl 级用 ExtImpl configSchema。
>
> **point 级 config 已砍掉**：EP 只是 contract（代码常量），无 point 级 config record（见 `plugin_system/[P0]extension_point_interface.md` §3.8）。

---

## 3. group 聚合视图（tab）

UI 按 tab 展示插件配置，每个 tab = 一个 group。v0.0.71 起 group 来自 `app/plugins/groups.json` 的 `GroupMeta`（唯一源，原 `ExtensionPoint.group` 字段已删，见 `plugin_system/[P1]groups_meta_decl.md`）：向同 group 扩展点贡献 ext impl 的插件，归到同一 tab。group 仍是**视图**（从 groups.json 派生），不分片；plugin 不分 group（一个插件向不同 group 的 point 贡献 ext impl 时出现在多个 tab）。

```typescript
/** 一个 tab：某 group 下所有插件的配置入口 */
interface PluginConfigTab {
  /** group id，来自 groups.json GroupMeta.id（v0.0.71 起唯一源，原 ExtensionPoint.group 字段已删） */
  group: string;
  /** tab 显示名（宿主 i18n，来自 GroupMeta.label） */
  label: string;
  /** 该 group 下的插件条目 */
  entries: PluginConfigTabEntry[];
}

/** tab 内一个插件条目 */
interface PluginConfigTabEntry {
  pluginId: string;
  /** 该插件在本 group 下贡献的扩展点 id（一个插件可能只在此 tab 暴露部分 point） */
  pointIds: string[];
  /** 插件值形状，供 UI 渲染表单（来自 manifest.configSchema） */
  configSchema: JsonSchema;
  /** 当前 plugin 级值（来自 PluginConfigRecord.configValues） */
  values: Record<string, unknown>;
  /** 该插件在本 tab 暴露的 ext impl 配置入口 */
  extImpls?: PluginConfigExtImplEntry[];
}

/** tab 内某 ext impl 的配置入口 */
interface PluginConfigExtImplEntry {
  implId: string;
  pointId: string;
  /** ext impl 值形状（来自 ExtImpl.configSchema，若有）+ 当前 impl 级值 */
  configSchema?: JsonSchema;
  values?: Record<string, unknown>;
}
```

**聚合规则**：

```
树的存在性来自 plugin registry（代码，不读 config 表）：
对 registry 中每个已登记的插件 P：
  对 P 的每条 ext impl E（E.point 指向某扩展点 PT）：
    把 (P, PT.group, PT.id) 记入 group → tab 映射
  → 同一插件若向不同 group 的 point 贡献 ext impl，会出现在多个 tab
在 tab 内，按 pluginId → PluginConfigRecord / implId → ExtImplConfigRecord overlay 值
（有 record 用 record，无 record 用代码默认）
```

> 一个插件贡献 `context_engine`（group "context"）和 `embedding_provider`（group "provider"）时，它同时出现在 context tab 和 provider tab——符合「按功能区浏览」的直觉。

---

## 4. 值面（本文）vs 管理面（PluginConfigService）的关系

tab 视图**只读引用**管理面状态，不改它。是否启用（两级 enabled 门）、exclusive 选谁、ordered 顺序、inventory 全量树，归 `PluginConfigService`（见 `[P0]plugin_config_service.md`）。UI 上「启用开关 / 排序」操作走 PluginConfigService；「填配置值」走本文的两级记录（实际 setter 也在 PluginConfigService 上，统一管理面）。

```
插件/ext impl 条目（tab 内）
  ├─ enabled（plugin 级 + impl 级）/ 排序（仅 ordered 点） → PluginConfigService（管理面）
  └─ 配置值（plugin 级 + ext impl 级）               → 本文两级记录（值面，setter 见 PluginConfigService）
```

> 值面与管理面共享 CrudStore、同一代码身份（`pluginId` / `implId`）；值面定义数据形状，PluginConfigService 定义写入/读取/inventory 契约。两者不重复定义数据模型。详见 `[P0]plugin_config_service.md`。

---

## 5. 持久化（v0.0.67 起 deprecated，仅 lazy migrate 兼容）

> **v0.0.67 起 deprecated（design §3 D2）**：配置代码化后，运行时读路径**不读 `plugin_policy/` 落盘 record**。v0.0.150 起 `PluginPolicyStore.migrateLegacyImplKeys/migrateLegacyExclusiveRecords` 两方法 + `plugin-policy-migrate.ts` 文件已删（A 决策：无真实用户，lazy migrate 兼容路径整段放弃；落盘 record 运行时本就不读，删除零行为影响，详 `[P0]plugin_config_service.md §4.4`）。`PluginPolicyStore` + 单 entity `plugin_policy` SchemaDef 仍保留（未删实例化），但运行时读路径完全绕过。新装实例无落盘 record，行为完全等同。

历史落盘形态（保留兼容，新装无 record）：
- **单 entity `plugin_policy`** 按 `kind` 字段分片（`{root}/plugin_policy/{kind}/<id>.json`，kind='plugin' | 'impl'），SchemaDef 字段 `{ id (ulid), kind (string), key (string), data (json) }`。
- **v0.0.26 复合 key**：impl 级 record 的 `key` 字段编码 `${scopeId}::${implId}`（D2 编码策略，详 `[P0]ext_impl_scope.md §4.2`）。
- **业务 data**：enabled/order/configValues/exclusive 稀疏 delta（v0.0.55 起 exclusive 字段 deprecated）。

> **运行时数据源 = 代码声明**：`scopes/*.yaml`（每 scope 一文件，schema 详 `plugin_system/[P1]scopes_config_decl.md`）。落盘 record 仅历史升级兼容，**不应再写入**（PUT 写端点已返 405，详 `specs/api/overall/03-config-center.md`）。

CRUD 细节不在本文（见 `persistence/` + `plugin-policy-store.ts`）。engine 声明 `file`（历史理由：为人可读、可版本化、bootstrap 安全；v0.0.67 后落盘仅兼容用）。

## 6. 字段总表

`PluginConfigRecord`（plugin 级，保留）：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string (ULID) | ❌ | 物理主键（可选，persistence 保留名 `id`） |
| `pluginId` | string | ✅ | 逻辑 key，对应 PluginManifest.id |
| `enabled` | boolean | ✅ | plugin 级总开关 |
| `configValues` | Record | ✅ | 配置值，经 manifest.configSchema 校验 |

`ExtImplConfigRecord`（ext impl 级，原 ImplConfigRecord 改名）：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string (ULID) | ❌ | 物理主键（可选） |
| `implId` | string | ✅ | 逻辑 key（单 string），对应 ExtImpl.implId |
| `enabled` | boolean | ✅ | impl 级单条开关（运行时值源 = scopes yaml impls 数组 membership） |
| `order` | number | ❌ | 排序：per ext point 组内连续 1..n（从 1 开始）；仅 ordered 点（运行时值源 = scopes yaml 数组序）；无声明 → 末尾补位（按 manifest 登记序） |
| `configValues` | Record | ✅ | 配置值，经 ExtImpl.configSchema 校验 |

> 变更历史见 [`log.md`](log.md)；跨版本发布说明见 [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)。
