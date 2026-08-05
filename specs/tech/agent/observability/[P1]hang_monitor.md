---
type: design
title: 跨三进程卡顿监控（hang monitor）
priority: P1
status: active
updated: 2026-08-05
since: v0.0.254
related: [[P0]observability_interface.md, index.md]
---

# 跨三进程卡顿监控（hang monitor）

## §1 概述

卡顿监控 = 跨三进程（server / electron 主进程 / renderer）的**事件循环卡顿自动抓捕**能力——检测「卡了多久」并在卡顿现场抓一份 CPU profile 落盘，供事后用 Chrome DevTools Performance 面板定位「卡在哪个函数」。与 trace 树链路（langfuse）人格独立：trace 回答「这次 run 做了什么」，hang monitor 回答「进程为什么卡住」。

**管**：lag 周期采样、超阈值触发 inspector CPU profile 写盘、renderer longtask 上报、三进程各自的 env 开关。
**不管**：不做 metrics 聚合/上报后端、不做 trace 树（→ `[P0]observability_interface.md`）、不做自动修复、不做历史 profile 管理（用户自行清理 `<dataDir>/profiles/`）。
**与外界交互**：写盘 `<dataDir>/profiles/<source>-<ISO时间戳>.cpuprofile` + console 结构化日志（server/electron-main）+ episode 记录落 `<dataDir>/logs/performance.log`（`kind:'hang'`，经模块级 sink → LogWriter，受 `enablePerformanceLog` 门禁）；renderer 只写 DevTools console，不落盘。

### 三进程开关与落点（速查表）

| 进程 | env 开关（默认） | 输出 | 接线点 |
|---|---|---|---|
| server（后端） | `EVENT_LOOP_MONITOR=1`（默认关） | `<dataDir>/profiles/server-<ts>.cpuprofile` + warn 日志 | `http-server.ts startServer()` listen 回调 |
| electron 主进程 | `MAIN_EVENT_LOOP_MONITOR=1`（默认关） | `<dataDir>/profiles/electron-main-<ts>.cpuprofile` + warn 日志 | `main.ts`（loadRuntimeConfig 后）经 `main-event-monitor.ts` |
| renderer（web） | `VITE_LONGTASK_MONITOR`（未设时 dev 默认开、prod 默认关） | DevTools console `[LONGTASK]` warn | `main.tsx` 首屏渲染前 |

## §2 接口 / 概念模型

### `startEventLoopMonitor(options)` → `EventLoopMonitorHandle`

实现：`app/server/src/observability/event-loop-monitor.ts`；re-export：`app/server/src/observability/index.ts` → `app/server/src/index.ts`（electron 侧经 `@app/server` 包名引用）。server 与 electron 主进程**共用同一实现**，靠 `source` / `envFlag` 区分。

关键入参（`EventLoopMonitorOptions`）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | 读 `env[envFlag]`（'1/true/yes/on' 不区分大小写为开） | 显式开关优先于 env |
| `envFlag` | `EVENT_LOOP_MONITOR` | electron 主进程传 `MAIN_EVENT_LOOP_MONITOR` |
| `source` | `'server'` | profile 文件名前缀 + 日志 tag（electron 传 `'electron-main'`） |
| `sampleIntervalMs` | 1000 | 采样周期（setInterval，unref 不拖住进程退出） |
| `lagThresholdMs` | 1000 | 单周期最坏延迟达到即判卡顿 |
| `profileDurationMs` | 3000 | 单次 CPU profile 时长 |
| `profileDir` | 无 | 写盘目录（绝对路径，调用方经 resolveDataDir 派生）；缺省只打日志不写盘 |
| `deps` | 生产全走 node 真身 | 直方图工厂 / cpuUsage / elu / timer / captureProfile / env / log 全可注入（UT 用 fake/spy） |

返回 `EventLoopMonitorHandle`：`active=false` 表示未启动（开关关 / runtime 不支持）；`stop()` 幂等（clearInterval + histogram.disable）。

### `startLongTaskMonitor(options)` → `LongTaskMonitorHandle`

实现：`app/web/src/lib/longtask-monitor.ts`。PerformanceObserver 监听 `'longtask'`（>50ms 上报，Chromium 支持）+ `'long-animation-frame'`（LoAF，能给出归因脚本 sourceURL/functionName，有则监听、没有静默跳过）。单条任务时长 > `thresholdMs`（默认 200ms）才 `console.warn('[LONGTASK]', duration, entryType, 归因摘要)`，避免 50–200ms 常规任务刷屏。开关解析：`VITE_LONGTASK_MONITOR` 显式优先；未设时 `import.meta.env.DEV` 兜底（dev 开 / prod 关）。

### episode 状态机（Node 侧）

