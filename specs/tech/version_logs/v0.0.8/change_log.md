# Tech Change Log — v0.0.8

> 增量记录 v0.0.8 相对 v0.0.7 的技术架构变更。
> 全量概念权威：`specs/tech/agent/`、`specs/tech/app/frontend/`、`specs/tech/persistence/`。
> PRD：`specs/prd/version_logs/v0.0.8/change_log.md`。API 契约：`specs/api/version_logs/v0.0.8/change_log.md`。
> v0.0.8 = **真实 agent 基础对话页**：把无 session 的 `POST /chat` + 旧模拟前端**彻底替换**为「session 化 + AgentLoop + ContextEngine + 工具 + EventBus/Hub + SSE channel + transcript 持久化」。

## 1. Scope 与简化口径

**IN SCOPE（后端按 spec 全实现属未提及依赖）**：EventBus + EventHub、SessionStore（transcript/summary/session/run）、AgentManager + AgentLoop + Inbox、ContextEngine 三接口（简化）、工具执行引擎（file + bash）、SSE channel、anthropic cache control 2bp。

**简化基线（用户授权，spec full 形态标 future）**：

| 项 | v0.0.8 简化 | full spec（future） |
|----|------------|---------------------|
| `ContextEngine.ingest` | 仅 append 进 transcript（不走 handler chain / truncate / offload） | `context_ingest_detail.md` ordered chain + truncate + offload |
| `ContextEngine.assemble` | 单 mapper 读全 transcript；有 summary 则 head 3 + tail 3 + recent（summary 作一条 message） | `context_assemble_detail.md` mapper/reducer 双扩展点 |
| `ContextEngine.compact` | 当前 snapshot + 一条 user → LLM → 解析 `<summary>` → 推进 summaryUpTo（**不用 forked agent**） | `context_compact_detail.md` forked agent |
| char/token ratio | 常数 1.0（不学 ratio） | `session_usage.md §7` RatioWindow |
| HITL 审批 | 不实现；`require_approval` 枚举保留不触发 | `agent_loop.md §4a/§4b` + ApprovalResultBlock |
| usage 累计/展示 | 不累计、不展示；仅 char 估算 context window 触发 compact | `session_usage.md` 三分区 + ratio |
| system prompt | 固定默认值（不上 builder） | `system_prompt.md` mapper/reducer |
| token 估算 | char × 1.0 | tokenizer（未来） |

## 2. 模块落地图（`app/server/src/` 下）

### 2.1 新增目录/文件

```
app/server/src/
├── message/
│   └── types.ts                     # Message + ContentBlock 子集（v0.0.8）+ TS 类型
├── agent/
│   ├── event-bus.ts                 # ReplayableEventBus（per-topic bus；replayable:true）
│   ├── event-hub.ts                 # EventHub 单例 + registerTopic/sub/unsub
│   ├── session-store.ts             # SessionStore impl：委托 CrudStore（4 schema）
│   ├── inbox.ts                     # InboxStore（内存 Map<sessionId, Message[]>；enqueue/drain/peek）
│   ├── agent-manager.ts             # AgentManagerImpl：enqueue/activate/subscribe
│   ├── agent-loop.ts                # AgentLoop：start/runLoop（eager inbox）/emit
│   ├── context-engine.ts            # ContextEngine：ingest/assemble/compact（简化版）
│   └── agent-event-types.ts         # AgentEvent 联合类型（对齐 agent_event.md §8）
├── tools/
│   ├── engine.ts                    # ToolExecutionEngine：串行 execute(toolCalls)→ToolResultBlock[]
│   ├── types.ts                     # ToolDefinition / Tool / ToolCtx / ToolRunResult
│   ├── file-read.ts                 # read tool（cat -n、行号剥离、limit/offset）
│   ├── file-write.ts                # write tool（先 read 后写校验）
│   ├── file-edit.ts                 # edit tool（精确替换、唯一性校验）
│   ├── file-glob.ts                 # glob 工具（gitignore 风格）
│   ├── file-grep.ts                 # grep 工具（ripgrep 调用）
│   ├── bash.ts                      # bash 工具（持久 cwd、timeout、输出截断）
│   └── registry.ts                  # 默认工具清单组装（file×5 + bash）
├── sse/
│   └── sse-channel.ts               # SseChannel：hub.sub→SSE 帧转发；subscribe/unsubscribe/destroy
├── schema_defs/
│   ├── session.ts                   # Session entity（id/status/title/usage meta 简化）
│   ├── message.ts                   # transcript entity（替换 v0.0.2 transcript 夹具，含 runId/role/content/sender）
│   ├── summary.ts                   # summary entity（单值 per session：summaryUpTo + content）
│   └── run.ts                       # run entity（id/sessionId/status/stopReason/startedAt/endedAt）
└── handlers/
    ├── session.ts                   # POST/GET/DELETE /session, GET /session/:id/messages（分页）
    └── sse.ts                       # GET /sse + POST /sse/subscribe + /sse/unsubscribe
```

