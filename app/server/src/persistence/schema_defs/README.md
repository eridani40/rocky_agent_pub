# schema_defs/ — 实验 fixture

> 性质：**实验 fixture，非正式业务 schema**
> 来源：v0.0.2 persistence 模块 P0（见 `specs/tech/persistence/[P0]overview.md` §7）

## 这个目录放什么

`transcript.ts` 与 `model_config.ts` 是 v0.0.2 为**验证 persistence 机制**（SchemaDef 声明 + InferRecord 类型派生 + 双 engine fs/sqlite 一致性 + CompositeStore 路由）而落地的实验 fixture：

- `transcript.ts`：file engine + 按 `sessionId` 分片 + jsonl 段文件——验证 FS engine 分片 + jsonl 路径。
- `model_config.ts`：无分片，用于 fs 与 sqlite 两 engine 对比测试——验证 engine 可换。

两者仅供本模块自测 / 集成测试消费。

## 这个目录不放什么

**不放正式业务 schema。** 正式业务 schema 归各业务模块自行声明（task.json `scope.out` 明确排除）：

- 正式 `transcript` schema → 归未来 **session** 业务模块。
- 正式 `config` / `model_config` schema → 归未来 **config** 业务模块。

v0.0.2 的 fixture 不承诺长期稳定，业务模块成稿后可能整体替换；本目录不应被 session / config 之外的模块 import。
