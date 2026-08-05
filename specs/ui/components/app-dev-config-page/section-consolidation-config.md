# section-consolidation-config（整理 tab group 渲染）

> 层级: section
> 文件: app/web/src/components/app-dev-config-page/section-consolidation-config.tsx

> **状态：已细化（coder 2026-07-15 编码前置补全）**——testid 契约 + 禁用态语义 + 只读状态区已定稿，实现与本文件一致。

## 职责
整理 tab（`consolidation`，系统设置收起区，与 observability/plugin 同级）下唯一一个 group 的渲染区（KV group `app_config/consolidation`，单 record key=`default`）：
- `enabled`：是否启用天级二级整理任务（boolean toggle）
- `dailyTime`：每天触发时刻
三字段均走 `useAppSettingsConfig` 扩展，参与 `TAB_KV_GROUPS.consolidation` 的 dirty 跟踪与保存，但**不进 `KV_GROUPS`**。

## 数据源
- **REST**：KV group 走 `PUT /config/app` body={group:'consolidation',key:'default',data}；整理任务 `POST /consolidation/run`（202 触发 / 409 = 已在跑）；初始态 `GET /consolidation/status`（失败兜底为「尚未整理过」）。
- **SSE**：`subscribe(APP_TASK_TOPIC='app_task', APP_TASK_BROADCAST_GROUP='_all')`——事件 `consolidation_task_update` 驱动 running/done/failed 状态迁移（`useLifecycle.onEvent` reducer 处理）。这是配置中心**唯一有 SSE** 的 group。
- 文件：`section-consolidation-config.tsx`（`TaskPanel` 子组件 `useLifecycle` + `subscribe`）。

## Props
- enabled: boolean
- dailyTime: string;      // HH:mm
- modelId?: string
- draft: ConsolidationData
- onChange: (key: keyof ConsolidationData, value: ConsolidationData[keyof Conso...

## 复用关系
- 被组合：`page-app-settings-merged` → `section-tab-panel.tsx`（整理 tab 唯一 group；实际 ta
- 组合：`common/component-key-model-picker`（modelId 选择）；enabled 走 `framework/primit
