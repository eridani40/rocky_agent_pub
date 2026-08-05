---
type: index
title: Observability 子系统总起
priority: P0
updated: 2026-08-04
---

# Observability 子系统总起

## ① 是什么

Observability = agent 执行的**横切追踪能力**——记录每次 run 的 LLM 调用、tool 执行、耗时与用量，供事后分析 / 调试 / 成本审计。v0.0.24 起增加第二用途：**作为验证 oracle**（api verifier 读 langfuse trace 独立断言「agent 做对了吗」）。另有第三条独立链路：**跨三进程卡顿监控**（hang monitor，§⑤ 导航末行）——检测 event loop 卡顿并抓 CPU profile 落盘，回答「进程为什么卡住」，与 trace 树人格独立。

**与 event 系统分离**：event（agent_loop / session_panel topic，经 EventHub）= 前端渲染用流式进度单元；observability（trace 树，经 adapter 直发 backend）= 运维/分析用 trace 树。agent loop 在边界**显式调 adapter**（精确拿 LLM input/output/model/usage），而非订阅 event 翻译。

| 核心概念 | 一句话 |
|---|---|
| **Trace** | 一个 run 的根节点（`traceId = runId`） |
| **Generation** | 一次 LLM 调用（含 model/input/output/**usage**，信息最密集） |
| **Span** | 一个 step（iteration）或一次 tool 执行（step span 包一轮；tool span 是子节点） |
| **Session** | trace 标 `sessionId`，Langfuse 自动聚合 view；**不主动 create** |
| **Metadata** | runId/sessionId/parentSessionId/toolCallId/游标/…（§5 全量字段） |
| **ObservabilityAdapter** | backend 中性接口（startTrace/startGeneration/startSpan 生命周期） |
| **ObservabilityManager** | composite adapter（持 child 列表 fan-out，对 loop 透明） |
| **LangfuseAdapter** | Langfuse backend 实现：API 表面（start*/end*/setLevel/shutdown）+ handle 生成 + op 构造 |
| **LangfuseEventQueue** | LangfuseAdapter 内部**有界事件消费者队列**（v0.0.138）：500MB byte buffer + drop-new + 单 consumer async loop；所有 SDK 调用经此队列（start 入队 create-op、end/setLevel 入队 update-op），对 loop 透明 |
| **Handle** | 父子关系载体（trace/span/gen 三种；backend 据此建树，任意深度嵌套） |
| **HangMonitor** | 跨三进程卡顿监控（server/electron-main event loop lag 采样 + 超阈值抓 inspector CPU profile 落盘；renderer PerformanceObserver longtask），与 trace 链路人格独立 |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| ObservabilityAdapter 接口 + 全量字段（Trace/Gen/StepSpan/ToolSpan） | agent loop 驱动 / RunState 游标（→ `../agent_interface_and_loop/`） |
| 埋点契约（loop 边界何时 start/end 各对象） | event 系统 / EventHub / session_panel topic（→ `../event/`） |
| ObservabilityManager（composite + fan-out + 双层容错） | Usage 类型定义（→ `../session/[P0]session_usage.md §1`） |
| LangfuseAdapter + LangfuseEventQueue（SDK 接入 + 队列 + 字段映射 + flush） | Message / ToolDefinition / ToolResultBlock 类型（→ `../message/`、`../tools/`） |
| langfuse 作为验证 oracle（三类断言 + lib） | observability 列表 schema（app_config runtime 组，→ `../../config/[P0]app_config.md §3.9`） |
| 卡顿监控（event-loop-monitor / main-event-monitor / longtask-monitor 三进程接线 + env 开关 + profile 落盘） | dataDir 展开权威（→ `app/server/src/config.ts` resolveDataDir，BUG-004 护栏） |

## ③ 与系统的关系

```
   agent_loop（② LLM 前/后、③ tool 前/后、iteration 起/末、run_start/end）
       │
       │ 显式调 adapter（边界埋点，非订阅 event）
       ▼
   SessionConfig.observability  ←── ObservabilityManager（composite，singleton，
       │                          实现 ObservabilityAdapter，对 loop 透明）
       │ fan-out（per-child try/catch + resolveParentPerChild）
       ├── LangfuseAdapter(child A)  ── enqueue op ──► LangfuseEventQueue（500MB drop-new + 单 consumer）
       │                                                    │ 批间 await sleep yield
       └── LangfuseAdapter(child B)  ── enqueue op ──► LangfuseEventQueue    ──► langfuse SDK batch ──► Langfuse backend

   Trace 树（任意深度嵌套）：
   Trace(runId)
   ├─ Span("step 1")
   │  ├─ Generation(LLM#1, model, input, output, usage)
   │  └─ Span("tool: read") ── 可再嵌 Generation（tool 内调 LLM，深度不限）
   └─ Span("step N") ...
```

