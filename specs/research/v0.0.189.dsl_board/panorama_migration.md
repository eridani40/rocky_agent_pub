---
type: research
title: Panorama 迁移模型
version: v0.0.189.dsl_board
status: draft
updated: 2026-07-22
---

# Panorama 迁移模型

> 调研产出：req.md §11 开放问题 3（迁移模型的方案格式与审计粒度）的回答。
> 决策 3 已定双层模型（增量自动 / 破坏性须方案）；本文产出变更分类、迁移方案 JSON 格式、审计日志结构、用户介入门槛。
> 设计目标：破坏性变更的迁移方案由 agent 提交（结构化 JSON），引擎执行 + 审计；用户仅在「重大」变更时介入。

---

## 1. 变更分类总表

| 分类 | 变更类型 | 引擎行为 | 需迁移方案 | 用户介入 |
|------|----------|----------|------------|----------|
| **增量** | 加实体 | 自动生效 | ❌ | ❌ |
| 增量 | 加字段 | 自动生效（存量实例该字段补 null） | ❌ | ❌ |
| 增量 | 加视图 | 自动生效 | ❌ | ❌ |
| 增量 | 扩 enum（加值） | 自动生效 | ❌ | ❌ |
| 增量 | 加 transition 出边 | 自动生效 | ❌ | ❌ |
| 增量 | 加状态机（实体新增 states） | 自动生效 | ❌ | ❌ |
| 增量 | 加 display labels/colors | 自动生效 | ❌ | ❌ |
| 增量 | 改 label/board_name/title 等展示文案 | 自动生效 | ❌ | ❌ |
| 增量 | 放宽约束（max 变大 / min 变小 / pattern 去掉） | 自动生效 | ❌ | ❌ |
| **破坏性** | 删实体 | ❌ 拒绝 | ✅ | ⚠️ 重大 |
| 破坏性 | 删字段 | ❌ 拒绝 | ✅ | ⚠️ 有数据时重大 |
| 破坏性 | 收窄 enum（删值） | ❌ 拒绝 | ✅ | ⚠️ 有存量值时重大 |
| 破坏性 | 改字段类型 | ❌ 拒绝 | ✅ | ⚠️ 重大 |
| 破坏性 | 删 transition 出边 | ❌ 拒绝 | ✅（有依赖存量时） | ❌ 次要 |
| 破坏性 | 改 states.field | ❌ 拒绝 | ✅ | ⚠️ 重大 |
| 破坏性 | 改 terminal（扩大终态集） | ❌ 拒绝 | ✅（有锁定存量时） | ❌ 次要 |
| 破坏性 | 改 group_by 目标 | 自动生效（视图层变更，不影响数据） | ❌ | ❌ |
| 破坏性 | 收紧约束（max 变小 / 加 pattern） | ❌ 拒绝 | ✅（有违规存量时） | ❌ 次要 |

**判定规则**：引擎在 define 的 Layer 4（数据安全层）自动判定。增量变更 = Layer 4 通过；破坏性变更 = Layer 4 报 error，agent 提交 migration 方案后重试。

---

## 2. 增量变更（自动生效）

agent 直接 `define(new_dsl)`，引擎检测到差异属于增量类，自动落盘 + 写审计日志。

### 2.1 加字段时存量实例处理

```yaml
# 旧 DSL
fields:
  id: { type: string }
  branch: { type: string }

# 新 DSL 加了 duration_sec
fields:
  id: { type: string }
  branch: { type: string }
  duration_sec: { type: number }   # 新增
```

存量实例的 `duration_sec` 自动补 `null`（JSON 中不存在该 key → 读取时视为 null）。引擎不批量回写——惰性策略：存量实例文件不动，读取时用 DSL 补默认值。写审计日志记录 schema 变更。

### 2.2 加状态机时存量实例处理

```yaml
# 旧 DSL：deployment 无 states
# 新 DSL：加了 states
states:
  field: status
  initial: pending
  transitions: { ... }
```

存量实例：引擎检查是否有同名字段（`status`），有则校验值在新的 enum values 内；无则在审计日志记 warning（存量实例缺状态字段，建议补值）。

---

## 3. 破坏性变更（须迁移方案）

### 3.1 迁移方案提交格式

agent 在 `define` 调用时附带 `migration` 参数：

