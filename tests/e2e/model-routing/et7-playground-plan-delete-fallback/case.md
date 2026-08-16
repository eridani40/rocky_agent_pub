# model-routing ET-7 — playground 选方案清模型 + 删方案回退链（v0.0.347 T6）

> v0.0.347 模型路由临时验证路径 ET-7（test-plan §4.2 T6 增补）。纯自然语言 + 定位提示；executor 读 case.md + app-guide 按 snapshot 文案/位置自选定位（action-key/testid > 可见文案 > aria-label）。
> 依据：test-plan `specs/tech/version_logs/v0.0.347/test-plan.md` §4.2 ET-7 + change_plan T6 修正段（决策㉛ 严格互斥 + ㉜ 回退链重定义，commit 6dbb8ee50）。

## Use Case

作为 Rocky 用户，我在 playground 设置的模型 tab 用合并 select 选了一个方案保存（原默认模型 chat 被严格互斥清空），随后在方案库删除该方案——回看 select 应显示**未设置态 placeholder**（挂载被自动解挂、chat 已清，无休眠模型幽灵接管）；同时确认 session 显式选过的模型仍优先生效不受影响。

## 前置条件

- env.sh 已起好环境（case_id 禁下划线；与 ET-1~6 同一 env 可复用）。
- 方案库已有 ≥1 个**可牺牲**方案（专为本 case 建一个如 `et7-plan` 更干净；或复用不再需要的 `et1-plan`——删除不可逆，勿删别 case 仍依赖的方案）。
- 若需验证步骤 5：有一个 chat 会话已在会话内显式选过模型（chat 页 ModelPicker 选模型 = session 级配置）。
- LLM provider 可用（minimax 优先；429 则按 skipped 口径汇报；步骤 5 用）。

## 操作目标（编号步骤）

1. **进设置模型 tab（初态核）**：应用设置 → 模型 tab → 「默认模型」区 chat 行合并 select（`data-action-key=settings.default-models.select-chat`）。
   - 初始态：trigger 显已有默认模型（「provider / model」）或 placeholder「选择模型或方案」；留证当前态。
2. **选方案保存（chat 被清）**：打开 select → 点下组「方案」目标方案行（如 `et7-plan`）→ SaveBar 保存。
   - 预期：保存成功；trigger 显「方案 · <方案名>」；严格互斥——原 chat 默认模型已被清（default_models record 写 `{}`）。
   - 可顺带 API 佐证（若 executor 有 API 访问通道）：GET `/config/app?group=default_models&key=default` → value 为空对象/null；GET `/config/app?group=model_routing` → key=default 含 `playgroundPlanId`。无通道则纯 UI 目视即可。
3. **方案库删除该方案**：同 tab 滚到「方案库」区 → 目标方案卡 ⋯ 菜单 → 「删除」→ 确认弹层（提示已挂载的 squad/playground 将回退）→ 确认删除。
   - 预期：删除成功，方案卡从列表消失（deletePlan 自动解除所有挂载引用，含 playground mount）。
4. **回看 select 回退态（核心断言）**：重新进入设置页（或刷新——挂载态在进入设置时读取）→ 模型 tab → chat 行 select。
   - 预期：trigger 显 **placeholder「选择模型或方案」**（未设置态：挂载已解 + chat 已清，**无休眠模型接管**——回退到显式未设置引导，22:22 拍板回退链语义；对应后端 ModelNotConfiguredError 400 引导配置）。
5. **session 显式模型仍优先（可选）**：进一个**会话内显式选过模型**的 chat 会话 → 发一条简单消息（如「hi」）。
   - 预期：agent 正常回复（session 显式模型优先级高于 playground 默认，不受方案删除/默认清空影响）；无「所有候选模型不可用」类错误。
   - 注：无现成显式模型会话时可在 chat 页 ModelPicker 选一个模型再发；时间紧可跳过（resolve 优先级链已有 UT 覆盖，此处为 UI 侧佐证）。

## 验收口径（executor 自由心证）

- **pass**：选方案保存后 trigger 显「方案 · <名>」（chat 已清）；删除方案后重进设置 select 显 placeholder 未设置态（无幽灵模型接管）；可选步骤 5 正常回复。
- **small**：主链路通但有瑕疵不阻塞——如删除后需手动刷新才见 placeholder（记录说明）、API 佐证通道不可用仅做 UI 目视、步骤 5 未做（记录说明）。
- **blocking**：选方案保存失败或 chat 未被清（trigger 显方案但 API 显 default_models 仍有值）/ 删除方案失败 / 重进后 select 仍显方案名（挂载未解）或显旧模型名（幽灵接管，回退链断裂）/ 步骤 5 报模型错误。

## 留证要求（每步 4 件套）

- 目录：`states/v0.0.347/verify/e2e/et7-playground-plan-delete-fallback/steps/NN-<action>/`（NN=01..05）。
- 每步：`screenshot.png` + `dom.html` + `snapshot.yml` + `meta.json`。
- 关键断言留证点：
  - 初态：snapshot select trigger 当前态（模型名或 placeholder）。
  - 选方案后：snapshot trigger 显「方案 · <方案名>」。
  - 删除确认：snapshot 删除确认弹层（含回退提示文案）。
  - 回退态（核心）：snapshot trigger 显 placeholder「选择模型或方案」。
  - 可选 session 优先：snapshot 消息气泡 agent 回复（非错误文案）。
- **视觉判定**：用 `tests/e2e/vision_check.py`（注入 token）；**禁 MCP / 禁 Read 截图**。

## 依赖

- specs/ui/components/app-dev-config-page/section-default-models-and-request.md（chat 行合并 select + mountDraft 联动）
- specs/ui/components/common/component-model-or-plan-picker.md（组件契约：placeholder/方案徽章）
- specs/api/overall/21-model-routing.md §2.3（DELETE 方案 = 解除挂载 + detached 清单）
- specs/tech/version_logs/v0.0.347/change_plan.md T6 修正段（决策㉜ UC-3 回退链重定义）
