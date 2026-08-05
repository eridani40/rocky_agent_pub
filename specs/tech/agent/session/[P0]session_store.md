---
type: interface
title: Session Store（统一存储 + 检索层）
priority: P0
status: active
updated: 2026-08-01
since: v0.0.7
---

# Session Store

> session 的**统一存储 + 检索层**。概念组（raw / transcript / tool_result / summary + message 逻辑概念）见 `[P0]session_concepts.md`。Message 定义见 `../message/[P0]agent_message_interface.md`。Usage 类型（AccumulatedUsage / ContextWindowUsage / Usage）见 `../context/[P0]context_snapshot_interface.md`。持久化后端见 `../../persistence/`。
> **运行态字段（state/running/currentRunId/pendingToolCalls）+ 状态机 API（markRunning/markSuspended/markInterrupting/markInterrupted/markIdle/markError + peekPendingToolCall/setPendingToolCalls/resolvePendingToolCall）+ reconcileOnStartup 崩溃恢复（保留 suspended）**见 `[P0]session_state.md`（权威）。中断/abort 行为见 `../agent_interface_and_loop/[P0]agent_interrupt.md`。
> 取代旧 `[P0]session_interface.md` 与 `[P0]session_off_loader.md`（已废弃）。
>
> **[v0.0.66] session_store EP 化**：本 SessionStore 接口（§4）额外做成 `SessionStorePoint` exclusive 扩展点（group='context'，详见 `../context/[P0]context_engine.md §3.6` + `../context/[P0]extension point and implementations.md §3.9`）。两个 impl：`persistent_session_store`（default scope 选中，包装真实持久 SessionStore 实例，全方法子集）+ `in_memory_session_store`（forked scope 选中，per-session `Map<sessionId, Message[]>`，只实现 appendMessages/getMessages/getSummary（恒 null）/getRatio（恒 1.0）/updateContextWindowUsage（no-op）/releaseSlot）。`ContextEngine.ingest/assemble` 经 `resolveStore(scopeId)` → session_store EP 选 impl。

## 1. 定位

**session 管理所有存储**。所有内容的写入与读取都经 SessionStore：

- **写入由 context engine 委托**：内容本质由 agent 生产（agent → context engine → SessionStore）。session 自身不操作 context，只提供存储能力。
- **读取多场合**：session 加载、agent 取用、用户查看，都直接读 SessionStore。
- **offload 不是 session 概念**：session 只管「存什么、取什么」（save / get / 查 pk）。「何时该把大内容挪出去」是 context 的决策（见 `../context/`）；落到 session 这里就是普通的存一条 raw / tool_result 记录。

```
       agent（生产内容）
          │
          ▼
   context engine（ingest/assemble/compact + offload 决策）
          │ 委托写入 / 读取
          ▼
   SessionStore（存储 + 检索）──→ persistence（CrudStore）
          ▲
   session 加载 / 用户查看（直接读）
```

## 2. Session / Run

