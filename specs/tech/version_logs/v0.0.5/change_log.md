# Tech Spec Change Log — v0.0.5

> 版本：v0.0.5 · 日期：2026-06-20
> 增量记录 v0.0.5 相对 v0.0.4 引入的技术架构变更。
> 全量技术定义见 `specs/tech/plugin_system/`、`specs/tech/config/`。
> v0.0.5 是 **配置中心重构**：后端补 5 个新概念（ext point type、impl schemaConfig、group 独立保存、plugin enable 独立、provider/model 统一为普通 app config group）；前端 22 组件 spec 已就绪（`specs/ui/components/`），本文件只补后端概念。

## 摘要

v0.0.5 在 tech 层做 **5 项后端概念扩展**（落实 task.json scope.in 与 keyDecisions）：

1. **ext point `type` 字段（cardinality 暴露为 `type`）**：`ExtensionPoint` interface 的 `cardinality` 语义已在 v0.0.4 定，v0.0.5 把它**显式化为 ext point 类型字段**（沿用三态 `exclusive`/`list`/`ordered`，不改语义，仅强调 UI 分化渲染的语义来源），`PluginConfigService.inventory()` 的 `cardinality` 字段改名为 `type`，UI 按 `type` 路由渲染控件（radio/checkbox/ordered）。
2. **impl `schemaConfig` 弹层 config**：impl 声明 `schemaConfig`（JSON Schema，key→{type, default, options?}）；新增 `setImplConfig(pluginId, pointId, implId, values)` API（与现 v0.0.4 的 `setImplConfig(implId, values)` 合一，仅参数命名澄清）；configValues 是稀疏 delta overlay 在 schemaConfig.default 上。
3. **group 独立保存**：`SET /config/app` / `SET /config/dev` 新增「整组提交」语义（body 携带 `group` + `items: { key, data }[]`），原子提交该 group 全部 key；其他 group 不受影响。新增「按 group 列出」已存在（GET ?group=）。
4. **plugin enable 独立（修 bug 根因）**：定位 v0.0.4 「两 plugin 开关联动」bug 根因在**前端 state slice 共享**（PluginSettingsPage 用 pluginId 作 matcher 乐观更新，影响同 pluginId 多行），**后端 `setEnabled(pluginId)`/`setImplEnabled(implId)` 各自独立无 bug**。修复架构 = 前端拆 state（每 plugin 一份），后端无需改动；同时 inventory 暴露顶层 `plugins[]`（plugin-centric 平面，给插件 tab 用）。
5. **provider/model 统一为普通 app config group**（用户决策 A）：v0.0.4 `/provider` `/provider/:id/model` 多实例 CRUD 端点**保留**（不复用，避免破坏现有 chat/credentials 脱敏逻辑），但 UI 层把它们与 appearance/llm_request 一样纳入三栏化；**数据归属不变**（仍是 app_config providers group record，key=instanceId）。多 provider/model 实例的 CRUD **不**映射为三栏 KV 编辑，而是作为 group 内的「实例卡片」独立交互区（v0.0.4 ProvidersSection 组件复用）。

## 文档修订（overall 就地更新）

