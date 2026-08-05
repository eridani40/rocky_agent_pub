# config-consolidation-status — 整理 tab 立即整理状态正确反映（切走切回仍禁用）

> PRD 路径 D（`specs/prd/version_logs/v0.0.205.t2_cons/change_log.md` §3）。
> 纯自然语言，零断言零录制；executor 按 snapshot 文案/位置自选定位方式。

## Use Case
作为触发整理的用户，我点「立即整理」后切走 tab 再切回，希望按钮仍显示「整理中」禁用态，不会误以为可以再次触发（修复现状切走切回按钮可点的 UX bug）。

## 前置条件
- env.sh 已起好环境（headless 或 electron 模式）。
- LLM provider 可用（minimax 优先）；app_config consolidation 已配置 modelId（整理任务可真正触发）。
- 若 enabled=false，executor 先打开整理开关并配置模型。

## 操作目标（编号步骤）

1. **进入应用设置 → 整理 tab**：照 `specs/ui/overall/00-app-guide.md` 相关章节，从 nav-rail 进应用设置，切到「整理」tab。
2. **点「立即整理」**：按钮立即变为禁用态 + 文案「整理中...」。
3. **切走**：点设置内其他 tab（或离开整理 tab）。
4. **切回整理 tab**：验按钮**仍显示「整理中...」禁用态**——这是本版核心修复点（此前切走切回按钮会恢复可点，UX bug）。
5. **等整理完成**：按钮恢复可点 + 显示「上次整理时间」。

## 验收口径（executor 自由心证）
- **pass**：立即整理触发后按钮禁用，切走切回按钮仍禁用（onInit 读到 running 状态），完成后恢复可点 + 显示上次时间。
- **small**：状态正确但文案/时间显示小瑕疵。
- **blocking**：立即整理点不动 / 切走切回按钮恢复可点（bug 未修）/ status API 500 / 按钮一直「整理中」不恢复。

## 依赖
- `specs/ui/overall/00-app-guide.md`（应用设置路径）
- `specs/prd/version_logs/v0.0.205.t2_cons/change_log.md` §定案2（整理状态修复）+ §3 路径 D
- `specs/ui/components/app-dev-config-page/section-consolidation-config.md`（整理 tab）
