# LLM Chat + Provider HTTP API（v0.0.3 server facade）

> version: 1.4 `[v0.0.8 modified]` · [v0.0.56 modified] SSE 事件 payload 中 session 类型字段同步 SessionKind 变更（type→role+derivation，bizType→biz）；无独立 HTTP 端点变更（/chat 已作废，session 化端点见 04-agent-session.md）。详见 `specs/api/version_logs/v0.0.56-session_type/change_log.md` · 引入版本 v0.0.3
>
> **[v0.0.89 modified] model resolve 抽象 + session.modelId 保留字 `default` + MODEL_NOT_CONFIGURED 错误体**（详见 `specs/api/version_logs/v0.0.89/change_log.md`）：
> 1. **`POST /session/:id/chat` / `POST /session/:id/messages` / `POST /session/:id/run` 错误体新增 `MODEL_NOT_CONFIGURED`**（HTTP 400）：resolveModel fallback 链跑空时返 `{ code: "MODEL_NOT_CONFIGURED", message: "请配置模型后再发起会话", detail: { sessionType, task } }`。**MUST NOT 静默 fallback 到首个 enabled provider**（与 v0.0.72 web_search 同款反静默原则）。技术权威 `specs/tech/agent/providers_and_models/[P0]model_resolve.md`。
> 2. **`POST /session` body.modelId 缺省 → 落 `"default"`**（替代旧不写）：保留字 `default` = 未手动选/跟随默认；`PUT /session/:id` body.modelId 接受 `"default"` / `"none"`（规范化为 default 落盘）/ 具体 ModelRef（保留字短路不查 provider 命中）。详见 §5.5（v0.0.89 新增）。
> 3. **resolveModel fallback 链**（playground/studio × chat/summary 6 行）：playground 读 `default_models.chat/summary`（app_config 新 group）；studio 完全不读 `app_config.default_models`（团队级走 `squad.modelDefault` + `squad.summaryModelDefault` + `member.model`）；保留字 `default`/`none`/`""`/`undefined` 全走 fallback。详见 `specs/tech/agent/providers_and_models/[P0]model_resolve.md §3`。
> 4. **新增 `default_models` app_config group**（playground 专属全局默认模型，单 record key=`default` data={chat?, summary?}）：`GET/PUT /config/app?group=default_models`（沿用 `/config/app` 通用 KV）。详见 `03-config-center.md §2.5`。
> 管什么：v0.0.3 server 经 `node:http` 暴露的 HTTP 端点契约—— `/chat`（SSE 流式）+ `/provider` CRUD + `/provider/:id/model` CRUD。
> 不管什么：`/config/{app,dev,plugin}` 三域端点（v0.0.5 起拆出 → `03-config-center.md`）；渲染层 UI（→ `specs/ui/overall/`）；server 实现细节（路由分发、CrudStore 访问、LlmClient 组装 → 代码层）；端口 schema 与 DATA_DIR（→ `app/envs/[P0]environments.md`）。
> **本文件是 AT（API Test）chat/provider 域的唯一依据**：api-verifier 黑盒 curl，不读代码。
>
> **[v0.0.8 modified]**：`/chat` 端点**作废删除**（被真实 agent session 化端点取代，新端点见 `04-agent-session.md`）。`/provider` `/provider/:id/model` 端点 v0.0.8 **完全不变**。§3 保留 v0.0.3 `/chat` 历史契约仅作参考，端点已不可调用。
>
> **[v0.0.5 modified] 拆分**：v0.0.5 起将 `/config/{app,dev,plugin}` 三域端点（原 §4）拆出独立文件 `03-config-center.md`。本文件保留 `/chat` + `/provider` + `/provider/:id/model` 端点。
>
> **[v0.0.4 modified]（保留信息）**：`/provider` `/provider/:id/model` UI 入口从插件设置页挪到 app 设置页（数据归属 = app_config providers group 不变，端点契约完全不变）；`/config/plugin` inventory 返回结构 v0.0.4 改 group-centric（见 `03-config-center.md` §3.1）。
>
> **[v0.0.25 modified] LLM 调用错误处理（backend-only，对 caller 透明）**：server 内部从 `client.stream` 改为 `llmCaller.invoke`（`specs/tech/agent/llm_caller/`，端点形状不变）。两点对外可观测变更：
> 1. **SSE error 事件新增 `errorCategory` 字段**（`LlmErrorCategory` 枚举值，17 值，向后兼容——旧 caller 仍读 `message`）。agent loop 失败时不再塌缩 `LOOP_ERROR`，按真实 category（`PROVIDER_OVERLOADED` / `RATE_LIMITED` / `AUTH_INVALID` / `CONTENT_FILTERED` / `CONTEXT_LENGTH_EXCEEDED` / `MAX_TOKENS_EXCEEDED` / `ABORTED_BY_USER` / `TIMEOUT_FIRST_CHUNK` / `TIMEOUT_INTER_CHUNK` 等）。整链全 dead 才真失败上抛。SSE error 事件契约见 `04-agent-session.md` AT 路径 C；完整 17 category 见 `specs/tech/agent/llm_caller/[P0]error_normalization.md §1`。
> 2. **新增 `GET/PUT /config/app/llm_request` 端点**（llm_request config group 读写，调优参数；详见 `03-config-center.md §2.4`）。
> 3. **langfuse generation metadata 补全**：`physical_wire_body`（encode 后 fetch 前的最终 wire body，含 tool_result 原文，做逻辑 input vs 物理 body diff 对账）+ `errorCategory`（错误分类，不再 LOOP_ERROR）+ `retry_chain`（每次 attempt 的 `{providerId, keyRef, attempt, category, delay}` 链）。非 HTTP 端点改动，observability 字段补充。
> 4. **anthropic role=tool 协议修复**（BUG-002）：canonical `role:"tool"` message 在 server encode 层转 `role:"user"` + `tool_result` block + 合并连续同 role → 端点接受（不再 422 literal_error）。完整规则见 `specs/api/version_logs/v0.0.25/change_log.md §2`。
>
> **[v0.0.25 rev2 modified] 错误外显 + 自适应机制改版**（端点形状不变，可观测字段扩充）。`LlmErrorCategory` 从 17 → **19 值**（新增 `MAX_TOKENS_TOO_HIGH` / `EMPTY_RESPONSE`）。**[v0.0.59 corrected]** 后端 `app/server/src/llm/caller/display_reason.ts` 的 `DISPLAY_REASON_TABLE` 实测为 **18 行**（不是 19——历史 spec 误记，`MAX_TOKENS_TOO_HIGH` 在表中只出现一次；前端 `error.json` 同步 18 leaf）。可观测变更：
> 1. **SSE error 事件再扩充**：在 rev1 `errorCategory` 基础上**新增可选 `displayReason`（用户可读理由，i18n 候选）+ `errorDetail`（raw provider message，给 tooltip/log）**。向后兼容（旧 caller 读 `message`/`errorCategory` 仍工作；message 保留兜底文案）。完整 `errorCategory → displayReason` 映射（实测 18 行）见 `specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md §1` + `app/server/src/llm/caller/display_reason.ts`。
> 2. **新增 `llm_attempt` SSE event**（topic=`agent_loop`）：per-attempt 实时外显 retry/fallback 进度。payload `{ type:"llm_attempt", attempt, providerId, keyRef?, modelId, action, category, maxAttempts, message }`（action ∈ RETRY/ROTATE_KEY/FALLBACK/FAIL；FAIL 后紧跟 SSE error 事件）。**[v0.0.144 modified]** 补 `maxAttempts: number`（= `llm_request` config `retry.max_attempts`，前端「重试中 x/x」分母）+ `message: string`（`deriveDisplayReason(category)` 派生的用户可读文案，前端 hover 展示）；前端 v0.0.144 起消费本事件切「重试中 {attempt}/{maxAttempts} + ！」气泡态（详见 `specs/api/version_logs/v0.0.144/change_log.md`）。
> 3. **Run/RunRecord error 字段**：run 失败时 `Run.error` 落 `RunErrorInfo = { errorCategory, displayReason, errorDetail? }`（agent loop catch ClassifiedLlmError 填）。**[v0.0.59 corrected]** `GET /session/:id` 响应 `currentRun.error` **仅在 `state=running` 且 `currentRunId≠null` 时存在**——`state=error` + eager-drain（currentRunId=null）时响应**无 currentRun/error 字段**，error 信息读 SSE error 事件（流中实时）或 history run 的 `RunRecord.error`（落库）；forked 旁路（compact 等）不落 RunRecord，error 仅在 SSE/log。`ABORTED_BY_USER` 走 stopReason=`interrupted` 不填 RunErrorInfo。
> 4. **连续错误驱动的自适应 maxTokens**（caller 透明，仅 observability 体现）：`LlmErrorState.recentErrors` 记连续错误历史（成功清空），maxTokens **派生** `base × 0.7^(MAX_TOKENS_TOO_HIGH 次数)`——`MAX_TOKENS_TOO_HIGH` 触发降参重试时 `llm_attempt.action=RETRY`（category 携带 `MAX_TOKENS_TOO_HIGH`）。旧 rev1 的 `maxTokensOverlay` 单值字段移除。**[v0.0.144 corrected]** `llm_attempt.action` 实际枚举 = `RETRY`/`ROTATE_KEY`/`FALLBACK`/`FAIL`（不存在 `bump_max_tokens`/`switch_key`/`switch_provider`——历史 spec 误记；具体动作语义由 `action` + `category` 组合表达）。
> 5. **per-session×per-model 降级**（caller 透明）：换 provider 走 `llm_attempt.action=FALLBACK`、换 key 走 `action=ROTATE_KEY`，反映 `resolveTarget` 两遍扫描结果（healthy 优先 → degraded 兜底 → cooled_down 跳 → dead 排除）；`llm_attempt.action=FAIL` 即整链全 dead/全 cooled_down。
> 6. **length + validate**（caller 透明）：`MAX_TOKENS_EXCEEDED`（stop_reason=length）→ one-shot ceiling bump（升到 model.maxOutputTokens，`llm_attempt.action=RETRY` + `category=MAX_TOKENS_EXCEEDED`）；`client.validate()` 越界收口为 `MAX_TOKENS_TOO_HIGH`（BUG-005 修复方向，合并后落地）。
>
> 详见 `specs/tech/agent/llm_caller/[P0]llm_caller.md §2.3`（llm_attempt event schema）+ `§2.4`（RunErrorInfo）+ `specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md`（权威附录：映射表 + resolveTarget 伪代码 + Run 收尾机制）。
>
> **[v0.0.50 modified] langfuse 双 generation + 逻辑视图层（observability 字段补充，HTTP 端点不变）**：
> 1. **一次 LLM 调用产两条紧邻 generation**（同 step span，name 后缀区分）：`llm-N-logical`（业务视图，input.messages 经 `toLogicalMessages` 展平——sender 已变文本前缀，与 LLM 真正看到的 input 一致）+ `llm-N-physical`（protocol.encode 后的 wire body 载荷，**不带 usage**——不污染 langfuse token/cost dashboard）。物理层受 `app_config.runtime.observability[i].logPhysical` 开关控制（默认 false，重启生效；v0.0.89 迁自废弃 dev_config）；AT 断言按 name `llm-*-logical` / `llm-*-physical` 区分。
> 2. **`physical_wire_body` 写路径废止**：旧 `GenMetadata.physicalWireBody`（v0.0.25 预留，把 wire body 塞进 logical metadata）停止写入；字段声明保留（optional，兼容旧 trace/旧读取）。写路径改走独立 physical generation（`kind='physical'`）。
> 3. **抽公共 `llm/logical-view.ts`**（业务 Message[] → LLM 视图 Message[]）：sender 展平归公共层（不再各 protocol 各做）；`protocol.encode` 入参假定已 logical 展平。
> 4. **消息级 `metadata.isSystemReminder` 废止**：injector 停写消息级标记（块级 `TextBlock.isSystemReminder` 唯一权威）；老 transcript 数据被前端块级 filter 忽略，不迁移。
>
> 技术权威 `specs/tech/agent/observability/[P0]observability_interface.md §4/§5.2` + `../observability/[P0]langfuse_adapter.md §4` + `../observability/[P0]observability_manager.md §5.3` + `../llm_caller/[P0]llm_caller.md §6.6` + `../providers_and_models/[P0]llm_logical_view.md` + `../message/[P0]agent_message_interface.md §4.1`；详见 `specs/tech/version_logs/v0.0.50.sender_data_format/change_log.md`。

