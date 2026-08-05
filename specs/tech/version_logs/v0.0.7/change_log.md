# Tech Spec Change Log — v0.0.7

> 版本：v0.0.7 · 日期：2026-06-20
> 增量记录 v0.0.7 相对 v0.0.5 引入的技术架构变更。
> 全量技术定义见 `specs/tech/config/`、`specs/tech/plugin_system/`。
> v0.0.7 是 **provider/model config 重做 + provider 对象设计修正**：不引入新模块，扩展运行时数据模型 + 落地 PUT 端点 + 修正 ext impl 配置归属原则。

## 摘要

v0.0.7 在 tech 层做 **3 项变更**（落实 `states/v0.0.7/user_query.md` Part 1 + Part 2）：

1. **`ModelInstance` 运行时数据模型扩展**：新增必填 `label: string`（POST 缺省 = modelId）+ `enabled: boolean`（POST 缺省 = true）。后端 handler `app/server/src/handlers/provider.ts#ModelInstance` 同步扩展；POST/PUT body 接收并部分更新。
2. **`PUT /provider/:id` 端点落地**：v0.0.3 起 spec 声明但无 handler 实现，v0.0.7 在 `handleProviderItem` 中落地，可改 `label/baseUrl/enabled/credentials.key`（`credentials.key === "***"` 视为不修改）。
3. **provider ext impl 不带 schemaConfig（Part 2 架构原则）**：移除 `app/plugins/builtins/llm_anthropic/plugin.json` 中 `anthropic_compatible` impl 的 schemaConfig（v0.0.6 误加）。ext impl 仅承载行为（auth header / wire 协议），provider 连接参数归 app_config providers group 实例。

## 文档修订（overall 就地更新）

| 文件 | 修订内容 | 标注 |
|------|---------|------|
| `specs/tech/config/[P0]app_config.md` §3.2 | 补「[v0.0.7] 运行时简化 + 字段扩展」注：runtime ModelInstance 是 LlmModelConfig 简化子集 + 新增 label/enabled + PUT 落地 + 前端 diff-save 编排说明 | `[v0.0.7 modified]` |
| `specs/tech/plugin_system/[P0]builtin_plugins_directory.md` §2.2 | 补「[v0.0.7] provider/model ext impl 不带 schemaConfig」架构原则：ext impl 仅行为，provider 配置归 app_config 实例；澄清 v0.0.6 误加 schemaConfig 的修正理由 | `[v0.0.7 modified]` |

## 修订点详述

### 修订 1：ModelInstance += label / enabled

- **v0.0.5 现状**：runtime `ModelInstance` = `{ modelId, protocolId, contextWindow, maxOutputTokens, default? }`。
- **v0.0.7**：新增 `label: string` + `enabled: boolean`（均必填）。
  - POST `/provider/:id/model` 缺省：`label = body.modelId`、`enabled = true`（handler 实现，见 `app/server/src/handlers/provider.ts#handleModelCollection`）。
  - PUT `/provider/:id/model/:modelId` 部分更新：仅更新 body 中出现的字段（`handleModelItem`）。
- **理由**：UI 重做三级流后，同 provider 下可配多个 model，需 `label`（显示名）区分；`enabled` 用于隐藏不用的 model 而非删除（保留配置）。
- **代码影响**：`handlers/provider.ts#ModelInstance` interface + `handleModelCollection` / `handleModelItem` 字段处理。

### 修订 2：PUT /provider/:id 端点落地

- **v0.0.3~v0.0.5 现状**：spec 声明 `PUT /provider/:id`（`api/overall/02-llm-chat.md` §5.1 列出），但后端 `handleProviderItem` 未实现 PUT 分支（只 GET/DELETE）。
- **v0.0.7**：`handleProviderItem` 补 PUT 分支，按 body 部分更新 `label/baseUrl/enabled`；`credentials.key` 仅当 `!== "***"` 时更新（与 GET 脱敏对称）。
- **理由**：UI diff-save 需要编辑已存 provider（改 label/baseUrl/apiKey/enabled），无 PUT 则只能删后重建（丢失 model 关联）。
- **代码影响**：`handlers/provider.ts#handleProviderItem` 新增 PUT 分支。

### 修订 3：provider ext impl 不带 schemaConfig（Part 2）

