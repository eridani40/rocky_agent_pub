# v0.0.47-ui_opt API 变更日志 — Session 加 titled 字段 + PUT title 广播 + POST 首 query AI 起名副作用

> version: 1.0 · 2026-07-02
> 一句话定位：本版本**无新 HTTP 端点**——3 处变更全在既有端点的字段 / 副作用层：
>   ① `Session` schema 加 `titled: boolean` 字段（lazy 默认 false）；
>   ② `PUT /session/:id` body.title 触发 `session_meta_update` 广播 + 同步置 `titled=true`；
>   ③ `POST /session/:id/messages` 接到首条 user query 时 fire-and-forget 后台 AI 起名（playground scope + CAS gate）。
> 权威：`specs/api/overall/04-agent-session.md` §2.1 / §2.5 / §3.2（已就地追加 [v0.0.47] 段）。
> 关联：tech `specs/tech/version_logs/v0.0.47-ui_opt/change_log.md`（titled 持久化 + auto_naming service 实现层）+ prd `specs/prd/version_logs/v0.0.47-ui_opt/change_log.md`。

---

## 1. Session schema 加 `titled` 字段（§2.1）

`GET /session/:id` / `GET /session` / `session_meta_update.data` 三处 Session 响应 shape 都加：

```typescript
interface Session {
  // ...既有字段...
  titled: boolean;          // [v0.0.47] true = title 已被命名（人工改名 OR AI 起名应用过）；
                            // false = title 仍是默认占位「新会话」。
                            // lazy 默认 false（不跑 migration；首 query 触发条件天然保护存量）。
                            // 前端列表 reducer 不读此字段（仅 AI 起名 service CAS gate + 可观测用）。
}
```

**lazy 默认 false 兼容存量**：现存 session（v0.0.47 之前创建）record 无 `titled` 字段 → 后端 `toSession` 用 `r.titled === true` 规范化 → 缺省 false。**无需 migration 扫存量置 true**：AI 起名首 query 触发条件（transcript 无 prior role=user）天然保护现存 session（都有 prior user 消息）不被误触发。

## 2. PUT /session/:id body.title 副作用补强（§2.5）

**契约不变**：请求体 `UpdateSessionBody { workspaceDir?, title? }` shape 不变；响应 `200 + Session` 不变。

**[v0.0.47] 内部副作用 MANDATORY**：body 提供非空 `title` 时，handler 内部：
1. `updateSession(id, { title: bodyTitle, titled: true })`——同步置 `titled=true`（防 AI 起名返回时 CAS 覆盖人工改名）。
2. **直接调 `SessionMetaBroadcaster.broadcast(sid)`**（v0.0.47 补强）→ emit `session_meta_update` 到 `(session_meta, _all)` → 列表 reducer 整条替换 → conv-item title 实时刷新（含多 tab 同步）。

> 此广播不经 statusBus（title 更新不是 SessionEvent），走 handler 直调 broadcaster 路径（同 markUnreadTrue 模式）。详见 tech `specs/tech/agent/session/[P0]session_event.md §3a.4` 触发时机表 + `specs/tech/version_logs/v0.0.27/session-meta-broadcast-decision.md §4.1`。

## 3. POST /session/:id/messages 首 query AI 起名副作用（§3.2）

**契约不变**：请求体 `PostMessageBody` shape 不变；响应 `202 + { runId, enqueueId }` 不变。

**[v0.0.47] fire-and-forget 后台副作用**：当本端点接到的是该 session 的**首条 user query**（transcript 无 prior role=user 消息）且 `bizType==='playground' && type!=='subagent'` 时，handler 在 deliverTo 前并行触发一次后台 LLM 起名调用（`void svc.triggerIfFirstQuery(sid, plainText).catch(()=>{})`）：

- **复用 config**：`agentManager.resolveConfigBySid(sid).client.call({ messages:[{role:user, NAMING_PROMPT+plainText}], params:{maxTokens:32, temperature:0} })` 单次非流式（对齐 LlmClient.call 机制层）。
- **CAS 应用**：AI 名返回时若 `session.titled===false` → 应用 `updateSession({title:aiName, titled:true})` + emit `session_meta_update`（前端列表经 session_meta topic 收到，conv-item title 从「新会话」变成 AI 名）；若 `titled===true`（用户在此期间人工改名 / 已应用过 AI 名）→ 丢弃。
- **失败/超时/空 → 静默**（不影响主 run，主 run 在另一条 promise 独立完成）。

详见 tech `specs/tech/agent/auto_naming/[P0]auto_naming_service.md`。

## 4. 复用端点（全部既有，shape 不变）

- `POST /session/:id/messages`（首 query 触发后台 AI 起名，HTTP 契约不变）
- `PUT /session/:id` body.title（同步置 titled=true + broadcast，HTTP 契约不变）
- `GET /session/:id` / `GET /session`（响应加 `titled: boolean` 字段，新增字段向后兼容）
- `GET /sse` topic `session_meta`（`SessionMetaView` payload 加 `titled: boolean`，新增字段向后兼容）

## 5. AT 覆盖（real LLM ark glm-5.2，5 case）

| case_id | 验证点 | 结果 |
|---|---|---|
| `session_title_put` | PUT body.title → 200 + Session.titled=true + session_meta 广播 | PASS（9s） |
| `auto_naming_first_query` | 首 query → 后台 LLM 起名 → titled true + title 非「新会话」+ session_meta 推送 | PASS（3s） |
| `auto_naming_race_user_wins` | 首 query 期间人工改名 → AI 名 CAS fail → 用户名保留 | PASS（32s） |
| `auto_naming_skip_non_first` | 已有 user 消息的 session 发 query → 不触发 AI 起名（gate fail） | PASS（85s） |
| `auto_naming_scope_gate` | studio session（bizType!=playground）POST 创建 → SKIP（studio 不能经 POST 创建；scope gate UT 覆盖） | SKIP |

## 6. 版本

v0.0.47-ui_opt（playground UI 优化后端配套——Session 加 titled 字段 lazy 默认 false + PUT body.title 同步置 titled=true + 触发 session_meta 广播 + POST 首 query fire-and-forget AI 起名 + resolveConfigBySid public。**无新 HTTP 端点**；既有端点 shape 加 `titled` 字段向后兼容；副作用走 session_meta 广播让列表实时刷新）。