> **[v0.0.59 modified] displayReason 前端 i18n 化（端点形状不变，向后兼容）**。i18n 基础设施首版（PRD `specs/prd/version_logs/v0.0.59.i18n.md`）落地。前端启用 react-i18next 后**前端侧**优先按 errorCategory 查 locale 表、回退 displayReason 字段：
> 1. **契约不变**：`RunErrorInfo = { errorCategory, displayReason, errorDetail? }` 字段集合不变（v0.0.25 rev2 锁定）。后端继续发 `errorCategory`（枚举值 code）+ `displayReason`（zh-CN 兜底文案，`deriveDisplayReason()` 函数不变）+ `errorDetail`（raw provider message）。**零 API breakage**——旧 caller 直接读 `displayReason` 仍工作。
> 2. **前端行为变更（透明于后端/AT）**：前端启用 i18n 后渲染 displayReason 时优先 `localizedDisplayReason(errorCategory, displayReason, t)`（内部 `t('error.llm.' + camelCase(errorCategory))` 查 locale 表，`app/web/src/i18n/locales/<lng>/error.json` 覆盖 **18 个** LlmErrorCategory leaf）；查到 → 用本地化文案；查不到 → **回退**用 `displayReason` 字段值（zh-CN 兜底，与 locale 表 zh-CN 文案一致，无视觉差异）。
> 3. **AT 影响**：API 层断言不变（仍可断言 `errorCategory` code / `displayReason` 字段存在）；前端 DOM 文案断言（E2E）按当前 locale 期望对应文案（PRD §4 路径 P4）。
> 4. **后端本版本不需要 locale**：displayReason 范式 = 后端发 code、前端查表，后端透明；后端产生本地化文案（HTTP 错误体 / plugin.json label）= 未来扩展点，不在本版本。
>
> 技术权威 `specs/tech/i18n/[P0]i18n_overview.md §8`；PRD `specs/prd/version_logs/v0.0.59.i18n.md`。

