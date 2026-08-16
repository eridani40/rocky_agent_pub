# model-routing ET-2 — squad 挂载方案 + 发消息走降级链（v0.0.347）

> v0.0.347 模型路由临时验证路径 ET-2（test-plan §4.2）。纯自然语言 + 定位提示；executor 读 case.md + app-guide 按 snapshot 文案/位置自选定位（action-key/testid > 可见文案 > aria-label）。
> 依据：test-plan `specs/tech/version_logs/v0.0.347/test-plan.md` §4.2 ET-2 + PRD §3 P-B + change_plan T3（component-manage-tab 挂载下拉）。

## Use Case

作为 Rocky 用户，我创建一个 squad，在「管理」tab 把模型组合方案挂载到该 squad，然后进入 leader 会话发消息——消息应走方案链（正常模型成功返回，无需手动指定模型），证明挂载生效且降级链不破坏正常调用；同时验证合并 select 方案组出现方案、切回模型（解除挂载）正常。

## 前置条件

- 沿用 ET-1 已建方案（如 `et1-plan`，含 Kimi 带时间 02-23 + GLM 无条件）；若 ET-1 未跑，先按 ET-1 步骤 1-5 建一个合法 2 条目方案。
- env.sh 已起好环境（与 ET-1 同一 env 或新 env，case_id 禁下划线）。
- LLM provider 可用（minimax 优先；429 则按 skipped 口径汇报）。

## 操作目标（编号步骤）

1. **建 squad**：nav-rail「Studio」→ 左 sidebar「+ 新建」→ wizard 建队（name + leader 名必填；modelDefault 选 minimax/MiniMax-M3）→ 落 squad 首页。
2. **管理 tab 挂载方案（T6 合并 select）**：squad 首页切「管理」tab（ManageTab）→「默认模型」行的合并 select（`data-action-key=studio.squad.select-default-model`，trigger 显「provider / model」模型名或 placeholder「选择模型或方案」）。
   - 打开 select：上组「模型」+ 下组「方案」两组恒显；下组方案行含 ET-1 建的方案（按名称）。
   - 选方案（如 `et1-plan` 方案名行）→ 面板级 SaveBar 保存。
   - 预期：保存成功；select 回显「方案 · <方案名>」（挂载已落盘；严格互斥——modelDefault 已被显式清空）。
3. **发消息走方案链（正常响应）**：进 leader 会话（坐席卡「进入对话」或首页点击 leader 行）→ 输入框发一条简单消息（如「hi」）。
   - 预期：leader agent 正常回复（LLM 调用成功——方案链 Kimi（当前小时命中）或降级 GLM 任一成功即算正常响应）。
   - 观察：无报错（「所有候选模型不可用」类错误 = 失败）；可顺带看消息响应正常生成。
4. **切回模型验证（严格互斥，为 ET-5 留前置）**：回「管理」tab → 打开合并 select → 选上组某模型行（如 minimax）→ SaveBar 保存。
   - 预期：保存成功；select 回显「provider / model」模型名（方案名消失——严格互斥：选模型已 PATCH planId:null 解除挂载）。
   - 注：T6 合并 select 无「未挂载」空选项——解除挂载 = 切选模型（22:22 拍板严格互斥语义）。此步与 ET-5 重叠，若 ET-5 单独验证可跳过本步。

## 验收口径（executor 自由心证）

- **pass**：合并 select 下组「方案」出现方案、选方案保存回显「方案 · <名>」、leader 会话发消息正常回复（降级链不破坏正常调用）、切回模型后回显模型名（planId 清空）。
- **small**：主链路通但有瑕疵不阻塞——如方案名显示截断、保存后回显延迟、消息回复慢但成功。
- **blocking**：合并 select 不存在或无方案组 / 选方案保存失败或回显不一致 / 发消息报「所有候选模型不可用」或 LLM 错误（非 429）/ 切回模型保存失败。

## 留证要求（每步 4 件套）

- 目录：`states/v0.0.347/verify/e2e/et2-squad-mount-send/steps/NN-<action>/`（NN=01..04）。
- 每步：`screenshot.png` + `dom.html` + `snapshot.yml` + `meta.json`。
- 关键断言留证点：
  - select 方案组含方案：snapshot select 面板下组含方案名行。
  - 挂载保存回显：snapshot select trigger 显「方案 · <方案名>」。
  - 发消息成功：snapshot 消息气泡出现 agent 回复（非错误文案）。
  - 切回模型回显：snapshot select trigger 显「provider / model」（无方案前缀）。
- **视觉判定**：用 `tests/e2e/vision_check.py`（注入 token）；**禁 MCP / 禁 Read 截图**。

## 依赖

- specs/ui/overall/00-app-guide.md §3.2（Studio 建队 + 管理 tab 路径）
- specs/ui/components/common/component-model-or-plan-picker.md（合并 select 组件契约）+ specs/ui/overall/06-studio.md §3.2（管理 tab 控件）
- specs/api/overall/21-model-routing.md §2.5（squad PATCH 挂载三语义）
- specs/prd/model-routing-PRD-2026-08-14.md §3 P-B（挂载 → 发消息走方案链）
