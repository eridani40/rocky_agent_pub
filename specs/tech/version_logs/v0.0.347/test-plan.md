# v0.0.347 测试计划 — 模型路由降级（组合方案 + attempt 内路由 + 三态熔断）

> 权威输入：PRD `specs/prd/model-routing-PRD-2026-08-14.md`（§3 三条关键路径 = 测试最低覆盖；§4 验收 9 条）+ 方案设计 v3.2（D1-D17 全部拍板）+ tech `[P0]model_routing.md` + api `21-model-routing.md` + change_plan `specs/tech/version_logs/v0.0.347/change_plan.md`（method 级契约）+ task.json（T1 后端配置层 / T2 后端路由层 / T3 前端）。
> **版本验证标准判定**：有后端行为变更（新端点 + 路由机制 + 挂载字段）→ AT 必须；前端用户可感知新板块 UI（方案库面板/编辑器/时间控件/红绿灯/squad 挂载）→ ET 必须；无设计稿 → 视觉保真门禁跳过。

## 0. 范围概览

- **UT**：T1/T2/T3 内嵌（coder 白盒：validation 全规则 / routing_loop 全路径 / circuit 三态机 / 分支 2 合成 / 组件测试），见 §2
- **AT**：4 条新增（tests/api/model-routing/），**入选持久用例库**（判定 §3.1）
- **ET**：4 条临时验证路径（**不新增持久 case.md**，判定 §4.1）
- **视觉保真**：无设计稿 → 跳过

## 1. 路径→case 映射（PRD §3 关键路径 = 最低覆盖）

### P-A 配置方案（设置 → 模型 tab → 新建方案 → 添加 Kimi(带时间 02-23, 启用)+GLM(无条件, 启用) → 保存）

| 子路径 | 描述 | 覆盖 |
|---|---|---|
| P-A1 | 新建方案（name/items 合法）保存成功 | AT mr_tc1 + UT(validation) + ET-1 |
| P-A2 | 条目时间条件 hours 白名单 + enabled 开关落库 | UT(validation) + 组件测试 + ET-1 |
| P-A3 | 同模型约束校验（2 带时间/2 不带/带时间在下）→ 保存 400 + 提示 | AT mr_tc1(step3-5) + UT(validation UC-21/22/23) + 组件测试 |
| P-A4 | 时间控件交互（拖拽连续段/多段加选/清空=全天/hover） | 组件测试(hour-grid-picker) + ET-1 |
| P-A5 | 删除方案 = 解除挂载 + 回退默认模型 | AT mr_tc1(step6-8) + ET-4 |

### P-B 挂载方案（group 设置 → 挂载方案 → session 设 default → 发消息）

| 子路径 | 描述 | 覆盖 |
|---|---|---|
| P-B1 | squad PATCH 挂载 modelRoutingPlanId 成功 + 回显 | AT mr_tc2(step1-2) + ET-2 |
| P-B2 | 挂载校验：planId 不存在 → 400 | AT mr_tc2(step3) + UT(handler) |
| P-B3 | 解除挂载：null 清空 / undefined 不写 | AT mr_tc2(step4-5) + UT(squad-service) |
| P-B4 | 挂载后 session default 发消息走方案链（Kimi 时间命中则尝试，未命中降级 GLM） | AT mr_tc4（401 降级实证）+ UT(session-config 分支 2) + ET-2 |
| P-B5 | session 显式模型 priority 0 合成（不写回方案实体） | UT(session-config 合成测试)（AT 不构造：需真调 + 外部行为，见 §3.1） |
| P-B6 | playground 挂载/解除（PUT model_routing） | AT mr_tc1(step7 附带) |

### P-C 调用降级（方案 Kimi→GLM 挂载；Kimi 连续失败触发熔断 → 发消息）

