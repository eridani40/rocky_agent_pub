# Agent Session + SSE Channel HTTP API（v0.0.8 server facade）

> version: 1.7 · **v0.0.177 修订**：§2.6 workspace 端点组加 §2.6.6 `POST /session/:id/workspace/save-image`（粘贴剪切板图片 base64 落盘 `<workspaceDir>/images/image-<ulid>.<ext>`，复用既有 file mention 渲染链；filename server 单一权威生成，路径白名单二次守卫）。技术权威 `specs/tech/version_logs/v0.0.177/change_plan.md §新端点 API 契约`。· **v0.0.192.delete_cleanup 修订**：§2.4 `DELETE /session/:id` 加级联删子孙 session 语义——`collectDescendants(id)` BFS 快照子孙 → 逐个 `deleteSession`（每触发 onSessionDestroyed 清内存 cron，堵潜伏调度）→ parent 最后删。
> version: 1.5 · 引入版本 v0.0.8（v0.0.12 修订：session 响应加 state/running/currentRunId；新增 `POST /session/:id/abort` + `POST /session/:id/messages/:enqueueId/cancel`；§3.2 发消息并发语义改为 enqueue 排队 + interrupting 循环等待）· v0.0.13 修订：§3.2 `POST /messages` 响应体新增 `enqueueId`（保留）· **v0.0.15 修订**：移除 `cancelEnqueueId` 参数（S5 多余概念），cancel 统一走专用端点 §3.4；`activate` 标测试专用（仅 `NODE_ENV=test` 生效，生产忽略，始终激活）；summaryTask 状态经启动清理（GET /session 不直接暴露 summaryTask 字段，详见 §5）· **v0.0.16 修订**：§3.3 `POST /session/:id/abort` 请求体新增 `runId` + `modeKey` 必填字段，响应加 `accepted: boolean`（区分真实中断与幂等 no-op）；三参数缺一不可——避免乱 abort 他人 run · **v0.0.17 修订**：Session 加 `workspaceDir` 字段 + 初始目录策略（caller 提供校验后用 / 缺省自动建 `<DATA_DIR>/workspaces/<sid>`）；新增 §2.5 `PUT /session/:id`（切目录）+ §2.6 Workspace 端点组（GET tree lazy 一层 / POST open 白名单 + spawn / POST pick-directory 原生 dialog）+ §2.6.4 `/api/workspace/*` ET seed 端点（test-only，NODE_ENV=test gate）；DELETE 加 stopWatch 副作用 · **v0.0.25 rev2 修订**：SSE error 事件再扩可选 `displayReason`+`errorDetail`（rev1 已加 `errorCategory`）；新增 `llm_attempt` SSE event（per-attempt retry/fallback 进度，run_end 前若干帧）；`GET /session/:id` 响应 `currentRun.error` / 历史 run error 携带 `RunErrorInfo = { errorCategory, displayReason, errorDetail? }`（eager-drain 落 RunRecord；ABORTED_BY_USER 走 interrupted 不填 RunErrorInfo）；LlmErrorCategory 17→19 值（+MAX_TOKENS_TOO_HIGH/EMPTY_RESPONSE）。详见 §10 路径 C + `02-llm-chat.md` §1 [v0.0.25 rev2 modified] + `specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md` · **v0.0.81 修订**：移除 compact_notice system message 留痕（compact summary 改 role=user message 落库，不再插 system notice / 不再渲染居中 pill）；§7 POST /compact 步骤 2 + §10 AT 路径 T 断言 + §11 context-engine.ts 同步；技术权威 `specs/tech/agent/context/[P0]context_compact_detail.md §6` · **v0.0.158 修订**：§3.2 `POST /messages` body `providerId` / `modelId` 参数**已废弃（兼容层：静默忽略不返 400）**——前端不再传，配置改动生效点 = 用户改设置那一刻（PUT /session）；§7 `POST /compact` 内部 SessionConfig 组装收敛为 `agentManager.resolveConfigBySid(sid)` 唯一入口（chat/compact 同链）；§9 错误体 `MODEL_NOT_CONFIGURED` 的 `detail.task` 字段已删（chat/compact 同链后 task 概念不存在）。技术权威 `specs/tech/agent/providers_and_models/[P0]model_resolve.md §3/§5.1` + `specs/tech/agent/context/[P0]context_compact_detail.md §2b`
> 管什么：v0.0.8 server 经 `node:http` 暴露的 **session 化真实 agent 对话** HTTP 端点契约——`/session` CRUD + `/session/:id/messages`（transcript 分页 / 发消息触发 run）+ `/session/:id/messages/:enqueueId/cancel`（**v0.0.12** 取消排队消息）+ `/session/:id/abort`（**v0.0.12** 中断收尾）+ `/session/:id/summary`（D2 compact 摘要只读）+ `/sse` channel（多连接 fan-out）。
> 不管什么：渲染层 UI（→ `specs/ui/components/chat-page/_overview.md`）；server 实现细节（handlers/agent loop/context engine → 代码层）；端口 schema 与 DATA_DIR（→ `app/envs/[P0]environments.md`）；**session 五态状态机的内部定义 + CAS + 收尾 4 步**（→ `specs/tech/agent/session/[P0]session_state.md` + `specs/tech/agent/agent_interface_and_loop/[P0]agent_interrupt.md`，本文件只暴露 state/running/currentRunId 字段 + abort 端点契约）。
> **本文件是 AT（API Test）agent session 域的唯一依据**：api-verifier 黑盒 curl，不读代码。
>
> **取代关系**：本组端点**取代** v0.0.3 无 session 的 `POST /chat`（已作废，见 `02-llm-chat.md` §3）。`/provider` / `/provider/:id/model` 端点（`02-llm-chat.md` §5）v0.0.8 不变。
>
> 增量变更见 `specs/api/version_logs/v0.0.8/change_log.md`（v0.0.8 基线）+ `specs/api/version_logs/v0.0.12/change_log.md`（v0.0.12 修订）。**v0.0.15**：无独立 api version_log（S5 cancel 简化是自主决策变更，记录在本文件 §3.2/§3.4 note）。**v0.0.15 实现层落地**：本文件 §3.3 abort 三参 + accepted + §4.2/§3.2 groupKey `_amt:<modeKey>` 命名 + AgentEventBase.modeKey 必填——上述契约已在 v0.0.16 spec 修订段记录，v0.0.15 是「实现层落地」对齐 spec（HTTP surface 不变，仅实现机制对齐 controller 内存模型 + groupKey 全链路）。

## 1. 概述

v0.0.8 server 在 v0.0.3/v0.0.4/v0.0.5/v0.0.7 server 基础上，删除无 session 的 `POST /chat`，新增一组 session 化端点支撑真实 agent 对话（PRD §3.1 v0.0.8 + tech change_log §4 AgentLoop）。

**核心约定**（沿用 `02-llm-chat.md` §2 通用约定）：
- host `127.0.0.1`（loopback），无 TLS。
- port `API_PORT`（test `3700` / dev `3710` / prod `3720`）。
- JSON 请求/响应；错误体 `{ "error": string }`。
- API key 仅 server 持有（读 app_config `providers[providerId].credentials.key`），前端请求体**不传 key**。

一句话：**v0.0.8 agent session facade = `/session` CRUD + `/session/:id/messages`（分页 + 发消息触发 run 返 runId）+ `/session/:id/summary`（D2 摘要只读）+ `/sse` channel（多连接 fan-out + 按 (topic,group) 订阅）**。

## 2. Session CRUD

### 2.1 `POST /session` — 创建会话

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/session` | 创建空 Session（ULID），不触发 run | `CreateSessionBody?`（可选） | `201` + `Session` |

```typescript
interface CreateSessionBody {
  title?: string;           // 缺省 = "新会话"
  providerId?: string;      // 可选，预绑定 provider/model（缺省用 app_config 默认）
  modelId?: string;
  workspaceDir?: string;    // [v0.0.17] 可选，缺省 = 后端自动建 <DATA_DIR>/workspaces/<sid>（详见 specs/tech/agent/session/[P0]session_workspace.md §3）
  // ── [v0.0.56] SessionKind 字段（替代旧 type/scope）──
  role?: "rocky" | "leader" | "mate" | "squad";   // [v0.0.56] 可选，缺省='rocky'（playground 主会话）；仅 create session/spawn 时填
  derivation?: "main" | "subagent";                 // [v0.0.56] 可选，缺省='main'；spawn subagent 时 handler 内设 'subagent'
  biz?: "playground" | "studio";                    // [v0.0.56] 可选，缺省='playground'
}

interface Session {
  id: string;               // ULID
  title: string;
  status: "active";         // 业务生命周期（active/archived，与 state 正交）
  // ── run 状态（v0.0.12 新增，对齐 session_state.md §2 六态机；[v0.0.101] 加 suspended）──
  state: "idle" | "running" | "interrupting" | "interrupted" | "error" | "suspended";  // [v0.0.101] suspended=等用户回填悬挂型 tool call（loop 已退出，pendingToolCalls 非空）
  running: boolean;         // state ∈ {running, interrupting} 时为 true（前端展示 loading / 中断按钮 / enqueue view 的快捷布尔）。[v0.0.101] **suspended 排除 running**（INV-2：列表亮「?」非 spinner）
  currentRunId: string | null;              // 当前活跃 run ULID；idle/interrupted/error/interrupting/suspended 时为 null
  // ── [v0.0.101] 悬挂型 tool 队列（落盘，recover 用；详见 specs/tech/agent/session/[P0]session_store.md §2）──
  pendingToolCalls: PendingToolCall[];      // [v0.0.101] 等待用户回填的悬挂型 tool call（空数组=无）；前端据此 mount 提问卡（可见性 = length>0）；recover 队首见 §3.6 GET /pending-tool-call
  // ── workspace（v0.0.17 新增）──
  workspaceDir: string;     // [v0.0.17] session 关联真实工作目录（绝对路径）；详见 specs/tech/agent/session/[P0]session_workspace.md
  // ── 未读（v0.0.27 新增，显式 bool 存储值；详见 specs/tech/agent/session/[P0]session_state.md §6）──
  unread: boolean;          // [v0.0.27] true = 有未读（run 完成于非前台且未标读）；显式存储值，非派生（GET 直接返回 session.unread）；前端列表红点渲染依据。消除见 §2.3.1 POST /session/:id/read
  // ── titled（v0.0.47 新增，AI 起名 CAS gate；详见 specs/tech/agent/session/[P0]session_store.md §2 + specs/tech/agent/auto_naming/）──
  titled: boolean;          // [v0.0.47] true = title 已被命名（人工改名 OR AI 起名应用过）；false = title 仍是默认占位「新会话」。lazy 默认 false（session.titled ?? false；不跑 migration）。AI 起名应用条件 = titled===false（CAS），应用后置 true；PUT /session/:id body.title 路径同步置 true（防 AI 名返回时覆盖）。前端列表 reducer 不读此字段（仅 AI 起名 service CAS gate + 可观测用）。
  //   ── [v0.0.62 i18n] title+titled 前端 i18n 渲染责任（零 API breakage）── 后端契约不变（title 仍字面「新会话」zh-CN 兜底，titled 不变）；前端按 `titled===false ? t('chat.session.defaultTitle') : title` 渲染（占位时查 locale 表、命名后直展 title 字面属用户数据硬边界不翻译）。详见 `specs/tech/i18n/index.md §⑥ Session.title 默认占位行` + `[P0]i18n_overview.md §8` displayReason 同款「后端发 sample+signal、前端查表回退」范式。
  // ── pinned（v0.0.231 新增，会话置顶；详见 specs/tech/agent/session/[P0]session_store.md §2）──
  pinned: boolean;          // [v0.0.231] true = 已置顶（playground 会话列表置顶组在前）；lazy 默认 false（不跑 migration，历史 session 缺省 false）。写路径 = PUT /session/:id body.pinned（§2.5）→ session_meta 广播多端一致。置顶分组是前端展示层归位（统一比较器：先 pinned 降序、同组内 updatedAt desc），GET /session 返回顺序契约不变（仍 updatedAt desc）
  // ── [v0.0.56] SessionKind 统一身份维度（取代旧 type/scope/bizType）──
  role: "rocky" | "leader" | "mate" | "squad";   // [v0.0.56] 会话角色（subagent 存 parent.role bloodline）；替代旧 type 字段
  derivation: "main" | "subagent";                 // [v0.0.56] 派生层级；替代旧 scope + type='subagent' 双字段
  biz: "playground" | "studio";                    // [v0.0.56] 业务分区；替代旧 bizType 字段（必填，无 lazy 默认）
  // ── studio session 增量（[v0.0.33.1] §11-squad.md §2 声明，本接口 [v0.0.96.ui_fix] doc-sync 补声明对齐）──
  squadId?: string;              // [v0.0.33.1] studio session 所属 squad ULID（playground session 为 undefined）；GET /squad/:id 锚
  memberId?: string;             // [v0.0.33.1] 仅 leader/mate session 双向（= member.id）；群聊 session.squadChatSessionId / subagent 无此字段
  // ── v0.0.148 session 级 effort 推理强度 + 审批模式 + always approve 持久化 ──
  effort: 'default' | 'low' | 'high' | 'max';           // [v0.0.148] 推理强度档位（canonical 语义值）。lazy 缺省 'default'（= 不传 wire output_config.effort，模型厂商默认行为）。GET /session / GET /session/:id / PUT 响应都返此字段
  approvalMode: 'normal' | 'greenlight';                // [v0.0.148] 审批模式总开关。lazy 缺省 'normal'（按现状 ask 弹审批卡）；'greenlight'（绿灯）= engine.execute ask 分支短路（不弹卡、视同 allow）；deny 路径与执行层沙箱不受影响
  alwaysApprovedKeys: string[];                         // [v0.0.148] 本会话「永远同意」的 approvalKey 集合（格式 `{toolName}:{policyId}` 如 `bash:rm-wildcard`）。lazy 缺省 []。**per-session 持久化**（跨 app 重启保留，换会话重置）。**不可经 PUT 直接改写**——仅 ApprovalManager 内部 allow_always 回填路径写（详见 specs/tech/agent/tools/[P0]tool_permission.md §5）
  createdAt: string;        // isoDate
  updatedAt: string;
}
```

**错误**：`400` body 非法 JSON；`400` `providerId` 提供但不命中 app_config providers 组；`400` `workspaceDir` 提供但非绝对路径 / 不存在 / 非目录。

> **`[v0.0.62 i18n BUG-001]` POST body.title 副作用（修 v0.0.47 漏 POST 路径）**：handler 内部当 `body.title !== undefined` 时，紧跟 `createSession` 之后调 `updateSession(id, { titled: true })`——同步置 `titled=true`（对齐同文件 PUT:185-193 行为）。原因：`createSession` 内部强制 `titled=false`（session-store 设计 invariant：新建一律未命名），故走 `updateSession` CAS gate 翻 true；POST 时若用户已命名而 titled 缺省 false，AI 后续 auto-naming 会 CAS 误判「未命名」覆盖用户字面。详见 `specs/tech/agent/auto_naming/[P0]auto_naming_service.md §6`。**响应形状不变**（仍 201 + Session），仅响应 body 的 `titled` 字段从 lazy `false` 变 `true`（boolean 仍 boolean，零 API breakage）。

> **[v0.0.17] workspaceDir 初始策略**：请求体不传 workspaceDir 时，后端自动建 `<DATA_DIR>/workspaces/<sid>`（`fs.mkdir recursive`，幂等）并写入 `session.workspaceDir`。详见 `specs/tech/agent/session/[P0]session_workspace.md §3`。

> **Session 接口含 `squadId?` / `memberId?` 两字段**（studio session 增量，§11-squad.md §2 声明；前端 `chat-page/types.ts` Session interface 同步含字段）。playground session 两字段为 `undefined`。chat 装饰数据（tag/成员/默认模型）由后端 `GET /session/:id/chrome`（`04a-session-chrome.md`）按这两字段聚合，前端不再两跳拼装。

> **[v0.0.12] state 字段语义**（前端 GET /session + SSE `session_status_update` 双通道，详见 session_state.md + session_event.md）：
> - `idle`：初始 / 正常结束后空闲；可发消息激活新 run。
> - `running`：run 进行中；发消息走 enqueue 排队（不报 409，见 §3.2）。
> - `interrupting`：abort 收尾中（临时态，currentRunId=null，loop 已退出）；发消息走 enqueue 排队 + activate 循环等待。
> - `interrupted`：被中断后的终态；可发消息激活新 run。
> - `error`：run 出错后的终态；可发消息激活新 run。

### 2.2 `GET /session` — 会话列表

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/session` | 所有 session（按 `updatedAt` desc） | `200` + `{ items: Session[] }` |

### 2.3 `GET /session/:id` — 会话详情（纯读，无副作用）

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/session/:id` | 单个 session 元数据（含 unread 字段）；**纯读，无副作用** | `200` + `Session` |

> **[v0.0.27] 纯读语义（修订）**：v0.0.27 初版曾在 GET /session/:id handler 内调 `markRead(sid)` 隐式标读（返回 unread 必为 false），用户两轮反馈否决——GET 是纯查询接口，标读须走独立端点（§2.3.1）。本端点直接返回当前 session.unread 存储值（true/false 不变），不触发任何写操作、不发事件。
>
> **未读消除请调** `POST /session/:id/read`（§2.3.1）。前端进入会话的完整路径：GET /session/:id（读初始状态）+ POST /session/:id/read（清未读）——两个独立请求。

**错误**：`404` session 不存在。

### 2.3.1 `POST /session/:id/read` — 标记已读（清未读，v0.0.27 新增）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/session/:id/read` | 标记 session 已读（CAS `unread: true → false` + emit `session_read_update`）；唯一消除未读入口 | 无（空 body） | `200` + `{ ok: true, session: Session }` |

**行为**（详见 `specs/tech/agent/session/[P0]session_state.md §6` + `[P0]session_store.md §4`）：
1. handler 调 `sessionStore.markRead(sid)`（CAS `UPDATE session SET unread=false WHERE id=:sid AND unread=true`）。
2. CAS 成功（unread 真从 true→false）→ 内部 emit `session_read_update`（topic=`session_panel`，data=`{unread:false}`，见 `specs/tech/agent/session/[P0]session_event.md §2/§3`）。
3. CAS 0 行（unread 已是 false）→ 幂等 no-op，**不发事件**，仍返 200。
4. 返回更新后的 Session（unread=false）。

