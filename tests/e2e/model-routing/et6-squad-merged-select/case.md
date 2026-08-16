# model-routing ET-6 — squad 合并 select 单选交互 + 严格互斥目视（v0.0.347 T6）

> v0.0.347 模型路由临时验证路径 ET-6（test-plan §4.2 T6 增补）。纯自然语言 + 定位提示；executor 读 case.md + app-guide 按 snapshot 文案/位置自选定位（action-key/testid > 可见文案 > aria-label）。
> 依据：test-plan `specs/tech/version_logs/v0.0.347/test-plan.md` §4.2 ET-6 + change_plan T6 修正段（决策㉛ 严格互斥，commit 6dbb8ee50）。

## Use Case

作为 Rocky 用户，我在 squad 管理 tab 打开「默认模型」行的合并 select（上组「模型」下组「方案」），依次体验 选模型 → 选方案 → 切回模型 的完整往返——trigger 态应随 pick 即时切换（模型名 / 「方案 · <名>」），且任意时刻 panel 高亮只在模型组或方案组其一（严格互斥：选方案后模型不再高亮、反之亦然），save 后落盘单值。

## 前置条件

- env.sh 已起好环境（case_id 禁下划线；与 ET-1~5 同一 env 可复用）。
- 已有一个 squad（可复用 ET-2 建的；若无需按 ET-2 步骤 1 wizard 建队，建队时 modelDefault 选 minimax/MiniMax-M3）。
- 方案库已有 ≥1 个方案（如 `et1-plan`；若 ET-1 未跑先按 ET-1 建一个合法方案）。
- 本 case 纯 UI 交互验证，不强依赖 LLM 调用（不涉及发消息）。

## 操作目标（编号步骤）

1. **进管理 tab**：nav-rail「Studio」→ 选中 squad → 「管理」tab（ManageTab）→「默认模型」行合并 select（`data-action-key=studio.squad.select-default-model`）。
   - 初始态：trigger 显建队所选模型（「provider / model」格式）或 placeholder「选择模型或方案」。
2. **打开 select 两组恒显核**：点 trigger 打开 panel。
   - 预期：上组标题「模型」+ 下组标题「方案」两组**恒显**；顶部搜索框；上组为 provider 分组模型行（如 minimax / MiniMax-M3），下组为方案名行（含 `et1-plan`）。
3. **选方案 → trigger 切方案态**：点下组方案名行（如 `et1-plan`）→ 面板收起 → SaveBar 保存。
   - 预期：保存成功；trigger 显「方案 · <方案名>」（方案徽章前缀区分模型）。
   - 可顺带 API 佐证（若 executor 有 API 访问通道）：GET /squad/:id → `modelRoutingPlanId` = 所选方案 且 `modelDefault` 为空/''（严格互斥显式清空；双设 = 非法态）。无通道则纯 UI 目视即可。
4. **高亮互斥核（方案向）**：再次打开 select。
   - 预期：方案 `et1-plan` 行高亮（`aria-selected=true`）；**上组所有模型行均无高亮**（原模型已被清，无幽灵高亮）。留证后收起。
5. **切回模型 → trigger 切模型态**：打开 select → 点上组某模型行（如 minimax / MiniMax-M3）→ SaveBar 保存。
   - 预期：保存成功；trigger 显「provider / model」模型名（方案前缀消失——PATCH planId:null 解除挂载）。
6. **高亮互斥核（模型向）**：再次打开 select。
   - 预期：所选模型行高亮（`aria-selected=true`）；**下组所有方案行均无高亮**（互斥反向验证）。留证后收起。

## 验收口径（executor 自由心证）

- **pass**：两组恒显（上「模型」下「方案」）；选方案保存后 trigger 显「方案 · <名>」且模型行零高亮；切回模型保存后 trigger 显模型名且方案行零高亮——两向互斥目视均成立。
- **small**：主链路通但有瑕疵不阻塞——如方案名/模型名显示截断、保存后 trigger 回显延迟、API 佐证通道不可用仅做 UI 目视（记录说明）。
- **blocking**：合并 select 不存在或无方案组 / 选方案保存失败或 API 佐证显双设（modelDefault 未清）/ 切回模型保存失败 / 打开 select 出现模型+方案双高亮（互斥失效）/ trigger 态与所选不符。

## 留证要求（每步 4 件套）

- 目录：`states/v0.0.347/verify/e2e/et6-squad-merged-select/steps/NN-<action>/`（NN=01..06）。
- 每步：`screenshot.png` + `dom.html` + `snapshot.yml` + `meta.json`。
- 关键断言留证点：
  - 两组恒显：snapshot panel 含中文组标题「模型」+「方案」。
  - 选方案回显：snapshot trigger 显「方案 · <方案名>」。
  - 方案向高亮互斥：snapshot panel 方案行 aria-selected=true + 模型行全无。
  - 切回模型回显：snapshot trigger 显「provider / model」（无方案前缀）。
  - 模型向高亮互斥：snapshot panel 模型行 aria-selected=true + 方案行全无。
- **视觉判定**：用 `tests/e2e/vision_check.py`（注入 token）；**禁 MCP / 禁 Read 截图**。

## 依赖

- specs/ui/components/common/component-model-or-plan-picker.md（合并 select 组件契约：trigger 态/两组/高亮互斥）
- specs/ui/overall/06-studio.md §3.2（管理 tab 控件 + 严格互斥载荷）
- specs/api/overall/21-model-routing.md §2.5（PATCH 挂载三语义 + 双非空 400）
