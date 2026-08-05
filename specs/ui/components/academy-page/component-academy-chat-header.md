# component-academy-chat-header（academy 会话身份 header）

> 层级: component
> 文件: app/web/src/components/academy-page/component-academy-chat-header.tsx
> since: v0.0.216 · 自旧 academy chat 列的 topbarLeft 段抽出（视觉零变化）

## 职责

academy 四个 chat 消费方（班主任 / 教练 / 学生版本会话 / subagent 只读）注入
`SectionChatSession` 的 `topbarLeft` render-prop 时共用的**纯展示身份 header**：
渐变 avatar 字 + 标题 + 可选状态行 + 可选右侧 mono tag。不挂任何 hook / 数据请求。

markup 与旧 `component-academy-chat-col.tsx` 的 topbarLeft 段逐行等价
（AVATAR_BASE 圆形 avatar + 13px 标题 + ml-auto tag），视觉零变化。

## Props

```ts
interface AcademyChatHeaderProps {
  /** avatar 单字（'班' / '教' / 学生首字 / 'S'） */
  avatarText: string;
  /** avatar 背景渐变；缺省 var(--brand-grad) */
  avatarBg?: string;
  title: string;
  /** 状态行（如「● 在线」sage）；缺省不渲 */
  statusLine?: ReactNode;
  /** 右侧 mono tag（如 'academy-coach'）；缺省不渲 */
  tag?: string;
}
```

## 可观测节点

无交互元素，纯展示；标题/tag 文本可被 E2E 文本断言（无独立 testid，随宿主 topbar）。

## 复用关系

- 消费方：section-classroom-detail（班）/ section-training-observe（教）/
  section-version-chat（学生首字）/ component-session-readonly（S）。
- 依赖：`academy-styles.AVATAR_BASE`。
