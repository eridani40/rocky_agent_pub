# v0.0.194 变更计划书 — squad token 用量统计（SQLite engine 扶正 + 时序表 + 异步事件 + 独立路由）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（persistence / squad / handlers / ui-studio / packaged） |
| 文件路径 | 完整相对路径（worktree 内） |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

---

## 用户裁决（钉死边界，不可议）

1. **token_usage_stat 用 SQLite engine**（engine='sqlite'），不走 FsCrudStore；**必须经 CrudStore/SchemaDef**（用户原话「用我们的 schema store 存储体系」），不能旁路单独走 SQL
2. **SQLite engine 扶正**（CrudStore 的 sqlite engine 从实验态 → packaged 可用）：重写 sqlite-{store,rows,schema}.ts 复用 `search-sql-driver.ts` 的 SqlDriver 抽象（三实现 + 动态 import + createSqlDriver 工厂），**统一不两套**
3. **better-sqlite3** 进 `@app/server/package.json` deps + asarUnpack（electron-builder.yml 已有 `**/*.node` 通配）+ Electron ABI rebuild 走 build-native.sh（守 memory `native-addon-workspace-skip-install-nodegyp` + 现有 computer-native 先例）
4. **migration 不做**（用户核实无精确数据源，最终决策）：`persistUsage`（session-store-usage-impl.ts:188）只有 `runUsage` 传入才写 `run.usage`，用户实测 run JSON **无 usage 字段** → 实际没落（调用没传 runUsage），run.usage 无数据；usage 流式 emit UsageBlock 但 message/transcript **不持久化**（前端不渲染过滤）；session.usage 只有累计总量（三分区）无 per-call 时间分布 → migration（遍历 run 复原）**无精确数据源** → 不做。**token_usage_stat 从空表开始，subscriber 从上线后统计新数据**（首见记 0，避免把历史累计一次性写入）

---

## SQLite engine 扶正方案（T0 核心）

### 现状
- `SqliteCrudStore`（sqlite-store.ts:19）顶层 `import { Database, ... } from 'bun:sqlite'` —— **packaged Electron Node CJS 不可用**（代码注释明示「实验库」）
- 项目先例：`search-sql-driver.ts` 已实现 SqlDriver 抽象 + 三实现（BunSqlDriver/NodeSqlDriver/BetterSqlite3Driver）+ 动态 import + `createSqlDriver(path)` 工厂 —— 为 search.sqlite 专用，**CrudStore 未复用**

### 方案（SqlDriver 复用 + CrudStore 重写）
1. **SqliteCrudStore 改为接收 SqlDriver 实例**（构造注入，不再 `new Database(path)`）
2. **sqlite-rows.ts** 的 `PrepareFn` 返回类型从 `Statement`(bun) 改为 `SqlStatement`（search-sql-driver 契约）；sqlite-rows 现有 `.get(id)` 调用依赖 SqlStatement 契约扩展 `.get()` 方法（见下行）
3. **sqlite-schema.ts** 的 `ensureTable` / `applyWal` 入参从 `DatabaseInstance`(bun) 改为 `SqlDriver`；内部 `db.exec()` → `driver.exec()`
4. **sqlite-query.ts** 纯 SQL 字符串构造，**不动**
5. **transaction 重写**：原 `this.db.transaction(() => fn(this))`（bun:sqlite 专有）→ 手动 `BEGIN/COMMIT/ROLLBACK` via `driver.exec`（跨 driver 共识，node:sqlite/better-sqlite3 均不支持 bun 式 transaction 高阶函数）
6. **stmtCache** 保留（sqlite-store.ts 现有 Map<string, Statement>）—— cache value 类型从 `Statement`(bun) 改为 `SqlStatement`；driver.prepare 是否缓存由实现决定（spec §3.5），sqlite-store 自维护上层缓存避免重复 prepare

