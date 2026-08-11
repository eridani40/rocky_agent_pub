# component-group-chat-toggle（squad 群聊可见性开关 — enableGroupChat）

> 层级: component
> 文件: app/web/src/components/studio-page/component-group-chat-toggle.tsx
> since: v0.0.270
> 模式参考: component-squad-autonomy-toggle.tsx（data-action-key + role=switch + pending + error banner）
> 数据契约: specs/api/overall/11a-squad-endpoints.md §1.3/§1.4（SquadDetail/PatchSquadBody enableGroupChat）
> 技术权威: specs/tech/version_logs/v0.0.270/change_plan.md（ui-autowork GroupChatToggle）+ specs/tech/squad/[P1]data_model.md §1.1

## 职责

squad 群聊可见性开关：开（默认）→ agents 注入 SquadChat（squad_agents_status）+ UI 群聊入口可见；关 → squad_agents_status SquadChat 行不渲染（system prompt + system_reminder 两头无 SquadChat）+ SeatCard 群聊按钮隐藏 + `send_message('squadchat')` 报错（全私聊语义）。**squad 实体/session 恒存在，仅控可见性**。

> **[v0.0.316] 受控化**：从「自管 PATCH + pending/error」改为「受控 + onChange 上报」。不再自管 PATCH（父级 ManageTab 统一 save），toggle 点击仅 `onChange(!enableGroupChat)`。去掉 error banner / pending 态（保存失败由 tab 级统一处理）。

**边界（不做什么）**：
- 只控 `enableGroupChat` 一个布尔（不做群聊解散/路由/历史清理）。
- **纯受控上报**：无本地态、无 async/PATCH 调用（攒入 ManageTab draft → dirty → 统一 save 时合并 PATCH）。

## Props

```ts
interface GroupChatToggleProps {
  /** 当前开关状态（受控：来自 ManageTab draft state） */
  enableGroupChat: boolean;
  /** 切换回调 → ManageTab 更新 draft → 攒入 dirty → 统一 save */
  onChange: (enableGroupChat: boolean) => void;
}
```

## 状态 / 交互

- 无本地态（纯受控）。
- 点击 toggle → `onChange(!enableGroupChat)`（上报父级，不直接 PATCH）。
- `data-action-key="studio.squad.toggle-group-chat"` + `role="switch"` + `aria-checked={on}`。
- 视觉：label（`groupChat.label`）+ switch（on=bg-accent / off=bg-border-strong，滑块 translate-x）+ 状态文案（on/off）+ hint 说明行（关闭影响：注入 + UI 入口 + send_message 门控）。

## 可观测节点

- 无 testid（仿 SquadAutonomyToggle，`data-squad-id` 根节点 + data-action-key 定位）。

## 视觉基线

- 仿 squad-autonomy-toggle 块风格：label（FIELD_LABEL）+ switch（h-5 w-9 rounded-full）+ 状态文案（FIELD_HINT）+ hint（FIELD_HINT）+ error banner（border-danger/40 + bg-danger/5 + text-danger）。

## 复用关系

- **挂载**：`component-manage-tab.tsx`（**[v0.0.292] 从 autowork-tab 迁入**；元信息编辑区后、`SquadDeleteSection` 前；`<GroupChatToggle enableGroupChat={enableGroupChat} onChange={setEnableGroupChat} />`）。
- 数据：ManageTab 持 `enableGroupChat` draft state，攒入 dirty；统一 save 时合并 PATCH（含 name/description/model/effort + enableGroupChat）。
- i18n：`studio:groupChat.*`（label/hint/on/off/errorPrefix，en + zh-CN 同步）。

## 消费方

- `app/web/src/components/studio-page/component-manage-tab.tsx`
