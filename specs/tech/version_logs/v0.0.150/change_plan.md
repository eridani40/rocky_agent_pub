# v0.0.150 变更计划书 — 固化持久化数据迁移逻辑（MigrationManager）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec / 原则编号 |
| 影响行 | +N / -M |

## 核心设计要点（architect summary）

1. **MigrationManager**（新增 class，`app/server/src/migration/migration-manager.ts`）：bootstrap 期启动 → load yaml registry + read ledger → 对每个 handler 判「applied 主防线 + version range 兜底」→ 执行未 applied 且符合的 → 记 done/error/na → 原子写 ledger。挂载点 = `bootstrap.ts:348` AppConfigService 之后、业务 store 之前（与原 ad-hoc 迁移同位置替换）。
2. **handler 注册表**：`app/server/src/migration/handlers.yaml`（仅 dummy-update）+ 同目录 `handlers/<id>.ts`。yaml schema = `handlers: [{ id, versionRange, module }]`。version range 用简化 semver（`<0.0.151`），自实现比较器（无 semver 库依赖）。
3. **ledger**：`<DATA_DIR>/migration_state.json` = `{ lastAppVersion, handlers: { [id]: { status, appliedAt, appVersion, error? } } }`，原子写 tmp+rename，**不走 CrudStore**（避免循环依赖）。
4. **当前版本号（B）**：`scripts/gen-version.ts` 读根 `package.json` → 写 `app/server/app-version.json`（与 src/dist 平级）。build-dmg.sh ①a 后调一次；run-dev.sh 启 server 前调一次。server 内 `app/server/src/migration/app-version.ts` 用 `fs.readFileSync(path.resolve(__dirname, '../app-version.json'))` 读（dev `src/` 与 packaged `dist/` 路径同一相对位置）。electron-builder.yml `files` 增 `node_modules/@app/server/app-version.json` 进 asar。**不走 process.env/runtime-config**（packaged env 干净，BUG-001）。
5. **报错前后端通道（C）**：bootstrap 收集 `migrationErrors[]` 不抛 → `BootstrapResult.migrationErrors` 字段 → 新端点 `GET /bootstrap/status`（router.ts:344 /health 旁，与同模式）→ 前端 AppShell useEffect fetch → 有 errors 则渲染 modal。**不用 SSE / 共享文件**（bootstrap 一次性快照，REST 够用且对齐 /health 模式）。
6. **文件锁（D）**：`<DATA_DIR>/migration.lock`（mkdir 原子操作 + pid 文件）。stale 检测 = pid 文件内写 pid+startedAt，pid 不存活则清。**不引入新 npm 依赖**（proper-lockfile 等免）。
7. **dummy-update**：handler = no-op return；id=`dummy-update`；versionRange=`<0.0.151`。首次启动 lastAppVersion=v0.0.0 → 满足 → done；下次启动 lastAppVersion=0.0.150 不满足 `<0.0.151` 仍是 done（applied 主防线）。验证 ledger 链路。
8. **packaged 护栏**：app-version.json 进 asar（electron-builder files 显式）；所有 DATA_DIR 路径走 `resolveDataDir`（packaged cwd=/）；yaml/json 处理复用 `yaml` 包（已在 server deps）；MigrationManager 在 server 内不进 plugin，免 build-plugins 调整。
9. **硬约束**：handler MUST 幂等（applied 主 + 自身幂等兜底）；MUST NOT 清理用户配置（仅格式升级）；forward-only 不回滚；失败不阻塞 bootstrap（收集 errors 后放行进 app）。
10. **旧 ad-hoc 迁移全删（A）**：6 文件 + 调用点清理（plugin-config-service.ts:72-73 / plugin-policy-store.ts:34-37 import + :234-246 两方法 / board-store.ts:37-38 re-export / bootstrap.ts:43 import + :45 import + :355-360 调用段 / migrate-memory-intro.test.ts 连带删）。

## 变更清单

