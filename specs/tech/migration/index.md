---
type: index
title: Migration 子系统总起
priority: P0
updated: 2026-07-15
---

# Migration 子系统总起

## ① 是什么

启动期**持久化数据迁移主控**——bootstrap 时挂 `MigrationManager`，跑注册的 handler（yaml 声明 + 静态 import map 解析），并把执行结果（done/error/na）原子写入 ledger。失败统一收集进 `BootstrapResult.migrationErrors`，**不阻塞 bootstrap**。

| 核心概念 | 一句话 |
|---|---|
| **MigrationManager** | 主控 class。`bootstrap.ts:362` AppConfigService 后实例化 + `run()` 跑迁移流程（acquireLock → loadRegistry → readLedger → process per-handler → writeLedger → releaseLock） |
| **ledger** | `<DATA_DIR>/migration_state.json` = `{ lastAppVersion, handlers: { [id]: HandlerState } }`，原子写（tmp+rename），**不走 CrudStore**（避循环依赖） |
| **HandlerEntry / handlers.yaml** | 注册表单条 `{ id, versionRange, module }`；yaml 同包内 `__dirname` 解析，`tsc -b && cp yaml` 保 packaged 生存 |
| **handler registry** | 静态 import map（`handlers/index.ts`），非 dynamic import（避 packaged asar 坑）。当前注册 3 handler：`dummy-update`（链路验证空操作）+ `memory-intro`（description→intro 重命名）+ `memory-source-updated`（补 source/updatedAt） |
| **MigrationHandlerContext** | `{ dataDir, appConfig }`——manager 注入到每个 handler |
| **app-version.json** | build step 从根 package.json 生成，写 `app/server/app-version.json`；运行时 `__dirname` 派生路径读（不走 env/runtime-config） |
| **文件锁** | `<DATA_DIR>/migration.lock` 目录 + pid 文件；mkdir 原子 + stale pid 检测；自实现无依赖 |
| **GET /bootstrap/status** | 前后端通道。返 `{ appVersion, lastAppVersion, migrationErrors }`，即使有 errors 仍 200（统一放行） |

## ② 边界

| 管 | 不管（→ 别处） |
|---|---|
| 启动期一次性数据迁移主控 + ledger + handler registry + 文件锁 + 版本号读取 | bootstrap 整体编排（→ `app/start_up`）|
| `GET /bootstrap/status` 数据装配（appVersion/lastAppVersion/migrationErrors）| HTTP 路由细节（→ `specs/api/overall/01-counter.md §6`）|
| MigrationErrorModal 数据契约（errors[] 形状）| modal 视觉/交互（→ `specs/ui/components/framework/migration-error-modal.md`）|
| 当前版本号读取（getAppVersion）+ build step 生成（gen-version）| 打包工具链（→ `app/package`）|

## ③ 与系统的关系

```
   bootstrap.ts
     ├─ AppConfigService 实例化
     ├─ ★ new MigrationManager({ dataDir, appConfig }).run()    ← 挂载点（AppConfigService 后、业务 store 前）
     │     ├─ acquireLock(<DATA_DIR>/migration.lock)             ← mkdir 原子 + pid stale 检测
     │     ├─ getAppVersion()                                     ← 读 app/server/app-version.json（__dirname 派生）
     │     ├─ loadRegistry()                                      ← 读 handlers/handlers.yaml（静态 import map 解析）
     │     ├─ readLedger() / writeLedger()                        ← <DATA_DIR>/migration_state.json（原子 tmp+rename）
     │     └─ processEntry() per-handler                          ← applied 主 + range 兜底 + na/error/done 三态
     ├─ business stores（BoardStore/MemberStore/SessionStore）
     └─ BootstrapResult.migrationErrors ← MigrationSummary.errors（透传给 GET /bootstrap/status）
                                ↓
   router.ts GET /bootstrap/status → handleBootstrapStatus(bs, dataDir)
                                ↓
   app-shell.tsx useEffect → fetchBootstrapStatus → MigrationErrorModal（errors>0 渲染）
```

**对外协作点**：migration 子系统是 bootstrap 期的横切关注——不持业务状态、不读业务 store；handler 通过 `MigrationHandlerContext.appConfig` 可访问配置（dummy-update 不用，预留）。

## ④ 核心设计原则

1. **handler applied 主防线 + version range 兜底**——`processEntry` 三分支：`status==='done'` skip（主防线，即使 range 仍满足也不重跑）/ 未 applied 且 range 不满足 → 持久化 `'na'`（下次启动仍走 range 重评估，幂等覆盖）/ 未 applied 且 range 满足 → 执行。不这样会怎样：无 range 兜底则升级过头后 handler 永远不跑（已 done 主防线还好），但 na 不持久化则下次启动 ledger 缺字段、无法区分「未跑」与「跑过但 range 不满足」。
2. **handler MUST 幂等**——manager 提供 applied 主防线（done 不重跑），handler 自身也须幂等兜底（同一 handler 多次调用零副作用）。forward-only：error 状态不自动重试，由人工介入。
3. **MUST NOT 阻塞 bootstrap**——任一 handler throw 被 `run()` catch 进 `summary.errors`；lock 冲突 / loadRegistry / readLedger / writeLedger 抛错也都进 summary.errors；最终 `BootstrapResult.migrationErrors` 透传给前端展示。不这样会怎样：handler 错让整个 app 启不来，用户无法进入界面看错误。
4. **MUST NOT 清用户配置**——handler 仅做格式升级/字段重命名等非破坏操作；禁止删除用户 record。
5. **ledger 原子写 + 不走 CrudStore**——`writeFileSync(tmp) + renameSync` 避免半写态；独立读写不经 CrudStore（CrudStore 内部依赖 app_config 等，会和 MigrationManager 形成循环依赖）。
6. **handler registry 静态 import map**——`handlers/index.ts` 用静态 `import { dummyUpdate } from './dummy-update'` 注册 map（非 dynamic import），避开 packaged asar dynamic import 路径解析坑（参考 BUG-003 plugin 教训）。
7. **当前版本号走 `__dirname` 派生静态 json**——不走 process.env / runtime-config（packaged env 干净，BUG-001），不 import json（避 bundler copy 坑）。`__dirname/../../app-version.json` 两级回溯：dev `src/migration/` + packaged `dist/migration/` 都解析到 `app/server/app-version.json`。所有 DATA_DIR 路径走 `resolveDataDir`（packaged cwd=/ 安全，BUG-004）。
8. **文件锁自实现**——`mkdir` 原子操作（已存在 → EEXIST → 检测 pid 存活 → 死则清重建）；锁目录内写 `pid + startedAt`。不引 proper-lockfile 等新 npm 依赖。
9. **挂载点：AppConfigService 之后、业务 store 之前**——handler 可访问 AppConfigService（读 config 决策迁移）；早于业务 store 避免 store 读到未迁移数据。lock 持有期 < 整个 bootstrap（finally 释放）。

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 优先级 | 链接 |
|---|---|---|---|
| `migration_manager.md` | MigrationManager 主控详细设计（processEntry 三分支 / acquireLock / loadRegistry / readLedger / writeLedger）+ ledger schema + handler registry + version-range + app-version | P0 | [link]([P0]migration_manager.md) |

> 变更历史见 [`log.md`](log.md)；跨版本发布说明见 [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)。
