# model-routing ET-1 — 方案库新建 + 时间弹层交互（v0.0.347 UI v2）

> v0.0.347 模型路由临时验证路径 ET-1（test-plan §4.2）。纯自然语言 + 定位提示；executor 读 case.md + app-guide 按 snapshot 文案/位置自选定位（action-key/testid > 可见文案 > aria-label）。
> 依据：test-plan `specs/tech/version_logs/v0.0.347/test-plan.md` §4.2 ET-1 + PRD §3 P-A + change_plan「UI v2 改版」决策⑨-⑰（demo v2 = specs/prd/model-routing-demo-v2.html 冻结视觉契约）。
> **UI v2 关键变化**：两层结构（外层方案卡片列表 → 点卡进详情）；时间控件 = 时钟 icon 弹层（草稿态 + 语义翻转 + footer 双按钮）；排序 = grip 手柄拖拽（无 ↑/↓ 按钮）；方案名 input 已删（命名走列表层 ⋯ 菜单重命名）。

## Use Case

作为 Rocky 用户，我在「应用设置 → 模型 tab」的方案库里新建一个模型组合方案（默认名「方案 N」，添加 Kimi 带时间条件 02-23 + GLM 无条件两个条目），体验两层结构（卡片列表 → 详情 → 快照回滚取消）、时间弹层交互（默认全灰、拖拽连段、footer 实时段、确定 1-23 校验、清除定时、点空白丢弃草稿）、grip 拖拽排序；保存成功后在列表重命名；故意违反同模型约束（带时间条目排在不带时间下面）时本地预检阻止保存。

## 前置条件

- env.sh 已起好环境：`bash tests/e2e/env.sh start et1-plan-library-time-picker --mode=headless`（case_id 禁下划线）。
- 已启用 ≥2 个 provider+model（如 minimax/MiniMax-M3 + GLM/glm-4 或现有可用 provider；若不足可先建 provider 或在 models tab provider 区确认）。
- 设置入口：nav-rail「应用设置」→ 左侧 tab 树「模型」（models tab，provider 区下方为方案库）。

## 操作目标（编号步骤）

1. **进入方案库（外层卡片列表）**：nav-rail「应用设置」→ tab 树选「模型」→ 方案库区块（`data-testid=model-routing-plans`，标题「模型组合方案库」）。
   - 预期：空态显示「还没有模型组合方案。点右上「新建方案」创建。」；或已有方案则显示 plan-card 列表（`plan-card`：名称 + 「N 个模型」 + 模型名 join + 挂载徽章 `plan-mount-badge`「未挂载」/「已挂载到 …」+ ⋯ 按钮 `plan-card-menu` + ›）。
2. **新建方案（直接进详情独立页）**：点「+ 新建方案」（`data-testid=plan-create`）。
   - 预期：**直接进入详情独立页（T4 补丁：独占 tab 内容区，provider 区及标题全隐藏）**——面包屑（`detail-back`「模型组合方案库」可点文字 + `/` + `detail-title` 纯方案名「方案 1」）+ logo 首字母块标题区 + 编辑器（`plan-editor`：toolbar「降级顺序（拖拽排序，序号即优先级）」+「+ 添加模型条目」`plan-editor-add-item` + 空条目列表 + 底部熔断参数区**常显**（`plan-editor-circuit`，5 参数带「默认 N」hint，无展开开关）+ **页面底部 sticky SaveBar**（左侧 dirty 状态文本；「取消」`plan-editor-cancel` 仅 dirty 时可见；「保存」`plan-editor-save`）。
   - 注：v2 无方案名 input；默认名 = 「方案 N」（N = 现有数 + 1），重命名在列表层（步骤 6）。详情风格 = provider 详情页同款（面包屑/logo/SaveBar 位置）。
3. **添加第一条 Kimi（带时间 02-23）**：
   - 点「+ 添加模型条目」→ 出现 7 列行（`plan-editor-item`：grip 手柄 `plan-editor-item-handle` + 序号 + ModelPicker（action-key `settings.models.plan.item-model-0`）+ 时钟 icon + 红绿灯位 + 开关 + ⋯）。
   - ModelPicker 选 Kimi 模型。
