---
type: interface
title: Panorama DSL 规范
priority: P1
status: active
updated: 2026-08-05
since: v0.0.189.dsl_board
related: [[P1]panorama_overview.md, [P1]panorama_validation.md, [P1]panorama_store.md, [P1]panorama_builtin.md]
---

# Panorama DSL 规范（meta / team / entities / views + 字段类型 + 状态机 + card 模板 + 护栏）

> 权威源：本文件是 panorama DSL 的**字段级契约权威**（schema / 类型 / 约束 / 护栏）。调研凝练自 `specs/research/v0.0.189.dsl_board/panorama_dsl_schema.md`（去调研口吻改现状陈述）。
> 设计目标（决策 1）：**LLM 生成可靠 + 可校验**——啰嗦但无二义、显式优于省略、JSON Schema 可逐条校验。

## 1. 顶层结构

```yaml
meta:        # §2
version:    # §3
entities:    # §4（核心，map：key=实体名）
views:       # §5（数组，有顺序=tab 顺序）
```

顶层四块：`meta` / `version` / `entities`（map，key=实体名） / `views`（数组，有顺序 = tab 顺序）。`meta` 和 `version` 缺失时引擎用默认值填充（meta.version="1.0"），追加 warning，不报错。

## 2. meta 块

```yaml
meta:
  version: "1.0"              # DSL schema 版本（semver major.minor，迁移引擎用）
  author: "leader-session-id" # 首次定义者 session id（审计追溯）
  created_at: "2026-07-22T10:00:00Z"  # ISO 8601，首次定义时间
  updated_at: "2026-07-22T14:30:00Z"  # ISO 8601，最近 define 时间（引擎自动维护，agent 不可手填）
```

- `version` 是 **DSL schema 版本**，非业务版本。字段类型集 / 视图语法 / 状态机模型变更时 bump。v1 = `"1.0"`。
- `updated_at` 由引擎每次 `define` 成功时自动写，**agent 不可手填**（校验层拒收非引擎写的 updated_at，`panorama_manual_updated_at`）。

## 3. version 块（纯展示）

```yaml
version:
  id: dev              # 固定标识（同 squadId），引擎不依赖此字段路由，仅展示用
  name: Dev 团队        # 展示名
  board_name: CI/CD 看板 # 看板标题（toolbar 显示）
```

纯展示字段，无业务逻辑依赖。`id` 在 v1 等于 squadId（引擎从 squad 上下文取，不校验一致性）。

## 4. entities 块（核心）

每个 entity = map entry，key = 实体名（`^[a-z][a-z0-9_]*$`）。

```yaml
pipeline_run:
  label: 流水线运行
  id_field: id              # 主键字段名（须指向 fields 中一个 string 类型字段）
  fields:                   # §4.2
  states:                   # §4.3（可选；无状态机实体不可 kanban 拖拽）
  display:                  # §4.4
  system: true              # §4.5（可选；仅系统固定 entity，leader DSL 写了被 parser 丢弃）
```

### 4.5 system 标记（系统固定 entity）

`system?: true` 标记**系统固定 entity**（leader 不可 edit/delete schema，防 hook/reminder 崩）。

- **parser 不识别此字段**：`dsl/parser.ts:parseEntity` 只读固定字段集（label/id_field/fields/states/display），leader 在 DSL 里写 `system: true` 被 parser 丢弃 → leader 无法自行标记 system。
- **仅由 `injectSystemEntities` 程序化设值**：系统 entity（目前仅 `task`，定义在 `panorama/builtin/task-schema.ts:TASK_ENTITY_DEF`）由 inject 在 define 流程 / lazy migration 时强制注入（覆盖任何 leader 提交的同名变体，system-wins）。
- **leader define 改 system entity 字段**：`checkSystemEntityImmutable`（`validation/validate_system_entity.ts`）比较 leader 提交字段（parser 后无 system）与 canonical（不含 system 比较）→ 不一致拒（`panorama_system_entity_immutable`）。
- 详见 `[P1]panorama_builtin.md §3-§4`（lazy migration + system 标记三段闭环）。

### 4.2 字段类型集（v1 = 6 种）

| 类型 | 约束键 | 示例 |
|------|--------|------|
| `string` | `max`(int，缺省不限长) / `pattern`(JS 正则) / `required`(bool) | `branch: { type: string, max: 200 }` |
| `number` | `min` / `max` / `required` | `duration_sec: { type: number, min: 0 }` |
| `boolean` | — | `is_hotfix: { type: boolean }` |
| `enum` | `values`(string[], 必填) / `required` | `status: { type: enum, values: [queued, running, success, failed] }` |
| `ref` | `entity`(string, 必填，指向另一实体名) / `required` | `pipeline_ref: { type: ref, entity: pipeline_run }` |
| `datetime` | `required` | `started_at: { type: datetime }` |

