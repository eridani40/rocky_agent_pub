---
type: interface
title: Ext Impl & Plugin Manifest Interface
priority: P0
status: active
updated: 2026-07-19
since: v0.0.3
related: [[P0]extension_point_interface.md, [P1]plugin_lifecycle.md, [P0]builtin_plugins_directory.md]
---

# Ext Impl & Plugin Manifest Interface

## 1. 概述

manifest 声明定义「插件如何**静态声明**自己向哪些扩展点贡献什么实现（ext impl 列表），以及 impl 级 configSchema（免代码校验）与版本兼容块」。
**不管**：扩展点定义（→ `[P0]extension_point_interface.md`）、运行时实例化（→ `[P1]plugin_lifecycle.md`）。
**与外界交互**：manifest 类型落 `app/server/src/plugin/manifest.ts`（`PluginManifest` / `ExtImpl`）；实例落 `app/plugins/builtins/<pluginId>/plugin.json`；BuiltinLoader 读取后调 `Registry.register()` 登记进 registry（见 `[P0]builtin_plugins_directory.md`）。

一个插件用一份 **manifest 声明**：它向哪些扩展点贡献哪些 ext impl（`extImpls`）。manifest **纯静态、不指向可执行入口、不含版本号**——版本与宿主兼容性放**包元数据**中（具体形式不规定），与声明分离。

**声明与运行分离**：discovery / 激活计划 / 配置后台只读 manifest（**不跑插件代码**）；只有 `getExtensionImpls` 时框架才按当前 config 实例化 impl 类（见 `[P1]plugin_lifecycle.md`）。

## 2. 接口定义

```typescript
/** 一份插件清单 */
interface PluginManifest {
  /** 插件唯一 id，snake_case（必须等于 builtin 子目录名） */
  id: string;
  /** ext impl 列表（扩展实现）；一个插件可向多个 point 贡献多个 ext impl */
  extImpls: ExtImpl[];
  /** 插件展示名（plugin tab UI 用；缺省时 inventory 以 pluginId 作 fallback） */
  label?: string;
  /** 插件描述（plugin tab UI 用；缺省时 inventory 返回空串） */
  description?: string;
}

/** 一条 ext impl（扩展实现）：把一个实现类挂到某个扩展点 */
interface ExtImpl {
  /** 本 ext impl 的唯一标识（snake_case），作为 ext_impl_config 的逻辑 key */
  implId: string;
  /** 目标扩展点 id（见 [P0]extension_point_interface.md） */
  point: string;
  /** 实现模块路径；该模块导出一个**类**（框架注入 config/资源并实例化，见 [P1]plugin_lifecycle.md） */
  impl: string;
  /**
   * impl 级 description（三级 description 之一，代码硬编码非配置）。
   * 一句话说明该 ext impl 干什么，inventory 透传给 UI 呈现（radio/checkbox/ordered 控件副文本）。
   * 不进 plugin_policy 配置（用户不可改），缺省时 inventory 返回空串。
   * 与 plugin 级（PluginManifest.description）、ext point 级（ExtensionPoint.description）并列。
   */
  description?: string;
  /**
   * 本 ext impl 的 per-impl 配置 JSON Schema（唯一 schema 源，可选）。
   * 全系统的 config 概念收敛到这一个字段：校验、UI 控件路由、default 底座都从它取。
   *  - properties.<key>.type：UI 控件路由（string→input / number→input / boolean→switch
   *    / 含 enum keyword 的 string→select / object→分组）
   *  - properties.<key>.default：实例化时与 scope configValues deepMerge 的底座
   *  - properties.<key>.description：UI 副文本（i18n 占位符 `__MSG_...__`）
   *  - properties.<key>.enum：UI select 候选值（JSON Schema 标准 enum keyword）
   */
  configSchema?: JsonSchema;
}
```

### 版本与兼容（**包元数据**，不在 manifest 声明中）

版本与兼容性跟 manifest 声明分离，各自独立演化（具体存储形式不规定）。

```jsonc
// 包元数据示例（示例形式，非强制）
{
  "name": "@acme/my-context-engine",
  "version": "1.2.3",
  "host": {
    "compat": { "pluginApi": "^1.0.0" },   // 声明兼容的插件 API 范围
    "build": { "hostVersion": "0.1.0" }    // 构建时所对宿主版本
  }
}
```

## 3. 设计决策

### 3.1 manifest 纯静态，不指向可执行入口、不含版本

**结论**：manifest 声明只有 `id` + `extImpls` + 可选 `label/description`；配置 schema 在 ext impl 级（`ExtImpl.configSchema`）。代码入口、版本、兼容性都不在 manifest 中。
**理由**：让 discovery / 激活计划 / 配置后台能**完全基于 manifest 声明做决策而不跑代码**；版本与声明分离，各自独立演化（具体存储形式不规定）。
**反例**：若 manifest 含 `main` 入口或版本，则「读 manifest」与「跑代码」边界模糊，难以做免代码的安全校验与惰性实例化。

### 3.2 configSchema 用 JSON Schema，宿主免代码校验