| 子路径 | 描述 | 覆盖 |
|---|---|---|
| P-C1 | 主模型失败 → 自动降级下一候选成功（核心链） | AT mr_tc4 + UT(routing_loop UC-14/15/16) |
| P-C2 | 401 AUTH → 直接熔断 Open + banned → 降级 | AT mr_tc4（无效 key 确定性触发）+ UT(UC-16) |
| P-C3 | 429 快速失败 0 重试降级 / 网络 1 次重试 | UT(routing_loop UC-14/15)（AT 不入选，见 §3.1） |
| P-C4 | 熔断三态 + 状态呈现映射（normal/abnormal+倒计时/observing） | AT mr_tc3(closed) + mr_tc4(open/half_open) + UT(UC-18/19/20) + ET-3(红绿灯) |
| P-C5 | 同模型多 item 去重（bannedModels） | UT(routing_loop UC-17)（AT 不构造） |
| P-C6 | 时间过滤跳过（不消耗尝试/不计熔断）+ 候选空「当前无可用模型」 | UT(routing_loop)（AT 不入选：依赖本地时钟，见 §3.1） |
| P-C7 | ABORTED_BY_USER 不计失败直接返回 / 全失败聚合错误 | UT(routing_loop) |

### 验收 §4 覆盖总览

| 验收 | 覆盖 |
|---|---|
| 1 CRUD 全通 + 删除解除挂载 | AT mr_tc1 + UT + ET-1/4 |
| 2 条目启停（停用跳过/重启用恢复） | UT(routing_loop enabled) + 组件测试（AT 不构造：路由行为白盒） |
| 3 时间条件白名单/清空=全天/成熟控件 | 组件测试 + ET-1（AT 不入选：本地时钟 + UI 交互） |
| 4 挂载层级（group 挂/priority 0 合成/session 不能配方案） | AT mr_tc2 + UT(session-config) |
| 5 降级链（429 快速/网络 1 次/401 直接熔断/同模型去重） | AT mr_tc4(401) + UT(全) |
| 6 熔断呈现（三维隔离/🔴倒计时/🟡无倒计时/恢复🟢） | AT mr_tc3/4 + UT(UC-18/19/20) + ET-3 |
| 7 配置校验硬拒绝 | AT mr_tc1 + UT(validation) + 组件测试 |
| 8 失败语义（全计入熔断/ABORTED 不计/看门狗沿用） | UT(routing_loop + registry) |
| 9 分支 1 零回归 | UT 既有全绿 + ET-5（解除挂载回退默认） |

## 2. UT（coder 白盒，编码完成后回填结果）

| Task | 文件 | 覆盖 |
|---|---|---|
| T1 | `services/__tests__/model-routing-validation.test.ts` | validateModelRoutingPlan 全规则：合法/2 带时间拒/2 不带时间拒/带时间在下拒/provider 不存在/model disabled/priority 非法/enabled 缺省兼容（UC-21/22/23 + 校验 9 条） |
| T1 | kv-config DELETE 白名单 + squad patch 透传/校验（并入既有或新增） | DELETE 非 model_routing_plans → 405；PATCH !== undefined 才写/null 清空 |
| T2 | `llm/caller/__tests__/routing_loop.test.ts` | 时间过滤跳过（不计尝试/不计熔断）/enabled=false 跳过/Open 跳过+banned/同模型多 item 只试一次（UC-17）/429 快速降级（UC-14）/网络 1 次（UC-15）/401 直接 Open（UC-16）/全失败聚合/ABORTED 返回/候选空「当前无可用模型」（UC-6/10） |
| T2 | `llm/caller/__tests__/circuit_breaker_registry.test.ts` | 连续 4 失败 Open/60s 后 HalfOpen/限流 1 探测/连续 2 成功 Closed/探测失败回 Open/三维隔离（UC-18）/默认参数+覆盖（UC-19/20） |
| T2 | session-config 分支 2 合成测试 | 挂载查询/合成候选链（session 显式 priority 0 不写回；default 原序）/无挂载分支 1 零回归 |
| T3 | `component-model-routing-plan-editor.test.tsx` | 条目增删/上移下移/enabled/同模型本地预检/时间条件打开/熔断高级区（P-A） |
| T3 | `component-hour-grid-picker.test.tsx` | 拖拽连续段/多段加选/清空=全天(hours:[])/hover/value 输出（UC-8/9） |

## 3. AT（4 条新增，tests/api/model-routing/）

### 3.1 入选决策

