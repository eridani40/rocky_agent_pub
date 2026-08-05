---
type: index
title: Plugin System 子系统总起
priority: P0
updated: 2026-07-26
---

# Plugin System 子系统总起

## ① 是什么

Plugin System 是 Agent 框架的**可扩展性基座**：把「一个接口多种实现」统一成一套机制——
**有名字的契约槽位（Extension Point）+ 注册表（Registry/PluginManager）+ 两级 enabled 门**。
P0 只做内部固定扩展（声明 + 注册表 + 按配置选可见，全静态，native 代码注册 + 默认 enabled）；
外部/动态扩展（三方打包、安装、发现、origin 信任策略、扫描）是 **P1**。

| 核心概念 | 一句话 |
|---|---|
| **Extension Point（EP）** | 有名字的契约槽位（`id` + `cardinality` + `description`），多插件向它贡献实现（v0.0.71 删 `group` 字段，group 归属迁到 groups.json） |
| **cardinality** | 注册表存取形状三态：`exclusive`(≤1) / `list`(无序并存) / `ordered`(按 order 升序) |
| **ExtImpl** | 一条扩展实现（`implId` + `point` + impl 类 + 可选 `configSchema`（唯一 schema 源）+ `description`；v0.0.71 删 `schemaConfig`） |
| **PluginManifest** | 一份插件清单（`id` + `extImpls[]` + 可选 `label`/`description`；v0.0.71 删 plugin 级 `configSchema`/`config` 死字段） |
| **groups.json**（v0.0.71） | UI 分区元数据唯一源（`app/plugins/groups.json`，7 group 各含 extPoints[]）；启动校验 registry ↔ groups.json 双向一致（D6 第 5 条不变量） |
| **Registry** | 全量代码树（按 `point+implId` 索引持有 impl 类引用），**存在性归代码** |
| **PluginManager** | 运行时活动投影：`getExtensionImpls(point[, scopeId])` = `Registry ∩ active`（active = scope impls 列表 membership），统一 filter + 按 YAML 数组序排序（无 cardinality 分支），get 时按当前 config 实例化（deepMerge） |
| **两级 enabled 门** | 一条 ext impl 进 active 当且仅当 `plugin.enabled ∧ impl.enabled`（plugin 级恒 true；impl 级 = scope impls 列表 membership） |
| **effective order** | 单一排序原语（删 `priority` 后）：运行时 = scopes yaml impls 数组序（loader 填 1-based），inventory 展示经 `computeEffectiveOrders` 末尾补位连续化 |
| **scope**（v0.0.26） | ext-impl 配置层正交维度（与 `group` 功能分区正交），per-EP 激活回退 |
| **三级 description** | plugin / ext point / ext impl 各一级，代码硬编码，inventory 透传给 UI |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| EP 定义 + cardinality 三态语义 + EP description | 各 EP 内部业务契约（provider/protocol/tool/context 各归自己的模块） |
| manifest 静态声明（ExtImpl + impl 级 configSchema + 版本兼容块） | 插件配置管理面（启用/选谁/排序/inventory/persist → `../config/`） |
| 内置 plugin 目录约定（`app/plugins/builtins/<id>/plugin.json`） | HTTP API 端点（→ `specs/api/`）/ UI 组件（→ `specs/ui/`） |
| Registry + PluginManager（注册表 + 单一 getter + active 投影） | CrudStore FS engine / sharding（→ `../persistence/`） |
| groups.json 元数据声明 + 「新增 EP 必须登记」强约定（v0.0.71） | EP.group 字段（已删，归属迁到 groups.json） |
| P1：discovery/install + 装前扫描 + origin 信任策略 + 同进程威胁模型 | secret 隔离的具体实现机制（→ `../config/` + key store） |

## ③ 与系统的关系

```
   app/plugins/builtins/<pluginId>/plugin.json  (静态声明，扫描点)
        │
        ▼ BuiltinLoader.loadAll → Registry.register(类引用)
   Registry  ───────────────────────────┐
        │                                │
        ▼ getExtensionImpls(point)       │ inventory JOIN（树∩状态）
   PluginManager                         │
   (运行时 active 投影)                   ▼
        │                          PluginConfigService（→ ../config/，只读管理面）
        ▼                             │
   consumer（agent/context/tools…）    └─ 读 active/order/config ← ScopeConfigProvider
                                          （代码声明 app/plugins/scopes/*.yaml，唯一源）
```

**对外协作点**：
- EP 类型 + 内置 EP 常量落 `app/server/src/plugin/extension-point.ts`（`BUILTIN_EXTENSION_POINTS`）。
- manifest 类型落 `app/server/src/plugin/manifest.ts`；形状校验 `registry.ts.validateManifestShape`。
- Registry/BuiltinLoader/PluginManager/PluginPolicyStore 落 `app/server/src/plugin/`。
- 配置管理面（`PluginConfigService`）**逻辑归 config 模块**（`../config/`），物理位置 `app/server/src/plugin/plugin-config-service.ts`（历史位置，见 config index §③）。
- 配置数据 = 代码声明 `app/plugins/scopes/*.yaml`（唯一源，经 `ScopeConfigProvider` 读；落盘 `plugin_policy` entity 已 deprecated，运行时不读）。

## ④ 核心设计原则（跨文件不变量）

