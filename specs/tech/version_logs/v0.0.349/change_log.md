# v0.0.349 tech change_log — provider 删除入口 + 方案 dangling 双语义

> 架构期产出（2026-08-15）：change_plan + task.json + spec 即时同步。编码期偏离在此追加。

## 架构期同步记录（architect，编码前）

| 文件 | 变更 | 依据 |
|------|------|------|
| `specs/tech/agent/providers_and_models/[P0]model_routing.md` §4 | 补「[v0.0.349] 全 dangling 降级」段：client 组装段全候选 throw → caller catch 降级 ModelNotConfiguredError（400 MODEL_NOT_CONFIGURED，与分支 1 同时机同构）；部分可组装零改动；routing_loop 单候选既有防御跳过 | change_plan 决策④ |
| `specs/api/overall/21-model-routing.md` | 1.0.0 → 1.1.0：新增 §2.7 dangling 双语义 | change_plan spec-sync 行 |
| `specs/api/overall/02-llm-chat.md` §5.1 | UI 删除入口注记（零契约变更） | 决策①②⑨ |
| `specs/ui/components/providers/section-providers.md` | detail 契约段补 [v0.0.349] 删除入口（SaveBar danger 按钮 + ConfirmModal + onDeleted → handleDeleted 链） | 决策①③ |
| `specs/ui/components/app-dev-config-page/component-plan-item-row.md` | props 补 `invalid?` + col-model dangling 呈现（红描边，冻结视觉内最小表达） | 决策⑥ |
| `specs/ui/components/app-dev-config-page/component-model-routing-plan-editor.md` | props 补 `providers?` + 本地预检补 dangling 存在性（itemModelInvalid，缺省兼容） | 决策⑤ |
| `states/v0.0.349/` | task.json（3 task）+ task-board.md + context.md 初始化 | 双轨状态管理 |

## 编码期偏离记录（coder/coder3/reviewer，doc-modifier2 汇总）

### T1 全 dangling 容错降级（coder，`675c2cc6c` +20/-1，review `9f4634e5c`）

- **实现**：`session-config.ts` 分支 2 caller 段 try/catch——全候选 dangling（provider 被删 → buildClientFromCandidates 全 throw）→ throw `ModelNotConfiguredError`（message 含「方案内所有模型不可用」，与分支 1 跑空同时机同构）；部分 dangling 既有循环零改动。消费链核实：agent-manager.activate catch → makeErrorRun 透传 → session-run/messages/compact/session-deps instanceof → 400 `MODEL_NOT_CONFIGURED`。
- **偏离**：无（唯一后端改动点，review 六死磕点全过）。
- **验证**：UT 全量 10645 绿；review PASSED（9f4634e5c）；**AT 5/5**（临时 case `mr-tmp349-full-dangling-400` 断 `.code == MODEL_NOT_CONFIGURED` + `.message ~= 方案内所有模型`；mr_tc1-4 冒烟零回归；报告 `states/v0.0.349/verify/api-test/AT_report_T1.md`）；teardown 204 瑕疵修复 `42b66aa2c`；临时 case 退场 `1e9cb00e0`。

### T2 前端删除入口 + dangling 预检（coder3，`3739d00d0` 18 files +406/-24，review `15e41b6f5`）

- **实现**：provider detail SaveBar danger 删除按钮（ConfirmModal 通用警示文案）→ `onDeleted` → section `handleDeleted`（deleteProvider → reload → 回 list）；`model-routing-plan-lib.ts` validatePlanLocal 加 providers 二参存在性预检（itemModelInvalid）；`component-plan-item-row.tsx` invalid 红描边（border-danger）；i18n zh/en（providers.json detail.delete* + app-dev-config.json validate.itemModelInvalid）。
- **表外接线 2 处（review 报备采纳）**：① `component-save-bar.tsx` 加 `trailing?: ReactNode` 尾部插槽（provider detail 挂删除按钮；不传零渲染，既有消费方零影响）② `lib/providers.ts` useProviders 加 `loaded` 返回位（首次拉取成功置 true——section 用 loaded 门控预检，防加载窗口全量误判）。
- **偏离**：无 Major/Minor 修复项（review 八死磕点全过：双条件渲染/预检与后端四点对齐/红描边契约/向后兼容/UT 10659 独立复跑/i18n 同构/零后端）。
- **验证**：UT 全量 10659 绿；ET et9 **pass**（删除全链 + data-invalid 红描边 + 保存被拦 circuit={} 未落盘；步 4 vision 误判按 DOM 仲裁通过）。

### T3 BUG-003/004 批修（coder3，`fcf9dbb21` + `1a2fd5f20` 双独立 commit，review `269bf18b2`）

- **BUG-003（SaveBar 首存 dirty 残留，347 遗留）**：根因 = `use-app-settings-config.ts` 三个 useCallback（dirtyOfTab/saveTab/cancelTab）读写 mountDraft/mountSnapshot 但 deps 缺失——真机时序（逐 PUT 网络往返 flush render）下 saveTab 收尾 setMountSnapshot 后闭包停留旧值 → 首存仍 dirty；既有 UT mock 即时 resolve 单 act 合批掩盖。修法 = deps 补全（dirtyOfTab/saveTab 补 [mountDraft, mountSnapshot]、cancelTab 补 [mountSnapshot]）；门控 fetch 红→绿复现 UT。
- **BUG-004（删已挂载方案 trigger 残显 planId，347 遗留）**：根因 = section handleDelete 不上报 page，而 `useAppSettingsConfig`（page 级跨 tab 存活）的 mountDraft/mountSnapshot 仍持已删 planId → 会话 tab trigger 显「方案 · <planId>」直到刷新。修法 = `clearPlaygroundMountState(planId)` + `onPlanDeleted(detached, planId)` 回调按现有结构透传（section → **表外接线 section-tab-panel** → **表外接线 page-app-settings-merged**：detached 含 'playground' 才清）。
- **验证**：三层复现 UT 红→绿；UT 全量 10665 绿 + tsc -b 0；review PASSED（九死磕点含双回滚验真红）；ET et10 **pass**（BUG-003 首存即收敛 data-dirty=false + BUG-004 不刷新即回 placeholder）；bugs/ 标 [fixed] `e73b87ad4`。

### 版本验证汇总

UT 三阶段递增全绿（10645→10659→10665）+ tsc -b 0；**AT 5/5**；**ET 4/4 pass 无阻塞**（et9 删除全链 / et10 BUG 回归 / et7 / et6 回归）；临时 case 退场（tmp AT 1 + tmp ET 2，留证 verify/）。

### doc-sync 记录（doc-modifier2，2026-08-15）

| 文档 | 同步内容 |
|---|---|
| `specs/ui/components/common/component-save-bar.md` | Props 补 trailing/saveTestId/cancelTestId + 消费方补 plan-detail/provider-detail（trailing） |
| `specs/ui/components/app-dev-config-page/section-model-routing-plans.md` | Props 补 onPlanDeleted + 数据态补 providers 数据源/loaded 门控（T2） |
| `specs/ui/components/app-dev-config-page/page-app-settings-merged.md` | 补 [v0.0.349] 方案删除上抛清挂载态（BUG-004）+ BUG-003 hook 修复注记 |
| `specs/tech/agent/providers_and_models/log.md` | 补 2026-08-15 · v0.0.349 条目 |
| `specs/prd/version_logs/v0.0.349-provider-delete.md` | 新建（参照 347/348 格式） |
| 架构期已同步复核 | api 21 §2.7（1.1.0）/ 02-llm-chat §5.1 注记 / tech model_routing §4 / section-providers / item-row / editor 六处复核无误读，未改 |
