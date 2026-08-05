# v0.0.150 change_log — 固化持久化数据迁移逻辑（MigrationManager）

> 跨版本发布说明（版本轴）。本目录级位置轴日志见各 KB 的 `log.md`（migration/config）。method 级合同见 `change_plan.md`。

## 1. 版本主题

引入 **MigrationManager** 统一管启动期持久化数据迁移：yaml 声明 handler + version range 条件 + 本地持久化 ledger（done/error/na 三态）；当前版本号由 build step 生成 `app/server/app-version.json` 静态读取；迁移失败统一收集进 `BootstrapResult.migrationErrors`，经 `GET /bootstrap/status` 端点透传给前端，errors>0 渲染 `MigrationErrorModal` 走统一放行（不阻塞 bootstrap）。同时 A 决策下旧 5 处 ad-hoc 迁移全删不重建（无真实用户）。

新增子系统 KB：`specs/tech/migration/`（index + log + `[P0]migration_manager.md`）。

## 2. 实现偏离 change_plan（9 项，全部接受）

> 以下偏离均由 coder 在实现期发现并主动汇报，经 reviewer/orchestrator 确认接受；不偏离核心约束（架构原则/invariants/PRD 关键路径）。

### 2.1 app-version.json 路径两级回溯（非一级）

- **change_plan §A 写**：`path.resolve(__dirname, '../app-version.json')`（一级回溯）
- **实际实现**：`path.resolve(__dirname, '../../app-version.json')`（两级回溯）
- **理由**：`__dirname` = `src/migration/`（dev）或 `dist/migration/`（packaged），一级 `../` 只到 `src/` 或 `dist/`，不到 `app/server/`。两级回溯正确解析到 `app/server/app-version.json`（src/dist 平级）。
- **spec 同步**：已在 `specs/tech/migration/[P0]migration_manager.md §3.4` + `index.md` ④ 原则 7 落地正确路径（spec 未硬编码一级路径，无需再修）。

### 2.2 handlers.yaml packaged 路径需 cp（tsc 不复制 yaml）

- **change_plan §A 未提**：`loadRegistry()` 假设 handlers.yaml 在 dist/ 可读。
- **实际实现**：`tsc -b` 不复制 `.yaml` 到 dist/，原计划在 packaged 模式会 ENOENT。已加 `app/server/package.json` build 脚本：`tsc -b && cp -r src/migration/handlers/*.yaml dist/migration/handlers/`。
- **spec 同步**：已在 `specs/tech/migration/index.md` ② 概念表（HandlerEntry 行）+ log.md 落地。

### 2.3 连带删 2 个额外 test 文件

- **change_plan §E 只列**：`migrate-memory-intro.test.ts` 连带删。
- **实际实现**：`migrate-v0.0.55.test.ts` 和 `migrate-web-search-provider.test.ts` 也 import 已删源文件，不删则 `bun run test` import 断裂。已一并 soft-delete。
- **spec 同步**：无需（test 文件删除属实现细节，spec 不列具体 test 文件）。

### 2.4 board-store.test.ts / plugin-policy-store.test.ts 手术清理（非整文件删）

- **change_plan §E 未提**：这两 test 文件非纯 migrate 测试（是 store 全量 UT）。
- **实际实现**：含 migrate 相关 describe block（`migrateSquadBoard` / `migrateLegacyImplKeys`）。已手术式删除这些 describe block（非整文件删），保留其余 store UT。
- **spec 同步**：无需（test 实现细节）。

### 2.5 lastAppVersion 重读 ledger（非 bs 多一字段）

- **change_plan §C 二选一 coder 定位**：「lastAppVersion 从 MigrationManager 注入 bs 或重读 ledger（避免 bs 多一字段）」。
- **实际选择**：重读 ledger——`bs` 只加 `migrationErrors` 字段；`handleBootstrapStatus(bs, dataDir)` 内 `fs.readFile` 读 ledger 拿 `lastAppVersion`（缺失/损坏兜底 `'0.0.0'`）。router 调 `handleBootstrapStatus(bs, dataDir)` 透传 dataDir。
- **理由**：尊重 change_plan「避免 bs 多一字段」倾向 + lastAppVersion 是「上次跑完版本」语义，从 ledger 读最直接。
- **spec 同步**：已在 `specs/api/overall/01-counter.md §6.2` + `specs/tech/migration/[P0]migration_manager.md §3.6` 落地。