### 2.2 修改的现有文件

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/router.ts` | 修改 | 删 `/chat` 路由；新增 `/session`、`/session/:id`、`/session/:id/messages`、`/sse`、`/sse/subscribe`、`/sse/unsubscribe` 路由分发 |
| `app/server/src/bootstrap.ts` | 修改 | 启动期构造 EventHub 单例 + ReplayableEventBus（topic=`agent_loop`）+ registerTopic；构造 AgentManager/SessionStore/ToolRegistry/SseChannel 注入 router |
| `app/server/src/handlers/chat.ts` | 删除 | 无 session 旧 `POST /chat` 整体作废 |
| `app/server/src/llm/protocol-encode.ts` | 修改 | `encodeAnthropicMessages` 注入 cache_control 2bp（system content block array + 最后 message 最后 block，ttl=ephemeral） |
| `app/server/src/llm/protocol-types.ts` | 修改 | `ContentBlock` 联合扩展为 `message/types.ts` 子集（新增 tool_call/tool_result 字段名对齐 message interface；保留 thinking 作为 reasoning 别名） |
| `app/server/src/persistence/schema_defs/transcript.ts` | 删除/替换 | v0.0.2 实验夹具作废，由 `schema_defs/message.ts` 接管 |
| `app/server/src/persistence/schema_defs/index.ts` | 修改 | 注册 session/message/summary/run 四个新 schema |

### 2.3 前端替换（详见 frontend component 清单 §8）

旧 `components/chat/{ChatPage,MessageBubble,ModelPicker}.tsx` + `store/chat-store.ts` + `lib/sse-client.ts` 整体作废，新组件按 `specs/ui/components/chat-page/_overview.md` 实现（coder 编码前置产出组件 spec）。

## 3. Message 模型（v0.0.8 子集）

对齐 `specs/tech/agent/message/[P0]agent_message_interface.md`，不发明新字段。v0.0.8 实现 5 个 ContentBlock：

```typescript
type ContentBlock =
  | TextBlock           // { type:"text"; text }
  | ToolCallBlock       // { type:"tool_call"; id; name; arguments }
  | ToolResultBlock     // { type:"tool_result"; toolCallId; content:ContentBlock[]; isError }
  | ReasoningBlock      // { type:"reasoning"; text } —— 后端落库 + 传 LLM；前端不渲染
  | UsageBlock;         // { type:"usage"; usage } —— 后端 emit；前端不渲染
