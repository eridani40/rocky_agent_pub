---
type: index
title: Session 子系统总起
priority: P0
updated: 2026-08-01
---

# Session 子系统总起

## ① 是什么

session 子系统 = agent **会话的全部状态与存储权威**。`SessionStore` 统一管 transcript / summary / raw / tool_result / run 五类内容 + Session 运行态（六态机，[v0.0.101] 加 suspended）+ usage 三分区 + workspace + 未读 + bizType + **[v0.0.55] 后台任务互斥锁（SessionTaskLock）**+ **[v0.0.101] HITL 悬挂队列 pendingToolCalls 落盘**。是 ContextEngine / AgentLoop 的**存储后端**，也是 session 面板的 **meta 事件源**。

| 核心概念 | 一句话 |
|---|---|
| **Session** | 会话实体（id/config/state/usage/workspaceDir/bizType + multi_agent 派生字段） |
| **SessionStore** | 统一存储 + 检索层（所有内容写入经 context 委托；底经 persistence CrudStore） |
| **transcript** | 每个 message **首次发给 LLM 时**冻结的规范记录（主存储） |
| **六态机** | idle / running / interrupting / interrupted / error / **suspended**（[v0.0.101] HITL 悬挂态）+ CAS 原子条件写 |
| **[v0.0.101] pendingToolCalls** | Session 落盘字段：悬挂型 tool 调用队列（loop 退出 + suspended 时持久化；peek/set/resolve API） |
| ~~**summaryTask**~~ | ~~compact 旁路 CAS~~ **[v0.0.55] 废弃**，被统一 SessionTaskLock subsumes（见下） |
| **[v0.0.55] SessionTaskLock** | per-session × per-task 内存锁（compact / tier1 / 后续同类）；CAS 语义；不落盘；subsumes summaryTask |
| **SessionEvent** | `session_panel`（per-sid，chat 页）+ `session_meta`（广播 `_all`，列表）双 topic |
| **Usage 三分区** | current / sub / forked（store 桶名保留）累加 + RatioWindow 学习 + 递归 sub 上报 parent；v0.0.204 profile.runShape.usagePartition（current/sub/summary/consolidate）经 mapUsagePartition 映射到 store 三分区（summary/consolidate 落 'forked' 桶） |
| **workspaceDir** | session 关联的真实 FS 工作目录（持久化，LLM 工具默认根 + watch 根） |
| **bizType** | `playground` \| `studio`（GET /session 列表隔离） |
| **[v0.0.56+v0.0.204] SessionKind** | 统一 session 身份维度对象 = biz/role/derivation（落盘）+ runKind（run 级不落盘，由 run 装配入口赋予）；v0.0.204 终版概念：瘦身（删实例 ID 字段、toolPolicyRole getter）+ Derivation `main`→`parent` 改名 + RunKind 扁平闭合枚举（main/summary/consolidate 替代 modeKey）+ forked 命名体系退役 |
| **[v0.0.204] SessionContext** | 实例上下文 ID（squadId/memberId/parentSessionId），与 kind 分离但结伴传递；SessionStore.getSessionContext(sid) 投影 |
| **[v0.0.204] SessionTypeProfile** | agent 行为契约配置层（`app/plugins/session-types/*.yaml`）+ SessionTypePolicy 读取接口；替代此前 5 键并存（scopeId 路由表 / TOOL_POLICY 等）——见 `[P0]session_type_profile.md` |
| **unread** | 显式 bool 存储值（非 timestamp 派生）；产生 + 消除都在 session 层 |
| **pinned** | 会话置顶标记（lazy 默认 false 无 migration）；仅 playground 列表消费——置顶组在前、同组内 updatedAt desc，分组/排序纯前端展示层归位；pinned-only 更新不刷 updatedAt（纯标记，经 `PutOptions.preserveUpdatedAt`） |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| Session/Run interface + 所有内容存取 + pk 检查 | ContextEngine 何时调用 ingest/assemble/compact（→ `../context/`） |
| 六态机 CAS API + reconcileOnStartup（保留 suspended）+ summaryTask CAS + [v0.0.101] pendingToolCalls API | AgentLoop run 生命周期 + activate 内部（→ `../agent_interface_and_loop/`） |
| SessionEvent / SessionMetaEvent 类型 + 触发时机 | event_bus / event_hub transport（→ `../event/`） |
| Usage 类型 + 三分区存储 + 递归上报 + view + ratio | usage 调用时机 + char×ratio 估算（→ `../context/[P0]context_usage_detail.md`） |
| workspaceDir 字段 + 切换语义 + clearSession | abort 4 步收尾（→ `../agent_interface_and_loop/[P0]agent_interrupt.md`） |
| bizType 二分 + 隔离规则 + 未读 explicit-bool 模型 | HTTP 端点契约（→ `specs/api/overall/`）+ UI（→ `specs/ui/`）+ CrudStore engine（→ `../../persistence/`） |

