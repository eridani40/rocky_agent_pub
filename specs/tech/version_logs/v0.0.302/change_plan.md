# v0.0.302 变更计划书 — KV 配置读缓存 + Transcript jsonl 追加优化

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 上游权威源

- 需求 `reqs/[working] v0.0.302/req.md`（纯技术改动，跳 PRD）
- KvConfigService `specs/tech/config/[P0]app_config.md` §5（AppConfigService）
- FsCrudStore jsonl engine `specs/tech/persistence/[P0]fs_crud_store_engine.md` §3.2-§3.5

## 核心事实（架构核对结论，落行前已 grep/读代码验证）

- `KvConfigService`（kv-config-service.ts:31-150）是抽象基类，持有 `schema: SchemaDef` + `store: CompositeStore`。get/listGroup/set/setGroup/delete 全部经 `store.query({ shardKey: group })` 做磁盘扫描。**零缓存**。
- `get()` (L52-55) → `findRecord()` (L61-63) → `store.query(this.schema, { shardKey: group })` → `FsCrudStore.query` → `collectAll` → `scanEntityDir` → `jsonlQuerySegments`：readdirSync 段目录 + 逐段 readFileSync + JSON.parse 每行。**每次 get = 一轮全量同步磁盘扫描**。
- `LogWriter.write` (log-writer.ts:77) 每写一条日志先 `this.appConfig.get('logs', TYPE_TO_KEY[type])` 查开关 → 触发上述全量扫描。squad 活跃期日志洪水 = 风暴放大器。
- 8s profile：5311 个 readFileUtf8 采样，99.2% 来自 `kv-config-service.get`。
- `set()` (L87-93) / `setGroup()` (L131-149) / `delete()` (L108-113) 全部先 query 再写（store.put / store.delete），写后不维护任何缓存。
- `jsonlPut`（fs-jsonl.ts:88-145）有两条路径：
  - **append 尾段**（L106-114）：id > maxId 时，读整个尾段 `readSegment` → `push` → `writeSegment` 整段重写。**这就是 6MB 段文件每次追加 = 整段读+重写的根因**。
  - **乱序回填**（L117-144）：id < maxId 时，二分定位段 + 读段 + 插入 + 重写。**本路径不变**（必须读+重写以保持段内有序）。
- transcript/message schema `format: 'jsonl'`, `jsonlMaxCount: 1000`（message.ts:38-39）。会话追加消息走 append 尾段路径。
- `writeSegment` (L47-50) 用 `atomicWriteSync`（fs-io.ts 原子写覆盖）。
- `listSegmentIdsSync` (fs-io.ts) = `readdirSync` 段目录 + 过滤 `.jsonl` + 排序。

## 决策一览（每条在下表落行）

| # | 决策点 | 结论 | 理由 |
|---|---|---|---|
| D1 | 缓存加在哪一层 | **KvConfigService 层**（不在 FsCrudStore / CompositeStore 底层） | 底层 engine 是通用 CRUD，缓存是 KV 语义层的职责；在底层加会污染所有 entity 的读写路径 |
| D2 | 缓存数据结构 | `Map<group, Map<key, data>>`（二级 Map） | group 是分片键，一次 query 填充整个 group 的全部 key（因 findRecord 本身就是 query group 再过滤）；二级 Map 支持 O(1) get 和 group 级失效 |
| D3 | 缓存填充策略 | **lazy fill**：get 首次 miss 整个 group → query → 填充该 group 的全部 key→data；后续 get 直接命中 | listGroup 已有的 query 逻辑直接复用；一次 query 填全 group 避免逐 key 查 |
| D4 | 缓存失效策略 | **write-through invalidate**：set/setGroup/delete 后删除该 group 的缓存条目（整 group 失效，下次 get lazy 重填） | 简单可靠；group 内 record 数极少（logs 组 ~7 个开关），整组失效代价可忽略 |
| D5 | T2 只动 append 尾段路径 | jsonlPut L108-110 尾段未满时改 `appendFileSync` 追加一行；尾段满（L111-112）和乱序回填（L117-144）不变 | append 路径是热点（transcript 消息追加几乎总是 id 递增）；乱序回填需保持段内有序，不能纯 append |
| D6 | append 路径尾段信息获取 | **模块级尾段缓存** `Map<dir, {segName, count, maxId}>`：热路径命中缓存零读文件（直接 appendFileSync + 更新缓存计数/maxId）；miss（冷启动/首次写该 dir）回退 readSegment 读一次填缓存；乱序回填/段轮转清缓存条目 | D6 旧方案（readFileSync 全量 + split）虽省了 JSON.parse 但 I/O 读全量没省——leader 指出。模块级缓存让连续追加的热路径完全不读文件，只有冷启动首次读一次 |

