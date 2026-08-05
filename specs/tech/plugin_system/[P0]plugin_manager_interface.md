---
type: interface
title: Plugin Manager Interface
priority: P0
status: active
updated: 2026-07-26
since: v0.0.3
related: [[P0]extension_point_interface.md, [P0]ext_impl_and_manifest_interface.md, [P1]plugin_lifecycle.md]
---

# Plugin Manager Interface

## 1. 概述

PluginManager 定义「按 cardinality 解析 ext impl 的运行时活动投影 + 单一 getter `getExtensionImpls`」——返回该扩展点的 active impl 实例列表（已按 cardinality 解析 + 按当前 config 实例化）。
**不管**：ext impl 的声明（→ `[P0]ext_impl_and_manifest_interface.md`）、发现与生命周期（→ `[P1]plugin_lifecycle.md` / `[P1]discovery_and_install_interface.md`）、配置管理面（→ `config/[P0]plugin_config_service.md` 的 `PluginConfigService`）、运行时组合（各 consumer）。
**与外界交互**：实现落 `app/server/src/plugin/plugin-manager.ts`（`PluginManager` 类）；consumer（agent/context/tools 等）通过依赖注入拿到 `PluginManager` 实例后调 `getExtensionImpls(point)`；底层经 `ScopeConfigProvider`（代码声明 `scopes/*.yaml` 读视图）取 active/order/configValues（**不调 PluginConfigService**）。

PluginManager 是**带类型的注册表**：聚合所有 ext impl 对一个扩展点的贡献，对外暴露**单一 getter `getExtensionImpls`**，永远返回**一个实例列表**。它是管理层最薄的一环——**只存与取，不组合**。

registry 持有的是 ext impl 的**类**（按 `point + implId` 索引）；`getExtensionImpls` 时找到该 point 下 enabled 的 ext impl，**按当前 config 实例化**返回（config 改 → next-get 反映新实例）。

「返回 1 个还是多个、有没有顺序」**不是方法形状决定的**，而是**扩展点自己的 cardinality 属性**决定的。消费方/配置界面去读 `point.cardinality`：`exclusive` → 列表 ≤1 个元素；`list` → 多个、无序；`ordered` → 多个、已按 **effective order 升序**排好。冲突解析与排序规则不变，只是产出形状统一为「列表」。

> **effective order**：单一排序源（删 `ExtImpl.priority` 后）。运行时 = scope YAML impls 数组序（`ScopeImplConfig.order`，loader 填 1-based）；inventory 展示经 `computeEffectiveOrders` 末尾补位连续化（无声明的 impl 按登记序接到末尾，见 `config/[P0]plugin_config_service.md` §3.1）。两态同源（都来自代码声明数组序）——根治 order/priority 双语义裂缝。

> **active 投影 + membership 直读 provider**：`getExtensionImpls` 返回的是 **Registry ∩ active** 的运行时活动投影，在 get 时求值（惰性）。active 判定 = **membership**：`scopeConfigs.getImplConfig(sourceScope, implId) !== undefined`（impl 在该 scope 的 impls 列表中 = active，无 `?? true` 兜底）。**PluginManager 经 `ScopeConfigProvider` 读代码声明**（不读落盘 store），自己持有 active-set 逻辑（filter membership + 按数组序统一排序，**无 cardinality 分支**），**不调 PluginConfigService**——PluginConfigService 是只读管理面（inventory 给 UI/HTTP 用）。详见 `index.md` ③ + `config/[P0]plugin_config_service.md` §4.5。

## 2. 接口定义

```typescript
interface PluginManager {
  /** 单参重载：传入 extension point，返回该 point 的 active impl 实例列表
   *  （已按 cardinality 解析 + 按当前 config 实例化）。
   *  ≡ getExtensionImpls(point, 'default')，100% 向后兼容（现有调用方零改动）。 */
  getExtensionImpls<T>(point: ExtensionPoint<T>): T[];
  /** 带 scopeId 重载：per-EP 回退（激活→scope 配置，未激活→沿 extends 链回退，终点 default 配置）。
   *  scopeId='default' 时与单参重载行为完全一致（default 无特权：激活集 = default.yaml 声明集）。 */
  getExtensionImpls<T>(point: ExtensionPoint<T>, scopeId: string): T[];
}
```