- `label`（可选，全类型通用）：字段中文列名/展示名，table 表头与实体弹层表单 label 用；缺省 = 字段名。非 string 值忽略。
- `required=true`：实例缺此字段时 schema 层报错（`panorama_missing_required`）。
- `pattern`：实例值必须 match；空值（null/缺省）跳过校验。
- number 存为 IEEE 754 double；实例值非数值（NaN）= 实例写校验 `panorama_type_mismatch`。**实例写前会先过 `coerceRecord` 无损 coerce**（number↔string / boolean←"true","false"）——同值类型拧巴不报错（如 number 字段传 `"1928"`），有损/不合法值（`"0x10"`/`""`/`"12a"` 等）保留原值交 check 报错。详 `[P1]panorama_validation.md §6.1`。

### 4.3 状态机（states）

```yaml
states:
  field: status               # 状态字段名（须是 entity 的一个 enum 类型字段）
  initial: queued             # 创建实例时的默认状态
  transitions:                # 跃迁表（map：from → to[]）
    queued: [running]
    running: [success, failed]
  terminal: [success, failed] # 终态列表（终态不可再跃迁）
```

- `field` 指向的 enum 字段 = 状态字段。`group_by == states.field` 时 kanban 可拖拽（拖动 = 发起状态跃迁，决策 5）。
- `initial` 必须在 enum values 内。`transitions` 的 from/to 必须在 enum values 内。
- `terminal` 列表中的状态不可再跃迁（`panorama_terminal_locked`）。
- guard（v1 简化）：跃迁目标 longhand 对象可带 `guard` 结构化条件——`running: [{ to: success, guard: { field: duration_sec, op: gt, value: 0 } }]`。guard = `{ field, op, value }` 三键对象（**不支持字符串表达式**）：`field` 须是本实体已声明字段（否则 schema 层 `panorama_guard_unknown_field`）；`op ∈ eq | ne | gte | lte | gt | lt | in | not_in`；`value` 为 string/number/boolean（`in`/`not_in` 时为 string[]）。transition 时引擎对当前实例求值，不满足 → `panorama_guard_failed`（见 `panorama_validation.md §7`）。shorthand `running: [success]` = `[{ to: success }]` 无 guard。

### 4.4 display（展示配置）

```yaml
display:
  status_labels: { queued: 排队中, running: 运行中, success: 成功, failed: 失败 }
  status_colors: { queued: "#8b949e", running: "#58a6ff", success: "#3fb950", failed: "#f85149" }
  env_labels: { staging: 预发, prod: 生产 }   # 字段级映射（field=env 的 enum 字段）
```

- `status_labels`：enum 值 → 展示名（缺省 = 原始值）。**全局映射，对实体所有 enum 字段生效**（不止状态机字段）。用于 kanban 列头、badge、table cell。
- `{field}_labels`：字段级 enum 值 → 展示名（`field` 须是本实体的 enum 字段名）。**优先级高于 status_labels**——不同 enum 字段有同名值需区分含义时用（如 `env=prod` vs `status=prod`）。无 states 实体同样生效。
- 渲染查找顺序：`{field}_labels?.[value]` → `status_labels?.[value]` → 原始值（状态机字段直接走 `status_labels`）。
- `status_colors`：状态值 → hex 色（缺省 = `#8b949e`）。用于 kanban 列 dot、badge 边框、bar_chart 分段色。
- 校验：`status_labels`/`status_colors` 的 key 须在实体**任一** enum 字段 values 并集内；`{field}_labels` 的 key 须在该字段 values 内、`field` 须真实存在——不满足 → warning `panorama_warn_unknown_display_key`（见 panorama_validation.md）。

## 5. views 块

```yaml
views:
  - id: run_kanban       # 唯一 id（^[a-z][a-z0-9_]*$）
    label: 流水线看板      # tab 标题
    entity: pipeline_run # 渲染实体名
    component: kanban    # kanban / table / bar_chart
    filter:              # 可选（v0.0.240）：field:value 精确匹配，多键 AND；前端 fetch 透传 ?filter=
      status: running
    # component 专属配置见 §5.1-5.3
```

### 5.0 view.filter（v0.0.240 — 默认过滤声明）

