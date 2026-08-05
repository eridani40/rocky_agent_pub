---
type: research
title: Panorama 四层校验完整规则表
version: v0.0.189.dsl_board
status: draft
updated: 2026-07-22
---

# Panorama 四层校验完整规则表

> 调研产出：req.md §11 开放问题 2（校验四层规则清单与错误码表）的回答。
> 决策 2 已定四层架构；本文产出每层的规则清单、错误码表、返回结构、dryRun 语义。
> 核心机制（决策 2）：结构化错误 `{code, path, suggestion}` 喂回 agent 自我修复。

---

## 1. 总体设计

### 1.1 四层顺序与短路

```
DSL 文本
  │
  ▼
Layer 1: 语法层（YAML parse + 根类型）
  │ fail → 立即返回（后续层无意义）
  ▼
Layer 2: schema 层（字段类型 / 必填 / enum 值集 / 护栏上限）
  │ 收集所有错误（不短路——一次报全）
  ▼
Layer 3: 语义层（跨引用闭合：ref / template / group_by / transitions / view.entity）
  │ 收集所有错误（不短路）
  ▼
Layer 4: 数据安全层（存量实例 vs 新 DSL 的兼容性）
  │ 仅 define（非 dryRun）且有存量数据时执行
  ▼
{ ok: true } 或 { ok: false, errors: [...] }
```

- Layer 1 短路（YAML 都 parse 不了，后续无意义）。
- Layer 2-3 **不短路**：收集全部错误一次性返回，减少 agent 修复轮次（一次修完所有问题）。
- Layer 4 仅在 `define` 调用（非 `dryRun`）且 board 已有存量实例数据时触发。空 board 首次 define 跳过此层。

### 1.2 返回结构

```typescript
interface ValidationResult {
  ok: boolean
  errors: ValidationError[]
  // ok=true 时 errors 为空数组
  // 额外信息（诊断用，不影响 ok 判定）
  warnings?: ValidationWarning[]
}

interface ValidationError {
  layer:   "syntax" | "schema" | "semantic" | "data_safety"
  code:    string        // panorama_* 前缀，见各层错误码表
  path:    string        // DSL 内的 JSON path（如 "entities.pipeline_run.fields.status"）
  message: string        // 人类可读错误描述
  suggestion?: string    // 修复建议（含示例片段）
}

interface ValidationWarning {
  layer:   "schema" | "semantic"
  code:    string        // panorama_warn_* 前缀
  path:    string
  message: string
}
```

### 1.3 dryRun 语义

| 场景 | dryRun | 行为 |
|------|--------|------|
| 首次定义（空 board） | true/false | 跑 Layer 1-3；Layer 4 跳过（无存量数据）。true/false 结果相同 |
| 更新 DSL（有存量数据） | `true` | 跑 Layer 1-4，**不落盘**。返回校验结果供 agent 预检 |
| 更新 DSL（有存量数据） | `false` | 跑 Layer 1-4，全过则落盘 + 记审计日志；有错则**不落盘**（原子性：要么全过全落，要么全拒） |
| 拖拽 / create / update | — | 这些操作不碰 DSL，只跑「实例值校验」（Layer 2 的字段类型校验子集）+ transition 校验 |

**核心规则**：**dryRun 失败绝不落盘**。partial success 不存在——校验是原子的。

---

## 2. Layer 1: 语法层

YAML 解析 + 根结构校验。

| # | 规则 | 错误码 | 触发条件 | message 示例 | suggestion |
|---|------|--------|----------|-------------|------------|
| 1.1 | YAML parse 成功 | `panorama_yaml_parse_error` | YAML 语法错误（缩进/Tab/引号不匹配） | `YAML 解析失败：第 12 行缩进错误` | 指出出错行号 + 上下文 |
| 1.2 | 根类型是 map | `panorama_invalid_root` | parse 成功但根不是 object（如根是数组或裸标量） | `DSL 根节点必须是对象（map），实际是 array` | `顶层应为: meta: ... / team: ... / entities: ... / views: ...` |
| 1.3 | 必需顶层键存在 | `panorama_missing_top_level` | 缺少 `entities` 或 `views` | `缺少顶层键 entities` | 补上对应块 |

