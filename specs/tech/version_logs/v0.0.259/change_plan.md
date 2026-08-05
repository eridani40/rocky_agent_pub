# v0.0.259 变更计划书 — panorama 创作体验三修（coerce / system-entity 解析 / create 幂等）

> **method 级 review 合同**。架构期冻结：planner/coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> 范围权威源：`reqs/[working] v0.0.259/req.md`（跳过 PRD 的纯技术版本，无用户可感知界面变化）。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | panorama 子系统名（panorama_validation / panorama_tool / panorama_http / panorama_builtin） |
| 文件路径 | worktree 相对路径 |
| 函数/符号 | 函数名/符号名（行粒度 = 符号；新增 interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | spec 路径+章节 / 项目原则编号 |
| 预计影响行 | +N / -M |

## 变更清单

### C — coerce + 错误信息增强（panorama_validation / validate_instance.ts）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| panorama_validation | app/server/src/squad/panorama/validation/validate_instance.ts | coerceRecord | 新增 | `coerceRecord(entityDef, record): Record<string,unknown>`：按 entityDef.fields 声明类型无损 coerce 各字段值后返回**新 record**（不 mutate 入参）。number 字段 + string 值：`Number(v)` 有限且 `String(Number(v))===v.trim()` → 转 number；否则保留原值。string 字段 + number 值：→ `String(v)`。boolean 字段 + string "true"/"false"：→ 转 boolean。enum/ref/datetime 字段：不 coerce（语义串/严格 id/ISO 解析交给 check） | MUST 返回新对象（不 mutate 入参 record）；MUST 仅做无损转换（round-trip 一致），有损/不合法值保留原值交下游 check 报错；MUST NOT coerce enum 字段；MUST NOT 抛异常（纯函数） | req §C；原则 `user-prefers-simple-direct-refactor-no-defensive-checks` | +22 |
| panorama_validation | app/server/src/squad/panorama/validation/validate_instance.ts | coerceFieldValue | 新增 | 私有 helper `coerceFieldValue(field, value): unknown`：单字段按 field.type 分派（number/string/boolean 三类做无损 coerce，其余原值返回）。被 `coerceRecord` 调用 | MUST 不抛异常；value==null 原值返回（null/空值语义交给 check 的 required 校验） | req §C | +20 |
| panorama_validation | app/server/src/squad/panorama/validation/validate_instance.ts | checkString | 修改 | 错误信息增强：`panorama_type_mismatch` / `panorama_value_too_long` / `panorama_pattern_mismatch` 三类错误的 message 带声明约束原文（type=string + max=N + pattern=regex 原文）；suggestion 字段加引导语「拿不准先 panorama readSchema / GET schema 看 entities.{X}.fields.{Y} 声明」 | MUST message 含 max 与 pattern 原文值（不能只说"长度超限"）；MUST suggestion 含 readSchema/GET schema 引导 | req §C；`specs/api/overall/14-panorama-endpoints.md §1.1`（schema 恒含 task） | +6/-4 |
| panorama_validation | app/server/src/squad/panorama/validation/validate_instance.ts | checkNumber | 修改 | 错误信息增强：`panorama_type_mismatch` / `panorama_value_out_of_range` 的 message 带 min/max 原文；suggestion 加 readSchema 引导 | MUST message 含 min 与 max 原文数值 | req §C | +4/-3 |
| panorama_validation | app/server/src/squad/panorama/validation/validate_instance.ts | checkEnumValue | 修改 | 错误信息增强：`panorama_invalid_enum_value` message 列出 enum values 全集 + 字段声明类型；suggestion 加 readSchema 引导 | MUST message 含完整 enum values 列表（已有，强化格式）+ 声明类型 enum | req §C | +3/-2 |
| panorama_validation | app/server/src/squad/panorama/validation/index.ts | coerceRecord (re-export) | 新增 | 在 validation 模块 barrel 导出 `coerceRecord`（tool/http 调用方需 import） | MUST 与 validateInstance / applyFieldDefaults 同 barrel 导出，统一调用入口 | `validation/index.ts` 现状 | +1 |

