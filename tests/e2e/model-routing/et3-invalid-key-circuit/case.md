# model-routing ET-3 — 无效 key 方案触发熔断 + 红绿灯呈现（v0.0.347 UI v2）

> v0.0.347 模型路由临时验证路径 ET-3（test-plan §4.2）。纯自然语言 + 定位提示；executor 读 case.md + app-guide 按 snapshot 文案/位置自选定位（action-key/testid > 可见文案 > aria-label）。
> 依据：test-plan `specs/tech/version_logs/v0.0.347/test-plan.md` §4.2 ET-3 + PRD §3 P-C + change_plan T2（routing_loop / circuit_breaker_registry）+「UI v2 改版」决策⑮/⑰ + D16 权威映射（状态词 + emoji，**禁展示熔断器词 Closed/Open/HalfOpen**）。
> **UI v2 关键变化**：方案库 = 两层结构（外层 plan-card 列表 → 点卡进详情）；熔断参数区**常显**（无展开开关）；红绿灯在**详情层**条目行显示（按 provider+model 匹配），**列表层无红绿灯**（决策⑰）。

## Use Case

作为 Rocky 用户，我挂载一个含**无效 API key** 模型的方案（坏模型 priority 1 + 正常 minimax 模型 priority 2），发消息触发 LLM 调用——坏模型 401 直接熔断（🔴 异常 + 倒计时）→ 自动降级正常模型成功返回；随后到方案**详情**看红绿灯：异常条目 🔴（异常，带倒计时）→ 观察期 🟡（观察中，无倒计时）→ 正常条目 🟢（正常）。**关键：红绿灯必须显示状态词（正常/异常/观察中）+ emoji，不能出现熔断器英文词（Closed/Open/HalfOpen）。**

## 前置条件

- env.sh 已起好环境（case_id 禁下划线；与 ET-1/ET-2 同一 env 可复用方案库）。
- 已建合法方案（如 `et1-plan`）或本 case 内新建；本 case 需**修改方案**使其含坏模型条目（如把 Kimi 条目换成无效 key 的 anthropic provider，或新建一个专用坏方案）。
- 无效 key 构造：在「应用设置 → 模型 tab」providers 区新增/修改一个 provider 填无效 key（如 anthropic `sk-invalid-xxx`，base_url 真实可达）；或直接改现有 provider 的 key 为无效（**注意：会破坏该 provider 后续正常调用——建议新增专用坏 provider 或做完恢复**）。
- LLM provider 可用（minimax 兜底降级目标；429 则按 skipped 口径汇报）。

## 操作目标（编号步骤）

1. **构造坏方案**（含坏模型 + 正常模型）：
   - 方案库（外层列表）点「+ 新建方案」（`plan-create`）→ 直接进详情 → 添加条目 1 = 坏 provider（无效 key）模型（priority 1，无条件，启用）；添加条目 2 = minimax 正常模型（priority 2，无条件，启用）。
   - **熔断参数加速（v2 常显）**：详情底部「熔断参数（高级）」区**始终可见**（`plan-editor-circuit`，无展开开关）→ 把「熔断时长（秒）」（`plan-editor-circuit-timeoutSeconds`，默认 60）改小（如 1-3 秒）加速后续观察（hint 显示「默认 60」）→ 保存（`plan-editor-save`，页面底部 sticky SaveBar）→ 回列表重命名（⋯ 菜单 → 重命名 → `et3-bad`）。
   - 注：若不想污染方案库，可编辑 ET-1 方案临时把某条目换成坏模型（ET 结束后改回或删除坏方案）。
2. **挂载坏方案 + 建 squad**（沿用 ET-2 流程）：Studio 建 squad → 管理 tab 挂载 `et3-bad` → 保存。
3. **发消息触发降级链**：进 leader 会话 → 发消息（如「hi」）→ 等待 LLM 调用完成。
   - 预期：**消息成功返回**（坏模型 401 熔断后降级 minimax 成功——不能是「所有候选模型不可用」错误）。
