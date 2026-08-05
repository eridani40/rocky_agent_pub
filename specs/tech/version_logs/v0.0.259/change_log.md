# v0.0.259 tech change log — panorama 创作体验三修（coerce / system-entity 解析 / create 幂等）

> 对应需求：`reqs/[working] v0.0.259/req.md`（纯技术/引擎改动，无用户可感知界面变化 → 跳过 PRD）。
> 权威契约：`specs/tech/version_logs/v0.0.259/change_plan.md`（method 级 8 列表，frozen）。

## 变更摘要

### 需求与动机

prod session `01KYY4ET9AYXQZGKJ44Y1R8HPA`（男频网文生产线全景看板）553 次 panorama 调用、123 次失败。抠具体实例归因后，失败主因**不是** DSL 创作面太大（实证 <10%），而是三类引擎/机制问题：

1. **字段类型反复横跳（~60%，最大头）**：`chapter_count_done` / `scraped_chapter_end` 等数字字段 agent define 声明 `type:string`、create 传 `1928`（number），或反过来——142 处错配里 114 是 string←number、28 是 number<-string，**全是同值类型拧巴**，硬拒毫无必要。
2. **task 系统实体引用悖论（~20%）**：v0.0.243 起 task 已是普通 entity，但 leader 提交的 DSL 里 `views` 引用 task 而 `entities` 未声明 task → 语义校验在 system 注入之前跑 → `panorama_unknown_view_entity`。注入后置是**故意的**（保留 immutable 校验），故修法是扩语义层解析可见性，不是注入提前。
3. **create duplicate 严格（~15%，重试放大）**：re-seed 23 本书 ×2 轮 bulk create 每本撞 `panorama_duplicate_id`，agent 不 query 现存就批量写。

### C — coerce + 错误信息增强（validate_instance.ts）

- **`coerceRecord(entityDef, record): Record<string, unknown>`**（validate_instance.ts:120-130）：按 entityDef.fields 声明类型无损 coerce 各字段值，返回**新 record**（不 mutate 入参；纯函数不抛异常）。用于 create/update 写库前。
- **`coerceFieldValue(field, value): unknown`**（私有 helper，validate_instance.ts:79-109）：单字段分派：
  - number + string：`Number(v)` 有限且 `String(Number(v))===v.trim()` → 转 number（排 `"0x10"`/`"1.0"`/`"1e3"`/`""`/`"12a"`）
  - string + number（有限）：→ `String(v)`
  - boolean + 字面串 `"true"`/`"false"`：→ 转 boolean（`"True"`/`1`/`0` 不 coerce，过宽易误判）
  - enum/ref/datetime/value==null：原值返回（null 语义交 required，enum/ref/datetime 交下游 check）
- **无损 round-trip 是核心约束**：有损/不合法值保留原值交下游 check 报错（pattern/enum/range/required）。
- **错误信息增强**：`checkString`/`checkNumber`/`checkEnumValue` message 带声明约束原文（type/max/pattern/enum values）+ suggestion 含 `panorama readSchema` / `GET schema` 引导。helper：`eHint`（错误工厂，固定 suggestion 引导语）+ `declaredStringConstraints` / `declaredNumberConstraints`（拼接声明约束原文）。
- **应用点**：① runCreate（tool）：`applyFieldDefaults` → `coerceRecord` → `validateInstance`；② runUpdate（tool）：merged 后 `coerceRecord` → `validateInstance`；③ handleCreateEntity（http）：同 ①；④ handlePatchEntity（http）：同 ②。
- **barrel re-export**：`validation/index.ts:14` 加 `coerceRecord`。

### B — create 幂等 skip-if-exists（validate_instance.ts / panorama-tool-data-actions.ts / panorama-routes-impl.ts）

- **validateInstance create 分支移除 duplicate check**（删 4 行 `if (idVal != null && options.store?.hasId...)` 块；line 156-158 仅留注释说明）。理由：调用方已短路，保留=死代码（违反「不遗留死代码」原则）。
- **runCreate**（panorama-tool-data-actions.ts:33-36）：`applyFieldDefaults` 之前加短路 `s.hasId(entity, id)` 命中 → 返 `okJson({ok:true, id, created:false})`（不写库 / 不 emit / 不 afterTaskWrite）；未命中走建路径返 `created:true`。
- **handleCreateEntity**（panorama-routes-impl.ts:200-202）：同款短路返 `201 {ok:true, id, created:false}`；未命中返 `201 {ok:true, id, created:true}`。HTTP 201 = idempotent success 语义（请求成功达成目标状态，与是否本次新建无关）。
- **response shape additive 变更**：`{ok:true,id}` → `{ok:true,id,created:boolean}`。旧 AT case 若严格等值断言会破；`any/all` 量词断言（`.ok==true` / `.id==X`）不破。