### B — create 幂等 skip-if-exists（panorama_validation / panorama_tool / panorama_http）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| panorama_validation | app/server/src/squad/panorama/validation/validate_instance.ts | validateInstance (mode==='create' 分支) | 修改 | **移除 duplicate check**（删 line 72-76 的 `panorama_duplicate_id` 检查）。duplicate 检测完全交给调用方（runCreate / handleCreateEntity 在 coerce+validate 之前短路）。mode==='create' 分支仅保留 `checkInitialState` | MUST 删除 duplicate check 4 行（含 `if (idVal != null && options.store?.hasId...)` 整块）；MUST NOT 保留作"安全网"（调用方已短路，保留=死代码，违反「不遗留死代码」）；checkInitialState 保留不动 | req §B；原则 `delete-old-code-fully-when-replacing` + `user-prefers-simple-direct-refactor-no-defensive-checks` | +0/-5 |
| panorama_tool | app/server/src/squad/panorama/tool/panorama-tool-data-actions.ts | runCreate | 修改 | 在 `applyFieldDefaults` 之前加短路：`s.hasId(entity, id)` 命中 → 直接返 `okJson({ok:true, id, created:false})`（不写库、不 emit、不 hook）。未命中路径改为：`applyFieldDefaults` → `coerceRecord(entityDef, record)` → `validateInstance` → `createInstance` → 返 `okJson({ok:true, id, created:true})` | MUST 短路在 coerce+validate 之前（幂等命中不触发校验）；MUST 响应 shape 含 `created:true|false`；MUST NOT 命中时调 afterTaskWrite（未实际写）；id 字段缺失仍返 panorama.create error（短路前） | req §B；`panorama_builtin §6`（task hook 仅实际写后触发） | +8/-2 |
| panorama_tool | app/server/src/squad/panorama/tool/panorama-tool-data-actions.ts | runUpdate | 修改 | patch 与 existing merge 后、validateInstance 之前插入 `coerceRecord(entityDef, merged)`：保证 update 路径同值类型拧巴也 coerce（如 PATCH `{chapter_count_done:"1928"}` 与库里 number merge 后再 coerce 写回一致类型） | MUST coerce 在 validateInstance 之前；MUST NOT coerce 后丢失 patch 字段（coerceRecord 仅转类型，不动 key 集） | req §C（coerce 覆盖 update 路径） | +3/-1 |
| panorama_http | app/server/src/squad/panorama/http/panorama-routes-impl.ts | handleCreateEntity | 修改 | 在 `applyFieldDefaults` 之前加短路：`s.hasId(entity, id)` 命中 → 返 `201 {ok:true, id, created:false}`（HTTP 201 语义对——请求成功达成幂等状态，即便未实际创建）。未命中路径改为：`applyFieldDefaults` → `coerceRecord` → `validateInstance` → `createInstance` → 返 `201 {ok:true, id, created:true}` | MUST 短路在 coerce+validate 之前；MUST 响应 shape 含 `created:true|false`；HTTP status 命中/未命中均 201（idempotent 成功）；MUST NOT 命中时 emit entity.created 事件（未实际创建） | req §B；`specs/api/overall/14-panorama-endpoints.md §2.2`（doc-sync：response shape 加 created 字段） | +8/-2 |
| panorama_http | app/server/src/squad/panorama/http/panorama-routes-impl.ts | handlePatchEntity | 修改 | merged record 在 validateInstance 之前插入 `coerceRecord(entityDef, merged)`（与 runUpdate 对齐） | MUST coerce 在 validateInstance 之前 | req §C | +3/-1 |

### A — 语义层认 system entity 恒在可引用（panorama_validation / validate_semantic.ts）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| panorama_validation | app/server/src/squad/panorama/validation/validate_semantic.ts | (import SYSTEM_ENTITY_DEFS) | 新增 | 顶部新增 `import { SYSTEM_ENTITY_DEFS } from '../builtin';`（canonical system entity def 来源，与 `validate_system_entity.ts` 同源） | MUST 从 `../builtin` barrel 导入（非深路径，与现有 checkSystemEntityImmutable 一致） | `validate_system_entity.ts:16` 现有 import 范式 | +1 |
| panorama_validation | app/server/src/squad/panorama/validation/validate_semantic.ts | validateSemantic | 修改 | 在构造 `entityNames` 集合后追加 `Object.keys(SYSTEM_ENTITY_DEFS)`（system entity 名恒在可引用，无论 leader 是否在 entities 里声明 task）。`entityNames` 用于 ref.entity 闭合校验（line 32）——ref→task 合法 | MUST 在 `new Set(Object.keys(schema.entities))` 之后追加 system names（不替换、只追加）；MUST NOT 触发 inject/write（纯内存集合操作） | req §A；`panorama_builtin §3 决策 5`（inject 后置是故意的，A 不动时序） | +3/-1 |
| panorama_validation | app/server/src/squad/panorama/validation/validate_semantic.ts | checkViews | 修改 | view.entity 查找改为 `schema.entities[view.entity] ?? SYSTEM_ENTITY_DEFS[view.entity]`：leader 未声明 task 时用 canonical def 校下游（group_by/columns/filter/template/badges）。`panorama_unknown_view_entity` 仅在两处都 miss 时报 | MUST fallback 到 canonical def 继续下游校验（不能只 pass 跳过下游）；MUST NOT 修改 canonical def 内容（只读引用） | req §A；`panorama_builtin §2`（task schema 字段/view 定义） | +4/-2 |

## 影响面评估

**跨模块**：4 文件改动（validate_instance.ts / validate_semantic.ts / panorama-tool-data-actions.ts / panorama-routes-impl.ts）+ 1 barrel 导出（validation/index.ts）。validate_system_entity.ts / system-entities.ts / panorama_store.ts **不动**（A 仅读 SYSTEM_ENTITY_DEFS，B 用既有 hasId）。

