# v0.0.231 API change log — Session.pinned（playground 会话置顶）

> 对应 PRD：`specs/prd/version_logs/v0.0.231.md`（块2 会话置顶）。
> 技术权威：`specs/tech/version_logs/v0.0.231/change_plan.md`。overall `specs/api/overall/04-agent-session.md` §2.1/§2.5 已同步（architect 落）。

## 1. Session 接口新增 pinned 字段

`Session`（GET /session / GET /session/:id / PUT /session/:id 响应体）新增 1 个持久化字段：

| 字段 | 类型 | 缺省 | 语义 |
|---|---|---|---|
| `pinned` | `boolean` | `false` | 会话置顶（playground 会话列表：置顶组在前、非置顶组在后，同组内 updatedAt desc——前端 store 统一比较器归位） |

**响应形状**：GET / PUT 响应都返完整 Session（含 pinned）；**零状态码变更**、零 URL 变更。

**兼容性**：optional + lazy 默认 false——历史 session（无字段）GET 返回 false，**无 migration**，不阻断旧客户端。`SessionMetaView`（session_meta 广播 payload）同步透出 `pinned: boolean`。

**归位分层**：后端 `GET /session` 返回顺序契约**不变**（仍 `updatedAt desc`）——置顶分组是纯前端展示层归位（比较器：先 pinned 降序、同组内 updatedAt desc）。

## 2. UpdateSessionBody 扩 pinned（PUT /session/:id）

| 字段 | 类型 | 校验 |
|---|---|---|
| `pinned?` | `boolean` | **提供但非 boolean → 400**（`validatePinned`，同 `validateEffortApproval` 风格）；undefined = 不改（部分更新语义，未提供不覆盖） |

**写后副作用**：pinned 更新成功后 handler 直调 `metaBroadcaster.broadcast(id)`（同 title 路径）→ emit `session_meta_update` 到 `(session_meta, _all)` → 前端列表 reducer 统一比较器归位，**多 tab 即时一致**。

**updatedAt 语义（用户裁决 2026-08-01）**：**pinned-only 更新不推进 updatedAt**——置顶是纯标记操作、不算对话活动（经 `PutOptions.preserveUpdatedAt` 机制，version 仍 +1）。取消置顶后该会话按**原对话时间**在非置顶组归位（可能不在顶部）；含其他字段的同一 PUT（如 title）仍正常推进 updatedAt。

**路由**：body 无 `workspaceDir` 时 `dispatchSessionPut` 自然落 `handleSessionItem`（与 effort/approvalMode 同路径）——router / session-update.ts（workspaceDir 分支）**零改动**。