### packaged（better-sqlite3 接入）
- `app/server/package.json`：`dependencies` 加 `"better-sqlite3": "^11.x"`（BUG-002 类型：packaged 后端用 → 进使用它的 workspace package.json，不能只根 package.json）
- `app/electron/electron-builder.yml`：现有 `asarUnpack: ['**/*.node', '**/*.dylib']` **已覆盖** better-sqlite3 的 .node 文件（通配符命中，无需改 asarUnpack）；files 加 `node_modules/better-sqlite3/**/*` 显式声明进 asar
- `npmRebuild: false` 已设（禁止 electron-builder 跑 @electron/rebuild，与 computer-native 一致）
- `scripts/build-native.sh` 加 better-sqlite3 Electron ABI 预编译步骤（与现有 computer-native 并置，参考 computer-native 先例）
- `@app/server/package.json` install 脚本覆盖（守 memory `native-addon-workspace-skip-install-nodegyp`：install 期 skip 裸 node-gyp，由 build-native.sh 显式编译）
- runtime-config：sqlite db 路径不需进白名单（路径 = `join(resolveDataDir(), 'crud.sqlite')`，resolveDataDir 已是绝对路径，PACKAGED-GUARD-2 走 config.ts:50 单一展开权威）

### packaged 验证范围
1. dev 跑通：`bun run test`（含 sqlite-store UT 全绿，复用现有 test fixtures + 新 mock SqlDriver fixture）+ 现有 search.sqlite UT 全绿（SqlDriver 复用不 regress）
2. packaged 跑通：解 asar（`node -e "require('@electron/asar').extractAll(...)"`）→ 用其 `@app/server/dist` 起真后端 → curl `GET /squad/:id/token-stats` 200 + sqlite 时序表非空（写入测试数据后查询返回）+ curl history-search 端点不 regress
3. clean install：`rm -rf node_modules && bun install` 验证 install 脚本覆盖（native addon install 期不崩）

---

## session→member 映射查证（subscriber 前提，已查清）

**已查清，零阻力**（subscriber 用于查 session 是否属于 member）：
- `SessionSchema.squadId`（`schema_defs/session.ts:161`）+ `SessionSchema.memberId`（`:167`）已有
- `MemberSchema.sessionId`（`schema_defs/squad/member.ts:55`）反向映射
- subagent session 无 memberId → subscriber 跳过（其 usage 已通过 accumulateUsage 递归 'sub' 上报 parent member session.sub → parent view.total 已包含）

---

## 变更清单

