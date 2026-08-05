---
type: index
title: Auto Naming 子系统总起（playground session AI 自动起名）
priority: P0
status: active
updated: 2026-07-15
since: v0.0.47
---

# Auto Naming 子系统总起

## ① 是什么

auto_naming = playground session 的 **AI 自动起名服务**——用户发出**首条 query** 时，后台**并行**触发一次非流式 LLM 调用为 session 起一个短名；AI 名返回时若 session 仍是「未命名态」（`titled===false`）则应用 + 触发 `session_meta_update` 广播，否则丢弃。**纯后台副作用**，无新 HTTP endpoint、无前端可观测 UI（用户感知只是 title 从「新会话」变成有意义的名字）。

| 核心概念 | 一句话 |
|---|---|
| **titled 字段** | Session 显式 bool（默认 false）区分「title 是默认占位还是已被命名」；落在 `session/` KB（`[P0]session_store.md §2`），本 KB 只**消费**它做 CAS gate |
| **首 query 触发** | `handleMessagesPost` 内、构造 userMsg 后、deliverTo 前/后检测 transcript 无 prior role=user 消息 = 首 query → 触发 |
| **playground scope gate** | 仅 `biz==='playground' && derivation!=='subagent'` 的 session 触发（v0.0.56 schema：`biz`/`derivation` 替代旧 `bizType`/`type`；studio 域 / subagent 不起名） |
| **CAS 应用** | AI 名返回时 re-read session，`if(titled===false) { updateSession({title, titled:true}); broadcaster.broadcast(sid); } else 丢弃` |
| **走 LlmCaller.invoke** | v0.0.84 起改走 `LlmCaller.invoke(baseReq, ctx)`（`backgroundPath:true`），复用 adaptive retry / provider 降级 / 错误归一化 / langfuse 闭环；**不裸调** `config.client.call`（v0.0.47–v0.0.83 旧路径已废弃） |
| **独立 langfuse trace** | fire-and-forget 后台任务，启独立 trace（`name:'auto_naming'`）+ 1 个 GENERATION 观测；observability 真源 = `deps.observability`（非 `config.observability`，详见 §④ 不变量） |
| **静默失败** | LLM 调用失败 / 超时 / 返回空 → 静默保留默认名，不打扰用户、不弹错；观测本身也 fail-silent |
| **不 await** | fire-and-forget（不阻塞主 agent run；主 run 流式回答照常） |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| 触发时机 hook（首 query 检测）+ playground scope gate + CAS 应用 + 静默失败 | titled 字段定义与持久化（→ `../session/[P0]session_store.md §2`） |
| 起名提示词内容（`content/auto_naming.md`，[v0.0.153] 文件化）+ 单次 LlmClient.call 编排 | prompt 正文文件化通用机制（→ `../context/[P0]prompt_content_files.md §4.2`）；SessionConfig resolve 链路（→ `../agent_interface_and_loop/[P0]agent_manager.md §3.1.1 resolveConfigBySid`） |
| AI 名返回时触发 `SessionMetaBroadcaster.broadcast(sid)` | broadcast payload 与列表订阅（→ `../session/[P0]session_event.md §3a`） |
| PUT /session/:id title 路径置 titled=true（手动改名也走 CAS gate） | PUT handler 本体（→ HTTP `specs/api/overall/04 §2.5`） |
| **POST /session body.title 路径置 titled=true**（v0.0.62 修 BUG-001，对齐 PUT 行为防 AI 名覆盖） | POST handler 本体（→ HTTP `specs/api/overall/04 §2.1`） |
| studio 域 / subagent scope 排除 | biz / derivation 字段语义（→ `../session/[P0]session_biztype.md` + `[P0]session_store.md §2`） |

## ③ 与系统的关系