```

- ImageBlock / AudioBlock / VideoBlock / FileBlock / ApprovalResultBlock 标 **future**（v0.0.8 不实现）。
- 字段名对齐 message interface：`ToolCallBlock.id/name/arguments`、`ToolResultBlock.toolCallId/content/isError`。
- store 信封 `createdAt/updatedAt/version` 由 CrudStore 注入，业务 put 不传（见 `persistence/[P0]crud_store_interface.md §2.1`）。
- `Message.runId?` 关联 agent run；`sender.source = "user"|"agent"`。

## 4. AgentLoop 落地（基础 loop）

照 `agent_loop.md §4` 实现 eager 模式（`inboxHandleMode = "eager"`，每轮 iteration ① 都 drain inbox）。

**循环骨架**：

```
start() → _startLoop(allowContinuousInboxRead: true):
  emit run_start { inputMessageIds }
  while (!state.done):
    ① Pre-Process: drain inbox → emit message_start/block/message_end（user query）或
       enqueued_message_processed（enq 消息）→ ingest → emit clear_replay → assemble → snapshot
    ② LLM Request (准入: ingestUpTo != llmUpTo):
       - 不准入 → break (no_new_messages)
       - 准入 → LlmClient.stream(CanonicalRequest{ modelId, messages: snapshot.messages, tools: defs, params })
         → 流式 emit message_start/text_block_*/tool_call_*/reasoning_block_*/usage_block/message_end
         → LLM 完整 message 落库后 ingest → emit clear_replay → assemble → snapshot
         - 判 compact（见 §5）
    ③ Tool Execution (LLM 产 tool_call 时):
       - toolEngine.execute(config, toolCalls) → ToolResultBlock[] 串行执行
       - 流式 emit tool_result_start/delta/end（每个 result）
       - 构造 role=tool message 含 ToolResultBlock[] → ingest → emit clear_replay → assemble → snapshot
    ④ Exit Check:
       - LLM 无 tool_call → done=true, stopReason="no_tool_call"
       - step >= maxIterations(默认 25) → done=true, stopReason="max_iterations"
       - doom_loop（同输入连续 ≥3 轮）→ done=true, stopReason="doom_loop"
       - try/catch 任一阶段抛错 → done=true, stopReason="error"，先 emit error 事件
  emit run_end { stopReason }；persist run status/stopReason/endedAt
