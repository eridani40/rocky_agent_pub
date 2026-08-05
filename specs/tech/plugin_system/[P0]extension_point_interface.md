---
type: interface
title: Extension Point Interface
priority: P0
status: active
updated: 2026-07-19
since: v0.0.3
related: [[P0]ext_impl_and_manifest_interface.md, [P0]plugin_manager_interface.md]
---

# Extension Point Interface

## 1. 概述

Extension Point 定义「扩展点的形状与 cardinality 三态语义」——是注册表存取形状的契约源。
**不管**：插件如何声明 ext impl（→ `[P0]ext_impl_and_manifest_interface.md`）、注册表如何解析（→ `[P0]plugin_manager_interface.md`）、运行时如何组合（→ 各 consumer 自定）、UI 分区元数据（→ `[P1]groups_meta_decl.md`）。
**与外界交互**：EP 由宿主/三方在代码中定义常量（`app/server/src/plugin/extension-point.ts`），bootstrap 时调 `Registry.registerExtensionPoint()` 登记进 registry，供 cardinality 解析 + inventory JOIN；EP 的 UI 分区归属（group）v0.0.71 起迁到 `app/plugins/groups.json` 唯一源（见 `[P1]groups_meta_decl.md`）。

Extension Point 是 Plugin System 的核心抽象：一个**有名字的契约槽位**，多个插件可向它贡献实现。每个扩展点声明 **cardinality**，决定注册表「存什么、检索时返回什么形状」。

cardinality **只是管理策略**——它决定注册表的存储与检索形状，**不规定运行时如何组合**。组合（middleware/reducer/合并规则）由消费该扩展点的子系统自行定义。

## 2. 接口定义

契约（contract）是一个**接口（类型）**，由泛型 `TContract` 携带；**实现**（implementation）是满足该接口的实例。TS 的 interface 无运行时表示，故契约是**类型而非值**——不写成 `contract` 字段，扩展点的运行时身份是其 `id`（见决策 3.5）。

```typescript
interface ExtensionPoint<TContract> {
  /** 扩展点唯一 id，snake_case，如 "context_engine"、"llm_provider"、"prompt_builder" */
  id: string;
  /** 注册表如何消费多个 ext impl */
  cardinality: "exclusive" | "list" | "ordered";
  /**
   * ext point 级 description（三级 description 之一，代码硬编码非配置）。
   * 一句话说明该扩展点干什么，inventory 透传给 UI 呈现（ext point header 副文本，
   * 见 specs/ui/components/plugin-config-page/section-ext-point-area.md）。
   * 不进 plugin_policy 配置（用户不可改），缺省时 inventory 返回空串。
   * 与 plugin 级（PluginManifest.description）、ext impl 级（ExtImpl.description）并列。
   */
  description?: string;
}
```

> **v0.0.71 D1 删 `ExtensionPoint.group` 字段**：原 `group: string` 必填字段已删除（13 个 builtin EP 常量的 `group:` 行同步删）。group 归属迁到外部 `app/plugins/groups.json` 元数据唯一源（`GroupMeta.extPoints[]`），inventory JOIN `GroupMetaProvider` 按 groups.json 声明序聚合（见 `[P1]groups_meta_decl.md`）。EP 自身只保留运行时身份字段（id/cardinality/description）。理由见 §3.6。

### cardinality 三态（配置/读取类型无关，仅 validator + UI 消费）

| cardinality | 注册表存储 | 检索返回形状 | 选择/排序规则 |
|---|---|---|---|
| `exclusive` | 全存，按 ext impl `implId` 索引 | 一个 list（恰好 1 个元素） | 该 scope impls 数组**恰好 1 项**（validator 启动硬失败保证；运行时统一 filter+sort 后 `[0]` 即唯一项，见 `[P0]plugin_manager_interface.md` §3.5） |
| `list` | 全存，按 ext impl `implId` 索引 | 一个 list（含全部 active，无序） | 无选择；调用方按 implId 取；同 implId 重复后者覆盖 + warning |
| `ordered` | 全存，按 `implId` 索引 | 一个有序 list | active 按 **YAML 数组序升序**（`ScopeImplConfig.order`，loader 填 1-based；inventory 展示侧再经 `computeEffectiveOrders` 连续化，见 `config/[P0]plugin_config_service.md` §3.1） |

> **类型无关化（impl 列表模型）**：cardinality 是 EP 的 intrinsic 属性（保留），但配置与运行时读取**不按类型分支**——配置 = impl 列表（membership = active，数组序 = order），运行时统一「filter membership + 按数组序排序」。cardinality 只剩两个消费方：**validator**（exclusive → 数组恰好 1）+ **UI / inventory**（按 `type` 渲染 radio/checkbox/ordered；`selected` 派生 = exclusive active 中 order 最小者）。
>
> **order 语义**：数组顺序即 order（YAML 写入序），无独立 order 字段。`exclusive` 数组恰好 1 项；`list` 不关心顺序但统一保留数组序。

