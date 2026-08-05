---
type: spec
title: SQLite Engine 扶正（CrudStore sqlite engine 从实验态 → 生产 / packaged 可用）
priority: P0
status: active
updated: 2026-07-23
since: v0.0.194
---

# SQLite Engine 扶正（CrudStore sqlite engine 从实验态 → 生产 / packaged 可用）

## 1. 概述

**管什么**：把 `SqliteCrudStore`（CrudStore 契约的 sqlite 实现）从「dev/Bun runtime 实验态」升级到「dev + packaged Electron 双 runtime 生产可用」，**复用 `search-sql-driver.ts` 的 SqlDriver 抽象**（不两套实现）。
**不管什么**：CrudStore 契约本身（→ `[P0]crud_store_interface.md`）；SchemaDef（→ `[P0]schema_interface.md`）；search.sqlite 专用 SearchEngine/HistoryIndexer（→ `[P1]search_engine.md`）。

**背景**：v0.0.2 起 `SqliteCrudStore` 顶层 `import { Database } from 'bun:sqlite'`，只能在 dev/Bun runtime 跑，packaged Electron Node CJS 不可用（`Cannot find module 'bun:sqlite'`）。代码头注释明示「packaged Electron 不消费 sqlite engine（实验库）」。v0.0.194 token_usage_stat 需要 SQLite engine 时序表（用户裁决），必须扶正。

## 2. 设计决策

### 2.1 复用 search-sql-driver.ts 的 SqlDriver 抽象（不两套实现）

**结论**：`SqliteCrudStore` 改为接收 `SqlDriver` 实例（构造注入），不再内部 `new Database(path)`；SqlDriver 抽象 + 三实现（BunSqlDriver / NodeSqlDriver / BetterSqlite3Driver）+ 动态 import + `createSqlDriver(path)` 工厂**全部复用** search-sql-driver.ts 的现有实现。
**理由**：
- `search-sql-driver.ts`（v0.0.126 引入）已经解决「packaged 双 runtime」问题，三实现 runtime 选 + 动态 import 避免顶层 bun:sqlite/node:sqlite/better-sqlite3 任一 import（PACKAGED-GUARD）；CrudStore 复用即继承所有护栏
- 两套实现 = 双倍维护 + 漂移风险（一份修了 bug 另一份没修）
- SqlDriver 契约（prepare/all/run/exec/close）覆盖 CrudStore 所需的 SQL 能力子集
**反例**：若 CrudStore 独立写一套 driver 抽象，会有两份三实现 + 两套 createSqlDriver 工厂，维护翻倍且 search-sql-driver 已验证的模式无法传染。

### 2.2 SqlStatement 契约扩展加 get()（兼容 sqlite-rows 现有调用）

**结论**：`SqlStatement<T>` 接口加 `get<U>(...params): U | undefined` 方法；三实现（BunSqlStatement / NodeSqliteStatementSync / BetterSqlite3Statement）原生支持 `.get()`，wrapper 直接转发。
**理由**：
- sqlite-rows.ts 现有 `readMeta` / `selectRow` / `readRawRowSafe` 都用 `.get(id)` 模式（按主键读单行）
- 改 `.get()` → `.all(id)[0] ?? null` 也行，但增加无谓调用开销 + 改动面大；契约扩展一行更干净
- bun:sqlite / node:sqlite / better-sqlite3 三实现 Statement 接口都原生有 `.get()`，零额外实现成本
**反例**：若不扩展契约，sqlite-rows 4 处 `.get()` 要改为 `.all()[0] ?? null`，调用方代码 churn，且语义弱化（all 暗示多行，get 是单行意图）。

### 2.3 transaction 走手动 BEGIN/COMMIT/ROLLBACK（跨 driver 共识）

**结论**：`SqliteCrudStore.transaction<T>(fn)` 重写为手动 `driver.exec('BEGIN'); try { r = fn(this); driver.exec('COMMIT'); return r; } catch(e) { driver.exec('ROLLBACK'); throw e; }`，**不**用 bun:sqlite 的 `db.transaction()` 高阶函数。
**理由**：
- bun:sqlite 的 `db.transaction(fn)` 是 bun 专有 API（返回包装函数 + 自动嵌套事务语义）
- node:sqlite 没有 `DatabaseSync.transaction()` 高阶函数（必须手动 BEGIN/COMMIT/ROLLBACK）
- better-sqlite3 有 `.transaction()` 但语义与 bun 不完全一致
- 手动 BEGIN/COMMIT/ROLLBACK 三 driver 都支持（SQL 标准语法），跨 driver 共识
- CrudStore 事务只有 1 层（无嵌套 caller），手动实现无嵌套语义损失
**反例**：若用 driver 专有 transaction API，三实现要各自适配，且 better-sqlite3 与 bun 嵌套事务语义差异可能引入隐性 bug；手动实现简单可靠。

