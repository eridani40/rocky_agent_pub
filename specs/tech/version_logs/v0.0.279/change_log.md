# v0.0.279 tech change log — squad 团队默认推理强度（effortDefault）

> 对应需求：`reqs/[working] v0.0.279/req.md`（用户可感知的行为改动 → 走完整 PRD）。
> PRD：`specs/prd/version_logs/v0.0.279/prd.md`（D1-D4 + UC-1~7）。
> 权威契约：`specs/tech/version_logs/v0.0.279/change_plan.md`（method 级 12 行表，frozen）。

## 变更摘要

### 需求与动机

squad 成员级 effort（推理强度）已存在（session.effort 4 档），但团队没有默认档——每个成员要么自己显式设，要么落厂商默认（undefined）。需求：给 squad 一个「团队默认推理强度」（effortDefault）——成员未显式设置时，用团队默认；团队也未设时，落厂商默认。**覆盖链两层（老板拍板）：成员显式档（low/high/max）→ 用之；否则团队 effortDefault（low/high/max）→ 用之；否则 undefined（厂商默认，encode 不注入）**。

### 方案（关键裁决，详见 change_plan「架构期裁决」）

1. **覆盖链两层**（D1）：成员 `'default'` 与 `undefined` 同语义（不覆盖 → 落团队/厂商默认）；resolveEffort 纯函数（session-config 新增）。
2. **resolve 时机与 model 一致**（D3）：`buildSessionConfigFromDeps` 与 resolveModel 同区调 `resolveEffort(sessionPersist.effort, isStudio && squad ? squad.effortDefault : undefined)`；每次 `resolveConfigBySid` 现拉无 cache——团队改设置下一次 run 立即生效。
3. **encode 层零改动**（D3）：resolve 完 config.effort 已是 low/high/max/undefined，encode guard 原样生效（`'default'` 不注入 output_config）。
4. **字段语义**（D2）：schema `required:false`（存量无字段=default）+ 读取 `?? 'default'` 兜底 + PATCH `!== undefined` 才写、显式 `'default'` 也落盘（不清空）+ 非法值 400（字段级，先于 404）。
5. **UI**（D4）：ManageTab modelDefault 下方加 effortDefault 下拉（4 档 default/low/high/max，state 初始 = detail.effortDefault 恒有值，dirty + save patch 恒带）。

### T1 — 后端（commit 2ca91e69f，9 文件 +255/-9）

- **schema `squad.ts:50`**：`effortDefault: { type: 'string', required: false }`（对齐 modelDefault 模式放其下方；存量无字段=default 兼容）。
- **handlers/squad.ts**：PatchSquadBody `effortDefault?: 'default'|'low'|'high'|'max'`（L112）+ `isValidEffortDefault()` 校验 helper（L123-125）+ PATCH 字段级校验 `!== undefined && !isValid` → 400（L396-397，先于查 squad=先于 404）+ 落盘 `!== undefined` 才 patch（L430，显式 'default' 也落盘）+ toDetail 回显 `?? 'default'`（L269，存量兼容）。
- **session-config.ts**：`resolveEffort()` 纯函数（L107-114，覆盖链：sessionEffort∈{low,high,max}→用之；否则 squadEffortDefault∈{low,high,max}→用之；否则 undefined）+ buildSessionConfigFromDeps 与 resolveModel 同区算 `resolvedEffort`（L255-260）+ 注入点 L354 `...(resolvedEffort !== undefined ? { effort: resolvedEffort } : {})`（源头不再直读 session record，encode 层零改动）。
- **UT**：session-config-studio.test 覆盖链 4 分支（成员显式 / 成员 default+团队 / 双 default / 非 studio）+ config.effort 注入 4 例；squad-handler.test PATCH 5 case（合法落盘+回显 / 非法 400 / 显式 default 落盘 / 存量回显 default / PATCH name 不动 effortDefault）。**43 核心 + 43 回归全绿（bun --bun）**；pre-existing 失败 1（session-config-subagent.test.ts maxIterations 断言 200 vs 实际 1000——v0.0.204 遗留，本任务 git diff 空，独立核实成立）。

### T2 — 前端（commit a19eca33e，前端 5 文件 + 测试 + states）