**4 条均入选持久用例库**，理由：
1. **mr_tc1（方案库 CRUD + 校验 + DELETE 解除挂载）**：方案库是本 feature 全新后端端点组（PUT 校验钩子 + 新增 DELETE 分支 + 引用解除），属「新后端端点 + 引用一致性」高价值区；DELETE 解除挂载漏做会导致挂载方指向幽灵方案（change_plan 风险 7）——黑盒回归保护必要。
2. **mr_tc2（squad 挂载 PATCH）**：挂载是 P-B 关键路径入口；null 清空/undefined 不写/planId 400 三个语义是「写时语义」契约，黑盒可确定性验证；squad 是核心实体，防回归价值高。
3. **mr_tc3（status 端点 closed 映射 + 404/400）**：新端点；presentation 映射（closed→normal 无 remainingSeconds）确定性可测。
4. **mr_tc4（401 直接熔断 + 降级链 + open/half_open 呈现）**：P-C 核心路径黑盒实证——用**无效 API key provider** 确定性触发 401 → 直接熔断 Open → 降级到有效 minimax 模型成功返回 → status 断言 abnormal+remainingSeconds → 方案级 `circuit.timeoutSeconds=1` 覆盖 → 1s 后 observing（half_open 映射）。**不依赖外部 provider 行为**（无效 key 必然 401），是真调 LLM 链路（对齐 member_rename_envelope_tc2 先例）。

**路由降级链其余分支 AT 不入选，UT 覆盖**，逐条理由：
- **429 快速降级 / 网络 1 次重试**：需外部 provider 真实限流/断网，test env 无 mock provider（v0.0.190 删 stub，case 真实调 provider）——不可控，无法确定性触发；UT 注入 fake attemptLoop 可精确断言（routing_loop.test.ts）。
- **时间过滤跳过**：依赖本地时钟当前小时，test env 无法冻结时钟制造「当前小时 ∉ hours」确定性窗口；UT 注入时钟可测（UC-10）。
- **同模型去重（bannedModels）/ enabled 跳过**：白盒状态轨迹（attempt state 不落盘、无端点可查），黑盒无法断言「只试一次」；UT 全分支覆盖（UC-6/17）。
- **half_open 探测恢复 Closed**：恢复需「探测连续成功 2 次」，AT 里无效 key 探测必失败（立即回 Open），无法确定性走通恢复路径；UT registry 状态机覆盖（UC-20）。

### 3.2 mr_tc1 — 方案库 CRUD + 同模型约束 400 + DELETE 解除挂载

契约：api §2.1/§2.2/§2.3 + change_plan（validation/store/deletePlan）。

| step | 操作 | 断言 |
|---|---|---|
| setup-1 | 读 provider 列表（GET /config/app?group=providers）取 2 个已启用 provider+model | 200；save pid_a/pid_b + mid_a/mid_b |
| 1 | PUT 方案 `{group:'model_routing_plans', key:'<plan_id>', data:{items:[A(priority1), B(priority2)]}}` | 200 `.ok == true` |
| 2 | GET /config/app?group=model_routing_plans | 200；`.items[] any .key == plan_id`（落库） |
| 3 | PUT 违规方案（同模型 2 带时间） | 400；`.message ~= "cannot have 2 time-condition items"` |
| 4 | PUT 违规方案（同模型带时间在下） | 400；`.message ~= "time-condition item must be above"` |
| 5 | PUT 违规方案（同模型 2 不带时间） | 400；`.message ~= "cannot have 2 unconditional items"` |
| 6 | PATCH squad 挂载该方案 + PUT playground 挂载 | 200（先挂载，为 step7 造引用） |
| 7 | DELETE /config/app?group=model_routing_plans&key=plan_id | 200；`.detached` 含 `squad:<id>` 与 `playground`（解除挂载） |
| 8 | GET squad 回读 + GET model_routing | squad 无 modelRoutingPlanId 字段（省略）；playground data 为空（回退默认） |
| 9 | DELETE 不存在的 planId | 404 |
| 10 | DELETE 非白名单 group（如 providers） | 405 |
| teardown | DELETE 解散 squad | 200/404 容忍 |

