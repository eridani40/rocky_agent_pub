---
type: interface
title: Panorama 迁移引擎
priority: P1
status: active
updated: 2026-07-22
since: v0.0.189.dsl_board
related: [[P1]panorama_validation.md, [P1]panorama_store.md, [P1]panorama_dsl.md]
---

# Panorama 迁移引擎（增量自动 / 破坏性须方案 + 审计 + 备份）

> 定位：DSL 更新时，引擎自动判定变更类型（增量 vs 破坏性），增量自动生效，破坏性须 agent 提交 migration 方案 + 审计日志。
> 凝练自 `specs/research/v0.0.189.dsl_board/panorama_migration.md`（去调研口吻改现状）。

## 1. 变更分类总表

| 分类 | 变更类型 | 引擎行为 | 需迁移方案 | 用户介入 |
|------|----------|----------|------------|----------|
| **增量** | 加实体/字段/视图/状态机/display/transition出边/放宽约束 | 自动生效 | ❌ | ❌ |
| **增量** | 扩 enum（加值） | 自动生效 | ❌ | ❌ |
| **破坏性** | 删实体（有数据） | 拒绝 | ✅ | ⚠️ 重大 |
| 破坏性 | 删字段（有非空值） | 拒绝 | ✅ | ⚠️ 重大 |
| 破坏性 | 收窄 enum（有存量值） | 拒绝 | ✅ | ⚠️ 重大 |
| 破坏性 | 改字段类型（有实例） | 拒绝 | ✅ | ⚠️ 重大 |
| 破坏性 | 改 states.field（有实例） | 拒绝 | ✅ | ⚠️ 重大 |
| 破坏性 | 扩大 terminal（有锁定存量） | 拒绝 | ✅ | ❌ 次要 |
| 破坏性 | 收紧约束（有违规存量） | 拒绝 | ✅ | ❌ 次要 |
| 破坏性 | 改 group_by 目标 | 自动生效（视图层，不影响数据） | ❌ | ❌ |
| 破坏性 | 删 transition 出边（无存量依赖） | 自动生效 | ❌ | ❌ |

判定在 define 的 Layer 4（数据安全层）自动执行。增量 = Layer 4 通过；破坏性 = Layer 4 报 error。

## 2. 增量变更（自动生效）

agent 直接 `define(new_dsl)`，引擎检测差异属增量类，自动落盘 + 写审计日志。

### 2.1 加字段时存量实例处理

存量实例新字段自动补 `null`（惰性：文件不动，读取时用 DSL 补默认值）。引擎不批量回写。审计日志记录 `change.kind=field_added`。

### 2.2 加状态机时存量实例处理

存量实例：引擎检查是否有同名字段（如 `status`），有则校验值在新的 enum values 内；无则在审计日志记 warning（存量实例缺状态字段，建议补值）。

## 3. 破坏性变更（须迁移方案）

### 3.1 迁移方案提交格式

agent 在 `define` 时附带 `migration` 参数：

```typescript
interface DefineParams {
  dsl: string;
  dryRun?: boolean;
  migration?: MigrationPlan;       // 破坏性变更时建议提交；缺省引擎自动生成默认 plan（planMigration）
  approved?: boolean;              // 重大变更需 user 点头
}

interface MigrationPlan {
  operations: MigrationOperation[];
}

interface MigrationOperation {
  operation: string;              // delete_entity / delete_field / narrow_enum / change_field_type / change_state_field / expand_terminal / tighten_constraint
  target: { entity: string; field?: string };
  from?: unknown;
  to?: unknown;
  handler: {
    strategy: string;             // archive / purge / drop / mapping / default / transform
    mapping?: Record<string, unknown>;
    default_value?: unknown;
    transform?: string;
  };
}
```

### 3.2 handler 策略

| strategy | 适用 operation | 行为 |
|----------|---------------|------|
| `archive` | delete_entity / delete_field | 归档存量到 `.archive/` 或实例 `_archived` 字段 |
| `purge` | delete_entity | 物理删除存量数据 |
| `drop` | delete_field | 丢弃字段值 |
| `mapping` | narrow_enum | 值映射表：`{old_value: new_value}` |
| `default` | change_field_type / narrow_enum | 设默认值 |
| `transform` | change_field_type | 变换表达式（白名单：`parseFloat` / `parseInt` / `toString` / `toLowerCase` / `toUpperCase` / `trim`，可链式） |
| `clip` | tighten_constraint | number 值截断到 min/max 约束范围 |

全部 strategy 幂等（已在目标集 / 已删 / 已转换 = no-op，支持中断恢复重放）。

## 4. 用户介入门槛

| 级别 | 标准 | 机制 |
|------|------|------|
| **重大** | 数据丢失/不可逆/影响业务语义 | 引擎返 `panorama_breaking_change_requires_approval`，agent 转达用户，用户确认后 agent 附 `approved: true` 重提 |
| **次要** | 可逆/范围可控/agent 可自决 | agent 提交 migration 即可，不需用户确认 |

