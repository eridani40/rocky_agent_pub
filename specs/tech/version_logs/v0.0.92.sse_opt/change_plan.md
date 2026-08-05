# v0.0.92.sse_opt 变更计划书（method 级 review 合同）

> version: v0.0.92 · slug: sse_opt · 2026-07-08
> 类型：内部重构 / 优化型版本（非新用户功能）
> 上游：PRD `specs/prd/version_logs/v0.0.92.sse_opt.md`（W1-W5 + P1-P5 + V1-V10）+ 调研 `specs/research/sse_research.md` + `specs/research/sse_lifecycle_audit.md`
> 本文件 = 架构期冻结契约。planner 按本表切 task（`coversModules/coversFiles/coversMethods`）；coder 按本表实现 + 汇报偏离；reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 列定义（8 列）

| 列 | 说明 |
|----|------|
| **所属模块** | 子系统（sse_client / studio_unread / poll_cleanup / use_lifecycle / memory_hook / spec_sync） |
| **文件路径** | 完整相对路径 |
| **函数·符号** | 函数名或符号名（行粒度 = 符号） |
| **类型** | 新增 / 修改 / 删除 / 迁移 / spec同步 / 验证（无改动仅核对） |
| **变更内容** | 具体做什么、完成什么职责（禁「更新调用链」等模糊描述） |
| **约束** | MUST / MUST NOT，钉死边界（invariants、PRD 路径对齐） |
| **参考** | 该方法改动依赖/对齐的 spec 路径+章节 + research 节号 + architect 原则 |
| **预计影响行** | +N / -M（粗估） |

---

## W1 — G1 修复（use-studio-unread-meta 改用单例）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| studio_unread | `app/web/src/components/studio-page/use-studio-unread-meta.ts` | import block | 修改 | 删 `import { SseClient }`（保留 `type SubscribeHandle`），加 `import { getSseClient } from '../../lib/sse-singleton'` | MUST 仅保留单例入口；不再直接 import SseClient 类 | `[P0]sse_client_singleton.md §1 S1/S3` | +1/-1 |
| studio_unread | `app/web/src/components/studio-page/use-studio-unread-meta.ts` | `sseRef` (`useRef<SseClient\|null>`) | 删除 | 删掉 ref（不再持 SseClient 实例引用；改直接调 `getSseClient()`） | MUST NOT 持有 SseClient 实例引用（singleton 全局唯一） | `[P0]sse_client_singleton.md §1 S1` | -2 |
| studio_unread | `app/web/src/components/studio-page/use-studio-unread-meta.ts` | `useEffect` body (`new SseClient()` + `void sse.connect(...)`) | 删除 | 删 `const sse = new SseClient(); sseRef.current = sse;`（line 46-47）+ 删 `void sse.connect(onError)`（line 59-62）+ 删上方关于「connect 永不 resolve」的整段注释（line 52-58，不再适用：单例 lazy 自连） | MUST NOT 调 `new SseClient()`；MUST NOT 调 `connect()`（单例 lazy 自连，`getSseClient()` 内部 `void connect()`） | `[P0]sse_client_singleton.md §4 getSseClient`；memory `sseclient-connect-never-resolves` | -16 |
| studio_unread | `app/web/src/components/studio-page/use-studio-unread-meta.ts` | `sse.subscribe(...)` 调用 | 修改 | 改为 `getSseClient().subscribe('session_meta', '_all', handler)`（保留 `.then/.catch` 链与 cancelled 守卫） | MUST 保留 cancelled flag + subscribe-before-unmount 兜底（line 78-82）；handler biz='studio' 反向守卫不动 | `[P0]sse_client_singleton.md §3.1 / §6` | +1/-1 |
| studio_unread | `app/web/src/components/studio-page/use-studio-unread-meta.ts` | `useEffect` cleanup return | 修改 | 删 `sse.destroy()`（line 95）+ 删 `sseRef.current = null`（line 96）；仅保留 `cancelled = true` + `metaHandle?.unsubscribe().catch()` + `metaHandle = null` | MUST NOT 调 `destroy()`（连接生命周期归 app，组件 unmount 仅 unsubscribe 句柄） | `[P0]sse_client_singleton.md §1 S3 / §3.4` | -2 |
| studio_unread | `app/web/src/components/studio-page/use-studio-unread-meta.ts` | 顶部 file header JSDoc | 修改 | 改 docstring「独立 SseClient 实例...unmount 时 destroy 防泄露」→「v0.0.92 起改用 getSseClient() 单例订阅，unmount 仅 unsubscribe 句柄」 | MUST 同步 spec 修正（不能留过时 docstring 误导后续 agent） | 原则 12（代码-spec 一致） | +2/-2 |

