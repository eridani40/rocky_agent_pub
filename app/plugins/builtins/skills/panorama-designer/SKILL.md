---
name: panorama-designer
description: 业务全景看板（panorama）搭建与演进工作流。何时加载——你是 squad leader，user 要搭业务看板/全景看板/数据看板（CI/CD、工单、审批、项目管道等），或要调整已有看板结构时。你生成 DSL → panorama(define) → 看板出现；DSL 作者是你（agent），不是 user。权威依据 specs/tech/squad/[P1]panorama_dsl.md + [P1]panorama_tools.md。
---

# Panorama Designer（业务全景看板搭建）

> 本技能是 leader 搭建 panorama 看板的**操作手册**（L1，按需加载）。panorama = 业务全景看板：你听懂 user 需求 → 生成 DSL → `panorama(define)` → 看板出现。user 不写 DSL、不看 DSL——建模质量全在你。

## 1. 工作流（MANDATORY，按序执行）

1. **听懂需求**：user 要什么看板、业务对象是什么、关心哪些字段、状态怎么流转。不清楚就追问 user，不要猜。
2. **选模板**：`templates/` 下有接近的先拿来改（见 §5），没有就从空白写。
3. **读现状**：`panorama({ action: "get_schema" })`——返回 `dsl: null` = 新建；有 DSL = 演进（见 §4）。
4. **生成 DSL**：按 §2 规范 + §3 建模模式写全量 YAML。
5. **预检**：`panorama({ action: "define", dsl, dryRun: true })`。有错 → 按返回的 `{code, path, suggestion}` 修复 → 重跑，直到 `ok: true`。
6. **落盘**：`panorama({ action: "define", dsl, dryRun: false })`。破坏性变更（删实体/字段、收窄 enum、改类型）：无存量数据直接过；有存量会被 `data_safety` 拦（dryRun 预检即可见）——按错误 suggestion 重提：`approved: true` 让引擎自动迁移（archive 删除数据 / 截断越界值 / 搬状态值），或附 `migration` 显式控制（narrow_enum 需 mapping）。重大变更先问 user 拿确认再落盘。
7. **汇报**：告诉 user 看板已就绪，去团队入口「业务全景」查看；说明有哪些 tab、怎么录入数据。

## 2. DSL 规范手册（精简版；权威细节读 specs/tech/squad/[P1]panorama_dsl.md）

### 顶层四块
`meta`（version 必填 `"1.0"`；**不写 updated_at**，引擎自动维护）/ `version`（纯展示块：id/name/board_name）/ `entities`（map，key=实体名 `^[a-z][a-z0-9_]*$`）/ `views`（数组，顺序=tab 顺序）。

### 实体结构
```yaml
entities:
  work_item:
    label: 工作项           # 必填
    id_field: id            # 必填，指向一个 string 字段
    fields: { ... }         # 必填，见下表
    states: { ... }         # 可选；有状态机的实体 kanban 才可拖拽
    display: { status_labels: {...}, status_colors: {...} }  # 可选，hex 色；另支持 {field}_labels
```

**display 值映射**（enum 值 → 中文名，用于 kanban 列头 / badge / table cell）：
- `status_labels`：全局映射，对**所有** enum 字段生效（不止状态机字段）。
- `{field}_labels`：字段级映射（如 `env_labels`），优先级高于 status_labels——不同 enum 字段有同名值需区分含义时用。
- 查找顺序：`{field}_labels` → `status_labels` → 原值。key 不在对应 enum values 内时服务端会给 warning。

### 字段 6 类型
| type | 必填约束 | 可选约束 |
|---|---|---|
| string | — | max / pattern / required |
| number | — | min / max / required |
| boolean | — | — |
| enum | values: [...] | required |
| ref | entity: <另一实体名> | required |
| datetime | — | required |

所有类型均可带 `label`（可选，字段中文列名，缺省 = 字段名）——table 表头 / 实体弹层表单展示用。

### 状态机（states）
```yaml
states:
  field: status        # 指向本实体一个 enum 字段
  initial: backlog     # 创建默认状态，必须在 enum values 内
  transitions:         # from → to[]；from/to 都必须在 enum values 内
    backlog: [todo]
    todo: [{ to: in_progress }]   # longhand 可加 guard: {field, op, value}
  terminal: [done]     # 终态不可再跃迁
```

### 视图 3 原语（每个 view 必有 id/label/entity/component）
- `kanban`：`group_by`（enum 字段）+ `columns`（列顺序）+ `card`（模板）。`group_by == states.field` 时可拖拽，拖动 = 状态跃迁。
- `table`：`columns`（字段名数组）+ 可选 `sort: {field, order}` / `limit`。
- `bar_chart`：`bucket: {field: <datetime>, unit: day, days: N}` + 可选 `stack_by: <enum>`。