### 2.6 na 状态持久化（Minor 1）

- **change_plan §A 写**：`isHandlerAppliable` 双防线判定，未明确 na 是否持久化。
- **实际实现**：`processEntry` 改三分支——done skip / 未 applied+range 不满足 **持久化 na** / 未 applied+range 满足 执行。na handler 下次启动仍走 range 兜底重评估（幂等覆盖）。`isHandlerAppliable` 公开 API 保留（processEntry 内部直接判，不调它——orphan，见 §2.9）。
- **UT 补**：3 个 na 测试（首次写 na / 二次 range 仍不满足幂等覆盖 / 二次 range 变满足执行 done）。
- **spec 同步**：已在 `specs/tech/migration/[P0]migration_manager.md §3.1` 落地三分支语义。

### 2.7 MigrationHandlerContext 挪 ledger.ts（Minor 2，避循环引用）

- **change_plan §A 写**：`MigrationHandlerContext` 放 `migration-manager.ts`。
- **实际实现**：挪到 `ledger.ts`——避 `migration-manager.ts ↔ handlers/index.ts` 循环引用（handlers/index.ts 的 `MigrationHandler` 契约引用 `MigrationHandlerContext`，从 ledger.ts 读类型即可）。
- **spec 同步**：已在 `specs/tech/migration/[P0]migration_manager.md §2.3` 落地。

### 2.8 i18n 本版硬编码（跨版本补）

- **change_plan 未提**：modal 中文字符串硬编码（"迁移失败"/"确定"/"打开日志目录"），未走 i18n t()。
- **判定**：本版可接受硬编码，follow-up 跨版本补。理由：(1) 本版纯后端 infra 免 PRD；(2) 动态 errors 来自后端中文（lock 错误等），后端 i18n 未做→只 localizing modal chrome 会产生 mixed-language UX（局部化更差）；(3) 完整 i18n 需后端 error 也 i18n，超出本版范围。
- **spec 同步**：已在 `specs/tech/migration/log.md` v0.0.150 块尾说明。

### 2.9 LEDGER_FILENAME 去重（Minor，reviewer 修复）

- **背景**：原 migration-manager.ts:52 + bootstrap-status.ts:35 各定义一份 `const LEDGER_FILENAME = 'migration_state.json'`（DRY 违反）。
- **修复**：挪到 `ledger.ts`（权威类型模块）`export const LEDGER_FILENAME`，两处 import 共用。
- **spec 同步**：已在 `specs/tech/migration/[P0]migration_manager.md §2.2` 落地（LEDGER_FILENAME 单一权威源）。

### 2.10 isHandlerAppliable orphan（观察，不修，follow-up）

- **背景**：`isHandlerAppliable()`（ledger.ts:90）在 §2.6 三分支重构后成 orphan——`processEntry` 内联 done/range 判定不再调它，无生产/测试 caller（仅 barrel re-export）。
- **决策**：change_plan §A 明确列为交付物 + coder 显式决定保留，故不删；后续若确认无外部消费可清理。
- **spec 同步**：无需（orphan 代码细节，spec 不列）。

## 3. 旧 ad-hoc 迁移全删（A 决策）

6 文件物理删 + 5 处调用点清理：

