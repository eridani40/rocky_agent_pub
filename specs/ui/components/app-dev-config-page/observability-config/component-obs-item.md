# component-obs-item

> 层级: component
> 文件: app/web/src/components/app-dev-config-page/observability-config/component-obs-item.tsx
> 视觉契约: reqs/v0.0.11/easy-opc-config-v10.html L409-428（provider-card）

## 职责
可观测性列表单项：logo + 名称行（状态点 + 名称 + 启停 badge）+ desc 行 + 启停 toggle + 删除按钮。点击整卡进详情；toggle 与删除独立。
边界：不展示编辑表单（→ detail）。

## Props
- config: ObservabilityConfig;          // 见 _overview §2
- onSelect: (id: string) => void
- onToggle: (id: string, enabled: boolean) => void
- onDeleteRequest: (config: ObservabilityConfig) => void;  // 触发父级打开 modal

## 状态 / 交互
- 点击整卡（logo/name/desc 区）→ `onSelect(id)`。
- toggle 点击：`stopPropagation` → `onToggle(id, !enabled)`（**即时生效，不计 dirty**）。
- **布局稳定性**：toggle 与删除按钮**始终可见**，预留固定空间（无 `display:none` 切换）。

## 视觉基线
见 `section-observability-list.md` 视觉基线「provider-card / logo / name 行 / desc 行 / toggle / 删除按钮」。

## 复用关系
- 被组合：`section-observability-list`
