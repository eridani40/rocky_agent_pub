---
type: research
title: Panorama DSL 完整规范
version: v0.0.189.dsl_board
status: draft
updated: 2026-07-22
---

# Panorama DSL 完整规范

> 调研产出：req.md §11 开放问题 1（DSL schema 细节）的回答。基于 demo `ci-cd.yaml` 验证过的核心结构，
> 补全字段类型集、状态机增强、视图配置完备性、card 模板语法、meta 审计、护栏。
> 设计目标（决策 1）：**LLM 生成可靠 + 可校验**——啰嗦但无二义、显式优于省略、JSON Schema 可逐条校验。

---

## 1. 顶层结构

```yaml
meta:                    # 见 §2
  version: "1.0"
  author: "leader-session-id"
  created_at: "2026-07-22T10:00:00Z"
  updated_at: "2026-07-22T14:30:00Z"
team:                    # 见 §3
  id: dev
  name: Dev 团队
  board_name: CI/CD 看板
entities:                # 见 §4（核心）
  pipeline_run:
    ...
views:                   # 见 §5
  - id: run_kanban
    ...
```

顶层三块 + meta：`meta` / `team` / `entities` / `views`。`entities` 是 map（key=实体名），`views` 是数组（有顺序 = tab 顺序）。

---

## 2. meta 块

```yaml
meta:
  version: "1.0"              # schema 版本号（semver major.minor），迁移引擎用
  author: "leader-session-id" # 首次定义者的 session id（审计追溯）
  created_at: "2026-07-22T10:00:00Z"  # ISO 8601，首次定义时间
  updated_at: "2026-07-22T14:30:00Z"  # ISO 8601，最近 define 时间（引擎自动更新）
```

- `version` 是 **DSL schema 版本**，不是业务版本。当字段类型集、视图配置语法、状态机模型等引擎契约变更时 bump。v1 = `"1.0"`。迁移引擎用它做跨版本升级（v2 引擎读 v1 DSL 时按 version 判断兼容路径）。
- `author` + `created_at` + `updated_at` 是审计三件套。`updated_at` 由引擎在每次 `define` 成功时自动写入，**agent 不可手填**（校验层拒收非引擎写的 updated_at）。

---

## 3. team 块

```yaml
team:
  id: dev              # 固定标识（同 squadId），引擎不依赖此字段路由，仅展示用
  name: Dev 团队        # 展示名
  board_name: CI/CD 看板 # 看板标题（toolbar 显示）
```

纯展示字段，无业务逻辑依赖。`id` 在 v1 等于 squadId（引擎从 squad 上下文取，不校验 team.id 与 squadId 一致——冗余信息，agent 填啥都行）。

---

## 4. entities 块（核心）

每个 entity 是一个 map entry，key = 实体名（`[a-z][a-z0-9_]*`），value 结构如下：

### 4.1 实体声明

```yaml
pipeline_run:
  label: 流水线运行          # 展示名（复数场景、表头、空态文案）
  id_field: id              # 主键字段名（必须指向 fields 中一个 string 类型字段）
  fields:                   # §4.2
    ...
  states:                   # §4.3（可选——无状态机的实体只能 table/bar_chart 渲染，不可 kanban 拖拽）
    ...
  display:                  # §4.4
    ...
```

### 4.2 fields — 字段类型集

v1 = **6 种基础类型**。不引入 duration/json/money（理由见 §4.2.7）。

```yaml
fields:
  id:           { type: string }
  branch:       { type: string, max: 200 }
  commit:       { type: string, pattern: "^[0-9a-f]{7,40}$" }
  status:       { type: enum, values: [queued, running, success, failed] }
  duration_sec: { type: number, min: 0 }
  is_hotfix:    { type: boolean }
  pipeline_ref: { type: ref, entity: pipeline_run }
  started_at:   { type: datetime }
```

#### 4.2.1 string

```yaml
branch: { type: string, max: 200 }
```

