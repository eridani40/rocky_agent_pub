# page-connector

> 文件: app/web/src/components/connector-page/page-connector.tsx

## 职责
连接器页根：标题 + tab 栏 + 当前 tab 内容。 落地第 2 tab `computer`（架构验证 spike）：
- `browser` tab → `section-browser-connector`（受控，state 由 ConnectorManager 经 HTTP 推回）。
- `computer` tab → `section-computer-connector`。
边界：browser 不实现状态机逻辑（ConnectorManager 提供 state，本组件只渲染 + 派发 enable/disable）；computer section 自管权限查询/截图 IPC，page 只按 active tab 渲染。

## Props
- connectors: ConnectorState[]
- onToggle: (id: 'browser', enable: boolean) => void;  // 派发 enable/disable

## 状态 / 交互
- 本地态：当前选中 tab id（默认 `browser`，v0.0.23 仅此一个）。
- `onToggle` 调 ConnectorManager.enable/disable（经 HTTP facade → 后端 ConnectorManager），后端回推新 state，组件重渲染。
- ** 语义变更**：`enable('browser')` 只写 intent + `switch=on`（**不再触发 connect**）——回推的 state 立即是 `{switch:'on', connection:'disconnected'}`。connect 由 LLM 首次调 `browser({mode:'attach'})` lazy 触发（UI 层不感知）。
- connecting 态只在 LLM 触发 lazy connect 期间短暂出现；用户点 toggle on 不再进 connecting。

## 视觉基线
- 容器 `max-width 880px` 居中，与 app-dev-config-page / skill-page 一致。
- 标题 15px/600，desc mono 13px/400 muted。
- tab 栏样式复用现有 tab 组件风格。

## 复用关系
- 被组合于：app-shell renderView
