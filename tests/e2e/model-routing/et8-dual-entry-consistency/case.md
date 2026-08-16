# model-routing ET-8 — squad / playground 双侧合并 select 一致性（v0.0.347 T6）

> v0.0.347 模型路由临时验证路径 ET-8（test-plan §4.2 T6 增补）。纯自然语言 + 定位提示；executor 读 case.md + app-guide 按 snapshot 文案/位置自选定位（action-key/testid > 可见文案 > aria-label）。
> 依据：test-plan `specs/tech/version_logs/v0.0.347/test-plan.md` §4.2 ET-8 + change_plan T6 增量段（决策㉕ 同组件双消费方）。

## Use Case

作为 Rocky 用户，我分别在 squad 管理 tab（studio 入口）与 playground 设置模型 tab（app-dev-config 入口）打开同一个合并 select 组件（ModelOrPlanPicker）——两处应视觉与交互完全一致：panel 结构（上组「模型」下组「方案」+ 搜索框）、行样式、高亮互斥、trigger 态文案（模型「provider / model」/ 方案「方案 · <名>」/ placeholder「选择模型或方案」）、i18n 中文文案相同——证明同一组件双消费方同构，无入口差异。

## 前置条件

- env.sh 已起好环境（case_id 禁下划线；与 ET-1~7 同一 env 可复用）。
- 已有一个 squad（ET-2/6 建过可复用）+ 方案库 ≥1 个方案（`et1-plan` 或现存任一）。
- 本 case 纯 UI 对照验证（不开 SaveBar 保存也行——只看打开面板的静态结构 + trigger 态；但若两侧都做了 pick + save，注意严格互斥语义下两侧状态独立存储：squad 存 squad record，playground 存 model_routing group，互不影响）。

## 操作目标（编号步骤）

1. **squad 侧打开**：nav-rail「Studio」→ squad → 「管理」tab → 合并 select（`data-action-key=studio.squad.select-default-model`）→ 打开 panel。
   - 留证：panel 结构 snapshot（组标题「模型」/「方案」、搜索框、模型行 provider/model、方案行）。
   - 记录 trigger 当前态（模型名 / 「方案 · <名>」/ placeholder 三者之一）。
2. **playground 侧打开**：应用设置 → 模型 tab → 「默认模型」区 chat 行合并 select（`data-action-key=settings.default-models.select-chat`）→ 打开 panel。
   - 留证：同上结构 snapshot。
3. **结构对照核（核心）**：对照两份 snapshot——
   - 组标题：均为中文「模型」+「方案」（i18n 双 ns 同构）。
   - 搜索框：均有、样式一致（h-[30px] 同款）。
   - 行样式：模型行均为 IconBox + provider / model 布局；方案行均为纯方案名行。
   - trigger 态：同一逻辑态（未选/模型/方案）在两侧显示文案一致（placeholder「选择模型或方案」/ 「provider / model」/ 「方案 · <名>」）。
   - panel 视觉：同宽 300px 白卡、同圆角/边框/阴影（视觉判定用 vision_check.py 对比两截图）。
4. **（可选）交互对照**：两侧各做一次「打开 → 选方案行 → 看收起 + trigger 显方案」的交互。
   - 预期：交互行为一致（选中即收起、trigger 即时切换）；若做了保存，两侧各自落盘互不串扰（squad 的选择不影响 playground 的默认，反之亦然）。
   - 注：对照可目视 + snapshot 对比；不强依赖保存成功（ET-6/7 已覆盖保存链路）。

## 验收口径（executor 自由心证）

- **pass**：两侧 panel 结构一致（组标题/搜索框/行样式）、trigger 态文案同构、视觉一致（vision_check 对比通过）；可选交互对照一致。
- **small**：主链路通但有瑕疵不阻塞——如某侧方案列表为空（组标题仍显 + 「暂无方案」空态文案一致也算一致）、触发器宽度因容器不同有细微差异（组件外层约束所致，记录说明）。
- **blocking**：任一侧无「方案」组或组标题文案不同（如一侧缺 i18n key 落 raw key）/ 行样式明显不一致（不同组件实现）/ 同逻辑态 trigger 文案不同 / panel 结构缺失（无搜索框或单组）。

## 留证要求（每步 4 件套）

- 目录：`states/v0.0.347/verify/e2e/et8-dual-entry-consistency/steps/NN-<action>/`（NN=01..04）。
- 每步：`screenshot.png` + `dom.html` + `snapshot.yml` + `meta.json`。
- 关键断言留证点：
  - squad 侧 panel：snapshot 含组标题「模型」+「方案」+ 搜索框 + 模型行 + 方案行。
  - playground 侧 panel：同上结构 snapshot。
  - trigger 态对照：两侧截图显同逻辑态的文案（或各自记录三态之一 + 说明一致）。
  - 视觉对比：vision_check.py 两截图对比结论记录在 meta.json。
- **视觉判定**：用 `tests/e2e/vision_check.py`（注入 token）；**禁 MCP / 禁 Read 截图**。

## 依赖

- specs/ui/components/common/component-model-or-plan-picker.md（组件契约：双 ns 同构 + i18n 5 keys）
- specs/ui/overall/06-studio.md §3.2（squad 侧消费方）
- specs/ui/components/app-dev-config-page/section-default-models-and-request.md（playground 侧消费方）
