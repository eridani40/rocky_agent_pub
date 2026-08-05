/**
 * chat-node —— studio 内部 chat 节点导航契约类型（page-studio ↔ chat 路由 ↔ 坐席入口/团队入口共享）
 * 参考: specs/ui/overall/06-studio.md §5（Chat 单聊/群聊入口）
 *       specs/ui/components/studio-page/component-seats-panel.md（坐席卡 onEnter 组装 ChatNode）
 *
 * 历史来源：v0.0.168 前定义在 `component-squad-tree.tsx`（sidebar 手风琴树旧入口）；本版侧栏树已删，
 *   类型独立为 chat-node.ts，被 page-studio / SeatsPanel / SeatsBody / StudioChatRouter / use-board-at-mention 共用。
 *   保持 shape 不变，纯物理迁移。
 *
 * 语义：
 *   - sessionId：目标 chat session id（squadChat / leader / mate）
 *   - title：chat topbar 主标题（member.name 或 群聊 tag）
 *   - tag：chat topbar 副标签（如「Alpha 小队 · 单聊」）
 *   - squadId：所属 squad id（点击导航时 page-studio 据此切 squad + reload detail）
 */
export interface ChatNode {
  sessionId: string;
  title: string;
  tag: string;
  squadId: string;
}