## 3. 设计决策

### 3.1 cardinality 显式写在扩展点定义里

**结论**：cardinality 是 ExtensionPoint 的字段，三态 `exclusive | list | ordered`，全系统统一（`exclusive`=独占≤1、`list`=无序并存、`ordered`=有序串联）。
**理由**：要「所有可扩展配置归一」，显式字段给一个统一心智；消费者从扩展点定义即可知道列表形状是「≤1 / 多个无序 / 多个有序」。
**反例**：OpenClaw 把 cardinality 按 capability 类型**隐式**分散（memory 靠 `kind` 选一、channel 靠 id 并存、hook 靠 priority），无统一概念，且 hook 用 priority / middleware 用注册顺序产生**不一致裂缝**（见 `refs/openclaw/src/plugins/agent-tool-result-middleware.ts`）。

### 3.2 cardinality 只是管理策略，组合下放消费侧

**结论**：框架只保证「按 type 给你 instance / list / 有序列表」；怎么组合（reducer 折叠、middleware `(ctx, next)`、合并规则）由各 consumer / 扩展点自定。
**理由**：不同扩展点的组合语义天然不同（prompt 拼接 vs 工具结果转换），焊在框架里要么过度抽象要么漏 case；下放后每个协议自定。
**反例**：若框架规定统一 middleware `(ctx, next)`，纯拼接型扩展点被迫多套一层 `next()`；若规定 reducer，需要短路的扩展点表达不了。

### 3.3 ordered 只用 effective order 一个排序原语（删 priority）

**结论**：`ordered` 点的顺序**只**用 `effective order`（= `ExtImplPolicyData.order` record ?? 末尾补位算法，见 `config/[P0]plugin_config_service.md` §3.1），不引入 before/after 提示，不依赖注册顺序；`exclusive`/`list` 点不参与 ordered 排序。`ExtImpl.priority` 字段已删除（见 `[P0]ext_impl_and_manifest_interface.md` §3.4）。

**理由**：单一原语可预测、可被配置后台直接编辑；避免「注册顺序」这种隐式依赖。order/priority 双语义裂缝（UI 写 order、运行时读 priority）曾导致拖动不生效；统一为 effective order（record 优先，无 record 时按 manifest 登记序末尾补位）让 UI 配置与运行时执行同源。

**反例**：(a) OpenClaw middleware 用注册顺序排序，导致顺序依赖加载时序、难复现、配置后台无法直接调整；(b) 若保留 priority 作 ordered 排序源，则 UI 改 order 不影响运行时，裂缝持续。

### 3.4 id 与 cardinality 字面量用 snake_case

**结论**：扩展点 id 与 cardinality 字符串字面量用 snake_case。
**理由**：与 [convention.md](../convention.md) §2 一致（type 字符串字面量 snake_case）。

### 3.5 契约是类型（泛型 TContract），不是运行时字段

**结论**：契约由泛型 `TContract` 携带，ExtensionPoint **没有** `contract` 运行时字段。
**理由**：契约是「实现必须满足的接口」，是**类型**；TS interface 无运行时表示，写成 `contract: TContract` 既非法（接口不能作值）又会让人误以为「契约是个可取到的对象」。泛型在编译期把契约绑到 getter（`getExtensionImpls<T>(point: ExtensionPoint<T>): T[]`）与 ext impl（`contribute<T>(point, impl: T)`），运行时身份用 `id`。
**反例**：若保留 `contract: TContract` 字段并填 `contract: ContextEngine`，因 `ContextEngine` 是 interface（非值）而编译失败；若改填一个 class/构造器，又把「契约」与「某个具体实现类」混为一谈。

### 3.6 group 元数据外置 groups.json（v0.0.71 D1，删 EP.group 字段）

**结论**：v0.0.71 D1 删除 `ExtensionPoint.group` 必填字段。group 归属（id/label/description/含哪些 EP）集中到 `app/plugins/groups.json` 元数据唯一源（详 `[P1]groups_meta_decl.md`）：
- `GroupMeta.extPoints: string[]` 显式列出该 group 包含哪些 EP（每 EP 出现且仅一次，D6 不变量，启动校验硬失败）。
- inventory `buildGroups` JOIN `GroupMetaProvider` 取 groupId，group 顺序按 groups.json 声明序（D5 七组固定排序）。
- 拆分 group（如把 context 拆 4 组）只改 groups.json，EP 代码零改动（v0.0.71 已实施：context 拆 context-ingest/context-assemble/context-compact/context-engine 四组）。