| 文件 | 修订内容 | 标注 |
|------|---------|------|
| `specs/tech/plugin_system/[P0]extension_point_interface.md` §2/§3.7/§6 | `cardinality` 字段补「[v0.0.5] 显式化为 ext point type，UI 按 type 分化渲染」语义说明；§3.7 控件映射补「v0.0.5 已落地三栏 type 分化」 | `[v0.0.5 modified]` |
| `specs/tech/config/[P0]plugin_config_service.md` §2 | `PluginInventoryTree` ext impl 节点 `cardinality` 改名 `type`；新增顶层 `plugins[]`（plugin-centric 平面，给插件 tab UI 用：pluginId + label + description + enabled） | `[v0.0.5 modified]` |
| `specs/tech/config/[P0]plugin_config_service.md` §2 | `setImplConfig` 签名注释补「v0.0.5 schemaConfig overlay 语义」（参数仍 `implId` string，schemaConfig 来自 ExtImpl 声明） | `[v0.0.5 modified]` |
| `specs/tech/config/[P0]app_config.md` §5/§3.2 | `AppConfigService` 新增 `setGroup(group, items[])`（整组提交）；providers group 注释「v0.0.5 三栏化 UI 入口，数据归属不变」 | `[v0.0.5 modified]` |
| `specs/tech/config/[P0]dev_config.md` §7 | `DevConfigService` 同样新增 `setGroup(group, items[])` | `[v0.0.5 modified]` |
| `specs/tech/config/[P0]overview.md` §6 | 补「[v0.0.5] group 独立保存 / setGroup 语义」一条 | `[v0.0.5 modified]` |
| `specs/tech/plugin_system/[P0]ext_impl_and_manifest_interface.md` §2/§3.5 | `ExtImpl.schemaConfig`（per-key {type, default, options?}）与 `configSchema`（JSON Schema）的**关系澄清**：schemaConfig 是 UI 渲染专用简化形态，configSchema 是免代码校验源；两者并存 | `[v0.0.5 modified]` |
| `specs/api/overall/02-llm-chat.md` §4.1/§4.2/§4.3 | `/config/app` `/config/dev` PUT 新增「group + items[]」整组提交；`/config/plugin` GET 响应 `cardinality`→`type` + 新增顶层 `plugins[]`；PUT 新增 `setImplConfig` values 来自 schemaConfig | `[v0.0.5 modified]` |

## 修订点详述

### 修订 1：ext point `type` 字段（cardinality 显式化）

- **v0.0.4 现状**：`ExtensionPoint.cardinality: "exclusive" | "list" | "ordered"`；inventory ext impl 节点字段名 `cardinality`。
- **v0.0.5**：**不改 EP interface 字段名**（仍 `cardinality`，避免代码大改）；inventory 节点字段名由 `cardinality` 改为 **`type`**（PRD §3.9.4 + UI 组件 spec 统一用 `type`，让 UI 路由更直观）；语义不变（exclusive=radio / list=checkbox / ordered=drag+toggle）。
- **理由**：UI 组件层（`component-ext-impl-radio/checkbox/ordered`）与 `_conventions.md` 已用 `type` 作路由 key；tech spec inventory 字段对齐 UI 术语，避免「cardinality↔type」二次翻译。
- **代码影响**：`PluginInventoryTree.groups[].extImpls[].cardinality` 改名 `type`（纯字段重命名，零逻辑变化）。

### 修订 2：impl `schemaConfig` 弹层 config

- **v0.0.4 现状**：`ExtImpl.configSchema`（JSON Schema）+ `ExtImplConfigRecord.configValues`（稀疏 delta），`setImplConfig(implId, values)` 已存在。
- **v0.0.5**：新增 `ExtImpl.schemaConfig?`（per-key 形态，比 JSON Schema 更贴近 UI 渲染）：
  ```typescript
  interface SchemaConfigEntry {
    type: "string" | "number" | "boolean" | "enum" | "object";
    default?: unknown;
    options?: (string | number)[];   // 仅 enum
    description?: string;
  }
  type SchemaConfig = Record<string, SchemaConfigEntry>;
  ```
  - **与 configSchema 关系**：schemaConfig 是**UI 渲染专用简化形态**（per-key type/default/options），configSchema 是**JSON Schema 免代码校验源**（type/required/enum/min...）。两者并存：configSchema 决定校验，schemaConfig 决定 UI 控件；若仅 configSchema 存在，UI 按 JSON Schema type 推导控件。
  - **setImplConfig 语义不变**：`setImplConfig(implId, values)` 写 `ExtImplConfigRecord.configValues`（稀疏 delta），实例化时 `deepMerge(schemaConfig.default, configSchema.default, manifest.config, configValues)`。
  - **API 参数澄清**：`PUT /config/plugin { op: 'setImplConfig', implId, values }` —— values 是稀疏 delta（只含用户改过的 key），未含 key 按默认。PRD §3.9.5 的 `(pluginId, pointId, implId)` 三参只是 UI 层定位用，**后端 API 仍用 implId 单参**（implId 全局唯一）。
