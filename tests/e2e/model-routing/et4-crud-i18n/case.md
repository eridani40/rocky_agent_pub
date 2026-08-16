# model-routing ET-4 — 方案 CRUD + i18n 文案核对（v0.0.347 UI v2）

> v0.0.347 模型路由临时验证路径 ET-4（test-plan §4.2）。纯自然语言 + 定位提示；executor 读 case.md + app-guide 按 snapshot 文案/位置自选定位（action-key/testid > 可见文案 > aria-label）。
> 依据：test-plan `specs/tech/version_logs/v0.0.347/test-plan.md` §4.2 ET-4 + PRD §3 P-A（P-A5 删除=解除挂载）+ change_plan「UI v2 改版」决策⑨/⑩/⑯/⑰ + i18n（app-dev-config.json modelRouting 词表）。
> **UI v2 关键变化**：方案库 = 两层结构（外层 plan-card 列表，点卡进详情）；重命名/复制/删除收进卡片 ⋯ 菜单（`plan-card-menu` → `plan-menu`）；挂载徽章（`plan-mount-badge`）显示「已挂载到 X」/「未挂载」；**列表层无红绿灯**（决策⑰：红绿灯在详情内按条目显示）。

## Use Case

作为 Rocky 用户，我在方案库里对方案做完整 CRUD（v2 交互）：点卡片进详情确认内容 → 回列表 ⋯ 菜单重命名 → 复制（生成「<原名> 副本」）→ 删除（确认提示「已挂载的 squad / playground 将回退到默认模型」）；同时核对挂载徽章、红绿灯（详情内 🟢/🔴/🟡，友好状态词：正常/异常/观察中，**无熔断词**）+ 中文 i18n 文案。

## 前置条件

- env.sh 已起好环境（case_id 禁下划线；与 ET-1~3 同一 env 可复用方案库）。
- 已有 ≥1 个方案（如 `et1-plan`；若 ET-1 未跑先按 ET-1 步骤 1-6 建一个并重命名）。
- 可选用：一个挂载了方案的 squad（验证挂载徽章 + 删除后挂载下拉消失）——若 ET-2 已挂载过 squad 可复用。

## 操作目标（编号步骤）

1. **进入方案库列表（外层卡片）**：应用设置 → 模型 tab → 方案库。
   - 预期：plan-card 列表显示已有方案（`data-testid=plan-card`：名称 + 「N 个模型」（`list.modelsCount`）+ 模型名 · join + 挂载徽章 `plan-mount-badge` + ⋯ 按钮 `plan-card-menu` + › chevron）。
   - **挂载徽章核**：未挂载方案显示「未挂载」（灰）；被 ET-2 挂载过的方案显示「已挂载到 <squad 名>」（绿，多个用 、连接；playground 挂载显示「已挂载到 Playground」）。
2. **进详情确认内容**：点某卡片（整卡可点）→ 详情独立页（面包屑「模型组合方案库 / <名称>」，`detail-title` 纯方案名）→ 条目/熔断参数与原方案一致 → 点面包屑「模型组合方案库」（`detail-back`）回列表（SaveBar「取消」`plan-editor-cancel` = 重置留页，非退出）。
3. **重命名（⋯ 菜单）**：点该卡 ⋯（`plan-card-menu`）→ 菜单（`plan-menu`：重命名/复制/删除）→ 点「重命名」（`plan-rename`）→ 卡片名称位变 input（`plan-rename-input`，值为原名受控回显）→ 输入新名如 `et4-renamed` → Enter。
   - 预期：input 消失，卡片名称更新为新名（重命名成功，列表即时刷新）。
4. **复制（⋯ 菜单）**：点该卡 ⋯ → 「复制」（`plan-copy`）。
   - 预期：列表新增卡片名为「`et4-renamed` 副本」；点开副本进详情，内容与原件一致；改副本条目保存后原件不受影响（独立可编辑）。
5. **红绿灯呈现核（详情内，决策⑰）**：点含模型的方案卡片进详情 → 条目行红绿灯位（`data-testid=circuit-status`，按 provider+model 匹配显示）。
   - 正常模型条目：🟢（title「模型正常」）。
   - 若 ET-3 触发过异常/观察：🔴 异常带倒计时（`circuit-countdown`）/ 🟡 观察中无倒计时。
   - **文案核**：状态词「正常/异常/观察中」+ emoji；**无** Closed/Open/HalfOpen 熔断器词。
   - 注：详情层状态在打开时拉取一次（不轮询）；列表层**无**红绿灯（v2 变化，勿报缺陷）。
6. **删除（⋯ 菜单 + 解除挂载提示）**：点某方案卡 ⋯ → 「删除」（`plan-delete`）→ 弹确认 modal（title「删除方案」，body「确定删除方案「{{name}}」？已挂载该方案的 squad / playground 将回退到默认模型。」）。
   - 预期：确认 modal 出现且 body 含解除挂载提示；点「删除」→ 卡片从列表消失。
   - 若该方案曾被挂载：回 squad 管理 tab → 合并 select 方案组中该方案**消失**（删除 = 解除挂载；T6 严格互斥下原挂载方 select 回未设置态 placeholder「选择模型或方案」）。