4. **详情层红绿灯异常态**：回「应用设置 → 模型 tab → 方案库」→ **点 `et3-bad` 卡片（`plan-card`）进详情** → 条目行红绿灯位（`data-testid=circuit-status`，按 provider+model 匹配，进详情时拉取一次）。
   - 预期：坏模型条目 **🔴 异常 + 倒计时**（`circuit-status` + `circuit-countdown` 显示剩余秒数，title「模型异常，N 秒后自动恢复」）；正常模型条目 **🟢 正常**（无倒计时）。
   - **文案核**：显示「异常」/「正常」状态词 + emoji，**无** Closed/Open/HalfOpen 熔断器词。
   - 注：**列表层卡片无红绿灯**（v2 决策⑰，勿报缺陷）；详情状态打开时拉一次不轮询——若需看新状态，退出详情重进刷新。
5. **观察中态（🟡）**：等倒计时结束（timeoutSeconds 秒后，默认 60 或已调小）→ **取消/← 回列表 → 重新点卡进详情**（重新拉取 status）→ 看红绿灯。
   - 预期：坏模型条目变 **🟡 观察中**（`circuit-status` 无 `circuit-countdown`，title「模型观察中（探测恢复）」）；**无倒计时**。
   - 注：观察中为 half_open 映射；若探测自动失败回异常也属预期（记录实际呈现即可——重点是 abnormal→observing 的**呈现映射**存在且状态词正确）。
6. **恢复态（🟢，尽力而为）**：若可行，把坏条目换回正常模型（或修复 key）后发消息成功 → 重新进详情红绿灯应回 🟢 正常（closed 映射）。
   - 注：探测恢复需连续 2 次成功（half_open 限流），ET 尽力而为；若无法确定性恢复，记录为 small 观察（不阻塞）——恢复路径由 AT mr_tc4/UT registry 覆盖。

## 验收口径（executor 自由心证）

- **pass**：坏方案挂载 → 发消息成功（降级链正常）→ **详情内**红绿灯 🔴 异常带倒计时 + 🟢 正常 → 倒计时后重进详情 🟡 观察中无倒计时；**全程状态词（正常/异常/观察中）+ emoji，无熔断器英文词**。
- **small**：主链路通但有瑕疵不阻塞——如恢复态（🟢）无法确定性触发（记录观察）、倒计时刷新偶发延迟、详情重进才刷新状态（已知不轮询）、文案 emoji 与 spec 有微差但语义正确。
- **blocking**：发消息报「所有候选模型不可用」（降级失败）/ 详情内红绿灯不渲染或状态词错误（出现 Closed/Open/HalfOpen）/ 异常无倒计时 / 观察中带倒计时 / 熔断参数区找不到（常显区缺失无法调 timeoutSeconds）。

## 留证要求（每步 4 件套）

- 目录：`states/v0.0.347/verify/e2e/et3-invalid-key-circuit/steps/NN-<action>/`（NN=01..06）。
- 每步：`screenshot.png` + `dom.html` + `snapshot.yml` + `meta.json`。
- 关键断言留证点：
  - 发消息成功：snapshot 消息气泡 agent 回复（非错误）。
  - 熔断参数常显：snapshot 详情含 `plan-editor-circuit`（无 toggle）+ timeoutSeconds 输入框。
  - 🔴 异常：**详情** snapshot/dom 含 `circuit-status` + 🔴 + `circuit-countdown`（数字秒）+ title「模型异常，N 秒后自动恢复」。
  - 🟡 观察中：详情 snapshot/dom 含 🟡 + title「模型观察中（探测恢复）」+ **无** `circuit-countdown`。
  - 🟢 正常：详情 snapshot/dom 含 🟢 + title「模型正常」。
  - **禁熔断词**：grep dom 确认无 `Closed`/`Open`/`HalfOpen`（大小写不敏感）。
- **视觉判定**：红绿灯 emoji/颜色呈现用 `tests/e2e/vision_check.py` 判图（注入 token）；**禁 MCP / 禁 Read 截图**。

## 依赖

- specs/api/overall/21-model-routing.md §2.6（status 端点：circuitState/presentation/remainingSeconds 映射表）
- specs/tech/[P0]model_routing.md §5/§6/§7（routing_loop / circuit_breaker / D16 状态词映射）
- specs/ui/components/app-dev-config-page/component-circuit-status.md（红绿灯契约：normal/abnormal/observing + emoji）
- specs/prd/model-routing-demo-v2.html + change_plan「UI v2 改版」决策⑮（熔断常显）/⑰（红绿灯详情层）
- specs/prd/model-routing-PRD-2026-08-14.md §3 P-C（401 直接熔断 + 降级链）