- **理由**：JSON Schema 嵌套/复合类型 UI 难直接渲染；schemaConfig 给 UI 一个扁平 per-key 入口，控件选择直接由 `type` 字面量路由（string→input/number→input/boolean→switch/enum→select/object→分组）。configSchema 仍是校验权威，不丢严格性。
- **代码影响**：`ExtImpl` interface 新增 `schemaConfig?`；`ExtImplConfigRecord` 不变；`setImplConfig` 不变。

### 修订 3：group 独立保存（`setGroup`）

- **v0.0.4 现状**：`AppConfigService.set(group, key, data)` 单 key 写；UI 整页保存需多次调用。
- **v0.0.5**：新增 `setGroup(group, items: { key, data }[])`——原子提交该 group 全部 key：
  ```typescript
  interface AppConfigService {
    get(group, key): unknown | undefined;
    set(group, key, data): void;
    /** [v0.0.5] 整组提交：原子写该 group 全部 key（其他 group 不受影响） */
    setGroup(group: string, items: { key: string; data: unknown }[]): void;
  }
  ```
  - **原子性**：同 group 内要么全成功要么全失败（CrudStore 事务）；其他 group record **完全不读不写**。
  - **DevConfigService 同构新增 `setGroup`**。
- **理由**：PRD §3.9.2 「group 独立保存」要求 UI 点「保存该 group」只落该 group；服务层提供 setGroup 避免前端循环 set（避免半完成状态、避免串扰其他 group）。
- **代码影响**：`AppConfigService` / `DevConfigService` 各加 `setGroup` 方法（底经 CrudStore 按 group shard 批量 upsert）。

### 修订 4：plugin enable 独立（修 bug 根因定位）

- **v0.0.4 现象**：用户报告「开 plugin A 关 plugin B 联动」。
- **根因定位**：
  - **后端无 bug**：`PluginConfigService.setEnabled(pluginId, enabled)` 只写 `PluginPolicyData[pluginId].enabled` 一条 record，**完全独立**（见 `app/server/src/plugin/plugin-config-service.ts:131-134`）；`setImplEnabled(implId, enabled)` 同样独立。后端不存在串扰。
  - **bug 在前端**：`PluginSettingsPage.handleTogglePlugin` 用 `(e) => e.pluginId === impl.pluginId` 作 matcher 乐观更新（`app/web/src/components/settings/PluginSettingsPage.tsx:78`），**同 pluginId 的所有 ext impl 行都被改 pluginEnabled 字段**。当用户在 UI 上感知「plugin A 开关」时，实际触发的可能是某个 ext impl 行的 plugin 级 toggle，乐观更新波及所有同 pluginId 行——视觉上表现为「联动」。
- **v0.0.5 修复架构**：
  - **前端**：拆 `PluginSettingsPage` 为两 tab（插件 tab + 扩展点 tab）；插件 tab 用**顶层 `plugins[]` 平面列表**（每 plugin 一行，一个 toggle，state 按 pluginId 独立 slice），不再用 ext impl 行的 pluginEnabled；扩展点 tab 只切 impl 级 enabled（`setImplEnabled`），不切 plugin 级。
  - **后端**：inventory 返回结构新增**顶层 `plugins[]`**（plugin-centric 平面，给插件 tab UI 用）：
    ```typescript
    interface PluginInventoryTree {
      /** [v0.0.5] plugin-centric 平面列表（插件 tab UI 用）；与 groups[] 并存，数据源同一份 policy */
      plugins: {
        pluginId: string;
        label: string;        // 来自 manifest（暂用 pluginId 或 manifest.label）
        description: string;  // 来自 manifest.description
        enabled: boolean;     // plugin 级 enabled（P0 默认开）
      }[];
      groups: { groupId: string; extImpls: ExtImplNode[] }[];  // 扩展点 tab UI 用（不变）
    }
    ```
  - **setEnabled 语义不变**：仍写 `PluginPolicyData[pluginId].enabled`，影响该 plugin 所有 ext impl 的 active 投影（plugin.enabled ∧ impl.enabled 合取）。UI 插件 tab 的 toggle 直接调 setEnabled，state 独立，互不影响。
