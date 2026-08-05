---
type: spec
title: MigrationManager 主控详细设计
priority: P0
status: active
updated: 2026-07-26
since: v0.0.150
---

# MigrationManager 主控详细设计

## 1. 概述

**管什么**：MigrationManager class 的 processEntry 三分支执行流 / acquireLock 文件锁语义 / loadRegistry+resolveHandler 静态 map 解析 / readLedger+writeLedger 原子读写 / getAppVersion 静态 json 读取 / satisfiesRange 自实现比较 / MigrationHandlerContext 注入契约。
**不管什么**：bootstrap 整体编排（→ `app/start_up`）、HTTP 路由细节（→ `specs/api/overall/01-counter.md §6`）、modal 视觉（→ `specs/ui/components/framework/migration-error-modal.md`）。
总览见 [`index.md`](index.md)。

MigrationManager 是启动期**单次使用** class：每次 bootstrap `new` 一个实例，`run()` 跑完即废弃。

## 2. 接口与数据形状

### 2.1 MigrationManagerOptions / MigrationSummary

```typescript
interface MigrationManagerOptions {
  /** DATA_DIR 绝对路径（packaged cwd=/ 下必须绝对，由 bootstrap 走 resolveDataDir 传入） */
  dataDir: string;
  /** AppConfigService —— handler 注入用（dummy-update 不用，预留） */
  appConfig: AppConfigService;
}

interface MigrationSummary {
  /** 本次实际执行的 handler id 列表 */
  ran: string[];
  /** 因 applied 或 range 不满足而跳过的 id 列表 */
  skipped: string[];
  /** 执行抛错的 handler 错误列表（不阻塞 bootstrap，透传 BootstrapResult.migrationErrors） */
  errors: Array<{ id: string; message: string; stack?: string }>;
}
```

### 2.2 Ledger 持久化形状

```typescript
/** ledger 文件名（单一权威源；MigrationManager 写、handleBootstrapStatus 读，共用） */
export const LEDGER_FILENAME = 'migration_state.json';

interface MigrationLedger {
  /** 上次成功跑完 MigrationManager 的 app 版本（'0.0.0' = 首次启动） */
  lastAppVersion: string;
  /** per-handler-id 的状态条目 */
  handlers: Record<string, HandlerState>;
}

interface HandlerState {
  status: 'done' | 'error' | 'na';
  appliedAt: string;   // ISO 8601
  appVersion: string;  // 跑该 handler 时的 app 版本
  error?: { message: string; stack?: string }; // status='error' 时必填
}
```

落盘位置：`<DATA_DIR>/migration_state.json`。原子写：`writeFileSync(tmp) + renameSync`（避免半写态）。

### 2.3 Handler 注册表

```typescript
/** handlers.yaml 单条 schema */
interface HandlerEntry {
  id: string;            // handler 唯一 id（同 handlers/index.ts 静态 map 的 key）
  versionRange: string;  // '<X.Y.Z' 形式（仅支持 < 前缀）
  module: string;        // './handlers/<file>'（信息性，实际解析走静态 import map）
}

/** handler 函数签名 —— 接收上下文，失败抛错由 manager catch */
type MigrationHandler = (ctx: MigrationHandlerContext) => Promise<void>;

// handler 契约：实现内 **不** try-catch MigrationManager 范围的错；
// 任何 throw 由 processEntry 的 try-catch 统一捕获 → 写 ledger `status: 'error'` +
// 进 summary.errors → 透传 BootstrapResult.migrationErrors。handler 自身只负责
// 「该迁移什么 + 怎么幂等」，错误分类 / 重试 / 上报归 manager。

/** handler 执行上下文（manager 注入） */
interface MigrationHandlerContext {
  dataDir: string;        // DATA_DIR 绝对路径
  appConfig: AppConfigService;
}
```

`MigrationHandlerContext` 放在 `ledger.ts`（非 `migration-manager.ts`）以避免 `handlers/index.ts ↔ migration-manager.ts` 循环引用：handlers 读类型即可，不 import manager。

## 3. 设计决策

### 3.1 processEntry 三分支（applied 主 + range 兜底 + na 持久化）

