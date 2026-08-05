---
type: log
title: Migration KB 变更记录
updated: 2026-07-26
---

# Migration KB 变更记录（ISO 倒序，最新在前）

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-07-26 · v0.0.206（新增 handler：channel-binding-config-id — channel_bindings 落盘 instanceId→configId）

- **背景**：v0.0.206 channel 无状态化重构把 `ChannelBinding.instanceId` 改名 `configId`（store schema `ChannelBindingSchema.fields` 同步改名）。未迁移的存量 binding 记录读不出 `configId`（undefined）→ bootstrap `rebuildReverseIndex` 反向索引全断 → binding 查找/echo 屏蔽/解绑全链断（load-bearing）。
- **handler**（`app/server/src/migration/handlers/channel-binding-config-id.ts`）：扫 `{dataDir}/channel_bindings/*.json` 逐文件读 JSON（fs-store 扁平信封形状）→ 顶层有 `instanceId` 字段才迁：`configId = instanceId` 原值承接 + 删 `instanceId` + `atomicWriteSync` 写回（信封 createdAt/updatedAt/version 不动）；已迁（有 configId 无 instanceId）→ 跳过。
- **幂等**：字段级 marker = 顶层 `instanceId` 存在性（二次运行 no-op 安全重跑；ledger done 主防线语义不变）。**备份**：改前整目录一次性备份到 `{dataDir}/channel_bindings.pre-configid.bak/`（已存在则不覆盖，memory-intro 先例）。**仅迁 active dataDir**（ctx.dataDir，不扫多环境）；handler 内不 catch（throw 由 manager 统一记 ledger error）。
- **registry 扩 1**：`handlers.yaml` + `handlers/index.ts` 静态 map 加 `'channel-binding-config-id'`（`versionRange: '<0.0.207'`——在 0.0.206 release 上跑，off-by-one 对齐 v0.0.203/v0.0.204/v0.0.205 先例：取 '<0.0.206' 会在 0.0.206 release 判 na 永不执行）。
- **迁移边界（用户裁决「改 + 做迁移」）**：
  | 数据 | 迁? | 理由 |
  |---|---|---|
  | `channel_bindings/*.json` 的 `instanceId→configId` | **迁**（本 handler） | 活跃运行时状态：bootstrap 从此建反向索引，不迁就断链；域小（个位数 KV 文件） |
  | `sessions/{sid}/transcript/*.jsonl` 历史 `sender.channel.instanceId` | **不迁** | append-only 不可变历史（INV-S-1）；origin 只对新入站消息实时派生（新消息走新字段），echo 屏蔽不读历史；影响仅前端历史消息来源标签降级 |
  | SSE `origin.instanceId` | **无数据可迁** | origin 是运行时派生字段（deriveOrigin 现算随 message_start 发出），不落盘；改名后新事件即新形状 |
- **UT**：4+1 用例（旧形状→迁后 configId 承接+信封不动 / 已迁 no-op / 重跑幂等 / 备份生成不覆盖 / 空目录 no-op），临时 dataDir（mkdtemp）+ full-record 形状断言。
- **`[P0]migration_manager.md §4.1`**：handlers.yaml 示例更新（registry 已扩至 10 条，示例改「首条 + 最新一条」形态）+ versionRange off-by-one 约定显式化。
- 详情：`specs/tech/version_logs/v0.0.206/change_plan.md`（模块九）

## 2026-07-16 · v0.0.158.compact_model_resolve（新增 2 handler：清 summary 字段族存量）

- **新增 handler**（`app/server/src/migration/handlers/`）：
  - `clean-default-models-summary.ts` → `cleanDefaultModelsSummaryMigration`：读 `appConfig.get('default_models', 'default')` → 若 record 存在且含 `summary` key（`hasOwnProperty` 判定）→ `delete rec.summary` + `appConfig.set('default_models', 'default', rec)` 回写；record 不存在 / 无 summary key → 静默 no-op。
  - `clean-squad-summary-model-default.ts` → `cleanSquadSummaryModelDefaultMigration`：`new SquadStore({root: dataDir}).listSquads()` → 遍历每 squad → 若 record 含 `summaryModelDefault` 或 `summaryModelDefaultProviderId` 任一字段（`hasOwnProperty` 判定）→ 剥信封（createdAt/updatedAt/version）+ `delete` 两字段 + `putSquad` 回写（withFileLock 串行 + version+1）。
- **registry 扩 2**：`handlers.yaml` + `handlers/index.ts` 加两条 entry（全 `versionRange: '<0.0.158'`——仅 ledger `lastAppVersion < 0.0.158` 首次启动时触发；跑完 done 后 applied 主防线永久 skip）。
- **handler 幂等（字段级 marker）**：两 handler 均按字段存在性判定是否需迁；二次运行无字段 → no-op（可安全重跑）。**非破坏性**：只 unset 目标字段，其他字段原样保留（version/updatedAt 由 CrudStore 信封处理）。
- **CrudStore 兼容验证**：`schema-validation.ts::validateRecord` 只按 schema.fields 校验，**不拒收 extra 字段**——handler MUST 在 `putSquad` 前显式 delete 字段（否则回写文件里 summary 字段依然存在，因 spread 透传）；两 handler 已按此实现。
- **UT 覆盖**：两分支 UT（数据存在→字段删净、modelDefault 保留、`set/putSquad` 被调；数据不存在→无更新调用；幂等二次跑无副作用；多 squad 混合分支）；真 store + tmp dataDir + `vi.hoisted` 派生绝对路径（memory `test-vitest-mock-absolute-path` 合规）。
- 详情：`specs/tech/version_logs/v0.0.158.compact_model_resolve/change_plan.md §H`