- **理由**：把 plugin 级 toggle 与 impl 级 toggle **UI 上彻底分离到两个 tab**（PRD §3.9.3 vs §3.9.4），state slice 物理隔离；后端无 bug 无需改动。
- **代码影响**：`PluginInventoryTree` 加 `plugins[]` 顶层；`inventory()` 实现加 buildPluginList（JOIN manifest label/description + PluginPolicyStore enabled）；`setEnabled` 不变。

### 修订 5：provider/model 统一为普通 app config group（用户决策 A）

- **v0.0.4 现状**：`/provider` + `/provider/:id/model` 是 app_config providers group 的**多实例 CRUD 封装**（路径化、ULID 实例 id、tombstone 软删、credentials 脱敏）；ProvidersSection 组件在 AppSettingsPage 渲染。
- **v0.0.5 决策**：**`/provider` `/provider/:id/model` 端点保留不动**；provider/model 实例**不**扁平化为三栏 KV 编辑，而是作为 app config providers group 内的「**实例卡片区**」（沿用 ProvidersSection），与 appearance/llm_request group 一样**纳入三栏布局**（group 列表选中 providers → 右侧渲染 ProvidersSection 而非 KV 卡片网格）。
- **理由（决策记录）**：
  1. **多实例 CRUD ≠ KV 编辑**：provider/model 是「列表内嵌套列表」的多实例语义（增删 provider、每个 provider 增删 model），扁平化为 KV 会丢失实例边界（key=instanceId 时，UI 仍需识别「这是一条 provider 实例」并出 CRUD 表单，反而比直接复用 ProvidersSection 更绕）。
  2. **credentials 脱敏 + tombstone 软删逻辑复用**：`/provider` 端点已实现 credentials 默认脱敏 `***`、PUT `***` 视为不修改、DELETE tombstone；若强制走 `/config/app` 通用 PUT，这些语义要重做（与 chat handler 读 credentials 的链路耦合），ROI 低。
  3. **三栏化的本质是「按 group 分区 + 独立保存」**，不是「所有 group 都用同一种 KV 控件」。providers group 用专属实例卡片控件、appearance group 用 KV 控件、llm_request group 用 KV 控件——三者**在 group 列表 + 配置区 + 保存条三栏框架下统一**，配置区内部控件按 group 类型分化（KV 卡片 vs 实例 CRUD 卡片）。
  4. **数据归属一致**：provider/model 仍是 app_config providers group record，只是 UI 入口三栏化；与「数据归属 = app_config」原则不矛盾。
- **反例（否决方案）**：把 provider/model 扁平化为 KV（key=instanceId, data=instance），UI 渲染需要特殊识别 data 形状出 CRUD 表单 → 比 ProvidersSection 多一层「识别 + 转译」，且 credentials/软删语义要重做 → 否决。
- **代码影响**：
  - `/provider` `/provider/:id/model` 端点契约 v0.0.5 **不变**（路径/方法/请求/响应/错误完全沿用）。
  - 前端：ProvidersSection 组件从 AppSettingsPage 旧位置迁入 `app-dev-config-page/` 三栏布局的「providers group 配置区」（作为 section 内嵌组件），**不改其内部 CRUD 逻辑**（调 `/provider` 端点）。
  - 三栏布局：group 列表含 `providers` / `appearance`；选中 providers → 右侧渲染 ProvidersSection（而非 KV key 卡片网格）；选中 appearance → 右侧渲染 KV key 卡片网格。配置区控件按 group 类型分发。

