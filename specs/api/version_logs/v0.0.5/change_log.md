# API Change Log — v0.0.5

> 版本：v0.0.5 · 日期：2026-06-20
> 增量记录 v0.0.5 相对 v0.0.4 引入的 HTTP API 变更。
> 全量 API 见 `specs/api/overall/01-counter.md` + `02-llm-chat.md`。
> v0.0.5 是 **配置中心重构**：API 层 3 项增量（group 整组提交 / inventory 字段重命名+plugins[] / setImplConfig schemaConfig 语义）；`/chat` `/provider` `/provider/:id/model` 端点 v0.0.5 **完全不变**。

## 摘要

v0.0.5 API 层做 **3 项增量**（详见 `specs/api/overall/02-llm-chat.md` 标注 `[v0.0.5 modified]`）：

1. **`/config/app` `/config/dev` PUT 新增「整组提交」**：body 可带 `group` + `items[]`（原子提交该 group 全部 key）；单 key PUT（`group`+`key`+`data`）保留向后兼容。
2. **`/config/plugin` GET 响应结构微调**：ext impl 节点 `cardinality` 字段改名 `type`；新增顶层 `plugins[]`（plugin-centric 平面，给插件 tab UI 用）；ext impl 节点新增 `schemaConfig?`（per-key UI schema）。
3. **`/config/plugin` PUT `setImplConfig` 语义澄清**：参数仍 `{ op:'setImplConfig', implId, values }`（implId 单参全局唯一）；values 是稀疏 delta（用户改过的 key），未含 key 按默认。无新参数（PRD 三参仅 UI 层定位）。

## 文档修订（overall 就地更新）

| 文件 | § | 修订内容 | 标注 |
|------|---|---------|------|
| `specs/api/overall/02-llm-chat.md` | §4.1 | `/config/app` PUT 新增「整组提交」body 形态（`{group, items[]}`）+ 响应；单 key PUT 保留 | `[v0.0.5 modified]` |
| `specs/api/overall/02-llm-chat.md` | §4.2 | `/config/dev` PUT 同样新增「整组提交」（同构） | `[v0.0.5 modified]` |
| `specs/api/overall/02-llm-chat.md` | §4.3 | GET `/config/plugin` 响应：ext impl 节点 `cardinality`→`type`；新增顶层 `plugins[]`（pluginId/label/description/enabled）；ext impl 节点新增 `schemaConfig?` | `[v0.0.5 modified]` |
| `specs/api/overall/02-llm-chat.md` | §4.3 | PUT `setImplConfig` 注释：values 是 schemaConfig delta（implId 单参不变） | `[v0.0.5 modified]` |
| `specs/api/overall/02-llm-chat.md` | 头注 | 标注 v0.0.5 改动范围（仅 /config；/chat /provider 不变） | `[v0.0.5 modified]` |

## 修订点详述

### 修订 1：`/config/app` `/config/dev` PUT 新增「整组提交」

- **v0.0.4 现状**：`PUT /config/app` body = `{ group, key, data }`（单 key 写）。
- **v0.0.5**：PUT body 新增第二种形态「整组提交」：
  ```json
  PUT /config/app
  {
    "group": "llm_request",
    "items": [
      { "key": "stall_timeout_s", "data": 45 },
      { "key": "max_retry_times", "data": 3 }
    ]
  }
  ```
  - 响应：`200 · { "ok": true }`。
  - **原子性**：该 group 内 items 全成功或全失败；其他 group record 完全不读不写。
  - **单 key PUT 向后兼容**：body `{ group, key, data }` 仍可（等价于 `items: [{key, data}]`）。
  - **`/config/dev` 同构**。
- **理由**：PRD §3.9.2 「group 独立保存」要求 UI 点「保存该 group」只落该 group；API 提供整组提交避免前端循环单 key PUT（半完成状态、串扰）。
- **错误响应**：`400`（group 非法 / items 缺字段）；`500`（CrudStore 写失败回滚）。

### 修订 2：`/config/plugin` GET 响应结构微调

- **v0.0.4 现状**：`{ tree: { groups[]: { groupId, extImpls[]: { ..., cardinality, pluginEnabled, enabled, order?, config? } } } }`。
- **v0.0.5 新结构**：
  ```json
  {
    "tree": {
      "plugins": [
        { "pluginId": "anthropic_provider_plugin", "label": "Anthropic Provider", "description": "...", "enabled": true }
      ],
      "groups": [
        {
          "groupId": "provider",
          "extImpls": [
            {
              "pluginId": "anthropic_provider_plugin",
              "pointId": "llm_provider",
              "implId": "anthropic_compatible",
              "type": "list",
              "pluginEnabled": true,
              "enabled": true,
              "schemaConfig": {
                "apiKey": { "type": "string", "description": "API Key" },
                "model": { "type": "enum", "default": "claude-sonnet-4", "options": ["claude-sonnet-4","claude-haiku-4"] }
              },
              "config": { "model": "claude-sonnet-4" }
            }
          ]
        }
      ]
    }
  }
  ```
  - **字段重命名**：ext impl 节点 `cardinality` → **`type`**（值不变：`exclusive`/`list`/`ordered`）。
  - **新增顶层 `plugins[]`**：plugin-centric 平面列表（给插件 tab UI 用）；字段 `{ pluginId, label, description, enabled }`；label/description 来自 manifest（无则 fallback pluginId/空）。
  - **ext impl 节点新增 `schemaConfig?`**：per-key UI 渲染 schema（来自 ExtImpl.schemaConfig 声明）；无则缺省（UI 不出「配置」齿轮）。
  - **`config?` 不变**：impl 级 configValues（稀疏 delta）。
