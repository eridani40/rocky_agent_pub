type: spec
title: component-panorama-entity-modal — 泛化实体新建/编辑弹层
priority: P1
status: active
updated: 2026-07-24
since: v0.0.189.dsl_board

## 职责
panorama 实体的**通用创建 + 编辑弹层**。与 `component-board-entity-modal`（goal/KR/req/task 固定 4 实体）不同：panorama 实体是 DSL 动态声明的，弹层的**字段集从 DSL `entity.fields` 动态生成**，不硬编码。edit + create 共用同一份 JSX（mode 区分 initial + 标题）。
- 不拉数据（schema + 实例快照由父 `component-panorama-view` 注入）。
- 不调 API（保存回调 `onSubmit`，调用方按 mode 调 POST/PATCH）。
- 不渲染按钮入口（+新建 在 toolbar；编辑在卡片/行点击）。

## Props
- mode: 'create' | 'edit'
- entity: string;                    // 实体名
- entityDef: EntityDef;              // DSL 实体定义（含 fields + id_field + states?）
- initial?: Record<string, unknown>; // edit 模式实例快照（create 传 undefined）
- refOptions?: Record<string, SelectorOption[]>;  // ref 字段选项（fieldName → 目标实体实例选项，父 view 注入）
- onSubmit: (values: Record<string, unknown>) => void;  // 保存（create=全量 values；edit=dirty patch）
- onCancel: () => void
- onToast: (msg: string) => void;    // 校验/服务端错误提示（父 view 持有 toast）

## 状态 / 交互
### 字段集动态生成
遍历 `entity.fields`，按字段类型（DSL `FieldDef` union 6 类）渲染对应控件：
| 字段类型 | 控件 | testid 后缀 |
|----------|------|-------------|
| `string` | `<input>` text（max 限制） | `-input` |
| `number` | `<input>` number（min/max） | `-input` |
| `boolean` | checkbox | `-toggle` |
| `enum` | board-selector primitive：`ChoiceCards`（≤4 选项）/ `Dropdown`（>4）（禁原生 select，`_conventions §10`） | `-selector` |
| `ref` | `Dropdown`（nullable，选项由父 view 注入） | `-selector` |
| `datetime` | `<input type="datetime-local">`（值取前 16 字符 `YYYY-MM-DDTHH:mm`） | `-input` |

### ref 字段选项数据来源
父 view 在 modal 打开时 `useEffect(editing)` 检查 `entityDef.fields`，对 `ref` 类型字段未缓存的目标实体预拉（`fetchEntity(fdef.entity)`）→ 注入 `refOptions`。选项 value/label 都是目标实例的 id（`recordId` 解析）。

### edit 模式 status 字段只读
edit 模式下 `id_field` 与 `states.field` 字段强制 readOnly。**why**：状态变更走 transition（拖拽 / 跃迁端点），服务端 PATCH 也过 transition 校验——锁死状态字段避免用户在 modal 改 status 被 server 拒（400 `panorama_illegal_transition`）。状态字段 readOnly 时仍渲中文 label（`enumValueLabel`）+ 下方 hint 文案「状态字段只读，请通过拖拽或跃迁操作变更」。

### 提交语义
- required 校验（含 create 模式 `id_field` 强制 required）：空提交 → onToast + 不提交；boolean 字段不算 required 空。
- edit 模式 dirty 检测：与 initial 逐字段比，全等时直接 onCancel 关闭（无提交）；空串与 undefined 视为等价（不当作 dirty）。
- create 模式：非空即 dirty，提交全量 values。

## 视觉基线
- 复用 `ModalShell`。
- 字段布局：title 在上 → 各字段 → footer（取消/提交）。
- selector 控件复用 `component-board-selector`（禁原生 select）。
- 必填字段 label 后 `*`；状态字段 label 后括注「(状态字段)」。

## 消费方

- `app/web/src/components/studio-page/component-panorama-view.tsx`