1. **存在性归代码、数据挂状态**——manifest + EP 定义决定「有哪些」；enabled/order/configValues 是挂在代码身份（pluginId/implId）上的运行时状态。→ `[P0]extension_point_interface.md §3.8`
2. **两级 enabled 门 + next-get 生效**——`plugin.enabled ∧ impl.enabled`，写后下一次 `getExtensionImpls` 反映新状态，不重启、不热替换运行中已取到的引用。→ `[P0]plugin_manager_interface.md §3.1/§3.4`
3. **single getter + cardinality 驱动**——`getExtensionImpls` 永远返回列表；1/多/有序由 EP 的 `cardinality` 属性决定，不焊进方法签名；同时驱动 UI 控件形态。→ `[P0]plugin_manager_interface.md §3.1` + `[P0]extension_point_interface.md §3.7`
4. **effective order 是唯一排序原语**——`ordered` 升序排、`exclusive` 无显式时选最小者，复用同一源（删 `ExtImpl.priority` 后的统一）。→ `[P0]extension_point_interface.md §3.3`
5. **声明 vs 运行分离**——manifest 纯静态（不指向可执行入口、不含版本号）；discovery/激活计划/配置后台只读 manifest 不跑代码；只有 get 时实例化 impl 类。→ `[P0]ext_impl_and_manifest_interface.md §3.1` + `[P1]plugin_lifecycle.md §3.1`
6. **同进程、可信运维**——插件代码与宿主同进程裸跑，无沙箱；安全靠装前扫描 + 来源标签 + 配置后台（P1），不靠运行时隔离。→ `[P1]isolation_and_threat_model.md §4`
7. **groups.json 元数据唯一源（v0.0.71 D1）**——group meta（id/label/description/含哪些 EP）外置 `app/plugins/groups.json`，删 `ExtensionPoint.group` 字段；inventory JOIN `GroupMetaProvider` 按声明序聚合；启动校验第 5 条不变量（registry ↔ groups.json 双向一致，D6 硬失败）。→ `[P1]groups_meta_decl.md` + `[P0]extension_point_interface.md §3.6`
8. **configSchema 单一源（v0.0.71 D7+D8）**——全系统唯一 config schema 源 = `ExtImpl.configSchema`（JSON Schema，校验+UI 控件路由+default 底座同源）；删 `ExtImpl.schemaConfig?`（双源漂移）+ 删 `PluginManifest.configSchema?/config?`（plugin 级死字段）。instantiate 改 deepMerge（修 BUG-PLUGIN-004）。→ `[P0]ext_impl_and_manifest_interface.md §3.5/§3.7`
9. **packaged 编译加载 + server 外置共享（v0.0.108）**——dev 跑 `.ts` 源码；packaged build 期把每 impl bun build 成自包含 `.cjs`（server import 外置成 `@app/server/dist/X` 共享同一 server 实例，防 `session-store-ep-delegate` 等单例断裂），放 asar `node_modules/@app/plugins`（server→plugins 相对偏移 `../../` dev/packaged 一致 → 路径解析零改动），loader 按后缀 `require`/`import()` 双模式。asar 内动态加载经 Electron 42 实证可行。→ `[P0]packaged_plugin_loading.md`
10. **default 无特权，membership 即启用（v0.0.206 删 plugin scope D6）**——default scope 激活集 = `default.yaml` 声明集（不配 = 关），与非 default 同路径判定（`isPointActivated`/`listActivatedPoints`/`resolveSourceScope` 三处 default 短路已删）；`default.yaml` 是「impl 可不可用」唯一事实源。channel EP 借此接入 scope 激活模型（16→17 EP，见 `../channel/`）。→ `../config/[P0]ext_impl_scope.md §4.2` + `[P0]plugin_manager_interface.md §3.6`

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 优先级 | 链接 |
|---|---|---|---|
| **P0 — 内部固定扩展框架** | | | |
| `extension_point_interface.md` | EP 接口 + cardinality 三态 + EP description（v0.0.71 删 group 字段） | P0 | [link]([P0]extension_point_interface.md) |
| `ext_impl_and_manifest_interface.md` | PluginManifest + ExtImpl + impl 级 configSchema 单一源 + description | P0 | [link]([P0]ext_impl_and_manifest_interface.md) |
| `plugin_manager_interface.md` | PluginManager 单一 getter + active 投影 + scope 重载 | P0 | [link]([P0]plugin_manager_interface.md) |
| `builtin_plugins_directory.md` | 内置 plugin 目录约定（`app/plugins/builtins/`）+ 扫描流程 | P0 | [link]([P0]builtin_plugins_directory.md) |
| `packaged_plugin_loading.md` | packaged 编译/打包/加载（bun build 自包含 .cjs + server 外置 + asar node_modules/@app/plugins + loader 双模式，v0.0.108） | P0 | [link]([P0]packaged_plugin_loading.md) |
| **P1 — 外部/动态扩展 + 配置声明** | | | |
| `plugin_lifecycle.md` | 四相生命周期（discovery→registry→enable→get 实例化） | P1 | [link]([P1]plugin_lifecycle.md) |
| `discovery_and_install_interface.md` | 发现路径 + 安装源 + 装前扫描（fail-closed） | P1 | [link]([P1]discovery_and_install_interface.md) |
| `isolation_and_threat_model.md` | 威胁模型 + 同进程决策 + 三道防线 | P1 | [link]([P1]isolation_and_threat_model.md) |
| `scopes_config_decl.md` | scopes/*.yaml 代码声明（groups→points→impls 树 schema + 加载/校验链路 + 「开发 plugin ext 同步改配置」约定；impl 列表模型：membership=active、数组序=order、全量替换零 delta） | P1 | [link]([P1]scopes_config_decl.md) |
| `groups_meta_decl.md` | groups.json 元数据声明（schema + 加载/校验链路 + 「新增 EP 必须登记」约定，v0.0.71） | P1 | [link]([P1]groups_meta_decl.md) |

> 配置管理面（启用/选择/排序/inventory，v0.0.67 起只读）由 `../config/` KB 提供，见 `../config/index.md` + `[P0]plugin_config_service.md` / `[P0]plugin_config.md` / `[P0]ext_impl_scope.md`。
> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