### 2.4 stmtCache 保留在 sqlite-store 层（driver 不保证缓存）

**结论**：sqlite-store.ts 的 `Map<string, SqlStatement>` 缓存层保留；SqlDriver.prepare 是否缓存由实现决定（spec search_engine §3.1 「多次调同名 SQL 由实现决定是否缓存」），sqlite-store 自维护上层缓存避免重复 prepare。
**理由**：
- bun:sqlite 的 prepare 有成本（SQL 解析 + 执行计划），重复 prepare 同 SQL 是浪费
- 三实现 driver 的内部缓存策略不一致（bun:sqlite 不缓存，better-sqlite3 缓存）—— sqlite-store 自维护上层缓存抹平差异
**反例**：若依赖 driver 缓存，三实现性能差异大（bun 每次新 prepare 慢）；sqlite-store 上层缓存简单且统一行为。

### 2.5 SqliteCrudStore 构造签名变更（注入而非 new）

**结论**：constructor 从 `(opts: { path: string })`（内部 new Database）改为 `(driver: SqlDriver)`（外部注入）；新增工厂 `createCrudSqlDriver(path): Promise<SqliteCrudStore>`（内部 createSqlDriver + applyWal + new SqliteCrudStore）。
**理由**：
- 注入而非内部 new 便于测试（mock driver）+ 装配时显式控制 driver 选型
- 工厂封装 createSqlDriver + applyWal + new 实例的样板，bootstrap 一行调用
- 兼容 search-sql-driver 异常容忍范式（bootstrap try/catch 决定是否降级）
**反例**：若 SqliteCrudStore 内部调 createSqlDriver，则破坏单一职责（store 不应感知 driver 选型）+ 测试时无法注入 mock driver。

### 2.6 bun-sqlite-shim.d.ts 精简保留（ambient module 声明必需）

**结论**：`app/server/src/persistence/bun-sqlite-shim.d.ts`（bun:sqlite 类型 shim）**精简保留**，不整文件删除——删 dead `transaction<T>(fn)` 高阶类型（CrudStore 事务改手动 BEGIN/COMMIT/ROLLBACK via driver.exec），**留** ambient `declare module 'bun:sqlite'` + 最小 `Database` 构造器 + `Statement` 接口（get/all/run）+ `DatabaseInstance`（prepare/exec/close）。
**理由**：
- `search-sql-driver.ts` 的 `BunSqlDriver.create` 内 `await import('bun:sqlite')` 在 dev typecheck（server tsconfig `types=node` 不含 bun:sqlite）下需 ambient module 声明才能解析
- `declare module 'bun:sqlite'` 在已 module 的 `.ts` 文件会被 TS 当 augmentation 报错（"Invalid module name in augmentation, module 'bun:sqlite' cannot be found"）—— ambient `.d.ts` 是唯一能让 typecheck 过的位置（TS 语义限制）
- 仅 dev typecheck 需要；packaged Electron Node 不消费 bun:sqlite（`BunSqlDriver` 仅 dev/Bun runtime 实例化）
**反例**：若整文件删除，typecheck 报 TS2307 `Cannot find module 'bun:sqlite'`（search-sql-driver.ts 的 dynamic import 类型解析失败）；若在 `.ts` 文件内本地 declare，TS augmentation 语义不允许（已知限制）。

## 3. packaged 打包接入

### 3.1 better-sqlite3 依赖归属（BUG-002 护栏）

**归属**：`@app/server/package.json` 的 `dependencies`（不是根 package.json）。
**理由**：CLAUDE.md 持续可打包护栏 BUG-002 —— packaged 后端要用的第三方 npm 依赖必须声明在使用它的 workspace package.json；electron-builder 只打包 `@app/server` 自身声明的 deps；只在根的依赖 dev 靠 bun hoist 侥幸能跑，packaged 崩「Cannot find module」。
**版本**：`^11.x`（stable 最新主版本，非 alpha/beta）。

### 3.2 asarUnpack 已覆盖（无需改）