**理由**：
1. **group 是 UI 概念**（分区 + 显示序 + i18n 标签），不是 EP 固有属性；放 EP 上是错位（v0.0.4-v0.0.70 `group: "provider"` 字面量无 label/description 让 UI 无 meta 可读）。
2. **可演化**：拆 group 只改 groups.json，EP 代码零改动。
3. **唯一源**：避免 EP.group 字面量 + groups.json 双源漂移。

**不影响运行时**：group 只服务于配置 UI 分组、inventory group-centric 聚合；exclusive/list/ordered 解析、effective order 排序都不读 group。
**反例**：v0.0.4-v0.0.70 EP.group 字段（散落 string）+ 配置界面隐式按字面量聚合，缺 label/description 让 UI 无 meta 可读；本版反转。

**与 config 实体 group 字段的关系**：`ExtensionPoint.group`（已删）与 config 实体的 `group` 字段（`app_config` schema 的 `group:string required` KV 分片键）**不再有「同一概念两处体现」关系**——v0.0.71 起 EP 不带 group 字段，config 实体 group 仍是自身 KV 分片键（与 plugin ext group 解耦）；插件配置页的 group 分区现由 groups.json 提供，app 设置页的 group 分区仍由 config 实体 group 字段提供，二者各自独立，无中间映射表。

### 3.7 cardinality 驱动配置管理界面的控件类型

**结论**：cardinality 不仅决定 registry 解析形状与运行时 getter 语义（见 `[P0]plugin_manager_interface.md` §3.1），还决定**插件配置界面**对该扩展点下 ext impl 的渲染控件：
- `exclusive` → 单选控件（radio / select），同 point 内只能选一个 ext impl（生效 ≤1）
- `list` → 多选控件（checkbox），可启用任意子集（无序）
- `ordered` → 多选 + 可拖序控件，可启用子集并调整 effective order 顺序（per ext point 组内连续 1..n，见 `config/[P0]plugin_config.md` §2）

**理由**：「这个 EP 允许几个生效、要不要顺序」是 EP 的固有属性，运行时（`getExtensionImpls` 形状）与配置界面（控件形态）共用同一来源（EP 的 `cardinality` 字段），不会漂移。这也支撑了 §3.1 的单一 getter 决策——配置界面拿不到「方法名」，只能拿 EP 字段，单一 getter + cardinality 驱动让两端自洽。
**与 group 的区分**：group（v0.0.71 起在 groups.json）决定控件分到哪个 **tab**（§3.6），`cardinality` 决定同 tab 内控件的**形态**（单选/多选/可拖序）。两者正交，互不读。
**反例**：若配置界面控件形态另行定义（如一份独立 mapping），则与 cardinality 形成两处真相源；EP 改了 cardinality 而控件映射没更新，配置 UI 与运行时行为就不一致。

> **inventory 序列化字段名**：`PluginConfigService.inventory()` 的 ext impl 节点字段名为 **`type`**（值不变：`exclusive`/`list`/`ordered`），与 UI 组件契约（`component-ext-impl-radio`/`-checkbox`/`-ordered`）的 type 路由术语对齐，避免「cardinality↔type」二次翻译。EP interface 字段名仍 `cardinality`（代码零改动），仅 inventory 序列化字段改名。

### 3.8 EP 是 contract（代码常量），无 point 级 config

**结论**：ExtensionPoint 是**契约（contract）**——代码常量，由 EP 定义自带（`id` / `cardinality` / `description`，v0.0.71 删 `group` 字段后无 group），不持久化、不进任何数据表、无 point 级 config record。需要配置就**写死在 EP 定义里**（作为代码常量字段），不进数据表。
**理由**：EP 定义本身是代码常量（见 §2 接口定义与 §3.5 契约是类型不是值），其属性都是声明期固化的——「代码定存在性」。配置走 ext impl 级（`ExtImpl.configSchema`，v0.0.71 起 configSchema 唯一源），不走 point 级（见 `[P0]ext_impl_and_manifest_interface.md` §3.5）。
**反例**：若 EP 进数据表（schema 或 point 级 config），则 EP 定义被一拆为二（代码声明 + 表里数据），与「EP 是代码常量」的整个存在性模型矛盾，且增加一处需保持同步的真相源。

### 3.9 ext point 级 description（三级 description 之一，代码硬编码）

**结论**：`ExtensionPoint` 新增可选 `description?: string`——ext point 级一句话说明，**代码硬编码**（写在 EP 定义常量里，如 `extension-point.ts` 的 `LlmProviderPoint`），**不进 plugin_policy 配置**（用户不可改）。inventory 透传给 UI 呈现（ext point header 副文本，见 `specs/ui/components/plugin-config-page/section-ext-point-area.md`）。与 plugin 级（`PluginManifest.description`）、ext impl 级（`ExtImpl.description`，见 `[P0]ext_impl_and_manifest_interface.md` §3.7）共同构成**三级 description**。

