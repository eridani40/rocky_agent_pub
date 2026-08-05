---
type: interface
title: Panorama 四层校验引擎
priority: P1
status: active
updated: 2026-08-05
since: v0.0.189.dsl_board
related: [[P1]panorama_dsl.md, [P1]panorama_migration.md, [P1]panorama_tools.md, [P1]panorama_http.md]
---

# Panorama 四层校验引擎（唯一规则源 + 三路写入共用）

> 定位：校验引擎是 panorama 数据写入的**唯一门卫**。用户拖拽 / agent 工具 / 直接 API 三个写入口（决策 6）全部经过它，规则从同一份 DSL 派生，不硬编码、不漂移。
> 凝练自 `specs/research/v0.0.189.dsl_board/panorama_validation.md`（去调研口吻改现状）。

## 1. 总体设计

### 1.1 四层顺序与短路

```
DSL 文本
  │
  ▼
Layer 1: 语法层（YAML parse + 根类型）     ── fail 短路返回
  │
  ▼
Layer 2: schema 层（字段类型/必填/enum 值集/护栏上限）   ── 收集全部错误（不短路）
  │
  ▼
Layer 3: 语义层（跨引用闭合：ref/template/group_by/transitions/view.entity）  ── 收集全部错误
  │
  ▼
Layer 4: 数据安全层（存量实例 vs 新 DSL 兼容性）    ── define/validate 且有存量 board（oldSchema+store）时执行（dryRun 也跑，不落盘）
  │
  ▼
{ ok: true } 或 { ok: false, errors: [...] }
```

- Layer 1 短路（YAML parse 不了，后续层无意义）。
- Layer 2-3 **不短路**：收集全部错误一次性返回（减少 agent 修复轮次）。
- Layer 4 在 define / schema/validate（含 dryRun）且 board 已有实例数据（oldSchema + store 可用）时触发；dryRun 只预检不落盘。空 board 首次 define 跳过。
- **`ValidationOptions.deferDataSafety`**：define 带 `migration` / `approved:true` 时由调用方（工具 runDefine / HTTP PUT execDefine）置 true → **跳过 Layer 4**，破坏性变更裁决让位 migration 引擎（引擎自带审批门槛 + 迁移后校验回滚兜底，见 `panorama_migration.md`）。理由：原流程 L4 是硬门槛，带 migration 的提交也永远 400、applyMigration 不可达（v0.0.189 生产实证）——L4 只拦「无迁移意图」的裸提交。`POST schema/validate` 恒跑 L4（预检预警，不接受 defer）。

### 1.2 返回结构

```typescript
interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  warnings?: ValidationWarning[];
}

interface ValidationError {
  layer: "syntax" | "schema" | "semantic" | "data_safety";
  code: string;            // panorama_* 前缀
  path: string;            // DSL 内 JSON path（如 "entities.pipeline_run.fields.status"）
  message: string;
  suggestion?: string;     // 修复建议（含示例片段）
}
```

### 1.3 dryRun 语义

| 场景 | dryRun | 行为 |
|------|--------|------|
| 首次定义（空 board） | true/false | Layer 1-3；Layer 4 跳过。结果相同 |
| 更新 DSL（有存量数据） | `true` | Layer 1-4，**不落盘**。返回预检结果 |
| 更新 DSL（有存量数据） | `false` | Layer 1-4，全过则落盘 + 审计；有错**不落盘**（原子性） |
| create / update / transition | — | 不碰 DSL，跑实例值校验（§6）+ transition 校验（§7） |

**核心规则**：dryRun 失败绝不落盘。partial success 不存在。

## 2. Layer 1: 语法层

| # | 规则 | 错误码 | 触发条件 |
|---|------|--------|----------|
| 1.1 | YAML parse 成功 | `panorama_yaml_parse_error` | YAML 语法错误（缩进/Tab/引号） |
| 1.2 | 根类型是 map | `panorama_invalid_root` | 根不是 object |
| 1.3 | 必需顶层键存在 | `panorama_missing_top_level` | 缺 `entities` 或 `views` |

`meta`/`version` 缺失不报错：引擎用默认值填充 + warning。Layer 1 fail → **短路返回**。

> 实现注记：parser 在 Layer 1 通过后会顺带做**结构归一化**（transitions shorthand→longhand、顶层块缺省填充），结构性缺字段统一用通用码 `panorama_missing_field`（path 定位到具体键，如 `entities.x.label` / `entities.x.id_field` / `...fields.r.entity`）+ `panorama_missing_fields`（整个 fields 块缺失）+ `panorama_invalid_entity` / `panorama_invalid_field` / `panorama_invalid_view` / `panorama_invalid_states`（块非 map）+ `panorama_invalid_view_component`（component 非三原语），layer 归 schema。meta/version 缺省填充 warning 码 = `panorama_meta_default`。

