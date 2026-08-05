# v0.0.148 API change log — session 级 effort + 审批模式字段

> 对应 PRD：`specs/prd/version_logs/v0.0.148/change_log.md`（effort 4 档 + approvalMode 绿灯 + alwaysApprovedKeys 持久化）。
> 权威 overall 待 doc-modifier 阶段 5 同步 `specs/api/overall/04-agent-session.md`。本文件为版本变更声明。

## 1. Session 接口新增 3 字段

`Session`（GET /session / GET /session/:id / PUT /session/:id 响应体）新增 3 个持久化字段：

| 字段 | 类型 | 缺省 | 语义 |
|---|---|---|---|
| `effort` | `'default' \| 'low' \| 'high' \| 'max'` | `'default'` | 推理强度档位（canonical 语义值；default=不传 wire `output_config.effort`，模型厂商默认行为） |
| `approvalMode` | `'normal' \| 'greenlight'` | `'normal'` | 审批模式总开关（greenlight=绿灯，短路所有策略 ask 不弹审批卡；deny 路径不受影响） |
| `alwaysApprovedKeys` | `string[]` | `[]` | 本会话「永远同意」的 approvalKey 集合（per-session 持久化，跨 app 重启保留；格式 `{toolName}:{policyId}` 如 `bash:rm-wildcard`） |

**响应形状**：GET / PUT 响应都返完整 Session（含 3 新字段）；**零状态码变更**、零 URL 变更。

**兼容性**：3 字段均 optional + lazy 默认——历史 session（无字段）GET 返回缺省值（effort=default / approvalMode=normal / alwaysApprovedKeys=[]），不阻断旧客户端。

## 2. UpdateSessionBody 扩 2 字段（PUT /session/:id）

`PUT /session/:id` 请求体扩 2 个 optional 字段（部分更新语义，对齐 title/providerId/modelId 模式）：

| 字段 | 类型 | 校验 |
|---|---|---|
| `effort` | `'default' \| 'low' \| 'high' \| 'max'` | 非法值（非 4 档之一）→ 400 |
| `approvalMode` | `'normal' \| 'greenlight'` | 非法值（非 2 档之一）→ 400 |

**`alwaysApprovedKeys` 不进 UpdateSessionBody**：无用户直填语义——仅由 ApprovalManager 内部通过 `allow_always` 审批回填路径写（tool-reply-handler → SessionStore.addAlwaysApprovedKey）。客户端不能任意改写此字段。

**示例**（选 effort=高 + 绿灯模式）：
```http
PUT /session/01J... HTTP/1.1
Content-Type: application/json

{"effort":"high","approvalMode":"greenlight"}
```
```json
{
  "id": "01J...",
  "effort": "high",
  "approvalMode": "greenlight",
  "alwaysApprovedKeys": [],
  "...": "其他 Session 字段"
}
```

## 3. CreateSessionBody（POST /session）

**本版不变**：effort/approvalMode 不进 CreateSessionBody（新建 session 走 lazy 默认 default/normal；用户进会话后再通过 PUT 改）。alwaysApprovedKeys 同理不进（新建无「已批准」语义）。

## 4. 无新增端点

本版复用现有 `PUT /session/:id`（`specs/api/overall/04-agent-session.md §2.5`），仅扩字段，不新增 URL / method / status code。

## 5. 关键用户路径（API 层覆盖，对应 PRD §4）

| 路径 | API 覆盖 |
|---|---|
| UC-A（effort 选「高」生效） | PUT /session/:id `{effort:"high"}` → 响应含 effort=high；后续 LLM 请求 wire body 含 `output_config.effort:"high"`（AT frame_checks 验出站帧） |
| UC-A2（默认档不传 wire） | 新建 session effort=default → wire body 不含 output_config 字段（AT frame_checks 验缺席） |
| UC-B（always 持久化） | allow_always 回填后 GET /session/:id 响应 alwaysApprovedKeys 含 `bash:rm-wildcard`；重启后 GET 仍含 |
| UC-B2（per-session 隔离） | session A always 含 key，session B GET alwaysApprovedKeys=[] |
| UC-C（绿灯短路） | PUT /session/:id `{approvalMode:"greenlight"}` → 触发 rm* 不进 need_approval（SSE 无 require_human_input） |
| UC-C2（绿灯不绕 deny） | 绿灯 + ls ~/.ssh → 策略 deny，tool_result isError 含拒绝理由（AT 验） |

## 6. 待 doc-modifier 同步 overall

- `specs/api/overall/04-agent-session.md` §2.1（Session 字段表加 3 字段）+ §2.5（UpdateSessionBody 扩 2 字段）— doc-modifier 阶段 5