设计要点：plan_id 用 `zz-mr-{sid}` 派生（不依赖清理残留）；违规 400 断言 message 子串（框架无 >/<，用 `~=`）；步骤 3-5 不落盘由步骤 2 的列表不含违规方案佐证（或独立 PUT 后 GET 确认 absent）。

### 3.3 mr_tc2 — squad 挂载 PATCH（null 清空 / undefined 不写 / planId 不存在 400）

契约：api §2.5 + change_plan（squad handler/service）。

| step | 操作 | 断言 |
|---|---|---|
| setup-1 | POST /squad 建队 | 201；save squad_id |
| setup-2 | PUT 方案 A（合法 2 条目）+ PUT 方案 B（合法 1 条目） | 200 |
| 1 | PATCH /squad/{id} {modelRoutingPlanId: planA} | 200；`.modelRoutingPlanId == planA`（挂载回显） |
| 2 | GET /squad/{id} | 200；`.modelRoutingPlanId == planA`（落盘一致） |
| 3 | PATCH {modelRoutingPlanId: '01KZZ...Z'（不存在 ULID）} | 400；`.message ~= "plan not found"` |
| 4 | PATCH {modelRoutingPlanId: null} | 200；响应无 modelRoutingPlanId 字段（清空省略） |
| 5 | GET /squad/{id} | 200；无 modelRoutingPlanId 字段（null 清空落盘） |
| 6 | PATCH body 不含 modelRoutingPlanId（改 name） | 200；name 变更且 modelRoutingPlanId 仍无（undefined 不写） |
| teardown | DELETE 解散 squad | 200/404 容忍 |

设计要点：不存在 planId 用硬编码无效 ULID（确定性，不依赖清理残留）；「无字段」断言用 `exists` 反义不可用 → 用 `.modelRoutingPlanId absent`（框架归零态用 exists/absent，DSL 陷阱 2 兼容）；step6 验证 undefined 不写 = 先 step4 清空再 PATCH 无该字段，断言仍无。

### 3.4 mr_tc3 — status 端点（closed 映射 + 404/400）

契约：api §2.6 + change_plan（status handler）。

| step | 操作 | 断言 |
|---|---|---|
| setup-1 | PUT 方案 A（2 条目：A1/Kimi + A2/GLM） | 200 |
| 1 | GET /model-routing/plans/{planA}/status | 200；`.planId == planA`；`.items.size >= 2`；items[] 每个 `.circuitState == "closed"` 且 `.presentation == "normal"`（closed 映射：无 remainingSeconds） |
| 2 | GET /model-routing/plans/{不存在}/status | 404 |
| 3 | GET /model-routing/plans//status（空 planId） | 400 |
| teardown | （方案保留或 DELETE 清理） | — |

设计要点：无任何调用 → 熔断全 Closed → normal；`remainingSeconds absent` 断 closed 无倒计时；open/half_open 映射由 mr_tc4 覆盖（此 case 只断 closed 基态 + 错误码）。

### 3.5 mr_tc4 — 401 直接熔断 + 降级链 + open/half_open 呈现（P-C 核心）

契约：api §2.6 + tech §5/§6/§7 + change_plan（routing_loop/registry/分支 2）。

| step | 操作 | 断言 |
|---|---|---|
| setup-1 | PUT provider 无效 key（如 anthropic `sk-invalid-...`，base_url 真实可达） | 200（providers group 写 provider，save bad_pid） |
| setup-2 | PUT 方案 `{items:[{bad_pid+model, priority1}, {minimax_provider+model, priority2}], circuit:{timeoutSeconds:1}}` | 200；save plan_id |
| setup-3 | POST /squad 建队 + PATCH 挂载方案 | 201/200 |
| setup-4 | POST /squad/{id}/session（或既有 session 入口） | 200；save sid（session 设 default） |
| 1 | POST /session/{sid}/messages（prompt 触发 LLM 调用）→ run 同步等终态 | 200；`.tool_result exists`（消息成功——坏模型 401 后降级到 minimax 成功，非「所有候选模型不可用」） |
| 2 | GET /model-routing/plans/{plan_id}/status | 200；坏模型条目 `.circuitState == "open"` + `.presentation == "abnormal"` + `.remainingSeconds exists`（🔴 带倒计时）；minimax 条目 `.presentation == "normal"`（降级成功未熔断） |
| 3 | wait 2s（timeoutSeconds=1 已过）→ GET status | 坏模型条目 `.circuitState == "half_open"` + `.presentation == "observing"` + `.remainingSeconds absent`（🟡 无倒计时） |
| teardown | DELETE 解散 squad + DELETE 方案 | 200/404 容忍 |