| 类型 | 路径 | 说明 |
|---|---|---|
| 删文件 | `app/server/src/memory/migrate-v0.0.55.ts` | user_memory.md→app_config 迁移 |
| 删文件 | `app/server/src/memory/migrate-memory-intro.ts` | description→intro 手动 CLI |
| 删文件 | `app/server/src/config/migrate-web-search-provider.ts` | web_search type 迁移 |
| 删文件 | `app/server/src/plugin/plugin-policy-migrate.ts` | impl key + exclusive 清理 |
| 删文件 | `app/server/src/stores/board-migrate.ts` | board schema 迁移 |
| 删文件 | `scripts/migrate-dev-to-app.v0.0.89.sh` | dev→app bash 脚本 |
| 连带删 | `app/server/src/memory/__tests__/migrate-memory-intro.test.ts` + `migrate-v0.0.55.test.ts` + `config/__tests__/migrate-web-search-provider.test.ts` | test 连带删 |
| 清调用点 | `bootstrap.ts` :43/:45 import + :350-360 调用段 | migrate-v0.0.55 + migrate-web-search-provider |
| 清调用点 | `plugin-config-service.ts` constructor :72-73 | migrateLegacyImplKeys + migrateLegacyExclusiveRecords |
| 清调用点 | `plugin-policy-store.ts` :34-37 import + :234-246 两方法 + board-store.ts :37-38 re-export | dead code 清理 |
| 手术清理 | `board-store.test.ts` + `plugin-policy-store.test.ts` 内 migrate describe block | 删 block 保 store UT |

**spec 同步**：config KB 内 5 处引用清理（详 `specs/tech/config/log.md` v0.0.150 块）；memory spec `migrate-memory-intro.ts` 引用清。

## 4. packaged 护栏验证（5 项全 PASS）

1. **gen-version → app-version.json**：含 `version=0.0.148`（当前 package.json）。
2. **`bun run build`**：`tsc -b && cp yaml` 成功无错。
3. **dist 结构三件齐**：`dist/migration/app-version.js` + `dist/migration/handlers/handlers.yaml` + `dist/migration/handlers/dummy-update.js`。
4. **packaged 模拟**（bun 跑 dist/index.js，干净 env 仅透 DATA_DIR/API_PORT/WEB_PORT/NODE_ENV=production）：`GET /bootstrap/status` → 200 返 `{"appVersion":"0.0.148","lastAppVersion":"0.0.148","migrationErrors":[]}`；POST → 405 method guard 正常。
5. **ledger 落盘**：`<DATA_DIR>/migration_state.json` 正确——dummy-update.status=done / appliedAt=ISO / appVersion=0.0.148 / lastAppVersion=0.0.148。

**预先存在问题（非 v0.0.150 引入）**：`node dist/index.js` 模拟 packaged 时 feishu plugin builtin-loader 试图 require `.ts` 源失败 → 500。该问题属 v0.0.118（feishu channel 鲁棒性改造，commit 4ffbf719），本版未触及；真 packaged 走 `scripts/build-plugins.ts` 编译成 `.cjs` 自包含包避免此问题。故用 bun 跑 dist 验证 MigrationManager 三件套。

## 5. spec 文件清单（本次新增/修改）

### 新增

- `specs/tech/migration/index.md`（KB 总起，5 章 + 9 条核心设计原则，~115 行）
- `specs/tech/migration/[P0]migration_manager.md`（主控详细设计）
- `specs/tech/migration/log.md`（KB 变更日志）
- `specs/tech/version_logs/v0.0.150/change_log.md`（本文件）

### 修改（清理旧 migrate 引用 / 加新端点）

- `specs/tech/index.md`：⑤ 导航加 migration 行 + 概念表加 migration 行
- `specs/tech/config/[P0]app_config.md`：§3.1/§3.3/§3.5/§3.6 删旧 migrate 脚本引用
- `specs/tech/config/[P0]ext_impl_scope.md`：§4.4 lazy migrate 改历史叙述
- `specs/tech/config/[P0]plugin_config_service.md`：§1/§3/§4.4 lazy migrate 改历史叙述
- `specs/tech/config/[P0]plugin_config.md`：§5 lazy migrate 引用更新
- `specs/tech/config/log.md`：加 v0.0.150 块
- `specs/tech/agent/memory/[P0]memory_definition.md`：§3 删 migrate-memory-intro.ts 引用
- `specs/api/overall/01-counter.md`：新增 §6 Bootstrap Status 端点契约
- `specs/ui/overall/02-llm-chat.md`：加 migration-error-modal 引用
- `specs/ui/components/framework/app-shell.md`：组合关系加 migration-error-modal

### 既有（coder 已建，doc-modifier 核对完整 + 与代码一致）

