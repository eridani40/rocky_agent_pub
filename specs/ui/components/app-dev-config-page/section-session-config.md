# section-session-config（会话 tab 第一 group 渲染）

> 层级: section
> 文件: app/web/src/components/app-dev-config-page/section-session-config.tsx

## 职责
会话 tab 下第一个 group 的渲染区（KV group `app_config/session`，单 record key=`default`）：
- `maxSkillInject`：单次会话注入 skill 的最大条数（`key-number`，整数，默认 50）
- `maxMemoryInject`：单次会话注入 memory 的最大条数（`key-number`，整数，默认 50）
两字段均 optional；record 不存在时回退默认值 50（不写入后端，仅前端兜底）。

## 数据源
REST CRUD 无 SSE——本 section 纯展示 + 上抛变更。draft + 保存由 `useAppSettingsConfig` + `app-settings-persist.ts` 持有：read-modify-write——基于完整 snapshot 改 `maxSkillInject` / `maxMemoryInject` 后 `PUT /config/app` body={group:'session',key:'default',data:fullSnapshot} 整 record 提交（不丢其他子字段）。
边界：不直接调 API（draft 由 `useAppSettingsConfig` 管理，本 section 纯展示 + 上抛变更）；

## Props
- sessionDraft: { maxSkillInject: number; maxMemoryInject: number }
- onSessionChange: (key: 'maxSkillInject' | 'maxMemoryInject', value: number) =...

## 视觉基线
- 值等于默认值 50 时 input 文本灰显，非默认值正常
- 无单位后缀（注入条数为无量纲整数）

## 复用关系
- 被组合：`section-tab-panel`（会话 tab 首个 group）
- 组合：（无，内联 `NumberKeyRow` 子组件，不依赖其他 component）