- **理由**：UI 组件契约（`_conventions.md` + 22 组件 spec）用 `type` 作控件路由 key；插件 tab 需要 plugin 平面列表（独立 toggle state）；schemaConfig 给弹层按 type 渲染控件。三者对齐 UI 层术语。
- **AT 影响**：v0.0.4 inventory AT 断言 `tree.groups[].extImpls[].cardinality` 改 `type`；新增 `tree.plugins[]` 断言；ext impl `schemaConfig` 可选断言。

### 修订 3：`/config/plugin` PUT `setImplConfig` 语义澄清

- **v0.0.4 现状**：`PUT /config/plugin { op: 'setImplConfig', implId, values }`，values 是 impl 级 configValues 全量覆盖。
- **v0.0.5**：**API 参数完全不变**（仍 `{ op, implId, values }`），但语义澄清：
  - values 是**稀疏 delta**（只含用户改过的 key），与 schemaConfig.default 合并；未含 key 按默认（不强制传全量）。
  - PRD §3.9.5 弹层「保存」时前端只发用户改过的 key（弹层编辑态对比默认/原值的 diff）。
- **PUT op 集合**（v0.0.5 与 v0.0.4 完全一致，无新增 op）：
  - `setEnabled` / `setImplEnabled` / `setExclusive` / `setOrder` / `setImplConfig` / `setConfig`
- **理由**：稀疏 delta 与 overlay 模型一致（`config/[P0]overview.md` §6）；前端发 diff 减少误覆盖默认的风险。

## 错误响应（沿用 v0.0.4，无新增）

| HTTP status | 触发条件 | 响应体 |
|---|---|---|
| `400` | PUT 缺字段 / group 非法 / op 不识别 / items 缺 key | `{ "error": "<原因>" }` |
| `404` | GET 单值时 group 不存在 | `{ "error": "Not Found" }` |

## 文件级变更清单（architect MANDATORY）

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/handlers/config.ts` | 修改 | `AppConfigHandler.put`：识别 body 是否含 `items[]`（整组提交）→ 调 `AppConfigService.setGroup`；单 key 走原 `set`。`DevConfigHandler.put` 同构。`PluginConfigHandler.getInventory`：响应序列化时 ext impl 节点 `cardinality`→`type`；新增顶层 `plugins[]`（调 `PluginConfigService.inventory().plugins`）；ext impl 带 `schemaConfig`。 |
| `app/server/src/config/app-config-service.ts` | 修改 | 新增 `setGroup(group, items[])`（底经 CrudStore 按 group shard 批量 upsert） |
| `app/server/src/config/dev-config-service.ts` | 修改 | 同构新增 `setGroup` |
| `app/server/src/plugin/plugin-config-service.ts` | 修改 | `PluginInventoryTree` 加 `plugins[]`；`inventory()` 加 buildPluginList；ext impl 节点 buildExtImplNode 输出 `type`（原 cardinality）+ `schemaConfig?`（来自 ExtImpl.schemaConfig） |
| `app/server/src/plugin/manifest.ts` | 修改 | `ExtImpl` interface 加 `schemaConfig?: Record<string, SchemaConfigEntry>` |

## 不变的端点（v0.0.5 完全沿用）

- `/chat`（SSE 流式）— v0.0.3 落地，v0.0.5 不动。
- `/provider` `/provider/:id/model` — v0.0.3 落地，v0.0.5 端点契约不变（UI 三栏化只是入口迁移，端点不动）。
- `/config/plugin` PUT op 集合 — 与 v0.0.4 完全一致（无新 op）。
- `/counter` `/counter/inc` — v0.0.1 落地，不动。

## AT 影响与回归点

| v0.0.4 AT case | v0.0.5 是否需更新 |
|---|---|
| `GET /config/plugin` inventory 断言 `cardinality` | 改 `type` |
| `GET /config/plugin` inventory 断言 `tree.groups[]` 顶层 | 加 `tree.plugins[]` 顶层断言 |
| `GET /config/plugin` ext impl 节点断言 | 加 `schemaConfig` 可选断言 |
| `PUT /config/app` 单 key | 保留（向后兼容） |
| `PUT /config/app` 整组 | **新增 AT case**：body `{group, items[]}`，断言仅该 group record 改、其他 group 不变 |
| `PUT /config/dev` 整组 | **新增 AT case**：同上 |
| `PUT /config/plugin` setImplConfig | 保留；新增 AT case：只发部分 key（diff），未发 key 按默认 |
| `/provider` `/model` 全部 | v0.0.5 不变，v0.0.4 case 全部回归 |

## 版本

version: 1.0