**W1 行数小计：6 行**。预期行为变化：切 playground↔studio 不再拆建第 2 条 GET /sse（DevTools Network 全周期仅 1 条）；biz='studio' 反向守卫不变；红点实时刷新行为不变。

---

## W2 — SSE 重连机制（R2 + spec §7 标「可选」→「已落地」）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| sse_client | `app/web/src/lib/sse-client.ts` | `connect(onError?)` reader.read() 循环的 `catch` + `finally` 块 | 修改 | catch（line 121-125）识别 `AbortError` vs 其他：AbortError=destroy 触发，不重连；其他 = 瞬时错误，进重连链路。finally（line 126-128）不再无脑 `active=false`，改为按错误类型分支：destroy→`active=false` 终态；瞬时错误→保持 handlers Map 不动 + 调度 `scheduleReconnect()` | MUST NOT 在瞬时错误时 `handlers.clear()`（保留订阅，重连后继续路由）；MUST 在 AbortError 时进终态不重连（避免 destroy 后僵尸重连）；connect() 仍是 stream loop 永不 resolve（重连逻辑走 catch 不走 then，参考 memory `sseclient-connect-never-resolves`） | `[P0]sse_client_singleton.md §7`；memory `sseclient-connect-never-resolves` | +12/-3 |
| sse_client | `app/web/src/lib/sse-client.ts` | `SseClient` private fields | 新增 | 加 `private reconnectTimer: ReturnType<typeof setTimeout> \| null = null` + `private reconnectAttempts = 0` + `private reconnectBaseMs = 1000` + `private reconnectMaxMs = 30_000` + `private destroyed = false`（防 destroy 后僵尸重连） | MUST 有 destroyed 守卫防 destroy 后重连泄漏 | `[P0]sse_client_singleton.md §3.4` | +5 |
| sse_client | `app/web/src/lib/sse-client.ts` | `SseClient.scheduleReconnect(onError)` | 新增 | 私有方法：计算 `delay = min(base * 2^attempts, max) ± jitter(20%)`；`reconnectTimer = setTimeout(() => void this.connect(onError), delay)`；attempts++。重连成功（connect 内部 stream 起来后）attempts 归零 + 触发 resumedSubscribers 通知 | MUST 用指数回退（1s/2s/4s/8s/.../cap 30s + ±20% jitter）；MUST 在每次重连尝试前 `controller = new AbortController()` 重置（旧 controller 已 abort）；MUST NOT 阻塞 caller（fire-and-forget setTimeout） | PRD §6.1 R-a；sse_research §4 R2 | +18 |
| sse_client | `app/web/src/lib/sse-client.ts` | `SseClient.onResumed(cb)` + private `resumedSubscribers: Set<() => void>` | 新增 | 公开方法：注册「重连成功 / visibilitychange 返前台」回调（fire once per resume event）；返回 `() => void` unsubscribe 函数。connect 第一次成功（reader 第一帧到达 / fetch res.ok）后若 reconnectAttempts>0 → 调全部 cb + attempts 归零 | MUST 回调在重连成功后触发；MUST 回调在 visibilitychange hidden→visible 时触发（仅当连接已 active 时；否则等重连）；MUST NOT 在每次帧到达都触发（只在「resume 瞬间」） | PRD P3 验收 (a)(b)；sse_research R2 | +20 |
| sse_client | `app/web/src/lib/sse-client.ts` | `destroy()` | 修改 | 加 `this.destroyed = true`（防僵尸重连）+ `if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = null;`；handlers.clear() 不变 | MUST 防 destroy 后 setTimeout 触发的僵尸重连（关键：destroyed flag 在 scheduleReconnect 入口检查 `if (this.destroyed) return;`） | `[P0]sse_client_singleton.md §3.4` | +3 |
| sse_client | `app/web/src/lib/sse-singleton.ts` | 模块顶层 `visibilitychange` listener | 新增 | 模块初始化时（首次 `getSseClient()`）注册一次 `document.addEventListener('visibilitychange', ...)`：hidden→visible 时调 singleton 的 resumedSubscribers 通知 + 若 `!singleton.isConnected()` 触发 `void singleton.connect(onError)`（兜底自愈） | MUST 仅注册一次（用模块级 flag 防 StrictMode 双触发）；MUST NOT 重复 addEventListener（singleton 生命周期 = app） | PRD P3；sse_research R2 | +12 |
| sse_client | `app/web/src/lib/sse-singleton.ts` | `getSseClient()` body | 修改 | 创建 singleton 时 `void singleton.connect(defaultErrorLogger)`（传一个默认 onError console.warn，确保重连链路激活）；保留 lazy 自连语义 | MUST 在 lazy 自连时传 onError（否则瞬时错误不进重连链路）；MUST NOT 改 lazy 单例幂等语义 | `[P0]sse_client_singleton.md §4` | +2/-1 |
| sse_client | `app/web/src/lib/sse-client.ts` | `isConnected()` | 修改 | `return this.active && !this.destroyed`（destroyed 状态下 isConnected 永远 false） | MUST 区分「重连中」（isConnected=false 但可恢复）vs「destroyed」（终态） | `[P0]sse_client_singleton.md §3` | +1/-1 |
| sse_client | `app/web/src/lib/sse-client.ts` | 顶部 file header JSDoc | 修改 | 补「v0.0.92 起加 reconnect：catch 触发指数回退重连 + handlers 不清 + onResumed 回调」段；列重连策略常量 + 默认值表 | MUST 同步 spec（reviewer G 清单会查 docstring 与行为一致） | 原则 12 | +6 |