- `meta` 和 `team` 缺失时**不报错**：引擎用默认值填充（meta.version="1.0", team.id=squadId），追加 warning。
- Layer 1 任何规则 fail → **短路返回**，不执行 Layer 2-4。

---

## 3. Layer 2: schema 层

结构化字段级校验：类型、必填、enum 值集、约束、护栏。**不短路**——全部检查完一次性返回。

### 3.1 meta + team 校验

| # | 规则 | 错误码 | 触发条件 | suggestion |
|---|------|--------|----------|------------|
| 2.1 | meta.version 格式 | `panorama_invalid_version` | version 不匹配 `\d+\.\d+` | `"1.0"` |
| 2.2 | meta.updated_at 不可手填 | `panorama_manual_updated_at` | define 请求中 updated_at 与引擎记录不一致 | 删除 updated_at 字段，引擎自动维护 |

### 3.2 entity 声明校验

| # | 规则 | 错误码 | 触发条件 | suggestion |
|---|------|--------|----------|------------|
| 2.3 | 实体名格式 | `panorama_invalid_entity_name` | 实体名不匹配 `^[a-z][a-z0-9_]*$` | 用小写字母+下划线 |
| 2.4 | label 必填 | `panorama_missing_label` | entity 缺 label | 补 label 展示名 |
| 2.5 | id_field 必填 | `panorama_missing_id_field` | entity 缺 id_field | 补 id_field |
| 2.6 | id_field 指向 string 字段 | `panorama_id_field_wrong_type` | id_field 指向的字段 type != string | id_field 必须指向 type: string 的字段 |
| 2.7 | fields 非空 | `panorama_empty_fields` | entity.fields 为空或缺失 | 至少定义一个字段（含 id_field） |

### 3.3 field 类型校验

| # | 规则 | 错误码 | 触发条件 | suggestion |
|---|------|--------|----------|------------|
| 2.8 | type 必填且合法 | `panorama_invalid_field_type` | type 缺失或不在 6 种基础类型内 | `type: string\|number\|boolean\|enum\|ref\|datetime` |
| 2.9 | enum 必有 values | `panorama_enum_missing_values` | type=enum 但无 values | 补 `values: [v1, v2, ...]` |
| 2.10 | enum values 非空 | `panorama_enum_empty_values` | values 是空数组 | 至少一个值 |
| 2.11 | enum 值格式 | `panorama_invalid_enum_value` | 值不匹配 `^[a-z][a-z0-9_]*$` | 小写字母+下划线 |
| 2.12 | enum 值唯一 | `panorama_duplicate_enum_value` | values 有重复值 | 去重 |
| 2.13 | ref 必有 entity | `panorama_ref_missing_entity` | type=ref 但无 entity | 补 `entity: 目标实体名` |
| 2.14 | string.max 是正整数 | `panorama_invalid_max` | max <= 0 或非整数 | `max: 500` |
| 2.15 | number.min/max 数值合法 | `panorama_invalid_range` | min > max | 调整使 min <= max |

### 3.4 跨实体 enum 一致性

| # | 规则 | 错误码 | 触发条件 | suggestion |
|---|------|--------|----------|------------|
| 2.16 | 同名 enum 值集一致 | `panorama_enum_name_collision` | 两个实体的同名字段 type=enum 但 values 不同 | 统一值集或重命名字段 |

### 3.5 states 校验