- ViewDef（kanban/table/bar_chart）新增可选 `filter: Record<string, 基本类型>`——field:value 精确匹配，多键 AND（同 `GET entities?filter=k:v,k2:v2` 语义）。
- **用途**：① 修复"3 个 table 筛出一样"（leader 在 view 写 filter 曾被前端忽略）；② task builtin view 默认 `filter: { archived: false }` 隐藏归档项。
- **校验**（语义层）：filter 的 key 须是 entity 已声明字段（否则 `panorama_unknown_filter_field`）；enum 字段值须在 values 内（否则 warning `panorama_warn_unknown_filter_value`）。
- **前端透传**：fetch `GET entities` 时把 view.filter 序列化为 `?filter=k:v,k2:v2`（与 `handleListEntities` 现有解析对齐）。
- **归档约定**：entity 想要"默认隐藏归档"只需 ① 声明 `archived: { type: boolean }` 字段 + ② view 加 `filter: { archived: false }`。panorama 不内置 archive 概念，全靠字段 + filter 表达。

### 5.1 kanban

```yaml
component: kanban
group_by: status        # 必填：分组字段（须是 entity 的 enum 字段）
columns: [queued, running, success, failed]  # 必填：列顺序
card:                   # 必填
  title: "{id} · {branch}"
  badges: [status, commit]
  footer: "耗时 {duration_sec}s"
```

- `group_by == states.field` 时列可拖拽（决策 5）。拖动 = 发起 transition（HTTP API），非法跃迁拒绝 + 可读原因。
- card 模板语法见 §5.5。

### 5.2 table

```yaml
component: table
columns: [id, branch, status, duration_sec, started_at]  # 必填：列字段名
sort: { field: started_at, order: desc }   # 可选
limit: 50                                    # 可选
```

### 5.3 bar_chart

```yaml
component: bar_chart
bucket: { field: started_at, unit: day, days: 7 }  # 必填
stack_by: status                                     # 可选（enum 字段名）
```

- v1 仅 day 粒度 + 近 N 天窗口。`bucket.field` 须是 datetime 类型。`stack_by` 须是 enum 字段。

### 5.5 card 模板（插值语法）

| 语法 | 语义 |
|------|------|
| `{field}` | 当前实例的字段值 |
| `{ref_id.target_field}` | ref 字段指向的目标实例字段值（一级嵌套） |
| `{field\|fallback}` | 字段为 null/空时用 fallback 文本 |
| `{{field}}` | 原样输出 `{field}`（字面花括号转义） |

插值正则（复合：先匹配 `{{...}}` 转义，再匹配 `{...}` 插值）：`/\{\{([^{}]*)\}\}|\{(\w+)(?:\.(\w+))?(?:\|([^}]*))?\}/g`（捕获：1=转义内容，2=字段名，3=目标字段，4=fallback）。

**编译期校验**（语义层，非运行时静默）：
- `{field}` field 不存在 → `panorama_unknown_field_in_template`（编译时报错，修复回路能自动修）。
- `{ref_id.target}` ref_id 不是 ref 类型 → `panorama_ref_navigation_on_non_ref`。
- `{ref_id.target}` 目标实体无 target 字段 → `panorama_unknown_ref_target_field`。
- 运行时：field 存在但值为 null → 渲染空串或 fallback；ref 目标实例已删 → 渲染 fallback 或空串（不报错）。

`badges`：字段名数组。enum 字段 → chip 带 label+color；其他类型 → 纯文本标签。字段不存在 = 语义层报错。

## 6. 护栏（上限约束，schema 层校验）

| 约束项 | 上限 | 错误码 |
|--------|------|--------|
| 实体数 | 20 | `panorama_limit_entities` |
| 字段数/实体 | 30 | `panorama_limit_fields` |
| view 数 | 10 | `panorama_limit_views` |
| enum 值数 | 15 | `panorama_limit_enum_values` |
| card 模板长度 | 200 字符 | `panorama_limit_card_template` |
| ref 嵌套深度 | 1（`{ref.target}`） | —（模板语法结构保证：点导航最多一级，无独立错误码） |
| transitions 出边数/状态 | 10 | `panorama_limit_transitions` |

超限 → `panorama_limit_*`，suggestion 提示具体超了哪项 + 建议拆分。

## 7. 设计原则（LLM 生成可靠性）

1. **显式优于省略**：所有约束显式写，不靠隐含默认值。
2. **shorthand 兼容 longhand**：简单场景一行搞定；复杂场景展开写。渐进式复杂度。
3. **编译期可校验**：所有跨引用（ref target / template field / group_by / transitions）在 define 时编译期校验。
4. **错误自解释**：校验失败返回 `{code, path, message, suggestion}`（见 `panorama_validation.md`）。
5. **flat map 优先**：entities / fields 都是 flat map（非数组/非嵌套对象），减少 LLM 缩进出错。

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
