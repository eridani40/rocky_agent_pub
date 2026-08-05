---
type: log
title: Dev Logs 变更
updated: 2026-08-05
---

# Dev Logs 变更

## 2026-08-05 · v0.0.258（performance.log 第二数据源 — 卡顿 episode + kind 字段）

- **`[P0]overall.md §3.8` 新增（performance 第二个 hook 点）**：Hang episode performance hook → `logs/performance.log`（与 §3.7 slow-query 共享同一文件 + `enablePerformanceLog` 门禁）。event-loop-monitor tick() 的 episode enter/recover 经 `observability/hang-sink.ts`（模块级 sink，同 slow-query.ts 范式）上报 `HangRecord`（`kind:'hang'` + phase/source + enter 阶段的 lagMs/cpuUserMs/cpuSysMs/elu/profileFile）。console 保留（双写）。bootstrap 注入 `setHangSink(record => logWriter.write('performance', record))` 紧接 `setSlowQuerySink`。
- **§3.7 SlowQueryInfo 加 `kind:'slowquery'`**：与 HangRecord 的 `kind:'hang'` 对称——`grep kind:` 统一筛 performance.log 中不同来源记录。
- **§3 intro + §2.2 文件列表 + §5 代码路径同步**：performance.log 现有两个数据源（slow-query + hang），靠 `kind` 字段区分；§5 补卡顿 episode 代码路径。
- 用途：修 prod GUI stdout 蒸发——原 console.warn/info 只在 dev 可见，prod 开了 `enablePerformanceLog` 也看不到卡顿文字日志。

## 2026-08-05 · v0.0.257（LogType 6→7：performance 慢查询性能日志 + enablePerformanceLog 开关）

- **`[P0]overall.md §3.7` 新增（第 7 个 hook 点）**：Slow query performance hook → `logs/performance.log`——persistence 两 engine（`FsCrudStore.query` / `SqliteCrudStore.query`）入口经 `persistence/slow-query.ts:queryWithSlowLog` 计时包装，耗时严格大于 `SLOW_QUERY_MS=200` 上报；字段 `{engine, entity, shardKey, ms, count, filter}`（ts 由 LogWriter 补）。**sink 注册点模式**：persistence 底座只定义 `SlowQuerySink` 接口 + `setSlowQuerySink` 模块级注册点（不反向 import dev-logs，保上层→底座单向依赖），`bootstrap.ts` 组合根在 LogWriter 创建后注入 `info => logWriter.write('performance', info)`。复用既有全部机制：write 门禁早 return 零开销（开关 false）、LogQueue 500MB drop-new + 失败静默、异步不阻塞查询主路径。
- **§2.2/§2.4/§2.5/§4/§5/§7 同步**：LogType 6→7（`performance: 'enablePerformanceLog'`）、文件列表加 `logs/performance.log`、KV_GROUPS（原 DEV_GROUPS 引用漂移一并修正为 `app-settings-config-defs.ts`，label/desc 走 i18n）加第 7 个 toggle、关键代码路径补慢查询链、UT 范围补 `slow-query.test.ts` 断言项。前端开关：设置 → 可观测性 → 日志 group →「记录性能日志」；i18n zh-CN/en 各加 `schema.logs.enablePerformanceLog.{label,desc}`。
- 用途：定位 prod 卡顿真凶（不猜哪个 entity，让慢日志说话）；抓到真凶后的优化（迁 sqlite/索引/缓存）另立版本。
- 详情：`specs/tech/version_logs/v0.0.257/change_log.md`

## 2026-07-30 · v0.0.224（error.log 新增工具层注入点 — web_fetch 失败归因）

- **`[P0]overall.md §3.6`**：error.log 在 run 层/LLM 层之外新增**工具层注入点**——`web-fetch/tool.ts:writeWebFetchErrorLog`（web_fetch 三类失败路径各一条：SSRF 拒绝/异常 `stage:'ssrf'`、fetchContent 抛错 `stage:'race'`、两路皆空 `stage:'race'`+`failures:[{fetcher,reason}]`；字段 `tool:'web_fetch'`/`url`/`stage`/`reason`/`failures?`，**无 `layer` 字段**，经 `ctx.config.logWriter` 鸭子类型探测，日志异常静默）。§4 DEV_GROUPS `enableErrorLog` desc 同步「run/LLM/工具失败」。
- 详情：`specs/tech/version_logs/v0.0.224/change_plan.md`