### T2 方案修正（D6 细化 — 模块级尾段缓存）

分析 append 尾段路径需要的三个信息：
1. `maxId`（判断走 append vs 乱序回填）
2. 尾段行数（判断是否满，满则 roll 新段）
3. 段文件路径（append 目标）

**模块级尾段缓存** `tailCache: Map<dir, { segName: string; count: number; maxId: string }>`：

- **命中缓存（热路径）**：id > cache.maxId → 直接 `appendFileSync` + count++ + maxId 更新；count 达 maxCount → 新开段 + 重置缓存
- **miss（冷启动/首次）**：回退原 readSegment 读尾段（全量读+parse 一次），填缓存后后续命中
- **失效时机**：乱序回填路径（id < maxId）或段删除 → `tailCache.delete(dir)`（下次 jsonlPut 重新冷填充）
- **无持久化**：进程级内存 Map，重启自动冷填充（安全回退到读文件）

热路径性能：连续追加消息（transcript 主场景）= **零读 + O(1) append**，从 O(n) 全量读写降为零读一行写。

## 变更计划表

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| config | app/server/src/config/kv-config-service.ts | KvConfigService (class) | 修改 | 新增 `private cache: Map<string, Map<string, unknown>>` 实例字段（二级 Map：group → key→data） | MUST 在 constructor 后初始化为空 Map | req.md T1；D2 | +1 |
| config | app/server/src/config/kv-config-service.ts | get() | 修改 | 先查缓存（`cache.get(group)?.get(key)`）；miss 则 `ensureGroupCache(group)` 填充整 group 后再取 | MUST 命中缓存时不触发任何 fs 操作（store.query）；MUST NOT 绕过缓存直接 findRecord | req.md T1；D3 | +8/-3 |
| config | app/server/src/config/kv-config-service.ts | listGroup() | 修改 | 先 `ensureGroupCache(group)` 填充（如未缓存），再从缓存 Map 构建 `[{key, data}]` 返回 | MUST 命中缓存时不触发 store.query | req.md T1；D3 | +5/-3 |
| config | app/server/src/config/kv-config-service.ts | ensureGroupCache() | 新增 | 私有方法：query group 全部 record → 构建 `Map<key, data>` → 填入 `cache.set(group, map)`；如 group 无 record 填空 Map（区分「未缓存」与「已缓存但空」） | MUST NOT 对已缓存 group 重复 query（缓存判定用 `cache.has(group)`）；返回该 group 的 Map | D3；findRecord 既有逻辑 | +10 |
| config | app/server/src/config/kv-config-service.ts | findRecord() | 修改 | 改为经 `ensureGroupCache` 从缓存取 record（而非直接 store.query）；保留 key 匹配逻辑 | set/delete 内部调用 findRecord 仍能正确工作（经缓存） | 既有 L61-63 | +3/-2 |
| config | app/server/src/config/kv-config-service.ts | set() | 修改 | 写入 store.put 后调 `invalidateGroup(group)` 失效缓存 | MUST 写后失效（缓存与磁盘一致） | req.md T1；D4 | +2 |
| config | app/server/src/config/kv-config-service.ts | setGroup() | 修改 | 写入全部 items 后调 `invalidateGroup(group)` 失效缓存 | MUST 写后失效 | req.md T1；D4 | +2 |
| config | app/server/src/config/kv-config-service.ts | delete() | 修改 | store.delete 后调 `invalidateGroup(group)` 失效缓存 | MUST 删后失效 | req.md T1；D4 | +2 |
| config | app/server/src/config/kv-config-service.ts | invalidateGroup() | 新增 | 私有方法：`this.cache.delete(group)` | 简单删除整 group 缓存条目，下次 get lazy 重填 | D4 | +3 |
| persistence | app/server/src/persistence/fs-jsonl.ts | tailCache (module-level) | 新增 | 模块级 `Map<dir, { segName: string; count: number; maxId: string }>` 尾段缓存：热路径命中缓存零读文件直接 append + 更新缓存；miss 时回退 readSegment 读一次填缓存 | MUST 无持久化（进程级内存，重启自动冷填充安全回退）；乱序回填/段删除后 MUST 清缓存条目 | req.md T2；D6 | +8 |
| persistence | app/server/src/persistence/fs-jsonl.ts | jsonlPut() | 修改 | append 尾段路径优化：命中 tailCache 时直接 `appendFileSync(segPath, line + '\n')` + 更新缓存 count/maxId（零读零重写）；miss 时回退 readSegment 读一次再填缓存 + append；尾段满则 writeSegment 新开段 + 重置缓存；乱序回填路径（L117-144）不变但末尾加 `tailCache.delete(dir)` 失效缓存 | MUST NOT 改乱序回填的核心逻辑；MUST 保持段文件格式不变（每行 JSON + 末尾换行）；命中缓存时 MUST NOT 调 readFileSync | req.md T2；D5/D6 | +20/-8 |
| persistence | app/server/src/persistence/fs-jsonl.ts | appendSegmentLine() | 新增 | 私有辅助函数：`fs.appendFileSync(segPath, JSON.stringify(row) + '\n')` | MUST 用追加模式（appendFileSync 默认 flag='a'）；MUST NOT 读旧内容 | D5 | +5 |