**现状**：`app/electron/electron-builder.yml` 已有 `asarUnpack: ['**/*.node', '**/*.dylib']`。
**效果**：better-sqlite3 的 `build/Release/better_sqlite3.node` 文件被通配符命中，自动解包到 `app.asar.unpacked/`（dlopen 需真实文件路径，不能在 asar 内）。
**files 需补**：`node_modules/better-sqlite3/**/*`（显式声明进 asar 防漏，与 @app/server 同级）。

### 3.3 npmRebuild=false（禁止 electron-builder 自动 rebuild）

**现状**：electron-builder.yml 已设 `npmRebuild: false`。
**效果**：禁止 electron-builder 自动跑 `@electron/rebuild`（与 computer-native 一致，构建职责归 build-native.sh）。
**理由**：electron-builder 默认会跑 `@electron/rebuild` 重建所有 native addon；但其 node-gyp 只做 C++ 链接（缺 swift/.build dylib → 'library not found'，computer-native 先例已验证）；better-sqlite3 虽纯 C++ 不需要 swift，但与现有 build-native.sh 并置更一致（统一构建职责）。

### 3.4 build-dmg.sh ②c 扩展（Electron ABI 预编译，非 install 期）

**新增步骤**：build-dmg.sh 在 computer-native 预编译后追加 better-sqlite3 Electron ABI rebuild：

```bash
# ②c better-sqlite3 Electron ABI 预编译（packaged 专用，非 install 期）
npx @electron/rebuild -f -w better-sqlite3 --module-dir app/server \
  --version=$ELECTRON_VERSION --arch=arm64
```

**失败处理**：非 0 退出，build-dmg.sh 中断。

**install 期不加 skip-native 脚本覆盖**（偏离原 architect 提案，对齐 better-sqlite3 v11 实际）：
- better-sqlite3 v11.10 用 `prebuild-install`（macOS arm64 / Linux x64 / Node 22 等主流平台有 prebuilt `.node` 下载）—— **dev `bun install` 零编译**（clean install 实测 4.89s），不像 computer-native 那样 install 期裸 `node-gyp`
- memory `native-addon-workspace-skip-install-nodegyp` 针对的场景（含 `binding.gyp` 的 native addon install 期自动 node-gyp 面向 Node ABI）better-sqlite3 v11 已用 prebuild-install 规避；强行覆盖 install 脚本（mutate better-sqlite3/package.json）timing 脆弱（parent install 跑时 better-sqlite3 可能已开始自己的 install）
- packaged Electron ABI 由 build-dmg.sh ②c 显式 `@electron/rebuild -f -w better-sqlite3` 处理（非 install 期），与 computer-native 并置同款
- **fallback**：prebuild-install 网络问题下载失败 → fallback 到 node-gyp 编译（需 Xcode CLT，可能失败）—— 这是 better-sqlite3 的标准行为，非本次改动引入

### 3.5 runtime-config 不需注入

**结论**：sqlite db 路径**不**进 `runtime-config.ts` 白名单。
**理由**：路径 = `join(resolveDataDir(), 'crud.sqlite')`，`resolveDataDir` 已是绝对路径（config.ts:50，单一展开权威），packaged cwd=/ 下也能解析；PACKAGED-GUARD-2 禁字面 `~` / 相对路径，本路径已合规。

## 4. packaged 验证（MANDATORY — dev 能跑 ≠ packaged 能跑）

### 4.1 验证步骤

1. **dev UT 全绿**：
   - `bun run test`（含 sqlite-store.test.ts + 新 mock SqlDriver fixture）
   - `search-sql-driver.test.ts` 全绿（SqlStatement.get 新方法覆盖）
   - `search-engine.test.ts` / `history-indexer.test.ts` 不 regress（复用 SqlDriver 后）

2. **packaged 解 asar 验证**：
   ```bash
   # 解 asar
   node -e "require('@electron/asar').extractAll('release/mac/rocky_agent.app/Contents/Resources/app.asar', '/tmp/rocky-unpack')"
   # 用其 @app/server/dist 起真后端
   cd /tmp/rocky-unpack && DATA_DIR=/tmp/rocky-verify node node_modules/@app/server/dist/index.js &
   # curl 统计端点（先 seed 测试数据）
   curl http://localhost:3000/squad/<test-squad-id>/token-stats?granularity=day
   # 期望：200 + series 数组（含 seed 数据）
   # curl history-search 端点不 regress
   curl http://localhost:3000/session/<sid>/history-search?q=hello
   ```