- **v0.0.6 现状**：`app/plugins/builtins/llm_anthropic/plugin.json` 的 `anthropic_compatible` impl 被（误）加上 schemaConfig，导致插件设置页 ext impl 行出现「配置」齿轮，与 app config providers group 的 provider 实例配置**重复且语义混淆**。
- **v0.0.7**：移除该 schemaConfig。ext impl（`anthropic_compatible` / `anthropic_messages`）**仅承载行为**：
  - `anthropic_compatible`（llm_provider）：`buildAuthHeaders(config)` 产 `x-api-key` + `anthropic-version` header。
  - `anthropic_messages`（llm_protocol）：wire 协议 path/contentType/encode/parse/parseStream。
  - provider 连接参数（apiKey/baseUrl/enabled/model 列表）归 **app_config providers group 实例**（`config/[P0]app_config.md` §3.2），经 `/provider` + `/provider/:id/model` 端点管理。
- **理由**：ext impl 的 `schemaConfig` 语义是「impl 行为参数」（如温度、超时），与 per-instance provider 连接数据（apiKey 是密钥、baseUrl 是端点）不是同一类。混在一起会导致两处配置入口（ext impl 弹层 vs app config provider 实例）数据打架、UI 重复。架构原则：**行为归 ext impl，实例数据归 app config**。
- **代码影响**：`app/plugins/builtins/llm_anthropic/plugin.json` 删除 `anthropic_compatible.extImpls[].schemaConfig` 字段（其他不变）。`ExtImpl.schemaConfig?` interface 本身保留（仍可用于其他真正需要行为参数的 impl）。

## 前端 diff-save 编排（实现说明）

`app/web/src/lib/api-client.ts` 的 `saveProviderWithModels(provider, snapshot)`：

1. **provider 字段 diff**：new（无 snapshot.id）→ `POST /provider`；已存且字段变 → `PUT /provider/:id`。
2. **model diff**（按 modelId 配对 snapshot.models vs draft.models）：
   - draft 有 snapshot 无 → `POST /provider/:id/model`
   - 都有且字段变 → `PUT /provider/:id/model/:modelId`
   - snapshot 有 draft 无 → `DELETE /provider/:id/model/:modelId`
3. 全部成功 → reload `GET /provider` → 返回 list；任一失败 → 保留 draft + 报错（已成功的不回滚，靠 reload 对齐）。

> **不引入事务**：后端无事务接口，diff-save 是「逐条 CRUD 编排」，半失败靠 reload 对齐 + UI 报错重试。YAGNI，未来需要时再补事务端点。

## 范围边界（v0.0.7 tech 层）

### IN SCOPE

1. `ModelInstance` += label / enabled（runtime + handler + body）。
2. `PUT /provider/:id` 端点落地实现。
3. 移除 `anthropic_compatible` impl 的 schemaConfig（Part 2）。
4. 前端 diff-save 编排（api-client helper）。

### OUT OF SCOPE

- `/provider` `/provider/:id/model` 端点路径/方法/错误码（不变）。
- credentials 脱敏 / tombstone 软删（沿用 v0.0.4）。
- `ExtImpl.schemaConfig?` interface（保留，给其他需要行为参数的 impl 用）。
- chat SSE / chat LlmClient / plugin manager active 投影。

## 文件级变更清单

### 后端

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/handlers/provider.ts` | 修改 | `ModelInstance` 加 label/enabled；`handleProviderItem` 补 PUT 分支；`handleModelCollection`/`handleModelItem` 处理 label/enabled 字段 |

### 插件 manifest

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/plugins/builtins/llm_anthropic/plugin.json` | 修改 | 移除 `anthropic_compatible` impl 的 schemaConfig（v0.0.6 误加） |

### 前端

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/web/src/components/providers/` | 新增 | 6 组件（section-providers + 5 子组件）三级流 + diff-save |
| `app/web/src/lib/api-client.ts` | 修改 | `ModelInstance` 扩展 label/enabled + `saveProviderWithModels` diff-save helper |
| `app/web/src/components/settings/{ProvidersSection,ProviderForm,ModelForm}.tsx` | 删除 | 旧扁平列表实现（被 providers/ 取代） |

## 版本

version: 1.0
