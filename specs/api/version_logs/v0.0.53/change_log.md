---
type: change_log
title: v0.0.53 API 变更说明 — /provider CRUD 字段迁移 + protocols metadata
version: v0.0.53
updated: 2026-07-02
related_overall: specs/api/overall/02-llm-chat.md §5
---

# v0.0.53 — `/provider` `/provider/:id/model` 端点契约变更

> 一句话：`ProviderInstance` += `protocolId`（必填，1 provider : 1 protocol 锁定）；`ModelInstance` −= `protocolId`（物理删除）；`GET /provider` 响应扩顶层 `protocols: ProtocolMeta[]`（已注册 llm_protocol ext impl 元数据投影）。

权威 spec：`specs/api/overall/02-llm-chat.md §5`（已修订）。后端 tech：`specs/tech/version_logs/v0.0.53/change_log.md`。

## 1. 字段变更矩阵

| 类型 | 变更 | 必填 | 说明 |
|---|---|---|---|
| `ProviderInstance` | += `protocolId: "anthropic_messages"` | 必填（响应必含） | 1 provider : 1 protocol 锁定，单一事实源 |
| `ProviderCreateBody` | += `protocolId: "anthropic_messages"` | 必填（缺省 400） | 必须在已注册 llm_protocol ext impl implId 集合内 |
| `ProviderUpdateBody` | += `protocolId?: "anthropic_messages"` | 可选 | 修改 protocol = 换接入点风格 |
| `ModelInstance` | −= `protocolId` | — | 物理删除（迁到 ProviderInstance） |
| `ModelCreateBody` / `ModelUpdateBody` | −= `protocolId` | — | body 含该字段 → **忽略**（201/200 不写入） |

## 2. `GET /provider` 响应扩展（[v0.0.53]）

**旧**（v0.0.7）：

```typescript
{ "items": ProviderInstance[] }
```

**新**（v0.0.53）：

```typescript
{
  "items": ProviderInstance[],
  "protocols": ProtocolMeta[]
}
```

`ProtocolMeta` 类型：

```typescript
interface ProtocolMeta {
  id: "anthropic_messages";   // implId / ProtocolName（持久化标识）
  label: string;              // "Anthropic Messages 风格"（UI 下拉展示文本）
  path: string;               // "/v1/messages"（拼接地址用）
}
```

**handler 实现要点**（`app/server/src/handlers/provider.ts handleProviderCollection` GET 分支）：

```typescript
// GET 时额外投影 protocols metadata
const protocols = pluginManager.getExtensionImpls<LlmProtocol>(LlmProtocolPoint).map(p => ({
  id: (p as { implId: string }).implId,
  label: p.label,
  path: p.path,
}));
return json(200, { items: items.map(mask), protocols });
```

**向后兼容**：旧 caller 读 `items`，新 caller 读 `items + protocols`。新增字段 `protocols` 旧 caller 忽略（无破坏性）。

## 3. 错误码（[v0.0.53] 更新）

| HTTP status | 触发条件 | 响应体 |
|---|---|---|
| `400` | POST `/provider` 缺 `protocolId` | `{ "error": "body requires ..., protocolId" }` |
| `400` | POST `/provider` / PUT `/provider/:id` 的 `protocolId` 不在已注册 llm_protocol ext impl implId 集合内 | `{ "error": "protocolId must be one of registered llm_protocol impls: [anthropic_messages]" }` |

**model body 含 `protocolId` 不报错**：`POST /provider/:id/model` / `PUT /provider/:id/model/:modelId` body 含 `protocolId` → **忽略**（201/200，不写入 ModelInstance）。理由：前端容错友好（旧 client/脚本仍可工作），且 model 字段彻底删除。

## 4. 校验规则汇总

| 端点 | 字段 | 规则 |
|------|------|------|
| `POST /provider` | `protocolId` | 必填 + 必须在 `pluginManager.getExtensionImpls(llm_protocol)` 的 implId 集合内 |
| `PUT /provider/:id` | `protocolId` | 可选；若传则必须在集合内 |
| `POST /provider/:id/model` | `protocolId` | **不接受**（body 含则忽略，不报错） |
| `PUT /provider/:id/model/:modelId` | `protocolId` | **不接受**（body 含则忽略，不报错） |

## 5. AT（API Test）影响

新增 / 变更 case（由 api-test-designer 按 PRD §4.5 + §5 关键路径设计）：

| Case ID | 描述 | 期望 |
|---------|------|------|
| `provider_create_with_protocol_tc1` | `POST /provider { ..., protocolId:"anthropic_messages" }` | 201，响应含 protocolId |
| `provider_create_missing_protocol_tc1` | `POST /provider` 缺 protocolId | 400 |
| `provider_create_invalid_protocol_tc1` | `POST /provider { ..., protocolId:"unknown" }` | 400（不在已注册列表） |
| `provider_update_protocol_tc1` | `PUT /provider/:id { protocolId:"anthropic_messages" }` | 200，响应更新 |
| `provider_list_protocols_metadata_tc1` | `GET /provider` 响应含 `protocols: [{id,label,path}]` | label = "Anthropic Messages 风格"，path = "/v1/messages" |
| `model_create_without_protocol_tc1` | `POST /provider/:id/model { modelId, ... }`（无 protocolId） | 201，正常创建 |
| `model_create_with_protocol_ignored_tc1` | `POST /provider/:id/model` body 带 protocolId | 201，响应 model **不含** protocolId |
| `model_get_no_protocol_tc1` | `GET /provider/:id` 响应中 model | 不含 protocolId 字段 |

迁移验证（PRD §4.4 UC-4.4.2）：升级前 dev/test 现有 provider 升级后 `GET /provider` → 每个 provider 含 `protocolId=anthropic_messages`，其 models[] 中无 protocolId。

## 6. 文件变更清单

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `specs/api/overall/02-llm-chat.md` | 修改 | §5 标题块加 `[v0.0.53]` 修订说明；§5.1 GET `/provider` 响应描述改 `{items, protocols}`；§5.2 类型表 ProviderInstance += protocolId / ModelInstance −= / 新增 ProtocolMeta + ProviderListResponse / ProviderCreateBody / ProviderUpdateBody 加 protocolId；§5.3 ModelCreateBody 去掉 protocolId；§5.4 错误码 + 行为说明 |
| `specs/api/version_logs/v0.0.53/change_log.md` | 新增 | 本文件 |

> 端点路径、HTTP 方法、credentials 脱敏规则、错误码格式（`{error: string}`）**不变**；仅字段加减 + 新增 `protocols` metadata。