```

**事件产出**（对齐 `agent_event.md §4-§8`）：`run_start` / `message_start` → `text_block_*` / `reasoning_block_*` / `tool_call_*` / `usage_block` → `message_end` / `tool_result_*` / `run_end` / `error`。HITL 事件（`require_human_input`）**不实现**。

## 5. ContextEngine 落地（简化口径）

```typescript
class ContextEngine {
  constructor(options: { store: SessionStore }) {}
  ingest(config, messages, allowEdit=false): appendMessages(sessionId, messages)（不走 chain）
  assemble(config, prevSnapshot?): ContextSnapshot {
    const all = store.getMessages(sessionId);                 // 升序
    const summary = store.getSummary(sessionId);
    let picked: Message[];
    if (summary && all.length > 6) picked = [...all.slice(0,3), summaryMsg(summary), ...all.slice(-3)];
    else picked = all;
    const inputCharCount = picked.reduce((n,m) => n + charCount(m), 0);
    const cw = { tokenLimit: config.client.contextWindow, usedTokens: inputCharCount * 1.0,
                 remainingTokens: tokenLimit - usedTokens };
    return { system: config.systemPrompt, messages: picked, inputCharCount, contextWindowUsage: cw };
  }
  compact(config): {
    const snap = this.assemble(config);
    const compactUserMsg = { role:"user", content:[{ type:"text", text:`请把以下对话压缩为 summary，用 <summary>...</summary> 包裹：\n${JSON.stringify(snap.messages)}` }] };
    const resp = await config.client.call({ modelId, messages:[...snap.messages, compactUserMsg], params:{} });
    const summaryText = extractTag(resp.message.content, "summary");
    store.setSummary(sessionId, { content: summaryText, summaryUpTo: lastMsgId, createdAt: now });
  }
}
```

**compact 触发时机**（agent_loop ② 后）：`assemble` 后若 `snapshot.contextWindowUsage.remainingTokens < 0` → 调 `compact(config)` → 再 `assemble` 生成新 snapshot 进 LLM。

**ratio**：常数 1.0（不学）；`SessionStore.accumulateUsage/getRatio/getUsageView` 在 v0.0.8 简化为 no-op（保留签名对齐 spec，详见 §6）。

## 6. SessionStore 落地

委托 `persistence` CrudStore（4 个 SchemaDef，见 §2.1 `schema_defs/`）：

| Schema | engine | 落盘 | 用途 |
|--------|--------|------|------|
| `session` | file | `{root}/sessions/{id}.json` | Session 元数据 |
| `message`（entity=transcript） | file, sharded by sessionId, jsonl | `{root}/sessions/{sid}/transcript/<seg>.jsonl`（替换 v0.0.2 夹具） | transcript 主存储 |
| `summary` | file | `{root}/sessions/{sid}/summary.json` | compact 产 summary 单值 |
| `run` | file | `{root}/sessions/{sid}/runs/{id}.json` | Run 状态/stopReason |

**v0.0.8 实现的 SessionStore 方法**：`createSession/getSession/updateSession/listSessions/deleteSession`、`createRun/updateRun/getRun/getRuns`、`appendMessages/getMessages(range)/getMessagesByRun`、`getSummary/setSummary`。

**`getMessages` 分页**（支撑「最近 50 + 上滑续载」）：`MessageRange = { limit?:50, beforeId?, fromId?, upToId? }`。`beforeId` = 取该 id ULID 字典序之前的 limit 条；无 beforeId 取末尾 limit 条；返回 `{ items, hasMore }`。

**usage 方法简化**（对齐 spec 签名，v0.0.8 简化实现）：
- `accumulateUsage(sid, type, usage)` → no-op（type 形参保留）
- `updateContextWindowUsage(sid, cw)` → 写 `session.contextWindowUsage`（用于 compact 触发判定）
- `getRatio(sid)` → 始终返回 1.0
- `getUsageView(sid)` → 返回零值 view
- `persistUsage(sid, runId, cw)` → 写 run.contextWindowUsage

## 7. EventBus/Hub + SSE channel 衔接

- **启动期**（`bootstrap.ts`）：`EventHub.singleton()` → `bus = new ReplayableEventBus({ replayable:true })` → `hub.registerTopic("agent_loop", bus)`。
- **AgentManager** 持有 bus，AgentLoop 通过 `manager.activate` 拿到 bus 引用 → `bus.emit("session_id:<sid>", { data, timestamp })`。
- **SseChannel**（后端对象）：`hub.sub("agent_loop", group, listener)` → listener 收 event → `sseStream.write({ topic, group, data, timestamp })` SSE 帧转发前端。key=`${topic}:${group}` 去重订阅。
- **生命周期**：electron 期 = app 启动建 SSE endpoint + SseChannel；server-only 测试 = `bootstrap` 启动即建（不需要 electron）。destroy 取消所有订阅 + 断流。
- **前端**（`sse/sse-channel.md §6`）：SseClient GET `/sse` 一条 SSE connection + POST subscribe/unsubscribe 按 (topic, group) 切换；按 `${topic}:${group}` 分发到 handler。

## 8. 前端组件清单（v0.0.8）

> 总纲见 `specs/tech/app/frontend/[P0]component_architecture.md`（已存在，本版本无大改）。下面是本版本组件 spec 清单（coder 编码前置产出 `.md` + `.tsx`，归属 `app-dev-config-page/` 一级目录下的 chat-page 子树）。

| 组件 | 类型 | 归属 | 新增/修改 |
|------|------|------|----------|
| `page-chat` | page | `app-dev-config-page/` | 新增（接管旧 ChatPage） |
| `section-conv-panel` | section | 同上 | 新增（会话列表 + 新建/选中/删除） |
| `section-chat-detail` | section | 同上 | 新增（消息流 + topbar + input-bar） |
| `component-message-stream` | component | 同上 | 新增（视图层合并：tool-batch 跨消息边界） |
| `component-tool-batch` | component | 同上 | 新增（折叠/展开胶囊） |
| `component-tool-call-item` | component | 同上 | 新增（call + 绑定 result KV） |
| `component-loading-status` | component | 同上 | 新增（4 阶段悬浮胶囊） |
| `component-empty-state` | component | 同上 | 新增（空会话引导态） |
| `component-run-finish` | component | 同上 | 新增（finish reason 各态） |
| `primitive-markdown-view` | primitive | `common/` | 新增（最小 markdown 子集） |
| `primitive-bubble` | primitive | `common/` | 新增（user 深底/assistant accent-surface 气泡） |
| 旧 `components/chat/{ChatPage,MessageBubble,ModelPicker}.tsx` | — | — | 删除 |
| `store/chat-store.ts` | — | — | 删除（替换为 view-store 内 chat slice + SSE 订阅 reducer） |
| `lib/sse-client.ts` | — | — | 删除（替换为基于新 `/sse` 协议的 SseClient） |

## 9. StopReason 统一（解决 PRD §7.2 标注的不一致）

**权威枚举源** = `agent_loop.md §2`（6 个）：

```typescript
type StopReason =
  | "no_tool_call" | "no_new_messages" | "max_iterations"
  | "doom_loop" | "error" | "require_approval";