> **[v0.0.62 modified] SSE 域 type code 全量前端本地化（端点形状不变）**。i18n 迁移 Batch 2（PRD `specs/prd/version_logs/v0.0.62.i18n_migration.md`）把 chat 域剩余可枚举 type code 全部走 §8 同款「后端发 code、前端查表」范式：
> 1. **契约不变**：`Run.stopReason`（7 enum）+ `RunErrorInfo.errorCategory`（18 enum）字段集合与 code 字面量均不变；后端 `deriveDisplayReason()` 函数与 `DISPLAY_REASON_TABLE` 不动。
> 2. **前端行为变更（透明于后端/AT）**：
>    - `Run.stopReason`（excl. `'error'`）：前端查 `chat.run.stopReason.<camelCase>` 表（6 leaf：`noToolCall/noNewMessages/maxIterations/doomLoop/requireApproval/interrupted`）；`stopReason==='error'` 仍走 `RunErrorInfo.displayReason` + §8 `error.llm.*` 范式（不进 stopReason 表）。
>    - `Session.state` / `Member.role` / `Member.state` / `Connector.connection`：本版本同步映射（key 见 `specs/tech/i18n/index.md §⑥` 累积表）。
> 3. **AT 影响**：API 层断言不变（仍断言 `stopReason` / `errorCategory` code 字面量）；E2E 文案断言按当前 locale 期望对应文案。
> 4. **HTTP 错误体（4xx/5xx response body `{ error: msg }`）不在本版本本地化**：核查全部 handler 确认当前 HTTP 错误体只有自由文本 msg、**无机器可读 code 字段**（PRD M4 premise「保留 code 契约」与现状不符）。按 v0.0.59 KB §2.2 硬边界，HTTP 错误 msg 归「动态自由文本」原样直展不翻译。如未来需本地化，须新引入 code 字段（新机制、扩 KB 硬边界），与本版本「机械迁移不变机制」原则冲突 → 不在本版本范围。
>
> 技术权威 `specs/tech/i18n/index.md §⑥`（type code 跨版本累积表）+ `[P0]i18n_overview.md §7/§8`；PRD `specs/prd/version_logs/v0.0.62.i18n_migration.md`。

## 1. 概述

v0.0.3 server 是 v0.0.1 server（mock 计数）的扩展，继续用 `node:http` 暴露 HTTP facade，监听 `http://127.0.0.1:${API_PORT}`（test `3700` / dev `3710` / prod `3720`）。所有端点 loopback only，无 TLS。

**chat 形态（关键约定）**：v0.0.3 `/chat` 是**无 session、无持久化、每次请求带最近 10 条 message** 的简单形态（PRD §5.1 + scope.out）——
- 前端在内存维护对话记录（刷新即失），发请求时裁剪到最近 10 条 POST。
- server 不存对话、不建 session、不维护上下文窗口（无 context engine）；每次 `/chat` 都是一次无状态的 LLM 调用。
- API key 仅 server 持有（读 app_config file），前端只发 `providerId` + `modelId` + `messages[]`，**不接触 key**（PRD §5.1）。

**SSE wire event**：`/chat` 流式**复用 protocol 层 `StreamEvent`**（`agent/providers_and_models/[P0]llm_protocol_interface.md` §2 流式），server 不另定 wire event —— 每条 `StreamEvent` 序列化为一条 SSE 帧 `event: <type>\ndata: <json>\n\n`，原样推前端。

一句话：**v0.0.3 server facade = `/chat` SSE（无 session，带 10 条 message）+ `/config` 三域 get-set（→ `03-config-center.md`）+ `/provider` `/model` CRUD，全部 loopback HTTP/JSON（chat 流式走 SSE）。**

### 1.1 数据流

> **[v0.0.8 modified]**：下方 `/chat` 数据流是 v0.0.3 历史形态（已作废，见 §3）。v0.0.8 真实 agent 对话的数据流见 `04-agent-session.md`（`POST /session/:id/messages` 触发 run + `GET /sse` 订阅 `agent_loop` 收 AgentEvent 流）。

```
┌──────────────┐  POST /chat (providerId+modelId+messages)        ┌────────────────────────────────┐
│  web 渲染层  │ ────────────────────────────────────────────────►│ app/server                     │
│ (browser)    │ ◄──────── SSE: thinking_delta / text_delta / ... │  └─ LlmClient → Anthropic API  │
└──────────────┘                                                   │  └─ 读 app_config providers 组  │
                                                                   └────────────────────────────────┘
┌──────────────┐  GET/PUT /config/{app,dev,plugin}                 ┌────────────────────────────────┐
│ web / curl   │ ────────────────────────────────────────────────►│ app/server                     │
│ (verifier)   │ ◄──────── JSON                                    │  └─ AppConfigService / DevCfg / │
└──────────────┘                                                   │     PluginConfigService        │
                                                                   └────────────────────────────────┘
```

> `/config/{app,dev,plugin}` 端点详见 `03-config-center.md`（v0.0.5 拆分）。v0.0.8 agent session 端点（`/session*` `/sse*`）详见 `04-agent-session.md`。

## 2. 监听地址与通用约定

| 项 | 取值 | 来源 |
|----|------|------|
| host | `127.0.0.1`（loopback） | 本文件契约 |
| port | `API_PORT`（test `3700` / dev `3710` / prod `3720`） | `app/envs/[P0]environments.md` §3.1 |
| 协议 | `http`（无 TLS） | v0.0.3 本机场景（PRD §6.1） |
| 请求体 | `application/json`（`/chat` 除外另有 SSE 响应） | 本文件契约 |
| 成功响应 | `200` + JSON body（chat 为 SSE 流） | 见各端点 |
| 错误响应 | JSON `{ "error": string }`，`Content-Type: application/json` | 与 v0.0.1 一致 |

