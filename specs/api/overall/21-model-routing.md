# Model Routing API（模型组合方案库 + 挂载 + 状态查询）

> version: 1.1.0 · 引入版本 v0.0.347 · 2026-08-14（1.1.0 `[v0.0.349 modified]`：新增 §2.7 dangling 语义——挂载方案 provider/model 失效的 runtime 跳过 + 全 dangling 400 + 编辑拦保存（既有校验语义确认）；详见 `specs/api/version_logs/v0.0.349/change_log.md`）
> PRD：`specs/prd/model-routing-PRD-2026-08-14.md`（§2.1-2.8 + §3 关键路径）· tech：`specs/tech/agent/providers_and_models/[P0]model_routing.md`
> 范围：方案库 CRUD + 挂载配置 + 熔断状态查询。**复用既有 `/config/app` 通用 KV 端点 + `/squad` PATCH**，仅状态查询为新增端点。

## 1. 端点总览

| # | 方法 | 路径 | 用途 | 章节 |
|---|---|---|---|---|
| 1 | GET | `/config/app?group=model_routing_plans` | 方案库列表（整组） | §2.1 |
| 2 | PUT | `/config/app` `{group:'model_routing_plans', key, data}` | 新建/编辑方案（含校验） | §2.2 |
| 3 | DELETE | `/config/app?group=model_routing_plans&key=<planId>` | 删除方案（解除挂载） | §2.3 |
| 4 | PUT | `/config/app` `{group:'model_routing', key:'default', data}` | playground 挂载/解除方案 | §2.4 |
| 5 | PATCH | `/squad/:id` `{modelRoutingPlanId?}` | squad 挂载/解除方案 | §2.5 |
| 6 | GET | `/config/app?group=model_routing&key=default` | 读 playground 挂载 | §2.4 |
| 7 | GET | `/model-routing/plans/:planId/status` | 方案内各模型熔断状态（红绿灯） | §2.6 |

## 2. 端点契约

### 2.1 `GET /config/app?group=model_routing_plans` — 方案库列表

走既有通用 KV 整组 GET（`kv-config-handlers.ts`）。

**请求**：`GET /config/app?group=model_routing_plans`
**响应 200**：

```json
{ "items": [
  { "key": "<planId>", "data": {
      "id": "<planId>", "name": "主力+兜底",
      "items": [
        { "providerId": "01KVC9A2...", "modelId": "kimi-k2", "priority": 1,
          "timeCondition": { "hours": [2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23] },
          "enabled": true },
        { "providerId": "01KVC9B5...", "modelId": "glm-4.6", "priority": 2, "enabled": true }
      ],
      "circuit": { "failureThreshold": 4, "successThreshold": 2, "timeoutSeconds": 60,
                   "errorRateThreshold": 0.6, "minRequests": 10 },
      "createdAt": 1755200000000
  } }
] }
```

**错误**：`400 missing group query`（无 group）；`404` group 不存在（整组 GET 无此错，缺失 = `items: []`）。

### 2.2 `PUT /config/app` — 新建/编辑方案（含校验）

走既有通用 KV PUT 单 key（`kv-config-handlers.ts`），**新增 `model_routing_plans` 组校验钩子**。

**请求**：`PUT /config/app`
```json
{ "group": "model_routing_plans", "key": "<planId>",
  "data": { "id": "<planId>", "name": "主力+兜底",
    "items": [ { "providerId": "...", "modelId": "kimi-k2", "priority": 1,
                 "timeCondition": { "hours": [2,3] }, "enabled": true } ],
    "circuit": { "failureThreshold": 4, "successThreshold": 2, "timeoutSeconds": 60,
                 "errorRateThreshold": 0.6, "minRequests": 10 },
    "createdAt": 1755200000000 } }
```

**响应 200**：`{ "ok": true }`