| # | 规则 | 错误码 | 触发条件 | suggestion |
|---|------|--------|----------|------------|
| 2.17 | states.field 指向 enum 字段 | `panorama_state_field_not_enum` | states.field 指向的字段 type != enum | states.field 必须指向 enum 字段 |
| 2.18 | initial 是合法 enum 值 | `panorama_invalid_initial` | initial 不在 field 的 enum values 内 | 改为 enum values 之一 |
| 2.19 | transitions 键是合法状态 | `panorama_invalid_transition_from` | transitions 的 from 键不在 enum values 内 | 改为 enum values 之一 |
| 2.20 | transitions 值是合法状态 | `panorama_invalid_transition_to` | transitions 的 to 值不在 enum values 内 | 改为 enum values 之一 |
| 2.21 | terminal 全部是合法状态 | `panorama_invalid_terminal` | terminal 数组含不在 enum values 内的值 | 改为 enum values 之一 |
| 2.22 | guard 操作符合法 | `panorama_invalid_guard_op` | guard 用了非支持操作符 | 用 eq/ne/gte/lte/gt/lt/in/not_in |
| 2.23 | guard.field 存在 | `panorama_guard_unknown_field` | guard.field 不是当前实体字段 | 改为已声明的字段名 |

### 3.6 display 校验

| # | 规则 | 错误码 | 触发条件 | suggestion |
|---|------|--------|----------|------------|
| 2.24 | labels/colors 键是合法 enum 值 | `panorama_invalid_display_key` | `foo_labels` 的 key 不在 foo 的 enum values 内 | 改为 enum values 之一（追加 warning 而非 error：多余 key 只警告） |
| 2.25 | colors 值是合法 hex | `panorama_invalid_color` | color 值不匹配 `^#[0-9a-fA-F]{6}$` | `"#4c9aff"` 格式 |

### 3.7 view 校验

| # | 规则 | 错误码 | 触发条件 | suggestion |
|---|------|--------|----------|------------|
| 2.26 | component 合法 | `panorama_invalid_component` | component 不在 kanban/table/bar_chart 内 | `kanban\|table\|bar_chart` |
| 2.27 | view.id 唯一 | `panorama_duplicate_view_id` | 两个 view 的 id 相同 | 重命名去重 |
| 2.28 | view.id 格式 | `panorama_invalid_view_id` | 不匹配 `^[a-z][a-z0-9_]*$` | 小写字母+下划线 |
| 2.29 | kanban 有 group_by | `panorama_missing_group_by` | kanban view 缺 group_by | 补 `group_by: 字段名` |
| 2.30 | kanban 有 columns | `panorama_missing_columns` | kanban view 缺 columns | 补 `columns: [...]` |
| 2.31 | kanban 有 card | `panorama_missing_card` | kanban view 缺 card | 补 card 模板 |
| 2.32 | table 有 columns | `panorama_missing_table_columns` | table view 缺 columns | 补 `columns: [...]` |
| 2.33 | bar_chart 有 bucket | `panorama_missing_bucket` | bar_chart view 缺 bucket | 补 `bucket: {field, unit, days}` |
| 2.34 | bucket.unit 合法 | `panorama_invalid_bucket_unit` | unit != day | `day`（v1 仅支持 day） |
| 2.35 | bucket.days 正整数 | `panorama_invalid_bucket_days` | days <= 0 或 > 90 | `days: 7`（1-90） |
| 2.36 | sort.order 合法 | `panorama_invalid_sort_order` | order 不在 asc/desc 内 | `asc\|desc` |

### 3.8 护栏校验

| # | 规则 | 错误码 | 触发条件 | suggestion |
|---|------|--------|----------|------------|
| 2.37 | 实体数 ≤ 20 | `panorama_limit_entities` | 超过 20 个实体 | 精简或合并实体（当前 N 个） |
| 2.38 | 字段数/实体 ≤ 30 | `panorama_limit_fields` | 单实体字段超 30 | 拆分实体或精简字段 |
| 2.39 | view 数 ≤ 10 | `panorama_limit_views` | view 超过 10 个 | 精简视图 |
| 2.40 | enum 值 ≤ 15 | `panorama_limit_enum_values` | 单 enum 值超 15 | 合并相近分类 |
| 2.41 | card 模板 ≤ 200 字符 | `panorama_limit_template` | 模板超长 | 精简模板内容 |
| 2.42 | transitions 出边 ≤ 10 | `panorama_limit_transitions` | 单状态出边超 10 | 简化工作流 |

---

## 4. Layer 3: 语义层

跨引用闭合校验：所有「指向别处」的声明必须指向已存在且类型匹配的目标。**不短路**。