**返回语义**：
- `200` + `{ ok: true, session: Session }` = 标读完成（或本就是已读态，幂等）；前端据返回 Session 更新本地未读态。
- session 不存在 → `404`。

**幂等 / 并发**：
- 重复 POST /read（unread 已是 false）→ CAS 0 行 → 幂等 200，不发事件。
- 同 session 多 tab 并发 POST /read → CAS 串行化，仅首个 true→false 触发事件，其余幂等。
- 与 **session 层**的产生未读（session 层订阅状态机 markIdle/markError completion 信号 → 查 isSessionActive 非前台 → CAS true）无冲突——两者 WHERE 子句互斥（产生 `WHERE unread=false`、消除 `WHERE unread=true`）。

**请求示例**：

```bash
curl -X POST http://127.0.0.1:3710/session/01KV.../read
# → 200 {"ok":true,"session":{"id":"01KV...","unread":false,...}}
```

**错误**：`404` session 不存在；`405` 非 POST。

> **为什么独立端点而非 GET 隐式**：GET 是查询语义，标读是写操作（改 unread 字段 + 发事件）；混入 GET 违反接口纯读性、使 GET 不可缓存、调试时难定位「未读为何消失」。独立 POST 让产生（**session 层**内部自治）与消除（用户显式）两个 timing 各有清晰入口，对齐 explicit-bool 模型（详见 `specs/tech/agent/session/[P0]session_state.md §6`）。

### 2.4 `DELETE /session/:id` — 删除会话（级联子孙 + 回收 tab 监听）

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `DELETE` | `/session/:id` | 删除 session + 其 transcript/summary/runs（级联）+ **[v0.0.139] 触发 SessionWorkspaceManager.recycleSession(sid)**（回收该 session 全部 tab 监听，幂等；旧 `stopWatch` 语义随懒监听重构改名）+ **[v0.0.192.delete_cleanup] 级联删全部子孙 session**（每 descendant 触发 `onSessionDestroyed` → 清内存 cron，堵潜伏调度） | `204`（无 body） |

**行为**（`[v0.0.192.delete_cleanup]` 级联删子孙语义）：
1. 校验 session 存在 → 不存在 `404 session not found`。
2. `store.collectDescendants(id)` BFS 快照全部子孙 session id（任意深度，基于 childrenIndex 正向索引，**必须在任何 deleteSession 之前调用**——onDeleted 会清 parent 自己的 child set，删后再查会漏子孙）。
3. **逐个** `deleteSession(sid)` 删子孙（每个都级联 rm `sessions/{sid}/` 含 cron.json + 触发 `onSessionDestroyed` → 该 descendant 的内存 cron job 在 engine 中注销，堵「删 parent 后 child cron 继续烧 token」的潜伏调度）。
4. `deleteSession(id)` 删 parent（级联 rm transcript/summary/runs/sessions/{id}/）。
5. `workspaceManager.recycleSession(id)` 回收 parent 的全部 tab 监听（v0.0.139，幂等；仅针对 parent——子孙无独立 tab）。
6. 兜底 `connectorManager.disconnect('browser', id)`（design §5，graceful，异常不影响 204）。
7. 返 204（无 body）。

> **级联覆盖任意深度**：BFS 从 parent 逐层展开（A→B→C，删 A 收集 [B,C]），不限一层；visited Set 防环（理论 parentSessionId 无环，防御）。`childrenIndex` 未建（lazy warm 未触发）时 collectDescendants 返 []（不阻塞删除，但漏子孙——caller 不必关心 warm 时机，impl 内部 warm 后再查）。
> **堵潜伏调度**：删 parent 后 child 挂的 cron job 在内存 engine 中继续被调度，继续 fire 烧 token。本版本修复：级联路径让每个 descendant 都走一次 `deleteSession` → `onSessionDestroyed` → `cronStore.removeAllJobs + engine.unregister`（机制不变，详 `specs/tech/scheduling/[P1]cron_subsystem.md §8`）。

**错误**：`404` session 不存在。

### 2.5 `PUT /session/:id` — 更新 session 元数据（v0.0.17 新增）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `PUT` | `/session/:id` | 更新 session 可变字段（部分更新语义，未提供字段不覆盖） | `UpdateSessionBody` | `200` + `Session` |

```typescript
interface UpdateSessionBody {
  workspaceDir?: string;    // [v0.0.17] 新的 workspaceDir（绝对路径，必须存在且是目录）
  title?: string;           // [v0.0.17] 可选，更新标题
  providerId?: string;      // 可选，更新 provider 绑定（保留字 / 具体 providerId）
  modelId?: string;         // 可选，更新 model 绑定（保留字 "default"/"none" 规范化为 default 落盘 / 具体 ModelRef）
  effort?: 'default' | 'low' | 'high' | 'max';        // [v0.0.148] 推理强度档位（canonical 语义键，4 档）；非法值 → 400
  approvalMode?: 'normal' | 'greenlight';             // [v0.0.148] 审批模式总开关（2 档）；非法值 → 400
  pinned?: boolean;         // [v0.0.231] 会话置顶（true=置顶 / false=取消，部分更新语义未提供不覆盖）；**提供但非 boolean → 400**（validatePinned，同 validateEffortApproval 风格）。写后 handler 直调 metaBroadcaster.broadcast(id)（同 title 路径）→ session_meta 广播 → 多端列表即时归位。**pinned-only 更新不推进 updatedAt**（置顶是纯标记操作，不算对话活动——用户裁决 2026-08-01；经 PutOptions.preserveUpdatedAt 机制，version 仍 +1）：取消置顶后该会话按**原对话时间**在非置顶组归位（可能不在顶部）；含其他字段的同一 PUT（如 title）仍正常推进 updatedAt
}
```

> **[v0.0.148] alwaysApprovedKeys 不进 UpdateSessionBody**：无用户直填语义——仅由 ApprovalManager 内部通过 `allow_always` 审批回填路径写（`tool-reply-handler` → `SessionStore.addAlwaysApprovedKey` read-modify-write merge）。客户端不能任意改写此字段。GET 响应返完整数组供只读观察。

> **[v0.0.148] effort / approvalMode enum 校验**：handler 内 `validateEffortApproval(body)` 校验非法值返 400（闭合 enum：effort ∈ 4 档 / approvalMode ∈ 2 档）。

> **[v0.0.47] title 更新副作用 MANDATORY**：body 提供非空 `title` 时，handler 内部 `updateSession(id, { title: bodyTitle, titled: true })`——同步置 `titled=true`（防 AI 起名返回时覆盖人工改名，详见 `specs/tech/agent/auto_naming/[P0]auto_naming_service.md §6`）；并在写完后**直接调 `SessionMetaBroadcaster.broadcast(sid)`**（v0.0.47 补强）emit `session_meta_update` 到 `(session_meta, _all)` → 列表 reducer 整条替换 → conv-item title 实时刷新（含多 tab 同步）。此广播不经 statusBus（title 更新不是 SessionEvent），走 handler 直调 broadcaster 路径（同 markUnreadTrue 模式，详见 `specs/tech/version_logs/v0.0.27/session-meta-broadcast-decision.md §4.1`）。

**切换 workspaceDir 流程**（后端 handler，权威见 `specs/tech/agent/session/[P0]session_workspace.md §4`）：

1. 校验 `newDir`：`path.isAbsolute(newDir) && fs.existsSync(newDir) && fs.statSync(newDir).isDirectory()` → 否则 `400`。
2. **[v0.0.139]** `SessionWorkspaceManager.switchDir(sid, newDir, setDirCb)` 内部：`recycleSession(sid)`（回收旧目录**全部**监听——相对路径基准变了，旧监听失效）→ `setDirCb`=`SessionStore.setWorkspaceDir(sid, newDir)`（更新字段 + 持久化 + emit `session_workspace_dir_changed`）。
3. 响应 `200` + 更新后的 `Session`。**不重启 watch**：前端收 `session_workspace_dir_changed` → 重置 tree（清 expanded）+ GET 顶层 + **watch-set 重算 effect 自动发新关注集合**（根 + 新根一级子文件夹，同新 tab 打开路径）。

**错误**：`400` body 非法 JSON / `workspaceDir` 非绝对路径 / 不存在 / 非目录；`404` session 不存在。

> **顺序保证 MANDATORY**（recycle → set）：先回收旧监听再改字段，避免旧 watcher 在 set 窗口继续推旧目录变化。详见 `session_workspace.md §4.1` + `session_workspace_manager.md §9`。

## 2.6 Workspace 端点（v0.0.17 新增）

### 2.6.1 `GET /session/:id/workspace/tree` — 工作区文件树（lazy）

| 方法 | 路径 | query | 语义 | 成功响应 |
|------|------|-------|------|---------|
| `GET` | `/session/:id/workspace/tree` | `parent?`（相对路径，缺省=顶层）/ `depth?`（缺省=1，仅一层） | 返回当前 workspaceDir 指定层的文件树（前端面板初始 / 展开子目录 / 手动刷新） | `200` + `WorkspaceTreeResponse` |

| 参数 | 类型 | 默认 | 语义 |
|------|------|------|------|
| `parent` | string? | 顶层（workspaceDir 根） | 相对 workspaceDir 的路径（如 `src/auth`）；指定时返该路径下的**直接子项**（不递归） |
| `depth` | number? | `1` | 本版本固定 `1`（只返一层）。预留扩展（future 支持 `depth=N` 多层） |

```typescript
interface WorkspaceTreeResponse {
  workspaceDir: string;          // 当前 workspaceDir（绝对路径；前端据此刷新路径栏 + 监听 dir_changed 时校验）
  parent: string | null;         // 本次返回的父路径（顶层=null；子目录=相对路径）；前端据此定位 childrenCache key
  tree: WsTreeNode[];            // 该层子项（lazy：只一层，不递归 children）
}

interface WsTreeNode {
  name: string;                  // 显示名（basename）
  path: string;                  // 相对 workspaceDir 的相对路径（唯一 key + POST open 入参；如 "src/auth/login.ts"）
  type: "file" | "dir";          // 真实类型（statSync 跟随 symlink 后判定）；symlink 不是新类型，是叠加标记
  hasChildren: boolean;          // dir 才有意义：是否有子项（前端据此决定 twisty 是否显示；本版本一次性返该层，不递归）
  /** [v0.0.263] true = 该节点是 symlink（lstatSync 识别，不跟随）；缺省 false 兼容旧响应 */
  isSymlink?: boolean;
  /** [v0.0.263] symlink 目标 realpath 绝对路径（仅 isSymlink=true 时有意义；供前端 tooltip/标注显示） */
  linkTarget?: string;
}
```

**lazy 加载语义**：
- 顶层 GET（无 `parent`）→ 返 workspaceDir 根级文件/文件夹 + 每个 dir 的 `hasChildren`。
- 展开某文件夹 → GET `?parent=<该 path>` → 返该文件夹的直接子项 + 每个 dir 的 `hasChildren`。
- **单次 GET 只返一层**（depth 固定 1），不递归 children；前端按需逐层 GET。
- watch event（§session_event.md `session_workspace_file_changed`）推送的变化，前端按展开状态决定立即刷新该层（GET `?parent=<父 path>`）还是标记 stale（下次展开 GET 拉最新）。

**过滤**：默认 ignore `node_modules` / `.git`（与 chokidar WATCH_OPTIONS 一致，`session_workspace_manager.md §4`）。按**节点名**过滤，与是否 symlink 无关。

**安全（路径白名单 MANDATORY，v0.0.263 链式授权）**：若提供 `parent`，后端 `whitelistResolve(realRoot, parent)` 分两步：
- **step 1 字符串前缀**：`resolve(realRoot, parent)` 必须在 `realRoot` 内（挡 `../` + 绝对路径注入）。
- **step 2 链式授权解析**：从 realRoot 出发**逐段** resolve——每段 `lstatSync` 判 symlink，命中则 `realpathSync` 授权该 symlink 目标为继续解析的根（**workspace 内存在的 symlink = 用户放置 = 用户显式意图 = 授权**）。无 symlink 段时与旧 `realpathSync(abs)` 等价（普通路径零行为变化）。
- 未授权越界（`?parent=../../etc`、绝对路径注入、未先展开 symlink 就访问其目标路径）→ `400`（穿越攻击语义不变）。

**错误**：`404` session 不存在；`400` `parent` resolve 后不在 workspaceDir 内（目录穿越攻击）/ `depth` 非 [1,10]；`500` workspaceDir 不存在或不可读（极端：用户外部删了目录 → 前端显示空态 + 提示切换目录）。

### 2.6.2 `POST /session/:id/workspace/open` — 打开文件/文件夹（系统默认应用）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/session/:id/workspace/open` | 后端 spawn 系统命令打开文件/文件夹（mac `open` / win folder `explorer`+file `start ""` / linux `xdg-open`） | `OpenBody` | `200` + `{ ok: true }` |

```typescript
interface OpenBody {
  path: string;                  // 相对 workspaceDir 的相对路径（如 "src/auth/login.ts"）
  kind: "file" | "folder";       // 文件 → 系统默认应用打开；文件夹 → 系统文件管理器打开
}
```

**[v0.0.263] 打开语义收窄**：本地文件（含普通 + symlink）**不再走本端点**——前端 handleOpen 对 `node.type === 'file'` 一律进内置 editor（`GET/POST /workspace/file`，见 §2.6.7）；远程链接（http/https，如 `.url`）走前端 `openLinkTarget` 浏览器打开。本端点当前实际只服务：文件夹（kind=folder，系统文件管理器打开 symlink→dir 目标目录）+ 历史兼容入口。kind 枚举保持 `file | folder` **不变**（后端不加 `link`——URL 打开是前端平台能力，open 端点保持纯文件路径语义）。

**安全（路径白名单 MANDATORY，v0.0.263 链式授权）**：后端 `whitelistResolve(realRoot, relPath)` 分两步——step 1 字符串前缀（`resolve(realRoot, relPath)` 必须在 realRoot 内，挡 `../` + 绝对路径注入）；step 2 链式授权解析（逐段 lstatSync 判 symlink → realpathSync 授权目标为继续解析根；workspace 内存在的 symlink = 用户放置 = 授权）。未授权越界（`../../etc/passwd`、绝对路径注入、未展开 symlink 先访问目标路径）→ `400`（穿越攻击语义不变）。

**错误**：`400` `path` resolve 后不在 workspaceDir 内（目录穿越攻击）；`400` `kind` 非 file/folder；`404` session 不存在 / 文件/文件夹不存在（含 broken symlink）；`500` spawn 失败（如 Linux 无 `xdg-open` → 错误信息提示「需安装 xdg-open」）。