### 模块 A：persistence — SQLite engine 扶正（T0 核心）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| persistence | app/server/src/persistence/search-sql-driver.ts | SqlStatement | 修改 | 契约扩展：加 `get<U>(...params): U \| undefined`（bun/node/better-sqlite3 三实现原生支持；sqlite-rows 现有 .get() 调用需要）；不加 `bind()`（保持 prepare 时即参数化的既有模式） | MUST 三实现都加（bun:sqlite / node:sqlite / better-sqlite3 原生 .get()）；MUST NOT 加 `bind()`（与现有调用模式不一致） | search_engine §3.1；sqlite-rows.ts 现有 `.get()` 用法 | +12 |
| persistence | app/server/src/persistence/search-sql-driver.ts | BunSqlStatement (internal wrapper) | 修改 | BunSqlDriver.prepare 返回的 SqlStatement 加 get 实现：`stmt.get(...params) as U \| undefined`（直接转发 bun:sqlite Statement.get） | 转发语义；UT 覆盖 | search-sql-driver BunSqlDriver 现有 | +5 |
| persistence | app/server/src/persistence/search-sql-driver.ts | NodeSqlStatement / BetterSqlite3SqlStatement (internal wrapper) | 修改 | 同上加 get 实现（node:sqlite StatementSync.get / better-sqlite3 Statement.get 原生） | 同上 | search-sql-driver 三实现现有 | +10 |
| persistence | app/server/src/persistence/sqlite-store.ts | SqliteCrudStore (class) | 修改 | 重写为接收 SqlDriver 实例（constructor 签名 `(driver: SqlDriver)` 替代 `(opts: {path})`）；删 `new Database(opts.path)` + `applyWal(this.db)`（移到工厂）；stmtCache value 类型从 `Statement`(bun) 改 `SqlStatement` | MUST 接收 SqlDriver 注入（不再内部 new Database）；MUST 保留 stmtCache 层（driver.prepare 不保证缓存）；MUST NOT import 'bun:sqlite'（顶层动态都不行，PACKAGED-GUARD） | sqlite_crud_store_engine §3；search-sql-driver §3；PACKAGED-GUARD | +90/-80 |
| persistence | app/server/src/persistence/sqlite-store.ts | transaction() | 修改 | 重写：`this.db.transaction(() => fn(this))` → 手动 `driver.exec('BEGIN'); try { const r = fn(this); driver.exec('COMMIT'); return r; } catch(e) { driver.exec('ROLLBACK'); throw e; }`（跨 driver 共识） | MUST 跨 driver 共识；MUST 异常路径 ROLLBACK | sqlite_crud_store_engine §3.4 | +8/-3 |
| persistence | app/server/src/persistence/sqlite-store.ts | close() | 修改 | `this.db.close()` → `this.driver.close()`（转发） | 一行转发 | sqlite-store.ts 现有 | +1/-1 |
| persistence | app/server/src/persistence/sqlite-store.ts | readRawRow() | 修改 | 入参 `db: DatabaseInstance` → `driver: SqlDriver`；内部走 prepare().all() 而非 db.prepare().get()（统一走 stmtCache 之外的临时 stmt） | 测试辅助 API；保持现有「表不存在 try/catch 返 undefined」语义 | sqlite-store.ts readRawRow 现有 | +5/-3 |
| persistence | app/server/src/persistence/sqlite-rows.ts | PrepareFn (type) | 修改 | `(sql: string) => Statement`(bun) → `(sql: string) => SqlStatement`（search-sql-driver 契约） | 类型替换；不改函数体 | sqlite-rows.ts 现有 | +1/-1 |
| persistence | app/server/src/persistence/sqlite-schema.ts | ensureTable / applyWal | 修改 | 入参 `db: DatabaseInstance` → `driver: SqlDriver`；内部 `db.exec(sql)` → `driver.exec(sql)` | 函数体零改动（仅类型） | sqlite-schema.ts 现有 | +3/-3 |
| persistence | app/server/src/persistence/crud-sqlite-driver-factory.ts | createCrudSqlDriver() | 新增 | 工厂：`async (path: string): Promise<{ store: SqliteCrudStore; driver: SqlDriver }>` —— 内部 `const driver = await createSqlDriver(path); driver.exec('PRAGMA journal_mode=WAL'); const store = new SqliteCrudStore(driver); return { store, driver };`；**双产物**（store 用于 CrudStore 体系写入，driver 用于 aggregator raw SQL 读聚合查询，§2.6 读写分离）；复用 search-sql-driver 的 createSqlDriver + 显式 applyWal | MUST 复用 createSqlDriver（不两套实现）；MUST 路径调用方传 `join(resolveDataDir(), 'crud.sqlite')`（绝对路径，PACKAGED-GUARD-2）；MUST 异常向上抛（不吞，由 bootstrap 决定是否容忍）；MUST 返回 {store, driver} 双产物（bootstrap 持 driver 引用供 aggregator 共享） | search-sql-driver createSqlDriver；crud §3.4；[P1]token_usage_stat.md §2.6 | +30 |
| persistence | app/server/src/persistence/bun-sqlite-shim.d.ts | (file delete) | 删除 | 实验态类型 shim 文件，sqlite-store 重写后不再引用（动态 import + search-sql-driver 本地 declare 替代） | MUST 删（死代码，违反原则「不遗留死代码」） | memory delete-old-code-fully-when-replacing | -22 |