**结论**：每个 handler entry 按以下顺序判：
1. `state?.status === 'done'` → skip（保持 done，不覆盖；**applied 主防线**）
2. 未 applied + range 不满足 → 持久化 `'na'`（`appliedAt/appVersion` 写当前）+ 进 skipped
3. 未 applied + range 满足 → 执行 → done 或 error

**理由**：
- **applied 主防线**：handler 一旦 done 不再跑，即使 range 仍满足（升级后回退场景也安全）。
- **range 兜底**：升级过头（当前版本 ≥ range 上界）的 handler 不跑；na 持久化让 ledger 完整记录三种终态（done/error/na），区分「未跑」与「跑过但 range 不满足」。
- **na 幂等覆盖**：下次启动 na handler 仍走 range 兜底重评估（range 变满足则执行）。

**不这样会怎样**：无 range 兜底则升级过头后 handler 永远不跑（done 主防线还好），但 na 不持久化则 ledger 无法区分「未跑」与「跑过但 range 不满足」——下次启动会重跑或漏跑。

### 3.2 handler registry 静态 import map（非 dynamic import）

**结论**：`handlers/index.ts` 用静态 `import { dummyUpdate } from './dummy-update'` + `handlerRegistry: Record<string, MigrationHandler>` map 注册。`resolveHandler(entry)` 从 map 查函数引用。

**理由**：dynamic import 在 packaged asar 中路径解析不稳定（参考 BUG-003 plugin 进 asar 教训）。静态 map 在编译期就把所有 handler 拉进 bundle，packaged 模式零路径解析风险。

**新增 handler 步骤**：(1) `handlers/<id>.ts` 实现 `export const xxxHandler = async (ctx) => {...}`；(2) `handlers.yaml` 加一条 `{ id, versionRange, module }`；(3) `handlers/index.ts` 加 import + 加入 `handlerRegistry` map。

### 3.3 文件锁 mkdir + pid（自实现，无新依赖）

**结论**：`<DATA_DIR>/migration.lock` 目录 + 内含 `pid` + `startedAt` 文件。`acquireLock` 流程：`mkdir`（原子）→ 已存在 EEXIST → `isLockHeld()`（读 pid + `process.kill(pid, 0)` 探活，EPERM=alive 权限不足，ESRCH=stale）→ alive throw `MigrationLockHeldError` / stale 清旧重建。`releaseLock` 在 finally `rmdir recursive`（catch 吞错）。

**理由**：mkdir 是 POSIX 原子操作（已存在返 EEXIST）；pid 检测跨平台 best-effort；不引 proper-lockfile 等新依赖。

### 3.4 getAppVersion 静态 json + `__dirname` 两级回溯

**结论**：`scripts/gen-version.ts`（根 `bun run gen-version`）从根 `package.json` 读 version → 写 `app/server/app-version.json` = `{ version, generatedAt }`。`getAppVersion()` 用 `path.resolve(__dirname, '../../app-version.json')` 读。

**两级回溯理由**：`__dirname` = `src/migration/`（dev）或 `dist/migration/`（packaged），两级回溯到 `app/server/`，两者都解析到 `app/server/app-version.json`（src/dist 平级）。change_plan 原写一级回溯路径算错（只到 src/ 或 dist/）。

**不走 env / runtime-config 理由**：packaged env 干净（BUG-001）；不 import json 避 bundler copy 坑；`__dirname` 派生绝对路径不依赖 cwd（packaged cwd=/ 安全，BUG-004）。

### 3.5 satisfiesRange 自实现（仅 `<X.Y.Z` 前缀）

**结论**：`version-range.ts` 仅支持 `<X.Y.Z` 形式（其他前缀 throw）；`parseVersion` 拆三段数字独立比较，不混 string 比较（避 `'10' < '9'` 字典序坑）。

**理由**：迁移场景只需「当前版本 < 上界」语义；引 semver 库 overdraft，自实现 < 50 行够用。

### 3.6 报错通道走 REST 端点（非 SSE / 共享文件）

**结论**：`BootstrapResult.migrationErrors` 字段 + `GET /bootstrap/status` 端点（router.ts `/health` 旁）+ `handleBootstrapStatus(bs, dataDir)`。lastAppVersion 由 handler 内重读 ledger 拿（避免 bs 多一字段）。