**W2 行数小计：9 行**。预期行为变化：网络抖动/HMR/macOS 唤醒后 ≤30s 自动重连，handlers 不丢，重连成功后通过 onResumed 通知订阅方做 GET 校正。

---

## W3 — 轮询清理 + dead code 删除 + 后台 tab 暂停

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| poll_cleanup | `app/web/src/components/chat-page/component-conversation-item.tsx` | `pollRef` (`useRef`) + `stopPolling` 函数 | 删除 | 删 line 101-108 全段：`pollRef` 从未赋值（dead code，v0.0.88 删 setInterval 后遗留）+ `stopPolling` 是 no-op + `useEffect(() => () => stopPolling(), [])` cleanup 是 no-op | MUST 渲染等价（既有 UT/ET 全绿）；MUST 同时清理下方 effect（line 124-129）中调 `stopPolling()` 的语句（保留 `setExpanded(false)`） | sse_lifecycle_audit §1.2 末行 + §6 G5；[P0]sse_client_singleton.md §8 P3 | -10 |
| poll_cleanup | `app/web/src/components/chat-page/component-conversation-item.tsx` | file header JSDoc + inline comment | 修改 | 删「pollRef + stopPolling 保留为 active 失焦 cleanup 用」段（line 97-100），改写为「[v0.0.88] 1.5s 轮询已删，[v0.0.92] pollRef dead code 同步清掉；subagent 状态变化靠 page-chat session_meta `_all` 推送 refreshChildren 兜底」 | MUST NOT 留过时注释（误导后续 agent） | 原则 12 | +2/-4 |
| poll_cleanup | `app/web/src/components/chat-page/component-mention-popover.tsx` | useEffect cleanup（debounce clear，line 132-140） | 验证 | **G6 已存在 cleanup**（line 137-139 `return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };`）—— **研究 sse_lifecycle_audit §1.2 G6 描述错误**：实际代码已有 unmount cleanup，不是「未清」。本行 = 仅核对，无代码改动。如 coder 发现 cleanup 仍有缺陷（如未置 debounceRef.current=null）才补；否则保持现状。 | MUST NOT 重复添加 cleanup（已有）；MUST 在 change_log 记录「G6 研究错误，实际已清理」作 doc-sync 待办（doc-modifier 阶段 5 同步修 sse_lifecycle_audit.md） | sse_lifecycle_audit §1.2 G6（错误）；实际代码 line 132-140 | +0 |
| poll_cleanup | `app/web/src/components/studio-page/component-budget-meter.tsx` | `useEffect` (line 47-51) setInterval + `POLL_INTERVAL_MS` 常量 | 修改 | 加 visibilitychange listener：document.hidden 时 `clearInterval(id)` 不跑；visible 时立即 `void reload()` + 重起 `setInterval`。保留 30s 间隔不变（squad-level 改 SSE 需后端补 broadcast 事件，out-of-scope；session_usage_update 是 per-session 不广播 squad 聚合，不可直接改 SSE） | MUST NOT 改成 SSE（squad-level 端点无对应 SSE 事件）；MUST 在后台 tab 时停轮询（V5 验收）；MUST 切回前台立即 refresh 一次 | PRD §6.2 模糊点1 default；budget-meter.md §3；sse_research §1.2 | +12 |
| poll_cleanup | `app/web/src/components/studio-page/component-budget-meter.tsx` | file header JSDoc | 修改 | 补一句「v0.0.92 起：后台 tab（document.hidden）暂停轮询，切回立即 refresh；30s 间隔保留（squad-level SSE 改造记 follow-up）」 | MUST 同步 spec；MUST 标 follow-up（不强推后端改动） | 原则 12；PRD §2.2 OUT | +2 |
| poll_cleanup | `app/web/src/components/connector-page/page-connector.tsx` | `POLL_INTERVAL_MS` 常量 + useEffect (line 40, 66-75) | 修改 | `POLL_INTERVAL_MS = 2000` → `5000`；useEffect 内加 visibilitychange listener 同 budget-meter 模式（hidden 暂停 / visible 立即 refresh + 重起）；cleanup 不变 | MUST 间隔从 2s 改 5s（V5 验收）；MUST 后台暂停；MUST NOT 改 SSE（端点无 SSE，PRD §6.2 default） | PRD §6.2 模糊点2 default；sse_lifecycle_audit §1.2 | +10/-1 |
| poll_cleanup | `app/web/src/components/chat-page/section-cron-panel.tsx` | useEffect (line 85-95) inline comment | 修改 | 在 60s 轮询上方补 justification 注释：已存在（line 19, 87-89），如已充分则不补；如仅一处则补到 useEffect 上方：`// justification: cron nextFireAt 漂移显示需周期刷新；端点无 SSE；60s 频率低 + cron 任务自身频率 ≥分钟级，足够` | MUST 有 justification（V8 验收）；MUST NOT 改成 SSE（端点无 SSE） | PRD §2.1 W3 (e)；sse_lifecycle_audit §1.2 | +1 |

