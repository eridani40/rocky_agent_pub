# section-right-tabs（studio leader/mate/squad chat 右侧区域薄 wrapper）

> 层级: section
> 文件: app/web/src/components/studio-page/section-right-tabs.tsx
> 薄 wrapper：memory/cron 迁悬浮菜单，右侧仅剩工作区
> HTTP：`/session/:id/workspace/*`（workspace）

## 1. 定位 + 设计意图（简化） `SectionRightTabs` 是 studio leader/mate/squad chat 主区右侧的薄 wrapper——只保留外层 `<aside>` wrapper，**无条件**渲染 `<SectionWorkspacePanel>`；后者自带 `ComponentWsTabBar`（唯一 tab bar，仅剩「工作区」单 tab）+ 工作区内容。
原「长期记忆」「定时任务」tab 迁至聊天区右上悬浮菜单弹层；本 wrapper 右侧仅承载 ws-panel 工作区。
| tab | 内容组件 | 数据源 | leader/mate | squad chat 群聊 |
|---|---|---|---|---|
| 工作区 | `SectionWorkspacePanel` 内 file-tree | `/session/:id/workspace/tree` | ✅ | ✅（团队语义） |

## Props
- sessionId: string;                            // leader / mate / squad sessio...
- workspaceSemantic: 'team' | 'personal';       // 工作区语义（仅 AT 断言/UI 提示，不影响渲染）
- renderWidth?: number;                         // 父引擎钳制后的渲染宽（优先于 ws-panel 内部 w...
- dragMaxWidth?: number;                        // 拖宽动态上限（dragDynMax(available,...
- onLayoutChange?: (report: { settingWidth: number; collapsed: boolean }) => void
- onDragModeChange?: (dragging: boolean) => void

## 视觉基线
外层 `<aside>` minimal className：；其余视觉（tab bar / 内容区 / collapsed 态）全由 `SectionWorkspacePanel` 提供（视觉基线见 `component-workspace-panel.md`）。
> wrapper `<aside>` 结构零改动——三栏响应式（外层 scroll 容器 + 内行 minWidth）由 `component-studio-chat-router` 提供（见 §6）；本 wrapper 仅作 prop 透传层。