> **`[v0.0.62 i18n]` description 值的两种形态**：同 §3.8 的两形态规则在此同样适用——**字面文案**（第三方/老 EP 默认）或 **`__MSG_<dotted.key>__` i18n 占位符**（v0.0.62 起 12 内置 EP description 全部占位符化为 `__MSG_extpoint.<id>.description__`，前端 `section-ext-point-area.tsx` 经 `resolveI18nField(pointDescription, t)` 翻译）。**字段类型 `string` 不变**。详见 `specs/tech/i18n/[P1]manifest_i18n.md`。

**理由**：plugin 配置界面光给 pointId（snake_case 标识）用户看不懂；EP 是代码常量（§3.8），其 description 是 EP 固有属性（声明期确定），与 id/cardinality 同源。inventory 透传是「算出来」的全量视图一部分（overlay 模型，树来自 registry 代码）。inventory 序列化时把 pointDescription 平铺到该 point 下每条 ext impl 节点（v0.0.71 嵌套结构 `groups[].points[].impls[]` 内 point 已是显式节点，pointDescription 仍平铺到 impls[] 节点便于 UI 单次取）。

**反例**：(a) 若 description 进数据表，与 §3.8「EP 是代码常量无 point 级 config」矛盾；(b) 若只在文档里写不在 EP 字段里，inventory 无法透传，UI 拿不到。

## 4. 示例

```typescript
// 典型扩展点。契约 = 尖括号里的接口类型（泛型携带），不是字段
// v0.0.71 D1：删 group 字段，group 归属迁到 app/plugins/groups.json。
// 旧 ContextEnginePoint(exclusive, id="context_engine") 已废弃——ContextEngine 不再整体
// 可替换，内部改 ordered handler/mapper/reducer。
const LlmProviderPoint: ExtensionPoint<LlmProvider> = {       // LlmProvider 见 [P0]llm_provider_interface.md
  id: "llm_provider",
  cardinality: "list",
  description: "__MSG_extpoint.llm_provider.description__",  // ext point 级 description（i18n 占位符）
};

const LlmProtocolPoint: ExtensionPoint<LlmProtocol> = {        // LlmProtocol 见 [P0]llm_protocol_interface.md
  id: "llm_protocol",
  cardinality: "list",
  description: "__MSG_extpoint.llm_protocol.description__",
};

// ordered 典型：system_prompt_mapper（契约 SystemPromptMapper 见 context/[P0]system_prompt.md）
const SystemPromptMapperPoint: ExtensionPoint<SystemPromptMapper> = {
  id: "system_prompt_mapper",
  cardinality: "ordered",
};

// exclusive 典型：示例 EP（v0.0.72 起 web_search_provider 改 list，不再作 exclusive 典型；契约 WebSearchProvider 见 web-search/types.ts）
const WebSearchProviderPoint: ExtensionPoint<WebSearchProvider> = {
  id: "web_search_provider",
  cardinality: "list",  // [v0.0.72] 由 'exclusive' 改 'list'（多 provider 共存，tool 按 app_config.web_search.type 单点路由）
  description: "__MSG_extpoint.web_search_provider.description__",
};

// context 模块共 6 个 ordered EP（v0.0.71 起分归 context-ingest/context-assemble/system-prompt
// 三个 group，详 groups.json；契约见各 detail 文档；整合索引 + rocky_context builtin impl 见
// context/[P0]extension point and implementations.md）：
//   - context_ingest_handler       （IngestHandler，context_ingest_detail.md §3）
//   - context_assemble_mapper      （AssembleMapper，context_assemble_detail.md §3）
//   - context_assemble_reducer     （AssembleReducer，context_assemble_detail.md §3）
//   - system_prompt_mapper         （SystemPromptMapper，system_prompt.md §3）
//   - system_prompt_reducer        （SystemPromptReducer，system_prompt.md §3）
//   - system_reminder              （SystemReminderProvider，system_reminder.md §3）
// 上述 EP + llm_provider / llm_protocol / web_search_provider 一起进 extension-point.ts 的
// BUILTIN_EXTENSION_POINTS；bootstrap 的 EP 注册循环自动带上。每个 EP 必须在 groups.json
// 某个 group 的 extPoints[] 出现且仅一次（D6 不变量，启动校验）。
```

## 5. 边界

| 零件 | 归属 |
|---|---|
| 扩展点定义、cardinality 三态语义 | 本文件 ✅ |
| group 元数据（id/label/description/含哪些 EP） | `[P1]groups_meta_decl.md` ✅ |
| ext impl（ExtImpl）字段 | `[P0]ext_impl_and_manifest_interface.md` |
| 注册表解析与 getter | `[P0]plugin_manager_interface.md` |
| 各契约接口（TContract）的内容 | 各自模块（`[P0]llm_provider_interface.md` / `agent/context/` 等） |