> **scope 维度说明**：scope 是 ext-impl 配置层正交维度（agent loop 风格），与 `ExtensionPoint.group`（功能分区）正交——group 不读运行时（仅 UI 分区），scope 绑定 impl 列表/order/configValues（每 scope 独立一份）。`getExtensionImpls(point, scopeId)` 按 per-EP 回退规则取配置源（§3.6）：该 (scopeId, pointId) 激活 → 取 scope 自己的全量列表；未激活 → 回退取 default 全量列表。读取路径**类型无关**（无 cardinality 分支），仅「取列表/order/configValues 的源」按 scopeId 取。详见 `config/[P0]ext_impl_scope.md` §5。

### 解析规则（按 cardinality）

| cardinality | 列表形状 | 解析 | 冲突处理 |
|---|---|---|---|
| `exclusive` | 0 或 1 个元素 | 无运行时分支：validator 保证该 EP 恰好 1 个 active（membership），统一 filter+sort 后 `[0]` 即唯一项（见 §3.5） | 0 个或多于 1 个 active → 启动校验硬失败（不配不崩运行时，但启动期 throw） |
| `list` | 多个，无序 | 全部保留 | 同 implId 重复 → 后者覆盖 + warning（见决策 3.3） |
| `ordered` | 多个，已按 **YAML 数组序升序**排好 | 按 `ScopeImplConfig.order`（数组序）升序（小者靠前） | 不冲突（数组序天然唯一） |

消费方按 `point.cardinality` 判定列表形状：exclusive 取 `[0]`（不存在则视为缺失/抛错由消费方决定）；list 直接迭代或按 implId 自取；ordered 直接 reduce。

> **active 投影与两级 enabled 门**：上述解析只处理「已通过 enabled 门」的 ext impl。一条 ext impl 进 active 当且仅当 `plugin.enabled ∧ impl.enabled`（两级门，见 `config/[P0]plugin_config_service.md` §4.5；plugin 级恒 true，impl 级 = scope impls 列表 membership）。通过后按当前 config 实例化（见 `[P1]plugin_lifecycle.md` §2）。

## 3. 设计决策

### 3.1 单一 getter `getExtensionImpls`，cardinality 是 EP 自身属性

**结论**：PluginManager 只暴露**一个** `getExtensionImpls<T>(point): T[]`，永远返回列表；「1 个/多个/有序」不是方法形状决定的，而是扩展点自身的 `cardinality` 属性决定的——消费方与配置界面读 `point.cardinality` 来判定列表形状与渲染控件。
**理由**：cardinality 是 EP 的固有属性，它同时驱动两件事：(1) 运行时消费语义（exclusive 取 `[0]`、list 直接用、ordered reduce）；(2) 配置界面控件形态（exclusive→单选 radio、list→多选 checkbox、ordered→多选+可拖序）。两者共用同一来源（EP 字段），不会漂移。把「形状」编码进方法签名（三 getter）反而与「cardinality 是 EP 属性」自相矛盾——形状本来就在 EP 上，没必要再用三个方法名复述一遍。
**反例**：(a) discriminated union 返回：消费者每次要拆类型，啰嗦且易错。(b) 三个 getter `get`/`list`/`ordered`：把 cardinality 重复编码进方法名，导致「EP 上有 cardinality 字段 + 又有三个 getter」两处真相源，且无法自然驱动配置界面控件（配置界面拿不到「方法名」，只能拿 EP）。
**冲突解析**：exclusive 由 validator 保证恰好 1 active（无运行时分支）；ordered 按 YAML 数组序升序；list 同 implId 后者覆盖 + warning。详见 §2 解析规则表 + §3.5。

### 3.2 管理层不组合

**结论**：PluginManager 只存只取，不做 reducer / middleware / 合并；组合全在消费侧。
**理由**：见 `[P0]extension_point_interface.md` §3.2——组合语义天然各异，焊框架会过度抽象或漏 case。
**反例**：若 manager 内置 pipeline 折叠，不同 pipeline 点要不同折叠策略，manager 膨胀且与消费侧重复。

### 3.3 list 的 implId 冲突：last-write 覆盖 + warning