**破坏性变更（契约）**：
1. **POST entities response shape 加 `created` 字段**（additive：`{ok:true,id}` → `{ok:true,id,created:true|false}`）。旧 AT case 若严格等值断言 `response == {ok:true,id:"X"}` 会破；`any/all` 量词断言 `response.ok==true / response.id==X` 不破。需 AT 回归确认（见下「契约影响」）。
2. **`panorama_duplicate_id` 错误码从实例写校验中消失**（validateInstance 不再产生）。`14-panorama-endpoints.md §2.2` 原列 `panorama_duplicate_id` 作 create 错误码 → doc-sync 改为 skip 语义。spec §6 实例写校验表对应行 doc-sync。

**依赖顺序**：底层 `validate_instance.ts`（C+B coerce/duplicate 移除）先于上层 `tool/http`（调用方接 coerce + 短路）。同一 task 内顺序编码即可。A 走 `validate_semantic.ts` 完全独立，可与 C+B 并行。

**风险点**：
- coerceRecord 无损判定边界（`String(Number(v))===v.trim()`）须严格——`"0x10"` / `"1.0"` / `""` / `"  "` 等不 coerce，保留原值交 check 报错。UT 必须覆盖这些边界。
- A 的 fallback 必须用 canonical def 做下游校验（不能 `return` 跳过）——否则 group_by/columns 等字段漂移静默通过。
- handleCreateEntity 命中已存在 id 返 201 还是 200：architect 决策 **201**（idempotent success 语义；HTTP 201 = "请求已处理，资源处于目标状态"，与是否本次新建无关）。coder 若有更恰当选择（如 200）可偏离 + 汇报。

**文件体量**：
- validate_instance.ts 现 188 行 + 净增 ~38 行 ≈ 226 行，未超 300。
- panorama-tool-data-actions.ts 现 219 行 + 净增 ~13 行 ≈ 232 行，未超 300。
- panorama-routes-impl.ts 现 310 行（已超 300，是既有债）+ 净增 ~11 行 ≈ 321 行——**触发拆分提示**：本 task 不修既有债（避免范围蔓延），但 coder 实现时若接近 321 应考虑把 helper 抽出；orchestrator 可立项后续拆分 task。
- validate_semantic.ts 现 262 行 + 净增 ~7 行 ≈ 269 行，未超 300。

## 契约影响（doc-sync 待办，doc-modifier 阶段 5 处理）

| 文档 | 章节 | 当前内容 | 应改为 |
|---|---|---|---|
| `specs/api/overall/14-panorama-endpoints.md` | §2.2 POST entities 成功响应 | `201 + { ok: true, id: string }` | `201 + { ok: true, id: string, created: boolean }`（created=true 新建 / false 幂等命中已存在） |
| `specs/api/overall/14-panorama-endpoints.md` | §2.2 POST entities 错误码 | 隐含 `panorama_duplicate_id` | 删除该错误码（create 改 skip-if-exists，不再报 duplicate） |
| `specs/tech/squad/[P1]panorama_validation.md` | §6 实例写校验表「id 唯一（create 时） \| `panorama_duplicate_id`」 | 作校验规则列出 | 改为「create 时 id 已存在 → skip 幂等（返 created:false，不报错；调用方负责）」；`panorama_duplicate_id` 从校验码集合移除 |
| `specs/tech/squad/[P1]panorama_validation.md` | §1.1 四层顺序 / §3 schema 层 | 未明确 `checkSystemEntityImmutable` 所在文件 | 注明实现于 `validate_system_entity.ts`（spec 概念表达未指明文件，code 实际独立文件——本版本核对发现的既有漂移） |
| `specs/tech/squad/[P1]panorama_validation.md` | §6 新增 coerce 小节 | （无） | 新增「实例写前 coerce（coerceRecord）：number↔string / boolean←string 无损转换；enum/ref/datetime 不 coerce」小节 |
| `specs/tech/squad/[P1]panorama_builtin.md` | §4 system 标记机制 | 已涵盖 immutable + inject 时序 | 补充：「语义层（validateSemantic）把 system entity 当恒在可引用：view.entity / ref.entity 指向 system entity 时用 canonical def 校下游；与 inject 后置时序解耦（A 仅扩解析可见性，不动注入时序）」 |

**AT 影响**：panorama 现有 AT 冒烟 case 需回归（response shape 加 `created` 字段）。若 case 用严格等值断言则会 fail，需 designer 调整为字段存在 + 值断言（`.created` exists + `.ok==true`）。orchestrator 在 test-plan 阶段核对现有 case 写法。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- coder 发现 spec 漂移或约束不合理 → 按「spec↔code 双向对齐」原则：按代码实际调整 + 汇报偏离，orchestrator 记 doc-sync 待办，doc-modifier 阶段 5 统一修 spec