> v0.0.1 的 `/counter` / `/counter/inc` 端点继续保留（不在本文件展开，见 `01-counter.md`）。

## 3. `/chat`（SSE 流式） — `[作废-被 v0.0.8 取代]`

> **[作废-被 v0.0.8 取代]**：v0.0.8 起，无 session 的 `POST /chat` 端点**已删除**（被真实 agent session 化端点取代）。新增端点见 **`04-agent-session.md`**：
> - `/session` CRUD（`POST/GET/DELETE`，§2）
> - `/session/:id/messages`（GET transcript 分页 + POST 发消息触发 run 返 `runId`，§3）
> - `/session/:id/summary`（GET 摘要只读，§5）—— 支撑 PRD path D compact 观测
> - `/sse` channel（GET SSE 流 + POST `/sse/subscribe` + `/sse/unsubscribe`，§4）—— 多连接 fan-out，按 (topic=`agent_loop`, group=`session_id:<sid>`) 订阅
>
> **取代理由**：v0.0.3 `/chat` 是「无 session、无持久化、每次带最近 10 条 message」的配置验证切片；v0.0.8 升级为真实 agent（session 化 + AgentLoop + 工具 + ContextEngine + transcript 持久化 + EventBus/Hub + SSE channel），`/chat` 失去存在意义，整体作废。增量变更见 `specs/api/version_logs/v0.0.8/change_log.md`。
>
> **AT 影响范围**：v0.0.3 旧 `/chat` AT case（curl SSE 验证流式分段）作废；新增 v0.0.8 AT 覆盖见 `04-agent-session.md` §7（PRD §4 关键路径 A-F 映射）。
>
> 下方保留 v0.0.3 `/chat` 端点的**历史契约描述**（仅作回归参考，**不再可调用**，端点已从 router 移除）。

### 3.1 端点

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/chat` | 无 session 流式对话：按 providerId + modelId 组装 LlmClient 调 Anthropic Messages API，SSE 推 `StreamEvent` | `ChatRequest` | `200` · `Content-Type: text/event-stream` · SSE 流 |

### 3.2 请求体 `ChatRequest`

```typescript
interface ChatRequest {
  /** provider 实例 id（= app_config providers 组 record key） */
  providerId: string;
  /** model 实例 id（= 该 provider 的 models[] 中一条 modelConfig.modelId） */
  modelId: string;
  /** 最近 10 条 message（前端裁剪）；server 不持久化、不补 system */
  messages: ChatMessage[];
}

interface ChatMessage {
  role: "user" | "assistant";     // v0.0.3 不收 system（PRD scope.out 工具调用 / 多轮上下文）
  content: string;                 // 纯文本（v0.0.3 不支持多模态，简化）
}
```

| 字段 | 类型 | 必含 | 校验 |
|------|------|------|------|
| `providerId` | string | 是 | 必须命中 app_config `providers` 组一条 record，否则 `400` |
| `modelId` | string | 是 | 必须命中该 provider 的 `models[]` 一条，否则 `400` |
| `messages` | `ChatMessage[]` | 是 | 非空、≤ 10 条（>10 由前端裁剪，server 不强制但建议）；每条 `content` 非空字符串 |

> **不收 API key**：key 从 app_config `providers[providerId].credentials.key` 读（server side），前端不传。

### 3.3 SSE 响应（复用 protocol `StreamEvent`）

`Content-Type: text/event-stream`，每条 `StreamEvent` 一帧：

```
event: thinking_delta
data: {"type":"thinking_delta","thinking":"让我想想..."}

event: text_delta
data: {"type":"text_delta","text":"你好"}

event: usage
data: {"type":"usage","usage":{"input_no_cache":320,"output_total_tokens":12,...}}