### 模块 B：persistence — bootstrap 装配 SqliteCrudStore + 新 SchemaDef（T0 末 + T1 始）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| persistence | app/server/src/bootstrap-store-phase.ts | bootstrapStorePhase() | 修改 | 现有 4 mount 到 FsCrudStore 不动；**新增** `const { store: sqliteCrud, driver: sqliteDriver } = await createCrudSqlDriver(join(dataDir, 'crud.sqlite'))` + `.mount('token_usage_stat', sqliteCrud)`；函数返回值加 `sqliteCrudStore` + `sqliteDriver`（供 subscriber/aggregator/handler 注入） | MUST async 化（createCrudSqlDriver 是 async）；MUST 异常容忍（sqlite 装配失败 → token_usage_stat mount 跳过 + log warn，不阻塞 server 启动，对齐 bootstrap-search-phase 异常容忍范式）；MUST token_usage_stat 只用 sqlite（其他 entity 保持 fs）；MUST 保留 sqliteDriver 引用供 aggregator raw SQL 共享 | bootstrap-search-phase 异常容忍范式；crud §3.4 多 engine 共存；[P1]token_usage_stat.md §2.6 | +30 |
| persistence | app/server/src/agent/schema_defs/token_usage_stat.ts | TokenUsageStatSchema | 新增 | 时序表 SchemaDef：`entity='token_usage_stat'`，**`engine='sqlite'`**；**粒度 = (sessionId, hour, providerId, modelId)**（细粒度累加，非天级预聚合）；fields: id/squadId(冗余)/memberId(冗余)/sessionId/hour('YYYY-MM-DD HH')/providerId/modelId/input_no_cache/cache_read/cache_creation/output_response/output_reasoning/cost/llmCallCount；不配 fs.sharding（sqlite engine 不分片）；indexes=[]（v1 不为业务字段建索引，聚合查询走 raw SQL json_extract） | MUST engine='sqlite'（用户裁决）；MUST 存细分 token 字段（snake_case 对齐 Usage 类型，便于 SQL SUM）；MUST 冗余存 squadId/memberId（免 join session 表，session 删后历史 stat 完整）；MUST hour 格式 'YYYY-MM-DD HH'（字典序可排序 + substr(1,10) 派生 date）；MUST NOT 存 total/cacheRate（视图层派生，禁冗余） | schema_interface §3；sqlite_crud_store_engine §3；[P1]token_usage_stat.md §2/§3；PRD §2.2 | +60 |
| persistence | app/server/src/agent/schema_defs/token_usage_stat.ts | TokenUsageStatRecord | 新增 | `export type TokenUsageStatRecord = InferRecord<typeof TokenUsageStatSchema>` | MUST InferRecord 派生（禁手写 interface） | schema_interface §2.3 | +1 |
| persistence | app/server/src/agent/schema_defs/index.ts | (barrel re-export) | 修改 | 加 `export { TokenUsageStatSchema } from './token_usage_stat'` + type export | 一行 re-export | 现有 barrel 模式 | +2 |
| persistence | app/server/src/persistence/token-usage-stat-store.ts | TokenUsageStatStore | 新增 | 时序聚合 store 类（**仅写**）：upsertDelta({squadId,memberId,sessionId,hour,providerId,modelId}, deltaUsage) 做 read-modify-write（按 (sessionId,hour,providerId,modelId) 四维度 queryByJsonExtract 查现有 → per-field 累加 → putAsync）；首见生成新 ULID，已存在复用 id | MUST 写入用 putAsync 串行化（fs_crud_store_engine §5.3 + sqlite engine CrudStore.put 契约）；MUST id 合法 ULID；MUST (sessionId,hour,providerId,modelId) 唯一约定（query-then-put 拿既有 id 复用）；MUST NOT 提供 query 聚合方法（聚合走 aggregator raw SQL，§2.6 读写分离） | crud §3 + sqlite engine json_extract §4 末；[P1]token_usage_stat.md §2.6/§4；session-store-usage-impl 同款 read-modify-write | +110 |