### 2.6.3 `POST /session/:id/workspace/pick-directory` — 系统 dialog 选目录

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/session/:id/workspace/pick-directory` | 后端 spawn OS 原生选目录 dialog（mac osascript / win PowerShell FolderBrowserDialog / linux zenity/kdialog）；**支持新建文件夹** | `{ currentDir?: string }` | `200` + `{ path: string \| null }` |

```typescript
interface PickDirectoryResponse {
  path: string | null;           // 用户选/建的目录绝对路径；用户取消 → null
}
```

**平台命令**（后端 spawn，分支逻辑）：
- macOS：`osascript -e 'POSIX path of (choose folder with prompt "选择工作区目录" default location "<currentDir>")'`（原生支持新建文件夹）。
- Windows：`powershell -command "Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.FolderBrowserDialog; $f.SelectedPath='<currentDir>'; $f.ShowDialog() | Out-Null; $f.SelectedPath"`。
- Linux：`zenity --file-selection --directory --filename=<currentDir>` 或 `kdialog --getexistingdirectory <currentDir>`（优先 zenity，缺失回退 kdialog）。

**错误**：`500` Linux 缺 zenity/kdialog（错误信息提示安装）；`500` spawn 失败（用户强制取消 dialog 进程）；`404` session 不存在。

> **取消语义**：用户点 dialog 的「取消」→ 后端返回 `{ path: null }`（**非错误**，200 状态码）；前端无操作。

### 2.6.4 `/api/workspace/*` — ET seed 端点（v0.0.17 新增，**test-only**）

> **生产环境不暴露**：router gate 仅 `NODE_ENV=test` 时生效；非 test 环境 → `404 Not Found`，避免生产暴露写端点。仅供 E2E 测试 seed fs（建测试目录结构、写 marker 文件）。

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/api/workspace/ensure-dir` | ET seed 递归建目录 | `{ path, sessionId }` | `200` + `{ ok: true, dir }` |
| `POST` | `/api/workspace/touch` | ET seed 写文件（父目录自动 mkdir） | `{ path, sessionId, content? }` | `200` + `{ ok: true, file }` |
| `POST` | `/api/workspace/ensure?path=<abs>` | ET seed 幂等 mkdir（query 形式） | — | `200` + `{ ok: true, dir }` |

**安全（白名单，MANDATORY）**：
- `ensure-dir` / `touch`：`path`（绝对或相对 session.workspaceDir）经 `resolve + realpath + startsWith(workspaceDir)` 校验 → 越界 400；session 不存在 404；session 无 workspaceDir 500。
- `ensure`（query 形式）：**放宽白名单**（不做 session 校验，专供 switch_tc1 step3 「先建临时目录 `/tmp/ws_x`，再 PUT 切到该目录」flow，因为目标目录此时还不属于任何 session）；仅校验 `path` 是绝对路径 + mkdir recursive；越界检测交给后续 PUT /session/:id 的 workspaceDir 校验兜底。

**为什么例外**：ET seed 需要在 session 创建前建临时目录用于后续切换；若强要 session 校验，则 switch_tc1 流程无法构造。`ensure` 端点只做 mkdir，不写文件内容，攻击面小。

**错误**：`400` path 缺失 / 非绝对路径（ensure）/ 越界（ensure-dir / touch）；`404` session 不存在；`500` mkdir/writeFile 失败。

> 非生产 API，仅供 ET。生产 API 仍走 §2.6.1-2.6.3 三个 `/session/:id/workspace/*` 端点。

### 2.6.5 `POST /session/:id/workspace/watch` + `/unwatch` + `/watch-set` — 懒监听 acquire/release/声明式替换（v0.0.139 新增 / v0.0.271 加 watch-set）

> 权威模型见 `specs/tech/agent/session/[P0]session_workspace_manager.md`（懒监听：根一层 + 展开目录各一层非递归 + tab 关注集合 + 目录引用计数）。**v0.0.271 起前端主路径走声明式 `watch-set`**（关注集合 = 打开节点自身 + 一级子文件夹，全量重算 + diff）；`watch`/`unwatch` 增量端点保留向后兼容（release-all 仍用）。前端接线见 `component-workspace-panel.md §4.3`。

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/session/:id/workspace/watch` | 为一个 tab（`clientId`）登记对 `path`（相对 workspaceDir 的目录，一层非递归）的监听（增量兼容；新前端不再调单 path） | `WatchBody` | `200` + `{ ok: true }` |
| `POST` | `/session/:id/workspace/unwatch` | 注销该 tab 对 `path` 的监听；**`path` 省略 = 回收该 tab 全部监听**（release-all，前端卸载/切 session 调） | `UnwatchBody` | `200` + `{ ok: true }` |
| `POST` | `/session/:id/workspace/watch-set` | **声明式替换**该 tab 关注集合（v0.0.271）：发**完整集合**（非增量），后端与上次 diff 增删，**不在新集合一律 close**（防泄漏对账） | `WatchSetBody` | `200` + `{ ok: true }` |

```typescript
interface WatchBody {
  clientId: string;   // [v0.0.139] tab 身份（前端生成 ULID，一个 ws-panel 实例一个，跨展开/收起稳定）
  path: string;       // 相对 workspaceDir 的目录路径；"" 或 "." = workspace 根一层
}
interface UnwatchBody {
  clientId: string;   // 必填
  path?: string;      // 省略 = 回收该 tab 名下全部监听（release-all-for-tab）
}
interface WatchSetBody {
  clientId: string;   // 必填（缺 → 400）
  paths: string[];    // 完整关注集合（相对 workspaceDir 的目录路径数组；含 "" 根；非数组 → 400；元素非 string → 400）
}
```

**幂等（MANDATORY，用户裁决 #3）**：
- `watch` 同 `(clientId, path)` 重复 → **不叠加**（tab 目录集是 Set；已持有则 no-op，不重复 refcount++）。
- `unwatch` 该 tab 未持有 `path` → 静默 **no-op**（200，非错误）。快速连点展开/收起、重试天然安全。
- `watch-set` 同集合重复 → **diff 全空 → no-op**（幂等；前端初始 rootTree 两次 applyWatchSet、展开后 childrenCache 补发两次均安全）。
- ⚠️ **不建议与 watch/unwatch 增量混用同一 tab**：增量改集合，声明式 diff 基于旧集合 → 状态不一致。

**语义要点**：
- **显式控制，GET tree 绝不隐式 watch**（用户裁决 #1）：`GET .../workspace/tree` 只取数据、不建监听；监听只由本端点组显式驱动。
- **引用计数合并（多 tab）**（用户裁决 #5）：同一目录被 N 个 tab watch → 计数 N，只 1 个物理 watcher；unwatch/回收只减自己那份，计数归零才真正停止监听。
- **收起期间不推事件 + 展开兜底**（用户裁决 #4）：unwatch 后该目录变化后端不接、不推；重新展开时前端 GET `tree?parent=<path>` 拉回最新（复用既有 lazy 兜底）。
- **兜底回收**（用户裁决 #2）：即便前端未显式 unwatch（浏览器崩溃/断连），`session_panel` 订阅归零（1→0）经既有 unsubscribe 钩子触发 `recycleSession(sid)` 回收该 session 全部监听。
- **watch-set 泄漏对账**（v0.0.271 裁决 R3）：`applyWatchSet` 全量 diff，不在新集合的物理 watcher 一律 close（refcount 归零即关）——结构性收敛，不做周期对账。
- **watch-set realRoot 基准**（v0.0.271 coder3 实现发现）：handler 用 `realpathSync(workspaceDir)` 作 realRoot，与 watch/unwatch 三端点共用 `resolveRoot`——macOS `/var` vs `/private/var` symlink 记账一致（测试锁定）。

**安全（路径白名单 MANDATORY）**：`absDir = path.resolve(workspaceDir, path)` 必须 `startsWith(workspaceDir)`（含根本身）——防目录穿越，与 §2.6.1 tree 同款校验。`watch-set` 的 `paths` 逐元素同款校验（穿越 → 400；不存在/非目录 → 静默跳过不建监听）。

**错误**：`404` session 不存在；`400` body 非法 / 缺 `clientId` / `path` resolve 后不在 workspaceDir 内（目录穿越）/ `path` 非目录 / `paths` 非数组或含非 string 元素。**注**：目标目录不存在或非目录时后端**静默忽略不建监听**（返 200，容忍前端与 fs 短暂不一致；对齐 manager「不存在忽略不报错」），仅穿越攻击才 400。

### 2.6.6 `POST /session/:id/workspace/save-image` — 粘贴图片落盘 workspace（v0.0.177 新增）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/session/:id/workspace/save-image` | 把一张剪切板图片（base64）落盘到 `<workspaceDir>/images/image-<ulid>.<ext>`，返回相对 workspaceDir 的 POSIX 路径（前端据此插 `@file` pill） | `SaveImageBody` | `200` + `SaveImageResponse` |

```typescript
interface SaveImageBody {
  mediaType: string;  // MIME，必须 `image/*` 且在闭合集 {image/png, image/jpeg, image/jpg, image/gif, image/webp} 内
  base64: string;     // 纯 base64（无 `data:image/...;base64,` 前缀），非空
}

interface SaveImageResponse {
  path: string;       // 相对 workspaceDir 的 POSIX 路径，如 `images/image-01JK...png`（filename 服务端生成）
}
```

**行为**（handler `handleWorkspaceSaveImage`，复用 `session-workspace.ts` 的 `json()` helper）：
1. method 非 POST → `405`（带 `Allow: POST`）。
2. `deps.store.getSession(id)` 未命中 → `404`。
3. 解析 body 为 `Partial<SaveImageBody>`：JSON 解析失败 / `mediaType` 非 string / `base64` 非空 string 失败分支 → `400`。
4. `mediaType` 必须 `startsWith('image/')`，否则 `400`。
5. `base64` 非空校验；空串 → `400`。
6. `mediaTypeToImageExt(mediaType)` 推 ext，未识别（非闭合集 5 值之一）throw → `400`。**闭合集**：`image/png→'.png'`、`image/jpeg|image/jpg→'.jpg'`、`image/gif→'.gif'`、`image/webp→'.webp'`。
7. 取 `session.workspaceDir`：缺失 → `500`。
8. `realpathSync(workspaceDir)` 解析真实根 `realRoot`：异常 → `500`（防 `workspaceDir` 自身含 symlink 段）。
9. **filename 由 server 端生成**（客户端无路径控制权）：`imageId = ulid()`（`app/server/src/config/ulid.ts`，Crockford Base32、同进程单调），`filename = \`image-${imageId}${ext}\``，`dirAbs = path.resolve(realRoot, 'images')`，`absPath = path.resolve(dirAbs, filename)`。
10. **白名单二次守卫（MANDATORY）**：`absPath.startsWith(realRoot + path.sep)` 必须 true——虽 filename 自生成，仍守卫防任何注入。不通过 → `400`（路径穿越拒绝）。
11. `fsp.mkdir(dirAbs, { recursive: true })` + `fsp.writeFile(absPath, Buffer.from(base64, 'base64'))`：任一 reject → `500`。
12. 返 `200` + `{ path: \`images/${filename}\` }`（POSIX 相对路径，filename 由 server 生成无跨平台分隔符问题）。

**安全（路径白名单 + 命名确定性，MANDATORY）**：
- **filename 服务端单一权威**：`image-<ulid>.<ext>` 用项目内 `ulid()`（Crockford Base32，同进程单调），客户端只传 `mediaType` + `base64`，不参与命名；**禁用纯 `Date.now()`**（同毫秒可撞名；ulid 单调且唯一）。
- **路径白名单**：`absPath.startsWith(realRoot + sep)` 二次兜底，防任何注入。
- **错误消息不回显敏感数据**：error message 不含 `base64` / 文件内容 / 绝对路径（避免泄漏）。
- **images 目录不假设存在**：`mkdir recursive` 幂等建。

**错误 codes**：
- `400` body 非法 JSON / 缺 `mediaType` 或 `base64` / `mediaType` 非 `image/*` / `mediaType` 不在闭合集 / 路径白名单不通过。
- `404` session 不存在。
- `405` 非 POST（响应头带 `Allow: POST`）。
- `500` session 无 `workspaceDir` / `workspaceDir` realpath 失败 / `images` mkdir 失败 / writeFile 失败（权限/磁盘）。

**请求示例**：

```bash
curl -X POST http://127.0.0.1:3710/session/01KV.../workspace/save-image \
  -H "Content-Type: application/json" \
  -d '{"mediaType":"image/png","base64":"iVBORw0KGgoAAAANS..."}'
# → 200 {"path":"images/image-01JK...png"}
```

> **复用既有 file mention 渲染链**：前端拿到 `path` 后插 `<mention type="file" path="images/..." icon="file" label="image-...png"/>` pill——下游 see_image（v0.0.141）零改动可消费（INV-2 type-agnostic，新场景复用 `file` type 不新增 type）。详见 `specs/ui/components/chat-page/chat-composer.md §粘贴图片（handlePaste）`。

### 2.6.7 `GET /session/:id/workspace/file` + `POST /session/:id/workspace/file/save` — workspace 文本文件读/存（v0.0.227 新增）

> 服务内置 file viewer/editor 用：workspace panel 点文件在前端拦截改走内置 editor（复用 academy `component-modal-md-editor`），读/存经本组端点。**[v0.0.241] 前端拦截 11 种格式（xml/yaml/json/jsonl/txt/csv/tsv/toml/ini/.env/.log）+ md 均走此端点查看/编辑（含格式化 + 校验，前端 `isBuiltinEditable` 守门）**；**[v0.0.263] 起本地文件（任意扩展名，含普通 + symlink）一律进内置 editor——前端 handleOpen 不再用 `isBuiltinEditable` 白名单判定（该函数保留原 12 格式语义服务 link-target.ts markdown 链接分发），改为「本地文件一律 editor && !isRemoteLinkPath(.url)」新判定；`.url` 远程链接走浏览器**；**[v0.0.320] 12 格式 + code 进预览区 tab（弹层退役），读响应带 version、save 带 expectedVersion/force + 409 冲突检测**。后端不限扩展名。技术权威 `specs/tech/version_logs/v0.0.227/change_plan.md`（v0.0.227 引入）+ `specs/tech/version_logs/v0.0.241/change_plan.md`（v0.0.241 扩 11 格式）+ `specs/tech/version_logs/v0.0.263/change_plan.md`（v0.0.263 本地/远程二元 + 授权模型）+ `specs/tech/version_logs/v0.0.320/change_plan.md`（v0.0.320 version/409/search）；UI 契约 `specs/ui/components/chat-page/component-workspace-panel.md §4.4`（文件点击分流）+ `specs/ui/components/chat-page/section-preview-area.md`（预览区 tab）+ `specs/ui/components/common/component-modal-md-editor.md`（通用 file editor，academy + 降级场景）。

| 方法 | 路径 | 语义 | 请求体 / query | 成功响应 |
|------|------|------|--------|---------|
| `GET` | `/session/:id/workspace/file` | 读 workspace 内文件内容（**[v0.0.263] 前端本地文件一律进 editor，后端不限扩展名**；.url 也走本端点读内容后嗅探 URL；**[v0.0.269] `?binary=1` → 读 Buffer 返 base64**，供图片 viewer 二进制通道；**[v0.0.320] 文本分支响应加 `version`**） | query `path`（相对 workspaceDir）+ `binary?`（`'1'` 时二进制，缺省/非 `'1'` = UTF-8 文本） | `200` + `{ content: string, version: string }`（binary=1 时 content 为 base64 字符串，**不加 version**） |
| `POST` | `/session/:id/workspace/file/save` | 覆盖写 workspace 内文本文件（**[v0.0.320] 带可选 expectedVersion 校验 + force 强制覆盖；不匹配且非 force → 409 不写盘**） | `SaveFileBody`（含 expectedVersion? / force?） | `200` + `{ ok: true, version: string }`；`409` + `{ error:'conflict', currentVersion }` |

```typescript
// GET query param
path: string;   // 相对 workspaceDir 的路径（同 §2.6.1 tree node.path / §2.6.2 OpenBody.path）
binary?: string; // [v0.0.269] '1' = 二进制通道（读 Buffer 返 base64）；缺省/非 '1' = UTF-8 文本

interface SaveFileBody {
  path: string;     // 相对 workspaceDir 的路径
  content: string;  // 新全文内容（覆盖写）
  expectedVersion?: string; // [v0.0.320] 前端读时拿到的 version；匹配当前文件 → 保存成功；不匹配 → 409
  force?: boolean;          // [v0.0.320] true = 跳过校验强制覆盖（last-write-wins）
}

// 成功响应（v0.0.320 返回 version）
interface SaveFileResponse {
  ok: true;
  version: string;  // 写后重新 stat 的新版本标记
}

// 409 冲突响应（v0.0.320）
interface ConflictResponse {
  error: 'conflict';
  currentVersion: string;  // 当前磁盘文件最新 version（前端可展示/重载用）
}
```

**version 语义（v0.0.320）**：`version = statSync(absPath).mtimeMs + ':' + statSync(absPath).size`（mtime 变化或 size 变化均导致 version 变化）；`binary=1` 分支不加 version（image viewer 无冲突语义）；**向后兼容**：version 为新增字段，旧消费方忽略即可；旧后端缺 version 字段 → 前端跳过冲突检测降级 last-write-wins。

**行为**（handler `handleWorkspaceFileRead` / `handleWorkspaceFileSave`，落 `app/server/src/handlers/session-workspace-file.ts`，复用 `session-workspace.ts` export 的 `json()` + `whitelistResolve()`）：

**GET read** 流程：
1. method 非 GET → `405`（带 `Allow: GET`）。
2. `deps.store.getSession(id)` 未命中 → `404`。
3. query `path` 缺失 / 非字符串 → `400`。
4. 取 `session.workspaceDir`：缺失 → `500`。
5. `realpathSync(workspaceDir)` 解析 `realRoot`：异常 → `500`（防 workspaceDir 自身含 symlink 段）。
6. **路径白名单（MANDATORY，复用 whitelistResolve）**：`whitelistResolve(realRoot, path)` → `traversal` → `400`；`not_found`（realpath 失败/文件不存在）→ `404`。
7. **读取（v0.0.269 binary 分支）**：query `binary === '1'` → `readFileSync(absPath)` 读 Buffer → 返 `200` + `{ content: buf.toString('base64') }`（图片 viewer 前端拼 data URL；白名单校验与文本同一路径，安全面不变）；binary 缺失/非 `'1'` → `readFileSync(absPath, 'utf8')` → 返 `200` + `{ content }`（向后兼容）。读失败（权限/磁盘）→ `500`。

**POST save** 流程：
1. method 非 POST → `405`（带 `Allow: POST`）。
2. `deps.store.getSession(id)` 未命中 → `404`。
3. body 解析 `{ path, content, expectedVersion?, force? }`：JSON 非法 / `path` 非 string / `content` 非 string → `400`（`expectedVersion` / `force` 非 string/boolean → 忽略，宽松解析不 400）。
4. 取 `session.workspaceDir`：缺失 → `500`。
5. `realpathSync(workspaceDir)` → `realRoot`（异常 → `500`）。
6. **路径白名单（MANDATORY）**：`whitelistResolve(realRoot, path)` → `traversal` → `400`；`not_found`（文件不存在，realpath 失败）→ `404`（**last-write-wins 不新建文件**，仅覆盖既有文件；新文件创建不在本端点语义内）。
7. **版本校验（v0.0.320，MANDATORY 顺序）**：`expectedVersion` 缺失 **或** `force === true` → 跳过校验直接覆盖（last-write-wins，向后兼容旧调用方）；`expectedVersion` 存在且非 force → `statSync(absPath)` 当前 version（`${mtimeMs}:${size}`）比对：
   - 匹配 → 继续覆盖写。
   - **不匹配 → `409` + `{ error:'conflict', currentVersion }`，不写盘**（文件内容保持外部改动后的最新状态）。
8. `writeFileSync(absPath, content, 'utf8')` 覆盖 → 返 `200` + `{ ok: true, version: 写后新version }`。写失败（权限/磁盘满）→ `500`。

**安全（路径白名单 MANDATORY，与 §2.6.1/§2.6.2 同款双层校验，v0.0.263 链式授权）**：
- **step 1 字符串前缀**：`resolve(realRoot, path)` 必须在 `realRoot` 内（挡 `../` 和绝对路径注入）。
- **step 2 链式授权解析**：从 realRoot 出发**逐段** resolve——每段 `lstatSync` 判 symlink，命中则 `realpathSync` 授权该 symlink 目标为继续解析的根（**workspace 内存在的 symlink = 用户放置 = 授权**；symlink 文件读/写放行，目标可在 workspace 外）；无 symlink 段时与旧 `realpathSync` 等价。
- 未授权越界（非 symlink 段 `../`、绝对路径注入、未先展开 symlink 就访问目标路径）→ `400`（穿越攻击语义不变）。
- 复用 `app/server/src/handlers/session-workspace-path.ts whitelistResolve(realRoot, rel)` export（返 `WhitelistResult`），**不新写校验逻辑**。
- **持续可打包护栏（BUG-004）**：路径展开经 `session.workspaceDir`（server 启动时 `resolveDataDir` 已展开为绝对路径落库）+ `realpathSync`，**禁字面 `~` / 禁相对路径拼接**（packaged cwd=`/` 不崩）。

**冲突处理（v0.0.320 起：可选版本校验；无 expectedVersion / force = last-write-wins 兜底）**：
- 编辑过程中文件被外部（其他会话 / 外部编辑器 / watch 事件）修改：保存带 `expectedVersion`（前端读时拿到）→ 不匹配 → `409 { error:'conflict', currentVersion }`，**不写盘**（文件内容保持外部改动后的最新状态）；前端弹冲突 modal（取消=重载 / 覆盖=force 重发）。
- 旧调用方不带 `expectedVersion` / 传 `force: true` → **跳过校验直接覆盖**（last-write-wins，PRD §5.3 兜底语义不变）。
- **absolute IPC 源 v1 不做冲突检测**（`shell:writeFileText` 零改，last-write-wins）。

**[v0.0.269] 文件打开判定（前端 handleOpen，v0.0.263 本地/远程二元 → 五路分流）**：
- 拦截在 `section-workspace-panel.tsx handleOpen`，顺序（MUST）：
  1. `node.type !== 'file'`（文件夹，含 symlink→dir）→ `openWorkspaceItem`（`POST /workspace/open` kind=folder 系统文件管理器打开）。
  2. `isRemoteLinkPath(node.path)`（`.url`，大小写不敏感）→ `openRemoteLink` 浏览器打开（嗅探失败降级 editor）。
  3. `isImagePath(node.path)`（6 格式 png/jpg/jpeg/gif/webp/svg，大小写不敏感）→ **`setWsImageTarget` → `component-ws-image-viewer`**（只读图片查看，走 `?binary=1` 二进制通道）。
  4. `getFileFormat(path) !== null`（12 格式文本）→ `setFileEditorTarget` → 内置 editor。
  5. 其余（非 6 格式图片如 .bmp/.tiff / 未知扩展名）→ `openWorkspaceItem(kind='file')` 系统打开（**无占位 pill**——二进制无法预览的占位只在 editor 内防御，见下）。
- editor 内 format 由 `getFileFormat(path) ?? 'txt'` 分流（md→markdown 渲染 / structured→pre / 其它→txt plain view）；**looksBinary 保留为 editor 内防御**（`.txt` 被改名成真二进制时 NUL/替换符占比 >5% → 占位 pill「二进制文件无法预览」，不渲染 editor modal——前置分流后正常进 editor 的都是文本，此分支仅兜底）。
- 后端 file 读/存端点本身**不限制扩展名**（通用文件读/存，path 落在授权根内即可）；本地/远程/图片/文本/系统打开五路判定纯前端。

**错误 codes**：
- `400` body 非法 JSON / 缺 `path` / `content` 非 string（save）/ `path` 非法（read query）/ 路径白名单 traversal 拒绝。
- `404` session 不存在 / 文件不存在（realpath 失败，read + save 均不新建文件）。
- `405` 非 GET（read）/ 非 POST（save），响应头带 `Allow`。
- **`409`（v0.0.320）** `expectedVersion` 存在且非 force、与当前文件 version 不匹配 → `{ error:'conflict', currentVersion }`，不写盘。
- `500` session 无 `workspaceDir` / `workspaceDir` realpath 失败 / readFileSync / writeFileSync 失败（权限/磁盘）。

**请求示例**：

```bash
# 读文本（v0.0.320 起带 version）
curl http://127.0.0.1:3710/session/01KV.../workspace/file?path=docs/notes.md
# → 200 {"content":"# Notes\n\n...","version":"1750000000000:1234"}
# [v0.0.269] 读二进制（图片 viewer 通道，不加 version）
curl "http://127.0.0.1:3710/session/01KV.../workspace/file?path=img/logo.png&binary=1"
# → 200 {"content":"iVBORw0KGgoAAAANSUhEUg..."}  （base64）
# 存（v0.0.320 带 expectedVersion）
curl -X POST http://127.0.0.1:3710/session/01KV.../workspace/file/save \
  -H "Content-Type: application/json" \
  -d '{"path":"docs/notes.md","content":"# Notes\n\n新增内容\n","expectedVersion":"1750000000000:1234"}'
# → 200 {"ok":true,"version":"1750000000123:456"}
# 冲突（expectedVersion 不匹配 → 409，不写盘）
curl -X POST ... -d '{"path":"docs/notes.md","content":"# New","expectedVersion":"1750000000000:9999"}'
# → 409 {"error":"conflict","currentVersion":"1750000000123:456"}
# force 强制覆盖（last-write-wins）
curl -X POST ... -d '{"path":"docs/notes.md","content":"# New","force":true}'
# → 200 {"ok":true,"version":"1750000000123:456"}
```

> **不进 AT（用户裁决，CLAUDE.md 持久化测试用例库铁律）**：本组端点是**确定性 HTTP 契约 / CRUD**，LLM 不参与、行为确定，一律 UT 覆盖（`app/server/src/handlers/__tests__/session-workspace-file.test.ts`：路径穿越 + 读/存 round-trip + 错误码），不新增持久 AT case。

### 2.6.8 `GET /session/:id/workspace/search?q=` — workspace 递归搜索（v0.0.320 新增）

> 工作区搜索框后端补全量用：文件树只懒加载已展开层，前端无法全量匹配；后端递归全量搜索文件名/文件夹名（substring，大小写不敏感）。技术权威 `specs/tech/version_logs/v0.0.320/change_plan.md` D10。

| 方法 | 路径 | 语义 | 请求体 / query | 成功响应 |
|------|------|------|--------|---------|
| `GET` | `/session/:id/workspace/search` | 递归全量搜索（文件名 + 文件夹名 substring 匹配，大小写不敏感） | query `q`（搜索关键词，非空；空 → 400） | `200` + `{ files: string[], dirs: string[], truncated?: boolean }` |

```typescript
// GET query param
q: string;   // 搜索关键词（非空；空 → 400）

// 成功响应
interface WorkspaceSearchResponse {
  files: string[];        // 文件名匹配的全路径（相对 workspaceDir，POSIX 风格，如 "src/app.ts"）
  dirs: string[];         // 文件夹名匹配的全路径（相对 workspaceDir，如 "src/components"）
  truncated?: boolean;    // files+dirs 合计达 200 上限截断时 true（前端提示「结果过多」）
}
```

**行为（MANDATORY）**：
1. method 非 GET → `405`（Allow: GET）。
2. `deps.store.getSession(id)` 未命中 → `404`。
3. query `q` 缺失 / 空串（trim 后）→ `400` `{ error: 'q required' }`。
4. 取 `session.workspaceDir` 缺失 → `500`。
5. `realpathSync(workspaceDir)` → realRoot（异常 → 500）；`whitelistResolve(realRoot, '')` 校验根可读（复用 tree 安全面）。
6. 递归遍历（BFS/DFS 均可）：**跳过 `node_modules` / `.git` 目录**（复用 `session-workspace.ts` IGNORED_NAMES 集合）；symlink 目录**跟随**（与 tree 语义一致：workspace 内 symlink = 授权）——但**不跟随到 workspace 外**（目录递归时遇 symlink→dir 目标在 workspace 外 → 跳过该 symlink，防循环/越权）；symlink→file 可列入 files。
7. 匹配规则：`basename(path)` 大小写不敏感 substring 包含 q。文件命中 → `files.push(relPath)`；目录命中 → `dirs.push(relPath)`（**不递归其下层**——前端拿到 dir 后展示该目录展开内容，后端只返 dir 路径本身）。
8. 上限：files+dirs 合计 **200 条**；超限截断 + `truncated: true`（超限后停止继续遍历）。
9. 无匹配 → `200 { files: [], dirs: [] }`（非 404）。

**示例**：
```bash
curl "http://127.0.0.1:3710/session/01KV.../workspace/search?q=helper"
# → 200 {"files":["src/utils/helper.ts"],"dirs":["src/components"],"truncated":false}
```

> 该端点属确定性搜索契约，AT 覆盖见 `tests/api/workspace/workspace_search_tc3/case.yaml`（v0.0.320 新增 3 条 AT：file version / save 409 / search，均真实调 API）。

## 3. Session Messages

### 3.1 `GET /session/:id/messages` — transcript 分页

| 方法 | 路径 | 语义 | query | 成功响应 |
|------|------|------|-------|---------|
| `GET` | `/session/:id/messages` | 读 transcript（升序） | `limit`、`beforeId`（可选） | `200` + `{ items: Message[], hasMore: boolean }` |

| 参数 | 类型 | 默认 | 语义 |
|------|------|------|------|
| `limit` | number | `50` | 单页最大条数 |
| `beforeId` | string? | — | 取该 messageId（ULID 字典序）**之前**的 limit 条；缺失 = 取末尾 limit 条（最近 50） |

**分页约定**（支撑 PRD §5.8 上滑续载）：
- 打开 session：前端无 `beforeId` 调用 → 拿到最近 50 条。
- 上滑到顶：前端用最旧一条的 `id` 作 `beforeId` → 续载前 50 条，**前插**渲染。
- `hasMore=true` 表示还有更早历史；`hasMore=false` 停止续载。

**响应 `Message`**（对齐 `agent_message_interface.md §5`，v0.0.8 ContentBlock 子集见 tech change_log §3）：

```typescript
interface Message {
  id: string;               // ULID
  sessionId: string;
  role: "system" | "user" | "assistant" | "tool";
  content: ContentBlock[];  // TextBlock | ToolCallBlock | ToolResultBlock | ReasoningBlock | UsageBlock
  runId?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  stopReason?: string;      // [v0.0.131] 见下方说明
  runError?: RunErrorInfo;  // [v0.0.131] 见下方说明；RunErrorInfo = { errorCategory, displayReason, errorDetail? }（§10 路径 C 同款）
}
```

> **[v0.0.131] 消息附所属 run 的 stopReason/runError**：`handleMessagesGet` 按 `items` 去重 `runId` join `runs/{runId}.json`——**run 已结束（有持久化 stopReason）** 时，该 run 名下全部消息（不筛选 role/type）都附 `stopReason`（string，如 `no_tool_call`/`interrupted`/`error` 等，与 SSE `run_end` 的 stopReason 同义）；若该 run `error` 存在，同时附 `runError`（`RunErrorInfo = { errorCategory, displayReason, errorDetail? }`，同 §10 路径 C）。**user 消息**（无 `runId`）与 **run 未结束**（无持久化 stopReason）时，两字段均不下发（键整体省略，非 `null`）。前端 `use-messages` onInit 据此倒序取最后一条带 `stopReason` 的消息 seed `lastRunFinish`（冷读，与 SSE `run_end` 走同一展示链路）。

> **[v0.0.107] user 消息 `sender.channel`**：`role='user'` 的消息可携带 `sender.channel`（IM 渠道来源信封）。仅当消息从 IM 渠道（飞书）入站时填充——`{ type, instanceId, conversationId, imUserId, imUserName }`（`type`=`ChannelInstance.implId` 如 `'feishu'`）；web client 直发的 user 消息**无** channel（向后兼容）。前端据 `sender.channel.type` 渲染「来自 {type}」来源徽标（`type='client'`/无 channel 不显）。类型权威见 `specs/tech/channel/[P0]channel_impl_interface.md §5.1`；判别联合形态见 `specs/tech/agent/message/[P0]agent_message_interface.md §5`。

**错误**：`404` session 不存在；`400` `limit` 非 [1,200]；`400` `beforeId` 格式非法。

### 3.2 `POST /session/:id/messages` — 发消息触发 run

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/session/:id/messages` | enqueue user message + activate AgentLoop（新 run）；**非 SSE** | `PostMessageBody` | `202` + `{ runId: string, enqueueId: string }`（v0.0.13 响应体新增 `enqueueId`） |

```typescript
interface PostMessageBody {
  content: string;          // 必填，user query 纯文本
  // ── [v0.0.158 已废弃] providerId / modelId body 一次性 override 已删除 ──
  //   前端不再传；后端 handler 收到**静默忽略**（不解析、不校验、不落 session、不返 400）。
  //   保留兼容：旧 client 传字段不会导致失败，仅无效——参数被丢弃，仍以 server session 记录为准。
  //   模型改动的生效点 = 用户改设置那一刻（PUT /session 或 PATCH squad），
  //   下次发消息走 server 记录（resolveConfigBySid 读 session.modelId/providerId + squad.modelDefault）。
  //   历史（v0.0.157 及之前）：body 可传 providerId/modelId 一次性覆盖当次 turn + 落 session 持久。
  activate?: boolean;       // 可选（v0.0.15，默认 true）：false 时只 enqueue 不 activate。**测试专用**：仅 NODE_ENV=test 生效；生产环境忽略（始终激活）
  // ── [v0.0.101] 悬挂型 tool 回填（ask-question 答案 / approval 决定 / callback payload）──
  toolReply?: {
    toolCallId: string;     // 关联 PendingToolCall.toolCallId（pre-process 匹配 key）
    handleType: "direct_result" | "approval" | "callback";
    payload: unknown;       // FeedbackAnswer | ApprovalDecision | unknown（按 handleType）
  };
}
```

> **[v0.0.158] body.providerId / body.modelId 已废弃（兼容层）**：删除动机——(1) 「per-call 一次性覆盖不落 session」违反「配置改动的生效点 = 用户改设置那一刻」的一致性；(2) 前端 chat 页面已改为编辑 session 时直接 PUT /session 落库（picker onChange 走 setSession），后续 POST /messages 不再挂参。删除方式 = **兼容层**：前端删传参、后端 handler 不解析不 400 不落 session（旧 client 仍能发消息，参数被静默丢弃）。此变更不影响 §3.2 其余响应字段与错误码。技术权威 `specs/tech/agent/providers_and_models/[P0]model_resolve.md §4 原则 6`。

> **[v0.0.107] 本端点不接受 `sender.channel`**（避免下游误解）：`PostMessageBody` 无 channel 字段——HTTP client 发的 user 消息 handler 硬构造 `sender: { source: 'user' }`（无 channel），落库 message 无 `sender.channel`，前端不显来源徽标（`type='client'` 语义）。**全仓唯一构造 `sender.channel` 的入口 = 飞书 WS 入站**（`feishu-channel.ts deliverUserMessage` 填 `type: instance.implId`，经 `deliverTo` 进 agent loop）；无「message-seed」类端点可从 HTTP 注入 channel。故 GET /messages 返回带 `sender.channel` 的 user 消息必来自 IM 渠道，非 HTTP client 伪造。

> **[v0.0.101] toolReply 回填分支**：body 含 `toolReply` 时，handler 构造 `Message{ role:'user', sender:{source:'tool_reply', tool_reply:{toolCallId, runId}}, content:[{type:'tool_reply', toolCallId, handleType, payload}] }`（runId 从 pendingToolCalls 匹配 toolCallId 取）→ `deliverTo(sessionId)`（复用统一入口，INV-5；不独立接口）。pre-process drain 时按 sender.source='tool_reply' 识别 → 走 handleType 三分发编辑占位 block（非普通 ingest）。body 不含 toolReply 时走原 user query 路径不变。suspended 态接 query（无 toolReply）= 放弃 c 路径（清空 pending + 占位原样发 LLM）。
>
> **[v0.0.101] toolReply 错误码**（handler 预校验，不发 deliverTo）：
> - `400` `toolReply.toolCallId required`（空 / 非字符串）或 `toolReply.handleType invalid`（非 direct_result/approval/callback 三者之一）。
> - `409` `{ error: 'tool_reply toolCallId mismatch or no pending' }`：peek 队首 `pendingToolCalls[0].toolCallId !== body.toolReply.toolCallId`（或队列为空）。INV-4 串行展示约束——只能回填队首，不能跳过中间项；前端必须按收到 `require_human_input` 的顺序逐条提交。
>
> **[v0.0.122] handleType='approval' 实例化**（v0.0.101 留位兑现，端点零新增）：`toolReply.payload = ApprovalDecision = { decision: 'allow' | 'allow_always' | 'deny' }`（危险 bash 命令审批卡提交）。HTTP 契约不变——handler 仍构造 `sender.source='tool_reply'` message 走 `deliverTo`。pre-process drain 按 handleType='approval' 三分发（`specs/tech/agent/tools/[P0]tool_permission.md §6`）：
> - `allow` → 补跑原 tool.run（经执行层沙箱）→ 真实结果编辑占位 block（status pending→success/fail）。
> - `allow_always` → 同 allow + `ApprovalManager.recordAlways(sessionId, approvalKey)`（本会话内该 approvalKey 免弹）。
> - `deny` → 占位编辑为 isError「用户拒绝执行：{reason}」（status pending→fail），LLM 可见继续对话。
>
> **`require_human_input` 事件 / `GET /pending-tool-call` 对 approval 无差别**：payload=队首 PendingToolCall（subState='need_approval'，data=ApprovalData{toolName, arguments, reason, approvalKey}）——infra 不区分 subType，前端按 subState 选审批卡（need_approval）/ 提问卡（need_feedback）渲染。

**行为**（**[v0.0.12 修订]** 并发语义从「409 报错」改为「按 state 分流 enqueue + activate」，design §3.3 / §4.3）：
1. 构造 `role:"user"` Message（content=`[{type:"text",text:content}]`）。
2. `AgentManager.enqueue(config, [msg])` → 写 inbox（**始终入队**，无论 state 为何——前端据此显示 enqueue view）+ 返回 `enqueueId`（v0.0.13 端点响应体携带，前端/测试可立即拿到用于 cancel，不必等 SSE `message_enqueued`）。
3. **[v0.0.15]** 若 `body.activate === false` **且** `process.env.NODE_ENV === 'test'` → 跳过 activate，消息留 inbox 等后续 POST 触发 drain。返 202 + `{ runId: '', enqueueId }`。**测试专用守卫**：AT 测试构造「多条消息在 inbox 排队」确定性场景（不依赖 LLM 速度维持 run）；生产环境忽略此参数（始终激活，避免 API surface 暴露测试行为）。
4. `AgentManager.activate(config)` → 按 session state 三情况 dispatch（详见 specs/tech/agent/session/[P0]session_state.md §4.3）：
   - `state=running` → 返 `{ status:"already_activated", runId:currentRunId }`；消息排队，eager loop 下轮 drain 消费。**端点仍返 202 + `{ runId, enqueueId }`**（runId 即当前 running run 的 id；前端 UX：消息进 enqueue view，run 进度见 SSE）。
   - `state=idle / interrupted / error` → CAS markRunning(newRunId) + 启动新 AgentLoop → 返 202 + `{ runId:newRunId, enqueueId }`。
   - `state=suspended` → **[v0.0.101]** 同上走 CAS markRunning（markRunning WHERE 加 'suspended'，O6 闸门：回填 tool_reply 或新 user query 进 inbox 时从 suspended 激活）→ 启动新 AgentLoop → pre-process drain 时识别 tool_reply（b 路径，编辑占位 block + resolve）或 user query（c 路径，清空 pendingToolCalls + 占位原样发 LLM）。返 202 + `{ runId:newRunId, enqueueId }`。
   - `state=interrupting` → **循环等待**（poll 100ms 重读 state），直到非 interrupting（→ interrupted/idle），再 activate 新 loop；消息已 enqueue 排队，abort 收尾完成后新 loop drain 处理。端点在循环等待期间保持连接，最终返 202 + `{ runId, enqueueId }`（新 run 的 id）。**这保证 clear replay 期间无其他 loop 起来写 buffer**（design §5.6）。
5. 端点本身**异步**，不 await run 完成；返回 `{ runId, enqueueId }` 供前端关联 SSE。

> **[v0.0.31·代码已落地]** 步骤 1-4 内部调用已从「裸 `enqueue(config)+activate(config)` + 自行 `buildSessionConfigFromDeps`」**收敛为 `manager.deliverTo(sessionId, userMsg)`**（manager 内部 resolveConfigBySid 获取 config + enrich 跳过 user 变体）。sender 形态对齐判别联合：`sender = { source: 'user' }`（**无 agentName/agentId 扁平残留，无 agent 子结构**——user 变体按 `agent_message_interface §5` 判别联合只有 source 字段）。enrich 在 deliverTo 层只对 `source='agent'` 生效（user/system/approval 原样透传，见 `[P0]agent_inbox_enqueue.md §2.5.4`）。HTTP 契约（请求体/响应体/状态码）**不变**——仅内部实现收敛。代码现状：`session-messages.ts:243` 测试守卫走 `enqueue(sessionId)`；`:252` 默认走 `deliverTo(sessionId, userMsg)`（manager enrich + enqueue + activate）。详见 `specs/tech/agent/agent_interface_and_loop/[P0]agent_manager.md §2.4` 调用方清单。落库 message.sender 形态见 `specs/api/version_logs/v0.0.31/change_log.md §3.2`（AT 黑盒断言 `sender = {source:'user'}`，无 agent 字段）。

> **[v0.0.13] 响应体加 `enqueueId`**：原本前端只能从 SSE `message_enqueued` 拿 enqueueId（有网络延迟，cancel 测试时序不稳）。v0.0.13 让响应体直接返 enqueueId，前端/测试可立即用于 cancel POST，消除「等 SSE 拿 enqueueId」的时序窗口。SSE `message_enqueued` 仍照发（前端可二选一，幂等）。

> **[v0.0.15] 移除 `cancelEnqueueId` 参数**：v0.0.13 曾引入 `cancelEnqueueId`（发新消息同时取消某条排队消息的原子参数），用户判断为多余概念。cancel 统一走专用端点 `POST /session/:id/messages/:enqueueId/cancel`（§3.4）——该端点经 `AgentManager.cancel` 同步 `removeMessage`（T1 核心修复，详见 enqueue_cancel §4.1），配合 `activate=false` 测试守卫可稳定触发 cancel 配对（消息留 inbox → cancel 同步移除 → 后续 activate drain 消费其余）。生产 cancel 场景：用户在 enqueue view 点某条取消按钮即调专用端点，无需「发新消息同时取消」的复合语义。

> **[v0.0.15] `activate` 测试专用守卫**：`activate=false` 仅在 `NODE_ENV=test` 时生效；生产环境忽略（始终 activate）。AT 测试用此构造「多条消息在 inbox 排队」确定性场景（不依赖 LLM 速度维持 run），保证 cancel POST 在任何时序下都能命中仍在 inbox 的排队消息。生产 API 不暴露 skip-activate 行为。

**run 进度**：前端**不**从这个端点拿流式响应；改通过 `POST /sse/subscribe { topic:"agent_loop", group:"session_id:<sid>_amt:current" }` 订阅，经 SSE 收 `run_start` / `message_*` / `tool_*` / `run_end`（见 §4）。`_amt:current` 为主对话 mode（v0.0.16，agent_interface.md §4）；forked 旁路 mode（summary / memory_extract）使用 `_amt:<modeKey>` 各自独立 group，不污染主对话流。

**错误**：`404` session 不存在；`400` `content` 空；`400` `providerId` 提供但不命中；`400` `{code, message, detail}` **model 未配置**（详见下条 error shell）。

> **[v0.0.102] error shell 路径返 400 MODEL_NOT_CONFIGURED**：session.modelId=`default`（保留字）但 app_config `default_models.chat` 也未配 → `buildSessionConfigFromDeps` 内部 `resolveModel` 跑空抛 `ModelNotConfiguredError`（含 `code`/`message`/`detail`）。handler 两条路径都返 400：
> - **路径 ① deliverTo 同步 throw**（`buildSessionConfigFromDeps` 在 deliverTo 入口同步调，throw 早）→ handler `catch (e) { if (e instanceof ModelNotConfiguredError) return json(400, {code, message, detail}) }`。
> - **路径 ② activate 返 error shell AgentRun**（`buildSessionConfigFromDeps` 在 activate 内 `resolveConfigBySid` 异步调，throw 被 activate catch 落 `makeErrorRun`）→ handler 检查 `agentRun.state === 'error'` → 调共享 helper `resolveErrorRunResult(agentRun)` → `agentRun.error instanceof ModelNotConfiguredError` → 返 400 `{code, message, detail}`，其余 activate 失败（session not found / buildMainDeps throw）→ 500 兜底。
>
> **v0.0.102 修复**：之前 `makeErrorRun` 只收字符串（`String(error)`），丢失 `ModelNotConfiguredError.code/detail`，路径 ② 只能返 500。现在 `makeErrorRun(sid, modeKey, error: Error|string)` 透传原 Error → `AgentRun.error?: unknown` 字段携带 → handler 识别返语义化 400。技术权威：`specs/tech/agent/agent_interface_and_loop/[P0]agent_manager.md §4.1`（makeErrorRun 契约）+ `[P0]agent_interface.md §3`（AgentRun.error 字段）。
>
> **响应体（400 MODEL_NOT_CONFIGURED）**：`{ "code": "<error.code>", "message": "<error.message>", "detail": "<error.detail>" }`（向后兼容：caller 仍可读 `message`）。

> **[v0.0.47] 首 query 后台 AI 起名副作用（fire-and-forget）**：当本端点接到的是该 session 的**首条 user query**（transcript 无 prior role=user 消息）且 `bizType==='playground' && type!=='subagent'` 时，handler 在 deliverTo 前/后**并行**触发一次后台 LLM 起名调用（不 await，不影响 202 返回时序）：复用 `agentManager.resolveConfigBySid(sid).client.call({messages:[{role:user, NAMING_PROMPT+plainText}], params:{maxTokens:32, temperature:0}})` 单次非流式调用。AI 名返回时若 `session.titled===false`（仍是默认名）→ 应用 `updateSession({title:aiName, titled:true})` + emit `session_meta_update`（前端列表经 `session_meta` topic 收到，conv-item title 从「新会话」变成 AI 名）；若 `titled===true`（用户在此期间人工改名）→ 丢弃 AI 名。失败/超时/空 → 静默（不影响主 run）。详见 `specs/tech/agent/auto_naming/[P0]auto_naming_service.md`。HTTP 契约（请求体/响应体/状态码）**不变**——AI 起名是纯后台副作用，client 经 `session_meta` topic 观察 title 变化。

> **[v0.0.12] 移除 409**：旧版「session 已有 run 在跑 → 409」语义废除。running/interrupting 时发消息改为 enqueue 排队（返 202，不报错），interrupting 时 activate 循环等待。前端 UX 从「禁用 send 直至 run_end」改为「send 一直可点 + running 时显示中断按钮（见 §3.3）+ enqueue view 显示排队消息」（design 板块 0 子问题 4）。

### 3.3 `POST /session/:id/abort` — 中断当前 run（v0.0.12 新增，v0.0.16 修订）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/session/:id/abort` | 中断 session 指定 (runId, modeKey) 的 run 并执行收尾（fire-and-forget） | `AbortBody` | `202` + `{ ok: true, accepted: boolean }` |

```typescript
interface AbortBody {
  runId: string;       // 必填，目标 run 的 ULID（v0.0.16 新增）；与 session 当前 currentRunId 不匹配则 accepted=false
  modeKey: string;     // 必填，目标 agent mode key（v0.0.16 新增）；当前主对话 = "main"（v0.0.204 由 "current" 改名），forked = "summary" / "consolidate"（v0.0.204 由 "memory_extract" 改名）。
  // **[v0.0.204] code 层字段名 `modeKey` → `runKind`**：闭合枚举 `'main'|'summary'|'consolidate'`（`app/shared/src/types/session-kind.ts`）。HTTP handler 解析 `body.runKind`（`app/server/src/handlers/session-abort.ts:66-70`，非 `modeKey`）；缺省或非法值（含旧 'current' / 'memory_extract'）兜底 'main'（不抛 400）。新 client 应传 `runKind`；本 spec 字段名 `modeKey` 暂未全量改名（v0.0.204 rename 漂移待后续 spec sync）。
}
```

> **[v0.0.16] abort 三参数缺一不可**——`sessionId`(path) + `runId`(body) + `modeKey`(body) 三者唯一定位 agentRuns map 中的 entry（key=`${sessionId}_${modeKey}`），且校验目标 run 即当前活跃 run。任何一个缺失或不匹配，abort 不生效（幂等 `accepted=false`），避免「乱 abort 别人的 run」。

**行为**（4 步收尾，详见 `specs/tech/agent/agent_interface_and_loop/[P0]agent_interrupt.md` §2；本端点只暴露 HTTP 契约，不重复内部流程）：
1. 校验 `agentRuns.get(sessionId_modeKey)?.runId === body.runId`：不匹配（已结束 / 已被新 run 取代 / modeKey 不对）→ 直接返 200 `{ ok:true, accepted:false }`（幂等无害）。
2. `state: running → interrupting` + `currentRunId: <runId> → null` + `controller.aborted = true`（CAS：仅当 currentRunId=thisRun 才生效）。
3. 等 loop 退出（100ms timeout 兜底）→ subscribe 回放 buffer → 重组 partial message（复用 `message_start` 的 messageId）+ interrupt 标记 → ingest；补 interrupted tool_result（悬空 tool_call）。
4. `bus.clearReplay(group)`（清半截 replay buffer）。
5. emit `run_stop`(stopReason=`interrupted`) + `state: interrupting → interrupted`。

**返回语义**：
- `202 Accepted` + `accepted: true` = 服务端已接收中断请求、开始异步收尾。**不 await 收尾完成**——调用方通过 SSE `run_end`(stopReason=`interrupted`) 感知收尾结束，通过 `GET /session/:id`（state→interrupted + currentRunId=null）或 SSE `session_status_update` 确认终态。
- `200` + `accepted: false` = 目标 (runId, modeKey) 已不活跃（runId 不匹配 / 未运行 / 已被新 run 取代），调用是幂等 no-op。

**幂等**：
- session 无活跃 run（state∈{idle, interrupted, error}）→ 200 + `accepted:false`（幂等 no-op）。
- `runId` 不匹配 currentRunId → 200 + `accepted:false`。
- `modeKey` 不存在于 agentRuns map → 200 + `accepted:false`。
- 同一 (sessionId, runId, modeKey) 并发多次 abort → CAS 串行化（仅首个成功 markInterrupting → 202 accepted:true，其余幂等 200 accepted:false）。

**请求示例**：

```bash
curl -X POST http://127.0.0.1:3710/session/01KV.../abort \
  -H "Content-Type: application/json" \
  -d '{"runId":"01KV...RUN","runKind":"main"}'
# → 202 {"ok":true,"accepted":true}
```

**错误**：`404` session 不存在；`400` body 缺 `runId` 或 `modeKey` / 字段非字符串。

> **[v0.0.12] 与 §3.2 的协作**：用户点 abort 后，session 进入 interrupting，期间若再发消息（§3.2），activate 走「循环等待」分支，等 abort 收尾完成（state→interrupted）再激活新 loop 消费已排队消息（design §4.3 case3 / §5.6）。这保证 clear replay 期间无其他 loop 起来写 buffer。

### 3.4 `POST /session/:id/messages/:enqueueId/cancel` — 取消排队中的消息（v0.0.12 新增）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/session/:id/messages/:enqueueId/cancel` | enqueue 一条 cancel 消息到 inbox（不删 inbox），作废对应的 `enqueueId` 排队消息 | 无（空 body） | `202` + `{ ok: true }` |

**行为**（design 板块 3.4；内部实现见 `specs/tech/agent/agent_interface_and_loop/[P0]agent_manager.md` §3 `cancel` + `[P0]agent_inbox_enqueue.md` §4.1 同步移除路径）：
1. `AgentManager.cancel(sessionId, enqueueId)` → **同步移除** inbox 中对应 message 条目（`inbox.removeMessage`）。移除成功（message 还在 inbox，cancel 早于 drain）→ 立即 `emit enqueued_message_canceled` → 返 202。
2. 移除失败（message 已被 drain 消费 / 不存在）→ `inbox.appendCancel(cancelFor=enqueueId)` 追加 cancel 条目作 drain 兜底（drain 时找不到配对 message 自然丢弃，幂等无害；不 emit 事件，前端已按 `enqueued_message_processed` 移除 enqueue view）。
3. 无配对 cancel 的 message → 正常 processed（emit `enqueued_message_processed`）。

**返回语义**：`202 Accepted` = 服务端已接收取消请求、已执行同步移除或追加兜底条目。**不 await drain 完成**——调用方通过 SSE `enqueued_message_canceled`（取消生效）或 `enqueued_message_processed`（已先一步被消费，幂等）感知结果。

**幂等 / 竞态**（enqueue_cancel §4.1）：
- `enqueueId` 对应 message 还在 inbox → **同步移除** + emit `enqueued_message_canceled`。
- `enqueueId` 对应 message 已被 drain processed（cancel 来晚）→ removeMessage 返 false → appendCancel 追加兜底 → 下轮 drain 找不到配对丢弃，**无事件**（前端已按 `enqueued_message_processed` 移除 enqueue view）。
- 同 `enqueueId` 多次 cancel → 首次同步移除生效；后续 removeMessage 返 false → appendCancel 幂等。
- `enqueueId` 不存在 / 格式非法 → 仍返 202（无害）。

**错误**：`404` session 不存在。

> **[v0.0.97] 前端 UX 修订**（详见 `specs/ui/components/chat-page/_overview.md` §4.11a）：用户在 enqueue view 点 enqueue-item 的取消按钮 → **x 立即转圈**（component-enqueue-view 本地 `canceling: Set<enqueueId>`，1s 恢复，转圈期禁点）+ POST cancel；移项**只**靠 SSE `enqueued_message_canceled`（多端一致性，不乐观移除、不进 store）。1s 内 SSE 未到回 x 可重试点（cancel POST 幂等）。

### 3.5 `GET /session/:id/inbox` — inbox 只读快照（v0.0.97 新增）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `GET` | `/session/:id/inbox` | 返回 inbox 中当前所有 `kind:'message'` 条目的只读快照（不清空、不锁、不触发 drain） | 无 | `200` + `{ items: InboxItemView[] }` |

**响应类型**：

```typescript
interface InboxItemView {
  enqueueId: string;
  content: ContentBlock[];   // 与 message_enqueued SSE 事件 payload 的 content 字段完全同形（INV-2）
  enqueuedAt: string;        // ISO date（InboxEntry.enqueuedAt，append 时注入）
}
```

**行为**（design `[P0]agent_inbox_enqueue.md` §10；实现：handler 调 `agentManager.peekInbox(id)` → 过滤 `kind:'message'` → 映射 InboxItemView）：
1. 调 `InboxStore.peek(sessionId)` 拿当前 inbox 条目（**只读视图**，不清空、不锁）。
2. handler **浅拷贝快照** `[...peek]` 防 drain `splice(0)` 改已返引用（peek 返直接引用，drain 并发会清空同数组）。
3. 过滤 `kind:'message'`（`kind:'cancel'` 是 drain 内部信号，不暴露）。
4. 按 `enqueuedAt` 升序（ULID 字典序 = 入队时间序，与 SSE 到达顺序一致）。

**约束**：
- **无副作用**：纯读，不 emit 事件、不改 inbox 状态、不触发 drain（drain 仍由 agent_loop eager 调度）。
- **content 形对齐 SSE**：`content: ContentBlock[]` 必须与 `message_enqueued` 事件 payload 的 `content` 完全同形（INV-2）——前端走同一 reducer 入口 `contentBlocksToPreviewText`，不出现 GET vs SSE 两套处理路径。
- **与 GET /messages 边界**：GET /messages 返已落库 transcript（ULID messageId），GET /inbox 返未落库 inbox 句柄（enqueueId，尚未生成 messageId）；两者正交。

**用途**：切 session 时前端 `useMessages` onInit 在 GET /messages 之后追加 GET /inbox，把响应 seed 进 `enqueueItems`（经 `contentBlocksToPreviewText` 转 string）——让「切到 running session 立刻看到该 session 既有排队队列」与 GET /messages 拉 transcript 一致。inbox 非 sticky（无 SSE replay），靠 GET seed 才能补足切会话场景。

**幂等**：后续 SSE `message_enqueued` 到达时前端 reducer 已有 `some(enqueueId)` 去重，GET seed 与 SSE 增量不会双计。

**错误**：`404` session 不存在。

### 3.6 `GET /session/:id/pending-tool-call` — 悬挂型 tool 队首只读 peek（v0.0.101 新增）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `GET` | `/session/:id/pending-tool-call` | 返回 `pendingToolCalls` 队列队首（单个 `PendingToolCall`），用于前端 recover（切走切回 / 重启后重渲染提问卡） | 无 | `200` + `{ pending: PendingToolCall \| null }` |

**响应类型**：

```typescript
interface PendingToolCall {
  sessionId: string; runId: string; toolCallId: string; toolName: string;
  handleType: "direct_result" | "approval" | "callback";
  subState: "need_feedback" | "need_approval";
  data: FeedbackData | ApprovalData;          // 交互载荷（前端渲染用）
  resultMessageId: string; resultBlockIndex: number;  // 编辑目标（transcript 里占位 block 位置）
  status: "pending" | "resolved";
}
```

**行为**（design `reqs/[done] v0.0.101.ask_question_tool/3-ask-question-tool.md` §4/§10；实现：handler 调 `store.peekPendingToolCall(id)`）：
1. **只读快照**（peek 队首，不清空、不锁、不触发 drain），与 GET /inbox 同构。
2. 空队列（session 无 pending）返 `200` + `{ pending: null }`（**非 404**——空是合法状态）。
3. 多 pending 串行展示（INV-4）：peek 仅返队首单条；前端提交后回填进 inbox → pre-process resolve 一条 → 下一个变队首 → 配合 SSE `require_human_input`（payload=新队首）切换。

**约束**：
- **无副作用**：纯读，不 emit 事件、不改 pendingToolCalls 状态。
- **配合 SSE sticky replay**：进 suspended 时 emit `require_human_input`（agent_loop topic，payload=单个 PendingToolCall）→ 前端首次弹。切走切回 / 重启后 SSE 无 replay → 前端 onInit 主动 GET 本端点拉队首重渲染（d 路径，类比 v0.0.97 GET /inbox seed enqueue）。
- **可见性门控**：提问卡可见性 = `pendingToolCalls.length > 0`（非 `session.running`，因 suspended 排除 running，INV-2）。

**错误**：`404` session 不存在。

## 4. SSE Channel

复用全局单链路（`specs/tech/app/frontend/[P0]sse_channel.md` §2-§4）：前端**一条** SSE connection（`GET /sse`）+ 多 (topic,group) 订阅（POST subscribe/unsubscribe）。**多连接 fan-out**：多个客户端（或同客户端多 tab）可同时 `GET /sse`，每条连接独立维护订阅集合。

> **[v0.0.88] 多订阅 + 广播 + 前端过滤（方案 B）**：前端单 SseClient 单例（`[P0]sse_client_singleton.md`），每 `subscribe()` 内部生成 `subId` 上行，后端帧携带 `subId` 下行（writeFrame **广播所有 sinks 不变**），前端按 `subId` 路由到 handler。同 (topic,group) 多订阅者各收带自己 subId 的帧（每订阅者各一 listener 各调一次 writeFrame，广播 N×M 帧；前端只匹配自己 subId，其他 tab 帧静默丢弃）。**1 次订阅 = 1 个 sub id**（不用 component id，组件多订阅各生成独立 subId 不撞车）。详见 `specs/tech/app/frontend/[P0]sse_channel_multipub.md` + `specs/api/version_logs/v0.0.88/change_log.md`。

### 4.1 `GET /sse` — SSE 流

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/sse` | 全局单 SSE connection；接收所有已订阅 (topic,group) 的事件帧（每帧携带 subId，**广播不变**——writeFrame 推所有 sinks，前端按 subId 过滤） | `200` · `Content-Type: text/event-stream` · `cache-control: no-cache` |

**SSE 帧格式**（每帧一条 `data:` 行，JSON payload）：

```
data: {"topic":"agent_loop","group":"session_id:01KV..._amt:current","data":<AgentEvent>,"timestamp":"2026-06-21T...","subId":"01J..."}
```

- `data` = `AgentEvent`（见 `specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md` §8，topic=`agent_loop`）。逐事件 payload 字段以该 tech 文档为权威源，本 API 文档不重复展开。
  - **[v0.0.119.bugs]** `message_start` 事件可携带 `sender?: {source:'agent', agent:{ref:{type,sessionId,name}}}`（仅 a2a inbox 消息；见 `agent_event.md §4.2`）——前端据此判定作者身份，修复 a2a 消息 SSE 实时推送被误判为 YOU 的问题。与既有 `origin`（user channel）各司其职。
- `subId`（[v0.0.88] 加）：订阅唯一 id（前端 subscribe() 内部生成 ULID），前端按此路由到 handler（零过滤）。**1 次订阅 = 1 个 sub id**。
- 前端按 `${topic}:${group}` 分发到 handler（v0.0.88 前单 SseClient 路径），或按 `subId` 路由（v0.0.88 后单例路径）。

### 4.2 `POST /sse/subscribe` — 订阅 (topic, group, subId)

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/sse/subscribe` | 后端 `hub.sub(topic, group, listener)`，listener 收 event 转 SSE 帧携带 `subId` **广播所有 sinks**（不定向）；前端按 subId 过滤路由到 handler | `SubscribeBody` | `200` + `{ ok: true }` |

```typescript
interface SubscribeBody {
  topic: string;            // "agent_loop"（v0.0.8）/ "session_panel"（v0.0.12）/ "session_meta"（v0.0.27 加）
  group: string;            // "session_id:<sid>_amt:current"（v0.0.16：主对话 = `_amt:current`，forked = `_amt:<modeKey>`）/ "_all"（v0.0.27：session_meta 共享广播 group）
  /** [v0.0.88] 订阅唯一 id（前端 subscribe() 内部生成 ULID）；后端帧携带此 id 下行，前端按 id 路由到 handler。必填（旧客户端不传 → 后端生成 ULID 兜底）。**1 次订阅 = 1 个 sub id**——不用 component id，组件多订阅各生成独立 subId 不撞车。 */
  subId?: string;
}
```

**幂等**：同 (topic,group,subId) 重复订阅不重复登记（hub `subs` key=`${topic}:${group}` 去重；channel `subscribers` key=subId 去重）。同 (topic,group) 不同 subId 视为多订阅（channel `groupSubs[key] = Set<subId>`，refcount +1）。

> **[v0.0.12] session_panel topic**：放开 `session_panel` 订阅以收 `session_status_update`（运行态变更，见 `specs/tech/agent/session/[P0]session_event.md` §3）。前端进入会话时双订阅：`agent_loop:<sid>_amt:current`（流式消息，v0.0.16 加 `_amt:current` 主对话 mode）+ `session_panel:<sid>`（state/running/currentRunId 实时更新，session 级无 modeKey）。
>
> **[v0.0.27] session_meta topic（广播，会话列表订阅）**：放开 `session_meta` 订阅以收 `session_meta_update`（session 完整最新 meta 视图，承载「session 变了」的通知——含 unread 红点实时出现/消失、running/title/workspaceDir 等所有 meta 字段变更）。**[v0.0.55]** `summaryTask` 持久化字段从 Session 删除（compact 进度改由 SessionTaskLock 内存态承载）。**[v0.0.78.bug]** SSE `summary_task_update` 事件恢复推送（SessionTaskLock CAS 成功后 emit；此前 v0.0.55 误删导致 CompactBtn spinner 信号丢失）；`SessionMetaView.summaryTask` 字段恢复为 optional（broadcaster 不填，前端从单独事件取，见 specs/tech/agent/session/[P0]session_event.md §3a.3）。
> - **group = `_all`（共享广播 group）**：所有 session 的 meta 变更都 emit 到这一个 group；会话列表 subscribe `(session_meta, _all)` **一次**即收所有 session 的 meta。**非 per-session**。
> - **payload = `SessionMetaView`（全量最新态，非 diff）**：见 `specs/tech/agent/session/[P0]session_event.md §3a.3`（与 GET /session 返回 session 对象 shape 对齐，不含 transcript）。reducer 收到按 sessionId 整条替换。
> - **触发时机**：任何 session 状态 OR meta 变更（状态机 CAS / summary / usage / clear / setWorkspaceDir / markRead 经 statusBus wrap 捕获；markUnreadTrue runtime 自治直调 broadcaster）。全集见 `specs/tech/agent/session/[P0]session_event.md §3a.4` + `specs/tech/version_logs/v0.0.27/session-meta-broadcast-decision.md` §4。
> - **producer = session 层 `SessionMetaBroadcaster`**（状态机/agent-loop 不感知；复用 `wrapStatusBusForUnread` 泛化 fan-out + markUnreadTrue 直调 broadcaster）。详见 `specs/tech/app/frontend/[P0]sse_channel.md §10`。
> - **白名单**：`handlers/sse.ts` 的 `ALLOWED_TOPICS` 含 `'session_meta'`。
> - **replayable=false**：列表初始态靠挂载时 `GET /session` 拉全量；session_meta 只推订阅后增量，避免回放陈旧 meta 与刚拉的全量冲突。

### 4.3 取消订阅 — `DELETE /sse/subscriber/:subId`（v0.0.88 推荐）/ `POST /sse/unsubscribe`（向后兼容）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `DELETE` | `/sse/subscriber/:subId` | 后端 `SseChannel.unsubscribe(subId)`；refcount -1，归零才拆 hub 订阅（v0.0.88 新增，**推荐路径**） | 无（路径参数） | `200` + `{ ok: true }` |
| `POST` | `/sse/unsubscribe` | 同上；body 形式（向后兼容老客户端）；subId 可选（不传时取消该 (topic,group) 全部订阅者——仅测试用） | `UnsubscribeBody` | `200` + `{ ok: true }` |

```typescript
interface UnsubscribeBody {
  topic: string;            // 必填
  group: string;            // 必填
  /** [v0.0.88] 取消指定订阅（生产路径必填，推荐走 DELETE /sse/subscriber/:subId）；可选（仅测试，不传时取消该 (topic,group) 全部订阅者）。 */
  subId?: string;
}
```

**错误（subscribe/unsubscribe 共享）**：`400` body 非法 / topic 不存在（合法集合：v0.0.8 `agent_loop`、v0.0.12 加 `session_panel`、v0.0.27 加 `session_meta`）。

## 5. `GET /session/:id/summary` — 摘要只读端点（D2）

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/session/:id/summary` | 读 session 当前 summary（compact 后产生）；使 path D compact 可观测 | `200` + `{ summary: SummaryInfo \| null }` |