event: finish
data: {"type":"finish","reason":"stop"}
```

帧类型与 protocol `StreamEvent` 一一对应（见 `[P0]llm_protocol_interface.md` §2 流式）：
- `thinking_delta`：assistant thinking block 增量（折叠面板渲染）。
- `text_delta`：assistant text block 增量（answer 文本）。
- `usage`：token 用量（出现一次或多次，最终值为流末值）。
- `finish`：流结束 + stop reason。

> server 不产出 `tool_call_delta`（v0.0.3 不接 tool，PRD scope.out）。

### 3.4 错误响应（`/chat`）

| HTTP status | 触发条件 | 响应体 |
|---|---|---|
| `400` | `providerId` / `modelId` 不命中；`messages` 为空或非法 | `{ "error": "<原因>" }`（JSON，**非 SSE**） |
| `500` | LlmClient 调用失败（网络 / Anthropic 4xx/5xx / 解析失败） | `{ "error": "<原因>" }`（JSON，**流未开始或流中错误均以 JSON 关闭**） |

> **流中错误**：若 SSE 已开始后上游报错，server 推一帧 `event: error\ndata: {"error":"..."}` 后关闭流（前端 reducer 把 message 标记为 error 态）。

## 4. `/config`（三域 get-set） — 见 `03-config-center.md`

v0.0.5 起 `/config/{app,dev,plugin}` 三域端点（含 `/config/app` `/config/dev` PUT 整组提交、`/config/plugin` GET 字段 `cardinality`→`type` + 顶层 `plugins[]` + ext impl `schemaConfig?` + PUT `setImplConfig` 稀疏 delta 语义）拆出独立文件，**详见 `03-config-center.md`**（避免本文件超 300 行）。

## 5. `/provider` CRUD（provider 实例 = app_config providers 组一条 record） `[v0.0.4]` UI 入口迁移 · `[v0.0.7]` PUT + label/enabled 扩展

provider/model 实例数据是 **app_config 数据**（PRD §5.2 + `config/[P0]app_config.md` §3.2）。本端点是 app_config `providers` 组的语义化 CRUD 封装（封装 `(group=providers, key=<instanceId>) → data`）。

> **[v0.0.4] UI 入口迁移（端点不变）**：v0.0.3 provider/model 实例 CRUD UI 在**插件设置页**；v0.0.4 起挪到 **app 设置页** 新增 providers 区（数据归属 = app_config providers group，UI 归属应与数据归属一致）。**本组端点（`/provider` + `/provider/:id/model`）的路径/方法/请求/响应/错误契约 v0.0.4 完全不变**，只是前端调它的入口从 PluginSettingsPage 改到 AppSettingsPage。ProviderHandler / ModelHandler / llm-client-factory 不变。

> **[v0.0.7] 端点扩展（PUT 已落地 + model 新增 label/enabled 字段）**：
> - `PUT /provider/:id` 端点从 v0.0.3 仅 spec 声明（无实现）变为**已落地**，可改 `label` / `baseUrl` / `enabled` / `credentials.key`（见 §5.1）。
> - `ModelInstance` **新增必填 `label: string` + `enabled: boolean`**（POST 缺省时 `label = modelId`、`enabled = true`；PUT 部分更新沿用既有值）。
> - `ProviderCreateBody` / `ProviderUpdateBody` / `ModelCreateBody` 字段同步扩展（见 §5.2 / §5.3）。
> - 路径 / 方法 / 错误码 / credentials 脱敏规则（§5.4）**不变**。

> **[v0.0.53] 字段归属迁移（protocolId model→provider）+ GET 列表响应扩 protocols metadata**：
> - **`ProviderInstance` 新增必填 `protocolId: ProtocolName`**（1 provider : 1 protocol 锁定，单一事实源）；**`ModelInstance` 删除 `protocolId`**（物理删除，不保留 override）。
> - `ProviderCreateBody` += `protocolId`（必填，缺省 400）；`ProviderUpdateBody` += `protocolId?`（可选）；`ModelCreateBody` / `ModelUpdateBody` -= `protocolId`（请求体含该字段：**忽略**，201 不写入 ModelInstance，前端容错友好）。
> - **`GET /provider` 响应扩展**：从 `{ items }` 改为 `{ items, protocols }`，新增顶层 `protocols: ProtocolMeta[]`（已注册 `llm_protocol` ext impl 元数据投影，前端 provider 配置 UI 拼「实际请求地址」+ 下拉展示用，详见 §5.2）。**对旧 caller 向后兼容**（新字段 `protocols` 旧 caller 忽略）。
> - POST/PUT 校验更新：`POST /provider` 缺 `protocolId` 或 `protocolId` 不在已注册列表 → 400（见 §5.4）。
> - **路径 / 方法 / credentials 脱敏规则不变**；仅字段加减 + 新增 protocols metadata。
> - 详细变更：`specs/api/version_logs/v0.0.53/change_log.md`；后端 tech 见 `specs/tech/version_logs/v0.0.53/change_log.md`。

### 5.1 端点

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `GET` | `/provider` | 列所有 provider 实例 + 已注册 protocol 元数据 `[v0.0.53]` | 无 | `200` · `{ "items": ProviderInstance[], "protocols": ProtocolMeta[] }`（`protocols` 见 §5.2，[v0.0.53]） |
| `POST` | `/provider` | 创建 provider 实例（生成 ULID 作 id） | `ProviderCreateBody` | `201` · `{ "provider": ProviderInstance }` |
| `GET` | `/provider/:id` | 取单个 provider 实例（含 models[]） | 无 | `200` · `{ "provider": ProviderInstance }` |
| `PUT` | `/provider/:id` | 更新 provider 实例（label/baseUrl/credentials/enabled/`[v0.0.53]` protocolId） | `ProviderUpdateBody` | `200` · `{ "provider": ProviderInstance }` |
| `DELETE` | `/provider/:id` | 删除 provider 实例（级联删其 models[]） | 无 | `200` · `{ "ok": true }` |
| `GET` | `/provider/quota` | 读全局额度 store 秒回 `[v0.0.363]`（见 §5.6） | 无 | `200` · `{ "items": QuotaSnapshot[], "lastSyncedAt": number \| null }` |
| `POST` | `/provider/quota/sync` | 触发一轮增量同步 fire-and-forget `[v0.0.363]`（见 §5.6c） | 无 | `202` · `{ "syncing": boolean, ... }` |

> **实现说明（v0.0.3）**：DELETE 走 **tombstone 软删**（record 标 `_deleted: true`，GET 列表过滤 tombstone 对外表现为已删）。原因：底层 `KvConfigService`（v0.0.2）只提供 KV upsert/get/listGroup，无 delete 接口。功能正确（GET/PUT/:id 命中 tombstone 返 404、列表不返回）；未来 persistence 层补 delete 接口时清理 tombstone 残留。此为实现妥协，**对外 API 契约（语义 = 已删）不变**。
>
> **[v0.0.349] UI 删除入口补充**：v0.0.349 起 provider 详情页提供删除入口（ConfirmModal + 通用引用警示文案）；API 契约零变更（DELETE 端点早已存在）。删除后引用其模型的方案条目成 dangling——双语义见 `21-model-routing.md §2.7`（runtime 跳过 + 编辑拦保存）。删除时不做方案引用实时扫描（无新端点）。

### 5.2 类型

```typescript
/** provider 实例（= app_config providers 组一条 record 的 data，含 models[]） */
interface ProviderInstance {
  id: string;                       // ULID（= app_config record key）
  // [v0.0.350] name = ProviderName：anthropic_compatible（通用，v0.0.3 既有缺省值）+
  // 4 native coding plan 类型（kimi_coding_plan / glm_coding_plan / minimax_coding_plan / deepseek_api，
  // 指向 llm_anthropic plugin 同名 llm_provider ext impl；POST/PUT 白名单校验，缺省 anthropic_compatible 向后兼容）
  name: ProviderName;
  protocolId: "anthropic_messages"; // [v0.0.53] 必填，1 provider : 1 protocol 锁定（指向 llm_protocol ext impl）。当前仅 "anthropic_messages" 字面量；未来扩多 protocol 时此处 union 扩展
  label: string;                    // 用户起的展示名
  baseUrl: string;                  // e.g. "https://api.anthropic.com"
  credentials: { key: string };     // key；各响应返回明文（[v0.0.119.bugs] mask 收敛前端展示层，详见 §5.4）
  enabled: boolean;
  models: ModelInstance[];
}

/** model 实例（嵌套在 provider.models[]，= modelConfig） */
interface ModelInstance {
  modelId: string;                  // wire 模型 id，如 "claude-sonnet-4-6"
  // [v0.0.53] protocolId 已删除（迁到外层 ProviderInstance.protocolId，单一事实源）
  // [v0.0.143] per-model default 字段已删除（"设为默认模型"废弃，改用 app_config/default_models）
  contextWindow: number;
  maxOutputTokens: number;
  label: string;                    // [v0.0.7] 显示名（区分同 provider 下多个 model；POST 缺省 = modelId）
  enabled: boolean;                 // [v0.0.7] 启停（关闭后在 chat 模型选择器隐藏；POST 缺省 = true）
  // v0.0.3 简化：paramConstraints / pricing / modalities 可选（chat 不消费校验严格性，YAGNI）
}