| 约束 | 键 | 类型 | 默认 | 说明 |
|------|-----|------|------|------|
| 最大长度 | `max` | int | 500 | 字符数上限（LLM 易产出超长，护栏） |
| 正则 | `pattern` | string(JS) | — | 实例值必须 match；空值（null/缺省）跳过校验 |
| 必填 | `required` | bool | false | 实例缺此字段时 schema 层报错 |

#### 4.2.2 number

```yaml
duration_sec: { type: number, min: 0, max: 86400 }
```

| 约束 | 键 | 类型 | 默认 | 说明 |
|------|-----|------|------|------|
| 最小值 | `min` | number | — | |
| 最大值 | `max` | number | — | |
| 必填 | `required` | bool | false | |

存为 JS number（IEEE 754 double）。实例值非 finite（NaN/Infinity）= schema 层错误。

#### 4.2.3 boolean

```yaml
is_hotfix: { type: boolean }
```

实例值仅接受 `true` / `false`（YAML 的 `yes/no/on/off` 在 parse 时由 yaml 库归一化为 boolean，引擎再做 typeof 校验）。无额外约束键。

**为何加 boolean**：业务看板大量需要二元标记（是否紧急/是否阻塞/是否通过审批）。用 enum `[true, false]` 表达是可行的但冗余且 LLM 易写成 string `"true"`，独立类型让校验更确定、渲染层可直出 toggle。

#### 4.2.4 enum

```yaml
status: { type: enum, values: [queued, running, success, failed] }
priority: { type: enum, values: [low, medium, high, urgent] }
```

| 约束 | 键 | 类型 | 说明 |
|------|-----|------|------|
| 值集 | `values` | string[] | **必填**。每个值 `[a-z][a-z0-9_]*`，**全 board 内同名字段值集必须一致**（跨实体同名 enum，如两个实体都有 `priority`，values 必须相同） |
| 必填 | `required` | bool | 默认 false |

- enum 值上限 15（§6 护栏）。
- 展示文案/配色在 entity.display 块声明（§4.4），不在字段定义里——关注分离。

#### 4.2.5 ref

```yaml
pipeline_ref: { type: ref, entity: pipeline_run }
deploy_run: { type: ref, entity: pipeline_run, required: true }
```

| 约束 | 键 | 类型 | 说明 |
|------|-----|------|------|
| 目标实体 | `entity` | string | **必填**。必须指向同 board 内已声明的实体名 |
| 必填 | `required` | bool | 默认 false |

- ref 的实例值 = 目标实体的 `id_field` 值（字符串）。引擎在 create/update 时校验目标存在（语义层 §validation doc）。
- **不支持自引用链路深度校验**（v1）：ref 只校验目标 id 存在，不递归校验目标自身的 ref 字段。

#### 4.2.6 datetime

```yaml
started_at: { type: datetime }
```

- 实例值 = ISO 8601 字符串（`2026-07-22T10:00:00Z` 或带偏移 `2026-07-22T18:00:00+08:00`）。
- 引擎 parse 时用 `new Date(iso)`；invalid date = schema 层错误。
- 无额外约束键（min/max datetime 在 v1 不做——业务需求弱，增量引入）。

#### 4.2.7 不引入的类型及理由

| 候选 | 结论 | 理由 |
|------|------|------|
| `duration` | ❌ v1 不加 | `number` + 字段命名约定（`duration_sec`/`timeout_ms`）已覆盖；独立类型增加校验复杂度但表达力增益小 |
| `json` | ❌ v1 不加 | 自由结构 blob 无法逐字段校验，与决策 1「可校验」目标矛盾；鼓励 agent 建模时用独立字段而非塞 json |
| `money` | ❌ v1 不加 | `number` + 语义化字段名（`amount_cny`）已够；独立类型引入币种/精度问题域，v1 场景不需要 |

**v2 再评估**：当实际使用中 agent 反复用 number 模拟 duration/money 且出现格式不一致时，升级为独立类型。

### 4.3 states — 状态机