**重大变更**：删实体（有数据）/ 删字段（有非空值）/ 收窄 enum（有存量值）/ 改字段类型 / 改 states.field。
**次要变更**：删 transition 出边（无依赖）/ 扩大 terminal / 收紧约束（少量违规）/ 删实体（无数据）/ 删字段（全 null）/ 删视图。

### 4.1 介入流程

```
agent define(new_dsl, migration)
  → 引擎跑 Layer 1-3（全过）
  → 引擎跑 Layer 4（有破坏性变更）
    ├─ 次要 → 执行 migration → 落盘 → 审计
    └─ 重大 → 返 panorama_breaking_change_requires_approval + 变更清单 + 迁移预览
              → agent 转达用户
                ├─ 用户确认 → define(new_dsl, migration, approved:true) → 执行 → 落盘 → 审计
                └─ 用户拒绝 → agent 放弃/修改方案
```

### 4.2 dryRun 预检

agent 可先 `define(new_dsl, dryRun:true, migration:plan)` 预检：引擎跑 Layer 1-4 返回 `{ ok, errors, warnings }`——破坏性变更以 Layer 4 error 呈现（agent 据此决定是否提交/调整 migration）。dryRun 不落盘、不执行 migration、不记审计。

## 5. 审计日志

每次 define 成功在 `events.jsonl` 写一条 `board.defined` 事件 + 内部 `migration.executed` 详情：

```json
{"seq":42,"ts":"...","type":"board.defined","summary":"DSL 更新（3 changes）",
 "payload":{"changes":[
   {"kind":"field_added","entity":"pipeline_run","field":"env"},
   {"kind":"enum_narrowed","entity":"pipeline_run","field":"status","migration_strategy":"mapping","affected_instances":2},
   {"kind":"view_added","view":"deploy_table"}
  ],"breaking":true,"instancesAffected":2,"lastWriteMessageId":"01J..."},
 "source":"agent","messageId":"01J..."}
```

### change kind 清单

`entity_added` / `entity_deleted` / `field_added` / `field_deleted` / `field_type_changed` / `enum_expanded` / `enum_narrowed` / `constraint_tightened` / `constraint_relaxed` / `view_added` / `view_deleted` / `view_modified` / `state_field_changed` / `transition_added` / `transition_removed` / `terminal_expanded` / `terminal_shrunk` / `display_changed` / `meta_updated`。

## 6. 引擎执行保证

### 6.1 原子性

一次 define（含 migration）= 一个原子事务。全部成功 → 落盘新 DSL + 迁移后数据 + 审计。任一步失败 → **全部回滚**：恢复旧 DSL + 旧数据，不写审计（或写 `outcome: "rolled_back"` entry）。

### 6.2 幂等性

migration operation 幂等：mapping 对已映射值再执行 = no-op；delete_field 对已删字段 = no-op；transform 幂等（parseFloat(42)=42）。引擎执行前检查当前状态，跳过已完成 operation（支持中断恢复）。

### 6.3 备份

破坏性变更执行前，引擎自动备份旧 DSL + 受影响实例到 `.archive/pre-migration-{seq}/`（含 `board.yaml.bak` + `entities/{entity}/{id}.json`）。回滚时从此目录恢复。备份保留至下次破坏性 migration（覆盖旧的）。

### 6.4 迁移后校验（post-validate）+ 回滚

operations 全部执行后、落盘新 DSL 前，引擎对 plan 触及且**仍存在于新 schema** 的实体逐实例过 `validateInstance`（update 模式）：

- `delete_entity` 目标实体已从新 schema 移除 → 跳过校验。
- 任一实例不过 → **全量回滚**（从 §6.3 备份恢复旧 DSL + 旧数据）+ throw `MigrationPostValidationError`（code = `panorama_migration_postcheck`，violations 明细收集上限 20 条，入口层截前 10 条返回给 agent/调用方修 migration）。
- 典型场景：narrow_enum 缺 mapping 残留非法 enum 值——这是迁移正确性的最后防线（此前静默残留非法值）。

入口映射：工具 define → `{ code: "panorama_migration_postcheck", message, violations }`；HTTP PUT schema → 400 同构 body。

## 7. 边界 + 衔接

| 零件 | 归属 |
|---|---|
| 变更分类 + 迁移方案格式 + handler 策略 + 审计 + 用户介入门槛 + 原子性/幂等/备份 | 本文 ✅ |
| Layer 4 判定逻辑（何时报破坏性 error） | `[P1]panorama_validation.md §5` |
| 存储布局（.archive 目录 + events.jsonl） | `[P1]panorama_store.md §1/§7` |
| define 工具 action（含 migration/approved 参数） | `[P1]panorama_tools.md` |
| define HTTP 端点 | `panorama_http.md` + `14-panorama-endpoints.md` |

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