4. **时间弹层交互（时钟 icon → HourGridPicker 草稿态）**：
   - **打开**：点该行时钟 icon（`plan-editor-item-time`，当前 `data-active=false` 灰色）→ 弹出时间弹层（`time-popover`：header「选择可用小时（拖拽连续段 / 点击单格）· 深色 = 该小时可用」+ 24 格网格 `hour-grid`（`hour-cell-0`~`hour-cell-23`）+ footer）。
   - **默认全灰**：打开瞬间 24 格全部**浅灰 = 关**（v2 语义翻转：浅灰=该小时不可用，深色=可用；与 v1 默认全选中相反）。
   - **拖拽连段**：从 `hour-cell-2` 拖到 `hour-cell-23`（mousedown 2 → 移动经过/到 23 → mouseup）→ 2-23 深色选中；**footer 左侧实时显示**「02:00-23:00」（`hour-grid-selected`，格式与 tooltip 同）。
   - **确定写回**：点「确定」（`hour-grid-confirm`）→ 弹层关闭 + 时钟 icon 变 `data-active=true`（高亮态）+ hover icon 出 tooltip（`plan-editor-time-tooltip`「02:00-23:00」）。
   - **草稿丢弃（再验一次）**：再点 icon 开弹层 → 点选一个新格（如 `hour-cell-5` 变深色，footer 变「02:00-06:00, 23:00-24:00」之类）→ **不点确定**，点弹层外空白处 → 弹层关闭 → icon tooltip 仍「02:00-23:00」（草稿未写回，基线不变）。
   - **校验（可选加分）**：开弹层 → 点「清除定时」左侧无操作使全空后点确定会报错——具体：若把格子清到 0 个再点「确定」→ footer 左显示 `hour-grid-error`「至少选择 1 个小时（全不选 = 无效）」且弹层**不关闭**；24 格全选再确定 → 「全选 = 全天可用，直接「清除定时」即可」同样不关闭。
   - **清除定时语义**：开弹层 → 点「清除定时」（`hour-grid-clear-time`）→ 弹层关闭 + icon 回灰 `data-active=false`（timeCondition 删除 = 全天可用）；如需 02-23 请重新打开拖一次并确定。
5. **添加第二条 GLM（无条件）+ 保存**：
   - 点「+ 添加模型条目」→ ModelPicker 选 GLM（action-key `settings.models.plan.item-model-1`）；时钟 icon 保持灰色（无条件 = 全天）。
   - 两条目开关（`plan-editor-enabled`，`data-enabled=true`）默认启用。
   - **grip 拖拽排序（顺手验证）**：抓第一条 grip 手柄（`plan-editor-item-handle`）拖到第二条行上放手 → 两行顺序交换 + 序号列重排（1/2）。
   - 点「保存」（`plan-editor-save`，页面底部 sticky SaveBar 右侧）。
   - 预期：保存成功 → **回外层卡片列表**；新卡片（`plan-card`）出现：名称「方案 1」+ 「2 个模型」+ 「kimi-model · glm-model」join + 「未挂载」徽章。
6. **列表层重命名（v2 新位置）**：点该卡片 ⋯（`plan-card-menu`）→ 菜单（`plan-menu`：重命名/复制/删除）→ 点「重命名」（`plan-rename`）→ 卡片名称位变 input（`plan-rename-input`，值为原名）→ 改为 `et1-plan` → Enter。
   - 预期：input 消失，卡片名称更新为 `et1-plan`。
