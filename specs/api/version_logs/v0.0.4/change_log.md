# API Spec Change Log — v0.0.4

> 版本：v0.0.4 · 日期：2026-06-20
> 增量记录 v0.0.4 相对 v0.0.3 引入的 HTTP API 契约变更。
> 全量 API 契约见 `specs/api/overall/02-llm-chat.md`。
> v0.0.4 是 **v0.0.3 UI 修订 + 配置归属完善**：API 层几乎无变更，仅 inventory 响应结构改 group-centric。

## 摘要

v0.0.4 在 API 层做 **1 项响应结构变更 + 1 项 UI 入口迁移标注**（落实 task.json keyDecisions 2、5）：

1. **`GET /config/plugin` 响应 group-centric**：inventory 返回结构由 v0.0.3 的 plugin-centric（`tree.plugins[]`）改为 group-centric（`tree.groups[]`），按 `ExtensionPoint.group` 聚合 ext impl；PUT op 集合不变。
2. **`/provider` `/model` 端点契约不变，UI 入口迁移**：provider/model 实例 CRUD 端点本身 v0.0.4 完全不变，仅前端调用入口从插件设置页挪到 app 设置页（数据归属一致，端点不动）。

## 文档修订（overall 就地更新）

| 文件 | 修订内容 | 标注 |
|------|---------|------|
| `specs/api/overall/02-llm-chat.md` 头注 | 标注 inventory group-centric + 其余端点不变 | `[v0.0.4 modified]` |
| `specs/api/overall/02-llm-chat.md` §4.3 | `GET /config/plugin` 响应结构改 group-centric（`tree.groups[].extImpls[]`）+ 响应示例 + group/enabled 正交说明 + AT 影响提示 | `[v0.0.4 modified]` |
| `specs/api/overall/02-llm-chat.md` §5 | 标注 `/provider` `/model` 端点契约 v0.0.4 不变，仅 UI 入口迁移 | `[v0.0.4]` |
| `specs/api/overall/02-llm-chat.md` §6/§7 | 文件变更清单 v0.0.3/v0.0.4 分节 + 版本号 1.1 | `[v0.0.4 modified]` |

## 修订点详述

### 修订 1：GET /config/plugin 响应 group-centric

- **v0.0.3 现状**：响应 `{ "tree": { plugins[]: { pluginId, enabled, config, extImpls[]: { implId, pointId, cardinality, enabled, order?, config? } } } }`（plugin-centric，`tree.plugins[]`）。
- **v0.0.4**：响应 `{ "tree": { groups[]: { groupId, extImpls[]: { pluginId, pointId, implId, cardinality, pluginEnabled, enabled, order?, configSchema?, config? } } } }`（group-centric，`tree.groups[]`）。
- **PUT op 集合不变**：`setEnabled` / `setImplEnabled` / `setImplConfig` / `setConfig`（请求体形状、响应 `{ "ok": true }`、错误码完全一致）。
- **AT 影响**：v0.0.3 inventory AT 断言路径 `tree.plugins[]` 需改 `tree.groups[].extImpls[]`；ext impl 节点新增 `pluginId` / `pluginEnabled` 字段（断言可覆盖）。
- **底层来源**：`PluginConfigService.inventory()` 改 group-centric（见 `specs/tech/config/[P0]plugin_config_service.md` §2 + `specs/tech/version_logs/v0.0.4/change_log.md` 修订 2）。

### 修订 2：/provider /model 端点契约不变（UI 入口迁移）

- **v0.0.3 现状**：provider/model 实例 CRUD UI 在插件设置页 providers_and_models group。
- **v0.0.4**：UI 入口挪到 app 设置页 providers 区；**端点契约完全不变**：
  - `GET/POST/PUT/DELETE /provider`：路径/方法/请求体/响应/错误码不变。
  - `GET/POST/PUT/DELETE /provider/:id/model`：路径/方法/请求体/响应/错误码不变。
  - `ProviderInstance` / `ModelInstance` / `ProviderCreateBody` / `ModelCreateBody` 等类型不变。
  - tombstone 软删实现说明（v0.0.3 §5.1）保留不变。
- **代码影响**：`app/server/src/handlers/provider.ts` 不变；仅前端 `AppSettingsPage.tsx` 新增 providers 区、`PluginSettingsPage.tsx` 移除 provider/model CRUD。
- **理由**：数据归属（app_config providers group）与 UI 归属（app 设置页）一致；端点是数据 CRUD 封装，不关心前端从哪调它。

## 6 条 PRD 用户路径的 API 可追溯性

| PRD 路径 | API 端点（AT 依据） |
|----------|--------------------|
| 路径 1（sidebar 会话图标 → 切 chat view） | 纯前端路由，无 API（AT 不覆盖；ET 覆盖） |
| 路径 2（app 设置页配 provider + model） | `POST /provider` + `POST /provider/:id/model`（端点不变，UI 入口迁移到此） |
| 路径 3（插件页看 ext impls group 分区 + inventory） | `GET /config/plugin`（v0.0.4 group-centric 结构）+ `PUT /config/plugin`（setEnabled/setImplEnabled op） |
| 路径 4（sidebar 4 图标导航） | 纯前端路由，无 API（ET 覆盖） |
| 路径 5（chat 选 model + 发消息回归流式） | `POST /chat`（SSE 流式，回归 v0.0.3） |
| 路径 6（app 设置页切 theme 回归） | `PUT /config/app`（group=appearance, key=theme）+ `GET /config/app?group=appearance&key=theme` |

> 6 路径全部可追溯到 `specs/api/overall/02-llm-chat.md` 具体端点；路径 1/4 是纯前端路由（无 API），由 ET 覆盖。

## 对 v0.0.3 代码的影响（planner/coder 范围）

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/handlers/config.ts` | 修改 | `PluginConfigHandler` GET 返回 `tree` 直接转发 `PluginConfigService.inventory()` 新结构（group-centric）；handler 本身逻辑不变，结构变更来自 service 层 |
| 其余 server handler（chat/provider/dev/app） | 不变 | v0.0.4 无端点签名变更 |

## 范围边界（v0.0.4 API 层）

### IN SCOPE

1. `GET /config/plugin` 响应 group-centric（结构 + §4.3 文档）。
2. §5 标注 `/provider` `/model` 端点契约不变 + UI 入口迁移说明。

### OUT OF SCOPE

- 新增端点（v0.0.4 不新增任何 HTTP 端点）。
- 端点签名变更（path/method/request body/response shape/error code 全部不变，除 inventory 响应内部结构）。
- SSE wire event 变更（`/chat` 复用 protocol StreamEvent，v0.0.3 已验证）。
- /provider tombstone 实现清理（v0.0.3 妥协，未来 persistence 补 delete 时再清）。

## 版本

version: 1.0