**理由**：bootstrap 一次性快照，REST 够用且对齐 `/health` 模式；不用 SSE（bootstrap 期还未建 SSE 通道）；不用共享文件（lastAppVersion 重读 ledger 最直接）。

## 4. 示例

### 4.1 handlers.yaml（registry 已逐版本扩至 10 条；示例 = 首条 + 最新一条的形态）

```yaml
handlers:
  - id: dummy-update              # 链路验证空操作（v0.0.150 首版）
    versionRange: '<0.0.151'
    module: './handlers/dummy-update'
  # ...（memory-source-updated / memory-intro / clean-default-models-summary /
  #      clean-squad-summary-model-default / session-derivation-main-to-parent /
  #      session-memory-per-entry / squad-rocky-dir——收编记录逐条见 log.md；
  #      v0.0.208 删除 academy-version-dirs / academy-trainer-template-refresh 两 handler——academy 板块整体删除）
  - id: channel-binding-config-id  # v0.0.206：channel_bindings 落盘 instanceId→configId
    versionRange: '<0.0.207'
    module: './handlers/channel-binding-config-id'
```

**versionRange off-by-one 约定（load-bearing）**：range 语义 = 当前 app 版本 < 上界才跑。vX.Y 引入的 handler 上界取 `'<X.Y+1>'`（如 v0.0.206 引入取 `'<0.0.207'`）——取 `'<X.Y>'` 会在 X.Y release 上判 na 永不执行（v0.0.150/v0.0.203/v0.0.204/v0.0.205 同先例，handlers.yaml 内注释逐条钉死）。

完整 handler 清单 + 各 handler 幂等/marker/备份语义见 [`log.md`](log.md) 各版本收编记录。

### 4.2 首次启动 ledger 演化

```json
// 启动前：<DATA_DIR>/migration_state.json 不存在
// 启动后（MigrationManager.run 跑完）：
{
  "lastAppVersion": "0.0.150",
  "handlers": {
    "dummy-update": {
      "status": "done",
      "appliedAt": "2026-07-15T06:30:00.000Z",
      "appVersion": "0.0.150"
    }
  }
}
```

### 4.3 二次启动（lastAppVersion=0.0.150，dummy-update applied）

```
processEntry(dummy-update):
  state.status === 'done' → skip（保持 done，不覆盖）
  → summary.skipped = ['dummy-update']
  → ledger.lastAppVersion = '0.0.150'（当前版本，原样更新）
```

### 4.4 handler 抛错进 summary（不阻塞 bootstrap）

```
processEntry(error-handler):
  state?.status !== 'done' → 进 range 判定
  range 满足 → 执行 → throw Error('boom')
  → catch: ledger.handlers['error-handler'] = { status: 'error', ... }
  → summary.errors.push({ id: 'error-handler', message: 'boom', stack? })
  → 继续下一个 handler；最终 run() 返 summary，bootstrap 继续启动
  → BootstrapResult.migrationErrors 透传给 GET /bootstrap/status
```

## 5. 边界

| 零件 | 归属 |
|---|---|
| MigrationManager class（run/processEntry/acquireLock/loadRegistry/readLedger/writeLedger）| 本文件 ✅ |
| ledger schema（MigrationLedger/HandlerState/MigrationSummary 类型 + LEDGER_FILENAME） | 本文件 §2.2 ✅ |
| HandlerEntry + handler registry 静态 import map + MigrationHandlerContext | 本文件 §2.3 ✅ |
| version-range 自实现比较 | 本文件 §3.5 ✅ |
| getAppVersion + gen-version.ts build step | 本文件 §3.4 ✅ |
| bootstrap 接线位置（AppConfigService 后、业务 store 前）| `app/start_up` + `bootstrap.ts:362` |
| `GET /bootstrap/status` HTTP 契约（路径/方法/响应字段）| `specs/api/overall/01-counter.md §6` |
| MigrationErrorModal 视觉/props/testid | `specs/ui/components/framework/migration-error-modal.md` |
| 打包工具链（build-dmg.sh gen-version step + electron-builder files） | `app/package` |

> 变更历史见 [`log.md`](log.md)；跨版本发布说明见 [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)。