**结论**：同一 list 扩展点内两条 ext impl `implId` 相同 → 后登记者覆盖，并记一条 warning。
**理由**：插件升级/替换时，新版本用同 implId 覆盖旧版本是常见且期望的行为；报错会让升级卡住。
**反例**：若 implId 冲突即报错，则「换一个同位替代实现」必须先卸载旧的，升级体验差。

### 3.4 静态注册（P0，类登记 + get 时实例化，无 activate 钩子）

**结论**：启动时宿主按各插件 manifest 的 `extImpls` 声明，把 ext impl 的**类**（`ExtImpl.impl` 指向的模块 default export 的类）登记进 registry（按 `point + implId` 索引）；P0 不引入运行时 `activate(ctx)` 钩子——impl 是类，框架 get 时实例化，无需 activate 仪式。**运行时 PluginManager 经 `ScopeConfigProvider` 读 active/order/configValues**（membership 判定，不调 PluginConfigService，见 §1）。
**理由**：内置/已安装插件的 ext impl 在 manifest 中已静态声明（impl 模块导出类），登记只是存类的引用、无需实例化；实例化推迟到 `getExtensionImpls` 时按当前 config 进行（见 `[P1]plugin_lifecycle.md` §3.2），让 config 变更 next-get 自然反映。可见性决策（active/order/选中）由代码声明 `scopes/*.yaml` 提供，注册只是执行登记。
**反例**：若 P0 强制每个 ext impl 通过 `activate(ctx)` 返回实例，则纯静态/内置插件背负多余初始化负担、config 变更需重新激活（破坏 next-get 语义）；且把"登记"与"实例化"耦合，P0 无法独立成立。

### 3.5 exclusive 解析：validator 恰好 1 active + 统一排序取 [0]

**结论**：`exclusive` 无独立运行时分支。机制：
1. **membership active**：active = impl 在该 scope impls 列表中（`getImplConfig(...) !== undefined`，无 `?? true` 兜底）。
2. **validator 保证恰好 1**：启动校验强制 exclusive EP 在其 scope 的 active impl 数量恰好 1（0 个或多于 1 都 throw，D3 硬失败）——「选谁」在 YAML 层面就是「数组只列这 1 项」。
3. **统一 filter+sort 后 `[0]` 即唯一项**：`getExtensionImpls` 对所有 cardinality 走同一路径（filter membership + 按 YAML 数组序升序 + instantiate），exclusive 的恰好 1 active 自然成为返回列表的唯一元素。

**理由**：删 priority 后「显式标记 + fallback」两层机制（旧 `exclusivePick`：enabled 门 + effective order 最小者）本质是「≤1 生效」的迂回表达；membership 模型下「数组恰好 1 项」直接表达同一语义，运行时无需分支——validator 把「恰好 1」提前到启动期保证，运行时只信不变量。cardinality 仍驱动 UI 控件形态（radio/checkbox/ordered）与 validator 规则，两处消费足够。

> **实现**：`app/server/src/plugin/plugin-manager.ts` 的 `getExtensionImpls`（统一路径；旧 `exclusivePick()` / `resolveByCardinality` 已删）。**[v0.0.72] `web_search_provider` 由 `exclusive` 改 `list`**（由 tool 按 `app_config.web_search.type` 在 list EP 中精确匹配 impl）。

**反例**：(a) 运行时保留 exclusive 分支（switch on cardinality）= 同一「选谁」语义在 validator 与运行时两处表达，易漂移；(b) 若 validator 不保证恰好 1 而靠运行时 fallback 取最小 order，则「未配置」与「配置了 1 项」无法区分，misconfig 静默通过。

### 3.6 per-EP 回退解析（scopeId 重载，extends 链 + default 无特权）

**结论**：`getExtensionImpls(point, scopeId)` 按 per-EP 回退规则取配置源，委托 `ScopeConfigProvider.resolveSourceScope(scopeId, pointId)` 返回该 (scope, point) 实际应取的源 scopeId：
1. **入口校验**：scopeId 未注册 → throw（v0.0.204 runtime defense，不静默兜底 default）。
2. **激活**（`activatedPoints` 含 pointId，YAML point 节点存在性）→ 返 `scopeId`（取该 scope 自己的 impls 全量列表，零 delta merge）。
3. **未激活** → 沿 `extends` 链逐级回退（链终点 `'default'`，继承 default 全量列表；per-EP 粒度回退，非整 scope）。
4. **default 无特权**（v0.0.206 删 plugin scope D6）：`'default'` 是 extends 链 root 终点，循环走到自然返回、无短路特判——default 激活集 = default.yaml 声明集（不配 = 关），与单参重载行为一致。