**W3 行数小计：7 行**。预期行为变化：conversation-item dead code 清掉；mention-popover 确认无改动（修正研究错误）；budget-meter/connector 后台 tab 暂停 + 前台立即 refresh；cron 保留 60s。

---

## W4 — useLifecycle hook 抽象引入（核心）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| use_lifecycle | `app/web/src/lib/use-lifecycle.ts` | 整个文件（NEW） | 新增 | 新建 hook 文件，导出 `useLifecycle<TCtx>` + `LifecycleOptions<TCtx>` 接口 + `LifecyclePhase` type。结构：①状态 `ctx/loading/error`（useState）+ AbortController ref；②useEffect 跑 init/destroy（deps 变化触发 destroy+init，init 失败 catch 兜底仍调 destroy）；③可选 setInterval 跑 refresh（仅当 `poll` 配置存在）；④visibilitychange listener（hidden 暂停 setInterval / visible 立即 reload 一次）；⑤dev 警告（NODE_ENV=development：缺 poll.justification → console.warn） | MUST `init` 接 `{ signal: AbortSignal }`（所有 fetch 必须 `signal.aborted` 校验）；MUST `destroy` 幂等（可被多次调用不抛异常，StrictMode 双 mount 兼容）；MUST `poll` 必须显式 + justification（V6 验收）；MUST NOT 在 init 内调 setState（除返回 ctx 外）；MUST NOT 在 destroy 内 fetch（仅清本地资源 + unsubscribe 句柄）；MUST NOT 与 SseClient 单例耦合（init 内调 getSseClient().subscribe 是 caller 责任，hook 不管连接）；MUST 文件 ≤300 行；MUST 单文件单 hook | PRD §3.1-§3.5；sse_lifecycle_audit §7.2-§7.4 | +180 |
| use_lifecycle | `app/web/src/lib/__tests__/use-lifecycle.test.ts` | 整个文件（NEW） | 新增 | UT 覆盖：①destroy 幂等（连调 2 次不抛）；②signal.aborted 校验（unmount 后 init 内 fetch 不再 setState）；③poll.justification 缺失触发 dev 警告；④visibilitychange hidden→visible 触发 reload；⑤deps 变化触发 destroy+重 init；⑥init 抛异常时 destroy 仍调（catch 兜底） | MUST UT 全绿（V6 验收）；MUST NOT 跑真 fetch（mock） | PRD §5 V6；原则 6（质量三关） | +140 |
| use_lifecycle | `specs/tech/app/frontend/[P0]component_architecture.md` | §3.10 useLifecycle 契约 | spec同步 | 新增 §3.10 章节：核心概念 + 接口签名（TS）+ 5 条不变量 + 6 条禁忌 + 与 SseClient 单例关系（兼容不动）+ 迁移映射表（指向 sse_lifecycle_audit §7.3）+ reload-on-resume poll-only 契约（code-review 修复）+ 全迁边界（v0.0.92 全迁 4 hook：useMemoryCrud/MemberPanelMemory/SectionWorkspacePanel/useSubagentChildren，剩余轮询类 hook 记 follow-up） | MUST 8 列中参考列指向 PRD §3 + research §7；MUST NOT 重写 §3.1-§3.9（仅追加 §3.10） | PRD §3；sse_lifecycle_audit §7；原则 14（概念先行） | +60 |

