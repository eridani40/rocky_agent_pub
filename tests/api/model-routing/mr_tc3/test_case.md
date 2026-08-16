# mr_tc3 — squad 挂载 modelRoutingPlanId：挂载/解除/校验 + status 端点基态

## 覆盖契约

| 端点 | spec | 验证点 |
|------|------|--------|
| `PATCH /squad/:id` modelRoutingPlanId | 21-model-routing.md §2.5 | 挂载合法方案 200 回显；planId 不存在 400；null 清空（无字段省略）；undefined 不写（改 name 不误清空） |
| `GET /squad/:id` | 11a-squad-endpoints.md §1.3 | 挂载/清空落盘一致 |
| `GET /model-routing/plans/:planId/status` | 21-model-routing.md §2.6 | closed 基态：circuitState=closed + presentation=normal + remainingSeconds absent；方案不存在 404 |

## 断言面

**挂载 PATCH 三语义（api §2.5 / change_plan）**
- PATCH `{modelRoutingPlanId: "zz-mr-tc3-plan"}` → `.modelRoutingPlanId == "zz-mr-tc3-plan"`（回显）+ GET 回读一致（落盘）
- PATCH `{modelRoutingPlanId: "01KZ...ZX"}`（不存在）→ 400 `.error ~= "plan not found"`
- PATCH `{modelRoutingPlanId: null}` → 200 `.modelRoutingPlanId absent`（清空省略）+ GET 回读无字段
- PATCH `{name: ...}`（不含 modelRoutingPlanId）→ `.modelRoutingPlanId` 仍为挂载值（undefined 不写，不误清空）

**status 端点基态（PRD UC-18 前件）**
- 无任何调用 → 全条目 `.circuitState == "closed"` + `.presentation == "normal"` + `.remainingSeconds absent`（D16 映射：closed→normal 无倒计时）
- 方案不存在 → 404

## 设计权衡

- **status 基态无真实调用**：熔断状态默认 Closed（内存态初始化）——确定性断言；open/half_open 动态呈现由 mr_tc4 覆盖（本 case 只断 closed 基态 + 错误码）
- **无效 planId 用硬编码 ULID**（`01KZZZZZZZZZZZZZZZZZZZZZZZX`，确定性，不依赖清理残留——skill 配方 4）
- **`.items[1] exists` 替代 `.size`**（eval_path 不支持 size；用索引存在性证明 ≥2 条目）
- **全确定性 HTTP 事务，零 LLM**

## 前置依赖

- v0.0.347 `squad.ts` schema modelRoutingPlanId（required:false）+ `squad.ts` handler（PATCH !== undefined 才写 / null 清空 / 校验 400）+ `model-routing-status.ts` 端点已实现