### 模块 C：squad（异步事件订阅 + 查询聚合）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad | app/server/src/squad/token-usage/token-usage-aggregator.ts | TokenUsageAggregator | 新增 | 查询聚合 service 类（**raw SQL GROUP BY SUM，读写分离 §2.6**）：query(squadId, {from,to,scope,granularity,providerId?,modelId?}) → 构造 GROUP BY SQL 通过注入的 SqlDriver 执行；scope=team WHERE squadId（不 filter memberId）/ scope=memberId 加 AND memberId；granularity=day GROUP BY substr(hour,1,10) / granularity=hour GROUP BY hour；可选 model 筛选 AND providerId+modelId；后处理派生 totalTokens + cacheRate | MUST 走 raw SQL（CrudStore.query 不支持 GROUP BY SUM）；MUST team 口径=Σ 全 member（PRD §2.4）；MUST cacheRate = sum(cache_read)/(sum(cache_read)+sum(input_no_cache))（视图层算）；MUST 接收 SqlDriver 注入（与 SqliteCrudStore 共享同一实例）；MUST NOT 写 team 占位行 | PRD §2.2/§2.4；[P1]token_usage_stat.md §2.6/§5；budget-aggregator.ts 同款 service 范式 | +150 |
| squad | app/server/src/squad/token-usage/token-usage-aggregator.ts | TokenUsageQueryResult (type) | 新增 | 查询返回类型：{squadId, granularity, scope, from, to, timezone, providerId?, modelId?, series: Array<{bucket (date 或 hour), input_no_cache, cache_read, cache_creation, output_response, output_reasoning, cost, llmCallCount, total, cacheRate}>} | 字段对齐 PRD §2.2 维度 + 缓存率口径 + model 筛选 | PRD §2.2 | +25 |
| squad | app/server/src/squad/token-usage/token-usage-subscriber.ts | TokenUsageSubscriber | 新增 | 异步事件订阅器：subscribe(statusBus) 注册 `session_panel` topic group=`session_id:<sid>` 的 SessionUsageUpdateEvent listener；onEvent(evt): ① 查 SessionSchema(ssid) 拿 squadId/memberId/providerId/modelId → 若无 squadId/memberId 跳过（subagent）② **model 三级解析**：session.providerId/modelId ?? squad.modelDefault/modelDefaultProviderId ?? '__unknown__' ③ hour = format(evt.createdAt in squad.timezone, 'YYYY-MM-DD HH') ④ delta = per-field diff(view.total, lastSeen[ssid])（首次见记 0）⑤ fire-and-forget upsertDelta | MUST fire-and-forget（写入失败不阻塞主流程，try/catch + log）；MUST 首次见记 0（不灌历史累计）；MUST subagent session（无 memberId）跳过；MUST model 解析三级 fallback（session 显式 → squad 默认 → __unknown__）；MUST delta 按 Usage 字段 key 算 per-field diff（input_no_cache/cache_read/.../llmCallCount） | event-bus §2；session-event-types SessionUsageUpdateEvent；[P1]token_usage_stat.md §4；PRD §2.4/§2.5 | +115 |
| squad | app/server/src/squad/token-usage/token-usage-subscriber.ts | setTokenUsageSubscriberStore() | 新增 | 模块级 setter：注入 TokenUsageStatStore + SessionStore + SquadStore（model 解析读 squad.modelDefault，避免构造期循环依赖，同 setSessionStoreEpDelegate 范式） | MUST 用模块级 holder（不用 constructor 注入），兼容 UT 直接 set + 生产 bootstrap set 两路径 | session-store-ep-delegate 同模式 | +15 |
| squad | app/server/src/agent/session-store-usage-impl.ts | sessionStoreNotifyUsageChanged() | 修改 | 在 emit SessionUsageUpdateEvent 后**额外**调 token-usage-subscriber.onUsageNotify(sid, view)（fire-and-forget + catch）；subscriber 自己决定记不记（subagent 跳过） | MUST 写入失败不阻塞 emit（fire-and-forget）；MUST NOT 改 accumulate 函数 | PRD §2.5；session-store-usage-impl 现有 | +6 |
| squad | app/server/src/bootstrap-store-phase.ts | bootstrapStorePhase() (装配 subscriber + aggregator) | 修改 | Phase 7 结尾：new TokenUsageStatStore(sqliteCrud) + new TokenUsageAggregator(sqliteDriver) + setTokenUsageSubscriberStore({statStore, sessionStore: store, squadStore}) + new TokenUsageSubscriber().subscribe(sessionStatusBus)；返回值加 tokenUsageStatStore + tokenUsageAggregator（供 handler 注入） | MUST 在 unreadRuntime.start() 后装配（bus 就绪）；MUST fire-and-forget 启动（subscriber 内部 catch）；MUST sqlite 装配失败时 subscriber+aggregator 跳过（无 statStore/driver 时不挂订阅/不装配 aggregator，仅 log warn）；MUST aggregator 与 SqliteCrudStore 共享同一 SqlDriver 实例（bootstrap 持 driver 引用，createCrudSqlDriver 改为返回 {store, driver} 双产物） | bootstrap-store-phase 装配时序；event-bus §2；bootstrap-search-phase 异常容忍范式；crud-sqlite-driver-factory.ts | +20 |