**W4 行数小计：3 行**（含 spec 同步）。预期产出：use-lifecycle.ts 落地 + UT + spec §3.10 契约。

---

## W5 — 非引擎非轮询全迁 4 hook（原计划试点 2 个，实施期扩为全迁 + T6，避免半拉子）

> **实施偏离记录（coder 决策 + orchestrator 确认）**：架构期原定「试点 useMemoryCrud + MemberPanelMemory 2 个」，实施期发现「非引擎、非轮询」hook 共 4 个（再加 SectionWorkspacePanel + useSubagentChildren），全迁成本可控且避免「试点 2 个 + 剩余 follow-up 半拉子」状态。扩为全迁 4 hook，SectionWorkspacePanel 编为 W6、useSubagentChildren 编为 T6（独立 task）。doc-modifier 阶段 5 据实同步本 plan + spec。

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| memory_hook | `app/web/src/components/chat-page/use-memory-crud.ts` | `useEffect(() => { void refetch(); }, [refetch])` (line 61-63) | 迁移 | 改用 `useLifecycle`：`const { ctx: entries, loading, error, reload } = useLifecycle({ init: async ({ signal }) => { const r = await listMemory(scope, { sessionId }); if (signal.aborted) throw new DOMException('aborted','AbortError'); return r; }, destroy: () => {}, deps: [scope, sessionId] });`；entries/loading/error 从 hook 返回值取（不再 useState）；refetch 改名 reload（命令式刷新，调 `reload()`） | MUST 行为等价（既有 UT/ET 全绿，V7 验收）；MUST NOT 加 poll（PRD §2.2 OUT：useMemoryCrud GET-once 无 SSE 不轮询）；MUST handleSave/handleArchive 调用 reload 替代 refetch；MUST 保持 setEditor/handleSave/handleArchive 接口不变 | PRD §2.1 W5；sse_lifecycle_audit §7.3 迁移表 | +12/-10 |
| memory_hook | `app/web/src/components/chat-page/use-memory-crud.ts` | `refetch` (`useCallback`) | 修改 | 改为 `const reload = ...`（或保留 refetch 命名以减少 diff，由 coder 定）+ 删 useState entries/loading/error（已迁 useLifecycle）；handleSave/handleArchive 内 `await refetch()` → `await reload()` | MUST 接口签名不变（`MemoryCrud` 接口 export 不动，下游 import 不破） | sse_lifecycle_audit §7.3 | +3/-5 |
| memory_hook | `app/web/src/components/chat-page/use-memory-crud.ts` | `MemoryCrud` interface export | 验证 | 接口字段不变（entries/loading/error/editor/setEditor/refetch/handleSave/handleArchive），确认下游 `section-memory-panel` / `section-user-memory` 无需改 | MUST NOT 改 export 接口（破坏下游）；MUST 跑 typecheck + UT/ET 验证零回归 | sse_lifecycle_audit §7.3；原则 12 | +0 |
| memory_hook | `app/web/src/components/studio-page/component-member-panel-memory.tsx` | `useEffect(() => { void reload(); }, [reload])` (line 43-45) | 迁移 | 改用 `useLifecycle({ init: async ({signal}) => { const r = await getSummary(sessionId); if(signal.aborted) throw ...; setSummary(r.summary?.content ?? null); }, destroy:()=>{}, deps:[sessionId] })`；summary 改 ctx 或保留 useState（由 coder 定，倾向保留 useState 因 init 内调 setState 违反不变量4，应返回 ctx 而非 setState） | MUST 行为等价（V7 验收）；MUST NOT 加 poll；MUST reload 命令式（用于 onCompact 后重拉） | PRD §2.1 W5；sse_lifecycle_audit §7.3 | +10/-4 |
| memory_hook | `app/web/src/components/studio-page/component-member-panel-memory.tsx` | `onCompact` 内 `window.setTimeout(() => void reload(), 1500)` (line 55) | 修改 | 删 setTimeout，改 `void reload()`（useLifecycle.reload 命令式）。注：原 setTimeout 是为给后端 compact 异步处理时间，删后可能拉到旧值——保留可接受（compact 完成后 summary_task_update SSE 会触发后续刷新，或 reload 多调几次无害）；若 coder 评估确实需延迟，可保留 setTimeout 但加 unmount cleanup（clearTimeout ref） | MUST NOT 引入「unmount 后 setTimeout 触发 setState」（V4 验收精神）；MUST 行为等价（compact 后能拉到新 summary） | sse_lifecycle_audit §1.2（setTimeout 未 clear）；PRD §2.1 W5 | +1/-1 |
| memory_hook | `app/web/src/components/studio-page/component-member-panel-memory.tsx` | `onCompact` finally 内 `window.setTimeout(() => setFeedback(null), 2600)` (line 62) | 修改 | 加 unmount cleanup（setTimeoutRef + useEffect cleanup clearTimeout）；**或**保留现状（一次性 setState on unmount 由 React 18 吞，低优不致命，sse_lifecycle_audit §1.2 标「低」）。倾向加 cleanup 以符合 useLifecycle 禁忌（V4 精神） | MUST 与 V4 精神一致（unmount 后定时器不残留）；MUST 文件 ≤300 行 | sse_lifecycle_audit §1.2；PRD §3.3 禁忌 | +6 |