7. **i18n 中文文案核对**（列表 + 详情 + 弹层三层走查）：
   - 列表：「模型组合方案库」/「+ 新建方案」（`list.create`）/「{{count}} 个模型」（`list.modelsCount`）/「已挂载到 {{names}}」（`list.mountedTo`）/「未挂载」（`list.unmounted`）/「重命名」/「复制」/「删除」（⋯ 菜单）。
   - 详情独立页（T4）：面包屑「模型组合方案库」（`group.model_routing_plans.label`）+ 标题 = 方案名；底部 SaveBar（common ns）：「保存」（`saveBar.save`）/「取消」（`saveBar.cancel`，仅改动后可见）/「有未保存的改动」（`saveBar.dirty`，accent 色）。
   - 编辑器：「降级顺序（拖拽排序，序号即优先级）」（`editor.degradeOrder`）/「+ 添加模型条目」/「启用」（开关 aria）/「熔断参数（高级）」+ 5 参数标签（连续失败阈值/连续成功阈值/熔断时长（秒）/错误率阈值/最小请求数）+「默认 {{value}}」hint（`editor.defaultHint`）。
   - 时间弹层（点时钟 icon）：「选择可用小时（拖拽连续段 / 点击单格）· 深色 = 该小时可用」（`time.popoverHeader`）/「未选择」（`time.unselected`，空态）/「清除定时」（`time.clearSchedule`）/「确定」（`time.confirm`）；校验文案「至少选择 1 个小时（全不选 = 无效）」（`time.errEmpty`）/「全选 = 全天可用，直接「清除定时」即可」（`time.errFull`）。
   - 条目删除（⋯ → 删除）：「删除路由条目？」（`deleteItem.title`）/「确定删除 {{name}}（序号 {{index}}）吗？此操作不可撤销。」/「删除」/「取消」。
   - 状态词「正常/异常/观察中」；**禁熔断英文词**。

## 验收口径（executor 自由心证）

- **pass**：CRUD 全通（进详情/⋯ 重命名生效/复制生成独立副本/删除确认含解除挂载文案 + 列表移除 + 挂载下拉消失）；挂载徽章正确（已挂载到 X / 未挂载）；红绿灯在详情内呈现正确 🟢/🟡/🔴；i18n 中文文案全部友好词，无熔断词。
- **small**：主链路通但有瑕疵不阻塞——如复制命名格式微差、删除确认文案个别字差、挂载徽章聚合偶发延迟、红绿灯某态无法现场触发（记录观察）。
- **blocking**：⋯ 菜单缺失或重命名/复制/删除任一无效 / 删除无确认提示或确认后不消失 / 挂载下拉仍显示已删方案 / 挂载徽章完全不渲染 / 详情内红绿灯不渲染或状态词错误 / 文案出现 Closed/Open/HalfOpen 熔断词。

## 留证要求（每步 4 件套）

- 目录：`states/v0.0.347/verify/e2e/et4-crud-i18n/steps/NN-<action>/`（NN=01..07）。
- 每步：`screenshot.png` + `dom.html` + `snapshot.yml` + `meta.json`。
- 关键断言留证点：
  - 卡片列表：snapshot 含 `plan-card` + 「N 个模型」+ `plan-mount-badge`（已挂载到 X / 未挂载）。
  - 重命名：snapshot 卡片名称更新。
  - 复制：snapshot 出现「副本」卡片；副本详情独立（改副本原件不变）。
  - 红绿灯：详情 snapshot/dom 含 `circuit-status`（🟢/🔴+倒计时/🟡）+ 状态词。
  - 删除确认：snapshot 含 modal title「删除方案」+ body「…将回退到默认模型」。
  - 删除后方案组：squad 管理 tab 合并 select 方案组无该方案（原挂载方 trigger 回 placeholder）。
  - **禁熔断词**：grep dom 确认无 `Closed`/`Open`/`HalfOpen`（大小写不敏感）。
- **视觉判定**：红绿灯 emoji/颜色用 `tests/e2e/vision_check.py` 判图（注入 token）；**禁 MCP / 禁 Read 截图**。

## 依赖

- specs/prd/model-routing-demo-v2.html（UI v2 冻结视觉契约：卡片/⋯ 菜单/详情）
- specs/tech/version_logs/v0.0.347/change_plan.md「UI v2 改版」决策⑨/⑩/⑯/⑰
- specs/ui/components/app-dev-config-page/section-model-routing-plans.md（方案库列表契约）
- specs/ui/components/app-dev-config-page/component-circuit-status.md（红绿灯契约）
- app/web/src/i18n/locales/zh-CN/app-dev-config.json（modelRouting 词表权威源）
- specs/api/overall/21-model-routing.md §2.3（DELETE 解除挂载）
- specs/prd/model-routing-PRD-2026-08-14.md §3 P-A5（删除=解除挂载+回退默认）+ §4 验收 1