### 模块 D：handlers（API 端点）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| handlers | app/server/src/handlers/squad-token-stats-handler.ts | handleTokenStatsRoute() | 新增 | 路由分发：解析 `/squad/:id/token-stats` 路径 → 仅 GET 走查询；其他 method 405 | 与 handleBudgetUsageRoute 同范式 | squad-budget-handler | +40 |
| handlers | app/server/src/handlers/squad-token-stats-handler.ts | handleGetTokenStats() | 新增 | 调 tokenUsageAggregator.query(squadId, {from,to,scope,granularity}) → 200 + TokenUsageQueryResult；query 参数解析：from/to=YYYY-MM-DD（缺省近 60 天）、scope=team\|memberId（缺省 team）、granularity=day\|hour（缺省 day）；404 squad 不存在；sqlite 装配失败时 503（对齐 history-search 端点） | MUST 查询响应 <500ms（PRD §7）；MUST 404 优先；MUST sqlite 未就绪返 503 不返 500 | PRD §7；squad-budget-handler；history-search 503 范式 | +60 |
| handlers | app/server/src/routes/squad-routes.ts | (route dispatch) | 修改 | 在 `/budget/usage` 路由分支后加 `/token-stats` 路径分发到 handleTokenStatsRoute；deps 加 tokenUsageAggregator（从 bs 透传） | MUST 路径分发与 budget/usage 同级 | squad-routes 现有 | +8 |
| handlers | app/server/src/bootstrap.ts | SquadHandlerDeps (type) | 修改 | 加 `tokenUsageAggregator?: TokenUsageAggregator` 字段（optional，sqlite 装配失败时 undefined）；透传到 squad-routes deps | 与 budgetAggregator 同款注入；optional 容忍装配失败 | bootstrap.ts 现有 | +4 |

### 模块 E：packaged 打包接入（T0 末）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| packaged | app/server/package.json | dependencies | 修改 | 加 `"better-sqlite3": "^11.x"`（BUG-002 持续可打包护栏：packaged 后端用 → 进 workspace deps） | MUST 进 @app/server/package.json（非根）；MUST 用 stable 版本 | CLAUDE.md BUG-002 | +1 |
| packaged | app/server/package.json | scripts | 修改 | 加 install 期 skip-native 脚本覆盖（守 memory `native-addon-workspace-skip-install-nodegyp`：跳过 better-sqlite3 默认 node-gyp，由 build-native.sh 显式编译） | MUST install 期跳过裸 node-gyp（面向 Electron ABI 必 fail）；MUST 显式 build-native.sh 编译 | memory native-addon-workspace-skip-install-nodegyp；computer-native 先例 | +5 |
| packaged | scripts/build-native.sh | (script extend) | 修改 | 现有 computer-native 预编译后追加：better-sqlite3 Electron ABI 预编译步骤（`npx @electron/rebuild -f -w better-sqlite3 --module-dir app/server` 或 `cd app/server/node_modules/better-sqlite3 && npx node-gyp rebuild --target=$ELECTRON_VERSION --runtime=electron`）；输出 build/Release/better_sqlite3.node | MUST 与 computer-native 并置；MUST Electron ABI（非 Node ABI）；MUST 失败非 0 退出 | scripts/build-native.sh 现有；electron-builder.yml npmRebuild:false | +20 |
| packaged | app/electron/electron-builder.yml | files | 修改 | 加 `node_modules/better-sqlite3/**/*`（确保进 asar；asarUnpack `**/*.node` 通配已覆盖 .node 解包，无需改 asarUnpack） | MUST files 显式声明（防漏）；MUST NOT 改 asarUnpack | electron-builder.yml 现有；CLAUDE.md BUG-002 | +2 |