**W5 行数小计：6 行**。预期行为：useMemoryCrud + MemberPanelMemory 行为等价（既有 UT/ET 全绿），符合 useLifecycle 契约（destroy 幂等 + signal.aborted 守卫）。

> **实施期追加（W6 + T6，非本表原行）**：架构期原 W5 仅含 useMemoryCrud + MemberPanelMemory 2 个试点；实施期扩为「非引擎非轮询全迁」，追加 W6（`section-workspace-panel.tsx` 顶层 tree GET 走 useLifecycle）+ T6（`use-subagent-children.ts` 借 useLifecycle unmount cleanup abort in-flight）。doc-modifier 阶段 5 已据实同步 spec（`[P0]component_architecture.md §3.10` 迁移映射表 + index 原则 16 + log.md v0.0.92 条目）。reload-on-resume poll-only 契约因 T6 而立（见 §3.10 轮询策略）。

---

## spec_sync — 文档同步（架构期产出，doc-modifier 阶段 5 复核）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| spec_sync | `specs/tech/app/frontend/[P0]sse_client_singleton.md` | §5 R3 注脚（line 178） | spec同步 | 修正：「research.md 列的「studio unread 红点独立 SseClient」（D3）经代码核实**不存在**...」改为「（v0.0.92 前**存在**于 `use-studio-unread-meta.ts`，违反 S1；v0.0.92 起收敛为 `getSseClient()` 单例 + subId 区分，与 playground session_meta `_all` 订阅并存不冲突）」 | MUST 标 since v0.0.92；MUST NOT 重写整段（仅修注脚 + 加 since） | sse_research §6 G1（确认存在）；PRD V1 (d) | +1/-1 |
| spec_sync | `specs/tech/app/frontend/[P0]sse_client_singleton.md` | §7「（可选）可见性变化 / SSE 重连后 GET 校正」行 | spec同步 | 改「（可选）」→「（v0.0.92 起落地：SseClient 内部指数回退重连 1s×2^k cap 30s + jitter ±20%；singleton 接 visibilitychange；resumed 通知走 `onResumed(cb)` 注册回调，由 caller 决定 GET 校正范围）」+ 列重连策略常量表 | MUST 标 since v0.0.92；MUST 列 invariants（handlers 不清 / destroyed 守卫 / 指数回退 + jitter） | PRD V2；sse_research §4 R2 | +8/-1 |
| spec_sync | `specs/tech/app/frontend/log.md` | 顶部 v0.0.92 变更条目 | spec同步 | 追加「## 2026-07-08 · v0.0.92.sse_opt」段：列 W1-W5 摘要 + 指向本 change_plan.md；按现有格式（参考 v0.0.85.ui_opt 条目） | MUST ISO 倒序（最新在前）；MUST 引用本 change_plan 路径 | OKF log 规范 | +18 |
| spec_sync | `specs/tech/app/frontend/index.md` | ④ 核心设计原则 | spec同步 | 追加原则 15（编号顺延）：「[v0.0.92] SSE 自动重连 + visibilitychange 校正」——connect 永不 resolve 的 stream loop 在 reader.read catch 中触发指数回退重连（base 1s × 2^k cap 30s + jitter ±20%）；handlers Map 不清；destroyed 守卫防僵尸；singleton 模块顶层注册 visibilitychange listener，返前台时触发 onResumed 回调通知 caller 做 GET 校正。**反例**：原 spec §7 标「可选」+ 代码 catch 仅 console.warn → 网络抖动后红点/run 态卡死需手动刷新。 | MUST 一句话讲清问题 + 方案 + 反例（参考原则 13/14 风格） | 原则 10；PRD V2 | +2 |
| spec_sync | `specs/tech/app/frontend/index.md` | ④ 核心设计原则 | spec同步 | 追加原则 16：「[v0.0.92] useLifecycle hook 抽象统一组件生命周期」——`useLifecycle({ init, destroy, refresh, poll.justification, deps })` 单 hook 收敛「订阅/数据/定时器」三类资源的 mount/unmount 管理；5 不变量（init 接 AbortSignal / destroy 幂等 / poll 显式+justification / 禁 init 内 setState 除 ctx / 禁 destroy 内 fetch）+ 6 禁忌（禁裸 setInterval / 禁裸 setTimeout / 禁 new SseClient 等）+ reload-on-resume poll-only 契约。**全迁 4 hook**（useMemoryCrud + MemberPanelMemory + SectionWorkspacePanel + useSubagentChildren）；剩余轮询类 hook（BudgetMeter/CronPanel/Connector）记 follow-up。 | MUST 与 §3.10 契约一致 | PRD §3；sse_lifecycle_audit §7 | +2 |

