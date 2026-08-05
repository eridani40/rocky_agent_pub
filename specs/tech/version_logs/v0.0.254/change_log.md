# v0.0.254 change_log — 跨三进程卡顿自动监控埋点

> 版本轴发布说明。目录级（位置轴）变更见 `specs/tech/agent/observability/log.md`；现状契约见 `[P1]hang_monitor.md`。

## 交付内容

新增**跨三进程卡顿监控（hang monitor）**：检测 event loop 卡顿并在现场抓 CPU profile 落盘，供 Chrome DevTools Performance 面板定位卡点函数。归属 observability KB（`specs/tech/agent/observability/`），与 langfuse trace 链路人格独立。

| 进程 | 开关 | 实现 | 接线 |
|---|---|---|---|
| server | `EVENT_LOOP_MONITOR=1`（默认关） | `app/server/src/observability/event-loop-monitor.ts`（`startEventLoopMonitor`） | `http-server.ts startServer()` listen 回调 |
| electron 主进程 | `MAIN_EVENT_LOOP_MONITOR=1`（默认关） | 复用 @app/server 同一实现，`source='electron-main'` | `app/electron/src/main-event-monitor.ts`，`main.ts` loadRuntimeConfig 后 |
| renderer | `VITE_LONGTASK_MONITOR`（dev 默认开 / prod 默认关） | `app/web/src/lib/longtask-monitor.ts`（PerformanceObserver longtask + LoAF） | `app/web/src/main.tsx` 首屏渲染前 |

- **监控原理**：`perf_hooks.monitorEventLoopDelay` 直方图周期采样（默认 1s/tick，读 max 即 reset）测「卡多久」；lag ≥ 阈值（默认 1000ms）进 episode 打 warn 日志（含 cpuUsage/ELU 差分）并触发一次 `node:inspector` CPU profile（默认 3s）写盘 `<dataDir>/profiles/<source>-<ISO ts>.cpuprofile`。episode 闸（一次卡顿只抓一次、回落复位）+ profileInFlight 闸（在飞限一个）。
- **⚠️ Bun 局限（实测）**：dev(Bun 1.3.14) 下 server 侧 monitorEventLoopDelay 对真实主线程阻塞不敏感（阻塞 1s/3s 恒报 ~2ms）+ inspector Profiler.stop 只返 ~3 空壳 node → **server 侧仅 packaged(Electron Node) 有效**（真机 Electron 42/Node 24 实证：阻塞 1500ms→测得 1518ms、profile 含真实调用栈）。renderer longtask（Chromium）与 electron 主进程 lag（Node）两条路 dev/prod 均有效。
- **红线**：失败静默（特性检测 + 全 try/catch，监控绝不影响启动/主流程）；开关关时近零开销（不建直方图不启 timer）；写盘走 `resolveDataDir`（BUG-004 护栏）。
- **re-export**：`app/server/src/observability/index.ts` → `app/server/src/index.ts`。

## spec 同步

- 新增 `specs/tech/agent/observability/[P1]hang_monitor.md`（5 章：概述/接口/设计决策/示例/边界）。
- `index.md`：① 补第三条链路 + 概念表 HangMonitor 行；② 边界行；④ 第 8 条原则；⑤ 导航「卡顿监控」分区。
- `log.md`：2026-08-04 条目。