- `specs/ui/components/framework/migration-error-modal.md`：组件契约（props/testid/Portal/多错聚合）✅

## 6. 代码-spec 一致性核查结论

逐项核查 MigrationManager 代码 vs 新写的 spec：

| 核查项 | 代码 | spec | 结论 |
|---|---|---|---|
| processEntry 三分支 | `migration-manager.ts:125-164` done skip / na 持久化 / 执行 | `[P0]migration_manager.md §3.1` | ✅ 一致 |
| handler registry 静态 import map | `handlers/index.ts:26` 静态 map（非 dynamic import） | `index.md` ④ 原则 6 + `[P0]migration_manager.md §3.2` | ✅ 一致 |
| 文件锁 mkdir+pid | `migration-manager.ts:170-194` acquireLock + `isPidAlive` EPERM/ESRCH | `[P0]migration_manager.md §3.3` | ✅ 一致 |
| getAppVersion 两级回溯 | `app-version.ts:25` `../../app-version.json` | `[P0]migration_manager.md §3.4` | ✅ 一致（spec 写两级） |
| LEDGER_FILENAME 单一权威源 | `ledger.ts:21` export + manager/handler 共用 | `[P0]migration_manager.md §2.2` | ✅ 一致 |
| MigrationHandlerContext 放 ledger.ts | `ledger.ts:75`（非 manager.ts） | `[P0]migration_manager.md §2.3` | ✅ 一致 |
| /bootstrap/status 三字段 | `bootstrap-status.ts:56-64` appVersion/lastAppVersion/migrationErrors | `01-counter.md §6.2` | ✅ 一致 |
| 即使有 errors 仍 200 | `bootstrap-status.ts:59` `json(200, ...)` 无 errors 分支 | `01-counter.md §6.1` | ✅ 一致 |
| method 错返 405 | `router.ts:372-374` 405 + Allow: GET | `01-counter.md §6.1` | ✅ 一致 |
| MigrationErrorModal 走 Portal | `migration-error-modal.tsx:24` `<Portal>` | `migration-error-modal.md` + `app-shell.md` | ✅ 一致 |
| 多错聚合 | `migration-error-modal.tsx:31` `${errors.length} 个迁移失败` | `migration-error-modal.md` | ✅ 一致 |

**无代码静默偏离 spec 的情况**——所有偏离均在 §2 实现偏离清单中明确记录 + spec 已同步对齐到代码实际。

## 7. 合并 step2 收编（v0.0.149 ad-hoc memory 迁移 → MigrationManager handler）

### 7.1 背景

worktree 合并 dev1 时，v0.0.149 在 dev1 引入的两处 ad-hoc memory 迁移（`migrate-memory-intro.ts` 手动 CLI + `bootstrap.ts` 内联 source/updated 字段补全）与 v0.0.150 step1「A 决策旧 ad-hoc 全删（无真实用户）」产生冲突——dev1 已有数据触达这两迁移。

**用户决策**：正式收编为 MigrationManager handler（非删 / 非留 ad-hoc）——保迁移逻辑持久化进 registry，未来启动期自动幂等执行，避免 ad-hoc 脚本漂移。

### 7.2 收编清单

| handler id | 源文件 | 迁移内容 | 介质 |
|---|---|---|---|
| `memory-intro` | `app/server/src/migration/handlers/memory-intro.ts` | `description` → `intro` 字段重命名（v0.0.114 存量） | (1) `<dataDir>/sessions/<sid>/session_memory.md` frontmatter；(2) `app_config` record `user_memory/default`.entries[] |
| `memory-source-updated` | `app/server/src/migration/handlers/memory-source-updated.ts` | 补 `source`(缺→'agent') + `updatedAt`(缺→now ISO)（v0.0.149 存量） | 同上两介质 |

`handlers.yaml` + `handlers/index.ts` 静态 map 从 `dummy-update` 单条扩到 3 条；全 `versionRange: '<0.0.151'`。

### 7.3 实现偏离原 ad-hoc（3 项，全部接受）

> 偏离源 = step1 已定的 MigrationManager handler 契约，收编须对齐契约非照搬 ad-hoc。

#### 7.3.1 active dataDir 单环境（非扫多环境）