```typescript
interface DefineParams {
  dsl: string           // 新 DSL 全文
  dryRun?: boolean      // true = 只校验不落盘
  migration?: MigrationPlan  // 破坏性变更时必填
}

interface MigrationPlan {
  operations: MigrationOperation[]
}

interface MigrationOperation {
  operation: string          // 操作类型（见 §3.2 清单）
  target: {                  // 操作目标
    entity: string           // 实体名
    field?: string           // 字段名（字段级操作）
    view?: string            // 视图名（视图级操作）
  }
  from?: any                 // 旧值（变更类操作）
  to?: any                   // 新值
  handler: MigrationHandler  // 存量数据处理策略
}

interface MigrationHandler {
  strategy: string           // 处理策略（见 §3.3）
  mapping?: Record<string, any>  // 值映射表（strategy=mapping 时）
  default_value?: any        // 默认值（strategy=default 时）
  transform?: string         // 变换表达式（strategy=transform 时）
}
```

### 3.2 迁移操作清单

| operation | target 粒度 | 触发条件 | handler.strategy |
|-----------|-------------|----------|------------------|
| `delete_entity` | entity | 删实体 | `archive`（归档存量数据到 `.archive/`）/ `purge`（物理删除） |
| `delete_field` | entity + field | 删字段 | `drop`（丢弃值）/ `archive`（归档到实例的 `_archived` 字段） |
| `narrow_enum` | entity + field | enum 收窄（删值） | `mapping`（旧值→新值映射表） |
| `change_field_type` | entity + field | 字段类型变更 | `transform`（变换表达式）/ `default`（无法变换时用默认值） |
| `change_state_field` | entity | states.field 变更 | `mapping`（旧状态字段值→新状态字段值） |
| `remove_transition` | entity | 删 transition 出边 | `none`（不需处理存量，只是限制未来跃迁） |
| `expand_terminal` | entity | 扩大 terminal 集 | `none` / `unblock`（把被锁的存量实例回退到非终态） |
| `tighten_constraint` | entity + field | 收紧 max/min/pattern | `clip`（截断到范围内）/ `default`（不合规值用默认值替换） |

### 3.3 handler 策略详解

#### strategy: `archive`

存量数据移到安全位置，不丢失。

```json
{
  "operation": "delete_entity",
  "target": { "entity": "old_feature" },
  "handler": { "strategy": "archive" }
}
```

引擎执行：`mv entities/old_feature/*.json → .archive/old_feature/`。审计日志记录归档路径 + 实例数。

#### strategy: `purge`

物理删除存量数据。**仅当 agent 明确声明数据可丢弃时使用**。

```json
{
  "operation": "delete_entity",
  "target": { "entity": "temp_runs" },
  "handler": { "strategy": "purge" }
}
```

#### strategy: `mapping`

值映射表：旧值→新值。用于收窄 enum / 改状态字段。

```json
{
  "operation": "narrow_enum",
  "target": { "entity": "pipeline_run", "field": "status" },
  "from": ["queued", "running", "success", "failed", "cancelled"],
  "to": ["pending", "in_progress", "done", "cancelled"],
  "handler": {
    "strategy": "mapping",
    "mapping": {
      "queued": "pending",
      "running": "in_progress",
      "success": "done",
      "failed": "cancelled"
    }
  }
}
```

引擎执行：遍历所有 pipeline_run 实例，将 status 值按 mapping 替换。映射后值必须在新 enum values 内（否则报 `panorama_migration_mapping_invalid`）。

#### strategy: `default`

无法变换的存量值用默认值替换。

```json
{
  "operation": "change_field_type",
  "target": { "entity": "task", "field": "estimate" },
  "from": "string",
  "to": "number",
  "handler": {
    "strategy": "default",
    "default_value": 0
  }
}
```

引擎执行：尝试将每个实例的 estimate 值 `Number(value)`，NaN 则用 default_value。

#### strategy: `transform`

变换表达式（v1 限定为简单模板，不支持任意 JS）。

```json
{
  "operation": "change_field_type",
  "target": { "entity": "task", "field": "estimate_hours" },
  "from": "string",
  "to": "number",
  "handler": {
    "strategy": "transform",
    "transform": "parseFloat(value)"
  }
}
```

v1 支持的 transform 函数：`parseFloat` / `parseInt` / `toString` / `toLowerCase` / `toUpperCase` / `trim`。链式调用：`parseFloat(trim(value))`。引擎在沙箱中执行，不允许任意代码。