```typescript
interface SummaryInfo {
  version: number;
  summaryUpTo: string | null;   // 摘要覆盖到的最新 messageId（ULID）
  content: string | null;        // 压缩后的 summary 文本
  createdAt: string;
  updatedAt: string;
}
```

**行为**：
- session 无 summary（未触发过 compact）→ `summary: null`。
- compact 产生后由 `SessionStore.setSummary` 写入，本端点直接读回（只读，不触发 compact）。
- compact 触发逻辑在 `ContextEngine.compact`：`char × 1.0` 估算超 `contextWindow.tokenLimit` 时推进（详见 tech change_log §5）。

**错误**：`404` session 不存在；`405` 非 GET。

**用途**：path D（多轮→compact）的 AT/ET 通过本端点断言 compact 已发生（summary 非 null + summaryUpTo 推进），无需直接读 store。

> **[v0.0.13] compact 改 forked agent + summaryTask 状态**（**v0.0.55 废弃 summaryTask 字段，下面是历史描述**）：compact 不再裸调 `client.call`，改由 `forked-agent.ts` 轻量执行器执行（继承父 system prompt + 压缩任务作末尾 user message + NO_TOOLS=[]；无 session.state/run 记录/bus 副作用）。原 session 持有 `summaryTask` 单值字段（`{status:"idle"|"running"|"done"|"failed", runId?, startedAt?, error?}`，旁路 CAS 不干扰五态机）。**summaryTask 字段不直接暴露于 HTTP 响应**（GET /session 响应仅含 state/running/currentRunId）。**[v0.0.55]** summaryTask 字段已删除，CAS 改由内存 `SessionTaskLock`（per-session × per-task Map，不落盘）承担——见 §7 + `specs/tech/agent/session/[P0]session_task_lock.md`。

