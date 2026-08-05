---
type: spec
title: Plugin Lifecycle（声明 → 发现 → 注册 → 实例化）
priority: P1
status: active
updated: 2026-06-30
since: v0.0.3
related: [[P1]discovery_and_install_interface.md, [P0]plugin_manager_interface.md, [P0]ext_impl_and_manifest_interface.md]
---

# Plugin Lifecycle（声明 → 发现 → 注册 → 实例化）

## 1. 概述

本文件定义「插件从『装上磁盘』到『运行时可用』的四相流程，以及 impl 模块（default export 类）如何被框架实例化」。
**不管**：发现/安装的具体路径与规则（→ `[P1]discovery_and_install_interface.md`）、配置管理面策略（→ `config/[P0]plugin_config_service.md` 的 `PluginConfigService`）、注册表 getter（→ `[P0]plugin_manager_interface.md`）。
**与外界交互**：四相由 `BuiltinLoader`（manifest-registry 阶段）+ `PluginManager`（get 时实例化）协作完成，落 `app/server/src/plugin/`；config 决策由 `PluginConfigService` + `PluginPolicyStore` 提供。

插件生命周期分四相，**前三相不跑插件代码**，只有最后一相执行：

1. **发现（discovery，P1）**：扫描安装路径，凭 **manifest 标记文件**存在判定（具体文件名待定/可配置），读出声明。无代码。**P0 无此相**——native 内部代码注册，manifest 已知。
2. **manifest-registry（元数据索引）**：把所有发现的 manifest 建成索引，把 ext impl 的**类**登记进 PluginManager（按 `point + implId` 索引），供激活计划与配置后台查询。无代码（仅静态登记类的引用，不实例化）。
3. **enable（config 决定，取代"激活计划跑代码"）**：根据 PluginConfigService（config 模块）策略（启用/选择）决定「哪些 ext impl 在 active 投影里」。无代码。
4. **get 时实例化**：`getExtensionImpls(point)` 时，框架找到该 point 下 enabled 的 ext impl → **按当前 config 实例化 impl 类** → 返回。**跑代码（构造）**。

核心不变量：**discovered = registered**。**无 activate 钩子后没有"已激活但未实例化"的中间态**——一个 ext impl 要么登记在 registry（discovered/registered）、要么不在。唯一的状态闸是 **enabled**（plugin.enabled ∧ impl.enabled，两级门，在 get 时求值）。**config 改 → next-get 反映**（重新实例化新对象），不重跑任何"激活"。

## 2. impl 模块导出

impl 模块（manifest `extImpls[].impl` 指向的文件）**default export 一个类**（实现某扩展点契约 TContract）。**没有 `activate(ctx)`、没有 `HostCapabilities`**（P1/future，见 §3.5）。

```typescript
// impl 模块 default export 一个类，框架 get 时 new 它
export default class MyContextEngine implements ContextEngine {
  // 框架注入已校验的 config（来自 deepMerge(configSchema.default, manifest.config, appConfig)）
  // 构造器签名约定 (implId, cfg)——implId 便于实例自识别身份
  constructor(implId: string, cfg: Record<string, unknown>) { /* init */ }
  // ...ContextEngine 契约方法
}
```

**实例化的硬约束**：
- **构造参数 = 已校验 config**：框架在实例化前用对应载体的 `configSchema` 校验配置（plugin 级 + ext impl 级，分层合并见 `[P0]ext_impl_and_manifest_interface.md` §3.5），构造时注入，impl 无需再校验。
- **每次 get 按当前 config 实例化**：`getExtensionImpls` 默认每次按当前 config `new` 一个新对象；调用方若需稳定快照自行缓存。
- **构造时机是实现细节**：默认 get 时实例化（惰性），允许 registry 在注册时预实例化（如热路径），但 next-get 反映 config 变更的语义不变。

## 3. 设计决策

### 3.1 四相分离，前三相不跑代码

**结论**：发现 / manifest-registry / enable 全部基于 manifest 元数据 + config 决策，**绝不实例化 impl 类**；只有 get 时实例化执行代码。
**理由**：让「配置错误」「禁用」「未触发」都能在跑代码前判定——启动快、安全（坏插件不因被发现就执行）、配置后台可安全展示全部插件。
**反例**：若发现即实例化，则禁用的插件也跑代码、坏配置触发副作用、启动变慢。借鉴 OpenClaw `activation-planner.ts:68`（"Returns a deterministic activation plan without importing plugin runtime modules"）。

### 3.2 get 时实例化，而非 activate 时一次性

