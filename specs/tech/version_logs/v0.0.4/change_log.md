# Tech Spec Change Log — v0.0.4

> 版本：v0.0.4 · 日期：2026-06-20
> 增量记录 v0.0.4 相对 v0.0.3 引入的技术架构变更。
> 全量技术定义见 `specs/tech/plugin_system/`、`specs/tech/config/`。
> v0.0.4 是 **v0.0.3 UI 修订 + 配置归属完善**：非重写，复用 v0.0.3 plugin/config/llm/server 底层，仅修订 EP.group 必填 + inventory group-centric。

## 摘要

v0.0.4 在 tech 层做 **2 项 spec 修订**（落实 task.json keyDecisions 4、5、6）：

1. **`ExtensionPoint.group` 改必填**：每个 ext point 直接在其定义上声明 `group: string`（不可缺省）；与 config 实体 group 字段（`app_config`/`dev_config` schema 的 `group:string required` 分片键）是**同一 group 概念两处体现**（UI 全按 group 分区，无中间映射表）。
2. **`PluginConfigService.inventory` 改 group-centric**：返回结构由 v0.0.3 的 plugin-centric（`plugins[] → extImpls[]`）改为按 `ExtensionPoint.group` 聚合（`groups[] → extImpls[]`），每个 ext impl 节点带 `pluginId`/`pointId`/`implId`/`pluginEnabled`/`enabled`/`order`/`config`。enabled 两级门（`plugin.enabled ∧ impl.enabled`）**不变**——group 决定展示分区，enabled 决定行为门，正交。

## 文档修订（overall 就地更新）

| 文件 | 修订内容 | 标注 |
|------|---------|------|
| `specs/tech/plugin_system/[P0]extension_point_interface.md` §2 | `group` 字段由 `group?: string` 改为 `group: string`（必填）+ 注释更新 | `[v0.0.4 modified]` |
| `specs/tech/plugin_system/[P0]extension_point_interface.md` §3.6 | group 必填（去除「缺省归 other」）+ 与 config 实体 group 一致性说明 | `[v0.0.4 modified]` |
| `specs/tech/plugin_system/[P0]extension_point_interface.md` §4/§3.8 | 示例注释 + §3.8 文案同步 group 必填 | `[v0.0.4 modified]` |
| `specs/tech/plugin_system/[P0]overview.md` 头注 | 标注 EP.group 必填 + inventory group-centric | `[v0.0.4 modified]` |
| `specs/tech/config/[P0]plugin_config_service.md` §2 | `PluginInventoryTree` 结构改 group-centric（`groups[] → extImpls[]`，每个 ext impl 带 pluginId/pluginEnabled）+ group/enabled 正交说明 | `[v0.0.4 modified]` |
| `specs/tech/config/[P0]overview.md` 头注 | 标注 inventory group-centric + EP.group 必填的影响 | `[v0.0.4 modified]` |

## 修订点详述

### 修订 1：ExtensionPoint.group 改必填

- **v0.0.3 现状**：`group` 是可选字段（`group?: string`，缺省归 `"other"`）；§3.6 文案描述「缺省归 other」。
- **v0.0.4**：`group: string` **必填**——每个 EP 定义必须显式声明 group。
- **代码影响**：`app/server/src/plugin/extension-point.ts` 的 `ExtensionPoint` interface 字段类型由 `group?: string` 改 `group: string`；现有两个内置 EP（`LlmProviderPoint` / `LlmProtocolPoint`）实际都已写 `group: 'provider'`，**无回归**。P1 三方 EP 必须自带 group 字段。
- **理由**：v0.0.4 inventory 改 group-centric（修订 2），无 group 的 EP 无法被聚合渲染；必填消除「缺省归 other」隐式默认，让 group 成为 EP 显式固有属性。
- **group 一致性**：`ExtensionPoint.group`（EP 必填 string）与 config 实体 `group` 字段（`app_config`/`dev_config` schema 的 `group:string required` KV 分片键）是同一概念两处体现——UI 全按 group 分区（app 设置页按 config 实体 group：providers/appearance；插件设置页按 EP.group：provider），无中间映射表。