## 6. `GET /session/:id/usage` — 用量视图（v0.0.16 新增）

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/session/:id/usage` | 读 session 当前 usage 视图（ContextWindowUsage 7 字段 + 三分区 AccumulatedUsage + 派生 cacheRate），供 usage 面板初始展示 | `200` + `SessionUsageView` |

```typescript
// [v0.0.16] 键名对齐真行为（session-store-types.ts:177-190）：
//   简写键 current/sub/forked/total（非全称键）+ ratio + contextWindowUsage? + 4 cacheRate。
//   v0.0.14 起三分区真累加（v0.0.8-0.0.13 是空对象 + ratio=1.0）；v0.0.16 加 4 cacheRate 派生。
interface SessionUsageView {
  current: Record<string, number>;             // 当前会话主对话分区（modeKey=current 累加）
  sub: Record<string, number>;                 // 子 agent 上报分区（递归 sub 累加）
  forked: Record<string, number>;              // forked 旁路分区（compact 等）
  total: Record<string, number>;               // 三分区合计
  ratio: number;                               // char→token 估算比率（sliding window=3 取中位数，冷启动 1.0）
  contextWindowUsage?: ContextWindowUsage;     // 最近一次 assemble 的 context window 占用（v0.0.14 加；可空）
  // 派生字段（cacheRate，0-1 小数；UI 显示百分比；= input_cache_read / input_total_tokens，分母 0 返 0）
  currentCacheRate: number;
  subCacheRate: number;
  forkedCacheRate: number;
  totalCacheRate: number;
}