| # | 规则 | 错误码 | 触发条件 | suggestion |
|---|------|--------|----------|------------|
| 3.1 | ref.entity 指向已声明实体 | `panorama_unknown_ref_target` | ref.entity 指向不存在的实体 | 改为已声明的实体名，或新建该实体 |
| 3.2 | states.field 指向已声明字段 | `panorama_state_field_missing` | states.field 在 fields 中不存在 | 改为已声明字段名 |
| 3.3 | view.entity 指向已声明实体 | `panorama_unknown_view_entity` | view.entity 指向不存在的实体 | 改为已声明的实体名 |
| 3.4 | kanban.group_by 指向已声明字段 | `panorama_unknown_group_by` | group_by 字段在 entity.fields 中不存在 | 改为已声明的 enum 字段名 |
| 3.5 | kanban.group_by 是 enum 类型 | `panorama_group_by_not_enum` | group_by 指向的字段 type != enum | group_by 必须指向 enum 字段 |
| 3.6 | kanban.columns 值是 group_by 的 enum 子集 | `panorama_invalid_column_value` | columns 含 group_by 字段 enum values 之外的值 | 改为 enum values 子集 |
| 3.7 | table.columns 指向已声明字段 | `panorama_unknown_table_column` | table columns 含 entity 中不存在的字段名 | 改为已声明的字段名 |
| 3.8 | sort.field 指向已声明字段 | `panorama_unknown_sort_field` | sort.field 不在 entity.fields 中 | 改为已声明字段名 |
| 3.9 | bar_chart.bucket.field 是 datetime 类型 | `panorama_bucket_not_datetime` | bucket.field 指向的字段 type != datetime | 改为 datetime 类型字段 |
| 3.10 | bar_chart.stack_by 是 enum 类型 | `panorama_stack_by_not_enum` | stack_by 指向的字段 type != enum | 改为 enum 字段名 |
| 3.11 | card 模板 `{field}` 引用已声明字段 | `panorama_unknown_field_in_template` | 模板中 `{foo}` 的 foo 不在 entity.fields 中 | 改为已声明字段名，或从模板中移除 |
| 3.12 | card 模板 `{ref.target}` ref 字段是 ref 类型 | `panorama_ref_navigation_on_non_ref` | `{foo.bar}` 的 foo 不是 ref 类型字段 | ref 嵌套只能用于 type=ref 的字段 |
| 3.13 | card 模板 `{ref.target}` target 字段存在 | `panorama_unknown_ref_target_field` | `{ref_id.target}` 的 target 在目标实体 fields 中不存在 | 改为目标实体已声明字段名 |
| 3.14 | card.badges 引用已声明字段 | `panorama_unknown_badge_field` | badges 数组含不存在的字段名 | 改为已声明字段名 |
| 3.15 | terminal 状态在 transitions 中无出边 | `panorama_terminal_has_outgoing` | terminal 声明的状态在 transitions 中有出边 | 从 transitions 移除该状态的出边，或从 terminal 移除该状态 |
| 3.16 | guard.field 类型与 guard 操作符匹配 | `panorama_guard_type_mismatch` | guard 用 gte 但 field 是 string 类型 | 数值比较操作符只能用于 number 字段 |
| 3.17 | kanban.columns 覆盖 group_by 全部 enum 值 | (warning) `panorama_warn_missing_column` | columns 缺少 group_by 的某些 enum 值 | 追加缺失值或确认有意省略 |

- 规则 3.15 是一个一致性检查：terminal 意味着「不可再跃迁」，如果 transitions 里还给出边就矛盾了。**报 error** 而非 warning（agent 容易写错）。
- 规则 3.17 是 warning：columns 可故意省略某些值（如隐藏 cancelled），但应提醒 agent 确认是否有意。

---

## 5. Layer 4: 数据安全层

存量实例 vs 新 DSL 的兼容性校验。仅在 `define`（非 dryRun）且 board 已有实例数据时执行。

