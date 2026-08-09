# component-group-chat-toggle（squad 群聊可见性开关 — enableGroupChat）

> 层级: component
> 文件: app/web/src/components/studio-page/component-group-chat-toggle.tsx
> since: v0.0.270
> 模式参考: component-squad-autonomy-toggle.tsx（data-action-key + role=switch + pending + error banner）
> 数据契约: specs/api/overall/11a-squad-endpoints.md §1.3/§1.4（SquadDetail/PatchSquadBody enableGroupChat）
> 技术权威: specs/tech/version_logs/v0.0.270/change_plan.md（ui-autowork GroupChatToggle）+ specs/tech/squad/[P1]data_model.md §1.1

## 职责

squad 群聊可见性开关：开（默认）→ agents 注入 SquadChat（squad_agents_status）+ UI 群聊入口可见；关 → squad_agents_status SquadChat 行不渲染（system prompt + system_reminder 两头无 SquadChat）+ SeatCard 群聊按钮隐藏 + `send_message('squadchat')` 报错（全私聊语义）。**squad 实体/session 恒存在，仅控可见性**。

**边界（不做什么）**：
- 只控 `enableGroupChat` 一个布尔（不做群聊解散/路由/历史清理）。
- **无本地态切换**：PATCH 成功后靠父级 refresh 回灌新值（`enableGroupChat` prop 变化 → 重渲染新态）；失败 → banner + toggle 视觉保持原态（prop 未变）。
- 防 in-flight 双击竞态（pending 期间 disabled）。

## Props

```ts
interface GroupChatToggleProps {
  squadId: string;
  /** 反映 squad.enableGroupChat 当前值（PATCH 成功后父级 refresh → 新值回灌） */
  enableGroupChat: boolean;
  /** 上抛 → PATCH /squad/:id { enableGroupChat } */
  onPatch: (patch: { enableGroupChat: boolean }) => Promise<void>;
}
```

## 状态 / 交互

- `pending: boolean`：in-flight 防双击；`error: string | null`：PATCH 失败 banner。
- 点击 toggle → `onPatch({ enableGroupChat: !enableGroupChat })` → 成功父级 refresh 回灌 / 失败 `error` banner（`e.message` 优先，fallback `groupChat.toggleFail`）。
- `data-action-key="studio.squad.toggle-group-chat"` + `role="switch"` + `aria-checked={on}` + `disabled={pending}`。
- 视觉：label（`groupChat.label`）+ switch（on=bg-accent / off=bg-border-strong，滑块 translate-x）+ 状态文案（on/off）+ hint 说明行（关闭影响：注入 + UI 入口 + send_message 门控）+ error banner（`groupChat.errorPrefix` + 错误信息）。

## 可观测节点

- 无 testid（仿 SquadAutonomyToggle，`data-squad-id` 根节点 + data-action-key 定位）。

## 视觉基线

- 仿 squad-autonomy-toggle 块风格：label（FIELD_LABEL）+ switch（h-5 w-9 rounded-full）+ 状态文案（FIELD_HINT）+ hint（FIELD_HINT）+ error banner（border-danger/40 + bg-danger/5 + text-danger）。

## 复用关系

- **挂载**：`component-manage-tab.tsx`（**[v0.0.292] 从 autowork-tab 迁入**；元信息编辑区后、`SquadDeleteSection` 前；`<GroupChatToggle squadId={detail.id} enableGroupChat={detail.enableGroupChat} onPatch={onSaveMeta} />`）。
- 数据：`onPatch` = autowork-tab 透传的 `onSaveMeta`（PATCH /squad/:id → 父级 setDetail(updated) 回灌）。
- i18n：`studio:groupChat.*`（label/hint/on/off/toggleFail/errorPrefix，en + zh-CN 同步）。