// 每个 Record<string, number> = AccumulatedUsage 字段集合（token+char+cost Σ + llmCallCount）：
//   { input_cache_read, input_cache_write, input_no_cache, input_total_tokens,
//     output_response, output_reasoning, output_total_tokens, total_tokens,
//     cost, inputCharCount, outputCharCount, llmCallCount }
// （Record 化而非对象强类型，对齐 store 通用序列化路径；字段集合权威见
//  `specs/tech/agent/session/[P0]session_usage.md §2` AccumulatedUsage 接口）

interface ContextWindowUsage {
  systemTokens: number;       // 系统 prompt token（char × ratio 估算）
  messageTokens: number;      // 消息 token
  toolTokens: number;         // 工具定义 token
  totalTokens: number;        // = system + messages + tools
  maxOutputTokens: number;    // 预留输出预算（默认 20000）
  tokenLimit: number;         // 模型 context window 上限
  remainingTokens: number;    // = tokenLimit − totalTokens − maxOutputTokens
}
```

> **[v0.0.16 spec drift 修正]** 原 spec 写全称键 `currentAgentAccumulatedUsage/subAgentAccumulatedUsage/forkedAgentAccumulatedUsage/totalAccumulatedUsage` 是设计期理想形态，代码实际返简写键 `current/sub/forked/total`（v0.0.14 起真行为，session-store-types.ts:177-190）。spec 对齐代码（代码是权威）。每个分区是 `Record<string, number>` 而非 `AccumulatedUsage` 强类型对象——store 序列化路径通用，字段集合权威在 `session_usage.md §2`。

**行为**：
- 调 `sessionStore.getUsageView(sid)` 读 SessionUsageMeta 三分区 + RatioWindow + contextWindowUsage 派生（详见 `specs/tech/agent/session/[P0]session_usage.md §8`）。
- 历史 record 缺字段（v0.0.8 老数据仅 3 字段）→ 内部 normalize 兜底补全（详见 `specs/tech/agent/context/[P0]context_snapshot_interface.md §2`）。
- 实时刷新由 SSE `session_usage_update` 推送（topic=`session_panel`，详见 §4.2 + session_event §3）—— 本端点仅作初始拉取。

**错误**：`404` session 不存在。

**用途**：usage 面板打开时 GET 一次拉全量，之后靠 SSE 增量刷新（AT 路径 U）。

---

## 7. `POST /session/:id/compact` — 手动触发 compact（v0.0.16 新增）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/session/:id/compact` | 手动触发 compact（fire-and-forget）；复用 forked agent 执行路径（`context_compact_detail §2`） | 空（无参） | `202` + `{ ok: true }` |

**触发条件**（caller 校验）：

| 当前态 | 行为 |
|---|---|
| `SessionTaskLock.getState(sid, 'compact').status === "running"` | `409` + `{ error: "compact_in_progress", message: "正在压缩中，请等待" }`（前端按钮 disabled） |
| 任何 `session.state`（idle/running/interrupting/interrupted/error）+ `SessionTaskLock.getState(sid, 'compact').status ∈ {idle, done, failed}` | 通过 → 调 compact 执行路径（fire-and-forget，立即返 202） |

> **[v0.0.55 modified；v0.0.78.bug SSE 恢复] compact 互斥改用统一 `SessionTaskLock`**：原 `summaryTask` 持久化字段 + `markSummaryRunning/Done/Failed` CAS 已废弃（被 `SessionTaskLock` subsumes）。新机制：内存 only，per-session × per-task CAS 锁（不落盘——客户端产品决策：磁盘锁=幽灵锁，重启自然清空）。HTTP 行为完全不变（409 `compact_in_progress` + 触发条件 + 响应体一致）；仅内部 409 判定改读 `SessionTaskLock.getState(sid, 'compact').status`。**[v0.0.78.bug]** SessionTaskLock 在 CAS 成功后 emit `summary_task_update` 到 session_panel topic（v0.0.55 误删的 SSE 推送恢复；前端零改动）。详见 `specs/tech/agent/session/[P0]session_task_lock.md` + `specs/tech/version_logs/v0.0.55.memory_ui_session_lock/change_log.md` + `specs/tech/version_logs/v0.0.78.bug/change_log.md`。
>
> **[v0.0.54.compaction] 简化原则（用户拍板）**：任何 session 任何时间都能 compact，除非 compact 正在跑（compact 互斥由 `SessionTaskLock` 检查 + 内部 `acquire('compact')` CAS 双保险保证）。之前的 `session.state === "running" → 409 session_running` / `session.state === "interrupting" → 409 session_interrupting` 已删除——它们违反"subagent 防爆炸必须随时可 compact"原则。
>
> **双保险语义（[v0.0.55] 统一锁后）**：接口层 `SessionTaskLock.getState('compact').status` 检查（reject `running`）+ 内部层 compact runner `lock.acquire('compact', runId)` CAS（state ∈ {idle,done,failed} → running 原子切换，并发抢不到者跳过）——两层独立防护 compact 互斥；session.state 不再参与（forked agent 不碰 session.state/Run，与主对话 AgentLoop 在写 buffer 上正交）。
>
> **[v0.0.54] subagent 允许 compact**：本端点不再对 `session.type === "subagent"` 返 403 `subagent_readonly`——subagent 长跑上下文也会爆炸，**必须支持** compact（手动 + 自动均走同一 forked agent 路径）。其他 subagent readonly 限制（POST messages/abort/clear）不变（详见 `10-multi-agent.md §4.3`）。

