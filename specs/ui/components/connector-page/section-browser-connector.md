# section-browser-connector（浏览器连接器卡片）

> 层级: section（单卡片 section）
> 文件: app/web/src/components/connector-page/section-browser-connector.tsx

## 职责
浏览器连接器的交互单元：呈现 switch + connection **双状态**、引导用户开 chrome remote debugging、显示错误与重试。边界：不直接 attach chrome（派发 enable/disable 给 ConnectorManager，状态由其推回）。

## 数据源
REST CRUD 无 SSE——本组件受控展示 `state: ConnectorState`，state 由父级 `page-connector` 经 `useLifecycle` 持有：`enable('browser')`/`disable('browser')` 走 HTTP facade → 后端 ConnectorManager；后端回推新 state 后组件重渲染。connecting→终态由后端 lazy connect 推动，无 SSE topic 感知 → page 用 5s poll 兜底（`onTick` reload）。

## Props
- state: ConnectorState;                       // { switch, connection, errorDe...
- onToggle: (enable: boolean) => void;          // enable/disable → ConnectorMa...

## 状态 / 交互
UI 态由 `state.switch` + `state.connection` 派生（**switch 与 connection 完全解耦**——switch=on 仅表示用户已启用，不代表已连上）：
| connection | switch | toggle 视觉 | status | 额外 |
|---|---|---|---|---|
| disconnected | off | off | 「未启用」灰 | — |
| **disconnected** | **on**  | **on** | **「已启用（未连接）」灰** | LLM 首次 attach 时会连 |
| connecting | on | on 禁用（防抖） | 「连接中…」黄+spinner | **LLM 触发 lazy connect 时短暂出现**（用户点 toggle on 不再进此态） |
| connected | on | on | 「已连接」绿 | 可显示 lastConnectedAt |
| error | on | on | 「连接失败」红 | 显 errorDetail + **重试按钮 `browser-connector-retry`**（点 → `onToggle(true)` 重试 enable） |

## 视觉基线
- 卡片：`padding 12px`、、`1px var(--color-border)`，与 key-card / skill-item 同基调。
- 状态色点：connected=绿、connecting=黄、disconnected=灰、error=红（用 design token，不硬编码）。
- guide 步骤：有序列表，mono 13px，muted。

## 复用关系
- 组合：（开关）、（spinner/status dot 若需）
- 被组合于：`page-connector`