**校验（服务端硬拒绝，400 + 明确提示）**：
> 错误形状：`{ "error": "<message>" }`（对齐全仓 KV 错误统一形状；AT `mr_tc1` 断言 `.error`）。
| 错误 | HTTP | body.error |
|---|---|---|
| name 空 / items 空 / items 非数组 | 400 | `invalid model routing plan: name/items required` |
| providerId+modelId 非已启用 provider 的合法 enabled model | 400 | `model routing plan item: model not found or disabled: <providerId>/<modelId>` |
| 同模型 2 带时间条目 | 400 | `same model cannot have 2 time-condition items: <providerId>/<modelId>` |
| 同模型 2 不带时间条目 | 400 | `same model cannot have 2 unconditional items: <providerId>/<modelId>` |
| 同模型带时间条目排在无条件条目下面 | 400 | `time-condition item must be above unconditional item: <providerId>/<modelId>` |
| priority 非正整数 / 重复 | 400 | `invalid priority: must be positive unique integers` |
| enabled 缺失（旧 client） | 400 | `invalid item: enabled required`（兼容层：缺省 true） |
| circuit.windowSize 非整数或越界 [v0.0.347 T5] | 400 | `invalid circuit: windowSize must be an integer in 1-1000` |
| 生效 minRequests > 生效 windowSize [v0.0.347 T5] | 400 | `invalid circuit: minRequests(<生效值>) must be <= windowSize(<生效值>)`（生效值=显式值??默认 10/20；窗口永不满=错误率轨道永久沉默，病态配置硬拒） |

> **校验时机**：PUT 时服务端静态校验（新建/编辑都校验，编辑 = 全量覆盖同校验）。校验函数放 `services/model-routing-validation.ts`（纯函数，可单测）。

### 2.3 `DELETE /config/app?group=model_routing_plans&key=<planId>` — 删除方案

**新增 DELETE 支持**（`kv-config-handlers.ts` 增 DELETE 分支 + group 白名单——仅 `model_routing_plans` 允许；其他 group DELETE → 405）。

**请求**：`DELETE /config/app?group=model_routing_plans&key=<planId>`
**响应 200**：`{ "ok": true, "detached": ["squad:01K...", "playground"] }`（detached = 解除的挂载方清单，可为空数组）
**错误**：`404 plan not found`；`400` group 非白名单（其他 group 405）。

**删除语义**（PRD UC-3）：删除方案 = ① 扫描所有 squad `modelRoutingPlanId === planId` → 清空字段；② `model_routing.default.playgroundPlanId === planId` → 清空；③ 删除 record。挂载方回退默认模型（分支 1 天然生效）。

### 2.4 `PUT /config/app` group=model_routing — playground 挂载/解除

单实例（key 固定 `default`），走既有通用 KV。

**挂载**：
```json
{ "group": "model_routing", "key": "default", "data": { "playgroundPlanId": "<planId>" } }
```
**解除**：`data: {}`（空对象 = 未挂载）或删除 key。

**校验**：`playgroundPlanId` 非空时须指向存在的方案（`model_routing_plans` 有对应 key），否则 400 `plan not found: <planId>`。

### 2.5 `PATCH /squad/:id` — squad 挂载/解除方案

对齐既有 `PatchSquadBody`（`11a-squad-endpoints.md §1.4`）新增可选字段：

```json
{ "modelRoutingPlanId": "<planId>" }        // 挂载
{ "modelRoutingPlanId": null }              // 解除（写 undefined/清空）
```

- **schema**：`squad.modelRoutingPlanId?: string`（`required:false`）；PATCH `!== undefined` 才写（显式 null = 清空字段）；
- **校验**：非空时须指向存在的方案，否则 400 `plan not found: <planId>`；
- **响应**：200 + SquadDetail（回显 `modelRoutingPlanId`，无字段省略——对齐「无 null 输出」）；
- `modelDefault` 与 `modelRoutingPlanId` **严格互斥**（T6 修正，老板 2026-08-14 22:22 拍板「必须只保留一个有效的」）：PATCH 载荷同时含非空 `modelDefault` + 非空 `modelRoutingPlanId` → **400** `modelDefault and modelRoutingPlanId are mutually exclusive`；任意时刻 squad 落库两字段至多一个有值。前端写策略：选模型带 `modelRoutingPlanId: null`；选方案带 `modelDefault`/`modelDefaultProviderId` 显式清空。存量双设**不迁移**（resolve 方案优先兼容、UI 方案优先呈现、用户触碰即收敛；deletePlan 解挂兜底）。

### 2.6 `GET /model-routing/plans/:planId/status` — 方案内模型熔断状态（红绿灯）

**新增端点**（`handlers/model-routing-status.ts`）。

**请求**：`GET /model-routing/plans/:planId/status`
**响应 200**：

```json
{ "planId": "<planId>",
  "items": [
    { "providerId": "01KVC9A2...", "modelId": "kimi-k2",
      "circuitState": "open",          // closed | open | half_open
      "presentation": "abnormal",      // normal | abnormal | observing（UI 直接消费）
      "remainingSeconds": 23,          // 仅 open 有（倒计时）；closed/half_open 省略
      "failureCount": 6, "totalRequests": 20, "errorRate": 0.5 }
      // [v0.0.347增量] errorRate = 滑动窗口口径（最近生效 windowSize 次请求的失败率，样本 0 → 0）；
      //   failureCount/totalRequests = 终身累计口径（呈现历史总量）——两口径并存，字段名/类型不变
  ] }
```