### 模块 F：ui-studio（前端独立路由 + 组件改造）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-studio | app/web/src/components/studio-page/page-studio.tsx | MainView (type) | 修改 | 加 `{ kind: 'token-stats'; squadId: string }` 变体 | 与 board/panorama 同范式 | PRD §2.1；page-studio MainView 现有 | +1 |
| ui-studio | app/web/src/components/studio-page/page-studio.tsx | PageStudio (render branch) | 修改 | 加 `else if (mainView.kind === 'token-stats')` 分支渲染 `<TokenStatsRoute squadId onBack={fallbackToSeats} />` | MUST 返回键走 fallbackToSeats；MUST NOT 改其他 kind 渲染 | page-studio 现有 chain | +6 |
| ui-studio | app/web/src/components/studio-page/page-studio.tsx | SeatsPanel onOpenTokenStats (prop wire) | 修改 | `<SeatsPanel ... onOpenTokenStats={(sid) => setMainView({ kind: 'token-stats', squadId: sid })} />` | 与 onOpenBoard/onOpenPanorama 同款 | page-studio 现有 | +1 |
| ui-studio | app/web/src/components/studio-page/component-seats-panel.tsx | SeatsPanel (props) | 修改 | props 加 `onOpenTokenStats: (squadId: string) => void`；tab 条右侧 ml-auto 处加入口按钮 `<button data-testid="token-stats-entry" onClick={() => onOpenTokenStats(squadId)}>` | MUST 入口在 tab 条右端（PRD §2.1 + 06-studio.md §2.3）；MUST testid='token-stats-entry' | PRD §2.1/§4.1；06-studio §2.3 | +15 |
| ui-studio | app/web/src/components/studio-page/component-token-stats-route.tsx | TokenStatsRoute | 新增 | 路由包装组件：顶部返回键（复用 ChatTopbarBackBtn primitive，同 board-topbar-back-btn）+ 主区渲染 TokenStatsPanel；fetch GET /squad/:id/token-stats；sqlite 装配失败（503）显降级空态 | MUST 返回键视觉复用 ChatTopbarBackBtn；MUST 控制条 state lift up 到本组件 | PRD §2.1；component-studio-board-route 同款 | +90 |
| ui-studio | app/web/src/components/studio-page/__token_stats_demo__/ | (rename + refactor) | 修改 | `__token_stats_demo__` 目录改名/迁出到 `component-token-stats-*.tsx` 正式组件族（panel/controls/calendar/timeline/tooltip/types/helpers）：删 mock 数据（token-stats-mock-data.ts），API 改 `fetch('/api/squad/:id/token-stats?...')`；types 对齐 TokenUsageQueryResult；calendar/timeline/tooltip 逻辑保留（demo 已修 overflow/portal 问题）；新增 panel + controls 数据 fetching + state 管理 | MUST 删 mock 全部数据流；MUST types 对齐 server 返回；MUST 控制条 testid 族对齐 PRD §4.3；MUST 保留 createPortal hover 浮层 | PRD §4.3；demo 现状 1365 行 | +350/-200 |
| ui-studio | app/web/src/lib/squad-api.ts | fetchTokenStats() | 新增 | API client fn：`fetchTokenStats(squadId, query) → Promise<TokenUsageQueryResult>`；走 `GET /api/squad/:id/token-stats?from&to&scope&granularity` | 与现有 listSquads/getSquadDetail 同款 fetch wrapper | squad-api 现有 | +15 |

---

## 影响面评估

**跨模块**：persistence（engine 扶正 + SchemaDef + bootstrap mount）+ squad（aggregator + subscriber）+ handlers（端点 + 路由）+ ui-studio（路由 + 入口 + 组件族改造）+ packaged（build-native + electron-builder + server deps）。