### A. 新增模块（migration subsystem）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| migration | app/server/src/migration/migration-manager.ts | MigrationManager | 新增 class | 主控 class。constructor({ dataDir, appConfig })。run()：acquire lock → load yaml registry → read ledger → 对每 handler 判「applied!=done && range 满足」→ 执行 handler → 记 done/error/na → 更新 lastAppVersion=当前 → 原子写 ledger → release lock。返回 MigrationSummary。失败 handler catch 不抛，记 error 进 summary。 | MUST 幂等兜底（applied!=done 才跑）；MUST NOT 清用户配置；MUST NOT 抛错阻塞 bootstrap（收集 errors 后 return summary）；lock 持有期 < 整个 bootstrap | req.md §1-§4；原则 9（forward-only） | +180 |
| migration | app/server/src/migration/migration-manager.ts | MigrationManager.run() | 新增 | 见上行 | 同上行 | 同上 | （含上行） |
| migration | app/server/src/migration/migration-manager.ts | MigrationManager.acquireLock() | 新增 private | 用 mkdir `<DATA_DIR>/migration.lock`（原子）；锁目录内写 `pid + startedAt`；若已存在且 pid 仍存活 → throw `MigrationLockHeldError`（被 run() catch 转 summary.error）；pid 死 → 清除重建 | MUST 复用 `resolveDataDir`（packaged cwd=/ 绝对路径） | specs/tech/app/envs/[P0]environments.md §4.6；原则 BUG-004 | +25 |
| migration | app/server/src/migration/migration-manager.ts | MigrationManager.releaseLock() | 新增 private | rmdir lock 目录；catch 吞错（不阻塞）。放在 try/finally 末尾 | MUST finally 释放避免泄漏 | 同上 | +8 |
| migration | app/server/src/migration/migration-manager.ts | MigrationManager.loadRegistry() | 新增 private | 读 `handlers/handlers.yaml`（同包内 path.resolve(__dirname, './handlers/handlers.yaml')）→ 用 `yaml` 包 parse → 返回 HandlerEntry[]。yaml 不存在或解析失败 throw（运行时硬失败） | MUST 复用 server 已有 `yaml` 包；MUST NOT 引新依赖 | specs/tech/config/[P0]plugin_config.md §6（engine file 范式）；app/server/package.json | +18 |
| migration | app/server/src/migration/migration-manager.ts | MigrationManager.readLedger() | 新增 private | 读 `<DATA_DIR>/migration_state.json`；不存在返回 `{ lastAppVersion: '0.0.0', handlers: {} }`（首次启动语义）；JSON 解析失败 throw（污染数据 hard fail，进 summary error） | MUST 不走 CrudStore（避免循环依赖）；MUST 首次缺失视为 v0.0.0 | req.md §10 | +20 |
| migration | app/server/src/migration/migration-manager.ts | MigrationManager.writeLedger() | 新增 private | 原子写：writeFileSync tmp（`migration_state.json.tmp`）→ renameSync 到正式路径。同 lastAppVersion + handlers map | MUST 原子（tmp+rename）；MUST NOT 多步写中间态 | 原则 9 | +12 |
| migration | app/server/src/migration/ledger.ts | MigrationLedger | 新增 interface | `{ lastAppVersion: string; handlers: Record<string, HandlerState> }` | — | req.md §4 | +6 |
| migration | app/server/src/migration/ledger.ts | HandlerState | 新增 interface | `{ status: 'done'\|'error'\|'na'; appliedAt: string(ISO); appVersion: string; error?: { message: string; stack?: string } }` | — | req.md §4 | +8 |
| migration | app/server/src/migration/ledger.ts | HandlerEntry | 新增 interface | `{ id: string; versionRange: string; module: string }` — yaml 单条 schema | — | req.md §3 | +5 |
| migration | app/server/src/migration/ledger.ts | MigrationSummary | 新增 interface | `{ ran: string[]; skipped: string[]; errors: Array<{ id: string; message: string; stack?: string }> }` — run() 返回值，供 BootstrapResult 收集 | — | — | +8 |
| migration | app/server/src/migration/ledger.ts | isHandlerAppliable() | 新增 | `(entry: HandlerEntry, ledger: MigrationLedger, currentVersion: string) => boolean`：applied 主防线（ledger.handlers[id].status !== 'done'）且 versionRange 兜底（satisfiesRange(currentVersion, entry.versionRange)） | MUST applied 主、range 辅 | req.md §3-§4 | +12 |
| migration | app/server/src/migration/version-range.ts | satisfiesRange() | 新增 | `(version: string, range: string) => boolean`：解析 `<X.Y.Z` 形式（仅支持 `<` 前缀，其他 throw）；比较 semver 三段（major/minor/patch 数字比较）。**自实现，不引 semver 库** | MUST 仅支持 `<` 形式（够用且简单）；MUST 数字段比较不混 string 比较 | req.md §3 | +30 |
| migration | app/server/src/migration/app-version.ts | getAppVersion() | 新增 | `fs.readFileSync(path.resolve(__dirname, '../app-version.json'), 'utf-8')` → JSON.parse → 返回 `.version`。dev `src/migration/` + packaged `dist/migration/` 都解析到 `app/server/app-version.json`（src/dist 平级） | MUST 用 `__dirname` 派生绝对路径（packaged cwd=/）；MUST NOT 走 process.env；MUST NOT import json（避开 bundler copy 坑） | BUG-001 / BUG-004；specs/tech/app/package | +18 |
| migration | app/server/src/migration/handlers/handlers.yaml | handlers | 新增资源 | yaml：`handlers: [{ id: dummy-update, versionRange: '<0.0.151', module: './handlers/dummy-update' }]` | MUST 仅 dummy-update（A 决策：一个都不收编） | req.md 设计决策 A | +6 |
| migration | app/server/src/migration/handlers/dummy-update.ts | dummyUpdate | 新增 | export const dummyUpdate = async () => { /* no-op */ }。空操作验证 ledger 记录链路 | MUST 真空操作（不读不写 fs、不改 config） | req.md §17 | +8 |
| migration | app/server/src/migration/handlers/index.ts | handlerRegistry | 新增 | 静态 map：id → handler 函数引用。**避免 dynamic import**（dynamic 在 packaged asar 有坑），用静态 import map 显式登记 | MUST 静态 map（不 dynamic import） | 原则 BUG-003（plugin 进 asar 教训类比） | +12 |
| migration | app/server/src/migration/index.ts | — | 新增 barrel | re-export MigrationManager + types | — | — | +5 |
| migration | app/server/src/migration/__tests__/migration-manager.test.ts | — | 新增 UT | UT：首次启动 ledger 缺失 → 跑 dummy-update → done + lastAppVersion 更新；二次启动 dummy applied → skip；error handler 进 summary 不抛；lock 冲突 throw 但被 run catch | MUST 覆盖 applied 主防线 + range 兜底 + lock 语义 | memory `bottom-up-layer-verify` | +120 |
| migration | app/server/src/migration/__tests__/version-range.test.ts | — | 新增 UT | UT：`<0.0.151` 满足 0.0.150、不满足 0.0.151；非法 range throw；数字段比较不混 string | MUST 数字段比较独立测 | 同上 | +30 |