```typescript
interface Session {
  id: string;            // ULID
  createdAt: string;     // ISO 8601 UTC
  updatedAt: string;
  title?: string;
  status: "active" | "archived";
  // ── [v0.0.89] modelId 保留字 `default` ──
  // POST /session 缺省 → 落 `"default"`（替代旧 undefined，= 未手动选/跟随默认）；
  // PUT /session/:id body.modelId 接受 `"default"`/`"none"`（规范化为 default 落盘）/具体 ModelRef；
  // resolveModel 视 `default`/`none`/`""`/`undefined` 为「继续 fallback」（详见 providers_and_models/[P0]model_resolve.md §3.1）；
  // session.providerId 字段保留作 v0.0.9 历史持久化（多数未填，resolver 不读，仅 cross-provider 反查 modelId）。
  modelId?: string;      // string? optional；保留字 "default" = 跟随默认
  // ── 运行态（v0.0.12 新增；状态机权威见 [P0]session_state.md）──
  state: SessionState;             // 六态枚举（idle/running/interrupting/interrupted/error/suspended；[v0.0.101] 加 suspended）
  running: boolean;                // 冗余 bool：state ∈ {running, interrupting} ⇔ true（高频查询用）；**[v0.0.101] suspended 排除 running（loop 已退出等用户输入）**
  currentRunId: string | null;     // 当前活跃 Run 的 ULID（= AgentLoop.runId），无活跃 run 时 null
  // ── [v0.0.101] HITL 悬挂队列（pendingToolCalls 落盘，INV-3）──
  //  runReActLoop ③ 段遇悬挂型 tool（interaction() 返非 null）→ setPendingToolCalls 落盘 + StopReason=tool_pending + session=suspended。
  //  回填（handleToolReply）按 toolCallId splice 一项；peek 返队首单条（recover / API GET /pending-tool-call 用）。
  //  reconcileOnStartup 对 suspended session 校验 pendingToolCalls 一致性（必有 ≥1 status='pending'，不一致则清空，INV-3）。
  pendingToolCalls?: PendingToolCall[];   // 默认 [];不设则视空（向后兼容旧 session）
  // ── summaryTask（v0.0.13 新增；旁路 CAS，不进五态机，见 [P0]session_state.md §3a）──
  summaryTask: SummaryTask;        // 单值：1 session 仅 1 个 compact 任务（D2.3）
  // ── usage meta（三分区累加 + ratio，见 context_usage_detail §2/§4）──
  usage: SessionUsageMeta;
  // ── workspace（v0.0.17 新增；详见 [P0]session_workspace.md §2）──
  workspaceDir: string;            // 真实工作目录绝对路径（LLM 工具默认根 + workspace reminder 数据源 + WorkspacePanel 展示根 + fs watch 根）
  // ── 未读（v0.0.27 新增，显式 bool 存储值；详见 [P0]session_state.md §6 未读模型）──
  unread: boolean;                 // true = 有未读（run 完成于非前台且未标读）；默认 false；**两个 timing 都在 session 层**：消除=POST /read→markRead CAS false；产生=session 层（SessionUnreadOps runtime，监听状态机 session_status_update completion 信号）查 isSessionActive 非前台时 CAS true。agent-loop 与状态机均不写 unread。
  // ── titled（v0.0.47 新增，AI 起名 CAS gate；详见 auto_naming/[P0]auto_naming_service.md）──
  titled?: boolean;                // [v0.0.47] true = title 已被命名（人工改名 OR AI 起名应用过）；false / 空缺 = title 仍是默认占位「新会话」。**lazy 默认 false，不跑 migration**：AI 起名首 query 触发条件（transcript 无 prior role=user）天然保护所有现存 session（都有 prior user 消息）不被误触发，故无需扫描存量置 true（对齐 bizType/unread lazy 默认先例）。**createSession 强制写 false**（CreateSessionInput 不暴露 titled 字段；session-store.ts:107-111 显式写 false 防御 caller 透传）。**置 true 的两个 timing**：① AI 起名 service 应用 AI 名（auto_naming/[P0]auto_naming_service.md §3 CAS `titled===false → true`）；② 用户改名（PUT /session/:id body.title 路径同步置 true，session-update.ts:37-44 + session.ts:184-195）。**置 true 后永不为 AI 名覆盖**（CAS gate fail → 丢弃）。session 层不感知此字段的语义，只持久化；AI 起名 service 在 auto_naming KB。
  // ── pinned（v0.0.231 新增，会话置顶；仅 playground 列表消费）──
  pinned?: boolean;                // [v0.0.231] true = 已置顶（playground 会话列表：置顶组在前、非置顶组在后，同组内 updatedAt desc——前端 store 统一比较器归位，详见 specs/ui/components/chat-page/_overview.md §4.1）。**lazy 默认 false，不跑 migration**：toSession `r.pinned === true` 规范化（对齐 unread/titled 先例，历史 session 缺省 false）。**写路径唯一 = PUT /session/:id body.pinned**（部分更新透传，同 effort/approvalMode；handler 校验非 boolean → 400 + 写后直调 metaBroadcaster.broadcast → session_meta 广播多端一致）。**pinned-only 更新不推进 updatedAt**（置顶是纯标记操作，不算对话活动——用户裁决 2026-08-01）：`sessionStoreUpdateSession` 对 pinned-only patch 经 `PutOptions.preserveUpdatedAt` 写（`computeEnvelope` upsert 分支保留 existing.updatedAt，version 仍 +1）；含任何非 pinned 字段的 patch 仍正常推进（title 改名等现状不变）。取消置顶后该会话按**原对话时间**在非置顶组归位（可能不在顶部）。session 层不感知 pinned 语义，只持久化；分组/排序纯前端展示层（GET /session 返回顺序契约不变，仍 updatedAt desc）。
  // ── v0.0.56 SessionKind 统一身份维度（v0.0.204 终版瘦身，详见 [P0]session_kind.md）──
  role: 'rocky' | 'leader' | 'mate' | 'squad';  // [v0.0.56] 会话角色（subagent 存 parent.role bloodline）；**[v0.0.208] academy 删除，去 coach/student/trainer**。
  derivation: 'parent' | 'subagent';              // [v0.0.56] 派生层级（parent=顶层/独立，subagent=被派生的子 agent）。**[v0.0.204] main→parent 改名**（语义不变，避免与 RunKind='main' 混淆）。**[v0.0.56] 取代旧 scope 字段**
  biz: 'playground' | 'studio';        // [v0.0.56] 业务分区（替代旧 bizType）；**[v0.0.208] academy 删除，biz 收窄为 playground/studio**。
  // ── RunKind（run 级，不落盘；由 run 装配入口赋予：activate→main / 旁路 run→summary 或 consolidate）──
  // 详见 [P0]session_kind.md §1。原 modeKey 字段 v0.0.204 并入 runKind 退役消失。
  // ── [v0.0.204] SessionContext（实例上下文 ID，与 kind 同源同刻产出但分离字段）──
  // 见 SessionConfig.kind + SessionConfig.sessionContext；SessionStore.getSessionContext(sid) 投影本组字段。
  // ── multi_agent（v0.0.28 新增；[v0.0.56] 字段更新：type→role+derivation，scope 删，parentRole 删）──
  parentSessionId?: string;        // [v0.0.28·顶层] 关联：派生者 session。**两处保持**——顶层（本字段）+ SessionUsageMeta.parentSessionId（见下）；createSession 时顶层值同步写入 SessionUsageMeta，代码保证一致。child 通过本字段知道自己的 parent（send_message('parent') 别名解析路由源）。**[v0.0.33.1]** leader/mate/squad session 的 parentSessionId=null（仅 subagent 有 parent）
  subAgentTemplateType?: string;  // [v0.0.28] 派生自哪个模板标签（如 "explorer"）；仅 derivation=subagent 有意义
  origin?: { spawnRunId: string; toolCallId: string };  // [v0.0.28] 由哪次 spawn 产生（审计/观测）
  subAgentConfig?: {              // [v0.0.28 Bug2 修复] createChildSession 时持久化的 effective config（spawn resolve 出的 systemPrompt/tools/skills/maxIter）。createChildSessionImpl 原只落 session 元信息，eff 字段全丢失→child 用 DEFAULT_SYSTEM_PROMPT + 全集工具；修：createChildSession 写入此字段，buildSessionConfigFromDeps（handlers/session-config.ts）读它覆盖 child SessionConfig。**[v0.0.56] parentRole 字段删除**（role 已带 bloodline role，不再重复持久化）
    systemPrompt: string;
    tools?: string[];
    skills?: string[];
    maxIter?: number;
  };
  // ── v0.0.33.1 squad 增量（详见 specs/tech/squad/[P1]data_model.md §1.4 + specs/tech/agent/session/[P0]session_biztype.md）；[v0.0.56] bizType→biz（必填）+ type→role/derivation ──
  squadId?: string;                    // [v0.0.33.1 新增·optional] 关联 squad（所有 studio session 带：squad/leader/mate/studio 内 subagent）。双向之三：session⇄squad（session 持 squadId 单向，squad 不持 sessionId 列表除 squadChatSessionId + 经 member 间接）。见 data_model.md §2.3
  memberId?: string;                   // [v0.0.33.1 新增·optional] 关联 member（**仅 leader/mate session** 带本字段；squad session 无 memberId；subagent session 无 memberId——它是 member 派生的临时子 agent，不是 member 本身）。双向之二：member⇄session（member.sessionId ↔ session.memberId）。见 data_model.md §2.2
  // ── v0.0.148 session 级 effort 推理强度 + 审批模式 + always approve 持久化（详见 specs/tech/agent/tools/[P0]tool_permission.md §5；specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §3.8）──
  effort?: 'default' | 'low' | 'high' | 'max';          // 推理强度档位（canonical 语义键）。lazy 缺省 'default'（= 不传 wire output_config.effort，模型厂商默认行为）；buildSessionConfigFromDeps 读 → config.effort → encode 注入 wire（low→low / high→high / max→max）。源头唯一 = 本字段，无 per-request 覆盖语义。
  approvalMode?: 'normal' | 'greenlight';               // 审批模式总开关。lazy 缺省 'normal'（按现状 ask 弹审批卡）；'greenlight'（绿灯）= engine.execute ask 分支内短路（视同 allow fall through），deny 路径与执行层沙箱不动。buildSessionConfigFromDeps 注入 config.approvalMode，engine 直读（无 store I/O，与 always 的 approvalKey 粒度正交）。
  alwaysApprovedKeys?: string[];                        // 本会话「永远同意」的 approvalKey 集合（格式 `{toolName}:{policyId}`，如 `bash:rm-wildcard`）。lazy 缺省 []（历史 session 缺字段经 toSession normalize 为 []）。ApprovalManager cache-through backing：isApproved cache miss 读本字段，recordAlways write-through 写本字段（updateSession read-modify-write 去重 merge）。**per-session 持久化**：跨 app 重启保留，换会话重置。**不进 UpdateSessionBody**（无用户直填语义，仅 ApprovalManager 内部写）。
}

/** [v0.0.13] summary 任务旁路状态（compact 用；与五态机正交，独立 CAS） */
interface SummaryTask {
  status: "idle" | "running" | "done" | "failed";
  runId?: string | null;           // 关联的 run（compact 触发时所在的 AgentLoop.runId；可选，便于观测）
  startedAt?: string | null;       // ISO 8601；markSummaryRunning 时设
  error?: string | null;           // markSummaryFailed 时设
}

/** Session 运行态六态（v0.0.12 起五态 + v0.0.101 加 suspended；权威定义 + CAS API + 转换表见 [P0]session_state.md） */
type SessionState = "idle" | "running" | "interrupting" | "interrupted" | "error" | "suspended";

/** 一次 AgentLoop.start() 对应一个 Run */
interface Run {
  id: string;            // ULID = AgentLoop.runId
  sessionId: string;
  status: "running" | "completed" | "failed" | "paused" | "interrupted";  // [v0.0.12] 加 interrupted（abort 收尾 / 崩溃恢复）
  stopReason?: StopReason;   // 见 ../agent_interface_and_loop/[P0]agent_loop_eager_drain.md（StopReason 联合 v0.0.12 加 "interrupted"）
  errorInfo?: RunErrorInfo;  // v0.0.25 rev2：run 失败结构化错误（仅 stopReason="error" 时填，可后置 updateRun 写；类型见 session-store-types.ts `RunErrorInfo`）
  startedAt: string;
  endedAt?: string;
  contextWindowUsage?: ContextWindowUsage;   // run 级：loop 结束落的 snapshot contextWindowUsage（见 context_usage_detail §7）
}

/** session 级 usage 存储（三分区 + ratio + contextWindowUsage）；聚合 view 见 session_usage.md §8 */
interface SessionUsageMeta {
  current: AccumulatedUsage;     // 当前 session 自己 loop 的调用 Σ
  sub: AccumulatedUsage;         // sub agent Σ
  forked: AccumulatedUsage;      // forked agent（compact / memory 整理）Σ
  ratio: RatioWindow;            // char/token ratio 学习窗口（仅 current 喂，见 session_usage.md §7）
  contextWindowUsage: ContextWindowUsage;  // session 级最新（updateContextWindowUsage 写）
  parentSessionId?: string;      // [v0.0.28·两处保持之一] 子 agent session 的父 session id（递归 sub 上报用，见 session_usage.md §6.2）。**两处保持**——本字段（usage 递归路径）+ Session.parentSessionId 顶层（child 自查 parent 路由用，见上 §2 Session）；createSession 时由顶层值同步写入，代码保证一致
}

/** char/token ratio 窗口（per-session） */
interface RatioWindow {
  samples: number[];     // 最近 3 个 ratio sample（已 clamp [0.2, 5.0]）
  current: number;       // 中位数；窗口未满用 1.0（冷启动）
}

type UsagePartition = "current" | "sub" | "forked";   // 见 [P0]session_usage.md §3
```

