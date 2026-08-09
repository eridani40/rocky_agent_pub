# component-token-stats — squad token 用量统计视图组件族

> 层级: section（路由态根）+ component（5 子组件）
> 参考: specs/prd/version_logs/v0.0.194/prd.md（口径 + 入口 + 维度）
>       specs/ui/overall/06-studio.md §2.3（SeatsPanel tab 条结构）
>       specs/api/overall/11c-token-stats.md §3（TokenUsageQueryResult 契约）

## 职责
squad 团队/成员 token 用量可视化视图：4 维度+ model 筛选 + 日期选择 + 日历热力 + 时间轴堆积图 + hover createPortal 明细。
入口 = SeatsPanel 头部 tab 条右侧「Token 统计」按钮 → `MainView {kind:'token-stats'; squadId}` 独立路由态（与 board/panorama 同范式），头部返回键退出回 seats。
边界：统计视图是只读可视化，不改 squad/member 数据；sqlite 装配失败（503）→ 显降级空态（不崩页面）。

## 状态 / 交互
- 4 chip 组（粒度/类型/视图 各 chip；范围走自定义下拉；model 走自定义下拉）+ 单日粒度下的日期选择
- **model 筛选下拉 value = `${providerId}/${modelId}`，modelId 可含 `/`**（OpenRouter 等 vendor 前缀命名，如 `deepseek/deepseek-chat`）；解码（`parseModelSelection`，见 helpers）按**首个 `/`** 切——providerId 恒为 slash-free ULID 或 `__unknown__`，首斜杠是唯一分隔符，modelId 后半段整体保留，**禁止 `split('/')` 截断**（否则后端过滤不命中）
- 视图切换：`calendar` + `granularity=hour` → 显空态引导（与 demo 沿用）
- **hover 明细走 createPortal 到 document.body**（修过的 overflow 裁剪 bug 不回退）+ native title 兜底
- **范围/模型自定义下拉（CustomDropdown）面板同走 createPortal 到 document.body + `position:fixed`**（脱离父 stacking context，盖过日历 cell / 时间轴 bar 图表列）+ `bg-surface` 不透明 + `z-popover`；定位 = open 时取 trigger `getBoundingClientRect()` 贴下沿 4px 左对齐；outside-close 用 `triggerRef + panelRef` 双 contains（Portal 后面板脱离 trigger DOM 分支，单判 trigger 会把点选项误判为容器外 → 选项 onClick 不触发）
- 503 sqlite 未就绪 → 主区显「统计功能未就绪」空态，不崩
- 503 范围外错误 → 显 error 空态 + retry 按钮（简化：仅显文案）

## 视觉基线
- 配色（reusable hue palette）：input=`--hue-blue` / output=`--hue-violet` / cache=`--hue-green` / cacheRate=`--hue-amber`
- 尺寸：chip / 下拉 / 日期 input 统一 ；状态切换尺寸恒定（§11）

## 复用关系
- 被组合：`page-studio.tsx`（token-stats 路由态，与 board/panorama 同级）
- 组合：`ChatTopbarBackBtn`（返回键 primitive，复用 board-topbar-back-btn 同款）+ `Controls`