## 3. Layer 2: schema 层（不短路，收集全部错误）

### 3.1 meta + version 校验
| 规则 | 错误码 |
|------|--------|
| meta.version 格式 `\d+\.\d+` | `panorama_invalid_version` |
| meta.updated_at 不可手填 | `panorama_manual_updated_at` |

### 3.2 entity 声明校验
| 规则 | 错误码 |
|------|--------|
| 实体名 `^[a-z][a-z0-9_]*$` | `panorama_invalid_entity_name` |
| label 必填 | `panorama_missing_field`（path=`entities.{x}.label`） |
| id_field 必填 + 指向 string 类型字段 | `panorama_missing_field`（path=`...id_field`） / `panorama_id_field_not_string` |
| 字段类型 ∈ {string,number,boolean,enum,ref,datetime} | `panorama_invalid_field_type` |
| enum 必有 values（非空数组） | `panorama_missing_enum_values` |
| enum values 元素合法（`^[a-z][a-z0-9_]*$`）+ 不重复 | `panorama_invalid_enum_value` / `panorama_duplicate_enum_value` |
| 同名 enum 字段跨实体 values 必须一致 | `panorama_enum_name_collision` |
| ref 必有 entity（指向已声明实体） | `panorama_missing_field`（path=`...entity`；存在性闭环在语义层 `panorama_unknown_ref_target`） |
| string.max 是正整数 / number min≤max | `panorama_invalid_max` / `panorama_invalid_range` |
| guard.field 指向本实体已声明字段 | `panorama_guard_unknown_field` |
| display.status_colors 值是合法 hex | `panorama_invalid_color` |
| display key 不在状态 enum values 内 | warning `panorama_warn_unknown_display_key`（不报错） |
| 护栏上限（实体/字段/view/enum值/card长度/transitions出边） | `panorama_limit_*` |

### 3.3 view 校验
| 规则 | 错误码 |
|------|--------|
| view id 唯一 + 格式 | `panorama_duplicate_view_id` / `panorama_invalid_view_id` |
| component ∈ {kanban,table,bar_chart} | `panorama_invalid_view_component` |
| view.entity 指向已声明实体 | （语义层校验） |
| kanban 必有 group_by + columns + card | `panorama_missing_field`（path 定位到具体键） |
| table 必有 columns | `panorama_missing_field` |
| bar_chart 必有 bucket{field,unit,days} | `panorama_missing_field` |

### 3.4 状态机校验
| 规则 | 错误码 |
|------|--------|
| states.field 是 enum 字段 | `panorama_state_field_not_enum` |
| states.initial 在 enum values 内 | `panorama_invalid_initial` |
| transitions from/to 在 enum values 内 | `panorama_invalid_transition_target` |
| terminal 中的状态在 enum values 内 | `panorama_invalid_terminal` |

### 3.5 system entity immutable 校验（Layer 2.5）

`checkSystemEntityImmutable(schema)` 在 schema 层（Layer 2）之后、Layer 3 之前跑：leader 提交的 task entity 字段（parser 后无 `system` 标记）若与 canonical `TASK_ENTITY_DEF` 不 deepEqual → 错误 `panorama_system_entity_immutable`（path=`entities.task`）。task 缺失（leader 未在 DSL 声明）→ pass，由后续 `injectSystemEntities` 兜底（见 `[P1]panorama_builtin.md §4`）。

- **实现文件**：`validation/validate_system_entity.ts`（独立文件，非 `validate_schema.ts`；后者仅 barrel re-export，见 `validation/index.ts:9`）。

## 4. Layer 3: 语义层（不短路，收集全部错误）

跨引用闭合校验——**编译期**而非运行时：