**对外协作点**：adapter per-session 经 `SessionConfig.observability` 注入（不可变共享，与 `tools`/`client` 同级）；manager 由 `bootstrap.ts` 据 app_config observability 列表（runtime 组）构造（singleton，跨 session 复用，不热更新）；shutdown 双触发（node SIGTERM/SIGINT + electron before-quit）。

## ④ 核心设计原则（跨文件不变量）

1. **信息完整性**——trace/generation/span 三类对象记**全量** input/output/metadata，不截断、不用 `...`；单条 trace 能还原整轮 run。→ `observability_interface.md §5`
2. **接口中性，概念借 Langfuse**——method 名/字段类型独立于 SDK；Langfuse v3 OTel-native，换 OTel backend（Jaeger/Tempo）几乎零摩擦。→ `observability_interface.md §1`
3. **composite 对 loop 透明**——manager 实现接口 + fan-out，loop 埋点代码零改动；handle 双层 id 空间，parent 必须按 child 翻译（BUG-001 生命线）。→ `observability_manager.md §4.1`
4. **双层容错**——第一层 manager per-child try/catch（一 child 挂不影响其他），第二层 loop `safe()` 兜底（整个子系统挂不影响主流程）；两层独立互补。→ `observability_manager.md §3`
5. **空/全 disabled 等价 Noop**——manager 持 0 child 即 noop，loop 无感知；不热更新（改列表须重启 / 下个 session）。→ `observability_manager.md §6/§7`
6. **双 generation 对账（v0.0.50）**——一次 LLM 调用产**两条紧邻 generation**（`llm-N-logical` 业务视图 + `llm-N-physical` wire body，同 step span，N 相同）；physical 不带 usage（不污染 token/cost dashboard），受 `ObservabilityConfigItem.logPhysical` 开关控制（默认 false）；manager fan-out 按 child.logPhysical 过滤 physical kind。logical 与 physical 互相独立 try/catch（双层容错沿用）。→ `observability_interface.md §4.1/§5.2` + `observability_manager.md §5.3` + `langfuse_adapter.md §4`
7. **LangfuseEventQueue async consumer loop + 500MB drop-new（v0.0.138 核心红线）**——LangfuseAdapter **所有 SDK 调用经 LangfuseEventQueue**（`langfuse-event-queue.ts`）：start* 同步生成 handle.id + enqueue create-op，end*/setLevel enqueue update-op，consumer FIFO 保证 parent op 先处理（`resolveParent` 必命中）。队列 500MB byte buffer + drop-new（保 FIFO 老）+ 单 consumer async loop 批间 `await sleep(250ms)` yield；`_apply` 失败 try/catch 静默。**核心红线：observability 失败绝不影响主流程**——enqueue 同步不 await + adapter `start*/end*` 全包 try/catch（`warnSuppressed` 模块级函数 console.warn debug 级）+ consumer `_apply` try/catch。shutdown 走 `drainAndShutdown`（drain 先于 `client.shutdownAsync()`，兑现 flush 契约）。→ `langfuse_adapter.md §2/§3/§4`
8. **卡顿监控失败静默 + Bun 局限（v0.0.254）**——hang monitor 沿用同一条红线（特性检测 + 全 try/catch，监控绝不影响启动/主流程；开关关时近零开销）；**但 server 侧 lag/profile 在 dev(Bun) 下失效**（monitorEventLoopDelay 对真实阻塞不敏感 + inspector profile 空壳），仅 packaged(Electron Node) 有效——server 卡顿排查必须在 packaged 真机开 `EVENT_LOOP_MONITOR=1`。episode enter/recover 经 `hang-sink.ts` 双写 console + `performance.log`（kind:hang），见 §3.8。→ `[P1]hang_monitor.md §3.2/§3.5/§3.8`

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 链接 |
|---|---|---|
| **接口契约** | | |
| `observability_interface.md` | ObservabilityAdapter 接口 + Trace 树结构 + 埋点契约 + **全量字段定义**（Trace/Gen/StepSpan/ToolSpan）+ 注入 + langfuse oracle 三类 | [link]([P0]observability_interface.md) |
| **实现** | | |
| `observability_manager.md` | ObservabilityManager composite（fan-out + 双层容错 + composite handle + resolveParentPerChild + per-item client） | [link]([P0]observability_manager.md) |
| `langfuse_adapter.md` | LangfuseAdapter（langfuse SDK 接入 + 接口映射 + 全量字段映射 + usage 映射 + flush 生命周期） | [link]([P0]langfuse_adapter.md) |
| **卡顿监控** | | |
| `[P1]hang_monitor.md` | 跨三进程卡顿监控（三进程 env 开关速查 + startEventLoopMonitor/startLongTaskMonitor 接口 + episode 状态机 + Bun 局限实测 + 失败静默红线） | [link]([P1]hang_monitor.md) |

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