设计要点：
- **无效 key 确定性触发 401**（AUTH_INVALID）→ 直接熔断 Open + banned → 降级 minimax 成功（P-C1/P-C2 黑盒实证）；不依赖外部 provider 故障；
- **circuit.timeoutSeconds=1 方案级覆盖**（api §3 支持）→ 1s 后 Open→HalfOpen，避免等 60s，half_open 映射可黑盒断言（框架 wait timeout 上限 60 内）；
- 坏模型条目在 status 按 priority 去重只出一条（同模型多 item 场景不构造，UT 覆盖 UC-17）；
- 真调 LLM 步骤 timeout 240；429/529/503 框架层自动 skip 不算 fail；
- provider 无效 key 写入：providers group 数据形状对齐 app_config spec（AT designer 实现时核对；key 无效不影响 PUT 校验——校验只查 enabled provider/model 存在性）。

### 3.6 持久冒烟集 ≤20 条约束评估

- **本版 +4 条**（AT 库 33 → 37 条，已超团队「冒烟集 ≤20」上限）——**评估结论：4 条均必须入选**（理由 §3.1：全新端点组 + 核心挂载语义 + P-C 核心路径黑盒实证；leader 要求「必选 3 组」+ 降级链评估后入选 401 链）。**超限治理提示**：v0.0.340 test-plan 已提示（33 条），本版继续累积，建议后续版本对低价值旧 case（如纯 UI 回归类）做一次治理瘦身——**非本版范围**。
- 新 feature 不新增持久 case 的评估：本 feature 是 P0 新板块（新端点 + 新路由机制 + 老板验收核心路径），不适用「普通 feature 不新增持久 case」豁免；但**不为次要 UC 新增**（429/网络/时间过滤/去重/恢复全归 UT，见 §3.1）。

## 4. ET（4 条临时验证路径，不新增持久 case.md）

### 4.1 判定

本版 UI 改动大（新板块：方案库面板/编辑器/时间控件/红绿灯/squad 挂载），但均为**常规表单交互**（非高 LLM 不确定性场景），后端契约已由 AT 4 条 + UT 全覆盖 → **ET 4 条临时验证**（真实 app 操作 + 截图留证，不落 tests/e2e/ 持久 case.md；对齐 340 先例）。

### 4.2 临时验证路径（executor 执行，states/v0.0.347/verify/e2e/ 留证）

| # | 操作链路 | 预期 |
|---|---|---|
| ET-1 | 设置 → 模型 tab → 方案库 → 新建方案 → 添加 Kimi(带时间 02-23, 启用)+GLM(无条件, 启用) → 保存 | P-A 全链路：方案保存成功；时间控件拖拽/清空交互正常；故意违反同模型约束（带时间在下）→ 本地预检阻止保存并提示 |
| ET-2 | studio squad 管理面板 → 挂载方案 → session 设 default → 发消息 | P-B 全链路：消息走方案链成功返回（正常模型）；挂载下拉出现方案、解除入口正常 |
| ET-3 | 方案含无效 key 模型挂载 → 发消息 → 看方案列表红绿灯 | P-C 呈现：消息成功（降级）；红绿灯 🔴 异常带倒计时 → 60s 后 🟡 观察中（默认参数，可临时改 timeoutSeconds 加速）；恢复 🟢 |
| ET-4 | 方案库 CRUD UI：新建/重命名/复制/删除（删除确认提示解除挂载）+ 红绿灯 🟢/🟡 呈现 + i18n 中文 | CRUD 全通；复制生成「<原名> 副本」独立编辑；删除后 squad 挂载下拉消失该方案 |
| ET-5 | 解除挂载（PATCH null）→ 发消息 | 回退默认模型（分支 1 零回归 UI 确认，验收 9） |
| ET-6（T6） | squad 管理面板 → 打开「默认模型/方案」合并 select → 依次选模型/选方案/切回 | **单 select 两组互斥**：panel 上组「模型」下组「方案」；选方案→trigger 显「方案 · <名>」；切回模型→方案解除；save 载荷互斥（UT 字段断言 + ET 目视 trigger 态） |
| ET-7（T6） | playground 设置 → 模型 tab → 默认模型/方案 select → 选方案保存（chat 应被清）→ 方案库删除该方案 → 回 select 看 | **严格互斥+回退链（22:22 拍板）**：选方案后 select 显方案且默认模型已清；删除方案 → select 回**未设置态 placeholder**（无休眠模型接管）；session 显式模型仍优先 |
| ET-8（T6） | 双侧同核：playground（ET-7）+ squad（ET-6）两处入口对照 | 两处消费方视觉/交互一致（同组件 ModelOrPlanPicker），i18n 中文分组标题「模型」/「方案」 |