```yaml
states:
  field: status                    # 状态字段名（必须指向 fields 中一个 enum 类型字段）
  initial: queued                  # 新建实例的初始状态（必须是 enum values 之一）
  transitions:                     # 跃迁表（见下）
    queued:  [running, failed]
    running: [success, failed]
    success: []
    failed:  []
  terminal: [success, failed]      # 终态声明（终态实例不可再跃迁）
```

#### 跃迁表格式：shorthand + longhand 混用

```yaml
transitions:
  queued: [running, failed]                # shorthand：纯目标列表
  running:                                  # longhand：带 guard 的目标
    - success
    - to: failed
      guard: { field: attempts, gte: 3 }   # 仅当 attempts >= 3 时允许 → failed
  success: []                               # 空数组 = 无出边（但不是终态仍可被其他实体 ref）
```

- **shorthand** `from: [to1, to2]` = 无条件跃迁到 to1/to2。demo 用的就是这个，向后兼容。
- **longhand** `from: [{to, guard?}]` = 带可选 guard 的跃迁。guard 是简单的**字段值条件**（见 §4.3.1）。
- **混合写法**：同一 from 下 shorthand 和 longhand 可混用（数组元素是 string = shorthand，是 object = longhand）。
- **自跃迁**（from == to）允许，视为 no-op 幂等更新。
- **未声明的 from**：transitions 中不出现的 enum 值 = 该状态下无任何出边（等同于空数组）。但如果是 terminal 则应在 `terminal` 显式声明。

#### 4.3.1 guard 条件（v1 可选，结构化）

```yaml
guard:
  field: attempts        # 当前实例的字段名
  gte: 3                 # 条件操作符（见下）
```

v1 支持的操作符（单一，多条件用多 guard 对象数组 `guard: [{field, gte}, {field, in}]` 表示 AND）：

| 操作符 | 语义 | 值类型 |
|--------|------|--------|
| `eq` | == | string/number/boolean |
| `ne` | != | 同上 |
| `gte` | >= | number |
| `lte` | <= | number |
| `gt` | > | number |
| `lt` | < | number |
| `in` | ∈ | array |
| `not_in` | ∉ | array |

- guard 校验在 `validateTransition` 中执行，不满足 = `panorama_guard_failed`（validation doc §语义层）。
- **设计边界**：guard 只读当前实例自身字段，不跨实体查询、不支持表达式嵌套。复杂业务规则走 agent 在 `transition` 调用前的预检逻辑，不塞进 DSL。

#### 4.3.2 history / 审计

**不另设 history 字段**。每次状态跃迁自动写入 `events.jsonl`（append-only 事件流），含 `{seq, ts, type, entity, summary, payload: {id, from, to, source}}`。事件流即审计日志。决策 7 已定存储文件制 + append-only 事件流。

#### 4.3.3 拖拽与状态机的关系

决策 5 已定：`group_by == states.field` 时 kanban 列允许拖拽。补充：
- 非 states.field 的 group_by（如 `env`）= 纯分组展示，拖拽 = 直接 patch group_by 字段（不走 transitions 表）。
- states.field 的 group_by 拖拽 = 发起 transition，过 transitions 表 + terminal 锁 + guard。非法跃迁拒绝 + 可读原因。

### 4.4 display — 展示配置

```yaml
display:
  status_labels:          # {enum值: 展示文案}，键名 = 字段名 + _labels
    queued: 排队中
    running: 运行中
    success: 成功
    failed: 失败
  status_colors:          # {enum值: hex色值}，键名 = 字段名 + _colors
    queued: "#8b949e"
    running: "#4c9aff"
    success: "#3fb950"
    failed: "#f85149"
  env_labels:             # 任意 enum 字段都可配 labels/colors
    staging: 预发环境
    prod: 生产环境
```

**约定（延续 demo）**：任何 enum 字段 `foo` 都可在 display 块配 `foo_labels`（值→文案）和 `foo_colors`（值→hex 色值）。
- 缺省 `foo_labels` → 渲染原值。
- 缺省 `foo_colors` → 渲染默认灰色 `#8b949e`。
- labels/colors 的 key 必须是 enum values 的子集（多余 key = schema 层警告，不报错；缺失 key = 渲染原值）。

