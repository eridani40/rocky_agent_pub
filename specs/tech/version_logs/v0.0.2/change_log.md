# v0.0.2 — Tech Spec 变更日志

> 本版本两条并行工作流合并：**A) persistence 模块 P0 落地**（实现驱动，来自 dev1）；**B) config / plugin_system / providers 设计稿收口**（设计驱动，来自 specs_v0.0.2）。

---

## A. Persistence 模块 P0 落地（实现驱动）

# v0.0.2 — Persistence Tech Spec 变更日志

> 版本范围：v0.0.2（persistence 模块 P0 落地）
> 创建：2026-06-19 · 架构阶段
> 基线：v0.0.1（无 persistence tech spec，persistence 为本版本新增模块）
> 跳过 PRD：persistence 无产品体验（无用户/UI/交互），经用户判断直接由 tech spec 驱动（见 task.json `prdSkipped`）

## 1. 本版本要实现的 P0 范围

persistence 是 Agent 框架的数据落地基座（内部库，无 HTTP API / UI 暴露）。v0.0.2 实现：

- **SchemaDef 声明层**：`SchemaDef` / `FieldDef` / `IndexDef` / `FsStorageConfig` 类型 + `InferRecord<S>` 类型派生 + 校验语义 + 错误类型，落在 `app/server/persistence/`。
- **CrudStore 契约层**：`CrudStore` 接口（put/get/query/delete）+ `StoredRecord` 信封（createdAt/updatedAt/version）+ `PutOptions` + `QueryFilter` + 错误类型 + `CompositeStore`（按 entity 寻址）。
- **FS engine**（`FsCrudStore`）：扁平目录 + 分片（shardKey 路由）+ json/jsonl 段文件 + 原子写 + query（单 shard / scatter）。
- **SQLite engine**（`SqliteCrudStore`，基于 `bun:sqlite`）：blob-first（data JSON + 信封列）、事务、id 全局索引、`json_extract` engine 专有扩展。
- **schema_defs/**：`transcript.ts`（file + 按 sessionId 分片 + jsonl）+ `model_config.ts`（无分片，fs + sqlite 两 engine 对比，验证 engine 可换）作为实验 fixture。
- **测试**：UT（白盒）+ 集成测试（真实 fs/sqlite 落盘），用例反哺 `tests/`。AT/ET 不适用（无 HTTP API/UI）。

P0 spec 文件（已存在、本版本修订）：`specs/tech/persistence/` 6 份（overview / schema_interface / crud_store_interface / fs_crud_store_engine / sqlite_crud_store_engine / [P1]search_engine 占位）。

## 2. 本版本对 tech spec 的修订（用户授权 4 处）

persistence spec 在 v0.0.1 之后成稿，v0.0.2 架构阶段做执行性修订（不重新设计）：

### 2.1 collection → entity 全局统一

- `SchemaDef.collection: string` → `SchemaDef.entity: string`（字段重命名；entity = 实体/schema 标识，同时是底层集合名：FS 目录名 / SQLite 表名）。
- CompositeStore 路由依据：`schema.collection` → `schema.entity`。
- 6 份 spec 所有文档措辞 collection → entity（标题、概述、决策、示例、注释、心智模型图、边界表）。
- **术语厘清**：在 schema_interface.md §1 加一段说明——entity 指实体/schema 标识（`SchemaDef.entity` 字段值，如 `"transcript"`），一条记录（record）是该 entity 的实例，避免「entity（标识）」与「record（实例）」混淆。

涉及文件：`[P0]overview.md`、`[P0]schema_interface.md`、`[P0]crud_store_interface.md`、`[P0]fs_crud_store_engine.md`、`[P0]sqlite_crud_store_engine.md`（含 `<coll>` SQL 占位符 → `<entity>`）、`[P1]search_engine.md`（寻址 `collection + recordId` → `entity + recordId`）。

### 2.2 路由措辞统一为「按 entity 寻址, engine 由 schema.engine 决定」

- 消除「按 engine 路由」与「按 collection 路由」的措辞分歧。
- 统一表述：**CompositeStore 按 entity 寻址到已挂载 engine 实例，挂载关系（哪个 entity 用哪个 engine）由 `schema.engine` 决定**。
- 涉及位置：overview.md §2 心智模型 + §5 关键决策、crud_store_interface.md §3.4 标题与结论 + §4 示例注释。明确「调用点无需、也不允许指定 engine」。

### 2.3 FS engine root/dirTemplate 拼接规则

- 明确：**root 是基目录**（如 `./data`）；**dirTemplate 是相对 root 的分片路径模板**（如 `sessions/{shardKey}/`）；sharding 时按 dirTemplate 把 `{shardKey}` 替换后 redirect 到分片路径；engine 老实拼接 root + dirTemplate(已替换) + entity + 文件，**不自作主张加前缀**（「配什么就是什么」）。
- 修 crud_store_interface.md §4 示例：去掉 `new FsCrudStore({ root: "./data/sessions" })` 让 dirTemplate 的 `sessions/` 段重复的写法；统一 root 为基目录（如 `./data`），分片路径完全由 dirTemplate 决定。
- 涉及位置：fs_crud_store_engine.md §2 目录布局（含拼接规则小节）+ §3.1、crud_store_interface.md §4 示例。

### 2.4 id 校验错误归类

- schema_interface.md §2.4 校验表的「主键存在」一行拆为两条：
  - **缺 id（record 无 id 字段）→ `PrimaryKeyMissingError`**
  - **id 存在但非合法 ULID 格式 → `SchemaValidationError`**
- 与 crud_store_interface.md §2.4 错误类型表一致：`PrimaryKeyMissingError` 注释从「record 缺主键或非合法 ULID」澄清为「record 缺 id 字段」；`SchemaValidationError` 注释补「含 id 非合法 ULID」。

## 3. 关键决策（来自 task.json keyDecisions，spec 已落实）

| 决策 | 取值 | spec 落点 |
|---|---|---|
| 命名 | collection → entity 全局统一；SchemaDef 含 engine 字段 | 全部 6 份 |
| schema 格式 | TS SchemaDef（`as const satisfies SchemaDef`）+ InferRecord，非 JSON | schema_interface §1/§2.3 |
| schema 位置 | `app/server/persistence/schema_defs/`（server 内部），不进 protocols | overview §7、scope |
| engine payload | put 传 native 强类型 plain object（InferRecord 派生） | crud §2.2 |
| id 策略 | id 业务生成；信封 store 注入；缺 id→PrimaryKeyMissingError，ULID 非法→SchemaValidationError | schema §2.4、crud §2.4 |
| engine 路由 | 按 entity 寻址，挂载关系由 schema.engine 决定；engine 参数从 ENV 读不读 config | crud §3.4、overview §5 |
| fs 布局 | root 为基目录，dirTemplate 相对 root 的分片模板，不自加前缀 | fs §2 |
| 实验实体 | transcript(file+按 sessionId 分片+jsonl)；model_config(无分片, fs+sqlite 对比) | schema §4、fs §6 |

## 4. scope 覆盖核对

| task.json scope.in | 覆盖 spec | 状态 |
|---|---|---|
| SchemaDef/FieldDef/IndexDef/FsStorageConfig + InferRecord + 校验 + 错误类型 | schema_interface §2 / §2.3 / §2.4 + crud §2.4 | ✅ |
| CrudStore 接口 + StoredRecord 信封 + PutOptions + QueryFilter | crud §2.1 / §2.2 / §2.3 | ✅ |
| FsCrudStore 扁平 + 分片 + json/jsonl + query | fs_crud_store_engine §2 / §3 / §4 | ✅ |
| SqliteCrudStore bun:sqlite + blob-first + 事务 + id 索引 + json_extract | sqlite_crud_store_engine §2 / §3 / §4 / §5 | ✅ |
| CompositeStore 按 schema.entity 路由 | crud §3.4（已修订） | ✅ |
| schema_defs/ transcript.ts + model_config.ts | schema_interface §4 示例（coder 按 §4 写法实现） | ✅ |
| 实验：transcript 分片 jsonl + model_config fs/sqlite 对比 | fs §3.1 + §6、sqlite §3 + §6 | ✅ |
| UT + 集成测试 + 反哺 tests/ | （属 verify 层，非 tech spec） | N/A |

**缺口**：无。

## 5. 内部一致性自查

- ✅ `collection` 字段名 → `entity`：6 份 spec 全部迁移，无残留（grep 验证：除变更说明文本外无残留 `schema.collection` / `collection:` / `按 collection` / `<coll>`）。
- ✅ 路由措辞：统一为「按 entity 寻址, engine 由 schema.engine 决定」，无「按 collection 路由」或「按 engine 路由」残留。
- ✅ PrimaryKeyMissingError：crud §2.4 与 schema §2.4 归类一致（缺 id → PrimaryKeyMissingError；id 非法 ULID → SchemaValidationError）。
- ✅ fs 拼接规则：fs §2 与 crud §4 示例一致（root 为基目录，dirTemplate 相对 root，不自加前缀）。
- ✅ 单文件行数：全部 ≤ 300（最大 211 行）。

## 6. 跨模块一致性提示（仅报告，本版本不改）

persistence 之外的模块 spec（config / session / plugin_system 等）若也引用过 persistence 的「collection」概念，建议后续版本统一改为「entity」。本版本仅改 persistence 模块自身 spec，不动其他模块。

## 7. 版本

version: v0.0.2 · persistence tech spec change log

---

## 8. doc 同步：coder/reviewer 阶段发现的实现层偏差（doc-modifier 阶段 5 补录）

> 时机：所有 task verified（UT + 集成 175/175 绿）后，doc-modifier 阶段 5 同步。
> 范围：仅记录实现层决策与 spec 修订点，不改架构决策。

### 8.1 错误类型补字段（spec：crud_store_interface §2.4）

- **VersionConflictError 补 `id` 字段**：spec 原写 `{expected, actual}`，实现加 `id`（实现 `app/server/src/persistence/errors.ts:72-95`）。理由：engine 算信封前已 `readMeta` 拿到 existing，把冲突 id 一并带出，便于 engine / 上层定位记录。
- **RecordExistsError / RecordNotFoundError 同补 `id`**：对称补全，便于调用方定位。
- **新增 EntityNotMountedError `{ entity }`**：CompositeStore 收到未挂载 entity 抛此错（`composite.ts:route()` + `errors.ts:106-118`）。spec 原 §3.4 仅说「抛错」未指定类型，本次明确为独立错误类型——mount 漏配是启动期典型错误，独立类型比泛用 RecordNotFoundError 更易定位。

### 8.2 sqlite engine 实现选型与 spec 措辞软化（spec：sqlite_crud_store_engine §4/§5）

- **upsert 实现**：spec §4 写 `INSERT...ON CONFLICT(id) DO UPDATE`；实现选「首次 INSERT / 已存在 UPDATE」两步（`sqlite-store.ts:put` + `sqlite-rows.ts:execUpsert`）。理由：engine 在算信封前已 readMeta 拿到 existing，分支已知 insert/update，无需 ON CONFLICT 兜底。spec 措辞软化：两种等价，实现选两步、ON CONFLICT 为备选。
- **delete 返回值**：spec 写 `changes()` 判断；实现用「先 selectRow 查存在性再 DELETE」。返回值语义一致（实际删了一行才 true），spec 标注两种实现等价、不强制其一。
- **事务 DDL 回滚**：bun:sqlite `db.transaction()` 实测把事务内 DDL（如 CREATE TABLE）也纳入回滚范围——事务内建表 + 抛错后表不存在（已有集成测试覆盖）。spec §5 补一句说明，engine 无需额外规避可幂等 DDL。

### 8.3 fs-jsonl 段名更新（spec：fs_crud_store_engine §3.4）

- 乱序回填（新 id 落在段首）或删段首行后，段名需更新为新首条 ULID（删旧段文件、写新段名文件），保证「段名 = 段首条」不变式。实现 `fs-jsonl.ts:jsonlPut` 插入分支 137-144 行 + `jsonlDelete` 197-205 行。spec §3.4 补此副作用说明。

### 8.4 test 脚本改 bun --bun（spec：tool_chain §2.2 + package_structure §4.1）

- 根 `package.json` 的 `scripts.test` 从 `npx vitest run` 改为 `bun --bun x vitest run`。原因：`bun:sqlite` 仅 bun runtime 可用（无 `@types`、node 不可用），必须强制 bun runtime 跑测试。
- 功能仍是 `vitest run`（vitest 入口、断言、配置不变），对开发者透明，`bun run test` 仍是唯一入口。
- package-boundaries 测试中曾断言脚本严格等于 `npx vitest run`，本次同步放宽为正则 `/vitest run$/`（容忍外层 runtime wrapper）。

### 8.5 bun:sqlite 类型 shim（spec：package_structure §3.3）

- server 的实验性 persistence 子模块（SQLite engine）用 `bun:sqlite`。处理方式：
  - server `tsconfig.json` `types` 仍为 `["node"]`（不变）——`bun:sqlite` 无 `@types`，server 自带本地 shim 类型声明 `app/server/src/persistence/bun-sqlite-shim.d.ts`（手写 `declare module 'bun:sqlite'`），让 tsc 在 node types 下也能类型检查。
  - runtime 必须是 bun（packaged Electron 不消费 sqlite engine，v0.0.2 实验库仅 bun 环境跑）。
- 这不破坏「server 零 electron 依赖」——electron 与 bun:sqlite 是两个不同 runtime 假设，前者禁止（装配耦合），后者允许（仅 sqlite engine 子模块依赖、隔离在 persistence 内）。

### 8.6 schema_defs/ 实验 fixture 性质（spec：overview §7 + schema_defs/README.md）

- 明确 `app/server/src/persistence/schema_defs/transcript.ts` 与 `model_config.ts` 是 v0.0.2 验证 persistence 机制的**实验 fixture**，非正式业务 schema；正式 transcript → session 模块、config → config 模块。
- 新增 `schema_defs/README.md` 标注 fixture 性质，警告不应被 session/config 之外的模块 import。

### 8.7 涉及 spec 文件 + 版本 bump

| spec 文件 | bump | 内容 |
|---|---|---|
| `specs/tech/persistence/[P0]crud_store_interface.md` | 1.1→1.2 | §2.4 错误类型补 id / 新增 EntityNotMountedError；§3.4 未挂载错误说明 |
| `specs/tech/persistence/[P0]sqlite_crud_store_engine.md` | 1.1→1.2 | §4 upsert 两步 + ON CONFLICT 备选；delete 两种实现；§5 DDL 在事务内回滚 |
| `specs/tech/persistence/[P0]fs_crud_store_engine.md` | 1.1→1.2 | §3.4 段名更新副作用 |
| `specs/tech/persistence/[P0]overview.md` | 1.1→1.2 | §7 schema_defs fixture 性质 |
| `specs/tech/app/package/[P0]package_structure.md` | 1.1→1.2 | §3.3 bun:sqlite 例外；§4.1 scripts.test 改 bun --bun |
| `specs/tech/app/package/[P0]tool_chain.md` | 1.0→1.1 | §2.2 scripts.test 变更说明；package-boundaries 断言放宽 |

未改：`specs/tech/persistence/[P0]schema_interface.md`（实现与 spec 一致，无需修订）、`[P1]search_engine.md`（占位）。

---

## B. config / plugin_system / providers 设计稿收口（设计驱动）

# Tech 版本变更日志 - v0.0.2（config 模块收口融合）

> 主题：把 plugin_system 的 ConfigBackend 并入 config 模块成为 PluginConfigService，删掉 plugin_system 那边的 config 文件，plugin_system 只引用 config 的模型。

## 变更概要

| 类型 | 文件 | 变更 |
|------|------|------|
| 删除 | `plugin_system/[P0]config_backend_interface.md` | git rm；全部职责并入 config 模块 |
| 新增 | `config/[P0]plugin_config_service.md` | `PluginConfigService` 契约（吸收原 ConfigBackend 全部方法）+ overlay/增量模型核心原则 + per-domain 默认表 + PluginManager 直读 store 不调 service 的读路径说明 |
| 改 | `config/[P0]overview.md` (→1.3) | 新增「服务层」节（3 个 service：AppConfigService / DevConfigService / PluginConfigService）+ 「核心原则：overlay/树满数据稀疏」节 + HTTP facade 归 specs/api 一节；§3 关系图补 PluginConfigService 依赖 plugin_system(树)+persistence(状态) |
| 改 | `config/[P0]plugin_config.md` (→1.2) | 值面 vs 管理面关系改指 PluginConfigService；数据形状（PluginConfigRecord/PointConfigRecord/ImplConfigRecord）保留不动 |
| 改 | `config/[P0]app_config.md` (→2.1) | 末尾新增 §5 AppConfigService（通用 KV get/set，底经 CrudStore） |
| 改 | `config/[P0]dev_config.md` (→2.1) | 末尾新增 §7 DevConfigService（通用 KV get/set；缺省→代码默认由消费方 `?? CODE_DEFAULT`，service 不域特化） |
| 改 | `plugin_system/[P0]overview.md` (→1.3) | §2.5 三角色 ConfigBackend→PluginConfigService（标注已并入 config 模块）；§4 文件地图删 config_backend 行；§3 数据流「config_backend 可见性」→「PluginConfigService（config 模块）可见性」 |
| 改 | `plugin_system/[P0]plugin_manager_interface.md` (→1.3) | §1 active 投影补「PluginManager 直接读 store 不调 PluginConfigService」；§3.4 静态注册可见性决策指向 config 模块 PluginConfigService |
| 改 | `plugin_system/[P0]extension_point_interface.md` (→1.3) | selectExclusive / setPriority / point config 持久化指向 config/[P0]plugin_config_service.md |
| 改 | `plugin_system/[P0]contribution_and_manifest_interface.md` (→1.2) | §3.5 config 值注入指向 PluginConfigService setConfig/setImplConfig |
| 改 | `plugin_system/[P1]plugin_lifecycle.md` | 激活计划读 PluginConfigService 策略；§3.5 next-get 生效指向 config §4.5 |
| 改 | `plugin_system/[P1]isolation_and_threat_model.md` | 来源标签与启用策略指向 config PluginConfigService |
| 改 | `plugin_system/[P1]discovery_and_install_interface.md` | 启用/信任策略消费指向 config PluginConfigService |
| 改 | `deps.md` | 板块 8 描述去掉 ConfigBackend；10→8 边改为「取树结构」；config↔plugin 双向边注记「PluginConfigService 已并入 config 模块」；关键证据文件指向 plugin_config_service §4.4 |
| 改 | `persistence/[P0]overview.md` §7 | 与 plugin_system 边界补 config 模块；原 config_backend_interface 引用 → plugin_config_service |
| 改 | `todo.md` | ConfigBackend → PluginConfigService（config 模块） |

## 核心原则成文（首次写入 specs）

1. **overlay / 增量模型（核心原则）**：有效状态 = 代码默认 ⊕ 数据增量。树满（代码定存在性）、数据稀疏（只存 delta）、未配置走默认。写入 config/[P0]overview.md §6 + plugin_config_service.md §3。
2. **PluginManager 直读 store 不调 PluginConfigService**：PluginConfigService 是写/管理面 + inventory；PluginManager 持有 active-set 逻辑直读 CrudStore。写入 plugin_manager_interface.md §1 + plugin_config_service.md §1。
3. **HTTP facade 归 specs/api**：3 个 service 是逻辑层，1 个 facade 按 3 域分路由。写入 config overview §7（本批不定义端点）。

## grep 核验

`grep -rn "config_backend\|ConfigBackend" specs/tech/` 残留全部为迁移注释（"吸收原 ConfigBackend / 原 config_backend 已并入 config 模块"），无任何指向已删文件的失效引用。

## 文件清单（config 目录）

```
config/
├── [P0]app_config.md              (v2.1, +AppConfigService)
├── [P0]dev_config.md              (v2.1, +DevConfigService)
├── [P0]overview.md                (v1.3, +服务层/overlay/HTTP facade)
├── [P0]plugin_config.md           (v1.2, 数据形状保留)
└── [P0]plugin_config_service.md   (v1.0, 新增管理面)
```