- **原 ad-hoc**：`migrate-memory-intro.ts` 接受 `--data-dir` 参数（可指定任意 dataDir）。
- **收编后**：handler 仅迁 `ctx.dataDir`（bootstrap 传入的 active 环境），不扫多 dataDir。
- **理由**：MigrationManager 语义是启动期对 active dataDir 做一次性迁移；多环境扫描超出子系统边界。

#### 7.3.2 共享 appConfig（ctx 注入）

- **原 ad-hoc**：`migrate-memory-intro.ts` 自建 AppConfigService 实例（独立读 app_config）。
- **收编后**：handler 通过 `ctx.appConfig`（bootstrap 期已初始化的 AppConfigService 实例）读写 user_memory record。
- **理由**：bootstrap 期 appConfig 已就绪（`MigrationManager` 挂载点 = AppConfigService 之后），复用单例避免重复初始化 + 保证 handler 看到与业务一致的 config 视图。

#### 7.3.3 移除顶层 try-catch warn（对齐 spec 契约）

- **原 ad-hoc**：两迁移在顶层 `try { ... } catch (e) { console.warn(...) }` 吞错继续。
- **收编后**：handler 内不 try-catch；throw 由 `processEntry` 统一 catch → 写 ledger `status: 'error'` + 进 `summary.errors` → 透传 `BootstrapResult.migrationErrors` → 前端 MigrationErrorModal 展示。
- **理由**：step1 已定 handler 失败统一由 manager catch 的契约（`index.md` ④ 原则 3 + §3 processEntry），收编 handler 须对齐；ad-hoc warn 会被吞掉丢失迁移失败信号，与 v0.0.150「errors 可视不阻塞」通道相悖。

### 7.4 注释瘦身

收编过程同步应用 v0.0.97 增量注释瘦身规范：两 handler 顶部注释只记「当前逻辑 + 设计动机 + 失败语义」（字段级 marker 原因 / 非破坏保护 / handler 不 catch 契约 / 介质覆盖），删 ad-hoc 期的「过去是 X 改 Y」过程流水账；版本号前缀（`v0.0.114` / `v0.0.149`）只保留识别存量来源所必需的一处（顶部 docstring），逻辑行内不堆叠。

### 7.5 spec 同步

- `specs/tech/migration/log.md`：加 v0.0.150 步骤2 块（倒序置顶）。
- `specs/tech/migration/index.md`：概念表「handler registry」行补当前 3 handler 清单。
- `specs/tech/migration/[P0]migration_manager.md`：§2.3 加 handler 失败统一由 manager catch 契约；§4.1 handlers.yaml 示例更新为 3 条。
- 本文件 §7（本节）。

### 7.6 代码-spec 一致性核查

| 核查项 | 代码 | spec | 结论 |
|---|---|---|---|
| registry 3 handler | `handlers/index.ts:28-32` map 含 dummy-update/memory-source-updated/memory-intro | `index.md` 概念表 + `[P0]migration_manager.md §4.1` | ✅ 一致 |
| handlers.yaml 3 条 | `handlers.yaml:14-23` | `[P0]migration_manager.md §4.1` | ✅ 一致 |
| memory-intro 字段级 marker | `memory-intro.ts:106-124` splitFrontmatterBlocks + gray-matter 独立解析 + hasOwnProperty('description') | `log.md` 步骤2 + 本节 §7.2 | ✅ 一致 |
| memory-source-updated 字段级 marker | `memory-source-updated.ts:147-172` 同款扫描 + hasOwnProperty('source'/'updatedAt') | `log.md` 步骤2 + 本节 §7.2 | ✅ 一致 |
| handler 不 try-catch | 两 handler 顶层无 try-catch，直接抛 | `[P0]migration_manager.md §2.3` 新增契约 | ✅ 一致 |
| 共享 ctx.appConfig | 两 handler 均用 `ctx.appConfig.get/set` | `index.md` 概念表 + 本节 §7.3.2 | ✅ 一致 |
| active dataDir 单环境 | 两 handler 仅用 `ctx.dataDir`，不扫多环境 | 本节 §7.3.1 | ✅ 一致 |