> **[v0.0.8 实现基线 — usage 简化]**：v0.0.8 **不累计 / 不展示** AccumulatedUsage，但**保留方法签名**对齐 spec。简化口径（详见 `specs/tech/version_logs/v0.0.8/change_log.md` §1/§6）。
>
> **[v0.0.14 supersede]**：以下 no-op 标注**已过期**——v0.0.14 `accumulateUsage` / `getRatio` / `getUsageView` **全部激活**（三分区真累加、ratio 真学（3 轮收敛，冷启动 1.0）、view 真聚合、`session_usage_update` event 真发）。仅 Run record per-run usage 字段仍 future。详见 `specs/tech/version_logs/v0.0.14/change_log.md` + `../session/[P0]session_usage.md §10`。下面 v0.0.8 行保留作历史快照参考。
> - `accumulateUsage(sid, type, usage)` → **no-op**（type 形参保留，不写 session.usage 的 current/sub/forked 分区）。
> - `updateContextWindowUsage(sid, cw)` → 写 `session.contextWindowUsage`（**仅用于 compact 触发判定**，agent_loop 据此判 `remainingTokens < 0`）。
> - `getRatio(sid)` → **始终返回 1.0**（不学 ratio，RatioWindow future，见 `[P0]session_usage.md` §7）。
> - `getUsageView(sid)` → **返回零值 view**（current/sub/forked 全零 AccumulatedUsage）。
> - `persistUsage(sid, runId, cw)` → 写 `run.contextWindowUsage`（保留 run 级快照，作 AT/ET 观测）。
> - `Session.usage` 字段保留（SessionUsageMeta 形态不变，但 v0.0.8 的 current/sub/forked 累计值恒为零，ratio.current = 1.0）。
> - **SchemaDef 落盘**：v0.0.8 落 `session` / `message`(transcript) / `summary` / `run` 四 schema，**不落** raw / tool_result（ingest 不 offload，见 `../context/[P0]context_ingest_detail.md` v0.0.8 标注）。