7. **同模型约束本地预检（故意违规）+ 回退回滚**：点 `et1-plan` 卡片进详情 → 把两条目换成**同一模型**（item0 ModelPicker 改选与 item1 相同模型），使「不带时间在上、带时间在下」违规（或拖拽交换使带时间条目在下）。
   - 预期：`plan-editor-validation` 实时显示「带时间条目必须在不带时间条目上面」（i18n `validate.timeAboveUnconditional`；也可能触发同模型 2 带/2 不带文案，任一即可）；点「保存」（SaveBar）被阻止（错误展示，仍留详情未回列表）。
   - **SaveBar 取消 = 重置留页（T4 语义）**：点「取消」（`plan-editor-cancel`，改动后可见）→ 草稿重置回快照（编辑器恢复原样）但**仍留详情页**（不回列表）。
   - **面包屑回退 = 回滚退列表**：点面包屑「模型组合方案库」（`detail-back`）→ 回列表 → 再点卡进详情 → 两条目**恢复原样**（编辑草稿未落盘，structuredClone 快照回滚生效）。

## 验收口径（executor 自由心证）

- **pass**：两层结构通（卡片→详情→取消回滚）、时间弹层全交互通（默认全灰/拖拽连段/footer 实时段/确定写回 icon 高亮/草稿丢弃/清除定时 icon 回灰）、grip 拖拽排序、保存回列表卡片正确（N 个模型 + 模型名 join + 未挂载徽章）、重命名生效、违规预检阻止保存 + 取消回滚。
- **small**：主链路通但有瑕疵不阻塞——如 footer 时段格式微差、拖拽边界格（23 点）行为小差异、校验报错文案微差、快照回滚后需手动刷新才见。
- **blocking**：方案库入口找不到 / 新建不进详情 / 时间弹层不渲染或拖拽无效 / 确定不写回（icon 不高亮）/ 违规可保存 / 取消后草稿污染原方案（回滚失效）/ 保存后列表数据丢失。

## 留证要求（每步 4 件套）

- 目录：`states/v0.0.347/verify/e2e/et1-plan-library-time-picker/steps/NN-<action>/`（NN=01..07）。
- 每步：`screenshot.png` + `dom.html` + `snapshot.yml` + `meta.json`（{step, action, intent, playwright_cmd, console_errors, my_observation, verdict}）。
- 关键断言留证点：
  - 两层结构：snapshot 含 `plan-card` 列表 → 点击后 `detail-title`「方案 1」（面包屑「模型组合方案库 / 方案 1」）+ `plan-editor`。
  - 时间弹层默认态：snapshot `hour-cell-*` 全部 data-selected=false（全灰 = 关，语义翻转）。
  - 拖拽 02-23：snapshot `hour-cell-2`~`hour-cell-23` data-selected=true + footer `hour-grid-selected` 文本「02:00-23:00」。
  - 确定写回：`plan-editor-item-time` data-active=true + tooltip `plan-editor-time-tooltip`「02:00-23:00」。
  - 草稿丢弃：点空白后 snapshot tooltip 仍「02:00-23:00」。
  - 清除定时：`hour-grid-clear-time` 点击后 data-active=false。
  - 校验（若做）：`hour-grid-error` 文本含「至少选择 1 个小时」或「全选」。
  - 违规预检：snapshot/dom 含 `plan-editor-validation` + 「带时间条目必须在不带时间条目上面」；保存后仍在详情层（未回列表）。
  - 快照回滚：取消后再进详情，snapshot 条目恢复原样。
- **视觉判定**：用 `tests/e2e/vision_check.py`（`set -a; . ~/.rocky_agent/test.secrets.env; set +a` 注入 token）；**禁 MCP / 禁 Read 截图**（截图只留证不判读）。

## 依赖

- specs/ui/overall/00-app-guide.md §3.x（应用设置 → 模型 tab 路径）
- specs/prd/model-routing-demo-v2.html（UI v2 冻结视觉契约：卡片/详情/弹层/footer）
- specs/tech/version_logs/v0.0.347/change_plan.md「UI v2 改版」决策⑨-⑰
- specs/api/overall/21-model-routing.md §2.1/§2.2（PUT 方案 + 校验 400）
- specs/prd/model-routing-PRD-2026-08-14.md §2.3（UC-8/9 时间语义不变：hours 白名单 / 清空 = 全天）