## 2026-07-15 · v0.0.150 步骤2（合并收编 v0.0.149 memory 迁移为 handler）

- **背景**：worktree 合并 dev1 时，v0.0.149 在 dev1 引入的两处 ad-hoc memory 迁移（`migrate-memory-intro.ts` 手动 CLI + `bootstrap.ts` 内联 source/updated 字段补全）与 v0.0.150 step1「A 决策旧 ad-hoc 全删」冲突——dev1 已有数据触达这两迁移。用户裁决正式收编为 MigrationManager handler（非删 / 非留 ad-hoc），保迁移逻辑持久化进 registry 未来启动期自动幂等执行。
- **收编 2 handler**（`app/server/src/migration/handlers/`）：
  - `memory-intro.ts` → `memoryIntroMigration`：session_memory.md frontmatter + user_memory record.entries[] 的 `description` → `intro` 字段重命名（v0.0.114 存量）。
  - `memory-source-updated.ts` → `memorySourceUpdatedMigration`：两介质补 `source`(缺→'agent') + `updatedAt`(缺→now ISO)（v0.0.149 存量）。
- **registry 扩 3**：`handlers.yaml` + `handlers/index.ts` 静态 map 从 `dummy-update` 单条扩到 3 条（全 `versionRange: '<0.0.151'`）。
- **handler 幂等（字段级 marker）**：两 handler 均扫 raw frontmatter 块 + gray-matter 独立解析，按 per-entry 字段存在性判定是否需迁（parseMemoryFile 投影会填默认值，不能作 marker）；二次运行无字段缺失 → no-op（可安全重跑）。
- **迁移逻辑保真**：两 handler 的介质扫描 + 字段判定 + 非破坏写回（备份 `.pre-intro.bak` / `atomicWriteSync`）均与原 ad-hoc 等价搬入；session_memory.md 块数 ≠ parseMemoryFile 投影 entries 数 → 跳过整个文件（不丢数据）。
- **active dataDir 单环境语义**：handler 仅迁 bootstrap 传入的 `ctx.dataDir`（active 环境），不扫多 dataDir。
- **handler 失败由 manager 统一 catch**：handler 内不 try-catch（原 ad-hoc 顶层 try/catch warn 已移除对齐 spec）；throw 由 `processEntry` catch → 写 ledger `status: 'error'` + 进 `summary.errors` → 透传 `BootstrapResult.migrationErrors`；下次启动 range 仍满足则重试。
- **共享 appConfig**：两 handler 通过 `ctx.appConfig`（AppConfigService 实例，bootstrap 期已初始化）读写 user_memory record，不另起 store。

详情：`specs/tech/version_logs/v0.0.150/change_log.md` §7

## 2026-07-15 · v0.0.150 步骤1（MigrationManager 首版引入）

- **新建 migration KB**：`index.md`（5 章总起 + 9 条核心设计原则）+ `[P0]migration_manager.md`（MigrationManager 主控详细设计）+ 本 `log.md`。
- **核心交付**：
  - `MigrationManager`（`app/server/src/migration/migration-manager.ts`，~290 行）：bootstrap 期启动主控，processEntry 三分支（done skip / na 持久化 / 执行 + done/error）。
  - ledger（`<DATA_DIR>/migration_state.json`）：`{ lastAppVersion, handlers: { [id]: HandlerState } }`，原子写 tmp+rename，不走 CrudStore。
  - handler registry（`handlers.yaml` + `handlers/index.ts` 静态 import map）：仅 `dummy-update`（空操作验证链路）；旧 ad-hoc 迁移一个都不收编。
  - version-range.ts：自实现 `<X.Y.Z` 比较（数字段独立比较，不引 semver 库）。
  - app-version.ts：`__dirname/../../app-version.json`（两级回溯，dev src/migration + packaged dist/migration 都解析到 app/server/app-version.json）。
  - 文件锁：`<DATA_DIR>/migration.lock` 目录 + pid 文件，mkdir 原子 + stale 检测，无新依赖。
  - bootstrap 接线：`bootstrap.ts:362` AppConfigService 之后、业务 store 之前；BootstrapResult.migrationErrors 字段新增。
  - `GET /bootstrap/status` 端点（router.ts，`/health` 同模式）：返 `{ appVersion, lastAppVersion, migrationErrors }`，即使有 errors 仍 200（统一放行）。
  - 前端通道：`fetchBootstrapStatus` 兜底空 errors（不阻塞 UI）+ `MigrationErrorModal`（走 Portal 避 pointer-events 祖先链坑）+ AppShell useEffect 启动拉取。
- **packaged 护栏**：`scripts/gen-version.ts` build/dev 启动前写 `app/server/app-version.json`（gitignore）；`app/server/package.json` 加 `tsc -b && cp -r src/migration/handlers/*.yaml dist/migration/handlers/` 保证 yaml 进 dist；`electron-builder.yml` files 加 `node_modules/@app/server/app-version.json`。
- **旧 ad-hoc 迁移全删（A 决策）**：6 个文件物理删 + 5 处调用点清理（详见 `specs/tech/version_logs/v0.0.150/change_log.md`）。
- **报错通道（C 决策）**：errors 不分级、多错聚合一条，主按钮「确定」+ 次按钮「打开日志目录」（后者本版 noop TODO，无现成 IPC 通道）；i18n 本版硬编码（后端 errors 也是中文，只 localize modal chrome 会 mixed-language，跨版本补完整后端 i18n 时一并）。

详情：`specs/tech/version_logs/v0.0.150/change_log.md`