**依赖顺序**（底层先）：
1. T0：persistence SQLite engine 扶正（SqlDriver 复用 + sqlite-{store,rows,schema} 重写）→ packaged（better-sqlite3 接入 + build-native）→ packaged 验证
2. T1：token_usage_stat SchemaDef（engine='sqlite'，T0 就绪后才能 mount SqliteCrudStore）+ bootstrap mount + store + aggregator + subscriber + handler + 路由分发（**无 migration**——用户核实 run.usage 实际没落 + session.usage 无 per-call 时间分布，无精确数据源；token_usage_stat 从空表开始）
3. T2：前端（依赖 T1 API 契约就绪）

**破坏性变更**：
- `SqliteCrudStore` 构造签名变更（`{path}` → `SqlDriver`）—— 实验态无生产 caller（packaged 不消费），dev UT 需更新 fixture
- `bun-sqlite-shim.d.ts` 删除（死代码）

**风险点**：
1. **better-sqlite3 Electron ABI 预编译坑**：`@electron/rebuild` 跑 node-gyp 需 Xcode CLT + Python + 网络；可能需 spike 验证（memory `native-addon-workspace-skip-install-nodegyp` + BUG-003 警示）。**回退预案**：若 better-sqlite3 ABI 编译失败，可降级 NodeSqlDriver（node:sqlite Node 22+ 内置，需 spike 验证 FTS5 / CRUD 所需 SQL 是否都支持）；若都不行，回退 FsCrudStore（schema.engine 改 'file' 即可，业务代码零改动——engine-agnostic 设计原则 crud §3.4 保证）
2. **SqlStatement.get 契约扩展影响**：现有 search.sqlite 的 SqlDriver 三实现要同步加 get；不影响调用方（search-engine 用 all 不用 get）
3. **transaction 跨 driver 行为**：bun:sqlite db.transaction 高阶函数有自动嵌套语义；手动 BEGIN/COMMIT/ROLLBACK 嵌套事务需 savepoint —— 但 CrudStore 事务只有 1 层（无嵌套 caller），手动实现等价
4. **bootstrap async 化**：bootstrap-store-phase 加 await createCrudSqlDriver 后变 async；caller (bootstrap.ts) 已经 await（bootstrap 链路本就 async），影响可控

**测试范围**：
- **UT**（T0）：sqlite-store.test.ts 全绿（SqlDriver 注入版，复用现有 fixture + 新 mock driver fixture）+ search-sql-driver.test.ts 全绿（SqlStatement.get 新方法覆盖）+ search-engine.test.ts / history-indexer.test.ts 不 regress
- **UT**（T1）：token-usage-stat-store（upsertDelta read-modify-write 累加 + sqlite engine queryByJsonExtract + (sessionId,hour,providerId,modelId) 唯一约定）+ token-usage-aggregator（**GROUP BY SQL**：scope=team/member 切换 + granularity=day（substr）/hour 切换 + model 筛选 + cacheRate 视图层派生 + total 派生）+ token-usage-subscriber（delta 计算 per-field diff + 首次见记 0 + subagent 跳过 + **model 三级 fallback**（session→squad→__unknown__）+ 错误隔离）
- **packaged 验证**（T0）：解 asar 起后端 curl GET /squad/:id/token-stats 200 + 写入测试数据查询返回 + curl history-search 端点不 regress + clean install 不崩
- **AT/ET**（T2）：按用户铁律普通 feature 不新增持久 AT/ET case；UT + 冒烟集回归即可

---

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- **SQLite engine 扶正遇阻**（better-sqlite3 ABI 编译失败 / packaged 验证不通过）→ coder **MUST 立即向 orchestrator 汇报**，由 orchestrator 裁决：① 继续攻坚 / ② 降级 NodeSqlDriver（spike FTS5/Crud SQL） / ③ 回退 FsCrudStore（schema.engine='file'，业务零改动）。**禁止 coder 自行决定回退**
- 若 coder 发现 `TokenUsageSubscriber` delta 计算有更简洁方案（如改在 `sessionStoreAccumulateUsage` 内部直接记增量），**可偏离本表行**但必须向 orchestrator 汇报（偏离项 + 理由 + 影响范围），由 orchestrator 裁决是否触发 spec 同步
