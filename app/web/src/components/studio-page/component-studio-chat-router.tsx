/**
 * component-studio-chat-router —— Studio chat 节点渲染路由（chrome 一次拉 + workspaceSemantic 派生）
 * 参考: specs/ui/components/studio-page/section-studio-chat.md（薄壳契约）
 *       specs/ui/components/chat-page/section-chat-session.md（会话能力权威）
 *       specs/ui/components/studio-page/section-right-tabs.md（右侧 tab 区域）
 *       specs/tech/app/frontend/[P0]chat_session_assembly.md §2.6（chrome 注入防双拉）
 *
 * 职责：调 useChatChrome(node.sessionId) 一次拉 chrome：
 *   - 派生 workspaceSemantic：群聊（capabilities.groupRender）或对端 member.role==='leader' → 'team'；
 *     mate 单聊 → 'personal'（对端 = chrome.members.find(id===chrome.memberId)）
 *   - chrome 经 prop 下传 SectionStudioChat → SectionChatSession（防双拉；chrome 是
 *     useLifecycle ctx state 对象 = 稳定引用，不会触发内层 useChatChrome 反复 re-init）
 *   在 chat 主区右侧并排挂 <SectionRightTabs/>（仅工作区单栏；记忆/定时任务在右上悬浮菜单）。
 *
 * `onBack` 存在即透传 → chat page 常驻返回键（缺省则不渲染返回键）。
 *
 * 三栏响应式布局（与 playground page-chat 同套）：
 *   - useThreeColLayout({hasLeft:false, rightPresent:true})——studio 布局上下文 = 中+右两槽
 *     （引擎 left=null，因 StudioSidebar 224 shrink-0 是 router 容器外兄弟固定不参与降级，裁决 P3）
 *   - 两分支（loading + 正常）根 = 外层 scroll 容器（flex-1 min-w-0 min-h-0 overflow-x-auto
 *     挂 containerRef）+ 内行 flex h-full w-full minWidth=rowMinWidth；min-w-0 让 flex child 可缩至
 *     内容内禀宽以下（缺它侧栏被 ws-panel content 撑开，无法横滚兜底）
 *   - hook 必须在 early return 前调用（React hooks 规则）；chatPage key={node.sessionId} remount 语义零改
 *
 * 边界：纯渲染路由；会话能力/身份 header 归 SectionStudioChat 薄壳。
 */
import type { ChatNode } from './chat-node';
import type { MentionAttrs } from '../chat-page/chat-composer-extension';
import { SectionStudioChat } from './section-studio-chat';
import { SectionRightTabs } from './section-right-tabs';
import { useChatChrome } from '../chat-page/use-chat-chrome';
// 三栏响应式布局 hook（chat-page 共用）
import { useThreeColLayout } from '../chat-page/use-three-col-layout';

interface StudioChatRouterProps {
  node: ChatNode;
  /**
   * 初始内容预填（mention pill 数组 / 纯文本字符串）。
   * 业务全景「更多」tab 引导按钮 → 父侧切 leader 单聊 + prefill 文本（模板填空）。
   * 透传给 SectionStudioChat；缺省不影响渲染。
   */
  prefill?: MentionAttrs[] | string;
  /** 返回坐席面板回调（挂到 chat-topbar 返回按钮 onClick；缺省 → 不渲染返回键） */
  onBack?: () => void;
}

/**
 * chrome 一次拉 → 派生 workspaceSemantic + 渲 SectionStudioChat 薄壳 + 右侧 SectionRightTabs。
 *   loading 期间渲占位（与 SectionChatSession 内部 chrome loading 占位一致语义）。
 *   key={node.sessionId} 保留——chat 视图按 sessionId 加 key，任何 chat 节点切换 = remount = fresh state，
 *   消除「同类型不同 session 复用实例」导致 useMessages 走 deps 变化 race 而非全新 init。
 *
 * useThreeColLayout 在 early return **前**调用（hooks 规则）；两分支共用同一 hook 实例。
 */
export function StudioChatRouter({ node, prefill, onBack }: StudioChatRouterProps) {
  const { chrome, loading } = useChatChrome(node.sessionId);
  // 三栏响应式布局 hook（中+右两槽场景，hasLeft=false）
  //   hasLeft=false → 引擎 left=null；rightPresent=true 恒为真（studio 右栏无条件挂载）
  //   **必须在 early return 前调用**（React hooks 规则：hook 调用顺序不可依赖条件分支）
  const threeCol = useThreeColLayout({ hasLeft: false, rightPresent: true });

  // chrome 未到位（loading/error）→ 渲占位（error 时 chrome 恒 null，同走此分支兜底）
  if (loading || !chrome) {
    return (
      // 外层 scroll 容器（overflow-x-auto 横滚兜底，min-w-0 让侧栏可缩）；挂 containerRef；内行 minWidth=引擎算的 minRowWidth
      <div ref={threeCol.containerRef} className="flex-1 min-w-0 min-h-0 overflow-x-auto">
        <div
          className="flex h-full w-full"
          style={{ minWidth: threeCol.rowMinWidth }}
        >
          <div className="flex flex-1 items-center justify-center text-[12px] text-muted">
            …
          </div>
          <SectionRightTabs
            sessionId={node.sessionId}
            workspaceSemantic="team"
            renderWidth={threeCol.rightRenderWidth}
            dragMaxWidth={threeCol.rightDragMaxWidth}
            onLayoutChange={threeCol.reportRightPanel}
            onDragModeChange={(d) => threeCol.setDragging(d ? 'right' : null)}
          />
        </div>
      </div>
    );
  }

  // workspace 语义：群聊（groupRender）/ leader 单聊 → team；mate 单聊 → personal
  //   对端 member = chrome.members.find(id===memberId)（studio_member 时 memberId 非空）
  const peer = chrome.memberId ? chrome.members.find((m) => m.id === chrome.memberId) : undefined;
  const workspaceSemantic: 'team' | 'personal' =
    chrome.capabilities.groupRender || peer?.role === 'leader' ? 'team' : 'personal';

  return (
    // 外层 scroll 容器（overflow-x-auto 横滚兜底，min-w-0 让侧栏可缩）；挂 containerRef；内行 minWidth=引擎算的 minRowWidth
    <div ref={threeCol.containerRef} className="flex-1 min-w-0 min-h-0 overflow-x-auto">
      <div
        className="flex h-full w-full"
        style={{ minWidth: threeCol.rowMinWidth }}
      >
        {/* [view 稳定性] key={node.sessionId}：任何 chat 节点切换 = remount = fresh state */}
        <SectionStudioChat
          key={node.sessionId}
          sessionId={node.sessionId}
          chrome={chrome}
          prefill={prefill}
          onBack={onBack}
        />
        <SectionRightTabs
          sessionId={node.sessionId}
          workspaceSemantic={workspaceSemantic}
          renderWidth={threeCol.rightRenderWidth}
          dragMaxWidth={threeCol.rightDragMaxWidth}
          onLayoutChange={threeCol.reportRightPanel}
          onDragModeChange={(d) => threeCol.setDragging(d ? 'right' : null)}
        />
      </div>
    </div>
  );
}

export default StudioChatRouter;