**行为**（详见 `specs/tech/agent/context/[P0]context_compact_detail.md §2b`）：
1. 校验触发条件（上表）。
2. **[v0.0.158] SessionConfig 组装收敛为唯一入口**：`config = await deps.agentManager.resolveConfigBySid(sid)`（chat/compact 同链，无 `task` 参数、无 summary 子链——见 `../providers_and_models/[P0]model_resolve.md §3/§5.1`）；resolve 跑空 → catch `ModelNotConfiguredError` 返 400 `{code:"MODEL_NOT_CONFIGURED", message, detail:{sessionType}}`；ProviderNotFound / ModelNotFound → 400。handler 从 ~90 行瘦到 ~30 行（旧版 v0.0.157 及之前直调 `buildSessionConfigFromDeps(..., task='summary', ...)` 独立支路已删）。
3. 调 compact 执行路径：`SessionTaskLock.acquire(sid, 'compact', runId)` → forked agent（继承 system + NO_TOOLS）→ setSummary + accumulateUsage('forked') write → `SessionTaskLock.markDone/markFailed(sid, 'compact', ...)`（见 context_compact_detail §2）。**[v0.0.81]** 不再 appendMessages(compact_notice)（system notice 已退役，summary 改 role=user message 落库，详见 context_compact_detail §6）。
4. 端点本身**异步**，不 await compact 完成；返回 202 即视为已接收（fire-and-forget：`void deps.contextEngine.compact(config).catch(log)`）。
5. **[v0.0.78.bug] SSE `summary_task_update` 已恢复**（v0.0.55 随 summaryTask 持久化字段一并误删——UX 回归：CompactBtn spinner 信号丢失。v0.0.78.bug 修复：SessionTaskLock CAS 成功后经注入的 sessionStatusBus emit `summary_task_update` 到 `(session_panel, session_id:<sid>)`；前端 CompactBtn 已就绪的 SSE 订阅零改动恢复 spinner 渲染）。spec 契约不变（见 §10 路径 T），仅 emit 入口从 SessionStateMachine 迁到 SessionTaskLock。

**返回语义**：
- `202 Accepted` + `{ ok: true }` = 服务端已接收触发请求、compact 异步执行中。
- `409` + `{ error, message }`（`compact_in_progress`，唯一 409 错误码）= 不满足触发条件，`message` 为用户可读友好提示。

**幂等 / 并发**：
- compact 进行中再点 → 409 `compact_in_progress`（前端按 SessionTaskLock 状态 disabled 按钮，无重复触发）。
- 任何 `session.state`（含 running/interrupting）时点 → 202 放行（compact 互斥由 SessionTaskLock + CAS 保证，与 session.state 正交）。

**请求示例**：

```bash
curl -X POST http://127.0.0.1:3710/session/01KV.../compact
# → 202 {"ok":true}
```

**错误**：`404` session 不存在；`405` 非 POST。

> **[v0.0.81 修订]** compact 成功后不再插 `role=system` compact_notice message（system notice 退役），summary 作为 `role=user` message 落库（详见 context_compact_detail §6 + chat-page/component-usage-panel.md）；前端不再渲染居中 pill。

---

## 8. `POST /session/:id/clear` — 清空会话（v0.0.16 新增）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/session/:id/clear` | 清空 session 所有内容（保留实体），同步原子 | `ClearBody?`（可选） | `200` + `{ ok: true, session: Session }` |

```typescript
interface ClearBody {
  force?: boolean;       // 可选，默认 false；true 时跳过 abort 收尾直接强制清空（调试 / 紧急清理用）
}
```

**行为**（详见 `specs/tech/agent/session/[P0]session_clear.md`）：
1. **force=false（默认）前置并发清理**：
   - 若 `session.state ∈ {running, interrupting}` → `POST /session/:id/abort`（4 步收尾，runId+modeKey="current"）→ 等 state 转 interrupted（poll 100ms × N，超时 fallback 强制清空）。
   - **[v0.0.55] compact 任务清理改 SessionTaskLock**：若 `SessionTaskLock.getState(sid, 'compact').status === "running"` → `SessionTaskLock.markFailed(sid, 'compact', 'cleared')` + 清 forked agent buffer（`bus.clearReplay(session_id:${sid}_amt:summary)`）。原 `markSummaryFailed` 调用替换；语义不变（compact 任务被中断标 failed）。
2. `sessionStore.clearSession(sid)`（单事务清空 §3 全部范围：transcript / summary / runs / usage 三分区 + RatioWindow + contextWindowUsage / state=idle）。`tokenLimit` 保留（来自 modelConfig，非累加值）。**[v0.0.55]** summaryTask 字段已删（不进 clear 范围；compact 锁在内存，clear 不动）。
3. emit 事件：
   - `session_status_update`（state=idle, running=false, currentRunId=null）。
   - `session_usage_update`（零 SessionUsageView）。
   - `messages_cleared`（前端清对话区，避免逐条 message_deleted）。
4. **同步返 200**（不 fire-and-forget——clear 是用户感知即时完成操作）+ 返回重置后的 Session。

**清空范围**（`session_clear.md §3` 详）：

| 范围 | 清理后 |
|---|---|
| transcript（含 raw/tool_result） | 空 `[]` |
| summary | `{version:0, summaryUpTo:null, content:null}` |
| runs | 空 `[]` |
| usage 三分区（current/sub/forked） | 全零 AccumulatedUsage |
| usage.RatioWindow | `{samples:[], current:1.0}`（冷启动） |
| usage.contextWindowUsage | 零占用（tokenLimit 保留） |
| session.state / running / currentRunId | `idle` / `false` / `null` |
| **session.id / title / status / config / createdAt / parentSessionId** | **保留**（不变） |

**force 语义**：
- `force=true`：跳过 §1 abort 收尾，直接 `clearSession(sid)` + 重置 idle。用于调试 / 紧急清理；生产路径不用（前端按钮不暴露 force 选项）。

**返回语义**：
- `200` + `{ ok: true, session: Session }` = 清空完成（同步原子）；前端据返回 Session 更新本地状态。
- session 不存在 → `404`。

**请求示例**：

```bash
curl -X POST http://127.0.0.1:3710/session/01KV.../clear \
  -H "Content-Type: application/json" \
  -d '{}'
# → 200 {"ok":true,"session":{"id":"01KV...","title":"Auth 模块安全审查","state":"idle","running":false,"currentRunId":null,...}}
```

**错误**：`404` session 不存在；`405` 非 POST；`400` body 非法 JSON。

> clear 是「保留 session 清内容」语义，区别于 `DELETE /session/:id`（删整个 session）。前端用确认 modal 防误操作（详见 chat-page/component-usage-panel.md）。

---

## 9. 错误码汇总

| HTTP | 场景 |
|------|------|
| `400` | 非法 JSON / 字段缺失 / 校验失败 / `providerId` 不命中 / **[v0.0.102] `model_not_configured`**（session.modelId=default 但 `default_models.chat` 未配 → `{code, message, detail:{sessionType}}`；error shell 路径识别 `agentRun.error instanceof ModelNotConfiguredError`，详见 §3.2）**[v0.0.158] `detail.task` 字段已删**（chat/compact 同链后 task 概念不存在）|
| `404` | session 不存在 |
| `405` | `/session/:id/summary` 非 GET / `/session/:id/compact` 非 POST / `/session/:id/clear` 非 POST |
| `409` | `POST /session/:id/compact` 在 compact 进行中（`compact_in_progress`，**[v0.0.54.compaction] 唯一 409**——session.state 不再拦截） |
| `500` | server 内部错误（EventBus / SessionStore / AgentManager 异常）/ **[v0.0.102]** activate 失败但非 ModelNotConfigured（session not found 兜底 / buildMainDeps throw）—— `resolveErrorRunResult` 兜底 500 `{error: 'activate failed for runId: ...'}` |

> **[v0.0.12] 移除 `409`（messages 路径）**：「session 已有 run 在跑」不再报错——running/interrupting 时发消息走 enqueue 排队（返 202），interrupting 时 activate 循环等待（见 §3.2）。**[v0.0.16] 409 仅在 `/compact` 端点恢复**（compact 并发拒绝语义）。

## 10. AT 覆盖映射

| 路径 | 端点组合 |
|------|---------|
| A：新建会话→发消息→纯文本回复 | `POST /session` → `POST /sse/subscribe` → `POST /session/:id/messages` → `GET /sse`（断言 run 序列 + `run_end` `stopReason=no_tool_call`） |
| B：发消息→调工具→result 回灌→续答 | `POST /session/:id/messages` → `GET /sse`（断言 `tool_call_*` / `tool_result_*` 序列 + 续 `message_start`） |
| C：run 异常→error 事件 | 注入 error → `GET /sse` 断言 error 事件 + `run_end` `stopReason=error` + `GET /session/:id` state=error。**[v0.0.25]** error 事件新增可选 `errorCategory` 字段（`LlmErrorCategory` 枚举值，向后兼容旧 caller 读 `message`）；不再塌缩 `LOOP_ERROR`，按真实 category 上抛。**[v0.0.25 rev2]** error 事件再扩可选 `displayReason`（用户可读）+ `errorDetail`（raw provider message）；`run_end` 前可能先发若干 `llm_attempt` event（per-attempt retry/fallback 进度，action ∈ retry/switch_key/switch_provider/bump_max_tokens/FAIL，FAIL 后紧跟 error）；**[v0.0.59 corrected]** `GET /session/:id` 响应 `currentRun.error` **仅在 `state=running` 且 `currentRunId≠null` 时存在**——`state=error` + eager-drain（currentRunId=null）时响应**无 currentRun/error 字段**，AT 应改读 SSE error 事件（流中实时）或 history run 的 `RunRecord.error`（落库）；forked 旁路（compact 等）不落 RunRecord，error 仅在 SSE/log；ABORTED_BY_USER 走 interrupted 不填。**[v0.0.59 corrected]** LlmErrorCategory 实测 **18 值**（不是 19——`app/server/src/llm/caller/display_reason.ts` 的 `DISPLAY_REASON_TABLE` 当前 18 行，`MAX_TOKENS_TOO_HIGH` 只出现一次）。详见 `02-llm-chat.md` §1 [v0.0.25 rev2 modified] + `specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md` |
| D：多轮→compact | 触发 char 估算超阈值 → `GET /session/:id/summary` 断言 summary 非 null + summaryUpTo 推进 |
| E：打开旧会话→分页续载 | `GET /session/:id/messages?limit=50` → `GET .../messages?beforeId=<id>&limit=50` → 断言 `hasMore` 切换 |
| F：跨消息边界工具合并 | （ET 主覆盖；AT 可断言 SSE `tool_call` 事件跨两条 assistant message） |
| **G（v0.0.12）：中断 run** | `POST /session/:id/messages` → run 中 → `POST /session/:id/abort`（202）→ `GET /sse` 断言 `run_end` `stopReason=interrupted` + `GET /session/:id` state=interrupted + currentRunId=null |
| **H（v0.0.12）：running 时排队** | run 中 → `POST /session/:id/messages`（202，不报 409）→ 消息进 enqueue view → run 结束后被消费 → `GET /session/:id/messages` 断言两条 user 消息顺序落库 |
| **I（v0.0.12）：interrupting 循环等待** | run 中 → `POST /session/:id/abort`（进入 interrupting）→ 立即 `POST /session/:id/messages`（202，activate 循环等待）→ abort 收尾完成 → 新 run 激活消费 → 断言 `[partial(interrupted) ... 新query]` 顺序 |
| **J（v0.0.12）：崩溃恢复** | 构造 running/interrupting session（改 store）→ 重启 server → `GET /session/:id` 断言 state=idle + currentRunId=null + Run.status=interrupted |
| **K（v0.0.12）：enqueue cancel** | 发 q1/q2（`activate=false`，留 inbox）→ `POST /session/:id/messages/:enqueueId1/cancel`（202，同步移除 q1 + emit canceled）→ 发 q3（`activate=true`，drain 消费 q2+q3）→ drain 后第 1 条 emit `enqueued_message_canceled`、不落库；q2/q3 正常 processed 落库 → `GET /session/:id/messages` 断言只有 q2/q3 |
| **L（v0.0.13）：长对话→compact（forked agent）** | 真 LLM 多轮 → 触发 compact → `GET /session/:id/summary` 断言 summary 非 null + summaryUpTo 推进；`GET /session/:id/messages` 继续正常（compact 无副作用） |
| **M（v0.0.13）：enqueue 处理后清理（S5 回归）** | run 中连发 N 条（POST /messages 返 enqueueId）→ drain 逐条处理 → `GET /session/:id/messages` 断言仅含落库消息（无残留 enqueue 项） |
| **O（v0.0.13）：session 状态变化→前端实时收到** | `POST /sse/subscribe`（topic=session_panel）→ 触发 running / interrupting / interrupted → `GET /sse` 断言收到 `session_status_update` 序列（每态一帧） |
| **Q（v0.0.13；v0.0.55 重定向）：app 重启→compact 执行中态清理** | **v0.0.55**：构造 `SessionTaskLock` running 状态（在内存 Map 注入）→ 重启 server → 内存自然清空（不落盘=全部释放）→ `GET /session/:id` 断言 state 非 running + `GET /session/:id/summary` 可读。原 v0.0.13 路径基于持久化 `summaryTask` 字段已废弃 |
| **R（v0.0.16）：usage 初始拉取** | `GET /session/:id/usage`（200）→ 断言返回 `SessionUsageView`（含 ContextWindowUsage 7 字段 + 三分区 AccumulatedUsage + 4 个 cacheRate 派生字段） |
| **S（v0.0.16）：多轮→SSE session_usage_update** | `POST /session/:id/messages`（触发真 LLM 多轮）→ `GET /sse`（topic=session_panel）断言收到 `session_usage_update` 序列 + `GET /session/:id/usage` 字段非零 |
| **T（v0.0.16；v0.0.78.bug SSE 恢复；v0.0.81 修订）：手动 compact → summary 落库** | `POST /session/:id/compact`（202）→ `GET /sse` 断言收到 `summary_task_update`(running→done) → `GET /session/:id/summary` 断言 summary 非 null（[v0.0.81] 不再断言 system compact_notice message——已退役，summary 改 role=user message 落库）。**注**：v0.0.55 一度误删 `summary_task_update` SSE，v0.0.78.bug 由 SessionTaskLock bus 注入恢复推送（契约不变，前端零改动）。 |
| **U（v0.0.16；v0.0.55 锁语义不变）：手动 compact 并发拒绝** | 触发 compact（`SessionTaskLock.acquire(sid,'compact')` 返 true → status=running）→ 立即 `POST /session/:id/compact` → 断言 409 `compact_in_progress`（行为与 v0.0.16 一致，仅内部锁机制由 summaryTask 改 SessionTaskLock） |
| **V（v0.0.16）：clear 清空 → empty-state + usage 归零** | `POST /session/:id/clear`（200）→ 断言返回 session state=idle + `GET /session/:id/messages` 返空 + `GET /session/:id/summary` 返 null/初始 + `GET /session/:id/usage` 返零 SessionUsageView |
| **W（v0.0.16）：running 中 clear → 先 abort 再 clear** | 构造 session running → `POST /session/:id/clear`（200）→ 内部 abort（state→interrupted）+ clear → `GET /session/:id` state=idle + currentRunId=null + `GET /session/:id/messages` 返空 |
| **X（v0.0.27）：未读产生（后台完成）** | session A 发消息触发 run → 切到 session B（unsubscribe A 的 session_panel）→ A 的 run 完成（状态机 markIdle CAS 成功 → emit session_status_update(state=idle) → **session 层**（非 agent-loop）订阅到 completion 信号，查 isSessionActive(A)=false → CAS `unread: false→true`）→ `GET /session` 断言 A.unread=true |
| **Y（v0.0.27）：未读消除（用户标读）** | 承接 X（A.unread=true）→ `POST /session/A/read`（CAS `unread: true→false` + emit session_read_update）→ 响应 session.unread=false → `GET /session` 断言 A.unread=false |
| **Z（v0.0.27）：前台完成不产生未读（no-op）** | session A 发消息触发 run → **保持在 A**（subscribe session_panel:A 持续）→ A 的 run 完成（markIdle → session 层收到 completion 信号后查 isSessionActive(A)=true → no-op，既不置 true 也不置 false）→ `GET /session` 断言 A.unread=false（前提：进入 A 时已 POST /read 清零；若未清，保持进入前的值）|
| **X'（v0.0.27）：未读产生不发事件** | 承接 X：A 的 run 完成产生 unread=true，期间 `GET /sse`（topic=session_panel, group=session_id:A）**不**收到 session_read_update（产生不发事件，因用户未订阅 A 的 panel；list 拉取可见即可）|

