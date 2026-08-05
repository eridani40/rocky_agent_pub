# v0.0.257 tech change log — 慢查询性能日志（performance.log + enablePerformanceLog 开关）

> 对应需求：`reqs/[working] v0.0.257/req.md`（三条硬约束：异步化不加剧延迟 / 队列有界太长就放弃 / 开关在 app config 可观测性）。
> 本版本无 PRD / change_plan（简化流程：纯技术改动 + UI 配置项，UT 为主，无 AT/ET）。

## 变更摘要

### 需求与动机

不猜哪个实体卡——在持久层查询入口加**慢查询性能日志**，让真实数据定位 prod 卡顿真凶；抓到具体慢查询后再决定优化方向（迁 sqlite / 加索引 / 缓存，另立版本）。本版本不改任何查询逻辑、不迁 SQLite。

### 核心机制（persistence 底座 + dev-logs 复用）

- **新模块 `app/server/src/persistence/slow-query.ts`**（95 行）：
  - `SLOW_QUERY_MS = 200`——慢查询阈值，**严格大于**（耗时恰好 200ms 不算慢）；先固定常量（参数化留注释，后续版本可接 app_config）。
  - `SlowQueryInfo`——一条慢查询记录的业务字段：`{engine: 'fs'|'sqlite', entity, shardKey: string|null, ms, count, filter}`（`ts` 由 LogWriter 补）。
  - `SlowQuerySink = (info) => void` + `setSlowQuerySink(sink|null)`——**模块级注册点**（进程内唯一；bootstrap 装配一次，传 null 注销供 UT 隔离；未注册 = 完全不产出慢日志）。
  - `queryWithSlowLog(engine, schema, filter, fn, nowMs)`——计时包装：执行原查询 → 超阈值上报 sink，返回值原样透传零行为变更；sink 未注册时短路（仅一次 `nowMs()` 开销，不构造任何对象）。
- **埋点**：`fs-store.ts:FsCrudStore.query()`（`'fs'`）+ `sqlite-store.ts:SqliteCrudStore.query()`（`'sqlite'`）——同一 `CrudStore.query` 接口两 engine 都包；`nowMs` 时钟构造注入（`FsCrudStore` opts / `SqliteCrudStore` opts，缺省 `Date.now`，UT 可控）。
- **sink 装配**：`bootstrap.ts` 在 LogWriter 创建后 `setSlowQuerySink(info => logWriter.write('performance', info))`。
- **新 log type `'performance'`**：`log-writer.ts` `LogType` 6→7 + `TYPE_TO_KEY` 加 `performance: 'enablePerformanceLog'` → 落 `<DATA_DIR>/logs/performance.log`（JSONL）。
- **前端开关**：`app-settings-config-defs.ts` KV_GROUPS logs group 第 7 个 toggle `enablePerformanceLog`（默认 false；设置 → 可观测性 → 日志 group →「记录性能日志」）+ i18n zh-CN/en `schema.logs.enablePerformanceLog.{label,desc}`。

### 设计决策：sink 注册点模式（底座不反向依赖上层）

persistence 是最底层基座，LogWriter（dev-logs）在上层——底座 import 上层会反转分层。故 slow-query.ts 只定义 sink 回调接口 + 模块级注册点，由 bootstrap（组合根）注入 LogWriter 适配；与 `setSessionStoreEpDelegate` / `setTokenUsageSubscriberDeps` 同范式。效果：persistence 零感知日志机制，开关门禁 / 队列有界 / 失败静默全部复用 dev-logs 既有机制，不重复实现。

### 三条硬约束的兑现

1. **异步化不加剧延迟**：上报 void fire-and-forget——sink 适配到 `LogWriter.write` = O(1) stringify + enqueue，单 consumer 异步 appendFile，查询主路径零磁盘 IO。
2. **队列有界太长就放弃**：复用 LogQueue 500MB byte buffer + drop-new（FIFO 丢新保老）+ 失败静默，本模块不重复实现。
3. **开关在可观测性**：`logs.enablePerformanceLog` 默认 false；开关 false 时 `LogWriter.write` 内部 `?? false` 门禁早 return（零开销：不 stringify、不 enqueue）；UI 改开关下一次 write 即生效，无需重启。

### 测试口径

UT 为主（`persistence/__tests__/slow-query.test.ts`，283 行）：超阈值上报字段正确 / 恰好等于阈值不上报 / sink 未注册零副作用（结果原样透传）/ 注销后不再上报 / nowMs 注入时钟控制 / 开关 false 门禁早 return。无 AT/ET（持久层 + 前端配置项，无 API 契约变更）。

## spec 同步（doc-modifier 阶段 5）

- **dev-logs KB**：`[P0]overall.md` §3.7 新增（Slow query performance hook 全文：注入位置/依赖路径/捕获字段/时机/零开销）+ §2.2 文件列表加 performance.log + §2.4 TYPE_TO_KEY 加 performance + §2.5 轮转类型清单 + §4 KV_GROUPS 加第 7 toggle（顺带修正 page-dev-config.tsx DEV_GROUPS → app-settings-config-defs.ts KV_GROUPS 的引用漂移）+ §5 关键代码路径补慢查询链 + §7 UT 范围；`index.md` 6→7（开关/hook/LogType/ASCII + performance hook 反向装配说明）；`log.md` 本版本条目。
- **persistence KB**：`[P0]crud_store_interface.md` §2.5 新增（SlowQuerySink + queryWithSlowLog 接口契约）+ §3.8 设计决策（sink 注册点模式，三段式）+ §5 边界表加慢查询埋点行；`index.md` 概念表加 SlowQuerySink + 边界加注册点行 + ④ 原则 7（底座不反向依赖上层）；`log.md` 本版本条目；`[P0]fs_crud_store_engine.md` / `[P0]sqlite_crud_store_engine.md` §4 操作映射 query 行各补一句埋点注记。