---

## 5. views 块

views 是数组，每个元素一个视图（= 一个 tab）。顺序即 tab 顺序。

### 5.1 通用字段

```yaml
- id: run_kanban          # 唯一标识（board 内不重复）
  title: 流水线看板         # tab 标题
  component: kanban        # 组件类型（kanban / table / bar_chart）
  entity: pipeline_run     # 数据源实体名（必须指向 entities 中已声明的实体）
```

### 5.2 kanban

```yaml
- id: run_kanban
  title: 流水线看板
  component: kanban
  entity: pipeline_run
  group_by: status         # 分组字段（必须是 entity 的 enum 字段）
  columns: [queued, running, success, failed]  # 列顺序（必须是 group_by 字段的 enum values 子集或全集）
  card:                    # 卡片模板（见 §5.5）
    title: "{id} · {branch}"
    badges: [status, commit]
    footer: "耗时 {duration_sec}s · {triggered_by}"
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `group_by` | ✅ | enum 字段名。等于 states.field 时可拖（§4.3.3） |
| `columns` | ✅ | 列定义，数组。元素 = group_by 字段的 enum 值。顺序 = 列排列顺序。可省略部分值（省略的值对应记录不显示） |
| `card` | ✅ | 卡片渲染模板，见 §5.5 |

### 5.3 table

```yaml
- id: run_table
  title: 运行记录
  component: table
  entity: pipeline_run
  columns: [id, branch, commit, status, duration_sec, triggered_by, started_at]
  sort: { field: started_at, order: desc }
  limit: 20
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `columns` | ✅ | 列定义。元素 = entity 的字段名。enum 字段渲染为 chip（带 label/color），datetime 渲染为本地时间，ref 渲染为目标 id |
| `sort` | ❌ | `{field, order}`。field 必须是 entity 字段，order = `asc`/`desc`。缺省 = 不排序（插入顺序） |
| `limit` | ❌ | int，最大返回行数。缺省 = 无上限 |

### 5.4 bar_chart

```yaml
- id: run_chart
  title: 近7天趋势
  component: bar_chart
  entity: pipeline_run
  bucket: { field: started_at, unit: day, days: 7 }
  stack_by: status
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `bucket` | ✅ | `{field, unit, days}`。field 必须是 datetime 类型。unit = `day`（v1 仅支持 day）。days = 桶数量（从今天往前推 N 天，含今天） |
| `stack_by` | ❌ | enum 字段名。每个桶内按此字段值堆叠分段 + 图例。缺省 = 单一颜色不堆叠 |

v1 仅 day 粒度 + 近 N 天窗口。v2 扩展 hour/week/month 等粒度 + 自定义时间范围。

### 5.5 card 模板 — 插值语法

```yaml
card:
  title: "{id} · {branch}"                    # 简单字段
  badges: [status, commit]                     # badge 列表（字段名）
  footer: "耗时 {duration_sec}s · {triggered_by}"
  # 进阶：ref 嵌套 + 默认值
  subtitle: "{pipeline_ref.branch|未知分支}"    # ref 嵌套 + 默认值
