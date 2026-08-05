# API Change Log — v0.0.7

> 版本：v0.0.7 · 日期：2026-06-20
> 增量记录 v0.0.7 相对 v0.0.5 引入的 HTTP API 契约变更。
> 全量 API 定义见 `specs/api/overall/`。
> v0.0.7 是 **provider 端点扩展**：PUT 落地 + ModelInstance/ProviderCreateBody/ModelCreateBody 字段扩展。路径/方法/错误码/脱敏规则完全不变。

## 摘要

v0.0.7 在 API 层做 **2 项变更**（落实 `states/v0.0.7/user_query.md` Part 1）：

1. **`PUT /provider/:id` 端点落地**：v0.0.3 起 spec 声明但无 handler 实现，v0.0.7 在 `handleProviderItem` 落地。可改 `label` / `baseUrl` / `enabled` / `credentials.key`；`credentials.key === "***"` 视为不修改（与 GET 脱敏对称）。
2. **`ModelInstance` / `ProviderCreateBody` / `ModelCreateBody` 字段扩展**：
   - `ModelInstance` 新增必填 `label: string`（POST 缺省 = modelId）+ `enabled: boolean`（POST 缺省 = true）。
   - `ModelCreateBody` 新增可选 `label?` / `enabled?`。
   - `ProviderCreateBody` 新增可选 `enabled?`（缺省 = true）。

## 文档修订（overall 就地更新）

| 文件 | 修订内容 | 标注 |
|------|---------|------|
| `specs/api/overall/02-llm-chat.md` §5 头注 | 新增「[v0.0.7] 端点扩展」callout：PUT 落地 + label/enabled 扩展 | `[v0.0.7 modified]` |
| `specs/api/overall/02-llm-chat.md` §5.2 | `ModelInstance` 加 label/enabled 字段 + 注释；`ProviderCreateBody` 加 enabled? | `[v0.0.7 modified]` |
| `specs/api/overall/02-llm-chat.md` §5.3 | `ModelCreateBody` 加 label?/enabled? + 「[v0.0.7] PUT 实现补全」说明 | `[v0.0.7 modified]` |
| `specs/api/overall/02-llm-chat.md` §6 文件变更尾注 | 追加 v0.0.7 端点扩展说明 | `[v0.0.7 modified]` |
| `specs/api/overall/02-llm-chat.md` §7 版本 | 1.3 → 1.4 | `[v0.0.7 modified]` |

## 修订点详述

### 修订 1：PUT /provider/:id 落地

- **v0.0.3~v0.0.5 现状**：§5.1 端点表列出 `PUT /provider/:id`（更新 label/baseUrl/credentials/enabled），但后端 `handleProviderItem` 仅实现 GET + DELETE，未实现 PUT 分支。
- **v0.0.7**：PUT 落地。请求体 `ProviderUpdateBody`（部分字段），handler 按字段部分更新（缺省保留原值）。
  - `credentials.key`：仅当 body 中提供且 `!== "***"` 时更新（GET 默认脱敏为 `***`，前端未改 key 时回传 `***` → 视为不修改）。
  - `label` / `baseUrl` / `enabled`：body 中出现即更新。
- **理由**：UI diff-save 编辑已存 provider 需 PUT；无 PUT 只能删后重建（丢失 model 关联 + ULID 变化）。
- **契约影响**：路径 / 方法 / 响应形状（`{ "provider": ProviderInstance }`）/ 错误码（400 invalid json / 404 not found / 405 method）完全不变。

### 修订 2：ModelInstance + body 字段扩展

- **v0.0.7 ModelInstance 新增**：
  ```typescript
  interface ModelInstance {
    modelId: string;
    protocolId: "anthropic_messages";
    contextWindow: number;
    maxOutputTokens: number;
    default?: boolean;
    label: string;      // [v0.0.7] 显示名；POST 缺省 = modelId
    enabled: boolean;   // [v0.0.7] 启停；POST 缺省 = true
  }
  ```
- **POST `/provider/:id/model` body**（`ModelCreateBody`）新增可选 `label?` / `enabled?`；缺省时 handler 填 `label = body.modelId`、`enabled = true`。
- **PUT `/provider/:id/model/:modelId` body**（`ModelUpdateBody = Partial<ModelCreateBody>`）部分更新：仅更新 body 中出现的字段。
- **POST `/provider` body**（`ProviderCreateBody`）新增可选 `enabled?`（缺省 = true）。
- **理由**：UI 重做三级流后，同 provider 下可配多个 model 需 `label` 区分；`enabled=false` 隐藏不用的 model 而非删除（保留配置）。
- **向后兼容**：旧 client 不传 label/enabled → POST 时 handler 填默认值；GET 响应恒带 label/enabled（旧 record 缺字段时由 GET 无补全，但 v0.0.7 起 POST 必填，新数据不会缺）。

## 不变项（v0.0.7）

- `/chat` SSE 端点（完全不变）。
- `/provider` `/provider/:id` GET/POST/DELETE、`/provider/:id/model` GET/POST、`/provider/:id/model/:modelId` PUT/DELETE（路径/方法/错误码不变，仅 body 可选字段增加）。
- credentials 脱敏规则（GET 默认 `***`，PUT `***` 视为不修改）。
- tombstone 软删（DELETE 标 `_deleted: true`）。
- `/config/{app,dev,plugin}` 三域（完全不变）。

## 测试覆盖（AT — api-verifier 执行）

v0.0.7 新增 AT case（见 `tests/api/provider/`）：

1. `PUT /provider/:id` 改 label → GET 反映新 label（200）。
2. `PUT /provider/:id` 改 credentials.key = "***" → GET 响应仍 *** + 后端 key 不变（200）。
3. `POST /provider/:id/model` 不传 label/enabled → 响应 label=modelId、enabled=true（201）。
4. `PUT /provider/:id/model/:modelId` 改 label + enabled=false → 响应反映（200）。
5. diff-save 链路（前端）：POST provider + POST model + PUT model + DELETE model 编排（前端 api-client 集成测试，归 ET 范围）。

## 版本

version: 1.0
