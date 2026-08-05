# component-group-save-bar

> 层级: component
> 文件: app/web/src/components/app-dev-config-page/component-group-save-bar.tsx

## 职责
单个 group 的独立保存按钮条。仅对当前渲染的 group 生效，提交该 group 全部 key。
边界：只负责触发 `onSave`（实际 `PUT /config/app` body={group,key,data} 在 page 层 `app-settings-persist.ts`）；不展示该 group 内的具体 key（那些由 `component-key-card` 渲染）；不跨 group 联动（每个 group 各自一条）。
**数据源**：REST CRUD 无 SSE——本组件不直接调 API，save 上抛 page 层走 `PUT /config/app`（logs 走 `putConfigGroup('app','logs',items)`，default_models/llm_request/session/consolidation 走单 record `{group,key,data}` 整体 PUT）。

## Props
- groupId: string
- dirty: boolean
- saving: boolean
- onSave: () => void

## 状态 / 交互
- 点保存 → `onSave`（page 收到后提交该 group 全部 key）
-  时按钮高亮并显示 `●` 标记，提示有未保存改动
-  时按钮禁用，文案切为「保存中…」
- 非 dirty 且非 saving 时按钮可点但无高亮（保留显式保存入口）

## 复用关系
- 被组合：`section-config-layout`（当前 group 的右侧底部）