**结论**：插件配置以 JSON Schema 声明（`ExtImpl.configSchema`，per-impl），宿主在实例化前用 schema 校验用户配置，错误不触发代码。
**理由**：配置错误是最常见故障，免代码校验让错误在启动前暴露，且配置后台能安全展示配置项。
**反例**：若靠插件运行时自校验，配置错误要到实例化后才报，且坏配置可能已触发副作用。

### 3.3 一个插件可贡献多个扩展点

**结论**：`extImpls` 是数组，一条插件可同时贡献多个 point。
**理由**：一个发布单元（npm 包）打包多个相关扩展点很常见（如一个 provider 包同时贡献 provider + embedding）。
**反例**：若一插件一 point，相关扩展被迫拆成多个包，发布/版本/依赖臃肿。

### 3.4 单一排序字段 order（删 priority），exclusive 与 ordered 复用 effective order

**结论**：`ExtImpl` **无 priority 字段**（已删除）。排序/选择唯一字段是 `ExtImplPolicyData.order`（per ext point 组内连续 `1..n`，从 1 开始，存于 plugin_policy 数据，见 `config/[P0]plugin_config.md` §2）；运行时 ordered 排序与 exclusive 解析**都读 effective order**（= record order ?? 末尾补位算法，见 `config/[P0]plugin_config_service.md` §3.1）。

**理由**：order/priority 双语义裂缝（UI 写 `implPolicy.order`、运行时读 `manifest.priority`，两套不互通）曾导致「拖了不生效」「顺序管理形同虚设」。单一字段 order 让 UI 配置与运行时执行同源，根治脱节。exclusive 也复用 effective order（无显式 setExclusive 时选 order 最小者，见 `[P0]plugin_manager_interface.md` §3.5），避免重新引入第二个排序概念。

**反例**：(a) OpenClaw 的 hook(priority) / middleware(注册顺序) 裂缝——正是要消除的；(b) 若保留 priority 作 exclusive 默认，则「删一半留一半」继续维持双语义裂缝，与决策 1 矛盾。

### 3.5 configSchema 仅在 ext impl 级（单一源），配置值 deepMerge

**结论**：
- **configSchema 唯一载体是 ext impl 级**（`ExtImpl.configSchema?`，per-impl）。一个插件贡献多 point 时，可为不同 ext impl 各自带不同形状的 schema。
- **不在 plugin 级**——v0.0.71 D8 删除原 `PluginManifest.configSchema?` + `config?` 字段（0 plugin 声明 + 0 代码读，死字段）。
- **不在 EP 级**——EP 只是 contract（代码常量），不管 config（见 `[P0]extension_point_interface.md` §3.8）。
- 配置值 deepMerge 合并，**app config 盖 manifest default**：
  - **manifest 默认**：`ExtImpl.configSchema.properties.<key>.default`（per-impl）。
  - **app config**：用户/应用在代码声明 `scopes/*.yaml` 的 `impls[implId].configValues` 填的值（v0.0.67 起代码声明，详 `config/[P0]ext_impl_scope.md §4.2`）。
- 生效 config = `deepMerge(extractConfigDefaults(configSchema), scopeConfigValues)`，按 `configSchema` 免代码校验后由框架在实例化 impl 类时注入构造参数（`PluginManager.instantiate` 用 `deepMerge`，v0.0.71 D8 修复 BUG-PLUGIN-004）。

**理由**：每个 impl 参数天然不同（LanceDB 要 `dbPath`、in-memory 不要），schema 必须随 ext impl 走；plugin 级 schema 在 0 使用下是死字段，删除消除「plugin 级 + impl 级两层并存」的认知负担与双源漂移风险。

**反例**：若 schema 放 EP 级，不同 impl 的差异参数无处表达；若保留 plugin 级 + impl 级两层并存（原设计），0 使用的 plugin 级字段成死代码，且 spec 偏离代码现实（教训 v0.0.49 类型）。

### 3.6 impl 模块导出实现类（非 activate）

**结论**：impl 模块（`ExtImpl.impl` 指向的文件）**default export 一个类**；框架在 `getExtensionImpls` 时按当前 config 实例化该类并返回（config 改 → next-get 反映新实例）。无 `activate(ctx)` 仪式。
**理由**：impl 是代码定义的「实现」，自然就是类；身份是 string（`implId`），无额外实体 id；config 与资源在 get 时注入，配置变更 next-get 即反映，无需重新激活。
**反例**：若 impl 导出 `activate(ctx)` 返回实例，则 config 变更需重新跑 activate（违反「运行时变更不重跑激活」，见 `[P1]plugin_lifecycle.md` §3.5）；且把「声明」与「初始化」耦合，P0 无法独立成立。

### 3.7 configSchema 单一源：校验 + UI 控件路由 + default 底座同源

**结论**：`ExtImpl.configSchema`（JSON Schema）是全系统**唯一**的 config schema 源，三职责同源：
- **校验**：宿主按 JSON Schema 免代码校验（§3.2）。
- **UI 控件路由**：前端按 `configSchema.properties.<key>.type` 推导控件（string→input / number→input / boolean→switch / 含 `enum` keyword 的 string→select / object→分组）。PRD §3.9.5 schema 弹层用本字段渲染。
- **default 底座**：实例化时 `extractConfigDefaults(configSchema)`（取 `properties.<key>.default`）与 scope configValues deepMerge（详 §3.5）。