### A — 语义层认 system entity 恒在可引用（validate_semantic.ts）

- **import**：`import { SYSTEM_ENTITY_DEFS } from '../builtin'`（validate_semantic.ts:16，barrel 导入，与 validate_system_entity.ts 同源）。
- **validateSemantic**（validate_semantic.ts:33-36）：`entityNames` 集合从 `new Set(Object.keys(schema.entities))` 改为 `new Set<string>([...Object.keys(schema.entities), ...Object.keys(SYSTEM_ENTITY_DEFS)])`——leader 即便未声明 task，`ref.entity`/`view.entity` 指向 task 也合法。
- **checkViews**（validate_semantic.ts:78）：`schema.entities[view.entity] ?? SYSTEM_ENTITY_DEFS[view.entity]` fallback canonical def 继续下游校验（group_by/columns/filter/template/badges，不能仅 pass 跳过下游——否则字段漂移静默通过）。`panorama_unknown_view_entity` 仅在两处都 miss 时报。
- **不改**：`injectSystemEntities` 后置时序、`checkSystemEntityImmutable` 抓 leader 改 task、`system-entities.ts` canonical def。

### 设计决策

- **coerce 无损判定边界**（`String(Number(v))===v.trim()`）须严格——`"0x10"` / `"1.0"` / `""` / `"  "` 等不 coerce，保留原值交 check 报错。boolean 仅认字面串（`"True"`/`1`/`0` 不 coerce，过宽易误判）。
- **coerce 不 mutate 入参**：返回新 record（调用方默认赋值语义，不依赖入参 record 副作用）。
- **create 幂等命中返 201 而非 200**：HTTP 201 = idempotent success 语义（请求已处理，资源处于目标状态，与是否本次新建无关）。与 POST 201 = "created" 的字面传统语义略有出入，但与 PATCH/PUT 的 idempotent 语义对齐。
- **A 的 fallback 必须用 canonical def 做下游校验**（不能 `return` 跳过）——否则 group_by/columns 等字段漂移静默通过。
- **duplicate check 删除而非保留作"安全网"**：调用方已短路，保留=死代码（违反「不遗留死代码」+「简单直接不加防御检查」原则）。

### 代码↔spec 核实（doc-modifier 阶段 5）

| 项 | 核验 | 状态 |
|---|---|---|
| `coerceRecord` 纯函数不 mutate | validate_instance.ts:120-130（`const out = {}; ... return out`） | ✓ |
| 无损 round-trip 守门 | validate_instance.ts:89（`String(Number(v))===trimmed`） | ✓ |
| boolean 仅认 `"true"`/`"false"` | validate_instance.ts:100-102（`"True"`/`1`/`0` 不 coerce） | ✓ |
| enum/ref/datetime 不 coerce | validate_instance.ts:106 default branch | ✓ |
| create skip-if-exists 在 runCreate | panorama-tool-data-actions.ts:33-36（短路在 coerce+validate 之前） | ✓ |
| create skip-if-exists 在 handleCreateEntity | panorama-routes-impl.ts:200-202 | ✓ |
| 命中不 emit / 不 afterTaskWrite | 两路命中 branch 均 `return`，无 emitEntity/afterTaskWrite 调用 | ✓ |
| validateInstance create 分支 duplicate check 删除 | validate_instance.ts:155-162（仅注释说明） | ✓ |
| validateSemantic 纳入 SYSTEM_ENTITY_DEFS | validate_semantic.ts:33-36 | ✓ |
| checkViews fallback canonical def | validate_semantic.ts:78 | ✓ |
| fallback 继续下游校验（非 pass 跳过） | validate_semantic.ts:85-93 | ✓ |
| checkSystemEntityImmutable 不动 | validate_system_entity.ts（既有文件，本版本未动） | ✓ |
| barrel re-export coerceRecord | validation/index.ts:14 | ✓ |

## 文档同步（doc-modifier 阶段 5 已完成）

- `[P1]panorama_validation.md`：§3.5 新增 system entity immutable 校验位置说明；§4 补 system entity 恒在可引用段；§6 删 `panorama_duplicate_id` + 加 id 唯一性由调用方短路注；§6.1 新增 coerceRecord 小节；§6.2 新增错误信息增强小节；frontmatter updated。
- `[P1]panorama_builtin.md`：§4 加 view 可直接引用 task bullet；frontmatter updated。
- `14-panorama-endpoints.md` v1.5：§2.2 response shape 加 `created` + 行为改写 skip-if-exists；§2.4 PATCH 加 coerceRecord；顶部 version 注释加 v1.5 条目。
- squad KB `log.md`：加 v0.0.259 位置轴条目。
- API `specs/api/version_logs/v0.0.259/change_log.md`：增量发布说明。