每 tick 读直方图 `max`（ns→ms）作为本周期最坏延迟，读完即 `reset()`（下一周期独立测量）。`lag ≥ lagThresholdMs` 进入 episode：打一条 warn 结构化日志（lag + `process.cpuUsage()` 差分 + `eventLoopUtilization()` 差分 + ISO 时间戳）并触发一次 inspector CPU profile 写盘；同时调 `reportHang({kind:'hang',phase:'enter',...})` 落 performance.log（§3.8）。episode 内不重复触发；lag 回落 < 阈值退出 episode 并打 recovery info 日志 + `reportHang({kind:'hang',phase:'recover',source})`，下次超阈值重新抓捕。同时在飞的 profile 只许一个（`profileInFlight` 闸）。

## §3 设计决策

### 3.1 两级抓捕：直方图 = 烟雾报警器，CPU profile = 监控录像

`perf_hooks.monitorEventLoopDelay` 直方图测「event loop 回调排队时长」——开销极小、常驻采样，回答**卡多久**；lag 超阈值才触发 `node:inspector` Profiler 抓 ~3s CPU profile——开销大、只抓现场，回答**卡在哪个函数**。不这样做会怎样：只打日志定位不到函数（知道卡了不知道哪卡）；每 tick 都抓 profile 则监控本身成为最大卡顿源。

### 3.2 ⚠️ Bun runtime 局限（实测，最重要的一条）

**dev 用 Bun 跑 server 时，server 侧 lag 检测与 CPU profile 双双失效**：

- `monitorEventLoopDelay` 直方图对真实主线程阻塞**不敏感**——实测阻塞 1s / 3s 均恒报 ~2ms（Bun 1.3.14），永远到不了阈值，episode 不会触发。
- 即使手动触发，`node:inspector` 的 `Profiler.stop` 只返回 ~3 个空壳 node，无真实调用栈。

**仅 packaged（Electron 内嵌 Node）下有效**。已用真机 `/Applications/rocky_agent.app`（Electron 42 / Node 24）实证：阻塞 1500ms → 测得 lag=1518ms、profile 含真实调用栈。

实操含义：server 侧卡顿排查**必须在 packaged app 上开 `EVENT_LOOP_MONITOR=1` 进行**；dev(Bun) 下开了也抓不到（静默近零输出，不是 bug）。renderer longtask（Chromium）与 electron 主进程 lag（Node）两条路在 dev/prod 均有效，覆盖「界面输入卡 / 整窗彩虹圈」主症状。

### 3.3 接线在 startServer 而非 bootstrap

server 侧接线点选在 `http-server.ts startServer()` 的 listen 回调（非 `bootstrapBuiltinPlugins`）：bootstrap 首请求才懒加载，覆盖不到**启动期**卡顿；startServer 是 dev(Bun) / packaged(Electron Node) 共同的真实启动点。监控 stop 挂在 server close 回调上。

### 3.4 server 与 electron 主进程用独立 env 开关

packaged 下后端内嵌主进程（`backend-bootstrap.startBackend` → `startServer` 也接了一个 `source='server'` 的监控），两者采样的是**同一条 event loop**——若共用一个 env，一次卡顿两进程各写一份 profile 重复抓。故主进程用 `MAIN_EVENT_LOOP_MONITOR`、后端用 `EVENT_LOOP_MONITOR`，文件名前缀 `electron-main-` / `server-` 区分。

### 3.5 失败静默红线 + 关时近零开销

全程特性检测 + try/catch：`monitorEventLoopDelay` / `node:inspector` 不可用 → 最多一条 info 日志静默降级，绝不 throw 阻断启动或请求；单次采样失败静默，不影响后续 tick。开关关时不建直方图、不启 timer，近零开销。与 trace 链路同一条红线：**observability 失败绝不影响主流程**。

### 3.6 写盘路径走 resolveDataDir（BUG-004 护栏）

profile 目录一律由 `config.resolveDataDir` 派生（`http-server.ts` 用上游已展开的 `opts.dataDir`；`main-event-monitor.ts` 动态 require `@app/server/dist/config` 的 resolveDataDir），禁止字面 `~` / 相对路径——packaged app cwd=`/` 不可写，不展开必崩（EACCES/ENOENT）。

### 3.7 episode 闸 + profileInFlight 闸

一次卡顿只抓一次 profile（episode 内不重复触发，lag 回落复位后才可再抓）；同时在飞 profile 限一个。不这样做会怎样：持续卡顿期间每 tick 触发一次 3s profile，监控自身放大卡顿、瞬间写满磁盘。

### 3.8 episode 落 performance.log（sink 模块 + console 双写）

episode enter/recover 除了打 console.warn/info（dev 即时反馈），还经 `hang-sink.ts` 的 `reportHang()` 上报结构化记录到 LogWriter performance 通道（落 `<dataDir>/logs/performance.log`）。设计动机：prod GUI 单进程 stdout 不落盘，console 输出蒸发——用户开了 `enablePerformanceLog` 仍看不到卡顿文字日志（原 performance.log 只收 slow-query）。修复后两种记录都带 `kind` 字段（hang / slowquery），`grep kind:` 统一筛。