#### strategy: `drop`

字段值丢弃（设为 null / 删 key）。用于删字段。

```json
{
  "operation": "delete_field",
  "target": { "entity": "pipeline_run", "field": "legacy_flag" },
  "handler": { "strategy": "drop" }
}
```

#### strategy: `clip`

值截断到约束范围内。用于收紧 max/min。

```json
{
  "operation": "tighten_constraint",
  "target": { "entity": "pipeline_run", "field": "duration_sec" },
  "handler": { "strategy": "clip", "default_value": 0 }
}
```

引擎执行：值 > max 则截为 max，< min 则截为 min。

### 3.4 完整迁移方案示例

场景：CI/CD 看板从 4 状态（queued/running/success/failed）收敛到 3 状态（pending/in_progress/done），同时删除 `triggered_by` 字段。

```json
{
  "operations": [
    {
      "operation": "narrow_enum",
      "target": { "entity": "pipeline_run", "field": "status" },
      "from": ["queued", "running", "success", "failed"],
      "to": ["pending", "in_progress", "done"],
      "handler": {
        "strategy": "mapping",
        "mapping": {
          "queued": "pending",
          "running": "in_progress",
          "success": "done",
          "failed": "done"
        }
      }
    },
    {
      "operation": "delete_field",
      "target": { "entity": "pipeline_run", "field": "triggered_by" },
      "handler": { "strategy": "drop" }
    }
  ]
}
```

引擎执行顺序：
1. 校验 migration operations 覆盖所有 Layer 4 errors
2. 按顺序执行每个 operation（遍历存量实例，应用 handler）
3. 重新跑 Layer 4 校验（确认迁移后数据合法）
4. 全过 → 落盘新 DSL + 迁移后数据 + 审计日志
5. 任一步失败 → **全部回滚**（原子性）

---

## 4. 审计日志

### 4.1 落点

```
data_dir/squads/{squadId}/panorama/
├── board.yaml
├── audit.jsonl              # ← 审计日志（append-only）
├── entities/{entity}/{id}.json
├── events.jsonl
└── .archive/                # 归档数据
```

`audit.jsonl` 与 `events.jsonl` 分开：events 记实例级操作（create/update/transition），audit 记 schema 级变更（define/migrate）。

### 4.2 结构

**每个 `define` 调用一个 entry**（不论增量还是破坏性）：

```json
{
  "seq": 42,
  "ts": "2026-07-22T14:30:00Z",
  "type": "schema.define",
  "author": "leader-session-id",
  "dryRun": false,
  "outcome": "applied",
  "changes": [
    {
      "kind": "field_added",
      "entity": "pipeline_run",
      "field": "is_hotfix",
      "detail": "type=boolean"
    },
    {
      "kind": "view_added",
      "view": "hotfix_board"
    },
    {
      "kind": "enum_narrowed",
      "entity": "pipeline_run",
      "field": "status",
      "removed_values": ["cancelled"],
      "affected_instances": 3,
      "migration_strategy": "mapping"
    }
  ],
  "stats": {
    "entities_before": 2,
    "entities_after": 2,
    "instances_touched": 3,
    "breaking": true
  }
}
```

### 4.3 粒度决策

| 问题 | 决策 | 理由 |
|------|------|------|
| 每次 define 一个 entry？ | ✅ 是 | 一个 define = 一次原子变更，审计追溯以 define 为单位 |
| 每个变更一个 entry？ | ❌ 否 | 一个 define 可能含多个变更（加字段 + 删字段 + 改 enum），拆开丢失原子性语义 |
| changes 数组逐条记录？ | ✅ 是 | 在 entry 内部按 changes[] 逐条展开，既有原子性又有细粒度 |
| migration operation 逐条审计？ | ✅ 是 | changes[] 里每个 migration operation 对应一条 change（kind=migration_*），含 affected_instances 计数 |

### 4.4 change kind 清单

