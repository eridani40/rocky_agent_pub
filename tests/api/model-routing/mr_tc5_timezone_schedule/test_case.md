# mr_tc5_timezone_schedule — timezone 校验 + enabled:false 跳过次候选 + trace 真实 provider/model（黑盒）

> v0.0.353 新增持久 AT case（test-plan §AT：老板拍板 bug 修复回归 + 新 LLM 不确定性场景，模块归位 tests/api/model-routing/ 与 mr_tc1-4 同域）。

## 覆盖契约

| 端点 | spec | 验证点 |
|------|------|--------|
| `PUT /config/app` | 21 §2.2（TimeCondition.timezone 校验） | P-A1 旧形状（无 timezone）200；P-A2 非法 IANA 400 + `.error ~= "timezone"` |
| `POST /squad` + `PATCH /squad/:id` | 21 §2.5 | 建档 + 挂载方案（挂载 PATCH 带 `modelDefault: ""` 显式清空——T6 canonical 写策略，sentinel=空串非 null） |
| leader run | 04 §3 | enabled:false 跳过主候选 → run 落次候选正常完成（`.state == "idle"`） |
| `GET /model-routing/plans/:id/status` | 21 §2.6 | **黑盒主断言**：minimax 条目 `totalRequests == 0`（enabled:false 不入候选）+ deepseek 条目 `>= 1` |
| Langfuse oracle | change_plan D4/D8/D9 | physical gen `.model == deepseek-v4-pro` + `.metadata.providerId`；logical gen `.metadata.routingPlan.{planId,planName}`；skip gen `.metadata.{skipped,reason}`（9dd309c90 形状） |

## 断言面（P-A1/A2/B/C）

- **P-A1 旧形状兼容**：timeCondition 不带 timezone → 200（缺省 Asia/Shanghai，禁 UTC 突变——R1 回归）
- **P-A2 非法 timezone**：`"Not/AZone"` → 400 + error 含 timezone（T1 validation）
- **P-B enabled:false 跳过触发次候选**：主候选 minimax `enabled: false`（routingAttemptLoop ②检查跳过，不入候选不消耗尝试）→ minimax 0 请求 + deepseek ≥1 请求。**BUG 复盘重构**（BUG-mr-tc5-empty-hours-reversal）：原「hours 空数组恒不匹配」假设错——产品语义 `hours=[]` = 全天等价无条件（`length>0` 守卫短路 `includes`，spec/validation/UT/UI 四层一致的有意设计），空数组构造致断言反转；时间过滤语义已由 UT 64 例闭环，AT 层放弃可接受（leader 裁决路 A）
- **P-C oracle**（增强证据，缺凭证 skip）：三层语义——①physical generation model + metadata.providerId 真实记录（D4「调用谁记录谁」）②logical generation metadata.routingPlan 记生效路由方案 planId+planName（D8 逻辑层=调用意图，1 意图 1 条）③被跳过候选成对 gen `llm-{N}-skip-{M}`：metadata.skipped=true + reason=disabled（MiniMax enabled:false 那条）+ input.skippedCandidate.modelId（D9 逐条可见，老板 13:50 语义模型）

## 设计要点

1. **enabled:false 确定性构造**（BUG 复盘后）：跳过语义「不入候选不消耗尝试」黑盒可断（totalRequests==0）；**不可用 hours=[] 构造「恒不匹配」**——空数组=全天无条件（length>0 守卫，isItemTimeConditioned 同口径），带时间窗的确定性触发在 AT 层无原语支持，归 UT；GET status items=方案内全部条目按 priority 去重（enabled:false 条目仍呈现，索引断言有效）
2. **黑盒主断言不依赖 Langfuse**：GET status totalRequests 双向断言（0 vs ≥1）为主证据；oracle 为增强层——skip 时 case 仍闭环（trace 记录面由 UT langfuse-adapter.test 承载）
3. **POST modelDefault 必填但挂载时必清空**：POST /squad modelDefault 缺 → 400（11a §1.1）；但残留 MiniMax 会合成 enabled:true 显式 p0 条目绕过 enabled:false（BUG 复盘链路）→ 挂载 PATCH 同载荷带 `modelDefault: ""` + planId（T6「选方案带 modelDefault 显式清空」canonical 写策略）+ 断言 `.modelDefault == ""`；**清空 sentinel 区分**：modelDefault=空串（UI 实证 component-manage-tab.tsx:110-112）/ modelRoutingPlanId=null（mr_tc3 先例），错套 null 触发产品 6 字段 null 穿透 500（BUG-mr-tc5-step04，产品侧缺口另行立项）；save 语义指向步末响应，建 squad 与挂载拆两步
4. **providerId 硬编码 = data.id**：minimax 01KVJMPG2EZ1078MCT9JH4J5HG / deepseek 01KW6CPB0BRHQXH2B9P8QR82MG（非池文件名外层 id，团队记忆坑）
5. **teardown**：解散 squad + 删方案；池 provider 不删（不污染共享池）

## 前置依赖

- v0.0.353 T1（timezone 校验 + getHourInTimezone + D3 继承）/ T2（recordAttemptTarget + physical 真实 target）已实施
- test 环境 minimax + deepseek provider 真实可用（全局池 symlink，data.id 口径）

## 执行

`CASES=mr_tc5_timezone_schedule bash tests/api/lib/run_all.sh`（executor 职责；AT/ET 严禁并发，随后 mr_tc1-4 回归）