## T1 缓存读写时序（审查参照）

```
get('logs', 'enableLlmRequestLog')
  → cache.has('logs')? 
    YES → cache.get('logs').get('enableLlmRequestLog')  // O(1)，零 fs
    NO  → ensureGroupCache('logs')
          → store.query(schema, {shardKey: 'logs'})     // 首次 fs 扫描
          → 构建 Map<'enableLlmRequestLog', data> ...
          → cache.set('logs', map)
          → 返回 map.get('enableLlmRequestLog')

set('logs', 'enableLlmRequestLog', true)
  → findRecord('logs', 'enableLlmRequestLog')           // 经缓存取（命中则零 fs）
  → store.put(...)
  → invalidateGroup('logs')                              // cache.delete('logs')
  → 下次 get → ensureGroupCache → query → 填充新缓存
```

## UT 要求

### T1 UT（kv-config-service 缓存）
- **缓存命中**：首次 get 触发 store.query（spy/mock 计数）；第二次 get 不触发 store.query
- **set 后失效**：get 填缓存 → set 写入 → 再 get 触发新 query（缓存已失效）
- **delete 后失效**：get 填缓存 → delete 删除 → 再 get 触发新 query

### T2 UT（jsonlPut append 路径）
- **追加不读旧内容**：mock fs 验证 append 尾段路径只调 appendFileSync，不调 readFileSync 读旧段全文（或验证 readFileSync 仅用于行计数，不 JSON.parse 全部行）
- **段文件格式不变**：追加后段文件每行一条 JSON + 末尾换行（读取侧 jsonlGet/jsonlQuerySegments 正常解析）

## 文件级变更清单

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| app/server/src/config/kv-config-service.ts | 修改 | 加 cache 字段 + ensureGroupCache/invalidateGroup 方法；get/listGroup/findRecord 走缓存；set/setGroup/delete 写后失效 |
| app/server/src/persistence/fs-jsonl.ts | 修改 | jsonlPut append 尾段路径改纯 appendFileSync + 轻量行计数；加 appendSegmentLine 辅助函数 |
| app/server/src/config/\_\_tests\_\_/kv-config-service.test.ts | 新增 | T1 缓存命中/失效 UT |
| app/server/src/persistence/\_\_tests\_\_/fs-jsonl-append.test.ts | 新增 | T2 追加不读旧内容 UT |