/** [v0.0.53] 已注册 llm_protocol ext impl 元数据（GET /provider 响应顶层附带）。
 *  handler 实例化 protocol impl 一次读 readonly 字段（id/label/path）投影返回。
 *  前端 provider 配置 UI 用此数组：label 渲染下拉选项 + path 拼「实际请求地址」预览（baseUrl + path）。 */
interface ProtocolMeta {
  id: "anthropic_messages";         // implId / 持久化标识（= ProtocolName）；当前仅一项
  label: string;                    // 人类可读展示名（如 "Anthropic Messages 风格"）
  path: string;                     // endpoint path（如 "/v1/messages"），拼接地址用
}

/** [v0.0.53] GET /provider 响应（顶层 = items + protocols） */
interface ProviderListResponse {
  items: ProviderInstance[];
  protocols: ProtocolMeta[];        // 已注册 llm_protocol ext impl 元数据（前端拼接地址 + 下拉展示用）
}

interface ProviderCreateBody {
  name: "anthropic_compatible";
  protocolId: "anthropic_messages"; // [v0.0.53] 必填，缺省 400；必须在已注册 llm_protocol impl 集合内（否则 400）
  label: string;
  baseUrl: string;
  credentials: { key: string };
  enabled?: boolean;                // [v0.0.7] 可选，缺省 = true
}

interface ProviderUpdateBody {
  label?: string;
  baseUrl?: string;
  protocolId?: "anthropic_messages";// [v0.0.53] 可选（修改 protocol = 换接入点风格）；必须在已注册集合内
  credentials?: { key: string };
  enabled?: boolean;
}
```

### 5.3 `/provider/:id/model` CRUD

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `GET` | `/provider/:id/model` | 列该 provider 的 models | 无 | `200` · `{ "items": ModelInstance[] }` |
| `POST` | `/provider/:id/model` | 给该 provider 加 model（push 到 models[]） | `ModelCreateBody` | `201` · `{ "model": ModelInstance }` |
| `PUT` | `/provider/:id/model/:modelId` | 更新某 model | `ModelUpdateBody` | `200` · `{ "model": ModelInstance }` |
| `DELETE` | `/provider/:id/model/:modelId` | 删某 model（从 models[] 移除） | 无 | `200` · `{ "ok": true }` |

```typescript
interface ModelCreateBody {
  modelId: string;
  // [v0.0.53] protocolId 已删除（迁到 ProviderCreateBody.protocolId）。
  // 请求体若含 protocolId 字段 → **忽略**（201，不写入 ModelInstance；前端容错友好，旧 client/脚本仍可工作）
  // [v0.0.143] default 已删除。请求体若含 default 字段 → **忽略**（POST/PUT 静默不写入，同 protocolId 范式）
  contextWindow?: number;
  maxOutputTokens?: number;
  label?: string;                   // [v0.0.7] 缺省 = modelId
  enabled?: boolean;                // [v0.0.7] 缺省 = true
}
type ModelUpdateBody = Partial<ModelCreateBody>;
```

> **[v0.0.7] PUT 实现补全**：`PUT /provider/:id` 从 v0.0.3 仅 spec 声明（无 handler 实现）变为已落地。后端 handler `app/server/src/handlers/provider.ts#handleProviderItem` 按 body 字段部分更新（缺省字段保留原值）；`credentials.key === "***"` 视为不修改（哨兵语义保留，向后兼容；[v0.0.119.bugs] GET 返回明文，此哨兵不再与 GET 脱敏对称，仍作幂等占位有效）。model 字段同：POST 缺省 `label=modelId` / `enabled=true`，PUT 仅更新 body 中出现的字段。

### 5.4 错误响应（`/provider` `/model`）

| HTTP status | 触发条件 | 响应体 |
|---|---|---|
| `400` | POST/PUT body 缺必填；`name` 非 v0.0.3 允许值（`[v0.0.350]` 白名单扩 5 值：anthropic_compatible + 4 native coding plan）；`[v0.0.53]` POST `/provider` 缺 `protocolId` 或 `protocolId` 不在已注册 `llm_protocol` ext impl 的 implId 集合内 | `{ "error": "<原因>" }` |
| `404` | `:id` / `:modelId` 不命中 | `{ "error": "Not Found" }` |
| `409` | POST model 时 `modelId` 在该 provider 下已存在 | `{ "error": "Conflict" }` |

> **credentials key（[v0.0.119.bugs modified]）**：`credentials.key` 各响应（GET 列表/单项、POST、PUT）均返回**明文**——mask 收敛到前端展示层（`SecretInput` 组件 display 态脱敏，见 `specs/ui/components/framework/primitive-secret-input.md`），后端不再脱敏。理由：编辑态需回填原文 + 本机单用户传输，明文下发是可接受的现状。PUT 时 `credentials.key === "***"` 仍视为**不修改**（哨兵语义，向后兼容旧调用方；幂等无害）。
>
> **历史（v0.0.7~v0.0.118 已废）**：早期所有响应把 `credentials.key` 脱敏为字面 `"***"`。v0.0.119.bugs 起废除后端脱敏（前端拿不到原文无法在 display 态渲染「头尾明文 + 中间 *」的 mask 样式），改为后端明文 + 前端展示层 mask。

> **[v0.0.53] model body 含 `protocolId` 字段行为**：`POST /provider/:id/model` / `PUT /provider/:id/model/:modelId` 请求体若含 `protocolId` → **忽略**（201/200 正常返回，不写入 ModelInstance）。理由：(1) model 字段彻底删除意味着新 client 不会带；(2) 旧 client/脚本可能仍带，忽略比 400 更友好（前端容错友好）；(3) 不破坏数据（model 不持久化 protocolId）。

> **[v0.0.53] `protocolId` 合法性校验**：POST `/provider` / PUT `/provider/:id` body 中 `protocolId` 必须在 `pluginManager.getExtensionImpls(llm_protocol)` 返回的 impl `implId` 集合内（当前仅 `"anthropic_messages"`）；不在则 400 `{error: "protocolId must be one of registered llm_protocol impls: [anthropic_messages]"}`。

### 5.5 [v0.0.89] `session.modelId` 保留字 `default` + MODEL_NOT_CONFIGURED 错误体

**保留字 `default` 落盘语义**（详见 `specs/tech/agent/session/[P0]session_store.md §2`）：

| 端点 | body.modelId 输入 | 落盘行为 |
|---|---|---|
| `POST /session` | 缺省（不传） | 落 `"default"`（替代旧不写/undefined） |
| `POST /session` | `"default"` / `"none"` | 落 `"default"`（`"none"` 规范化为 `"default"`） |
| `POST /session` | 具体模型（如 `"gpt-4o"`） | 走 `validateModelId` 校验命中 + 落盘 |
| `PUT /session/:id` | `"default"` / `"none"` | 落 `"default"`（保留字短路不查 provider 命中） |
| `PUT /session/:id` | 具体模型 | 走 `validateModelId` 校验 + 落盘 |
| `PUT /session/:id` | `undefined`（不传字段） | 不修改（保留原值） |