**取源后**：impl 的 active（membership）/ order / configValues 按源 scopeId 取（`scopeConfigs.getImplConfig(源scopeId, implId)`；plugin 级恒 true 不分 scope）。读取路径**类型无关**（统一 filter + 按数组序排序），inventory 展示侧 `computeEffectiveOrders` 连续化算法不变（详见 `config/[P0]ext_impl_scope.md` §5.2 + §9 末行）。

**理由**：(1) **per-EP 粒度**（非整 scope）——激活粒度 = EP；(2) **default 无特权**——「membership 即启用」对 default 同效，default.yaml 成为「impl 可不可用」唯一事实源（v0.0.206 channel EP 接入依赖此语义：不配 = 关）；(3) **全量替换语义清晰**——scope 出现某 EP 节点 = 完整声明自己的列表，无「在 default 上做修改」的 delta 中间态（旧 `?? true` 兜底曾让「未列 impl」语义含糊：是继承 default 还是默认 active，两者答案不同）。

**反例**：(a) 若按整 scope 回退（非 per-EP），则 scope 部分激活时其他 EP 也被迫激活，破坏「per-EP 继承」模型；(b) 若保留 default 短路，则「default.yaml 删掉某 EP」无法表达「关闭该 EP」（channel 验收状态不可达）；(c) 若保留 delta merge，则 scope 配置的真实效果要脑内叠加 default 才能看清，读配置 ≠ 读行为。

## 4. 示例

```typescript
const mgr: PluginManager = getPluginManager();

// exclusive：示例 EP（cardinality=exclusive，列表 ≤1 个元素，取 [0]）
// [v0.0.72] web_search_provider 改 list 后不再用此模式；此处保留为通用示例
const exclusiveProviders = mgr.getExtensionImpls(SomeExclusivePoint);
const picked = exclusiveProviders[0];  // 缺失/冲突时由解析规则抛错或返回空，消费方按需处理

// [v0.0.72] web_search_provider（改 list 后）：按 app_config.web_search.type 精确匹配 impl.id
const searchProviders = mgr.getExtensionImpls(WebSearchProviderPoint);
const wsType = appConfig.get('web_search', 'default')?.type;
const search = searchProviders.find(p => p.id === wsType);  // 不取首个、不静默回退

// list：所有 provider（cardinality=list，无序列表，按 implId 自取）
const providers = mgr.getExtensionImpls(LlmProviderPoint);
const anthropic = providers.find(p => p.implId === "anthropic_compatible");

// ordered：prompt builders（cardinality=ordered，已按 effective order 升序，消费侧直接折叠）
const builders = mgr.getExtensionImpls(SystemPromptMapperPoint);
const systemPrompt = builders.reduce((acc, b) => b.append(acc), basePrompt);

// scopeId 重载：取 'release' scope 下该 point 的 impl（per-EP 回退）
const releaseBuilders = mgr.getExtensionImpls(SystemPromptMapperPoint, 'release');
// release 此 point 激活 → 取 release 配置；未激活 → 回退取 default 配置（per-EP 粒度）
```

## 5. 边界

| 零件 | 归属 |
|---|---|
| `getExtensionImpls`、解析规则、active 投影语义、get 时实例化 | 本文件 ✅ |
| ExtensionPoint + cardinality 定义 | `[P0]extension_point_interface.md` |
| 静态注册（P0，ext impl 类如何进注册表） | 本文件 §3.4 ✅ |
| 实例化时机与 config 注入（P1 详细） | `[P1]plugin_lifecycle.md` |
| active 列表 / 排序 / exclusive 恰好 1 的策略输入（scopes/*.yaml） | `plugin_system/[P1]scopes_config_decl.md`（经 `ScopeConfigProvider`） |
| channel impl 组合（v0.0.206 起经 getExtensionImpls 统一 scope 解析，ChannelManager 按 config 动态 connect） | `specs/tech/channel/[P0]channel_manager.md` |
| 配置界面控件由 cardinality 驱动 | `[P0]extension_point_interface.md` §3.7 |