3. **clean install 验证**：
   ```bash
   rm -rf node_modules && bun install
   # 期望：install 不崩（better-sqlite3 v11 prebuild-install 下载 prebuilt .node，macOS arm64 零编译；网络失败 fallback node-gyp）
   ```

### 4.2 回退预案

**触发条件**：better-sqlite3 Electron ABI 编译失败 / packaged 解 asar 验证不通过 / clean install 崩。

**回退梯度**（由 orchestrator 裁决，coder 不得自行决定）：
1. **降级 NodeSqlDriver**（node:sqlite Node 22+ 内置）：CRUD 所需 SQL（CREATE TABLE / INSERT / UPDATE / json_extract / transaction）+ **FTS5**（search.sqlite 用）在 node:sqlite 下**实测全支持**（Node 22.22 验证）—— CrudStore + search.sqlite 都走 NodeSqlDriver，better-sqlite3 运行时不需要
2. **回退 FsCrudStore**（schema.engine='file'）：业务代码零改动（engine-agnostic 设计原则 crud §3.4 保证）；损失 SQLite 查询能力（token_usage_stat 走 in-memory filter，数据量小可接受）

### 4.3 packaged 验证结论（v0.0.194 实测）

**结论：PASS**（T0 sqlite 代码 + 运行时全绿；②c ABI rebuild 失败已由 warn+skip 解决，非运行时阻塞）。

**better-sqlite3@11 + Electron 42 ABI rebuild 失败**（上游兼容问题，非本版代码 bug）：
- 根因：better-sqlite3@11.10.0 源码用旧 `v8::External::Value()` 无参；Electron 42.4.1（Chromium 138+ V8）改为 `Value(ExternalPointerTypeTag tag)`（指针压缩安全修复）。14 个 C++ 编译错误
- **运行时影响：零**。packaged default=NodeSqlDriver（node:sqlite）全覆盖 CrudStore + search.sqlite 所需能力（含 FTS5，Node 22.22 实测）；`setPackagedSqlDriverKind('better-sqlite3')` 生产代码从不调，BetterSqlite3Driver 为未激活 fallback

**②c warn+skip（orchestrator 裁决）**：`build-dmg.sh` ②c `@electron/rebuild` 失败 → log WARN 不 `exit 3`，dmg build 继续。better-sqlite3 `.node` 用 prebuild Node ABI（或 rebuild 失败时缺失）进 asar，packaged 用 NodeSqlDriver 不加载此 `.node`，无害。better-sqlite3 保留为未激活冗余，未来版本可评估移除（选项 3：移除 deps + BetterSqlite3Driver class）。

**实测验证项**（Node CJS cwd=/ 模拟 packaged）：
- T0 sqlite 代码路径 8/8 PASS（createCrudSqlDriver 双产物 + crud.sqlite 落盘 BUG-004 + upsertDelta + raw SQL GROUP BY + BetterSqlite3Driver .node Node-ABI 加载 + transaction + WAL）
- 全量 HTTP bootstrap：`/health` 200 + `/squad` 200 + `/squad/:id/token-stats` **404 非 500/503**（route+handler+sqlite ready）+ `/history/search` **200 不 regress**；crud.sqlite + search.sqlite 均创建，`driver=NodeSqlDriver`，零 500
- clean install 3.9s prebuild-install 零编译 ✅
- 4 BUG 类别全 clear（BUG-002 deps 归属 / BUG-003 asar files+asarUnpack / BUG-001 runtime-config 无新键 / BUG-004 路径展开 cwd=/ 不崩）

## 5. 边界

| 零件 | 归属 |
|------|------|
| SqlDriver 抽象 + 三实现 + createSqlDriver 工厂 | `[P1]search_engine.md §3.1`（search-sql-driver.ts 共享） |
| SqliteCrudStore 重写（接收 SqlDriver）+ createCrudSqlDriver 工厂 + stmtCache 层 + 手动 transaction | 本文件 ✅ |
| CrudStore 契约、StoredRecord 信封、PutOptions、QueryFilter | `[P0]crud_store_interface.md` |
| SchemaDef / InferRecord / 字段校验 | `[P0]schema_interface.md` |
| SQLite 表结构、blob-first、WAL、索引策略 | `[P0]sqlite_crud_store_engine.md`（spec 不动，代码重写对齐 spec） |
| better-sqlite3 native addon 打包（asarUnpack / build-native.sh / npmRebuild） | `specs/tech/app/package/`（持续可打包护栏） |

> 变更历史见 [`log.md`](log.md)；跨版本发布说明见 [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)。
