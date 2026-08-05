# v0.0.243 变更计划书 — task 改普通 entity（拆 builtin 通道）

> **method 级 review 合同**。架构期冻结：planner/coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> 背景：v0.0.240 把 task 做成「builtin 通道」（代码声明 + 不进 schema 响应 + 前端镜像合成）= hack（get_schema 看不到 task + 前后端双份定义已漂移 + readEffectiveSchema 复杂度）。本版本彻底拆：**task 改普通 entity（落盘进 squad schema，和 book 平级）+ system 标记（不可 edit/delete）+ lazy migration 初始化**。需求：`reqs/[working] v0.0.243.task_entity/req.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径（worktree 内） |
| 函数/符号 | 函数名或符号名（行粒度 = 符号；新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么（禁「更新调用链」等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

## 关键设计决策（architect 裁定）

1. **migration 触发点 = lazy on read**（非 boot 时 eager）：在 panorama schema 读取 chokepoint 调 `ensureSystemEntities(store)` 幂等注入 task entity。理由：(a) 单一触发点，无需 squad-runtime.startAll() 跨模块耦合；(b) 自然处理 boot 后新建 squad（boot eager 漏掉新建 squad，需再 wire createSquad 路径）；(c) 幂等 ensure 廉价（readBoard + 条件 writeBoard，首次后纯读）。req 的「启动时」是行为语义（task entity 恒在），非字面 boot 时刻；lazy 等价达成。
2. **冲突策略 = system-wins**（req 给的「系统优先 / 报错」二选一，architect 选 system-wins）：旧 squad 若已有 leader 手动 DSL define 的同名 `task` entity → migration 覆盖为系统版本（无有效 task 数据，概率低，覆盖最简）。**define 流程对 leader 提交的 task**：validate 阶段 `checkSystemEntityImmutable` 比较 leader 提交的 task 字段（parser 已丢 system flag）与 canonical（不含 system 比较）→ 不一致直接 error `panorama_system_entity_immutable`（leader 须移除 task 或改名）；一致或缺失 → pass，inject 阶段注入/补全 canonical（覆盖 leader 的 task 为 system 版本，applyMigration 落盘）。
3. **system 标记机制**：`EntityDef.system?: true`。parser（`dsl/parser.ts:parseEntity`）只读固定字段集（label/id_field/fields/states/display），**不读 system**（leader 写 `system: true` 在 DSL 里被 parser 丢弃）→ leader 无法自行标记 system；system 标记**仅由 inject 程序化注入**。结合 define 的 `checkSystemEntityImmutable` 校验，三段闭环。
4. **system-protect 校验位置**：新文件 `validation/validate_system_entity.ts`，在 `validateSchema` 主入口 Layer 2 之后调用（接收 parsed schema；不需 oldSchema，因比较对象是 canonical SYSTEM_ENTITY_DEFS 而非 oldSchema）。校验逻辑：leader 提交的 entity 名命中 system entity 名（`task`）且字段（label/id_field/fields/states/display，**不含 system flag**）与 canonical 不一致 → error；一致或缺失 → pass（inject 兜底）。
5. **define inject 时序关键**（反直觉）：**validate 先 → inject 后**（在 validate 与 applyMigration 之间）。理由：(a) validate 先跑让 checkSystemEntityImmutable 看到 leader 原始提交（parser 后无 system）→ 能拒字段漂移；(b) inject 在 applyMigration 前一刻跑，让 newSchema 含 canonical task → applyMigration 的 oldSchema/newSchema diff 两边都含 task → 不误判 `entity_deleted:task` 触发破坏性迁移。**反序（inject 先于 validate）会让 check 看到 canonical → trivially pass → 失去防 leader 改 task 能力**。
6. **afterTaskWrite 签名简化**：drop `squadId` + `dataDir` 两参 → `afterTaskWrite(store)`。原参仅用于 `readEffectiveSchema(squadId, dataDir)` 查 task entity 是否存在；refactor 后 `store.readBoard()?.entities.task` 直查，无需 squadId/dataDir。

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| panorama_dsl | app/server/src/squad/panorama/dsl/types.ts | EntityDef | 修改 | 加可选字段 `system?: true`（标记系统固定 entity，不可 leader edit/delete） | MUST 仅由 inject 程序化设值；MUST NOT 由 parser 从 leader DSL 读入（parser 不识别此字段，自然丢弃） | panorama_dsl §4（EntityDef）；本 spec §1 决策 3 | +1 |
| panorama_builtin | app/server/src/squad/panorama/builtin/task-schema.ts | TASK_ENTITY_DEF | 修改 | 加 `system: true` 字段（标记为系统固定） | MUST 保持其余字段不变（v0.0.240 已稳定）；owner=string、dependencies=string+pattern 决策不变 | panorama_builtin §2.1（v0.0.243 改写后） | +1 |
| panorama_builtin | app/server/src/squad/panorama/builtin/task-schema.ts | BUILTIN_ENTITY_DEFS | 删除 | 删常量（builtin 通道废除，不再 read 层合并用） | MUST 同步删所有引用（tool/routes/data-actions 的 schemaOr409/resolveEntity） | 本 spec §3 决策 | -3 |
| panorama_builtin | app/server/src/squad/panorama/builtin/task-schema.ts | BUILTIN_VIEWS | 删除 | 删常量（同上） | MUST 同步删前端镜像引用 | 本 spec §3 决策 | -1 |
| panorama_builtin | app/server/src/squad/panorama/builtin/system-entities.ts | injectSystemEntities | 新增 | 函数 `(schema: PanoramaSchema) => PanoramaSchema`：mutate schema 强制设 `entities.task = TASK_ENTITY_DEF`（canonical system 版本）+ prepend `task_kanban` view（缺失时）；返回 schema（chainable）。用于 define 流程 post-parse | MUST 用 TASK_ENTITY_DEF 覆盖任何 leader 提交的 task 变体（system-wins）；MUST NOT read 文件系统（纯内存 mutate）；幂等（已 canonical 时 no-op） | 本 spec §2/§3；panorama_builtin §3（v0.0.243） | +25 |
| panorama_builtin | app/server/src/squad/panorama/builtin/system-entities.ts | ensureSystemEntities | 新增 | 函数 `(store: PanoramaEntityStore) => PanoramaSchema`：lazy migration chokepoint。read board → null 则建 `{meta:{version:'1.0'}, entities:{task}, views:[task_kanban]}`；非 null 且 `entities.task?.system !== true` 则 injectSystemEntities + writeBoard；已 system 则直返。返回非 null schema | MUST idempotent（task.system===true 时纯读不写）；MUST NOT 触发 task 实例迁移（req 边界：不迁实例数据）；冲突策略=system-wins（覆盖 leader 同名 task 变体） | reqs/[working] v0.0.243.task_entity/req.md §migration 边界；本 spec §3 | +30 |
| panorama_builtin | app/server/src/squad/panorama/builtin/effective-schema.ts | readEffectiveSchema | 删除 | 删整个文件（builtin 合并 chokepoint 废除；task 真在 board.yaml，读取不需合并） | MUST 同步改所有调用方（tool/routes 的 effectiveSchema helper、task-hooks）改用 `ensureSystemEntities(store)` + `store.readBoard()` | 本 spec §3 决策 | -49 |
| panorama_builtin | app/server/src/squad/panorama/builtin/task-hooks.ts | afterTaskWrite | 修改 | 签名从 `(squadId, store, dataDir)` 改为 `(store)`；内部 `readEffectiveSchema(squadId, dataDir)` 改 `store.readBoard()`；`if (!schema?.entities.task) return` 防御守卫保留 | MUST NOT 再依赖 squadId/dataDir；MUST 保持 source='system' 调 transitionInstance（不变量 §3 不变）；同值跳过防事件洪水 | panorama_builtin §4（不变量#3）；本 spec §1 决策 5 | +3/-4 |
| panorama_builtin | app/server/src/squad/panorama/builtin/index.ts | (re-exports) | 修改 | 删 `readEffectiveSchema`/`BUILTIN_ENTITY_DEFS`/`BUILTIN_VIEWS` 导出；加 `injectSystemEntities`/`ensureSystemEntities` 导出（自 `./system-entities`） | MUST 保持 `TASK_ENTITY_DEF`/`TASK_VIEW_DEF`/`TASK_STATUS`/`TASK_STATUSES`/`parseDeps`/`afterTaskWrite` 导出不变（外部消费方不挪） | 本 spec §3 | +3/-3 |
| panorama_validation | app/server/src/squad/panorama/validation/validate_system_entity.ts | checkSystemEntityImmutable | 新增 | 函数 `(schema, errors) => void`：对每个 SYSTEM_ENTITY_DEFS 条目（目前仅 task），若 `schema.entities[name]` 存在且字段（label/id_field/fields/states/display，**不含 system**）与 canonical 不 deepEqual → push error `panorama_system_entity_immutable`（path=`entities.{name}`，suggestion「移除该 entity 定义或改名」）；缺失则 pass（inject 兜底） | MUST 比较时排除 `system` 字段（leader DSL 经 parser 后无 system，比较必假）；MUST NOT 阻止 omission（缺 task 时 pass，inject 处理）；MUST 命中所有 system entity（用 SYSTEM_ENTITY_DEFS 遍历，不硬编码 task） | panorama_builtin §3/§8 不变量（v0.0.243 改写） | +35 |
| panorama_validation | app/server/src/squad/panorama/validation/validate_schema.ts | validateSchema | 修改 | 主入口在 Layer 2 (checkSchema) 之后、Layer 3 (validateSemantic) 之前调 `checkSystemEntityImmutable(schema, errors)` | MUST 在所有 caller（tool runDefine / HTTP execDefine / validate endpoint）生效；MUST NOT 依赖 oldSchema（canonical 即权威） | 本 spec §1 决策 4 | +3 |
| panorama_validation | app/server/src/squad/panorama/validation/index.ts | (re-exports) | 修改 | 加 `checkSystemEntityImmutable` 导出 | — | — | +1 |
| panorama_tool | app/server/src/squad/panorama/tool/panorama-tool-actions.ts | effectiveSchema | 修改 | 重命名为 `readSquadSchema(rtc, dataDir)`：内部改调 `ensureSystemEntities(store(rtc, dataDir))`（替代 `readEffectiveSchema`），返回非 null schema | MUST 保证 read 路径 task entity 恒在（lazy migration 在此触发）；返回类型从 `PanoramaSchema`（合并版）变为同（已落盘版）—— API 形状不变 | 本 spec §1 决策 1 | +2/-2 |
| panorama_tool | app/server/src/squad/panorama/tool/panorama-tool-actions.ts | runDefine | 修改 | `validateSchema` 通过后、`applyMigration` 之前调 `injectSystemEntities(parsed.schema)`（强制 task 进 newSchema）。**顺序关键**：validate 先跑（让 checkSystemEntityImmutable 看到 leader 提交的原始 task → 拒字段漂移）；validate pass 后再 inject（让 applyMigration 的 oldSchema/newSchema diff 两边都含 task → 不误判 entity_deleted=task 触发破坏性迁移） | MUST validate → inject → applyMigration 顺序（反序会让 check 失效或 diff 误判）；MUST 落盘 newSchema 必为 canonical task；dryRun 路径不注入（不落盘） | 本 spec §1 决策 2/3；apply_migration diff 行为 | +6 |
| panorama_tool | app/server/src/squad/panorama/tool/panorama-tool-actions.ts | runGetSchema | 修改 | 改用 `ensureSystemEntities(store)` 后 readBoard 序列化返（task 已落盘，YAML 含 task entity/view） | MUST 返包含 task 的 DSL（修认知 bug：agent 可见 task）；空 squad 也返 task-only schema（非 null） | reqs v0.0.243 §目标；panorama_api §1.1（doc-modifier 同步） | +3/-2 |
| panorama_tool | app/server/src/squad/panorama/tool/panorama-tool-data-actions.ts | resolveEntity | 修改 | 删 `BUILTIN_ENTITY_DEFS[entity]` 短路（builtin 概念废除）；空 board 不再特判（readSquadSchema 已 ensure task）；非 system entity 在空 schema 上仍报 `panorama_schema_not_defined`（task 是 system entity，ensure 后必在） | MUST task entity 永远 resolved（system ensure 兜底）；MUST NOT 误判其他 entity 为「永远 defined」 | 本 spec §3 | +2/-4 |
| panorama_tool | app/server/src/squad/panorama/tool/panorama-tool-data-actions.ts | runCreate/runUpdate/runTransition | 修改 | `afterTaskWrite(rtc.selfSquadId!, s, dataDir)` 改为 `afterTaskWrite(s)`（签名简化） | MUST 保留 entity==='task' 条件触发；MUST NOT 改触发条件（dependencies/status 触发不变） | task-hooks afterTaskWrite 签名 | +3/-3 |
| panorama_http | app/server/src/squad/panorama/http/panorama-routes-impl.ts | effectiveSchema | 修改 | 重命名 `readSquadSchema(ctx)`：改调 `ensureSystemEntities(store(ctx))` | 同 tool readSquadSchema 约束 | 本 spec §1 决策 1 | +2/-2 |
| panorama_http | app/server/src/squad/panorama/http/panorama-routes-impl.ts | schemaOr409 | 修改 | 删 `BUILTIN_ENTITY_DEFS[entity]` 短路（task 不再例外，因 ensure 后必在 schema 内）；非 system entity + 空 schema → 409 不变 | MUST NOT 误返 409 for task（ensure 兜底） | 本 spec §3 | +1/-2 |
| panorama_http | app/server/src/squad/panorama/http/panorama-routes-impl.ts | handleGetSchema | 修改 | 返 `readSquadSchema(ctx)` 序列化（task 含在内）；空 squad 返 task-only schema（非 null） | 同 runGetSchema；MUST doc-modifier 同步 API spec §1.1（返含 task 的 DSL） | reqs v0.0.243 §目标；panorama_api §1.1 | +2/-2 |
| panorama_http | app/server/src/squad/panorama/http/panorama-routes-impl.ts | execDefine | 修改 | `validateSchema` 通过后、`applyMigration` 之前调 `injectSystemEntities(parsed.schema)`（同 runDefine 顺序：validate 先看 leader 版本 → pass 后 inject → applyMigration diff 两边含 task） | 同 runDefine 顺序约束 | 本 spec §1 决策 2/3；apply_migration diff 行为 | +4 |
| panorama_http | app/server/src/squad/panorama/http/panorama-routes-impl.ts | handleCreateEntity/handlePatchEntity/handleTransition | 修改 | `afterTaskWrite(ctx.squadId, s, ctx.dataDir)` 改 `afterTaskWrite(s)` | 同 tool data-actions | task-hooks 签名 | +3/-3 |
| web_panorama | app/web/src/components/studio-page/panorama-types.ts | BUILTIN_TASK_ENTITY_DEF | 删除 | 删前端镜像常量（后端单一来源） | MUST 同步删所有引用（panorama-utils/component-panorama-route/__tests__） | 本 spec §3 | -45 |
| web_panorama | app/web/src/components/studio-page/panorama-types.ts | BUILTIN_TASK_VIEW_DEF | 删除 | 删（同上） | — | 本 spec §3 | -10 |
| web_panorama | app/web/src/components/studio-page/panorama-types.ts | BUILTIN_ENTITY_DEFS | 删除 | 删（同上） | — | 本 spec §3 | -2 |
| web_panorama | app/web/src/components/studio-page/panorama-types.ts | BUILTIN_VIEWS | 删除 | 删（同上） | — | 本 spec §3 | -2 |
| web_panorama | app/web/src/components/studio-page/panorama-types.ts | mergeBuiltinSchema | 删除 | 删合并函数（后端返 schema 已含 task，前端不再合成） | MUST 改 parsePanoramaDsl 不再调它 | 本 spec §3 | -12 |
| web_panorama | app/web/src/components/studio-page/panorama-utils.ts | parsePanoramaDsl | 修改 | 删 `mergeBuiltinSchema(dsl)` 调用；parse 后直返 schema（YAML 已含 task） | MUST 保留最小结构守卫（entities/views 存在）；MUST NOT 再依赖前端镜像 | 本 spec §3 | +0/-3 |
| web_panorama | app/web/src/components/studio-page/component-panorama-route.tsx | (schema loader) | 修改 | 删 `dsl === null ? mergeBuiltinSchema(null) : parsePanoramaDsl(dsl)` 的 null 分支合并；空 DSL（理论不出现，因 ensure 兜底）走空态分支 | MUST 保留 parsePanoramaDsl 调用；空态 idle 引导逻辑不变 | 本 spec §3 | +1/-2 |

## 影响面评估

**跨模块**：panorama_dsl（types）→ panorama_builtin（task-schema + 新 system-entities + 删 effective-schema + task-hooks）→ panorama_validation（新 validate_system_entity + 主入口 wire）→ panorama_tool（actions + data-actions）→ panorama_http（routes-impl）→ web/panorama（前端镜像删除）。依赖顺序：types 先 → builtin 模块 → validation → tool/http 并行 → web。

**破坏性变更**：
- `readEffectiveSchema` 删除（公共导出，但仅 panorama 内部用 → 内部 break，无外部 API break）
- `BUILTIN_ENTITY_DEFS`/`BUILTIN_VIEWS` 删除（同上，内部）
- `afterTaskWrite` 签名变（squadId/dataDir 参数移除）— 内部 API，3 处 caller 同步改
- **HTTP `GET /schema` 行为变**：返 DSL 含 task entity（v0.0.240 返纯 leader DSL 不含 builtin）— agent 可感知（修认知 bug，正是本版本目标）；doc-modifier 同步 `specs/api/overall/14-panorama-endpoints.md §1.1`

**风险点**：
1. **lazy migration 并发**：两并发 read 触发 ensureSystemEntities → 都 read null → 都 write。atomicWriteSync 保证不损坏文件；内容相同（TASK_ENTITY_DEF 是常量）→ 无害。可接受。
2. **leader 已有 task 变体被覆盖**（migration 冲突）：req 明确「无有效 task 数据，概率低」+ system-wins 策略。覆盖前不数据迁移（task 实例数据本就忽略）。低风险。
3. **define 的 inject 时序**：必须 **validate 后 + applyMigration 前**（见决策 5）。顺序错则两类 bug：(a) inject 先于 validate → checkSystemEntityImmutable 看到 canonical → trivially pass → 失去防 leader 改 task 能力；(b) inject 后于 applyMigration → applyMigration 的 oldSchema/newSchema diff 看到 newSchema 缺 task → 误判 `entity_deleted:task` → 触发破坏性迁移或 4 拒。
4. **前端 null DSL 兜底**：理论 ensure 兜底后 squad schema 不为 null（task 必在）。但若 squad 还没被任何 panorama 路径触达（极冷启动），GET schema 触发 ensure → 返 task-only schema 非 null。前端 parsePanoramaDsl(null) 不会发生。保留 idle 引导逻辑防御极端场景。

**测试覆盖**：
- 删 `builtin/__tests__/effective-schema.test.ts`（readEffectiveSchema 已删）
- 新 `builtin/__tests__/system-entities.test.ts`：injectSystemEntities（覆盖 leader 变体）、ensureSystemEntities（null/无 task/有非 system task/已 system task 四态幂等）
- 新 `validation/__tests__/validate_system_entity.test.ts`：leader 提交 task 字段不一致 → error；一致 → pass；缺失 → pass
- 改 `studio-page/__tests__/panorama-utils.test.ts`：删 mergeBuiltinSchema 相关 case
- 改 `tool/__tests__` + `http/__tests__` 中 task 相关 UT：afterTaskWrite 签名、get_schema 返含 task

**doc-modifier 阶段 5 同步清单**：
- `specs/tech/squad/[P1]panorama_builtin.md`（architect 本版本已改写，doc-modifier 复核代码对齐）
- `specs/tech/squad/[P1]panorama_dsl.md`（EntityDef 加 system 字段）
- `specs/tech/squad/[P1]panorama_tools.md`（get_schema 返含 task）
- `specs/api/overall/14-panorama-endpoints.md` §1.1（GET schema 返含 task 的 DSL）
- OKF KB：`specs/tech/squad/index.md` + `log.md`（v0.0.243 决策记录）

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- 实现细节合理偏离（如 inject 比较函数实现方式、deepEqual 库选择）→ coder 决策 + 汇报，orchestrator 裁决是否触发 spec 同步