| kind | 说明 |
|------|------|
| `entity_added` | 新增实体 |
| `entity_deleted` | 删除实体（含归档/清除信息） |
| `field_added` | 新增字段 |
| `field_deleted` | 删除字段 |
| `field_type_changed` | 字段类型变更 |
| `enum_expanded` | enum 扩值（增量） |
| `enum_narrowed` | enum 收窄（破坏性，含 migration） |
| `constraint_tightened` | 约束收紧（破坏性） |
| `constraint_relaxed` | 约束放宽（增量） |
| `view_added` | 新增视图 |
| `view_deleted` | 删除视图 |
| `view_modified` | 视图配置变更（改 group_by / columns / card） |
| `state_field_changed` | states.field 变更（破坏性，含 migration） |
| `transition_added` | 加 transition 出边 |
| `transition_removed` | 删 transition 出边 |
| `terminal_expanded` | 扩大 terminal 集 |
| `terminal_shrunk` | 缩小 terminal 集 |
| `display_changed` | display labels/colors 变更 |
| `meta_updated` | meta.updated_at 引擎自动更新 |

---

## 5. 用户介入门槛

### 5.1 分类标准

| 级别 | 标准 | 介入方 | 机制 |
|------|------|--------|------|
| **重大** | 可能导致数据丢失 / 不可逆变更 / 影响业务语义 | 用户点头 | 引擎返 `panorama_breaking_change_requires_approval`，agent 须转达用户，用户确认后 agent 附 `approved: true` 重新提交 |
| **次要** | 可逆 / 影响范围可控 / agent 有足够信息自决 | agent 自决 | agent 提交 migration 方案即可，不需用户确认 |

### 5.2 重大变更清单

| 变更 | 为何重大 |
|------|----------|
| 删实体（有存量数据） | 数据丢失风险 |
| 删字段（有非空值） | 数据丢失风险 |
| 收窄 enum（有存量值受影响） | 存量数据语义改变 |
| 改字段类型 | 存量数据可能损坏 |
| 改 states.field | 状态机语义重写 |

### 5.3 次要变更清单

| 变更 | 为何次要 |
|------|----------|
| 删 transition 出边（无存量依赖） | 仅限制未来操作 |
| 扩大 terminal 集 | 可通过缩小 terminal 恢复 |
| 收紧约束（有少量违规存量） | 可通过放宽约束恢复 |
| 删实体（无存量数据） | 无数据影响 |
| 删字段（全为 null） | 无数据影响 |
| 删视图 | 纯展示层，可重建 |

### 5.4 介入流程

```
agent define(new_dsl, migration)
  │
  ▼
引擎跑 Layer 1-3（全过）
  │
  ▼
引擎跑 Layer 4（有破坏性变更）
  │
  ├─ 次要变更 → 执行 migration → 落盘 → 审计
  │
  └─ 重大变更 → 返回 panorama_breaking_change_requires_approval
                    + 列出重大变更清单 + 迁移方案预览
                    │
                    ▼
              agent 转达用户（"以下变更将影响现有数据，是否确认？"）
                    │
                    ├─ 用户确认 → agent define(new_dsl, migration, approved: true)
                    │              → 引擎执行 → 落盘 → 审计
                    │
                    └─ 用户拒绝 → agent 放弃或修改方案
```

### 5.5 dryRun 预检

agent 可先 `define(new_dsl, dryRun: true, migration: plan)` 预检：
- 引擎返回完整的变更分析（哪些增量 / 哪些破坏性 / 哪些重大 / 哪些次要 / 预估影响实例数）。
- agent 据此决定是否提交正式 define、是否需要用户确认。
- dryRun 不落盘、不执行 migration、不记审计。

---

## 6. 引擎执行保证

### 6.1 原子性

一次 define（含 migration）= 一个原子事务：
- 全部成功 → 落盘新 DSL + 迁移后数据 + 审计日志。
- 任一步失败 → **全部回滚**：恢复旧 DSL + 旧数据，不写审计日志（或写一条 `outcome: "rolled_back"` 的 entry）。

### 6.2 幂等性

migration operation 幂等：
- `narrow_enum` 的 mapping 对已映射的值再执行 = no-op（值已在目标集内）。
- `delete_field` 对已删除的字段再执行 = no-op。
- `change_field_type` 的 transform 对已转换的值再执行 = 幂等（parseFloat(42) = 42）。

引擎在执行前先检查当前状态，跳过已完成的 operation（支持中断恢复）。

### 6.3 备份

破坏性变更执行前，引擎自动备份旧 DSL + 受影响实例到 `.archive/pre-migration-{seq}/`：
```
.archive/pre-migration-42/
├── board.yaml.bak
└── entities/
    └── pipeline_run/
        ├── pr-001.json
        └── pr-002.json
```

回滚时从此目录恢复。备份保留至下次破坏性 migration（覆盖旧的），或由用户手动清理。
