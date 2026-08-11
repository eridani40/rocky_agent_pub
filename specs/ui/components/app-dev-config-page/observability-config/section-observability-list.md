# section-observability-list

> 层级: section
> 文件: app/web/src/components/app-dev-config-page/observability-config/section-observability-list.tsx
> 视觉契约: reqs/v0.0.11/easy-opc-config-v10.html L399-458（list 视图）+ reqs/v0.0.11/list.png

## 职责
可观测性列表视图：标题区 + provider-card 列表 + 「添加配置」卡 + 删除确认 modal。每项点击进入详情；启停 toggle 攒入 dirty（v0.0.317 D10，走 tab 级 SaveBar 保存，不再即时生效）；删除经 modal 二次确认后即时。
**数据源**：REST CRUD 无 SSE——configs/toggle/delete 均由父级 `section-observability.tsx` 持有，走 `GET /config/app?group=runtime&key=observability`（整 list 一 record）+ `PUT /config/app`（整 list 提交，SecretInput 编辑态明文回传）。本 list 组件是受控展示。
边界：不管详情编辑（→ `section-observability-detail`）；不直接落库（调 observability manager API，归 tech）。

## Props
- configs: ObservabilityConfig[];       // 见 _overview §2
- onSelect: (id: string) => void;       // 点列表项 → 进 detail
- onAdd: () => void;                    // 点「添加配置」→ 进 detail（new）
- onToggle: (id: string, enabled: boolean) => void;  // v0.0.317 D10：攒入 dirty，走 SaveBar 保存（不再即时生效）
- onDelete: (id: string) => void;       // modal 确认后调（即时删除）

## 状态 / 交互
- **header**：config-header 样式；title「可观测性配置」+ desc「observability · 链路追踪与监控」。
- **列表项**（`component-obs-item`）：点击整卡 `onSelect(id)`；toggle 与删除按钮 `stopPropagation`。
- **添加卡**：dashed border；点击 `onAdd`。
- **删除 modal**：点项删除按钮 → 打开 `component-obs-delete-modal`，确认 → `onDelete(id)` → 关闭。
- **空列表态**：列表为空时仅显示「添加配置」卡（无 empty-state 文案；可后续追加）。
- **布局稳定性（MANDATORY）**：避免相邻项位移。

## 复用关系
- 被组合：`section-config-layout`（dev config 页选中 observability group 时路由到本 section）