### card 模板插值
`{field}` 字段值 · `{ref_id.target}` ref 目标字段（一级嵌套）· `{field|fallback}` 空值兜底 · `{{field}}` 字面花括号。

### 护栏（超限必错）
实体 ≤20 · 字段/实体 ≤30 · view ≤10 · enum 值 ≤15 · card 模板 ≤200 字符 · transitions 出边/状态 ≤10 · ref 嵌套 ≤1 级。

### 常见错误与自修复
define 失败返回 `errors: [{layer, code, path, message, suggestion}]`——**path 指哪修哪，suggestion 就是修复建议**，改完重跑 dryRun。高频错误：
- YAML 缩进错 / 漏顶层键（layer=syntax）
- card 引用不存在字段 → `panorama_unknown_field_in_template`
- group_by/stack_by 指向非 enum 字段、bucket.field 非 datetime
- transitions 的 from/to 或 initial 不在 enum values 内
- ref.entity 指向不存在的实体
- 手写了 meta.updated_at → `panorama_manual_updated_at`（删掉它）
- 同名 enum 字段跨实体 values 不一致 → `panorama_enum_name_collision`（给状态字段起实体专属名，如 deploy_status / phase）

### 完整小例子
```yaml
meta: { version: "1.0" }
version: { id: team, name: 示例团队, board_name: 示例看板 }
entities:
  ticket:
    label: 工单
    id_field: id
    fields:
      id: { type: string }
      title: { type: string, max: 200, required: true }
      status: { type: enum, values: [open, doing, done] }
      created_at: { type: datetime }
    states:
      field: status
      initial: open
      transitions: { open: [doing], doing: [done], done: [] }
      terminal: [done]
views:
  - id: ticket_kanban
    label: 工单看板
    entity: ticket
    component: kanban
    group_by: status
    columns: [open, doing, done]
    card: { title: "{id} {title}", badges: [status] }
```

## 3. 建模模式（业务描述 → 实体+状态机+视图）

**状态机优先**：先想清楚业务对象的**生命周期**——「这个东西从出生到消亡经过哪几步？哪步能回退？什么是终点？」字段和视图都是状态机的投影。

- **管道流**（CI/CD、发布流水线）：线性状态机 queued→running→success/failed，终态收口；kanban 看流转 + table 看历史 + bar_chart 看趋势。
- **工单**（任务/客服/运维）：backlog→doing→done，允许回退边（review→in_progress）；优先级/负责人做 badges。
- **审批**（请假/报销/上线）：pending→approved/rejected，approved 后可再接执行态；拒绝是终态，或显式画「重提」回边。

多实体用 `ref` 字段关联（如 deployment 引 pipeline_run），card 里 `{ref_id.target}` 展示关联信息。

## 4. 演进规则（已有看板时）

`get_schema` 返回已有 DSL 时，define 是**合并演进不是覆盖**：
- 先读当前 DSL，**在原有基础上**加实体/字段/视图——user 已有数据不能丢。
- 纯新增 = 安全变更，直接 dryRun → 落盘。
- 删实体/字段、改字段类型、收窄 enum 值 = **破坏性变更**：无存量数据直接过；有存量时 define 被 `data_safety` 拦 → 按 suggestion 重提 `approved: true`（引擎自动迁移：archive / clip / 搬状态值），或附 `migration` 显式控制（`narrow_enum` 需 `mapping`，格式见 specs/tech/squad/[P1]panorama_migration.md）。重大变更先向 user 说明影响、拿到确认再提。
- 改视图/label/配色 = 展示层调整，非破坏性。
- 删实例数据（非结构）：`panorama({ action: "delete", entity, id })`。

## 5. 模板库索引（templates/）

| 模板 | 适用场景 | 建模要点 |
|---|---|---|
| `templates/ci-cd.yaml` | 研发交付类：流水线/部署/故障 | pipeline_run 线性流 + deployment 环境推进 + incident 处理流，ref 关联 |
| `templates/team-work.yaml` | 通用团队工作管理（**user 说不清要什么时的默认起点**） | work_item 五态工作流（backlog→…→done）+ sprint 迭代，ref 关联 |

用法：读模板全文 → 按 user 业务改实体名/字段/状态/文案 → 走 §1 工作流。模板是种子不是成品——**必须按需求裁剪**，不要原样落盘。

## 6. 参考（L2 深度钻取）

- `specs/tech/squad/[P1]panorama_dsl.md`（DSL 字段级权威契约）
- `specs/tech/squad/[P1]panorama_tools.md`（panorama 工具 8 action 全表 + 权限矩阵）
- `specs/tech/squad/[P1]panorama_validation.md`（四层校验规则 + 错误码全表）
- `specs/tech/squad/[P1]panorama_migration.md`（破坏性变更迁移方案格式）