### B. bootstrap 接线

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| migration | app/server/src/bootstrap.ts | import { migrateUserMemoryToAppConfig, logLegacySharedSessionMemory } from './memory/migrate-v0.0.55' | 删除 | :43 import 行整删（连带 :355-356 调用） | MUST 连带删调用段不留 dead import | req.md 决策 A | -1 |
| migration | app/server/src/bootstrap.ts | import { migrateWebSearchProviderId } from './config/migrate-web-search-provider' | 删除 | :45 import 行整删（连带 :359-360 调用） | 同上 | 同上 | -1 |
| migration | app/server/src/bootstrap.ts | migrateUserMemoryToAppConfig + logLegacySharedSessionMemory 调用段 | 删除 | :350-356 整段（注释 + 两 await 调用） | MUST 整段删 | 同上 | -7 |
| migration | app/server/src/bootstrap.ts | migrateWebSearchProviderId 调用段 | 删除 | :357-360 整段（注释 + await） | MUST 整段删 | 同上 | -4 |
| migration | app/server/src/bootstrap.ts | MigrationManager 接线 | 新增 | :348 AppConfigService 构造后插入：`const migrationSummary = await new MigrationManager({ dataDir, appConfig }).run();` （catch 收集 errors 进 summary 不抛）；构造 `migrationErrors` 数组（含 lock 错误 + 各 handler 错误）赋给 BootstrapResult | MUST 位置在 AppConfigService 之后、业务 store（BoardStore/MemberStore/SessionStore）之前；MUST NOT 任一 handler fail 阻塞 bootstrap | context.md（启动/迁移挂载点）；req.md §11-§13 | +12 |
| migration | app/server/src/bootstrap.ts | BootstrapResult.migrationErrors | 新增字段 | `migrationErrors: Array<{ id: string; message: string; stack?: string }>` 加进 BootstrapResult interface（:140 起）。空数组表示无错 | — | — | +3 |