**spec_sync 行数小计：5 行**。

---

## 总计行数汇总

| 模块 | change_plan 行数 |
|---|---|
| W1 studio_unread | 6 |
| W2 sse_client 重连 | 9 |
| W3 poll_cleanup | 7 |
| W4 use_lifecycle | 3 |
| W5 memory_hook 全迁 4 hook（原试点扩为全迁 + T6） | 6 |
| spec_sync | 5 |
| **总计** | **36 行** |

---

## 预防性核对记录（architect 落 change_plan 前核对引用符号存在 — 原则 16）

| 引用符号 / 路径 | 核对方式 | 核对结果 |
|---|---|---|
| `app/web/src/lib/sse-client.ts` `connect/subscribe/unsubscribe/destroy/handlers/active/controller/carry` | Read 全文 | ✅ 全部存在（class SseClient line 74-201）；当前无重连逻辑（catch/finally line 121-128 仅 `active=false` + `onError?.(e)`） |
| `app/web/src/lib/sse-singleton.ts` `getSseClient/_resetSseSingletonForTest/singleton` | Read 全文 | ✅ 存在；当前 `void singleton.connect()` 未传 onError（W2 需补） |
| `app/web/src/components/studio-page/use-studio-unread-meta.ts` `new SseClient` / `void sse.connect` / `sse.destroy` / `sseRef` | Read 全文 | ✅ 行号确认：line 46 `new SseClient()`、line 59 `void sse.connect(...)`、line 95 `sse.destroy()`、line 42 `sseRef`、line 96 `sseRef.current = null` |
| `app/web/src/components/chat-page/component-conversation-item.tsx` `pollRef/stopPolling` | Read 全文 | ✅ 行号确认：line 101 `pollRef`、line 102-107 `stopPolling`、line 108 `useEffect(()=>()=>stopPolling(),[])`、line 127 `stopPolling()`（在 active effect 内）；pollRef **从未赋值**（dead code 确认） |
| `app/web/src/components/chat-page/component-mention-popover.tsx` `debounceRef` cleanup | Read 全文 | ⚠️ **研究错误**：sse_lifecycle_audit §1.2 G6 称「未在 unmount clear debounceRef」，实际 line 132-140 useEffect 已有 `return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };`。本 change_plan W3 行 3 标「验证」类型，不安排改动。doc-modifier 阶段需同步修研究文档。 |
| `app/web/src/components/studio-page/component-budget-meter.tsx` 30s 轮询 + session_usage_update SSE 评估 | Read 全文 + grep session_usage_update | ✅ 行号确认：line 24 `POLL_INTERVAL_MS = 30_000`、line 47-51 useEffect。**关键决策**：grep 结果显示 `session_usage_update` 是 **session 级** event（on `session_panel` topic，group=`session_id:<sid>`，仅订阅的 session 触发），**不是 squad 级广播**。BudgetMeter 需 squad 聚合（`GET /squad/:id/budget/usage`），改 SSE 需后端补 squad-level broadcast event，**out-of-scope**（PRD §2.2 OUT）。**决策：保留 30s 轮询 + 加后台 tab 暂停**（PRD §6.2 模糊点1 default）。 |
| `app/web/src/components/connector-page/page-connector.tsx` 2s 轮询 | Read 全文 | ✅ 行号确认：line 40 `POLL_INTERVAL_MS = 2000`、line 66-75 useEffect（含 cleanup clearInterval）；timerRef 存 ref。**决策**：延长至 5s + 后台暂停（PRD §6.2 模糊点2 default） |
| `app/web/src/components/chat-page/section-cron-panel.tsx` 60s 轮询 justification | Read 全文 | ✅ 行号确认：line 19 file header 已有 justification + line 85-95 useEffect inline comment（line 87-89）也有 justification（v0.0.64 加）；如已充分则 W3 行 7 标 minimal 补充 |
| `app/web/src/components/chat-page/use-memory-crud.ts` 接口 | Read 全文 | ✅ `MemoryCrud` interface line 28-37 + `useMemoryCrud` line 43-93；refetch/handleSave/handleArchive 全 useCallback；下游 `section-memory-panel` + `section-user-memory` 依赖此接口 |
| `app/web/src/components/studio-page/component-member-panel-memory.tsx` setTimeout reload | Read 全文 | ✅ 行号确认：line 55 `window.setTimeout(() => void reload(), 1500)`、line 62 `window.setTimeout(() => setFeedback(null), 2600)` |
| `app/web/src/lib/sse-client.ts` `SseClient.isConnected` 方法 | Read 全文 | ✅ 存在（line 84-86）；W2 行 8 修改其返回逻辑加 `&& !this.destroyed` |