| 规则 | 错误码 | 触发条件 |
|------|--------|----------|
| ref.entity 指向已声明实体 | `panorama_unknown_ref_target` | ref entity 不在 entities 中 |
| view.entity 指向已声明实体 | `panorama_unknown_view_entity` | view entity 不存在 |
| kanban group_by 字段存在 | `panorama_unknown_group_by` | group_by 字段不在 entity fields 中 |
| kanban group_by 是 enum 字段 | `panorama_group_by_not_enum` | group_by 字段存在但非 enum |
| kanban group_by == states.field 才可拖拽 | — | 非 warning（渲染层判断，不报错） |
| table columns 字段存在 | `panorama_unknown_column` | 列字段不在 entity fields 中 |
| table sort.field 字段存在 | `panorama_unknown_sort_field` | sort.field 不在 entity fields 中 |
| bar_chart bucket.field 是 datetime | `panorama_bucket_not_datetime` | bucket field 非 datetime |
| bar_chart stack_by 是 enum | `panorama_stack_by_not_enum` | stack_by 非 enum |
| card 模板 `{field}` 字段存在 | `panorama_unknown_field_in_template` | 模板引用的字段不存在 |
| card 模板 `{ref.target}` ref 是 ref 类型 | `panorama_ref_navigation_on_non_ref` | 非 ref 字段用了点导航 |
| card 模板 `{ref.target}` 目标有 target 字段 | `panorama_unknown_ref_target_field` | 目标实体无该字段 |
| badges 字段存在 | `panorama_unknown_badge_field` | badge 引用的字段不存在 |
| ref 无环（实体间 ref 不成环） | `panorama_circular_ref` | A→B→A |
| terminal 态无出边 | `panorama_terminal_has_outgoing` | 终态在 transitions 表仍有出边（状态机自闭合） |

语义层 warnings（不阻塞 define）：kanban `columns` 未覆盖 group_by enum 全部值 → `panorama_warn_missing_column`，随 `result.warnings` 返回。

**system entity 恒在可引用**：`validateSemantic` 构造 `entityNames` 集合时追加 `Object.keys(SYSTEM_ENTITY_DEFS)`（纯内存操作，不触发 inject/write）——leader 即便未在 `entities` 声明 task，`view.entity` / `ref.entity` 指向 task 也合法。`checkViews` 在 `schema.entities[view.entity]` miss 时 fallback 到 `SYSTEM_ENTITY_DEFS[view.entity]` canonical def 继续下游校验（group_by/columns/filter/template/badges，不能仅 pass 跳过下游——否则字段漂移静默通过）；`panorama_unknown_view_entity` 仅在 schema.entities 与 SYSTEM_ENTITY_DEFS 两处都 miss 时报。与 `injectSystemEntities` 后置时序解耦（inject 仍后置，由 `checkSystemEntityImmutable` 抓 leader 改 task）。

- 实现：`validate_semantic.ts:33-36`（entityNames 集合追加）+ `validate_semantic.ts:78`（checkViews fallback）。

## 5. Layer 4: 数据安全层

define / validate（含 dryRun）且有存量实例时执行。对比旧 DSL vs 新 DSL 差异，判定变更是否破坏存量数据。

| 变更 | 判定 | 错误码 |
|------|------|--------|
| 删实体（有数据） | 破坏性 | `panorama_dropping_entity_data` |
| 删字段（有非空值） | 破坏性 | `panorama_dropping_field_data` |
| 收窄 enum（有存量值受影响） | 破坏性 | `panorama_enum_narrowed` |
| 改字段类型（有实例） | 破坏性 | `panorama_field_type_changed` |
| 改 states.field（有实例） | 破坏性 | `panorama_state_field_changed` |
| 扩大 terminal（有实例被锁） | 破坏性 | `panorama_terminal_expanded` |
| 收紧约束（有违规存量） | 破坏性 | `panorama_constraint_tightened` |

Layer 4 报 error → 新 DSL **不落盘**。agent 按 error 的 suggestion 重提 define：`approved:true` 让引擎自动生成默认 plan 迁移（archive 删除数据 / clip 越界值 / 状态值归位），或附显式 `migration` 方案全控（narrow_enum 必须带 mapping）——带 migration/approved 的重提走 `deferDataSafety` 跳过本层，由 migration 引擎裁决（`panorama_migration.md`）。

## 6. 实例写校验（create / update）

不碰 DSL，校验「实例值是否符合当前 DSL 约束」（Layer 2 子集）。**写库前**先经 `coerceRecord` 无损 coerce（见 §6.1），再喂进下表 check。

| 规则 | 错误码 |
|------|--------|
| 字段类型匹配 | `panorama_type_mismatch` |
| enum 值合法 | `panorama_invalid_enum_value` |
| ref 目标存在 | `panorama_dangling_ref` |
| required 字段非空 | `panorama_missing_required` |
| string.max 未超 | `panorama_value_too_long` |
| string.pattern 匹配 | `panorama_pattern_mismatch` |
| number 在 min/max 内 | `panorama_value_out_of_range` |
| datetime 可 parse | `panorama_invalid_datetime` |
| 状态字段值合法（create 时） | `panorama_invalid_initial_value` |