## 5. 视觉保真清单

- 无设计稿、无新视觉基线 → 视觉保真门禁跳过。
- UI 相关确认：ET-1~5 截图留证（vision_check.py 判图，禁 Read 看图）；红绿灯呈现必须用**状态词**（正常/异常/观察中）+ emoji（🟢/🔴/🟡），**不展示熔断器词**（Closed/Open/HalfOpen，D16 权威映射）——ET-3 重点核。

## 6. 验证执行顺序

1. **UT**（coder 交付，全量 tsc -b + bun run test 全绿）→ code-review → 合并 T1/T2/T3
2. **AT 4 条**（api-test-executor：env_start → `CASES=mr_tc1,mr_tc2,mr_tc3,mr_tc4 bash tests/api/lib/run_all.sh` → env_shutdown；产出 states/v0.0.347/verify/api-test/）
3. **ET 4-5 条临时验证**（e2e-test-executor：等 AT 完成后串行，AT/ET 严禁并发；产出 states/v0.0.347/verify/e2e/）
4. doc-modifier 同步 specs（api/tech 与实现核对 + change_log）
5. 合并 → bump → 打包

## 7. 门禁标准

- UT 全绿（全量 tsc -b 0 error + bun run test 通过）
- AT ≥90%（本版 4 条；mr_tc4 真调 LLM 若 429 skip 不算 fail），无阻塞 issue
- ET 4-5 条临时验证 blocking = 0（pass 或 small）
- PRD §3 三条关键路径全路径覆盖（映射见 §1）

## 8. 测试层级结论表（避免重复覆盖）

| 路径/UC | UT | AT | ET |
|---|---|---|---|
| P-A 配置方案（CRUD/校验/时间控件） | ✅ validation 全规则 + 组件测试 | ✅ mr_tc1（CRUD+400+解除挂载） | ✅ ET-1/ET-4（UI 交互） |
| P-B 挂载方案（PATCH/合成/playground） | ✅ session-config 分支 2 + squad-service | ✅ mr_tc2（PATCH 三语义） | ✅ ET-2（挂载→发消息） |
| P-C 调用降级（401 链 + 三态呈现） | ✅ routing_loop + registry 全路径 | ✅ mr_tc4（401 降级 + open/half_open） | ✅ ET-3（红绿灯视觉） |
| 降级分支：429 快速/网络 1 次/时间过滤/去重/恢复 | ✅ UT 全分支 | ❌ 不入选（不可控/白盒，§3.1） | ❌ 不重复 |
| status 端点基态 + 错误码 | ✅ handler 单测 | ✅ mr_tc3（closed + 404/400） | ❌ 不重复 |
| 分支 1 零回归 | ✅ 既有 UT 全绿 | ❌ 无新端点 | ✅ ET-5（解除挂载回退） |
| 视觉/文案（状态词/emoji/i18n） | ✅ 组件测试（词映射） | ❌ 非 API 契约 | ✅ ET-3/ET-4 截图核 |