**输入**：旧 DSL + 存量实例数据 + 新 DSL。
**输出**：存量实例在新 DSL 下是否仍合法。不合法 = 破坏性变更，须 agent 提交迁移方案（见 migration doc）。

| # | 规则 | 错误码 | 触发条件 | suggestion |
|---|------|--------|----------|------------|
| 4.1 | 删除实体后存量数据 | `panorama_dropping_entity_data` | 新 DSL 删除了有存量实例的实体 | 提交迁移方案（migration operation: archive_entity / delete_entity） |
| 4.2 | 删除字段后存量数据 | `panorama_dropping_field_data` | 新 DSL 删除了有非空值的字段 | 提交迁移方案（migration operation: drop_field + handler） |
| 4.3 | 收窄 enum 致存量越界 | `panorama_enum_narrowed` | 新 DSL 的 enum values 是旧值的真子集，且存量实例有被移除的值 | 提交迁移方案（migration operation: narrow_enum + value_mapping） |
| 4.4 | 改字段类型致存量不兼容 | `panorama_field_type_changed` | 同名字段 type 变更（如 string→number），存量值不满足新类型 | 提交迁移方案（migration operation: change_field_type + transform） |
| 4.5 | 改 states.field 致存量非法 | `panorama_state_field_changed` | states.field 从 A 改为 B，存量实例 A 的值不在 B 的 enum 中 | 提交迁移方案（migration operation: migrate_state_field） |
| 4.6 | 改 initial 致新实例与存量不一致 | (warning) `panorama_warn_initial_changed` | initial 变更（不影响存量合法性，但语义变化值得提醒） | 确认旧实例状态不受影响 |
| 4.7 | 删 transition 致存量卡死 | `panorama_transition_removed` | 新 DSL 删除了 transitions 中的某条出边，且存量实例当前状态依赖该出边才能离开 | 提交迁移方案或确认终态 |
| 4.8 | 改 terminal 致存量卡死 | `panorama_terminal_changed` | 新 terminal 声明使存量非终态实例变为终态（不可逆锁定） | 提交迁移方案（migration operation: unblock_terminal） |

### 5.1 数据安全层判定逻辑

```
for each entity in old_dsl.entities:
  if entity not in new_dsl.entities:
    if has_existing_instances(entity):
      → error 4.1

for each field in old_entity.fields:
  if field not in new_entity.fields:
    if any_instance_has_non_null_value(entity, field):
      → error 4.2

  elif field.type changed:
    if any_instance_fails_new_type(entity, field):
      → error 4.4

  elif field is enum and values narrowed:
    affected = instances_with_removed_values(entity, field)
    if affected.length > 0:
      → error 4.3 (count: affected.length)

  # states.field changes
  elif entity.states.field != new_entity.states.field:
    → error 4.5

  # terminal changes
  elif terminal_grew(old, new):
    affected = instances_now_locked(old, new)
    if affected.length > 0:
      → error 4.8
```

### 5.2 Layer 4 与迁移的关系

- Layer 4 报 error = **新 DSL 不会落盘**（原子拒绝）。
- agent 收到 Layer 4 error 后，必须提交 **迁移方案**（`migration` 参数），引擎重新跑 define：
  - 验证迁移方案覆盖所有 Layer 4 error（每个 error 有对应 migration operation）
  - 执行迁移方案（transform 存量数据）
  - 重新跑 Layer 4（确认迁移后存量数据合法）
  - 全过则落盘新 DSL + 迁移后的数据 + 审计日志

迁移方案的格式与操作清单见 migration doc。

---

## 6. 实例写操作校验（create / update / transition）

这些操作不碰 DSL，校验的是「实例值是否符合当前 DSL 约束」。

### 6.1 create / update 校验（Layer 2 子集）