## ③ 与系统的关系

```
                  ┌── context/         (ContextEngine 委托写 transcript/summary/raw；读 getRatio/getUsageView)
                  │
                  ├── agent_interface_and_loop/  (AgentLoop run_end → markIdle/markError；activate → markRunning)
                  │
   session KB ────┼── event/           (event_bus + event_hub transport + replay)
   (本目录)        │
                  ├── persistence/     (CrudStore FS engine + 按 sessionId 分片)
                  │
                  ├── multi_agent/     (parentSessionId / scope / subAgentConfig 派生字段)
                  │
                  └── squad/           (bizType=studio + type=squad/leader/mate + squadId/memberId)
```

**对外协作点**：
- SessionStore 落 `app/server/src/agent/session-store.ts`；状态机落 `session-state-machine.ts`；事件类型落 `session-event-types.ts` + `session-meta-broadcaster.ts`。
- usage helper 落 `session-usage-helper.ts`；workspace manager 落 `session-workspace-manager.ts` + `session-workspace-store.ts`；clear 落 `session-clear-op.ts`；未读 runtime 落 `session-unread-ops.ts` + `session-unread-runtime.ts`。
- Schema 落 `app/server/src/agent/schema_defs/`；类型落 `session-store-types.ts`。

## ④ 核心设计原则（跨文件不变量）