### C. HTTP 端点（前后端通道）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| migration | app/server/src/handlers/bootstrap-status.ts | handleBootstrapStatus | 新增 | export `handleBootstrapStatus(bs: BootstrapResult): Response`：返回 `{ appVersion: getAppVersion(), lastAppVersion: bs.lastAppVersion, migrationErrors: bs.migrationErrors }` JSON 200。lastAppVersion 从 MigrationManager 注入 bs 或重读 ledger（避免 bs 多一字段，二选一 coder 定位） | MUST 200（即使有 errors，统一放行语义）；MUST NOT 在此 handler 抛 | req.md 决策 C | +25 |
| migration | app/server/src/router.ts | GET /bootstrap/status 路由 | 新增 | 在 :344 `/health` 分支后、:365 `getBootstrap(dataDir)` 调用前 加分支：`if (path === '/bootstrap/status' && method === 'GET') { const bs = await getBootstrap(dataDir); return handleBootstrapStatus(bs); }` | MUST 在 getBootstrap 之前不能依赖（此 endpoint 需 bs）；MUST method 错返 405 | 同上 | +6 |
| ui-bootstrap | app/web/src/lib/bootstrap-status-api.ts | fetchBootstrapStatus | 新增 | `fetchBootstrapStatus(): Promise<BootstrapStatusResponse>`。GET `${API_BASE}/bootstrap/status` → JSON。复用 `api-base.ts` 现有 fetcher 范式 | MUST 失败兜底返空 errors（不阻塞 UI） | specs/api/overall 现有 facade 范式 | +20 |
| ui-bootstrap | app/web/src/lib/bootstrap-status-api.ts | BootstrapStatusResponse | 新增 type | `{ appVersion: string; lastAppVersion: string; migrationErrors: Array<{ id; message; stack? }> }` | — | — | +6 |
| ui-bootstrap | app/web/src/components/framework/app-shell/migration-error-modal.tsx | MigrationErrorModal | 新增 component | 受控 modal：props `{ errors, onConfirm, onOpenLogDir }`。固定遮罩 + 居中 card；列聚合错误条（多错聚合一条：「N 个迁移失败，详情见日志」+ 展开）；主按钮「确定」(onConfirm)，次按钮「打开日志目录」(onOpenLogDir)。testid: `migration-error-modal` / `migration-error-confirm` / `migration-error-open-log` | MUST 多错聚合（不分级）；MUST 走 createPortal（避 pointer-events 祖先链坑，memory `css-pointer-events-inherits-dom-not-position`） | req.md 决策 C；specs/ui/components/_conventions.md | +90 |
| ui-bootstrap | app/web/src/components/framework/app-shell/app-shell.tsx | bootstrap status fetch effect | 新增 | useEffect 启动时调 fetchBootstrapStatus → 若 errors.length > 0 setState show modal。渲染 `<MigrationErrorModal errors={...} onConfirm={() => setShow(false)} onOpenLogDir={() => /* open log dir */} />` | MUST 仅 errors.length > 0 显示（无错零感知）；MUST 打开日志目录走 IPC（coder 定位具体通道，无现成则按钮 noop 标 TODO） | specs/tech/app/package IPC 范式 | +30 |