v0.0.71 D7 删除原 `ExtImpl.schemaConfig?`（per-key 简化形态）+ `SchemaConfigEntry` type——schemaConfig 与 configSchema 双源漂移风险高，且 schemaConfig 的 `description/options/enum` 信息可由 JSON Schema 标准 `description/enum` keyword 表达，无独立载体必要。7 个 builtin plugin 的 schemaConfig 块已并入各自 configSchema.properties.<key>。

**理由**：JSON Schema 是标准、通用、可演化的 schema 形态；控件路由按 `properties.<key>.type` + `enum` keyword 推导足够覆盖 5 态（string/number/boolean/enum/object），无需第二个简化形态。单一源消除「schemaConfig 改了 configSchema 没改」的双源漂移。

**反例**：若 schemaConfig + configSchema 并存（原设计），则 enum 候选值在 schemaConfig.options 与 configSchema.enum keyword 两处可声明，需保持同步；UI 控件路由（schemaConfig.type）与校验（configSchema.type）两套语义，复杂 JSON Schema 的 anyOf/$ref schemaConfig 表达不了。

### 3.8 impl 级 description（三级 description 之一，代码硬编码）

**结论**：`ExtImpl` 新增可选 `description?: string`——impl 级一句话说明，**代码硬编码**（写在 manifest/ExtImpl 定义里），**不进 plugin_policy 配置**（用户不可改）。inventory 透传给 UI 呈现（radio/checkbox/ordered 控件副文本，见 `specs/ui/components/plugin-config-page/component-ext-impl-*.md`）。与 plugin 级（`PluginManifest.description`）、ext point 级（`ExtensionPoint.description`，见 `[P0]extension_point_interface.md` §3.9）共同构成**三级 description**。

> **`[v0.0.62 i18n]` description 值的两种形态**：**代码硬编码**指 description 由产品代码声明（非用户配置），其值可以是 (a) **字面文案**（如 `"Anthropic 鉴权 header 构造"`）——第三方/老 plugin 的默认形态；或 (b) **`__MSG_<dotted.key>__` i18n 占位符**（如 `"__MSG_plugin.builtin.llm_anthropic.impl.anthropic_compatible.description__"`）——v0.0.62 起 builtin plugin 的本地化形态，前端组件经 `resolveI18nField(value, t)` helper 翻译（识别占位符 → `t()` 查 locale 表，否则直展原文兼容）。**字段类型 `string` 不变**，向后兼容。详见 `specs/tech/i18n/[P1]manifest_i18n.md`。

**理由**：plugin 配置界面光给 implId（snake_case 标识）用户看不懂；plugin 级已有 description（透传到 plugins[] 节点），ext point/ext impl 级缺。三级 description 都属「代码定义的存在性属性」（与 implId/point/cardinality 同源），不应进数据表（用户不能改代码定义，也不应能改其描述）。inventory 透传是「算出来」的全量视图一部分（overlay 模型，树来自 registry 代码）。

**反例**：(a) 若 description 进 plugin_policy 配置，则与「代码定存在性、数据定增量」的 overlay 模型矛盾——description 是代码定义的固有属性，不是用户改过的增量；(b) 若只在 manifest 文档里写不在 interface 字段里，则 inventory 无法透传，UI 拿不到。

## 4. 示例

manifest 声明示例（无 priority 字段；ext impl 带 description + impl 级 configSchema）：
```json
{
  "id": "memory_lancedb",
  "extImpls": [
    {
      "implId": "lancedb_ctx_engine",
      "point": "context_engine",
      "impl": "./context_engine.ts",
      "description": "LanceDB-backed context engine for long-term memory retrieval",
      "configSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "dbPath": { "type": "string", "default": "./data/lancedb", "description": "LanceDB 存储路径" },
          "embeddingDim": { "type": "number", "default": 1024, "description": "向量维度（内部/高级）" }
        }
      }
    }
  ]
}
```

impl 模块示例（`./context_engine.ts`，default export 一个类，非 activate；框架约定构造器签名 `(implId, cfg)`——`implId` 便于实例自识别身份，`cfg` 为已校验的合并 config）：
```typescript
export default class LanceDbContextEngine implements ContextEngine {
  constructor(implId: string, cfg: { dbPath: string }) { /* open db */ }
  // ...ContextEngine 契约方法
}
```

对应包元数据示例（包元数据示例，非强制）：
```json
{
  "name": "@acme/memory-lancedb",
  "version": "0.4.1",
  "host": { "compat": { "pluginApi": "^1.0.0" }, "build": { "hostVersion": "0.1.0" } }
}
```

## 5. 边界

| 零件 | 归属 |
|---|---|
| ExtImpl 字段、impl 级 configSchema、host 版本块 | 本文件 ✅ |
| 扩展点 id 与 cardinality | `[P0]extension_point_interface.md` |
| 实例化时机与 config 注入 | `[P1]plugin_lifecycle.md` |