## 关键 TS 接口（v0.0.5 新结构汇总）

```typescript
// ExtensionPoint 不变（cardinality 字段保留，语义即 type）
interface ExtensionPoint<T> { id: string; cardinality: "exclusive"|"list"|"ordered"; group: string; }

// ExtImpl 新增 schemaConfig
interface ExtImpl {
  implId: string; point: string; impl: string; priority?: number;
  configSchema?: JsonSchema;          // 校验源（保留）
  /** [v0.0.5] UI 渲染专用 per-key schema（简化形态） */
  schemaConfig?: Record<string, {
    type: "string"|"number"|"boolean"|"enum"|"object";
    default?: unknown; options?: (string|number)[]; description?: string;
  }>;
}

// PluginInventoryTree 新增 plugins[] 顶层 + ext impl 节点 cardinality→type
interface PluginInventoryTree {
  /** [v0.0.5] plugin-centric 平面（插件 tab UI 用） */
  plugins: { pluginId: string; label: string; description: string; enabled: boolean }[];
  groups: {
    groupId: string;
    extImpls: {
      pluginId: string; implId: string; pointId: string;
      type: "exclusive" | "list" | "ordered";   // [v0.0.5] cardinality → type
      pluginEnabled: boolean; enabled: boolean; order?: number;
      configSchema?: JsonSchemaSummary;
      schemaConfig?: Record<string, { type: string; default?: unknown; options?: unknown[] }>; // [v0.0.5]
      config?: Record<string, unknown>;
    }[];
  }[];
}

// AppConfigService / DevConfigService 新增 setGroup
interface AppConfigService {
  get(group, key): unknown | undefined;
  set(group, key, data): void;
  setGroup(group: string, items: { key: string; data: unknown }[]): void;   // [v0.0.5]
}
```

## 文件级变更清单（architect MANDATORY）