1. **session 管所有存储**——写入由 context engine 委托（agent → context → SessionStore），读取多场合直读；offload 不是 session 概念。→ `session_store.md` §1
2. **六态机 CAS 原子写**——所有状态转换只由 agent loop(run_end) / abort api / activate 三者设置（无其他写入路径）；CAS WHERE 子句防并发交错。[v0.0.101] 加 markSuspended（CAS currentRunId=expected AND state=running → suspended）+ markRunning WHERE 加 suspended（回填激活）+ reconcileOnStartup 保留 suspended（合法存活态）。→ `session_state.md` §2/§7
3. **running bool 与 state 同步**——`state∈{running, interrupting} ⇔ running=true`（冗余字段，高频查询用）。→ `session_state.md` §1
4. **[v0.0.55] 后台任务互斥用 SessionTaskLock（subsumes summaryTask；v0.0.80.t1 tier1 实接）**——compact / tier1 / 后续同类任务用 per-session × per-task 内存锁（CAS 语义）；**不落盘**（客户端产品决策：磁盘锁=幽灵锁，重启自然清空）；不动五态机；HTTP 409 行为不变。原 v0.0.13 summaryTask 旁路 CAS 废弃（持久化字段 + markSummary* 方法删除）。**[v0.0.80.t1] tier1_consolidation 锁实接**：`MemorySkillConsolidationHandler.handle` 内部 acquire/markDone/markFailed（compact + tier1 同 session 可并行，写入域正交）。→ `session_task_lock.md` + `session_state.md §3a`（废弃标注）
5. **transcript = 首次发给 LLM 时冻结**——同一条 message 在 transcript 里永远是它第一次被 LLM 看到的样子；落库后不可变（仅 allowEdit 覆盖）。→ `session_concepts.md` §1.2
6. **未读 explicit-bool，产生 + 消除都在 session 层**——`unread` 是存储值非派生；markRead 唯一消除入口；产生由 SessionUnreadRuntime 监听 completion 信号自治（agent-loop / 状态机不参与）。→ `session_state.md` §6
7. **parentSessionId 两处保持**——`Session.parentSessionId`（顶层，child 路由）+ `SessionUsageMeta.parentSessionId`（usage 递归上报），createSession 同步写入。→ `session_store.md` §2 + `session_usage.md` §9
8. **[v0.0.56+v0.0.204] SessionKind 统一对象 + 实例 ID 拆 SessionContext**——session 构建时一次产出 `getSessionKind(sid)`（身份层，自包含）+ `getSessionContext(sid)`（实例上下文 ID）；身份维度 biz/role/derivation 落盘 + runKind run 级不落盘（由 run 装配入口赋予）；trainer（v0.0.204 升格）= 独立 parent Role（非派生 subagent）。**v0.0.204 终版**：Derivation `main`→`parent` 改名；RunKind 扁平闭合枚举（main/summary/consolidate 替代 modeKey）；实例 ID 拆 SessionContext；ToolPolicyRole getter 删除（职责归 SessionTypePolicy，见 `[P0]session_type_profile.md`）；`Session.type`/`scope`/`subAgentConfig.parentRole` 完全删除。→ `session_kind.md` + `session_type_profile.md`
9. **[v0.0.47] titled 字段（lazy 默认 false，不跑 migration）**——`titled?: boolean` 区分「title 是默认占位还是已被命名」。AI 起名应用条件 = `titled===false` → 应用后置 true；PUT /session/:id body.title 路径也置 true（手动改名）。lazy 默认 false 是安全的：AI 起名**首 query 触发条件**（transcript 无 prior role=user）天然保护所有现存 session（都有 prior user 消息）不被误触发，故无需扫描存量。AI 起名 service 本体见 `../auto_naming/`（本 KB 只定义字段 + PUT title 路径）。→ `session_store.md` §2 + `auto_naming/index.md` ④
10. **[v0.0.139 + v0.0.271] SessionWorkspaceManager 懒监听（目录级非递归 watcher + tab 关注集合 + 引用计数；取代 v0.0.85 递归模型）**——监听集合 = **关注集合 = 所有打开节点自身 + 各自一级子文件夹（含空文件夹）**（chokidar `depth:0` 非递归；v0.0.271 修 BUG-fs-watch-empty-folder-no-expand：空文件夹从未展开 → 无 watcher → 新增文件无事件）。**v0.0.271 起声明式 watch-set**：前端 `computeWatchSet` 全量重算 → `applyWatchSet`（POST watch-set）→ 后端 registry.setTabSet diff 增删，**不在新集合一律 close（结构性泄漏收敛）**；v0.0.139 的 `watch`/`unwatch` 增量端点保留兼容（release-all 仍用）。tab 消失回收：两层触发（① 前端显式 `releaseTab` 优雅回收；② `session_panel` 订阅 1→0 经既有 unsubscribe 钩子 `recycleSession` 兜底）。监听成本与树大小彻底解耦（`.venv` 不展开零成本，扫描风暴结构性消失），**不再依赖 ignore 名单兜性能**。tab 身份=前端 `clientId`（非复用 SSE subId）；目录 refcount 合并多 tab（只 1 物理 watcher）；watch-set 幂等（同集合 diff 全空 no-op）；GET tree **绝不隐式 watch**；同 (sid,absDir) create/close **串行化防重入**（Bun FSEvents close 竞态段错误面）。保留 `await waitForChokidarReady(5000)`（超时 resolve 不抛，导出供 UT 直测）；**移除** addDir→`watcher.add` 自动递归（懒监听下新子目录只 emit addDir 显示、不自动 watch，展开才 acquire）。→ `session_workspace_manager.md`
11. **[v0.0.164.memory_opt] app 级后台任务互斥用 AppTaskLock（形态照抄 SessionTaskLock 扩到 app 级）**——tier2 天级整理 + 未来其他 app 级任务（backup/cleanup 等）用 `AppTaskLock`（`Map<taskType, state>` 单层，去 sessionId 维度）；**独立 class**（不复用 SessionTaskLock 扩 sid='__app__'）三大理由：(1) API 类型层强制，不需 sessionId 入参哨兵；(2) emit 目标不同——SessionTaskLock emit `(session_panel, session_id:<sid>)` per-sid，AppTaskLock emit `(app_task, _all)` 全局广播；(3) bootstrap 独立单例装配（同 store-phase 相邻）。CAS 语义 + 不落盘 + 三不 emit 原则完全对齐 SessionTaskLock。撞车语义：cron `fire()` + 手动 `POST /consolidation/run` 都 acquire 同 taskType，后到者返 false（cron 静默跳过 + 不推进 lastFiredAt；HTTP 返 409 `consolidation_in_progress`）。→ `app_task_lock.md` + `../memory/[P0]consolidation_tier2.md §7`

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 链接 |
|---|---|---|
| **存储 / 概念** | | |
| `session_kind.md` | **[v0.0.204 终版]** SessionKind 瘦身（biz/role/derivation + runKind）+ SessionContext（实例 ID）+ 两层校验 K1-K5/C1-C7 + trainer 独立 parent | [link]([P0]session_kind.md) |
| `session_type_profile.md` | **[v0.0.204 新]** SessionType Profile 配置层（`app/plugins/session-types/*.yaml`）+ SessionTypePolicy 接口 + extends 继承 + enabled 门 + 扩展流程 + 打包护栏 | [link]([P0]session_type_profile.md) |
| `session_store.md` | Session/Run interface + SessionStore 统一 API（含 getSessionKind/getSessionContext 投影）+ pk 检查 + multi_agent/bizType 字段 | [link]([P0]session_store.md) |
| `session_concepts.md` | 内容概念（raw/transcript/tool_result/summary）+ truncate vs snip + snip 状态 | [link]([P0]session_concepts.md) |
| **运行态** | | |
| `session_state.md` | 五态机 + CAS API + reconcileOnStartup + 未读 explicit-bool 模型 + ~~summaryTask 旁路 CAS~~（[v0.0.55] 废弃，迁 `session_task_lock.md`） | [link]([P0]session_state.md) |
| **[v0.0.55] 任务锁** | | |
| `session_task_lock.md` | per-session × per-task 内存锁（compact / tier1 / 后续）+ CAS 语义 + 不落盘 + subsumes summaryTask | [link]([P0]session_task_lock.md) |
| `app_task_lock.md` | **[v0.0.164.memory_opt]** app 级 × per-task 内存锁（tier2_consolidation / 未来 backup 等）+ CAS 语义 + 不落盘 + emit `consolidation_task_update` to `(app_task, _all)` group（照抄 SessionTaskLock 扩到 app 级） | [link]([P0]app_task_lock.md) |
| `session_clear.md` | clearSession（清空内容保留实体）+ clear vs delete 边界 + 并发处理 | [link]([P0]session_clear.md) |
| **事件 / usage** | | |
| `session_event.md` | SessionEvent（session_panel per-sid）+ SessionMetaEvent（session_meta 广播）+ 触发时机全集 | [link]([P0]session_event.md) |
| `session_usage.md` | Usage/AccumulatedUsage 类型 + 三分区存储 + 递归 sub 上报 + 聚合 view + ratio 学习 | [link]([P0]session_usage.md) |
| **workspace / biz** | | |
| `session_workspace.md` | workspaceDir 字段（持久化）+ 初始目录策略 + 切换语义 + 历史兼容 | [link]([P0]session_workspace.md) |
| `session_workspace_manager.md` | **[v0.0.139+v0.0.271]** SessionWorkspaceManager 懒监听（目录级非递归 watcher + 关注集合 = 打开节点自身 + 一级子文件夹含空 + 声明式 watch-set diff + 引用计数 + 两层回收 + 100ms debounce） | [link]([P0]session_workspace_manager.md) |
| `session_biztype.md` | bizType 二分（playground\|studio）+ 隔离规则 + 传递规则 + lazy 默认 | [link]([P0]session_biztype.md) |

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
>
> **[v0.0.47] 关联 KB**：AI 起名 service（消费 titled 字段做 CAS gate + 触发 broadcast）见 `../auto_naming/index.md`。titled 字段定义在本目录 `[P0]session_store.md §2`，本 KB 不重复起名 service 内部逻辑。