> **id 唯一性**：create 时**不再由校验引擎判定**——调用方（`runCreate` / `handleCreateEntity`）在 coerce+validate 之前用 `store.hasId(entity, id)` 短路：命中 → 返 `created:false`（skip-if-exists 幂等，不报错）；未命中 → 走建路径返 `created:true`。`panorama_duplicate_id` 已从校验码集合移除（保留作死码清理，不再产生）。

### 6.1 实例写前 coerce（coerceRecord）

`coerceRecord(entityDef, record): Record<string, unknown>` 按 entityDef.fields 声明类型无损 coerce 各字段值，返回**新 record**（不 mutate 入参；纯函数不抛异常）。用于 create / update 路径（tool `runCreate`/`runUpdate` + http `handleCreateEntity`/`handlePatchEntity`），在 `applyFieldDefaults` 之后、`validateInstance` 之前调用。

| 声明类型 + 实际值 | coerce 行为 |
|------------------|------------|
| number 字段 + string 值 | `Number(v)` 有限且 `String(Number(v))===v.trim()` → 转 number；否则保留原值 |
| string 字段 + number 值（有限） | → `String(v)` |
| boolean 字段 + 字面串 `"true"` / `"false"` | → 转 boolean |
| enum / ref / datetime 字段 / 其他值 | 原值返回（语义串/严格 id/ISO 解析交给 check） |
| `value == null` | 原值返回（null/空值语义交 required 校验） |

**无损 round-trip 是核心约束**——以下不 coerce（保留原值交下游 check 报错）：`"0x10"` / `"1.0"` / `"1e3"` / `""` / `"  "` / `"12a"` / boolean 字段传 `"True"` / `1` / `0`（过宽易误判）。boolean 仅认字面串 `"true"`/`"false"`。

实现：`validate_instance.ts:coerceFieldValue`（单字段分派）+ `coerceRecord`（按 fields 遍历）；barrel 导出 `validation/index.ts:14`。

### 6.2 错误信息增强（声明约束原文 + readSchema 引导）

`checkString` / `checkNumber` / `checkEnumValue` 三类 check 报错时 message 带声明约束原文（不只说"长度超限"等模糊语），suggestion 含 `panorama readSchema` / `GET schema` 引导（让 agent 自我定位字段约束）：

- `panorama_type_mismatch` / `panorama_value_too_long` / `panorama_pattern_mismatch`：message 含 `type=string` + `max=N` + `pattern=regex` 原文（按声明拼）。
- `panorama_value_out_of_range`：message 含 `min` / `max` 原文数值。
- `panorama_invalid_enum_value`：message 含完整 enum values 列表 + 声明类型 enum。

实现：`validate_instance.ts:eHint`（错误工厂，固定 suggestion 引导语）+ `declaredStringConstraints` / `declaredNumberConstraints`（拼接声明约束原文）。

## 7. transition 校验

| 规则 | 错误码 | suggestion |
|------|--------|------------|
| from 是合法状态 | `panorama_illegal_transition` | 检查实例当前状态 |
| to 是合法状态 | `panorama_illegal_transition` | 检查目标状态 |
| from 不是终态 | `panorama_terminal_locked` | 终态不可跃迁，需新建实例 |
| from→to 在 transitions 表 | `panorama_illegal_transition` | 列出合法目标状态 |
| guard 条件满足 | `panorama_guard_failed` | 列出 guard + 当前实例值 |
| 实体有状态机 | `panorama_no_state_machine` | 该实体未声明 states，不可跃迁 |
| 实体存在 | `panorama_unknown_entity` | entity 名不在 DSL 中 |

## 8. 校验器调用入口（三路共用，决策 6）

| 入口 | 校验范围 |
|------|----------|
| `panorama(define, dsl, dryRun)` 工具 | Layer 1-4 |
| `POST /squad/:id/panorama/schema`（HTTP API） | Layer 1-4 |
| `POST /squad/:id/panorama/entities/:entity`（create 实例） | §6 实例校验 |
| `POST .../transition`（拖拽/工具） | §7 transition 校验 |
| 拖拽（UI → HTTP transition） | §7 transition 校验（同规则） |

**规则唯一源 = DSL**。所有入口的校验逻辑从同一份 DSL 派生。

## 9. 错误码命名约定

`panorama_` 统一前缀 + 语义化中段（invalid/missing/unknown/dropping/narrowed/illegal/terminal/guard/dangling/limit）+ 具体对象后缀。

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