## 3. 内容概念组与存储规则

session 存 4 类内容（`message` 是逻辑概念，不单独建表 —— 见 `[P0]session_concepts.md`）：

| 内容 | 单位 | pk | 存储规则 | 写入方（context 委托） |
|---|---|---|---|---|
| **transcript** | message | `(sessionId, messageId)` | **总存**（主存储规范记录） | ingest |
| **summary** | 单值/会话 | `(sessionId)` | **总存**（snapshot 用） | compact |
| **raw** | message 形态（item） | `(sessionId, contentId)` | **仅 offload 时存** | ingest（truncate 原文） |
| **tool_result** | message 形态（item） | `(sessionId, contentId)` | **仅 offload 时存** | ingest（truncate 工具结果 / 过长 tool call 参数） |

> **item = 整个 message 级**：raw / tool_result 存的是一个 message 形态的快照（读出可能是局部 json，可接受）。
> raw 与 tool_result 共享「offload 的大内容」语义，但在 session 侧不叫 offload，就是两类内容各自 save/get、查 pk。

## 4. SessionStore 接口（统一）

> **v0.0.156 起：facade 实现模式**——`app/server/src/agent/session-store.ts`（313 行）是 SessionStore class 的 **facade**（constructor + 字段声明 + 21 method 签名 + 方法体单行委托 `return sessionStoreXxx(this, ...)`），方法实现拆到 4 impl 文件：`session-store-core-impl.ts`（core 8 方法：createSession/getSession/getSessionKind/updateSession/listSessions/deleteSession/fallbackCascadeDelete/stripEnvelope）+ `session-store-messages-impl.ts`（runs+messages 7 方法）+ `session-store-usage-impl.ts`（summary+usage 8 方法）+ `session-store-children-impl.ts`（listChildren）。**公开 API 100% 等价**（消费方零改，INV-S-3）；impl 函数首参 `(store: SessionStore, ...)`，内部经 `store.crud/statusBus/childrenIndex` 访问依赖（字段为 `readonly` public，与 `readonly stateMachine` 同款；facade 化的必要偏离，见 `log.md` v0.0.156 节 + `version_logs/v0.0.156/change_log.md`）。

