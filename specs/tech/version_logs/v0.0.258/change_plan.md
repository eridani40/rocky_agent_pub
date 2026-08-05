# v0.0.258 变更计划书 — 卡顿 episode 落 performance.log（接 LogWriter，修 console 蒸发）

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么（禁模糊描述） |
| 约束 | MUST / MUST NOT |
| 参考 | spec 位置（路径+章节 / 原则编号） |
| 预计影响行 | +N / -M |

## 关键架构决策（5 点实测结论）

1. **接线方式 = 模块级 sink 注册**（同 slow-query.ts 范式）：新建 `hang-sink.ts`，export `setHangSink` + `reportHang` + `HangRecord`。bootstrap 注入 `setHangSink(r => logWriter.write('performance', r))`。两调用点（http-server / main-event-monitor）**零改动**——sink 是 event-loop-monitor 内部检查的。
2. **electron-main 接线（实测结论）**：packaged 下 `backend-bootstrap.startBackend()` 调 `require('@app/server').startServer()` **进程内直调**（非 fork），electron main 与 server 共享同一 Node event loop（hang_monitor spec §3.4 已记录）。两监控共享同一模块级 sink。sink 在 bootstrap（首请求）注册——监控启动早于 sink 注册，但 episode 是运行时事件，sink 在 episode 发生时已就绪；启动期极端 hang（首请求前）只 console.warn，可接受。
3. **格式**：HangRecord = `{ kind:'hang', phase:'enter'|'recover', source, lagMs, cpuUserMs, cpuSysMs, elu, profileFile? }`；SlowQueryInfo 加 `kind:'slowquery'`（对称 grep `kind:`）。ts 由 LogWriter 补；profileFile 含在 record 内（同 tsIso 派生，grep kind:hang → 看路径 → 开 DevTools）。
4. **开关**：走 `logWriter.write('performance', ...)` → 自动受 `enablePerformanceLog` 门禁。无新开关。
5. **console 保留**：双写——console.warn/info 保留（dev 即时反馈，监控开即有）+ LogWriter sink（文件落盘，`enablePerformanceLog` 开即有）。不互斥。

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| observability | app/server/src/observability/hang-sink.ts | HangRecord | 新增 | 卡顿 episode 结构化记录类型：`{ kind:'hang', phase:'enter'\|'recover', source:string, lagMs:number, cpuUserMs:number, cpuSysMs:number, elu:number, profileFile?:string }`。type 别名（非 interface）以兼容 LogWriter.write 的 `Record<string,unknown>` 参数 | MUST kind 恒 'hang'（与 slowquery 对称 grep）；MUST NOT 含 ts 字段（LogWriter 补） | slow-query.ts SlowQueryInfo（同范式）；dev-logs §3.7 | +12 |
| observability | app/server/src/observability/hang-sink.ts | HangSink | 新增 | sink 回调类型 `(record: HangRecord) => void`（fire-and-forget，void 签名不阻塞 tick） | 同 SlowQuerySink 签名风格 | slow-query.ts:46 | +1 |
| observability | app/server/src/observability/hang-sink.ts | _sink | 新增 | 模块级 sink 变量 `let _sink: HangSink \| null = null`（进程内唯一；null = 完全不产出） | MUST NOT 在 event-loop-monitor 内直接持有引用（解耦，UT 可 setHangSink(null) 隔离） | slow-query.ts:49 | +1 |
| observability | app/server/src/observability/hang-sink.ts | setHangSink() | 新增 | 注册/注销 sink：`setHangSink(sink: HangSink \| null): void`。bootstrap 调一次注入；UT 传 null 注销隔离 | MUST 幂等（重复调覆盖前值） | slow-query.ts:55 setSlowQuerySink（同范式） | +4 |
| observability | app/server/src/observability/hang-sink.ts | reportHang() | 新增 | 上报通道：`reportHang(record: HangRecord): void`，读 `_sink` 非空则调。供 event-loop-monitor tick() 调用 | MUST sink 为 null 时零副作用（不构造 record 由调用方控制）；MUST NOT throw（观测红线） | slow-query.ts queryWithSlowLog 内 sink 调用模式 | +4 |
| observability | app/server/src/observability/event-loop-monitor.ts | import reportHang | 新增 | 顶部 `import { reportHang } from './hang-sink'`（引入上报通道） | MUST NOT import LogWriter（底座不反向依赖上层；sink 模块无 dev-logs 依赖） | 原则：依赖方向 上层→底座 | +1 |
| observability | app/server/src/observability/event-loop-monitor.ts | tick() — episode enter | 修改 | episode 进入分支：将 `const filePath` 从 if 块内提取为 `const profileFile = profileDir ? join(...) : undefined`（含.tsIso 派生路径，供 record + captureProfile 共用）；在 log.warn 后调 `reportHang({kind:'hang',phase:'enter',source,lagMs:Math.round(lagMs),cpuUserMs:Math.round(cpuDiff.user/1000),cpuSysMs:Math.round(cpuDiff.system/1000),elu:eluDiff.utilization,profileFile})`；captureProfile 参数改用 profileFile | MUST profileFile 计算在 reportHang 之前（record 需引用）；MUST 保持 log.warn 不删（双写）；MUST NOT 在 profileInFlight=true 时跳过 record（record 含路径即使 profile 未抓） | hang_monitor §2 episode 状态机；dev-logs §3.7（sink 模式） | +10/-4 |
| observability | app/server/src/observability/event-loop-monitor.ts | tick() — episode recover | 修改 | episode 退出分支（`else if (inEpisode)`）：在 `log.info(...recovered...)` 后加 `reportHang({kind:'hang',phase:'recover',source})` | MUST 保持 log.info 不删（双写） | hang_monitor §2 episode 状态机 | +1 |
| persistence | app/server/src/persistence/slow-query.ts | SlowQueryInfo | 修改 | type 加 `kind:'slowquery'` 字段（与 HangRecord 的 kind:'hang' 对称，便于 `grep kind:` 统一筛 performance.log） | MUST kind 恒 'slowquery'（字面量） | dev-logs §3.7 SlowQueryInfo | +1 |
| persistence | app/server/src/persistence/slow-query.ts | queryWithSlowLog() | 修改 | sink 调用的 record 对象加 `kind:'slowquery'` 属性 | MUST 与 type 声明一致 | dev-logs §3.7 | +1 |
| bootstrap | app/server/src/bootstrap.ts | import setHangSink | 新增 | 顶部 `import { setHangSink } from './observability/hang-sink'` | — | 同 setSlowQuerySink import 风格（L68） | +1 |
| bootstrap | app/server/src/bootstrap.ts | bootstrapBuiltinPlugins() — setHangSink 注入 | 修改 | 在 `setSlowQuerySink(...)`（L323）之后紧接 `setHangSink((record) => logWriter.write('performance', record))`（同一 logWriter 实例，同 performance 通道） | MUST 在 logWriter 创建之后；MUST NOT 新建 LogWriter 实例（复用 L317 单例） | dev-logs §2.6 装配点；§3.7 sink 注入范式 | +2 |
| observability/test | app/server/src/observability/__tests__/event-loop-monitor.test.ts | hang sink 测试块 | 修改 | 新增 describe('hang sink')：(1) episode enter → reportHang 被调 + record.kind='hang'/phase='enter'/含 lagMs/cpuUserMs/cpuSysMs/elu/profileFile；(2) episode recover → record.phase='recover'；(3) sink null（setHangSink(null)）→ episode 触发但不调 sink（零副作用）；(4) 后置清理 setHangSink(null) | MUST 每 test 后 setHangSink(null) 隔离（模块级状态防泄漏） | slow-query.test.ts collectSink 模式 | +45 |
| persistence/test | app/server/src/persistence/__tests__/slow-query.test.ts | kind 断言 | 修改 | 在现有 sink 上报断言中加 `expect(info.kind).toBe('slowquery')`（不改既有断言，仅补 kind 字段校验） | MUST NOT 删/改既有断言（只加不改） | — | +3 |