- **squad-types.ts**：SquadDetail.effortDefault（L126 恒有值）+ PatchSquadBody.effortDefault（L165 optional）。
- **component-manage-tab.tsx**：ModelPicker 下方加 effortDefault 下拉（L100-112，Dropdown 原语 component-shared-selector，4 档，state 初始 = detail.effortDefault，dirty L53 加比较，save patch L67 恒带 effortDefault）；i18n `studio:manageTab.effortDefaultLabel` + `effortOptions.{default|low|high|max}`（en/zh 双语）。
- **UT**：component-manage-tab.test.tsx 3 用例（渲染 4 档 + save patch 含 effortDefault + dirty 判定）。**3/3 新 + studio-page 404/404 回归全绿 + tsc 0（bun --bun 独立复验）**。

### 代码↔spec 核实（doc-modifier 阶段 5）

| 契约点 | 代码 | 结果 |
|---|---|---|
| 字段名/语义 == spec（PATCH undefined 不改 / 显式 default 落盘 / 回显 ?? default） | schema `squad.ts:50` required:false + handler `squad.ts:396-397` 校验 + `L430` 落盘 + `L269` 回显 | ✅ |
| resolveEffort 覆盖链（成员 > 团队 > undefined）== llm_protocol_interface §3.8 注记 | `session-config.ts:107-114` 纯函数 + `L255-260` 调用 + `L354` 注入 | ✅ |
| UI 下拉候选（default/low/high/max）== 06-studio §3.2 | `component-manage-tab.tsx:22` EFFORT_LEVEL_OPTIONS + `L100-112` Dropdown | ✅ |
| 零改动边界（encode/model-resolver/成员 picker/playground+academy/subagent） | T1/T2 commit 文件清单 + review 独立 git diff 核实（encodeAnthropicMessages / model-resolver.ts / component-input-effort-picker.tsx / createSquadService / playground+academy+standalone / subagent 全未触碰） | ✅ |

### 偏离记录

- **EFFORT_LEVELS 未 export → 本地 EFFORT_LEVEL_OPTIONS（coder2 自报，reviewer 4Q 判断合理）**：change_plan 假设复用 `component-input-effort-picker.tsx` 已 export 的 `EFFORT_LEVELS`（L29），但实际**无 export 关键字**（仅 L26 `EffortLevel` 类型 export）。约束「MUST NOT 改成员级 picker 文件」+ 复用类型 → 本地定义值数组 `EFFORT_LEVEL_OPTIONS = ['default','low','high','max']`（同值同序对齐成员级，注释标注）。语义等价 + 遵守约束 + 已报备（coder 报告 / commit message / context findings）。
- **TDZ/顺序类偏离**：无（T1/T2 无函数顺序依赖问题；resolveEffort 独立纯函数导出，无 TDZ）。
- **影响行偏差**：T1 schema +4（计划 +4 ✅）/ handler +19（计划 +9，略超但 <3x 合理）/ session-config +17（计划 +9，含注释详细，合理）/ T2 manage-tab +26（计划 +18，含 Dropdown 装配，<3x 合理）。

## 文档同步（doc-modifier 阶段 5）

- `specs/api/overall/11a-squad-endpoints.md`：版本注记 + §1.3 SquadDetail `effortDefault`（回显 ?? 'default'）+ §1.4 PatchSquadBody（undefined 不修改 / 显式 default 落盘 / 非法 400 先于 404）+ 行为变更段 + 错误段。
- `specs/ui/overall/06-studio.md §3.2`：管理 tab 加「默认推理强度（v0.0.279，effortDefault）」段（Dropdown 4 档 + state 初始 + dirty + save patch 恒带 + 覆盖链指针 + i18n 键）。
- `specs/ui/components/studio-page/squad-panel.md`：解体占位补 ManageTab 现状指引（effortDefault 下拉见 06-studio §3.2 + 覆盖链见 llm_protocol_interface §3.8）。
- `specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §3.8`：透传链后补「studio 覆盖链（[v0.0.279]）」注记（resolveEffort 纯函数位置 + 成员>团队>undefined + resolve 时机与 model 一致 + 非 studio/subagent 边界 + 数据契约指针）。
- `specs/tech/squad/[P1]data_model.md §1.1`：Squad interface 加 `effortDefault?: 'default'|'low'|'high'|'max'`（schema required:false + ?? 'default' 兜底 + PATCH 语义 + 覆盖链指针）。