```

#### 插值规则（v1 完整定义）

| 语法 | 语义 | 示例 |
|------|------|------|
| `{field}` | 当前实例的字段值 | `{branch}` → `"main"` |
| `{ref_id.target_field}` | ref 字段指向的目标实例的字段值（一级嵌套） | `{pipeline_ref.branch}` → resolve ref → 目标 pipeline_run 的 branch |
| `{field\|fallback}` | 字段为 null/undefined/空串时用 fallback 文本 | `{commit\|无commit}` → `"abc123"` 或 `"无commit"` |
| `{ref_id.target_field\|fallback}` | ref 嵌套 + 默认值组合 | `{pipeline_ref.branch\|未知}` |

#### 插值解析正则

```
/\{(\w+)(?:\.(\w+))?(?:\|([^}]*))?\}/g
```

捕获组：1=字段名，2=目标字段（ref 嵌套），3=fallback 文本。

#### 边界与错误处理

| 情况 | 行为 | 校验层 |
|------|------|--------|
| `{field}` field 不存在 | **编译时报错**（semantic 层），不在运行时静默 | 语义层 `panorama_unknown_field_in_template` |
| `{ref_id.target}` ref_id 不是 ref 类型字段 | **编译时报错** | 语义层 `panorama_ref_navigation_on_non_ref` |
| `{ref_id.target}` ref_id 是 ref 但目标实体无 target 字段 | **编译时报错** | 语义层 `panorama_unknown_ref_target_field` |
| `{field}` field 存在但实例值为 null | 渲染空串（或 fallback 如果有） | 运行时，不报错 |
| `{ref_id.target}` ref 目标实例已被删除 | 渲染 fallback（或空串） | 运行时，不报错 |
| 模板无任何 `{...}` 插值 | 原样输出字面文本 | 合法（静态标题） |
| `{{field}}` 双花括号 | 原样输出 `{field}`（字面花括号转义） | 合法 |

**关键改进（对比 demo）**：demo 用 `/\{(\w+)\}/g` 只支持单级字段名，缺失字段静默渲染空串。本规范改为：
1. 支持 ref 一级嵌套 `{ref_id.target_field}`（业务需要：部署卡显示关联流水线的分支名）。
2. 缺失字段从运行时静默 → **编译时报错**（语义层）。LLM 生成时常见错误是拼错字段名，编译期捕获 = 修复回路能自动修。
3. 加 fallback 语法，让空值场景可控。

#### badges 字段

`badges` 是字段名数组，每个 badge 渲染为一个 chip/标签：
- enum 字段 → chip 带 label + color。
- 其他类型 → 纯文本标签。
- badge 引用的字段不存在 = 语义层报错（同 card 模板字段校验）。

---

## 6. 护栏（上限约束）

| 约束项 | 上限 | 理由 |
|--------|------|------|
| 实体数 | 20 | 业务看板场景极少超过 10 个实体；20 留余量。过多 = agent 建模失控信号 |
| 字段数/实体 | 30 | 表格列 30 已接近人类可扫描极限；超出 = 实体拆分信号 |
| view 数 | 10 | tab 10 个已超出单屏；更多 = 信息过载。实际场景 3-5 个 |
| enum 值数 | 15 | kanban 列 15 已无法并排显示；过多 = 分类粒度过细 |
| card 模板长度 | 200 字符 | 防 LLM 生成超长模板撑爆卡片 |
| ref 嵌套深度 | 1 | `{ref.target}` 一级，不支持 `{ref.target.deep}`。跨实体链路走显式查询 |
| transitions 出边数/状态 | 10 | 单状态 10 个出边已覆盖所有合理工作流 |

护栏在 schema 层校验（validation doc §schema 层）。超限 = `panorama_limit_exceeded`，suggestion 提示具体超了哪项 + 建议拆分。

---

## 7. 设计原则（LLM 生成可靠性）

1. **显式优于省略**：所有字段约束（max/pattern/required）显式写，不靠隐含默认值。LLM 生成时不需要猜。
2. **shorthand 兼容 longhand**：简单场景（demo CI/CD）用 shorthand 一行搞定；复杂场景（guard）用 longhand 展开写。渐进式复杂度。
3. **编译期可校验**：所有跨引用（ref target、template field、group_by field、transition states）在 define 时编译期校验，不等到运行时才发现。
4. **错误自解释**：校验失败返回 `{code, path, message, suggestion}`，suggestion 给出修复示例（见 validation doc）。agent 能据此自我修复。
5. **flat map 优先于嵌套**：entities 是 flat map（非数组），字段定义是 flat map（非嵌套对象）。减少 LLM 生成时的缩进/嵌套出错。