## 11. 文件变更清单

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/router.ts` | 修改 | v0.0.8：删 `/chat`；新增 `/session*` CRUD + `/session/:id/messages` + `/session/:id/summary` + `/sse*`。**v0.0.12**：新增 `POST /session/:id/abort` + `POST /session/:id/messages/:enqueueId/cancel`。**v0.0.16**：新增 `GET /session/:id/usage` + `POST /session/:id/compact` + `POST /session/:id/clear` 路由分发 |
| `app/server/src/handlers/chat.ts` | 删除 | v0.0.8：无 session 旧 `POST /chat` 整体作废 |
| `app/server/src/handlers/session.ts` | 修改 | v0.0.8 新增 `SessionHandler`。**v0.0.12**：Session 响应加 state/running/currentRunId；abort handler；cancel handler。**v0.0.16**：新增 `getUsage` handler（调 `sessionStore.getUsageView`，返 SessionUsageView 含 cacheRate）、`compact` handler（校验触发条件→调 ContextEngine.compact 执行路径，202 fire-and-forget，409 拒绝 running/interrupting）、`clear` handler（前置 abort+markSummaryFailed→调 sessionStore.clearSession→emit events，200 同步） |
| `app/server/src/handlers/sse.ts` | 新增 | v0.0.8：`SseHandler`（`GET /sse` + subscribe/unsubscribe） |
| `app/server/src/session-store.ts` | 修改 | **v0.0.16**：新增 `clearSession(sid)` 方法（单事务清空 transcript/summary/runs/usage/summaryTask/state，保留实体 + tokenLimit）；`getUsageView` 增 cacheRate 派生字段；`updateContextWindowUsage` normalize 旧 record 补全 7 字段 |
| `app/server/src/context-engine.ts` | 修改 | **v0.0.16**：assemble 改读 `session.getRatio(sessionId)`（不再硬编码 1.0）；compact 触发算式补 `− maxOutputTokens`（**[v0.0.81]** compact 不再 appendMessages(compact_notice)，summary 改 role=user message 落库） |
| `app/web/src/slices/chat-slice-reducer.ts` | 修改 | **v0.0.16**：处理 SSE `session_usage_update` / `summary_task_update` / `messages_cleared` 事件，更新 usage 面板状态 |
| `app/server/src/handlers/session.ts` | 修改 | **v0.0.27**：新增 `POST /session/:id/read` handler（**消除未读=session 层**：调 `SessionUnreadOps.markRead(sid)` CAS `unread: true→false` + 返 Session）；`GET /session/:id` **删隐式 markRead**（保持纯读）；`GET /session` / `GET /session/:id` 响应 Session 序列化加 `unread: boolean`（直接返回存储值，非派生）；删 lastReadAt 字段 |
| `app/server/src/session-store.ts` | 修改 | **v0.0.27**：Session schema 加 `unread: boolean` 字段（持久化，默认 false）；保留 `SessionUnreadOps.markRead/markUnreadTrue`（session 层模块，CAS `unread=true/false`）；markIdle/markError SQL **不**含 unread 写（解耦，由 session 层订阅者自治 CAS） |
| `app/server/src/agent/session-unread-runtime.ts`（或 bootstrap 接线处，**session 层**） | 新增 | **v0.0.27**：session 层订阅者——subscribe statusBus `session_panel`/`session_id:<sid>`，on `session_status_update` 过滤 `state∈{idle,error}`（+ reconcile 豁免，识别 run 终态=interrupted 跳过）→ 调 `sseChannel.isSessionActive(sid)`：**false**（不在前台）→ `SessionUnreadOps.markUnreadTrue(sid)` CAS `unread: false→true`（产生未读）；**true**（在前台）→ no-op |
| `app/server/src/agent/agent-loop.ts` + `agent-manager.ts` | 修改 | **v0.0.27**：**删除** `maybeMarkUnread()` 调用 + `sseChannel`/`SessionPresenceProbe` 注入 + `setSseChannel` 透传——agent-loop 还原原始职责（run 收尾只调 `markIdle`/`markError`，不查前台、不写 unread）。产生未读改由 session 层订阅者（上一行）自治 |
| `app/server/src/agent/session-state-machine.ts` | （零改动） | **v0.0.27**：状态机继续 emit `session_status_update`（v0.0.12 既有行为，每次 CAS 成功后已 emit），不知 unread/SSE/前台。session 层订阅此 event 作为 completion 信号 |
| `app/server/src/handlers/sse.ts`（SseChannel） | 修改 | **v0.0.27**：SseChannel 加 `isSessionActive(sid): boolean` 方法（查 subs Map `session_panel:session_id:<sid>`；**消费方从 agent-loop 改到 session 层**，实现不变）。**v0.0.27 meta**：`ALLOWED_TOPICS` 加 `'session_meta'`（放开广播 topic 订阅） |
| `app/server/src/bootstrap.ts` | 修改 | **v0.0.27 meta**：`hub.registerTopic('session_meta', new ReplayableEventBus({ replayable: false }))`（复用 hub 只加 topic）；`SessionMetaBroadcaster` 实例化 + 注入 wrap（泛化 `wrapStatusBusForUnread` 同时 fan-out 给 `SessionUnreadRuntime` 和 broadcaster）；reconcile 期间豁免与 unreadRuntime 一致 |
| `app/server/src/agent/session-meta-broadcaster.ts` | 新增 | **v0.0.27 meta**：session 层 producer——持 `crud`（读最新 record）+ `sessionMetaBus`（emit 到 `_all`）；方法 `broadcast(sessionId)` 读最新 record → 组装 `SessionMetaView` → emit `session_meta_update` 到 `(session_meta, _all)`。状态机/agent-loop 不感知 |
| `app/server/src/agent/session-unread-runtime.ts` | 修改 | **v0.0.27 meta**：`wrapStatusBusForUnread` 泛化为同时 fan-out 给 `SessionUnreadRuntime` 和 `SessionMetaBroadcaster`（statusBus emit 入口对任何 SessionEvent → `broadcaster.broadcast(event.sessionId)`）；`SessionUnreadRuntime.handleSessionEvent` 在 `markUnreadTrue` CAS 成功后直接调 `broadcaster.broadcast(sid)`（产生路径 runtime 自治直调） |
| `app/server/src/agent/session-event-types.ts` | 修改 | **v0.0.27 meta**：新增 `SessionMetaUpdateEvent` 接口 + `SessionMetaView` 类型（对齐 GET /session 返回 shape，见 session_event.md §3a.2/§3a.3） |

> **v0.0.12 / v0.0.16 server 内部实现细节**（不在本契约文件展开）：SessionStateStore 引入、`reconcileOnStartup` bootstrap 钩子、abort 4 步收尾链路——详见 `specs/tech/agent/session/[P0]session_state.md` + `specs/tech/agent/agent_interface_and_loop/[P0]agent_interrupt.md` + `specs/tech/version_logs/v0.0.12/change_log.md` + `specs/tech/version_logs/v0.0.16/change_log.md`。

## 13. Test-only 端点（NODE_ENV=test gate — 绝不进 prod surface）[v0.0.120][v0.0.190 modified]

> **安全门禁**：以下端点仅在 `NODE_ENV=test` 时可用（router 层 + handler 内二次 gate）。非 test 环境 → 404。生产构建**零代码路径**，不进 prod surface。

**[v0.0.190] 已删除**：`POST /test/llm-mode` + `POST /test/llm-mode/commit`（+ 从未进本契约的 `/test/stub*` 系列）随 AT record/replay 基建整体删除（`app/server/src/testing/` 整目录 + `misc-routes.ts` 对应路由块）——AT 改真实调 API 不再录制/回放，不再需要 per-case LLM 模式切换与 commit flush。原契约文本见本文件 git 历史 + `specs/api/version_logs/v0.0.190/change_log.md`。

### 13.1 `POST /test/consolidation/run` — test-only 同步触发 t2 整理（保留）

AT 可测性补充端点（v0.0.151.t2_consolidate 引入，v0.0.190 保留）：同步跑一次 `runConsolidationTier2` 并 await 到完成，不经调度器（SchedulerEngine 天级 cron 到点粒度 AT 等不起）。

| 方法 | 路径 | 前置条件 | 语义 |
|------|------|---------|------|
| `POST` | `/test/consolidation/run` | `NODE_ENV=test`（router + handler 双重 gate） | 同步触发 `runConsolidationTier2(deps)`，await 完成后返完整结果 |

**请求体**：无（空 body）——不接受任何覆盖 `app_config.consolidation` 的参数（本端点只读现有 config，非隐藏配置入口）。

**响应** `200`（同步，非 202）：`{ globalSkill, globalMemory, sessions[], ... }`（各段 action/result/detail）。**完整请求/响应契约**见 `specs/api/version_logs/v0.0.151.t2_consolidate/change_log.md`；架构落点 `specs/tech/scheduling/[P1]consolidation_job.md` §7。

**约束**：
- 不动 `Job.lastFiredAt`（真实调度锚点，测试触发推进会静默扰动真实 job 下次到点计算）；会写 `lastResult`（AT「seed → 触发 → 断言 status」需看到本次结果）
- `404` — 非 test 环境（router gate + handler 二次 gate）

---

## 12. 版本

version: 2.7（v0.0.271 修订：§2.6.5 新增 `POST /session/:id/workspace/watch-set`（声明式替换该 tab 关注集合，body `{ clientId, paths: string[] }` 完整集合非增量，后端 diff 增删 + 不在新集合一律 close；paths 逐元素白名单校验，穿越 400 / 不存在静默跳过；缺 clientId 400；realRoot = realpathSync(workspaceDir) 三端点共用）。watch/unwatch 增量保留兼容（release-all 仍用），新前端不再调单 path。权威模型 `specs/tech/agent/session/[P0]session_workspace_manager.md`（v0.0.271 关注集合升级）+ 前端接线 `component-workspace-panel.md §4.3`）。2.6（v0.0.231 修订：§2.1 Session 增 `pinned: boolean`（lazy 默认 false，无 migration）；§2.5 UpdateSessionBody 增 `pinned?: boolean`（非 boolean → 400，写后 metaBroadcaster.broadcast 多端归位；**pinned-only 更新不推进 updatedAt**——置顶是纯标记，用户裁决 2026-08-01）。置顶分组 = 前端展示层归位，GET /session 顺序契约不变。详见 `specs/tech/version_logs/v0.0.231/change_plan.md` + `specs/api/version_logs/v0.0.231/change_log.md`）。2.5（v0.0.192.delete_cleanup 修订：§2.4 `DELETE /session/:id` 加级联删子孙语义——删 parent 前先 `collectDescendants(id)` BFS 快照全部子孙 session（任意深度，基于 childrenIndex），子孙先删（每触发 `onSessionDestroyed` → 清内存 cron，堵潜伏调度）、parent 最后删；recycleSession/disconnect 仍仅 parent 维度（tab/连接器是 parent 维度，子孙无独立 tab）。堵「删 parent 后 child cron 继续烧 token」漏洞；机制不变（onSessionDestroyed 行为同 scheduling KB §8），只让级联路径每 descendant 走一次 deleteSession。详见 `specs/tech/version_logs/v0.0.192.delete_cleanup/change_plan.md`）。2.4（v0.0.190 修订：§13 Test-only 端点组删 `POST /test/llm-mode` + `/test/llm-mode/commit`——AT record/replay 基建整体删除（`app/server/src/testing/` 整目录 + misc-routes 路由块），对齐 v0.0.188 ET 真实跑范式；保留的 `POST /test/consolidation/run` 补入 §13.1。生产零影响（删除端点全 NODE_ENV=test 门控）。详见 `specs/api/version_logs/v0.0.190/change_log.md`）。2.3（v0.0.139 修订：workspace watcher 懒监听重构——§2.6.5 新增 `POST /session/:id/workspace/watch` + `/unwatch`（tab `clientId` + `path` 显式 acquire/release，一层非递归监听，幂等，`path` 省略=release-all-for-tab）；§2.5 切目录副作用 stop→set→start 改 `switchDir`=recycleSession→setDir（不重启，前端重新 watch 新根）；§2.4 DELETE 副作用 `stopWatch`→`recycleSession`。权威模型 `specs/tech/agent/session/[P0]session_workspace_manager.md`（v0.0.139 重写）+ 前端接线 `component-workspace-panel.md §4.3`）。2.2（v0.0.31 修订：§3.2 POST /messages 加「[v0.0.31·代码已落地]」注——内部从裸 enqueue(config)+activate(config) + buildSessionConfigFromDeps 收敛为 manager.deliverTo(sessionId, userMsg)（manager 内部 resolveConfigBySid 获取 config）；sender 形态对齐判别联合 `{source:'user'}`（无 agentName/agentId 扁平残留）；HTTP 契约不变（仅内部实现收敛 + 落库 message.sender 形态变化）。详见 `specs/api/version_logs/v0.0.31/change_log.md §3.2`）。2.1（v0.0.27 新增 `session_meta` 广播 topic——§4.2 SubscribeBody topic 注释加 `session_meta` / group 注释加 `_all` + 新增「[v0.0.27] session_meta topic（广播，会话列表订阅）」段（group=`_all` 共享广播 / payload=`SessionMetaView` 全量最新态 / 触发时机全集引用 / producer=session 层 `SessionMetaBroadcaster` / 白名单含 session_meta / replayable=false）；§4.3 错误合法集合加 session_meta；§11 文件变更清单新增 v0.0.27 meta 4 项（handlers/sse.ts ALLOWED_TOPICS 加 session_meta / bootstrap.ts registerTopic session_meta + broadcaster 装配 / 新建 session-meta-broadcast/session-meta-broadcaster.ts / session-unread-runtime.ts wrap 泛化 + markUnreadTrue 直调 / session-event-types.ts 加 SessionMetaUpdateEvent + SessionMetaView）。详见 `specs/tech/version_logs/v0.0.27/session-meta-broadcast-decision.md`）。2.0（v0.0.27 二次修订：**产生未读归属层**从「agent-loop」改为「**session 层**」自治——§2.3.1 step 5 注释 / §10 AT 路径 X/Z 措辞 / §11 文件变更清单全部同步：§11 删除「agent-loop.ts markIdle/markError 后调 isSessionActive + CAS unread」条目，新增「**session-unread-runtime.ts（session 层订阅者）**：订阅 session_status_update completion 信号 → 查 isSessionActive → CAS unread」+「agent-loop.ts/agent-manager.ts 删除 maybeMarkUnread + sseChannel/SessionPresenceProbe 注入（还原原始职责）」+「session-state-machine.ts 零改动（继续 emit session_status_update）」+「SseChannel.isSessionActive 消费方从 agent-loop 改到 session 层（实现不变）」。保留 explicit-bool / GET 纯读 / POST /read 唯一消除 / CAS 幂等不动）。1.9（v0.0.27：watermark→explicit-bool）。1.8（v0.0.25 rev2 修订：SSE error 事件再扩可选 `displayReason`+`errorDetail`（rev1 已加 `errorCategory`）；新增 `llm_attempt` SSE event（per-attempt retry/fallback 进度）；`GET /session/:id` 响应 `currentRun.error` / 历史 run error 携带 `RunErrorInfo = { errorCategory, displayReason, errorDetail? }`（eager-drain 落 RunRecord；ABORTED_BY_USER 走 interrupted 不填）；LlmErrorCategory 17→19 值（+MAX_TOKENS_TOO_HIGH/EMPTY_RESPONSE）。§10 路径 C 更新；详见 `02-llm-chat.md` §1 [v0.0.25 rev2 modified] + `specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md`）。1.7（v0.0.17 修订：§2.1 workspaceDir 初始策略补 BUG-001 修复（caller 在 body 提供 workspaceDir 时校验 abs + exists + isDir 通过后用该值，**不**强制默认路径；缺省仍自动建 `<DATA_DIR>/workspaces/<sid>`）；新增 §2.6.4 `/api/workspace/*` ET seed 端点（test-only，NODE_ENV=test gate，非 test 404；3 个端点 ensure-dir / touch / ensure，仅供 ET seed fs；ensure 放宽白名单专供 switch_tc1 flow）。详见 `specs/api/version_logs/v0.0.17/change_log.md`）。1.6（v0.0.17 修订：§2.6.1 `GET /session/:id/workspace/tree` 改 lazy 加载——加 query param `parent?`（相对路径，缺省顶层）+ `depth?`（缺省 1，仅一层）；响应 `WsTreeNode` 用 `hasChildren` 替代 `children?`（不递归）；响应加 `parent: string|null` 字段；安全校验 `parent` resolve 后必须在 workspaceDir 内（防穿越）；§2.6.1 错误码加 400 parent 非法/depth 越界。详见 `specs/api/version_logs/v0.0.17/change_log.md`）。1.5（v0.0.17：§2.1 `CreateSessionBody` 加 `workspaceDir?`（缺省自动建 `<DATA_DIR>/workspaces/<sid>`）+ `Session` 响应加 `workspaceDir: string` 字段；新增 §2.5 `PUT /session/:id`（切换 workspaceDir，stop→set→start 顺序保证）；新增 §2.6 Workspace 端点组（`GET /session/:id/workspace/tree` + `POST /session/:id/workspace/open`（路径白名单防穿越）+ `POST /session/:id/workspace/pick-directory`（系统原生 dialog，支持新建文件夹））；§2.4 DELETE 触发 stopWatch。详见 `specs/api/version_logs/v0.0.17/change_log.md`）。1.4（v0.0.16：新增 `GET /session/:id/usage`（§6，返 SessionUsageView 含 ContextWindowUsage 7 字段 + 4 个 cacheRate 派生字段）+ `POST /session/:id/compact`（§7，手动触发 fire-and-forget 202，409 拒绝 running/interrupting）+ `POST /session/:id/clear`（§8，同步原子 200，前置 abort+markSummaryFailed）；§9 错误码表恢复 409（仅 compact 路径）；§10 新增 AT 路径 R-W；§11 文件变更清单补 v0.0.16 entries）。1.3（v0.0.16：§3.3 `POST /session/:id/abort` 请求体新增 `runId` + `modeKey` 必填；响应新增 `accepted: boolean` 区分真实中断与幂等 no-op；三参数缺一不可；新增请求示例）。1.2：v0.0.12 补 design 板块 3.4 cancel。1.1：v0.0.12 修订（Session 响应加 state/running/currentRunId；新增 abort；enqueue 排队 + interrupting 循环等待；移除 409）。1.0：v0.0.8 新建）。
> **v0.0.27 归属层决策史**：(1) agent-loop（maybeMarkUnread + SessionPresenceProbe 注入）——违反关注点分离，否决；(2) 状态机注入 SSE——违反纯粹原则，否决；(3) 最终：**session 层**自治（订阅 completion 信号 + 查 isSessionActive + CAS unread）。详见 `specs/tech/version_logs/v0.0.27/unread-model-decision.md` §6。