### D. 版本号生成（B）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| version | scripts/gen-version.ts | main | 新增 | 读根 `package.json` `.version` → 校验非空非 0.0.0 → 写 `app/server/app-version.json` = `{ "version": "<ver>", "generatedAt": "<ISO>" }` + console.log 确认。dev/build 共用 | MUST 失败非 0 退出（无版本号 build 无意义）；MUST 写到 server 包内（src/dist 平级，packaged 进 asar） | req.md 决策 B；specs/tech/app/package | +35 |
| version | package.json（根） | scripts.gen-version | 新增 | `"gen-version": "bun run scripts/gen-version.ts"` | — | — | +1 |
| version | scripts/build-dmg.sh | gen-version step | 修改 | 在 `①a building @app/server` 段（:99）后、`① building @app/web`（:94 之后实际是 ② plugins）前 插入：`echo "[build-dmg.sh] generating app/server/app-version.json ..." && bun run gen-version`。确保 server 编译后、打包前生成 | MUST 在 server build 后（避免时序）、electron-builder 前（确保进 asar） | specs/tech/app/package/[P0]packaging_toolchain.md | +3 |
| version | scripts/run-dev.sh | gen-version step | 修改 | 在 `关键字段校验` for 循环后、`echo "[run-dev.sh] APP_NAME=..."` 前 插入：`bun run gen-version` | MUST 在 server 启动前 | specs/tech/app/envs/[P0]scripts.md §3.2 | +2 |
| version | .gitignore | app/server/app-version.json entry | 新增 | 在 build 期生成物段（`app/electron/runtime-config.json` 旁）加 `app/server/app-version.json`（生成物不入库） | MUST 与 runtime-config.json 同段（生成物约定） | — | +2 |
| version | app/electron/electron-builder.yml | files entry | 修改 | `files:` 列表内加 `- node_modules/@app/server/app-version.json`（紧跟 `node_modules/@app/server/**/*` 段）。确保 packaged 时 app-version.json 进 asar | MUST 显式列出（@app/server **/* 默认包含，但显式防漏）；MUST NOT 与 server dist 冲突 | specs/tech/app/package；原则 BUG-002 | +1 |

### E. 旧 ad-hoc 迁移清理（A — 全删不重建）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| migration-cleanup | app/server/src/memory/migrate-v0.0.55.ts | 整文件 | 删除 | user_memory.md→app_config 迁移（不再保留） | MUST 整文件删；MUST grep 确认无 import 残留 | req.md 决策 A | -150 |
| migration-cleanup | app/server/src/memory/migrate-memory-intro.ts | 整文件 | 删除 | description→intro 手动 CLI 迁移 | 同上 | 同上 | -200 |
| migration-cleanup | app/server/src/memory/__tests__/migrate-memory-intro.test.ts | 整文件 | 删除 | 上一文件的 UT 连带删 | MUST 连带删（避免悬空 import） | memory `delete-old-code-fully-when-replacing` | -180 |
| migration-cleanup | app/server/src/config/migrate-web-search-provider.ts | 整文件 | 删除 | web_search type 迁移 | MUST 整文件删 | req.md 决策 A | -50 |
| migration-cleanup | app/server/src/plugin/plugin-policy-migrate.ts | 整文件 | 删除 | impl key + exclusive 清理 | MUST 整文件删 | 同上 | -180 |
| migration-cleanup | app/server/src/stores/board-migrate.ts | 整文件 | 删除 | board schema 迁移 | MUST 整文件删 | 同上 | -250 |
| migration-cleanup | scripts/migrate-dev-to-app.v0.0.89.sh | 整文件 | 删除 | dev→app bash 脚本 | MUST 整文件删 | 同上 | -100 |
| migration-cleanup | app/server/src/plugin/plugin-config-service.ts | constructor :72-73 | 修改 | 删 `this.store.migrateLegacyImplKeys();` + `this.store.migrateLegacyExclusiveRecords(this.registry);` 两行；连带删 import `{ ImplPointResolver }` 若仅此处用（coder grep 确认） | MUST 不留 dead call | memory `delete-old-code-fully-when-replacing` | -2 |
| migration-cleanup | app/server/src/plugin/plugin-policy-store.ts | import 段 :34-37 | 修改 | 删 `import { migrateLegacyImplKeys as migrateLegacyImplKeysFn, migrateLegacyExclusiveRecords as migrateLegacyExclusiveRecordsFn } from './plugin-policy-migrate'` | MUST 连带删（被 import 的文件已删） | 同上 | -4 |
| migration-cleanup | app/server/src/plugin/plugin-policy-store.ts | migrateLegacyImplKeys() :234-236 | 删除 method | 整方法删（plugin-policy-migrate 删后成 dead） | MUST 不留 dead method | 同上 | -3 |
| migration-cleanup | app/server/src/plugin/plugin-policy-store.ts | migrateLegacyExclusiveRecords() :244-246 | 删除 method | 同上 | 同上 | -3 |
| migration-cleanup | app/server/src/stores/board-store.ts | re-export :37-38 | 修改 | 删 `export type { MigrateReport } from './board-migrate';` + `export { migrateSquadBoard } from './board-migrate';` | MUST 连带删 | 同上 | -2 |
| migration-cleanup | app/server/src/plugin/index.ts | 注释行 :59 | 修改 | 删/更新 migrateLegacy 相关注释行（grep 确认无其他 export） | MUST 不留悬空注释 | 同上 | -1 |

## 影响面评估

**跨模块影响**：
- 后端：bootstrap.ts（接线点）、router.ts（新端点）、新模块 migration/（10+ 新文件）、6 个文件物理删 + 5 个调用点清理
- 前端：app-shell.tsx（启动 fetch effect）、新 modal component、新 api lib
- 构建：根 package.json scripts、build-dmg.sh + run-dev.sh（gen-version step）、.gitignore、electron-builder.yml
- 配置：无用户配置 schema 变更（仅新增 ledger 文件 + lock 目录，不影响 CrudStore）

**破坏性变更**：
- 旧 DATA_DIR 若有 user_memory.md / dev_config / 旧 board schema 等遗留数据：旧迁移不再执行，**按现状读**（部分旧格式可能解析失败但不会主动迁移 — A 决策已知风险，无真实用户接受）
- BootstrapResult 结构新增字段（migrationErrors），router/sessionDeps 等消费方零侵入（仅新端点读此字段）
- electron-builder.yml files 增项：packaged 产物包含 app-version.json，包大小 +<1KB

**依赖顺序**（底层先）：
1. version-range.ts + ledger.ts（纯类型 + 工具，零依赖）→
2. app-version.ts + gen-version.ts + build scripts（版本生成链路）→
3. handlers/（dummy-update + handlers.yaml + index.ts）→
4. migration-manager.ts（依赖 1+3）→
5. bootstrap.ts 接线 + 删旧 import 段（依赖 4 + 删 6 文件）→
6. handlers/bootstrap-status.ts + router.ts 路由（依赖 5）→
7. 前端 api + modal + app-shell 接线（依赖 6）→
8. UT（白盒覆盖 1+4）

**风险点**：
- packaged 模式 app-version.json 路径解析（dev vs packaged `__dirname`）：用 `path.resolve(__dirname, '../app-version.json')` + 放 src/dist 平级 → dev `src/migration/` 与 packaged `dist/migration/` 都映射 `app/server/app-version.json`。**coder 必须在 packaged 真机验证此路径**（packaged 护栏第 4 条）
- mkdir 文件锁的跨平台行为（Windows mkdir 已存在返错 vs Unix 同）— 本项目 macOS 优先，coder 用 try/catch + pid 检测兜底
- handler 静态 map vs dynamic import：选静态 map 避开 packaged asar dynamic import 坑（参考 BUG-003 plugin 教训）
- 删 plugin-policy-migrate.ts 后 PluginPolicyStore 的 lazy migrate 路径彻底消失：spec 已声明 `落盘 policy deprecated 仅 lazy migrate 兼容`（config/index.md §3），删除即放弃兼容路径，spec 需 doc-modifier 同步对齐

**packaged 护栏自检（coder 必须按本护栏验证）**：
1. 依赖归属：无新 npm 依赖（复用 yaml + node:fs/node:path）→ ✓
2. plugin 进 asar：本变更不涉及 plugin 编译 → n/a
3. 运行时配置注入：app-version.json **不走 runtime-config.ts**（直接 fs 读静态 json），无新 env 键 → ✓
4. 路径展开：所有 DATA_DIR 路径走 `resolveDataDir`（packaged cwd=/）；app-version.json 用 `__dirname` 派生 → ✓
5. 验证：**dev 全绿 ≠ packaged 跑得通**，coder 必须解 asar 起真后端 curl `/bootstrap/status` 确认 appVersion 字段返回正确（packaged 护栏 MANDATORY 验证条）

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- coder 发现 spec 概念与代码实际不符（如 PluginPolicyStore 字段名偏差）：按代码实现 + 汇报偏离 → orchestrator 记 doc-sync 待办 → doc-modifier 阶段 5 统一修 spec
