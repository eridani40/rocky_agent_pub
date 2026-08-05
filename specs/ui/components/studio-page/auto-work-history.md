# auto-work-history（自动工作历史 section — 心跳唤醒记录）

> 文件: app/web/src/components/studio-page/section-auto-work-history.tsx
> 数据源: `GET /squad/:id/scheduler/history`（挂载即拉 + 父级 reloadKey 触发重拉）；无 SSE（自动工作触发经 squad SSE 推送后由父级 hook 重拉此 endpoint）。

## 职责
展示 squad 自动工作历史：每个 deployed role 的心跳唤醒（reason=heartbeat）记录。每条 = 谁（role）/ 何时（at）/ 为何醒（reason）/ 结果（fired/skipped_*）。
> **重组**：从「独立第 5 tab」改为「`component-autowork-tab` 容器的组合成员之一」。本 section 的职责、Props、状态、testid、数据来源**零改**——仅被组合关系变。
边界：
- **纯只读**（无编辑、无 drag-drop、无创建）。
- 不渲染 charter / member 管理 / 看板工作项（those 在各自 tab）。

## Props
- squadId: string
- limit?: number;  // 缺省 50

## 状态 / 交互
- **渲染列表**（时间倒序，最新在顶）：
  - 每条 item：roleName + at（ISO 格式化为本地时刻）+ reason（heartbeat 中文 label）+ result（fired/skipped_* 状态 badge）。
  - result badge 着色：fired=sage（成功唤醒+跑了一轮）/ skipped_*=muted（被某 gate 跳过：busy/budget/window/killswitch）。
- **空状态**：`auto-work-empty` banner 文案「暂无自动工作记录」（squad 无 deployed member 心跳配置时为空，非 error）。
- **失败状态**：`auto-work-error` banner + 重试。
- **加载状态**：骨架屏 / spinner。
- **过滤 TBD**：可选 roleId 过滤（?roleId=<memberId>），UI 是否暴露 filter TBD（本版本可不暴露，纯时间倒序列表）。

## 视觉基线
> 本版本无设计稿（PRD §3 note），按既有 Studio 视觉对齐。
- 容器沿用 squad-panel 主区（ + `animate-[fadeIn]`）。
- 列表项沿用 member-card / board 卡片 token（ +  + `padding 12px`）。
- reason label 中文：heartbeat→「心跳」。

## 复用关系
- **被组合**：**`component-autowork-tab`**（squad-panel「自动工作」tab 容器，与 squad-autonomy-
- **交叉引用**：与 `squad-board.md`（侧栏独立 board 路由态）平级——squad-board 在 page-studio 主区 bo