**MODEL_NOT_CONFIGURED 错误体**（HTTP 400，`POST /session/:id/chat` / `POST /session/:id/messages` / `POST /session/:id/run` 共用）：

```json
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "code": "MODEL_NOT_CONFIGURED",
  "message": "请配置模型后再发起会话",
  "detail": {
    "sessionType": "playground",
    "task": "chat"
  }
}
```

- **触发条件**：`resolveModel` fallback 链跑完仍无具体 modelId（详 `specs/tech/agent/providers_and_models/[P0]model_resolve.md §3`）。
  - playground chat：`session.modelId=default` + `default_models.chat` 未配 + 无 enabled provider 默认匹配
  - playground summary：`default_models.summary` 未配 + `session.modelId=default` + `default_models.chat` 未配
  - studio chat：`squad.modelDefault` 空 + `member.model` 空
  - studio summary：`squad.summaryModelDefault` 空 + `member.model` 空 + `squad.modelDefault` 空
- **`detail.sessionType`**：`"playground"` / `"studio"`（取自 `session.biz`）。
- **`detail.task`**：`"chat"` / `"summary"`（取自 resolveModel 调用入参；compact 走 summary）。
- **MUST NOT 静默 fallback 到首个 enabled provider**（与 v0.0.72 web_search 同款反静默原则）。
- **MUST 错误体含 code/message/detail 三字段**（不省略）。

> **AT 路径覆盖**：`tests/api/session/model_default_resolve` (P7) + `tests/api/compact/summary_model_fallback` (P8) + `tests/api/multi_agent/squad_summary_model` (P9) + `tests/api/config/dev_to_app_migration` (P10)。

### 5.6 `GET /provider/quota` — 全局额度 store 读取（`[v0.0.350]` 引入现拉聚合，`[v0.0.363]` 改读 store 秒回）

**语义**：读 server 全局 QuotaStore 立即返回（秒回，不再现拉渠道 API）——store 由 QuotaSyncService 每 5min（env `QUOTA_SYNC_INTERVAL_MS` 可配，缺省 300000）后台同步 + 启动立即首轮；同步完成后经 SSE `provider_quota` 广播推送（§5.6b）。覆盖全部 4 native 类型（kimi/glm/minimax/deepseek coding plan）provider；通用 anthropic_compatible 实例不参与（items 不含）。

**请求**：`GET /provider/quota`（无参数）

**响应 200**：

```typescript
interface QuotaGetResponse {
  items: QuotaSnapshot[];       // store 当前快照（含 error 项——错误态也是状态）；零 native provider → []
  lastSyncedAt: number | null;  // store 上次同步毫秒时间戳；null = 启动空窗（尚未完成首轮）
}

// 快照条目（v0.0.350 形状不变）
interface QuotaSnapshot {
  providerId: string;         // provider 实例 id
  providerLabel: string;      // 实例 label（用户起的展示名）
  implId: string;             // kimi_coding_plan | glm_coding_plan | minimax_coding_plan | deepseek_api
  kind: 'quota' | 'balance';  // 额度型（三渠道）| 余额型（deepseek）
  tiers?: QuotaTier[];        // kind=quota 时：5h/周两桶（usedPercent=已用百分比）
  membership?: string;        // 套餐/会员档位（glm data.level / kimi membership.level）
  balance?: { currency: string; total: number; granted?: number; toppedUp?: number };
  isAvailable?: boolean;      // kind=balance：is_available（false → UI「余额不足」）
  error?: { kind: 'auth' | 'business' | 'network' | 'timeout'; message: string }; // 单渠道错误（401/403→auth；业务错误透原始文案）
  fetchedAt: number;          // 快照毫秒时间戳
}
interface QuotaTier { window: 'five_hour' | 'weekly'; usedPercent: number; resetsAt?: string }
```

**启动空窗行为**：store 空 → 异步触发一轮同步（**不等待**）+ 立即返回 `{ items: [], lastSyncedAt: null }`——前端 lastGood 兜底 + SSE 帧到达刷新。

**错误隔离**：单渠道查询失败**不炸整体**——该渠道 item 带 `error` 字段返回（其余渠道正常）；零 coding plan provider → `items: []`。渠道内字段缺失/形状漂移 → 防御式降级（缺哪段展示哪段，见 tech `llm_provider_interface.md` §queryQuota）。

**实现约束**：查询域从 provider 实例 baseUrl 推导（子串匹配：glm 按 bigmodel.cn→国内站否则 z.ai；minimax 按 minimax.io→国际站否则国内站；kimi 用 baseUrl 原样；deepseek 取 origin）；glm 鉴权**裸 api_key 无 Bearer**（其余 Bearer）；解析规则权威 = `specs/research/v0.0.350-live-verify.md`（实测）+ cc-switch 对照。

### 5.6b `[v0.0.363]` SSE topic `provider_quota` — store 更新广播

- **订阅**：`POST /sse` body `{ "topics": ["provider_quota"], "group": "_all" }`（广播组 `_all`，同 `app_task` 模式——所有打开中的页面共享）。
- **触发时机**：QuotaSyncService 每轮同步写 store 完成后（5min 周期轮 / 启动首轮 / POST sync 触发的增量轮，同构 syncOnce）。
- **帧形状**：

```typescript
{
  "topic": "provider_quota",
  "group": "_all",
  "data": { "items": QuotaSnapshot[], "lastSyncedAt": number },  // 同 GET 响应体（items 含 error 项）
  "timestamp": string                                           // ISO 8601（同步完成时刻）
}
```

- **断线语义**：SSE 断线期间 store 更新不达——重连后由下一轮 5min 周期 / 下次打开页面触发补齐（既有 SSE 全 topic 共性）；前端浏览器侧 lastGood 兜底展示。

### 5.6c `[v0.0.363]` `POST /provider/quota/sync` — 触发一轮增量同步

**语义**：fire-and-forget 触发一轮 syncOnce（聚合全部 native provider 快照 → store 全量覆盖 → SSE 广播），立即返回 202。前端打开额度消费页面（squad 额度弹层 / providers 页）时调用，「打开触发」= 提前跑一轮（与 5min 周期轮同构，增量范围 = 全量 native providers ≤5 个，成本低）。

**请求**：`POST /provider/quota/sync`（无 body）

**响应 202**：