### 修订 2：PluginConfigService.inventory 改 group-centric

- **v0.0.3 现状**：`inventory()` 返回 `PluginInventoryTree { plugins[]: { pluginId, enabled, config, extImpls[]: { implId, pointId, cardinality, enabled, order?, config? } } }`（plugin-centric，顶层 plugin → 下挂 ext impl）。
- **v0.0.4**：`inventory()` 返回 `PluginInventoryTree { groups[]: { groupId, extImpls[]: { pluginId, pointId, implId, cardinality, pluginEnabled, enabled, order?, configSchema?, config? } } }`（group-centric，顶层 group → 下挂 ext impl，跨 plugin 跨 point 聚合）。
- **新结构关键点**：
  - `groups[]` 顶层（顶层不再是 plugins[]），每个 group 节点 `{ groupId, extImpls[] }`。
  - ext impl 节点新增 `pluginId`（v0.0.3 plugin-centric 隐含在父节点，group-centric 显式带出）+ `pluginEnabled`（plugin 级 enabled，与 impl 级 enabled 分开暴露，让 UI 可分别切两级门）。
  - group 顺序：按 registry 中 EP 注册顺序（首次出现）；同 group 内 ext impl 顺序按 `(pluginId, pointId, implId)` 字典序稳定。
- **enabled 门不变**：`plugin.enabled ∧ impl.enabled` 两级，运行时 active 投影由 `PluginManager.getExtensionImpls` 求合取（不读 group）。
- **正交关系**：group=展示分区（决定 ext impl 在 UI 树的位置）；enabled=行为门（决定是否进 active 投影）。一个 ext impl 可 `group="provider"` 但 `enabled=false`——它仍在 provider 分区可见，但运行时不生效。UI 按 group 分区渲染（plugin-enabled/impl-enabled 两 toggle 各自独立可切）。
- **代码影响**：`app/server/src/plugin/plugin-config-service.ts` 的 `PluginInventoryTree` interface + `inventory()` 实现需重构（buildPluginNode → buildGroupNode，按 EP.group 聚合 ext impl）。`persist()` / setters 不变。

## 关键 TS 接口（group-centric 新结构）

```typescript
interface PluginInventoryTree {
  groups: {
    groupId: string;                 // = ExtensionPoint.group
    extImpls: {
      pluginId: string;
      pointId: string;
      implId: string;
      cardinality: "exclusive" | "list" | "ordered";
      pluginEnabled: boolean;        // plugin 级 enabled（两级门之 plugin 级）
      enabled: boolean;              // impl 级 enabled（两级门之 impl 级）
      order?: number;                // 仅 ordered 点
      configSchema?: JsonSchemaSummary;
      config?: Record<string, unknown>;
    }[];
  }[];
}
```

## 对 v0.0.3 代码的影响（planner/coder 范围）

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/plugin/extension-point.ts` | 修改 | `ExtensionPoint.group` 类型 `group?: string` → `group: string`（必填）；现有内置 EP 已自带 group，无回归 |
| `app/server/src/plugin/plugin-config-service.ts` | 修改 | `PluginInventoryTree` interface 改 group-centric（`groups[]` 顶层，ext impl 带 pluginId/pluginEnabled）；`inventory()` 实现 buildPluginNode → 按 EP.group 聚合 ext impl；`persist()`/setters 不变 |

## 范围边界（v0.0.4 tech 层）

### IN SCOPE

1. EP.group 必填（类型约束 + spec §2/§3.6/§3.8 + overview 头注）。
2. inventory group-centric（结构 + spec §2 + overview 头注）。
3. enabled 两级门、setters、persist、overlay 模型 **不变**（仅 inventory 视图重组）。

### OUT OF SCOPE

- `PluginManager.getExtensionImpls` / registry / `PluginPolicyStore` 改动（运行时 active 投影逻辑不变，仍按两级 enabled 合取）。
- 新增 ext point（仍只 `llm_provider` / `llm_protocol`）。
- plugin manifest / ExtImpl configSchema 改动（数据形状不变）。
- LlmClient resolveProviderConfig deepMerge（config 聚合逻辑不变）。

## 版本

version: 1.0