## 影响面评估

- **跨模块**：observability（hang-sink + event-loop-monitor）+ persistence（slow-query）+ bootstrap（组合根注入）。三模块但改动极小，核心新增在 hang-sink.ts（~22 行新文件）。
- **无破坏性变更**：console.warn/info 保留（双写）；slow-query 加字段不破坏既有消费方（LogWriter.write 接受任意 Record）；event-loop-monitor 对外签名不变。
- **文件体量**：event-loop-monitor.ts 290 行 → 预计 ~299 行（极限但 ≤300）。hang-sink.ts ~22 行。均在限内。
- **packaged 影响**：hang-sink.ts 是纯 server 模块（app/server/src/），编译进 @app/server dist，packaged 可达（与 slow-query.ts 同路径同构建）。不涉及新依赖、不涉及 electron 直接 import。无打包风险。
- **时序**：sink 注册（bootstrap 首请求）晚于监控启动（startServer），但 episode 是运行时事件——sink 在 episode 发生时已就绪。极端启动期 hang（首请求前）只 console + cpuprofile，无 LogWriter 文字记录（可接受边缘情况）。
- **依赖方向**：hang-sink.ts 无 import（独立底座模块）；event-loop-monitor import hang-sink；bootstrap import hang-sink + LogWriter。无循环依赖。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
