# component-cron-panel（「定时任务」tab 内容区）
> - cron CRUD 逻辑抽出为数据 hook **`use-cron-crud.ts`**（`useCronCrud(sessionId,{enabled})`，`enabled:false` 零网络；float-menu 恒挂载驱动 badge + 弹层，见 `[P0]component_data_map.md §2`）。`NewFormState`/`INITIAL_NEW` 迁入该 hook。

> 文件: ~~app/web/src/components/chat-page/section-cron-panel.tsx~~

## 1. 定位 + 设计意图 `section-cron-panel` 是右侧 ws-panel **「定时任务」tab 激活时**渲染的内容区，列出当前 session 的全部 cron jobs（cron expr + prompt），支持 enable/disable、删除、新建。归属 **session**（playground / leader / mate 各自独立；**squad chat 群聊不挂** — 群聊 session 不归单个 agent）。
| 复用场景 | prop sessionId 来源 | tab 容器 |
|---|---|---|
| playground chat 右侧 | chat 当前 session id | `section-workspace-panel`（`component-ws-tab-bar` 切到「定时任务」） |
| studio leader/mate 右侧 | leader/mate 各自 session id | `section-right-tabs`（切到「定时任务」） |
**与心跳的关系**：心跳 = squad 级团队统管（`studio-page/heartbeat-config.md`），cron = session 级自建；两套独立 UI，共享底层调度引擎。

## 4. 状态 / 交互
- **进入 tab** → GET `/session/:sid/cron` → 渲染 jobs 列表
- **保存新建** → POST `/session/:sid/cron` → 成功后 refetch + 收起表单
- **点 toggle** → enabled ? POST disable : POST enable → refetch
- **点删除** → `confirmDeleteId=id` → 二次确认 → DELETE → refetch
- **失败** → error 文本展示在列表区

## 视觉基线
- **layout**：header（标题 + 归属 tag + 新建按钮）→ 列表垂直滚动 padding 8px 12px gap 8px；新建表单展开时占据列表顶部。
- **font**：job name 13px/600 var(--fg)；人话频率 chip 12px/600 var(--accent-hover) bg var(--accent-surface)；prompt 摘要 12px var(--text-2)；下次触发 11px mono var(--text-3)。
- **color**：行底 var(--surface)；hover var(--bg-warm)；disabled job opacity 0.55 + bg var(--bg)。
- **chip**：bg var(--accent-surface) + border 1px var(--accent-light) + 圆角 999px + 前缀「🔁 」icon。

## 复用关系
- 被组合：`section-workspace-panel`（chat 右侧 ws-panel 第 3 tab）+ `section-right-tabs`（
- 与 `studio-page/heartbeat-config.md`（心跳配置）：**独立**（cron=session 级，心跳=squad 级；不共享