| # | 规则 | 错误码 | 触发条件 |
|---|------|--------|----------|
| 5.1 | 字段类型匹配 | `panorama_type_mismatch` | string 字段传了 number 等 |
| 5.2 | enum 值合法 | `panorama_invalid_enum_value` | 值不在 DSL 声明的 values 内 |
| 5.3 | ref 目标存在 | `panorama_dangling_ref` | ref 字段值指向不存在的实例 id |
| 5.4 | required 字段非空 | `panorama_missing_required` | required=true 的字段为 null/undefined |
| 5.5 | string.max 未超 | `panorama_value_too_long` | 字符串超 max |
| 5.6 | string.pattern 匹配 | `panorama_pattern_mismatch` | 值不匹配 pattern |
| 5.7 | number 在 min/max 内 | `panorama_value_out_of_range` | 值超 min/max |
| 5.8 | datetime 可 parse | `panorama_invalid_datetime` | 值不是合法 ISO 8601 |
| 5.9 | id 唯一（create 时） | `panorama_duplicate_id` | id 已存在 |
| 5.10 | 状态字段值在 enum 内（create 时） | `panorama_invalid_initial_value` | create 时 status 值不在 enum values 内（缺省用 states.initial） |

### 6.2 transition 校验

| # | 规则 | 错误码 | 触发条件 | suggestion |
|---|------|--------|----------|------------|
| 6.1 | from 是合法状态 | `panorama_illegal_transition` | from 不在 enum values | 检查实例当前状态 |
| 6.2 | to 是合法状态 | `panorama_illegal_transition` | to 不在 enum values | 检查目标状态 |
| 6.3 | from 不是终态 | `panorama_terminal_locked` | from 在 terminal 列表中 | 终态不可跃迁，需新建实例 |
| 6.4 | from→to 在 transitions 表 | `panorama_illegal_transition` | transitions[from] 不含 to | 列出合法目标状态 |
| 6.5 | guard 条件满足 | `panorama_guard_failed` | transition 有 guard 但实例字段不满足条件 | 列出 guard 条件 + 当前实例值 |

---

## 7. 错误码命名约定

| 前缀 | 范围 | 示例 |
|------|------|------|
| `panorama_yaml_*` | Layer 1 语法 | `panorama_yaml_parse_error` |
| `panorama_invalid_*` | Layer 2 类型/格式/值 | `panorama_invalid_field_type` |
| `panorama_missing_*` | Layer 2 必填缺失 | `panorama_missing_label` |
| `panorama_limit_*` | Layer 2 护栏超限 | `panorama_limit_entities` |
| `panorama_unknown_*` | Layer 3 引用不存在 | `panorama_unknown_ref_target` |
| `panorama_dropping_*` | Layer 4 数据丢失 | `panorama_dropping_field_data` |
| `panorama_*_narrowed` | Layer 4 收窄 | `panorama_enum_narrowed` |
| `panorama_*_changed` | Layer 4 变更 | `panorama_field_type_changed` |
| `panorama_illegal_*` | 实例操作非法 | `panorama_illegal_transition` |
| `panorama_terminal_*` | 终态锁定 | `panorama_terminal_locked` |
| `panorama_guard_*` | guard 条件 | `panorama_guard_failed` |
| `panorama_dangling_*` | 悬空引用 | `panorama_dangling_ref` |
| `panorama_warn_*` | 警告（不阻断） | `panorama_warn_missing_column` |

**原则**：`panorama_` 统一前缀 + 语义化中段（invalid/missing/unknown/dropping/narrowed/illegal/terminal/guard/dangling）+ 具体对象后缀。

---

## 8. 校验器调用入口

三个写入入口（决策 6）共用同一个校验器实例：

| 入口 | 校验范围 | 备注 |
|------|----------|------|
| `panorama(define, dsl, dryRun)` | Layer 1-4 | agent 工具调用，核心入口 |
| `POST /panorama/schema`（HTTP API） | Layer 1-4 | 用户直接 API 调用 |
| `POST /panorama/entities/:entity`（create 实例） | §6.1 实例校验子集 | HTTP/工具 |
| `POST /panorama/entities/:entity/:id/transition` | §6.2 transition 校验 | 拖拽/工具 |
| 拖拽（UI → HTTP transition） | §6.2 transition 校验 | 走 HTTP，同规则 |

**规则唯一源 = DSL**（决策 6）。所有入口的校验逻辑从同一份 DSL 派生，不硬编码。