---

## 与 PRD 路径对齐（V1-V10 验收 mapping）

| PRD 验收 | 本 plan 对应行 |
|---|---|
| V1 G1 修复 | W1 全部 6 行 + spec_sync 行 1（§5 R3 修正） |
| V2 SSE 重连（R2） | W2 全部 9 行 + spec_sync 行 2/4（§7 标落地 + index 原则 15） |
| V3 G5 dead code 删除 | W3 行 1-2（conversation-item pollRef/stopPolling） |
| V4 G6 debounce cleanup | W3 行 3（验证无改动，研究错误记录） |
| V5 budget/connector 评估 | W3 行 4-6（budget 保留+暂停 / connector 延长+暂停 / cron justification） |
| V6 useLifecycle 抽象 | W4 全部 3 行 |
| V7 试点迁移 ≥1 hook | W5 全部 6 行（实施扩为全迁 4 hook：W5+W6+T6，超 V7 最低要求） |
| V8 cron 60s 保留 | W3 行 7（cron justification） |
| V9 spec 同步 | spec_sync 全部 5 行 |
| V10 测试覆盖 | （由 test-plan.md 落 case，不在本 plan 范围） |

---

## 偏离与开放点（需 orchestrator 注意，非阻断）

1. **G6 研究错误**（W3 行 3 已记）：sse_lifecycle_audit §1.2 G6 称 mention-popover debounce 未 clear，**实际已 clear**（line 132-140 useEffect cleanup）。本版本不安排改动，但需 doc-modifier 阶段 5 修正 sse_lifecycle_audit.md G6 描述（避免误导后续 agent）。
2. **budget-meter 改 SSE 不可行**（W3 行 4 已决策）：`session_usage_update` 是 per-session 事件，非 squad 级广播；改 SSE 需后端补 squad_budget_update 事件，out-of-scope。本版本保留 30s 轮询 + 后台暂停，squad-level SSE 改造记 follow-up。
3. **`[P0]component_architecture.md §3.8/§3.9` 用词「subscriberId」**（不在本 plan 范围）：v0.0.88 spec 统一为 `subId`，但 component_architecture.md §3.8/§3.9 仍写「subscriberId」（与代码 + sse_client_singleton.md 不符）。本版本不修（避免范围蔓延），由 doc-modifier 阶段 5 顺手统一。
4. **W2 onResumed API 设计开放**：本 plan 给方向（SseClient.onResumed(cb) + Set<cb>）+ 钉 invariants（重连成功 + visibility 返前台触发 / handlers 不清 / destroyed 守卫），具体实现细节由 coder 决策。若 coder 发现更优方案（如 custom window event / emitter 库），可偏离 + 汇报。
5. **W5 MemberPanelMemory init 内是否 setState**：W5 行 4 标注「init 内调 setState 违反不变量4，应返回 ctx」。coder 落地时确认：summary 走 ctx（hook 内部 setCtx）而非 init 内调外部 setState。如已混用，需在迁移时调整。

