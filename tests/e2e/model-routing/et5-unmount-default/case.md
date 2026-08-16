# model-routing ET-5 — 解除挂载 → 回退默认模型（v0.0.347）

> v0.0.347 模型路由临时验证路径 ET-5（test-plan §4.2）。纯自然语言 + 定位提示；executor 读 case.md + app-guide 按 snapshot 文案/位置自选定位（action-key/testid > 可见文案 > aria-label）。
> 依据：test-plan `specs/tech/version_logs/v0.0.347/test-plan.md` §4.2 ET-5 + PRD §3 P-B3（解除挂载 null 清空）+ §4 验收 9（分支 1 零回归）。

## Use Case

作为 Rocky 用户，我把已挂载方案的 squad 切回模型（T6 合并 select 选模型行 = PATCH planId:null + 写 modelDefault，严格互斥解除挂载），然后发消息——消息应**回退走默认模型**（分支 1 零回归：无挂载时行为与 v0.0.346 及以前完全一致），正常响应无报错。

## 前置条件

- env.sh 已起好环境（case_id 禁下划线；与 ET-2 同一 env 或复用已挂载方案的 squad）。
- 已有一个**挂载了方案**的 squad（ET-2 已挂载过；若 ET-2 未跑先按 ET-2 步骤 1-2 挂载）。
- LLM provider 可用（minimax 优先；429 则按 skipped 口径汇报）。

## 操作目标（编号步骤）

1. **确认已挂载**：进 squad 首页 → 「管理」tab → 「默认模型」行合并 select（`studio.squad.select-default-model`）trigger 显「方案 · <方案名>」（已挂载态）。
2. **解除挂载（切回模型）**：打开合并 select → 选上组「模型」某行（如 minimax / MiniMax-M3）→ 面板级 SaveBar 保存。
   - 预期：保存成功；select 回显「provider / model」模型名（PATCH 载荷 planId:null + modelDefault 写入——严格互斥，无方案前缀）。
   - 可顺带 API 佐证：GET /squad/:id 无 modelRoutingPlanId 字段 + modelDefault=所选模型（若 executor 有 API 访问通道；无则纯 UI 回显即可）。
3. **发消息回退默认模型**：进 leader 会话 → 发消息（如「hi」）。
   - 预期：leader agent **正常回复**（走默认模型，非方案链；无「所有候选模型不可用」类错误，无模型路由报错）。
   - 观察：消息响应正常生成，与未挂载过的普通 squad 行为一致（分支 1 零回归 UI 确认）。
4. **（可选）再挂载验证可恢复**：回管理 tab 打开合并 select 重选方案 → 保存 → trigger 回显「方案 · <方案名>」（挂载/解除往返正常，无残留状态；modelDefault 被显式清空）。
   - 注：可选步骤，若时间紧可跳过；核心是解除后回退默认。

## 验收口径（executor 自由心证）

- **pass**：切回模型保存 → select 回显模型名（无方案前缀）→ 发消息正常回复（走默认模型无报错）；可选：重挂载往返正常。
- **small**：主链路通但有瑕疵不阻塞——如切换保存后回显延迟、可选重挂载步骤未做（记录说明）、消息回复慢但成功。
- **blocking**：切回模型保存失败或回显仍显示方案 / 解除后发消息报模型错误（分支 1 回归）/ 重挂载失败。

## 留证要求（每步 4 件套）

- 目录：`states/v0.0.347/verify/e2e/et5-unmount-default/steps/NN-<action>/`（NN=01..04）。
- 每步：`screenshot.png` + `dom.html` + `snapshot.yml` + `meta.json`。
- 关键断言留证点：
  - 解除前：snapshot select trigger 显「方案 · <方案名>」。
  - 解除后：snapshot select trigger 显「provider / model」模型名（无方案前缀）。
  - 发消息成功：snapshot 消息气泡 agent 回复（非错误文案）。
  - 可选重挂载：snapshot select trigger 回显「方案 · <方案名>」。
- **视觉判定**：用 `tests/e2e/vision_check.py`（注入 token）；**禁 MCP / 禁 Read 截图**。

## 依赖

- specs/ui/overall/06-studio.md §3.2（管理 tab 控件 + 严格互斥载荷）+ specs/ui/components/common/component-model-or-plan-picker.md（合并 select 组件契约）
- specs/api/overall/21-model-routing.md §2.5（PATCH null 清空 / undefined 不写）
- specs/prd/model-routing-PRD-2026-08-14.md §3 P-B3 + §4 验收 9（分支 1 零回归）