```typescript
interface SessionStore {
  // ── Session ──
  createSession(session: Session): Promise<void>;
  getSession(sessionId: string): Promise<Session | null>;
  /** [v0.0.56+v0.0.204] 构造 SessionKind 统一身份维度对象（读 session record → 构造 biz/role/derivation；runKind 由 run 装配入口赋予，不在此赋值）。
   *  所有 session 类型判别统一读此方法产出（替代散落 45 处 if/switch）。 */
  getSessionKind(sessionId: string): Promise<SessionKind>;
  /** [v0.0.204] 构造 SessionContext（实例上下文 ID，与 kind 同一构造点产出；读 session record → 投影 squadId/memberId/parentSessionId/classroomId/coachId/studentId）。
   *  runKind 不在此（record 无此字段，由 run 装配点补：activate→main / 旁路 run→summary 或 consolidate）。
   *  与 getSessionKind 同源同刻产出 `{ kind, context }`，两字段分离（SessionConfig.kind + SessionConfig.sessionContext）。 */
  getSessionContext(sessionId: string): Promise<SessionContext>;
  updateSession(sessionId: string, patch: Partial<Session>): Promise<void>;
  /** [v0.0.28] 列 parent 派生的 children（subagent），按 state 分 running/terminated 两组
   *  （api 10-multi-agent §3 / subagent_derivation §7 权威）。
   *  [v0.0.30] 实现用内存正向索引 Map<parentSid, Set<childSid>>（`session-children-index.ts`
   *  ChildrenIndex），lazy 建（首次扫全量）+ createSession/deleteSession 增量维护，O(children)；
   *  替代之前全量 scan+filter parentSessionId 的 O(N)（subagent 无限膨胀会慢）。parentSessionId
   *  创建后不可变，故只需 create/delete 维护一致性；deleteSession(parent) 不级联删 children（孤儿）。 */
  listChildren(parentSid: string, filter?: ListChildrenFilter): Promise<ChildrenView>;

  // ── [v0.0.192] 级联删 / squad 平铺查（删除链路修正：保工作产出 + 堵潜伏调度）──
  /** BFS 收集 parent 的全部子孙 id（任意深度，不含 parent 自身）。级联删用：删 parent 前先快照子孙，
   *  caller（DELETE /session/:id + dissolveSquad）逐个 deleteSession（每触发 onSessionDestroyed → 清内存 cron）。
   *  纯索引操作（不读 crud / 不做 I/O），visited Set 去环防重；idx 未建（lazy warm 未触发）返 []。
   *  MUST 在任何 deleteSession 之前调用（onDeleted 会清 parent 自己的 child set，删后再查会漏子孙）。
   *  impl: session-store-children-impl.ts `sessionStoreCollectDescendants`（warm 后委托 `ChildrenIndex.collectDescendants`）。 */
  collectDescendants(parentId: string): Promise<string[]>;

  /** 按 `Session.squadId` 平铺查全量 session id（含 spawn children——child record 自带 squadId）。
   *  dissolveSquad 用：解散时一次性快照全部 squad session（step② 逐个 deleteSession）；O(N) 扫描可接受（解散低频）。
   *  MUST 在删任何 session 前调用（删后 listSessions 不返）。
   *  impl: session-store-children-impl.ts `sessionStoreListSessionsBySquad`（直接 crud.query SessionSchema filter squadId）。 */
  listSessionsBySquad(squadId: string): Promise<string[]>;

  // ── Session 运行态（v0.0.12；CAS 原子条件写，权威见 [P0]session_state.md §3）──
  /** activate 用：CAS state ∈ {idle, interrupted, error, suspended} → running + 设 currentRunId；返 true=成功。
   *  [v0.0.101] WHERE 加 'suspended'：回填 tool_reply 或新 user query 进 inbox 时从 suspended 激活（O6 闸门） */
  markRunning(sessionId: string, newRunId: string): Promise<boolean>;
  /** [v0.0.101] HITL 悬挂用：CAS currentRunId=expectedRun AND state=running → suspended + running=false（清 currentRunId）。
   *  生产者唯一 = MainLifecyclePort.onRunEnd stopReason='tool_pending' 分支。recover 靠 pendingToolCalls 落盘（不靠 currentRunId）。 */
  markSuspended(sessionId: string, expectedRunId: string): Promise<boolean>;
  /** abort step1 用：CAS currentRunId=expectedRun AND state=running → interrupting + 清 currentRunId */
  markInterrupting(sessionId: string, expectedRunId: string): Promise<boolean>;
  /** abort step4 用：CAS state=interrupting → interrupted + running=false */
  markInterrupted(sessionId: string): Promise<boolean>;
  /** loop run_end(正常) 用：CAS currentRunId=expectedRun AND state=running → idle + 清 currentRunId */
  markIdle(sessionId: string, expectedRunId: string): Promise<boolean>;
  /** loop run_end(error) 用：CAS currentRunId=expectedRun AND state=running → error + running=false */
  markError(sessionId: string, expectedRunId: string): Promise<boolean>;
  /** 启动扫描：state ∈ {running, interrupting} → idle + 清 currentRunId + Run.status=interrupted。
   *  [v0.0.101] **不动 suspended**：suspended 是合法存活态，保留 + 校验 pendingToolCalls 落盘一致（不清 idle，INV-3）。 */
  reconcileOnStartup(): Promise<{ reconciled: string[] }>;

  // ── [v0.0.101] HITL pending 队列 API（落盘 + peek + resolve）──
  /** 返队首 status='pending' 单条（深拷贝，只读快照）；空队列返 null。GET /pending-tool-call + 前端 recover 用。
   *  INV-4 peek 队首单条：多 pending 串行展示，前端一次渲染一张卡。 */
  peekPendingToolCall(sessionId: string): Promise<PendingToolCall | null>;
  /** 覆盖写整个 pendingToolCalls 数组（runReActLoop ③ 段初次落盘 + c 路径清空用）。 */
  setPendingToolCalls(sessionId: string, pending: PendingToolCall[]): Promise<void>;
  /** 按 toolCallId splice 队首一项（handleToolReply 回填后调）；返被删的项或 null（未匹配）。 */
  resolvePendingToolCall(sessionId: string, toolCallId: string): Promise<PendingToolCall | null>;

  // ── summaryTask（v0.0.13；旁路 CAS，不进五态机，权威见 [P0]session_state.md §3a）──
  /** compact 进入用：CAS summaryTask.status ∈ {idle, done, failed} → running + 设 runId/startedAt；返 true=成功 */
  markSummaryRunning(sessionId: string, runId: string): Promise<boolean>;
  /** compact 成功用：CAS summaryTask.status=running → done + 清 error */
  markSummaryDone(sessionId: string): Promise<boolean>;
  /** compact 失败用：CAS summaryTask.status=running → failed + 设 error */
  markSummaryFailed(sessionId: string, error: string): Promise<boolean>;
  /** 手动复位 / 启动清理用：无条件（仅扫 status=running）→ idle + 清 runId/startedAt/error */
  markSummaryIdle(sessionId: string): Promise<boolean>;
  /** [v0.0.13] 启动扫描 summaryTask 残留：status=running → idle（崩溃恢复一致性，见 ../../app/start_up/[P0]startup_reconcile.md §2.2） */
  reconcileSummaryTaskOnStartup(): Promise<{ reconciled: string[] }>;

  // ── Run ──
  createRun(run: Run): Promise<void>;
  getRun(sessionId: string, runId: string): Promise<Run | null>;
  updateRun(sessionId: string, runId: string, patch: Partial<Run>): Promise<void>;
  getRuns(sessionId: string): Promise<Run[]>;

  // ── transcript（总存）──
  appendMessages(sessionId: string, messages: Message[]): Promise<void>;
  getMessages(sessionId: string, range?: MessageRange): Promise<Message[]>;
  getMessagesByRun(sessionId: string, runId: string): Promise<Message[]>;

  // ── summary（总存，单值）──
  getSummary(sessionId: string): Promise<SummaryInfo | null>;
  setSummary(sessionId: string, summary: SummaryInfo): Promise<void>;

  // ── 大内容（raw / tool_result，仅 offload 时存）──
  /** 存一条大内容；检查 pk (sessionId, type, contentId) 冲突（见 §5） */
  saveContent(sessionId: string, type: ContentType, contentId: string, payload: ContentPayload): Promise<void>;
  /** 取回；offset/limit 支持分页读回（内容可能很长） */
  getContent(sessionId: string, type: ContentType, contentId: string, range?: { offset?: number; limit?: number }): Promise<ContentPayload | null>;
  dropContent(sessionId: string, type: ContentType, contentId: string): Promise<void>;

  // ── Usage（session 级三分区 + ratio + contextWindowUsage；view/接口见 session_usage.md）──
  // [v0.0.44] write / notify 分离：write ops 不 emit；由独立 notifyUsageChanged 通知。
  /** Σ 累加某分区（读该分区 + usage 各字段、llmCallCount++、写回）；type = current/sub/forked
   *  [仅 current] 顺带学 ratio（sample = usage.input_total_tokens / usage.inputCharCount → 窗口；见 session_usage.md §7）
   *  [内部] if sid 有 parentSessionId → 递归 accumulateUsage(parent, "sub", usage)（见 session_usage.md §6.2）
   *  [v0.0.44] **不 emit**；返回 sid 链（含自身 + 递归 parent，顶层最后），供调用方 batch notify。 */
  accumulateUsage(sessionId: string, type: UsagePartition, usage: Usage): Promise<string[]>;
  /** 更新 session 级 context window usage（assemble 后由 context engine 调）；[v0.0.44] **纯 write，不 emit** */
  updateContextWindowUsage(sessionId: string, cw: ContextWindowUsage): Promise<void>;
  /** [v0.0.44] 通知：读 getUsageView(sid) 全量 view → emit `session_usage_update`（topic=session_panel, group=`session_id:<sid>`）；
   *  由 write ops 调用方（context / agent loop）在 write 完成后显式触发，保证 event.data 与 GET /usage 同源同全（session_usage.md §3/§6/§10） */
  notifyUsageChanged(sessionId: string): Promise<void>;
  /** 读当前 ratio（context 估算用） */
  getRatio(sessionId: string): Promise<number>;
  /** 聚合视图（三分区 + total + contextWindowUsage），见 session_usage.md §8 */
  getUsageView(sessionId: string): Promise<SessionUsageView>;
  /** run 结束落 run 级 contextWindowUsage（snapshot 产物；run 快照，区别于 session 级 updateContextWindowUsage） */
  persistUsage(sessionId: string, runId: string, cw: ContextWindowUsage): Promise<void>;
  /** [v0.0.16] 清空 session 内容（保留实体），单事务 + store 内 emit 三事件，见 session_clear.md
   *  [v0.0.66] 命名分离：与 SessionStoreContract.releaseSlot 不同——本方法删整 session 返 Session（HTTP handler 用）；
   *  releaseSlot 仅清 forked in_memory_session_store 的 Map slot（forked run 结束 caller 调，default scope 永不调）。 */
  clearSession(sessionId: string): Promise<Session>;

  // ── workspace（v0.0.17 新增；详见 [P0]session_workspace.md §2.2）──
  /** [v0.0.17] 切换 session 工作目录（更新 workspaceDir + 持久化 + emit session_workspace_dir_changed）。
   *  - 不负责重启 watch（[v0.0.139] 懒监听：SessionWorkspaceManager.switchDir 先 recycleSession 回收旧目录全部监听 → 再 setWorkspaceDir；不重启，前端收 dir_changed 后重新 watch 新根）。
   *  - 校验 newDir 绝对路径 + 存在 + 是目录（否则抛错）。 */
  setWorkspaceDir(sessionId: string, newDir: string): Promise<void>;

  // ── 未读（v0.0.27 新增，显式 bool 模型；**产生+消除都在 session 层**；权威见 [P0]session_state.md §6）──
  /** [v0.0.27] 标记 session 已读：CAS 无条件 unread = false。
   *  - 唯一消除未读入口（**消除归属 session 层**：POST /session/:id/read handler 调本方法）。
   *  - 与「产生未读」（session 层 SessionUnreadOps runtime 监听状态机 completion 信号自治）一并构成两离散 timing。
   *  - 触发点：POST /session/:id/read 端点（用户进入会话显式标读；详见 specs/api/overall/04-agent-session.md §2.3.1）。
   *  - 不依赖任何 timestamp 比较（explicit-bool 模型，直接置 false）。
   *  - 写完 emit session_read_update（topic=session_panel，data={unread:false}）。 */
  markRead(sessionId: string): Promise<{ unread: boolean }>;
}

type ContentType = "raw" | "tool_result";

interface MessageRange {
  fromId?: string;        // 起始 message id（含）
  upToId?: string;        // 结束 message id（含）
  limit?: number;
  beforeId?: string;      // 分页：取该 id 之前
  takeFromStart?: boolean; // [v0.0.185] 取范围头部 limit 条（缺省 false=取尾部；无 beforeId 时生效；head 候选锚定会话真第一条用）
}

/** 大内容载体：一个 message 形态的快照 */
interface ContentPayload {
  contentId: string;      // 逻辑 key（如 messageId / toolCallId）
  message: Message;       // item = 整 message 级
  size: number;           // 字节数（便于预算/分页）
  createdAt: string;
}
```