```

**v0.0.8 实现**：6 个枚举值全部声明；HITL 相关分支（`agent_loop.md §4a/§4b` 流程图中的 `pending_approval` / `approval_rejected`）**全部不实现**——`require_approval` 永不触发（工具直接执行）。

**措辞统一结论**：`agent_loop.md §4a/§4b` 出现的 `pending_approval` / `approval_rejected` 是 **HITL future 的内部流程图状态**（doc-modifier 阶段在 detail 文档标注 future），**不是 StopReason 枚举**。StopReason 枚举唯一权威是 §2，v0.0.8 不与之矛盾。

## 10. cache control

在 `app/server/src/llm/protocol-encode.ts` 的 `encodeAnthropicMessages` 末尾注入 2 breakpoint（对齐 `anthropic_impl.md §4`）：

1. **system**：encode 时若为 string 转 content block array（如已是 array 保留），给（最后一个）block 加 `cache_control: { type:"ephemeral" }`。
2. **最后 message 最后 block**：定位 `messages[messages.length-1].content[last]`，加 `cache_control: { type:"ephemeral" }`。

ttl 默认 ephemeral（不显式指定 `ttl` 字段）。

## 11. 工具安全/沙箱

- **file 工具**：`filePath` 必须**绝对路径**（硬约束）；read/write/edit 内部校验绝对路径，相对路径返 isError。
- **bash 工具**：v0.0.8 默认 cwd = `<DATA_DIR>/workspace`（不存在则 mkdir）；调用间 cwd 持久（per session）；`timeout` 默认 120s、上限 600s；输出截断到 `MAX_OUTPUT_CHARS`（建议 64KB）；交互式 flag（`-i`）不支持。
- **测试场景**：自动化测试（`ROCKY_TEST_MOCK_LLM=1`）用 mock LLM；工具执行用受控临时目录（`DATA_DIR` 指 test fixture）。
- **沙箱**：v0.0.8 不上 OS 级 sandbox；`dangerouslyDisableSandbox` 字段保留不消费。

## 12. 文件级变更清单（汇总）

新增：`message/types.ts`、`agent/{event-bus,event-hub,session-store,inbox,agent-manager,agent-loop,context-engine,agent-event-types}.ts`、`tools/{engine,types,file-read,file-write,file-edit,file-glob,file-grep,bash,registry}.ts`、`sse/sse-channel.ts`、`schema_defs/{session,message,summary,run}.ts`、`handlers/{session,sse}.ts`。

修改：`router.ts`（路由替换）、`bootstrap.ts`（wire 装配）、`llm/protocol-encode.ts`（cache control 2bp）、`llm/protocol-types.ts`（ContentBlock 对齐 message interface）、`persistence/schema_defs/index.ts`（注册 4 schema）。

删除：`handlers/chat.ts`、`persistence/schema_defs/transcript.ts`、`app/web/src/components/chat/{ChatPage,MessageBubble,ModelPicker}.tsx`、`app/web/src/store/chat-store.ts`、`app/web/src/lib/sse-client.ts`。

## 13. 版本

version: 1.0（v0.0.8 新建：真实 agent 基础对话页；后端 agent/tools/sse/message 子系统全实现；ContextEngine 三接口简化；StopReason 6 枚举统一；cache control 2bp；旧无 session chat 彻底替换）