**映射（D16 权威）**：

| circuitState | presentation | remainingSeconds |
|---|---|---|
| closed | `normal`（🟢 正常） | 省略 |
| open | `abnormal`（🔴 异常） | 有（Open 剩余秒） |
| half_open | `observing`（🟡 观察中） | 省略 |

**错误**：`404 plan not found`；`400` planId 缺失。
**语义**：只读内存态快照（不持久化）；items = 方案内全部条目按 priority 去重（同模型多 item 只出一条，取当前熔断状态）；方案不存在 → 404。
**UI 消费**：设置 → 模型 tab → 方案编辑页/方案列表行内红绿灯（轮询或编辑时拉取）。

### 2.7 dangling 语义（方案内 provider/model 失效）[v0.0.349]

provider 删除（`DELETE /provider/:id`，02-llm-chat §5.2）或其 model 删除/禁用后，引用它的方案条目成为 dangling item，双语义（老板 2026-08-14 22:00 拍板）：

1. **runtime 拿不到就跳过（容错）**：路由循环构建 target 时 provider/model 拿不到即跳过该候选（既有防御）；**挂载方案全部候选 dangling** → chat/run 入口降级 `MODEL_NOT_CONFIGURED` 400（message 区分「方案内所有模型不可用」，与分支 1 跑空同构、同时机），MUST NOT 静默回退默认模型（D11）。
2. **重新编辑有失效 item 拦保存（严格）**：PUT（§2.2）校验每条目指向 enabled provider 的 enabled model——dangling 条目命中既有 400 `model routing plan item: model not found or disabled: <pid>/<mid>`（347 已有，语义确认）；前端本地预检同步显示失效（红描边 + 预检提示），强制用户先清理失效条目。

**非目标**：删除 provider 时不做方案引用实时扫描端点（引用警示为 UI 层通用文案）；dangling 条目不自动清理（用户触碰即收敛）。

## 3. 数据形状（data schema，与 tech §2.1 一致）

```typescript
interface ModelRoutingPlan {
  id: string;
  name: string;
  items: RoutingItem[];
  circuit?: CircuitConfig;
  createdAt: number;
}
interface RoutingItem {
  providerId: string;
  modelId: string;
  priority: number;
  timeCondition?: { hours: number[]; timezone?: string };  // 0-23 白名单；timezone = 合法 IANA 字符串（缺省 Asia/Shanghai，向后兼容；非法 400）；缺省 timeCondition = 随时可用
  enabled: boolean;                      // 默认 true
}
interface CircuitConfig {
  failureThreshold?: number;   // 默认 4
  successThreshold?: number;   // 默认 2
  timeoutSeconds?: number;     // 默认 60
  errorRateThreshold?: number; // 窗口错误率阈值，默认 0.6
  minRequests?: number;        // 窗口内最小有效样本数，默认 10
  windowSize?: number;         // 错误率滑动窗口大小（最近 N 次请求），默认 20；校验：整数 ∈[1,1000] 且生效 minRequests ≤ windowSize
}
```

## 4. 错误码汇总

| code | HTTP | 场景 |
|---|---|---|
| (message-based `body.error`) | 400 | 方案校验失败（见 §2.2 表，含 [v0.0.347 T5] windowSize 两条） |
| (message-based `body.error`) | 404 | plan not found（DELETE/状态查询/挂载校验） |
| (message-based `body.error`) | 400 | [v0.0.347 T6] PATCH /squad 双非空互斥：`modelDefault and modelRoutingPlanId are mutually exclusive`（§2.5） |
| 405 | 405 | DELETE 非白名单 group |
| MODEL_NOT_CONFIGURED | 400 | 无方案分支 1 既有错误（零改动） |
| NO_AVAILABLE_MODEL | 500 | 分支 2 候选为空/全失败（「当前无可用模型」/「所有候选模型不可用」，见 tech §5 ⑥） |

## 5. 非目标（对齐 PRD §5）

- ❌ session 级配方案（session 端点零改动）；
- ❌ 熔断状态持久化/写端点（status 只读）；
- ❌ quota/成本/延迟路由相关字段。

> 变更历史见 `specs/api/version_logs/v0.0.347/change_log.md`。