```
   POST /session/:id/messages（handleMessagesPost，session-messages.ts）
        │
        │  ① 构造 userMsg（已有）
        │  ② 检测「首 query + playground + 非 subagent」
        │  ③ 不 await，并行触发 →
        ▼
   ┌─── AutoNamingService（本 KB）────────────────────────────────────┐
   │  triggerIfFirstQuery(sid, plainText, deps):                       │
   │    - gate: biz==='playground' && derivation!=='subagent'          │
   │    - first-query check: store.getMessages(sid) 无 prior role=user │
   │    - 不 await，调 applyAiName(sid, plainText, deps)               │
   │  applyAiName(sid, plainText, deps):                               │
   │    - config = agentManager.resolveConfigBySid(sid)                │
   │    - obs = startGeneration(this.observability, sid, ...)          │
   │        （独立 trace name:'auto_naming' + 1 GENERATION，详 §⑥）   │
   │    - baseReq = {                                                  │
   │        modelId: config.modelId,                                   │
   │        messages: [{role:'user', text: AutoNamingHandler.build(    │
   │          {vars:{query: plainText}}).content}],  // [v0.0.153] md  │
   │        params: {}      // v0.0.84 D3：不 hardcode，复用配置       │
   │      }                                                            │
   │    - ctx = buildInvokeContext({                                   │
   │        client, errorState, sessionId, controller,                 │
   │        observability: obs?.port,                                  │
   │        backgroundPath: true   // 排除 capacity 类重试防雪崩       │
   │      })                                                           │
   │    - resp = await llmCaller.invoke(baseReq, ctx)                  │
   │        （复用 adaptive retry / FIX_AND_RETRY_MAX_TOKENS 治 thinking│
   │         截断 / ROTATE_KEY / FALLBACK + endGenerationOk）          │
   │    - aiName = extractPlainName(resp)                              │
   │    - re-read session → if(titled===false && aiName):              │
   │        store.updateSession(sid, {title: aiName, titled: true})    │
   │        metaBroadcaster.broadcast(sid)                             │
   │      else: 丢弃（no-op）                                          │
   │  静默：失败/超时/空 → catch all → 不抛；obs fail-silent           │
   └───────────────────────────────────────────────────────────────────┘
        │ (与下面并行，不互相等待)
        ▼
   agentManager.deliverTo(sid, userMsg)（主 agent run，流式回答照常）
```

**对外协作点**：
- 实现落 `app/server/src/agent/auto-naming-service.ts`（新文件，单文件 ≤300 行）。
- 触发点接线：`app/server/src/handlers/session-messages.ts:107-187` `handleMessagesPost` 内，userMsg 构造后（约 line 167 后）+ deliverTo 前/后（不 await，并行触发）。
- deps 注入：`SessionHandlerDeps` 加 `metaBroadcaster?: SessionMetaBroadcaster`（与 unreadRuntime 同构，bootstrap 已 wire broadcaster 实例，可直接共享）；`agentManager` 已注入。
- **[v0.0.153]** 起名提示词正文落 `app/server/src/prompts/content/auto_naming.md`（经 `AutoNamingHandler` 读取 + `{{query}}` 占位符替换），不再是本模块内 TS 字面量常量；通用机制见 `../context/[P0]prompt_content_files.md §4.2`。

## ④ 核心设计原则（跨文件不变量）

