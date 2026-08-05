---
type: index
title: Config 子系统总起
priority: P0
updated: 2026-07-19
---

# Config 子系统总起

## ① 是什么

Config 模块定义 **schema（数据形状）+ 逻辑 service**——回答「有哪些配置、各自长什么样、逻辑服务怎么取/怎么写」。读写、校验落盘、乐观锁都归 `../persistence/` 的 `CrudStore` + `SchemaDef`，本模块的 service **底经 CrudStore**。HTTP 是 facade（→ `specs/api/`），UI 呈现归 `specs/ui/`，均不在本模块。

| 核心概念 | 一句话 |
|---|---|
| **AppConfig** | 用户偏好域 + 技术调参域（v0.0.89 合并原 dev_config 全部 group），值分**权威值**（多数）+ **可选覆盖调参**（agent/context/logs，缺失回退代码默认），KV-sharded entity `app_config`；v0.0.55 起 `user_memory` 组为 user memory 唯一介质；v0.0.89 起 `default_models`/`logs`/`runtime`（含 observability）/`web`/`sub_agent_templates`/`agent`/`context` 全部迁入（见 `[P0]app_config.md §3.7-§3.14`） |
| **PluginConfig** | 两级 config 值（plugin + ext impl）+ 两级 enabled 门 + exclusive/ordered/inventory；**代码声明**（`app/plugins/scopes/*.yaml` 唯一源，impl 列表模型：membership=active、数组序=order、EP 不出现=继承 default 全量/出现=全量替换，落盘 policy deprecated 仅 lazy migrate 兼容） |
| **overlay 增量模型** | 有效状态 = 代码默认 ⊕ 数据增量；树（有哪些）100% 来自 registry 代码。app_config 叶子只存被改过的 delta；plugin config 叶子 = scopes yaml 的 EP 全量列表（EP 不出现 = 继承 default，per-EP 粒度继承） |
| **setGroup** | 整组原子提交（app/dev 同构），供 UI「保存该 group」用 |
| **inventory** | PluginConfigService 全量树 JOIN 数据（树来自 registry，叶子来自代码声明 scopes/*.yaml，enabled/selected 从 membership 派生） |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| 三个域的逻辑 schema + 形状示例 + 三个逻辑 service | 读写/持久化机制（→ `../persistence/`） |
| overlay 增量模型 + per-domain 默认表 + group 独立保存 | group 清单（→ PRD/需求） |
| PluginConfigService 管理面（吸收原 plugin_system ConfigBackend） | plugin_system 的 registry/ExtensionPoint/ExtImpl 字段（→ `../plugin_system/`） |
| ext impl 配置层 scope 维度（数据模型/激活/接口） | scope 选择逻辑（调用方自决，PRD OUT） |
| Connectors 概念 + 双状态机 + ConnectorManager | chrome/CDP/MCP attach 细节（→ `../agent/tools/`）；UI（→ `specs/ui/`） |

## ③ 与系统的关系

```
   UI / HTTP facade（specs/api，按域分路由包 3 service）
        │
        ▼
   config（逻辑 schema + 逻辑 service；底经 CrudStore）
        │
        ├── AppConfigService  ──→ persistence.CrudStore(entity=app_config, engine=file)
        │                       （v0.0.89 吸收原 DevConfig 全部 group：appearance(含 language)
        │                        /providers/llm_request/user_memory/web_search/default_models
        │                        /logs/runtime(observability)/web/sub_agent_templates/agent/context；
        │                        dev_config entity + DevConfigService 已删，无独立 dev 域）
        ├── ConnectorConfigService ──→ persistence.CrudStore(entity=connector_config, engine=file)
        └── PluginConfigService（只读管理面：inventory/scopes/activations）
                ├─ 取树结构 ← plugin_system（registry / ExtensionPoint / ExtImpl / manifest）
                ├─ 取状态 ← ScopeConfigProvider（代码声明 app/plugins/scopes/*.yaml，唯一源）
                └─ 与 PluginManager 共享同一 ScopeConfigProvider（Manager 直读 provider，不调本 service）
```

**对外协作点**：service 落 `app/server/src/config/`（app/dev/connector/kv-config-service）+ `app/server/src/plugin/plugin-config-service.ts`（PluginConfigService 历史位置）；schema 落 `app/server/src/config/schema_defs/` + `app/server/src/plugin/schema_defs/`。

## ④ 核心设计原则（跨文件不变量）

1. **overlay 增量模型（核心）**——树枝=代码 registry（存在性），叶子=配置增量；app_config 叶子只存被改过的 delta，plugin config 叶子 = `scopes/*.yaml` 的 EP 全量列表（EP 不出现 = 继承 default，全量替换零 delta）。→ `[P0]plugin_config_service.md §3`
2. **三域分立**——受众（用户/运维/开发）、来源（固定 vs 插件自带）、可变性、暴露面不同；混在一起会让用户看到 maxIterations。→ ②概念表
3. **KV-sharded（app/connector）**——同构通用 KV `(group,key)→data`，按 group 分片。app_config 内两类语义并存：权威值组（缺失 = 未配置）+ 可选覆盖调参组（agent/context/logs，缺失回退 `?? CODE_DEFAULT`）。→ `[P0]app_config.md §3.14`
4. **plugin_policy 单 entity 按 kind 分片（v0.0.67 起 deprecated 读路径）**——`{root}/plugin_policy/{kind}/<id>.json`（v0.0.26 订正）；v0.0.67 起配置代码化（代码声明 = 唯一源），落盘 policy 仅 lazy migrate 兼容。→ `[P0]plugin_config.md §5`
5. **配置代码化（v0.0.67 D2）+ 只读管理面**——active 列表/order/activatedPoints 全部代码声明 `scopes/*.yaml`；PluginConfigService 写方法全删（D4，HTTP PUT 返 405）；secret 不进代码（D1，移 dev config/env）；启动校验 throw（D3 硬失败）。→ `[P0]plugin_config_service.md §4` + `plugin_system/[P1]scopes_config_decl.md`
6. **engine 选 file**——操作性偏好（人可读/可版本化）+ bootstrap 安全（内置 engine 启动即就绪）。→ `[P0]plugin_config.md §5`
7. **连接器 lazy connect + 全局单例 owner**（`v0.0.46`）——connector switch 是纯功能开关（feature flag），与 connection 运行时态**完全解耦**；connect 时机 = tool.run 首次调用 lazy 触发（非 bootstrap/toggle），attach 资源全局单例（owner=sessionId 粒度），冲突返 ToolError 不排队。根治 chrome-devtools-mcp `--autoConnect` 副作用。→ `[P1]connectors.md §3.2 / §5`
8. **exclusive EP 恰好 1 active（impl 列表模型）**——三种 cardinality（exclusive/list/ordered）共用同一数据模型：配置 = impl 列表（membership = active，数组序 = order；废 `exclusivePicks`/`enabled`/`selected` 字段）；exclusive EP 的 impls 数组恰好 1 项（validator 启动硬失败），运行时统一 filter+sort 无 cardinality 分支；inventory `selected` 派生 = exclusive active 中 order 最小者。cardinality 仅 validator + UI 消费。→ `[P0]plugin_config_service.md §2/§3.2` + `[P0]ext_impl_scope.md §4.3/§5.3`
9. **groups.json 元数据唯一源（v0.0.71）**——group meta（id/label/description/含哪些 EP）外置 `app/plugins/groups.json`（唯一源），删 `ExtensionPoint.group` 字段；inventory JOIN `GroupMetaProvider` 按 groups.json 声明序聚合；启动校验第 5 条不变量（registry ↔ groups.json 双向一致）。→ `plugin_system/[P1]groups_meta_decl.md` + `[P0]plugin_config_service.md §2`
10. **dev_config 已废弃（v0.0.89）—— 无独立 dev 配置域**——原 DevConfig entity + `DevConfigService` 类整文件删（`/config/dev` 路由整段删，命中返 404）；技术调参全部迁入 app_config（logs/runtime(observability)/web/sub_agent_templates/agent/context），走 `/config/app`。这些迁入组保留「可选覆盖调参」语义（agent/context/logs 缺失回退代码默认，见原则 3 + `[P0]app_config.md §3.14`）。**代码层保留名偏离（已 verified reasonable）**：`loadTemplateFromDevConfig` 函数名 / `JinaDevConfig` 类型名 / `JinaContentFetcherCtor.devConfig` 字段名保留作过渡桥（语义已切 app_config，避免下游 import 大规模改名）。→ `[P0]app_config.md §3.7-§3.14`

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 优先级 | 链接 |
|---|---|---|---|
| `app_config.md` | AppConfig KV-sharded entity + groups（appearance(含 language)/providers/llm_request/user_memory/web_search/default_models/logs/runtime(observability)/web/sub_agent_templates/agent/context；v0.0.89 吸收原 dev_config 全部 group）+ 权威值 vs 可选覆盖调参两类语义 + AppConfigService | P0 | [link]([P0]app_config.md) |
| `plugin_config.md` | 两级 config 值存储 schema + group 聚合视图 + plugin_policy entity | P0 | [link]([P0]plugin_config.md) |
| `plugin_config_service.md` | PluginConfigService 管理面（enabled/exclusive/ordered/config/inventory/persist） | P0 | [link]([P0]plugin_config_service.md) |
| `ext_impl_scope.md` | ext impl 配置层 scope 维度（数据模型/激活/接口/inventory 扩展） | P0 | [link]([P0]ext_impl_scope.md) |
| `connectors.md` | Connectors 概念 + 双状态机（switch/connection 完全解耦，`[v0.0.46]`）+ ConnectorManager（`connectForToolRun`/`disconnect` + owner sessionId）+ attach 门禁分层 | P1 | [link]([P1]connectors.md) |

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