**sink 注册模式**（同 `slow-query.ts` 范式）：observability 是底座层，不反向 import dev-logs（LogWriter 在上层）。`hang-sink.ts` 只定义 `HangSink` 回调接口 + 模块级 `_sink` 变量 + `setHangSink()` / `reportHang()`；由 `bootstrap.ts`（组合根）在 LogWriter 创建后注入 `record => logWriter.write('performance', record)`。sink 未注册（null）→ `reportHang` 短路（仅判一次 `_sink`），零开销。

**HangRecord 字段**（ts 由 LogWriter 补）：

| 字段 | 含义 | phase=enter | phase=recover |
|------|------|-------------|---------------|
| `kind` | 恒 `'hang'`（与 slowquery 对称 grep） | ✓ | ✓ |
| `phase` | `'enter'` / `'recover'` | ✓ | ✓ |
| `source` | 来源标识（profile 前缀 + 日志 tag） | ✓ | ✓ |
| `lagMs` | 本周期最坏延迟（ms，取整） | ✓ | — |
| `cpuUserMs` | 用户态 CPU 增量（ms，取整） | ✓ | — |
| `cpuSysMs` | 内核态 CPU 增量（ms，取整） | ✓ | — |
| `elu` | event loop utilization 增量 | ✓ | — |
| `profileFile` | CPU profile 路径（与 warn tsIso 同源；无 profileDir 缺省） | ✓ | — |

recover 仅带 `source`——退出信号不需要当前指标快照（避免误导读者以为这是新卡顿）。metric 字段 optional（`number?`），enter 必填、recover 不带。

## §4 示例

开启 server 侧监控（packaged 真机）并查看 profile：

```bash
EVENT_LOOP_MONITOR=1 /Applications/rocky_agent.app/Contents/MacOS/rocky_agent
# 卡顿发生后：
ls ~/Library/Application\ Support/rocky_agent/profiles/
# server-2026-08-04T11-22-33-456Z.cpuprofile
# → 拖入 Chrome DevTools → Performance 面板看火焰图
```

卡顿现场 warn 日志（server / electron-main 同格式）：

```
[event-loop-monitor] server event loop lag=1518ms >= 1000ms cpuUser=+1420ms cpuSys=+35ms elu=0.97 ts=2026-08-04T11:22:33.456Z
[event-loop-monitor] cpu profile written: <dataDir>/profiles/server-2026-08-04T11-22-33-456Z.cpuprofile
[event-loop-monitor] server lag recovered (<1000ms)
```

`performance.log` 中对应的 episode 记录（JSONL，`enablePerformanceLog=true` 时落盘）：

```
{"ts":"2026-08-04T11:22:33.456Z","kind":"hang","phase":"enter","source":"server","lagMs":1518,"cpuUserMs":1420,"cpuSysMs":35,"elu":0.97,"profileFile":"<dataDir>/profiles/server-2026-08-04T11-22-33-456Z.cpuprofile"}
{"ts":"2026-08-04T11:22:35.789Z","kind":"hang","phase":"recover","source":"server"}
```

`grep kind:hang performance.log` 可筛出全部卡顿记录；`profileFile` 路径与 warn 日志的 tsIso 同源，直接拖入 Chrome DevTools 看火焰图。

renderer 侧（DevTools console）：

```
[LONGTASK] 832ms longtask task=unknown src=
[LONGTASK] 1250ms long-animation-frame script=flushSync@http://localhost:8900/node_modules/.vite/deps/chunk-XXX.js
```

## §5 边界

| 零件 | 唯一归属 |
|---|---|
| Node 侧监控实现（直方图 + episode + inspector profile） | `app/server/src/observability/event-loop-monitor.ts` |
| episode → performance.log sink（HangRecord + setHangSink + reportHang） | `app/server/src/observability/hang-sink.ts` |
| sink 注入（组合根） | `app/server/src/bootstrap.ts`（`setHangSink(r => logWriter.write('performance', r))`，紧接 `setSlowQuerySink`） |
| server 接线 | `app/server/src/http-server.ts`（`startServer` listen 回调；close 时 stop） |
| electron 主进程接线 | `app/electron/src/main-event-monitor.ts`，`main.ts` loadRuntimeConfig 后调用 |
| renderer 长任务监控 | `app/web/src/lib/longtask-monitor.ts`，`main.tsx` 首屏渲染前调用 |
| re-export | `app/server/src/observability/index.ts` → `app/server/src/index.ts`（`@app/server` 包名，electron 跨 workspace 值导入） |
| trace 树 / generation / span（与本文件人格独立） | `[P0]observability_interface.md` |
| dataDir 展开权威 | `app/server/src/config.ts`（`resolveDataDir`，BUG-004 护栏） |