1. **首 query 触发（仅一次）**——触发条件 = `transcript 无 prior role=user 消息`（用 `store.getMessages(sid)` 扫一遍）。后续 query 不再起名（已有 user 消息 → 检查失败 → no-op）。这条**比 titled 字段更基础**——它保护**所有现存 session**（包括 v0.0.47 之前创建的）不会被错误触发起名（都有 prior user 消息）。→ 详见 `[P0]auto_naming_service.md §2`
2. **titled CAS gate（防首 query 期间人工改名竞态）**——AI 名返回时 re-read session，**只在 `titled===false` 时应用**（CAS 语义：`updateSession WHERE titled=false`）。用户在此期间人工改名（PUT /session/:id）会先把 titled 置 true → AI 名返回时 CAS 失败 → 丢弃。**无需区分 user/ai 来源**（PRD OUT：无起名可观测 UI）。→ `session/[P0]session_store.md §2` + 本 KB §③
3. **走 LlmCaller.invoke（v0.0.84，替代裸 client.call）**——单次 `LlmCaller.invoke(baseReq, ctx)`（`backgroundPath:true`），复用 adaptive retry 全套（`RETRY_BACKOFF` / `FIX_AND_RETRY_MAX_TOKENS`←治 thinking 模型 maxTokens 截断 / `ROTATE_KEY` / `FALLBACK`）+ provider 降级 + 错误归一化 + langfuse 闭环。`backgroundPath:true` 仅排除 capacity(rate_limit/overload) 类重试防雪崩。`baseReq.params:{}` 不 hardcode（D3：maxTokens/temperature 全复用 session/model 配置 + invoke buildRequest overlay）。→ `[P0]auto_naming_service.md §3` + `../llm_caller/[P0]llm_caller_overview.md`
4. **observability 真源 = deps 注入（v0.0.84 不变量，**MUST**）**——起名 observability adapter **必须从 `AutoNamingServiceDeps.observability` 注入**（bootstrap 传 `observabilityManager`，与 `AgentManager` 同源），**绝不读 `config.observability`**。根因：`resolveConfigBySid` 返的 `SessionConfig` 不含 observability 字段（该字段只在 `AgentManager.activate` 主 run 路径注入），起名不走 activate → `config.observability === undefined` → `?? noopAdapter` 落 noop → **langfuse 永远接不上**（功能 pass 但无 trace，AT langfuse oracle 抓到）。误用必致 langfuse 静默断流。→ `[P0]auto_naming_service.md §6.1`
5. **静默失败 + 观测 fail-silent（不打扰用户）**——LLM 调用失败 / 超时 / 返回空 / 解析失败 / config 缺失 → 全部 catch + no-op + 不抛。**绝不影响主 agent run**（主 run 在另一条并行 promise 上，独立完成/失败）。AI 起名是「锦上添花」，不是关键路径。**观测本身也 fail-silent**：`startTrace`/`startGeneration`/`endGenerationOk`/`endGenerationError`/`endTrace` 全 try/catch 吞异常——langfuse 不可达 / SDK 抛错 → 视为无 observability，invoke 仍跑、起名仍工作。→ `[P0]auto_naming_service.md §5`
6. **playground scope gate**——仅 `biz==='playground' && derivation!=='subagent'` 触发（v0.0.56 schema 迁移：旧 `bizType`→`biz`、`type`→`derivation`，见 session-store.ts:92-100）。studio 域（squad/leader/mate/studio 内 subagent）有 member identity / 模板名，不起名（PRD OUT）；playground 内 subagent 由 parent 驱动，不起名。→ `[P0]session_biztype.md` + 本 KB §③ gate
7. **不 await（fire-and-forget）**——`handleMessagesPost` 不 await auto-naming promise，主 run 立即返回 202 + runId + enqueueId。AI 名在主 run 流式回答期间或结束后某时刻到达，经 `session_meta_update` 广播让列表 reducer 整条替换 → conv-item title 自动从「新会话」变成 AI 名。→ 本 KB §③ + `session_event.md §3a`
8. **触发广播经 SessionMetaBroadcaster 直调**——AI 名应用后**直接调** `metaBroadcaster.broadcast(sid)`（同 `markUnreadTrue` 模式：runtime 自治路径不经 statusBus）。原因：title 更新走 `store.updateSession({title, titled})` 是纯 CRUD 写、不经 statusBus；若不显式 broadcast，前端列表收不到 title 变化。→ `session_event.md §3a.4` 触发时机表 + `session-meta-broadcast-decision.md §4`

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 链接 |
|---|---|---|
| `[P0]auto_naming_service.md` | 触发 hook + CAS 应用（走 `LlmCaller.invoke`）+ 起名提示词（`AutoNamingHandler`）+ 错误矩阵 + langfuse 观测接线（§6 observability 真源 + trace 命名约定）+ POST/PUT title 路径协作 + 触发点接线 | [link]([P0]auto_naming_service.md) |

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。titled 字段持久化与 Session schema 见 `../session/[P0]session_store.md §2`；broadcast 机制见 `../session/[P0]session_event.md §3a`；LlmCaller.invoke 详情见 `../llm_caller/[P0]llm_caller_overview.md`。