**结论**：impl 是类，框架在 `getExtensionImpls` 时按当前 config `new` 它并返回；不设 `activate(ctx)` 一次性初始化钩子。
**理由**：get 时实例化让 config 变更 next-get 自然反映（新 config → 新实例），无需热替换/重新激活机制；构造参数 = 已校验 config，注入路径单一、可预测。
**反例**：若用 `activate(ctx)` 一次性返回实例并缓存，则 config 变更后需重新跑 activate（破坏一次性语义、引入竞态），或要额外的热替换机制。

### 3.3 discovered = registered，无"已激活"中间态

**结论**：discovered（manifest 已知）即 registered（类已登记进 PluginManager）；**没有"已激活但未实例化"的中间态**。唯一状态闸是 enabled。
**理由**：删掉 activate 后，registry 持有类的引用就是"已注册"；"是否 active"由 get 时投影（registry ∩ enabled）决定，无需第二个集合。
**反例**：若保留"discovered ≠ activated"的双集合（原 activate 模型的残留），则要维护两套同步语义，复杂且无收益。

### 3.4 enable 由 config 决定，非"激活计划跑代码"

**结论**：哪些 ext impl 进 active 投影由 PluginConfigService 的 enabled 策略决定（plugin.enabled ∧ impl.enabled 两级门），而非"激活计划执行代码"。
**理由**：状态闸归 config（数据挂状态），代码只管登记；启用/禁用是纯数据操作，next-get 投影生效，无需重跑任何"激活"。
**反例**：若 enable 需"跑激活计划代码"，则每次 toggle 都重新执行代码、引入竞态与一次性约束破坏。

### 3.5 启动注册与运行时变更的关系

**结论**：启动期 manifest-registry 决定「**启动时**登记哪些 ext impl 的类（按 point + implId 索引）」；**启动之后**，enable/disable/select/order/config 这类配置变更**不重新实例化任何对象、不重跑任何"激活"**，而是通过 `getExtensionImpls` 的 get 时投影（Registry ∩ (plugin.enabled ∧ impl.enabled)）+ 按当前 config 实例化，在**下次 get 生效**（见 `[P0]plugin_manager_interface.md` §3.1、`config/[P0]plugin_config_service.md` §4.5）。
**理由**：避免「每次 toggle 都重新构造/激活」的复杂与竞态。discovered = registered 的不变量由「类已登记」表达；禁用一个 ext impl 不改 registry（类仍在），仅让 `getExtensionImpls` 的投影把它排除。
**反例**：若每次 enable/disable 都重新构造或重新登记，则同一 implId 在一次进程内被反复实例化、运行中已持有引用的代码无法预测对象身份何时被替换。

### 3.6 P0 = native 代码注册，无 discovery/install/activate

**结论**：P0 是 native 受信代码注册——manifest 在宿主代码内、ext impl 类直接 import 登记、默认 enabled。**无 discovery（P1：扫描安装路径）、无 install（P1：npm/git/市场/本地）、无 activate(ctx) 契约（已删除）**。这些是 P1/future。
**理由**：P0 只做「声明 + 注册表 + 按配置选可见」的静态内核；discovery/install/激活仪式属于外部/动态扩展，下沉到 P1 解耦。
**反例**：若 P0 强制 discovery/install/activate 全套，则纯静态/内置插件背负多余负担，P0 无法独立成立。

## 4. 示例

四相时序：
```
启动 → ① discovery（P1：读 manifest 标记文件，无代码；P0：跳过，native 已知）
     → ② manifest-registry（登记 ext impl 类到 point+implId 索引，无实例化）
     → ③ enable（PluginConfigService enabled 策略 → active 候选集，无代码）
     → ④ getExtensionImpls(point) 时按当前 config 实例化 enabled 的 impl 类（跑代码：构造）
```

get 时实例化示例：
```typescript
// 框架内部：getExtensionImpls(point) 时（plugin-manager.ts PluginManager.instantiate()）
const enabledImpls = registry.getByPoint(point.id)   // 已登记的类
  .filter(impl => pluginEnabled(impl.pluginId) && implEnabled(impl.implId));
const instances = enabledImpls.map(ImplClass => new ImplClass(implId, currentConfig(implId)));
return instances;  // exclusive 取 [0]、list 全用、ordered 按 effective order 升序（1..n）
```

## 5. 边界

| 零件 | 归属 |
|---|---|
| 四相流程、impl 类导出契约、实例化时机 | 本文件 ✅ |
| 发现/安装的具体路径与规则 | `[P1]discovery_and_install_interface.md` |
| enable 的策略输入（启用/选择/触发） | `config/[P0]plugin_config_service.md`（PluginConfigService） |
| 登记后的 getter | `[P0]plugin_manager_interface.md` |
| impl 类的 configSchema（plugin 级 + ext impl 级） | `[P0]ext_impl_and_manifest_interface.md` §3.5 |