> **读写分离（可选视图）**：外部只读消费者（UI / API / 其他 agent）可只暴露 `get*` 子集作为只读视图（原 SessionQuery 职责并入，不另立接口）；写入路径（append/save/createRun/persistUsage）由 context engine / agent loop 调。

## 5. pk 检查（save 语义）

`saveContent` / `appendMessages` 写入时检查主键冲突：

- **transcript**：`(sessionId, messageId)` 撞 id → 默认拒绝（append-only）；覆盖需显式 allowEdit（见 `../context/[P0]context_ingest_detail.md` §6）。
- **raw / tool_result**：`(sessionId, type, contentId)` 撞 → 幂等（同 contentId 视为已存，不重复写）或拒绝，由实现定；contentId 通常是 messageId / toolCallId，天然唯一。

## 6. 持久化后端

SessionStore 底经 `persistence` 的 CrudStore（每类内容一个 SchemaDef，engine file/sqlite 由各 SchemaDef 声明，per-schema 待定）。

- transcript：高基数，按 `sessionId` 分片（见 `persistence/[P0]fs_crud_store_engine.md` sharding）。
- raw / tool_result：仅 offload 时落，稀疏。
- **无独立 blob store**：raw / tool_result 作为普通 CrudStore 实体存储（item = message），不再是「session 独立 blob store」（废弃旧 off-store 概念）。

## 7. 边界

| 零件 | 归属 |
|---|---|
| 存什么 / 取什么 / pk 检查 | 本文件（SessionStore）✅ |
| 何时 offload、offload 什么、与 truncate/compact 协作 | context（见 `../context/[P0]context_ingest_detail.md`） |
| 大内容分页读回的 context 侧工具 | `context loader`（见 `../context/[P0]context_ingest_detail.md`） |
| 概念组定义（raw/transcript/tool_result/summary） | `[P0]session_concepts.md` |
| CRUD / engine / 分片机制 | `../../persistence/` |

## 8. 版本

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。未读模型选型（watermark → explicit-bool）决策见 `specs/tech/version_logs/v0.0.27/unread-model-decision.md`。
