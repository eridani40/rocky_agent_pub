# section-version-chat（学生版本会话页 — 复用 playground-rocky）

> 层级: section（薄壳，内嵌 chat-page 复用）
> 文件: app/web/src/components/academy-page/section-version-chat.tsx

## 职责
基于学生某个正式版本工作区发起的 academy-student session 会话页。**完全复用 playground-rocky 设计**（design §8.3）：conv-panel + chat-col + 右 ws-panel + chat 右上悬浮菜单（memory/cron/skills）。

边界：不重新定义任何 chat 组件（chat 内核全部来自 chat-page）；不自定义右面板（旧 academy 右栏已废，design §8.3 明确去掉）。

## Props
```ts
interface Props {
  versionId: string;
  sessionId?: string; // 已有会话 id；缺省则新建
  onBack: () => void;
}
```

## 状态 / 交互
- **conv-panel**（左，可拖宽：默认 240 / min 180 / max 400，对齐 chat conv-panel 常量口径；右缘复用 `chat-page/component-col-resize-handle`（side='left'）拖拽，宽度经 `common/use-persistent-width` + `ACADEMY_COL.versionConv` 常量持久化 localStorage 全局 key `academy-version-conv-width`）：conv-head（学生名 + 「+」新建会话按钮）+ conv-list（该版本下的会话列表，13px/500 title + 11px muted time，active `bg-accent-light`）。
- **chat-col**（中 flex-1，relative；**高度链**：包装层为水平 flex + `min-h-0 overflow-hidden`，禁 flex-col 垫层，见 `_overview §2 宿主高度链约束`）：
  - **chat-topbar**：会话标题 13.5px/600 + `academy-student` tag + 右 `usage-chip`（mono「39k/300k」）+ 「压缩上下文 (Compact)」ghost sm 按钮 + 「清空会话 (Clear)」ghost sm 按钮。
  - **float-menu**（chat 右上 absolute 纵排，复用 `component-chat-float-menu`）：🧠 长期记忆 / ⏰ 定时任务 / ✨ skills（与 playground 完全同款）。
  - **chat-msgs**（复用 `ComponentMessageStream`，max-w 72%）。
  - **chat-input**（textarea + ➤）。
  - **placeholder**：「继续和 {学生名} vX 对话…」。
- **ws-panel**（300px，右）：ws-head「工作区」+ 关闭按钮 + ws-scroll（按目录分组 label：版本 vX 目录 / `.rocky/skills/` / `.rocky/memory/`，文件行 icon + 名 + 可选 mono provider）。
- **可见文案**（E2E）：学生名 / 会话标题 / 「academy-student」tag / 「N/300k」usage / 「压缩上下文 (Compact)」「清空会话 (Clear)」/ float-menu tooltip 「长期记忆」「定时任务」「skills」/ placeholder / 目录 label / 文件名（AGENTS.md / version.json / 技能名 / 记忆 .md 名）。

## 复用关系（MANDATORY — design §8.1 + §8.3）
- **chat 列 = `chat-page/section-chat-session.tsx`**（统一装配层，能力全开）：消息流 / 输入区 / usage 三件套（含 summaryTask）/ minimap / 右缘 overlay / 悬浮菜单（memory/cron/skills 弹层）全部内置——**本 section 不再自挂 useUsage/useSummary/useFlattenedView，也不经 `onMessagesChange` 回收 messages 建 minimap**（防双 useMessages 双订阅）。
- 另组合：
  - `chat-page/section-conversation-list.tsx`（conv-panel）
  - `chat-page/component-workspace-panel.tsx`（ws-panel）
- academy 侧仅提供：route 参数（versionId + sessionId）+ biz=`academy` 过滤 + topbarLeft（`component-academy-chat-header`）+ placeholder + workspaceDir 指向该版本目录 + session-kind=`academy-student` 标识。
- **视觉 / SSE 链路 / run 态 / IME 守卫 / 消息合并规则 / part key 原则** 全部沿用 playground，**不发明新结构**。

## 视觉基线
- 设计稿来源：`demo/10-version-chat.html`（design §8.3 注：复用 playground，demo 是示意）。
- 详细视觉规则归 `specs/ui/components/chat-page/` 各组件 spec（conv-item / msg bubble / float-btn / ws-file 等）。
- 唯一 academy 侧差异：tag 显示「academy-student」（demo 拼写「acadamy-student」是 demo 笔误，正式实现用 `academy` 拼写）。
