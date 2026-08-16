# mr_tc1 — 方案库 CRUD + 同模型约束 400 + DELETE 解除挂载

## 覆盖契约

| 端点 | spec | 验证点 |
|------|------|--------|
| `PUT /config/app` (group=model_routing_plans) | 21-model-routing.md §2.2 | 新建/编辑方案：合法通过 200 `.ok==true`；同模型约束违规 400（2 带时间/带时间在下/2 不带时间），不落盘 |
| `GET /config/app?group=model_routing_plans` | 21-model-routing.md §2.1 | 整组回读落库（key=data 形状）；违规方案 absent |
| `DELETE /config/app?group=model_routing_plans&key=` | 21-model-routing.md §2.3 | 删除方案解除 squad + playground 挂载（detached 清单）；挂载方回退默认（字段清空）；不存在 404；非白名单 group 405 |
| `PATCH /squad/:id` modelRoutingPlanId | 21-model-routing.md §2.5 | 挂载回显 |
| `PUT /config/app` (group=model_routing) | 21-model-routing.md §2.4 | playground 挂载 |

## 断言面

**方案 CRUD（PRD UC-1~4 黑盒）**
- PUT 合法 2 条目（minimax p1 + volcengine p2）→ `.ok == true`
- GET 整组 → `.items[] any .key == "zz-mr-tc1-plan"` + 条目模型/优先级落库
- 编辑 = PUT 全量覆盖（同模型 1 带时间在上 + 1 无条件 + 第二模型）→ `.ok == true`

**同模型约束 400（PRD UC-21/22/23）**
- 2 带时间 → `.error ~= "time-condition items"`
- 带时间在下 → `.error ~= "must be above"`
- 2 不带时间 → `.error ~= "unconditional items"`
- 违规不落盘：GET 整组 `.items[] all .key != badN`

**DELETE 解除挂载（PRD UC-3 / change_plan 风险 7）**
- 先 PATCH squad 挂载 + PUT playground 挂载
- DELETE → `.detached[] any ~= "squad:"` + `.detached[] any == "playground"`
- squad 回读 `.modelRoutingPlanId absent`（回退默认）
- playground 回读 `.value.playgroundPlanId absent`（兼容 value:{} 与 404 两种实现，status [200,404]）
- DELETE 不存在 → 404；DELETE providers group → 405

## 设计权衡

- **provider/model 用 test.env 提交的非机密 id**（minimax/volcengine 硬编码，先例 si1 case）——方案校验要求 providerId+modelId 指向已启用 provider 的合法 enabled model
- **plan_id 用 `zz-` 前缀固定名**（唯一化防误匹配；teardown 显式清理，不依赖框架残留）
- **400 响应键名用 `.error`**（kv-config-handlers 实际实现 `{ error: err.message }`；api spec §2.2 表格写 message——按 W14 以代码实际为准，doc-sync 待办已记）
- **全确定性 HTTP 事务，零 LLM**（timeout 60 足够）
- **teardown 解散 squad**（级联清理 sessions/members）

## 前置依赖

- v0.0.347 `model-routing-validation.ts`（同模型约束全规则）+ `model-routing-store.ts`（deletePlan 解除引用）+ `kv-config-handlers.ts` DELETE 白名单 + `squad.ts` modelRoutingPlanId 字段已实现
