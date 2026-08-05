# v0.0.92.sse_opt Tech Change Log

> version: 1.0 · 2026-07-08
> 6 task 全部 code-review PASSED（含 1 次 T4 Major 修复）+ UT 验证。change_plan.md = 架构期冻结契约；本文件 = 发布说明（实际落地的跨子系统变更）。
> 无 HTTP API 契约变更（纯前端 transport / 生命周期重构）。

## 影响的 tech KB

### app/frontend KB（唯一受影响 KB）

**A. `[P0]sse_client_singleton.md`（W1 G1 修复 + W2 SSE 重连）**
- §5 R3 注脚修正：原写「studio unread 红点独立 SseClient 经核实**不存在**」→ 改为「v0.0.92 前**存在**于 `use-studio-unread-meta.ts`（违反 S1），since v0.0.92 已收敛为 `getSseClient()` 单例 + subId 区分 handler，与 playground session_meta `_all` 订阅并存不冲突」。
- §7.2 重连机制（原标「（可选）」→「since v0.0.92 已落地」）：SseClient 私有重连常量 `reconnectBaseMs=1000` / `reconnectMaxMs=30_000` / `reconnectJitterRatio=0.2`（指数回退 `base×2^k cap max × (1±0.2 jitter)`）；reader.read catch 识别 AbortError（终态）vs 瞬时错误（保 handlers + scheduleReconnect）；`destroyed` 守卫防僵尸重连；`onResumed(cb)` 回调（重连成功 / visibility 返前台时触发）；singleton 顶层注册一次 visibilitychange listener（模块级 flag 防 StrictMode 双触发）；`isConnected() = active && !destroyed`。
- 代码侧：`use-studio-unread-meta.ts:54` 改 `getSseClient()` 单例（删 new/connect/destroy）；`sse-client.ts:87-92,154-162` reconnect 实现；`sse-singleton.ts:44-51` visibilitychange listener。

**B. `[P0]component_architecture.md` §3.10 useLifecycle 契约（W4 核心 + code-review 修复）**
- 新增 §3.10：`useLifecycle<TCtx>({ init, destroy, refresh?, poll?, deps })` 单 hook 收敛「订阅 / 数据 / 定时器」三类资源 mount/unmount 管理；5 不变量（init 接 AbortSignal / destroy 幂等 / poll 显式+justification / 禁 init 内 setState 除 ctx / 禁 destroy 内 fetch）+ 6 禁忌（含禁 `new SseClient()`）。
- **reload-on-resume poll-only（正式契约，code-review 抓出 useSubagentChildren Major 后定）**：visibilitychange 切回 visible 时**仅当 poll 启用才 reload**——非 poll hook（数据走订阅/SSE onResumed、命令式 API）不重载。根因：useSubagentChildren 借 useLifecycle 只为用其 unmount cleanup（abort in-flight），不传 poll；原无条件 reload → destroy 清 controllersRef → 切回 tab 静默丢 in-flight。代码：`use-lifecycle.ts:198-209 onVisibility`（`else if (pollRef.current)`）。
- 迁移映射表：全迁 4 hook（useMemoryCrud / MemberPanelMemory / SectionWorkspacePanel(W6) / useSubagentChildren(T6)）+ follow-up 轮询类（BudgetMeter/PageConnector/CronPanel）+ 不迁引擎类。
- 代码侧：`app/web/src/lib/use-lifecycle.ts`（NEW 228 行）+ `__tests__/use-lifecycle.test.ts`（NEW）；4 hook 迁移 confirmed by grep（全部 `import { useLifecycle }`）。

**C. `index.md`（概念表 + 核心设计原则）**
- ④ 加核心原则 15（SSE 自动重连 + visibilitychange 校正）+ 原则 16（useLifecycle hook 抽象，含 reload-on-resume poll-only 契约 + 全迁 4 hook）。

**D. `log.md`**
- 顶部追加 v0.0.92.sse_opt 条目（ISO 倒序）：G1 修复 / SSE 重连 / 轮询清理 + dead code / useLifecycle 抽象 / reload-on-resume poll-only / 全迁 4 hook / 偏离记录（G6 研究误报 + budget-meter SSE 不可行）。

### 其他 KB 不受影响

- `app/server` / `agent/*` / `squad/*` / `session/*` KB：零改动（纯前端版本）。

## 验证产出

- **UT**：use-lifecycle.test.ts（destroy 幂等 + signal.aborted 守卫 + poll.justification 警告 + reload-on-resume poll-only + deps 变化 destroy+init + init 抛异常 catch 兜底）+ sse-client reconnect + use-studio-unread-meta-singleton + 既有 chat-page/studio-page 回归全绿。
- **AT/ET**：纯前端无 API/UI 契约变更，本版本 UT-only（用户接受豁免 AT/ET，见 memory `ui-only-ut-skip-at-et`）。

## Known drift

无。spec↔code 双向对齐已核验：
- sse-client.ts reconnect 常量（1000/30_000/0.2）与 §7.2 表一致。
- use-lifecycle.ts onVisibility（`else if (pollRef.current)`）与 §3.10 reload-on-resume poll-only 契约一致。
- use-studio-unread-meta.ts 用 `getSseClient()` 单例（line 54）与 §5 R3 一致。
- 4 个迁移 hook 全部 `import { useLifecycle }` confirmed。

## 版本

version 1.0（2026-07-08）：纯前端 SSE 优化 + 组件生命周期统一管理——G1 单例破口修复（use-studio-unread-meta）/ SSE 指数回退重连 + visibilitychange 校正 / 轮询清理（删 dead code + 后台暂停 + 延长过密）/ useLifecycle hook 抽象（5 不变量 + 6 禁忌 + reload-on-resume poll-only 契约）/ 全迁 4 hook（useMemoryCrud + MemberPanelMemory + SectionWorkspacePanel + useSubagentChildren）。
