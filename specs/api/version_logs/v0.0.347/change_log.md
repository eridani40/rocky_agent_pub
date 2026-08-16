# v0.0.347 — API Change Log（模型路由降级：方案 CRUD + 状态查询 + squad 挂载）

> 增量变更。全量权威：`specs/api/overall/21-model-routing.md`（新增）+ `specs/api/overall/11a-squad-endpoints.md` §1.4（PATCH 扩展）。
> 权威输入：`specs/prd/model-routing-PRD-2026-08-14.md` + `specs/tech/version_logs/v0.0.347/change_plan.md`。
> **后端边界（MANDATORY）**：既有端点仅 2 处扩展——`PATCH /squad/:id`（PatchSquadBody 加 `modelRoutingPlanId`）+ `DELETE /kv/config/:group` 白名单（仅 `model_routing_plans` 放行，其他 405）。其余（session/agent 等）零改。

## §1 变更端点

### 1.1 新增 `GET /model-routing/plans/:planId/status` — 方案熔断状态查询（v0.0.347）

**动机**：UI 红绿灯呈现方案各候选模型熔断状态。只读进程内存快照（`CircuitBreakerRegistry` 单例），不持久化。

**契约**：

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/model-routing/plans/:planId/status` | 方案熔断状态（只读内存快照） | `200` + 状态对象（circuitState + presentation + remainingSeconds） |

```typescript
interface CircuitStatusResponse {
  planId: string;
  items: Array<{
    providerId: string;
    modelId: string;
    circuitState: 'closed' | 'open' | 'half_open';   // 原始熔断态（内部）
    presentation: 'normal' | 'abnormal' | 'observing';  // D16 用户友好呈现（UI 消费此值）
    remainingSeconds?: number;   // open 时剩余秒数（abnormal 才有）
  }>;
}
```

**presentation 权威映射（D16，禁熔断词）**：`closed → normal`（🟢 正常，无倒计时）；`open → abnormal`（🔴 异常，带 remainingSeconds 倒计时）；`half_open → observing`（🟡 观察中，无倒计时）。

**错误**：`404 plan not found`（body.error）；未调用过 → 全 closed 基态。

### 1.2 扩展 `PATCH /squad/:id` — modelRoutingPlanId 挂载（v0.0.347）

`PatchSquadBody` 加 `modelRoutingPlanId?: string | null`（undefined=不修改 / null=解除挂载清空字段 / 非空须指向存在方案否则 400 `plan not found: <planId>`）；`SquadDetail` 回显 `modelRoutingPlanId?: string`（未挂载无字段省略）。详见 `11a-squad-endpoints.md §1.4`。

### 1.3 扩展 KV config DELETE — group 白名单（v0.0.347）

`DELETE /kv/config/:group` 仅 `model_routing_plans` 放行（调 deletePlan：扫描 squad/playground 解除挂载 → 删 record，返 detached 清单）；其他 group → `405`。详见 `21-model-routing.md §2.3`。

## §2 错误形状对齐

v0.0.347 新增端点错误统一 `{ error: "<message>" }`（对齐全仓 KV 错误统一形状；AT `mr_tc1` 断言 `.error`）。

## §3 T5 增量 — 熔断错误率滑动窗口（老板 2026-08-14 20:51 拍板）

- **§2.2 校验表 +2 行**（`21-model-routing.md`）：`circuit.windowSize` 非整数或越界 → 400 `invalid circuit: windowSize must be an integer in 1-1000`；生效 `minRequests > 生效 windowSize` → 400 `invalid circuit: minRequests(<生效值>) must be <= windowSize(<生效值>)`（生效值=显式值??默认 10/20）。
- **§2.6 status 快照**：`items[].errorRate` 改**滑动窗口口径**（最近生效 windowSize 次请求的失败率，样本 0 → 0；failureCount/totalRequests 保留终身口径）。commit `27634c93d`，review PASSED。

## §4 T6 增量 — squad PATCH 严格互斥 400（老板 2026-08-14 22:22 拍板）

- **§2.5**（`21-model-routing.md`）：`PATCH /squad/:id` 载荷同时含非空 `modelDefault` + 非空 `modelRoutingPlanId` → **400** `modelDefault and modelRoutingPlanId are mutually exclusive`（防 API 误用；任意时刻 squad 落库两字段至多一个有值）。前端写策略双向清：选模型带 `modelRoutingPlanId: null`，选方案显式清空 `modelDefault`/`modelDefaultProviderId`。后端唯一改动 `handlers/squad.ts` +8 行（resolve 链零改动）。commit `4488c49ba`，review PASSED + ET-6/7/8 全 PASS。