```typescript
// 接受触发
{ "syncing": true, "lastTriggeredAt": number }   // lastTriggeredAt = 本次受理时刻（诊断字段）
// 拒绝触发（非错误——同步已在途 / 30s 节流窗内）
{ "syncing": false, "reason": string }            // reason = 'in_flight' | 'throttled'
```

**节流语义**：`inFlight`（上一轮未完跳过）+ `lastTriggeredAt` 30s 节流（多页面同时打开触发不叠加）。结果经 SSE `provider_quota` 帧到达（本端点不回传同步结果）。

## 6. 文件变更清单（planner/coder 依据）

v0.0.3 端点首次落地（已在 dev1 合并）：

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/router.ts`（或对应路由文件） | 修改 | 新增 `/chat` `/config/{app,dev,plugin}` `/provider` `/provider/:id/model` 路由分发 |
| `app/server/src/handlers/chat.ts` | 新增 | `ChatHandler`：解析 ChatRequest → 组装 LlmClient → 调 `stream()` → SSE 推流（序列化 StreamEvent） |
| `app/server/src/handlers/config.ts` | 新增 | `AppConfigHandler` / `DevConfigHandler` / `PluginConfigHandler`：委托三域 service |
| `app/server/src/handlers/provider.ts` | 新增 | `ProviderHandler` / `ModelHandler`：封装 app_config providers 组 CRUD |
| `app/server/src/llm-client-factory.ts` | 新增 | `resolveProviderConfig`（deepMerge 代码默认 ⊕ app_config）+ LlmClient 构造缓存 |

v0.0.4 `/chat` `/provider` `/provider/:id/model` 端点契约**完全不变**（前端调用入口迁移到 AppSettingsPage，端点本身不动）。

v0.0.5 `/chat` `/provider` `/provider/:id/model` 端点**完全不变**。`/config/*` 三域变更见 `03-config-center.md` §5。

v0.0.7 `/provider` `/provider/:id/model` 端点扩展：`PUT /provider/:id` 从 spec 声明变为已实现；`ModelInstance` 新增必填 `label` / `enabled`（POST/PUT body 同步）；`ProviderCreateBody` 新增可选 `enabled`。路径/方法/错误码/credentials 脱敏规则不变。前端 diff-save 编排（`saveProviderWithModels`）调用本组端点：provider 变 → PUT/POST；model 按 modelId 配对做 POST/PUT/DELETE diff。

## 7. 版本

version: 1.9 `[v0.0.363 modified]`（§5.1 GET /provider/quota 行改 store 秒回语义 + 新增 POST /provider/quota/sync 行；§5.6 重写——GET 从现拉聚合（350 决策⑥，已推翻）改为读全局 QuotaStore 秒回（响应加 lastSyncedAt；启动空窗 `{items:[],lastSyncedAt:null}` 异步触发不等待）；新增 §5.6b SSE topic `provider_quota`（广播组 _all，每轮同步完成推送 `{data:{items,lastSyncedAt},timestamp:ISO}`）+ §5.6c POST /provider/quota/sync（202 fire-and-forget；`{syncing:true,lastTriggeredAt}` / 节流 `{syncing:false,reason}`）。技术权威 `specs/tech/version_logs/v0.0.363/change_plan.md` + `specs/tech/version_logs/v0.0.363/change_log.md`）。1.8 `[v0.0.350 modified]`（§5.1 加 `GET /provider/quota` 行；§5.2 `ProviderInstance.name` 从 `"anthropic_compatible"` 字面量放宽为 `ProviderName` union（+4 native coding plan 类型，POST/PUT 白名单校验、缺省值向后兼容）；新增 §5.6 quota 聚合端点契约（QuotaSnapshot/QuotaTier 形状 + 错误隔离语义 + baseUrl 推导/glm 裸 key 实现约束）。技术权威 `specs/tech/version_logs/v0.0.350/change_plan.md` + `specs/api/version_logs/v0.0.350/change_log.md`）。1.7 `[v0.0.59 modified]`（§1 header 加 v0.0.59 段：displayReason 前端 i18n 化——契约不变（零 API breakage），前端启用 react-i18next 后前端侧优先按 errorCategory 查 locale 表、回退 displayReason 字段；技术权威 `specs/tech/i18n/[P0]i18n_overview.md §8`；PRD `specs/prd/version_logs/v0.0.59.i18n.md`。**[v0.0.59 corrected]** 同步修正两处历史偏差：(1) `LlmErrorCategory` 实测 **18 值**（不是 19——后端 `DISPLAY_REASON_TABLE` 当前 18 行，`MAX_TOKENS_TOO_HIGH` 只出现一次；前端 `error.json` 同步 18 leaf）；(2) `GET /session/:id` 响应 `currentRun.error` **仅在 `state=running` 且 `currentRunId≠null` 时存在**——`state=error` + eager-drain 时响应无 currentRun/error 字段，AT 改读 SSE error 事件或 history run RunRecord。详见 `specs/api/version_logs/v0.0.59.i18n/change_log.md`）。1.6 `[v0.0.25 rev2 modified]`（§1 header 加 rev2 错误外显 + 自适应机制说明：LlmErrorCategory 17→19 值（+MAX_TOKENS_TOO_HIGH/EMPTY_RESPONSE）；SSE error 事件再扩 displayReason+errorDetail（向后兼容）；新增 `llm_attempt` SSE event（per-attempt retry/fallback 进度）；Run/RunRecord.error 落 RunErrorInfo（errorCategory+displayReason+errorDetail，GET /session/:id 可读）；连续错误驱动 maxTokens 派生（base×0.7^TOO_HIGH，旧 maxTokensOverlay 移除）；per-session×per-model 降级（四元组 key 两遍扫描）；length one-shot ceiling bump + prefill defer；validate 收口 BUG-005。权威附录 `specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md`）。1.5 `[v0.0.25 modified]`（§1 header 加 LLM 调用错误处理说明：server 内部 client.stream → llmCaller.invoke（端点形状不变）；SSE error 事件新增 `errorCategory` 字段（LlmErrorCategory 17 值，向后兼容）；新增 `/config/app/llm_request` 端点（→ `03-config-center.md §2.4`）；langfuse metadata 补 physical_wire_body/errorCategory/retry_chain；anthropic role=tool 协议修复 BUG-002）。1.4 `[v0.0.8 modified]`（1.3 → 1.4 [v0.0.7]：`PUT /provider/:id` 从 spec 声明落地为实现；`ModelInstance` / `ProviderCreateBody` / `ModelCreateBody` 扩展 label/enabled；路径/方法/错误码/脱敏规则不变。→ 1.4 [v0.0.8]：`/chat` 端点作废删除，被 `04-agent-session.md` 的 session 化端点取代；`/provider` `/provider/:id/model` 不变；§3 保留 `/chat` 历史契约仅作参考）