### 后端

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/plugin/extension-point.ts` | 不动 | `cardinality` 字段保留（语义即 type，仅 inventory 节点改名） |
| `app/server/src/plugin/manifest.ts` | 修改 | `ExtImpl` interface 新增 `schemaConfig?: Record<string, SchemaConfigEntry>`；导出 `SchemaConfigEntry` type |
| `app/server/src/plugin/plugin-config-service.ts` | 修改 | `PluginInventoryTree` interface：ext impl 节点 `cardinality` 改名 `type`；新增顶层 `plugins: { pluginId, label, description, enabled }[]`；ext impl 节点新增 `schemaConfig?`；`inventory()` 实现加 `buildPluginList()`（JOIN manifest label/description + store enabled） |
| `app/server/src/config/app-config-service.ts` | 修改 | `AppConfigService` 新增 `setGroup(group, items[])` 方法（按 group shard 批量 upsert） |
| `app/server/src/config/dev-config-service.ts` | 修改 | `DevConfigService` 同构新增 `setGroup(group, items[])` |
| `app/server/src/handlers/config.ts` | 修改 | `AppConfigHandler` / `DevConfigHandler` PUT 新增「整组提交」分支（body 含 `group` + `items[]` → 调 `setGroup`）；`PluginConfigHandler` GET 响应 `cardinality`→`type` + 顶层 `plugins[]`；PUT op `setImplConfig` 注释更新（values 是 schemaConfig delta） |
| `app/server/src/plugin/plugin-policy-store.ts` | 不动 | `setEnabled`/`setImplEnabled` 已独立无 bug（v0.0.4），无需改 |

### 前端（组件 spec 已就绪，文件级清单归 coder 编码前置产出）

| 文件 | 操作 | 备注 |
|------|------|------|
| `app/web/src/components/settings/PluginSettingsPage.tsx` | 重构/拆分 | 拆为 `plugin-config-page/page-plugin-config.tsx`（两 tab）+ `section-plugin-list.tsx`（插件 tab，独立 state）+ `section-ext-point-area.tsx`（扩展点 tab） |
| `app/web/src/components/settings/ExtImplRow.tsx` | 拆分 | 拆为 `component-ext-impl-radio.tsx` / `component-ext-impl-checkbox.tsx` / `component-ext-impl-ordered.tsx`（按 type 分化） |
| `app/web/src/components/settings/AppSettingsPage.tsx` | 重构 | 改 `app-dev-config-page/page-app-config.tsx`（三栏），ProvidersSection 嵌入 providers group 配置区 |
| `app/web/src/components/settings/DevSettingsPage.tsx` | 重构 | 改 `app-dev-config-page/page-dev-config.tsx`（三栏 KV） |
| 新增 `app/web/src/components/{framework,common,app-dev-config-page,plugin-config-page}/*` | 新增 | 22 组件（见 `specs/ui/components/` 清单） |

## 范围边界（v0.0.5 tech 层）

### IN SCOPE

1. ext point type 显式化（inventory 字段 cardinality→type；EP interface 不动）。
2. impl schemaConfig 新增（per-key UI schema）+ setImplConfig 语义澄清（API 参数仍 implId）。
3. group 独立保存（AppConfigService / DevConfigService 加 setGroup）。
4. plugin enable 独立（inventory 加顶层 plugins[]；后端 setEnabled 已独立无 bug）。
5. provider/model 统一为普通 app config group（端点不动，UI 三栏化）。

### OUT OF SCOPE

- `PluginManager.getExtensionImpls` 运行时 active 投影逻辑（两级 enabled 合取不变）。
- `/provider` `/provider/:id/model` 端点契约（v0.0.5 完全不变）。
- credentials 脱敏 / tombstone 软删逻辑（沿用 v0.0.4）。
- chat SSE / chat LlmClient（v0.0.5 不涉及）。

## 对 `specs/ui/overall/02-llm-chat.md` 的同步点（coder 编码时同步更新，architect 列出）

coder 编码 v0.0.5 前端时**必须同步更新** `specs/ui/overall/02-llm-chat.md`：

1. **§4 AppSettingsPage**：改「v0.0.5 三栏化（功能导航 + group 列表 + 配置区）」；providers group 配置区 = ProvidersSection（沿用，UI 入口三栏化）；appearance group = KV 卡片（theme）；新增 testid 规范（`group-list` / `group-item-{groupId}` / `config-area` / `group-save-{groupId}`）。
2. **§5 PluginSettingsPage**：改「v0.0.5 两 tab（插件 / 扩展点）」；插件 tab testid（`plugin-tab` / `plugin-list` / `plugin-item-{pluginId}` / `plugin-toggle-{pluginId}`，**每个 toggle 独立 state**）；扩展点 tab testid（`ext-tab` / `ext-group-list` / `ext-point-{pointId}` / `ext-impl-radio-{implId}` / `ext-impl-checkbox-{implId}` / `ext-impl-ordered-{implId}` / `ext-impl-drag-{implId}` / `ext-impl-config-btn-{implId}` / `schema-config-modal-{implId}`）。
3. **§6 DevSettingsPage**：改「v0.0.5 三栏化」，llm_request group = KV 卡片。
4. **§7 关键用户路径**：追加 PRD §3.9.6 的 6 条路径（三栏 group 保存 / 插件开关独立 / exclusive radio / list checkbox / ordered 拖拽 / schema 弹层）。
5. **§4.1 providers 区 testid**：ProvidersSection 内部 testid（`provider-*` / `model-*`）**沿用 v0.0.4 不变**（端点不动，UI 内部 CRUD 控件不动，只是外层包了三栏 group 容器）。

## 版本

version: 1.0