## 2026-07-14 · v0.0.144（error.log 分层：加 `layer` 字段 + LLM 层 per-attempt 失败记录）

- **`[P0]overall.md §3.6` 重写（4→更精确的两注入点 + `layer` 字段）**：error.log 记录统一带 `layer` 字段区分来源——**run 层**（`layer:'run'`，`run-react-loop.ts` catch，每 run 失败一条，字段 sessionId/runId/category/message/stack/displayReason）+ **LLM 层**（`layer:'llm'`，`llm_caller.ts:invokeCore` 的 `result.kind==='error'` 分支，`appendRecentError` 后 `decideAction` 前，**每次 attempt 失败一条含重试中每次/TIMEOUT**，字段 sessionId/category/message/attempt/providerId/modelId/keyRef）。invoke 级 all_dead/max_tokens 终态由 run 层兜底不重复。与 `llm.log`（invoke 级快照）职责不重叠都保留。受 `enableErrorLog` 门禁（默认 false 零开销早 return）。`LogWriter.write` 无需改 schema（record 是自由 Record，`layer` 直接进）。§7 UT 范围同步补 layer 断言。
- 背景：v0.0.144 需求1「分层失败日志」——此前 error.log 只在 run 层写一条、LLM 失败细节只散在 llm.log invoke 级聚合；补 layer 字段 + LLM 层 per-attempt 后可跨层统一失败视图（含重试中每次失败）。

详情：`specs/tech/version_logs/v0.0.144/change_plan.md`

## 2026-07-14 · v0.0.138（LogWriter → 有界消费者队列 + drop-new + 按 type 文件轮转 + api.log 加 durationMs）

- **`[P0]overall.md §2.3` 重写（核心契约升级）**：LogWriter 落盘机制从「write 内逐条直调 `appendFile`」改为 **LogQueue 有界消费者队列**（新文件 `log-queue.ts`）。生产者（`write` 同步路径）= 零开销门禁 → `JSON.stringify`（留生产者侧，GC 友好）→ `queue.enqueue(type, line)` O(1) fire-and-forget；消费者（单 async loop，lazy 启 on first enqueue）= 按 type 分桶取 batch（≤64 条/≤1MB）→ 每 type 单次 `appendFile({flag:'a'})` → 批间 `await sleep(250ms)` yield 让出 event loop。**核心修复**：旧直调 appendFile 字面兑现 fire-and-forget 但违背「不阻塞」精神（每条 syscall + 同步 stringify，squad leader 巨型状态同步下致 API 慢）；现回归 spec 意图（memory `async-marked-fn-sync-io-blocks-eventloop`）。
- **`§2.3` 500MB byte 有界 buffer + drop-new**：`MAX_BUFFER_BYTES=500MB`（用户硬上限，byte 计量非条数——单条 size 跨度大）；`enqueue` 时 `bufferedBytes+size > MAX` → drop new（FIFO 丢新保老）+ 节流 warn（10s 窗口聚合 N 条计数）。稳态 queue 几乎恒空（256 条/s 消费率远超 ingest），burst 才触发；dev 日志旁观者，drop 不影响业务。
- **`§2.3` flush 契约 + `writing` flag**：consumer 在 appendFile **前** shift 条目出队 → `q.length===0` ≠ IO 完成（race：consumer 在 appendFile pending 时 flush 误判完成）。加 `writing` flag（appendFile 段内置 true / finally false），`flush()` 条件 `q.length>0 || writing`。flush 仅 UT 用，生产 shutdown 不调（dev 日志可丢）。
- **`§2.5` 日志文件轮转（新章节 — 改造#5）**：补磁盘轮转（内存 buffer 500MB 已封顶，磁盘文件此前无界——api.log 180M/llm.log 1G）。规格：每 type 独立 size-based，活跃文件恒 `<type>.log`（保 `tail -f`），单文件 ≥ `ROTATION_MAX_FILE_BYTES=50MB` 触发 rename `<type>.log`→`<type>-YYYYMMDD-HHMMSS-mmm.log`（带毫秒防同秒碰撞）→ `readdir` 筛 `<type>-*.log`，> `ROTATION_MAX_FILES=10` 按名（=时间戳字典序）`unlink` 最老直到剩 9。`fileSizeByType: Map<LogType, number>` 单线程 consumer 维护，首次写某 type 前 `stat` 既有文件初始化（接续重启前 size）。每类型磁盘 ≤500MB，6 类型 ≤3GB。失败静默（同核心红线）。
- **`§2.1/§2.2` 文件名 4→6 + 章节重编号**：§2.1 加 `log-queue.ts` 位置 + 独占 LogQueue 约束；§2.2 文件列表补 `logs/agent.log` + `logs/error.log` + api.log 加 `durationMs` 标注。§2.4 零开销门禁代码示例改 `this.queue.enqueue` 路径（删 `appendFile` 直调僵尸）；原 §2.5 依赖注入 → §2.6。
- **`§3.3` api hook 加 `durationMs` 字段（改造#3）**：`router.handleRequest` dispatch 前 `const start = Date.now()`，write 时算 `durationMs: Date.now() - start`。2 行级改动，零行为变化（仅 log 字段加一个，非 API 契约）。
- **`index.md` 概念表加 LogQueue/日志轮转两行 + §② 边界把「文件轮转」挪到管 + §③ ASCII 反映 queue 链路**。
- **公共 API 零变化**：`LogWriter.write(type, record)` 签名不变；行为变化（落盘延迟 ≥250ms / 队列满 drop new / api.log 多 durationMs）向后兼容。

详情：`specs/tech/version_logs/v0.0.138/change_plan.md`

## 2026-07-13 · v0.0.130.hang（补记 agent/error hook — spec 对齐代码，4→6 hook）

- **`[P0]overall.md §3` 4→6 hook**：补记 §3.5 **Agent loop breadcrumb hook**（`logs.enableAgentLog` → `logs/agent.log`；`run-react-loop.ts` 各阶段边界注入 `loop_enter/step/exit` + `loop_tools_begin/end` + `state_change` + `inbox_*`，只记 id/类型/计数不记内容，诊断 hang/stuck-running）+ §3.6 **Error hook**（`logs.enableErrorLog` → `logs/error.log`，run catch 块 category/message/stack/displayReason）。§4 DEV_GROUPS 补两 key。`index.md` 4→6 hook + `LogType` 补 error/agent。
- 背景：`enableAgentLog`/`enableErrorLog` 早随 breadcrumb（E 模块）落 dev1 + `app_config §3.8`，但 dev-logs KB 仍写「4 hook」——本次补齐 spec↔code 对齐（rule 12/13）。`loop_tools_begin/end` breadcrumb 是 v0.0.130.hang SSE `tool_execution_start/end` 的同址来源（一机制两用，见 `../agent/agent_interface_and_loop/[P0]agent_event.md §5.6`）。

## 2026-07-08 · v0.0.89（logs group 迁入 app_config — DevConfigService 废弃）

- **`[P0]overall.md §2.4`**：LogWriter 构造形参 `devConfig: DevConfigService` 改 `appConfig: AppConfigService`；`shouldWrite` 读取 `appConfig.get('logs', <key>) ?? false`。**group/key 名零变更**（仍是 `logs/enableLlmRequestLog` / `enableToolResultLog` / `enableAppApiLog` / `enableEventLog`），仅 entity 名从 `dev_config` 改 `app_config`。
- **`§2` 注释段更新**：`logs` group 存储归属从 `dev_config` 改 `app_config`（v0.0.89 起迁入）；权威定义在 `[P0]app_config.md §3.8`（原 `[P0]dev_config.md §3.6` 于 2026-07-12 随 dev_config spec 删除）。
- **代码落点（T1 已 verified）**：`app/server/src/dev-logs/log-writer.ts:LogWriter` 构造形参改名 + `shouldWrite` 改读 appConfig；`bootstrap.ts` 注入改 appConfig；4 个 hook 点（llm/tool/api/event）调用入口不变（仍 `logWriter.write(type, record)`，门禁在内部读 appConfig）。
- **AT**：dev_to_app_migration (P10) 覆盖 GET /config/app?group=logs 返 4 个 boolean（迁后落点验证）。

详情：`specs/tech/version_logs/v0.0.89/change_log.md`

## 2026-06-30 · v0.0.35
- OKF 迁移：建 `index.md` + `log.md` + frontmatter；正文去版本噪声 → `../version_logs/v0.0.35/`

## 2026-06-28 · v0.0.30
- 引入：dev_config `logs` group（4 boolean 开关）+ LogWriter（JSONL 追加）+ 4 hook 点契约（llm/tool/api/event）；spec-only 概念先行 → `../version_logs/v0.0.30/`
