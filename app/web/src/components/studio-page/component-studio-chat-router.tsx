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
import { memo } from 'react';
import type { ChatNode } from './chat-node';
import type { MentionAttrs } from '../chat-page/chat-composer-extension';
import { SectionStudioChat } from './section-studio-chat';
import { SectionRightTabs } from './section-right-tabs';
import { SectionPreviewArea } from '../chat-page/section-preview-area';
import { PreviewAreaProvider } from '../chat-page/preview-area-provider';
import { usePreviewArea } from '../chat-page/preview-area-context';
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
 * [v0.0.268] 导出用 memo() 包装（决策② 阻断级联）：page-studio SSE re-render 时 node/prefill
 *   来自 mainView state（SSE 不 setMainView → 引用稳定）+ onBack 已 useCallback → props 全等
 *   → memo 短路不 re-render chat 树（消息区/输入区零 re-render）。内部 useChatChrome 自身订阅
 *   不受影响（memo 只挡父级 re-render 传入，不挡 hook 订阅）。
 *
 * useThreeColLayout 在 early return **前**调用（hooks 规则）；两分支共用同一 hook 实例。
 */
function StudioChatRouterImpl({ node, prefill, onBack }: StudioChatRouterProps) {
  const { chrome, loading } = useChatChrome(node.sessionId);

  // chrome 未到位（loading/error）→ 渲占位（error 时 chrome 恒 null，同走此分支兜底）
  if (loading || !chrome) {
    return (
      // [Task 3 偏离] PreviewAreaProvider 顶层包整行（兄弟节点消费 context；透明容器不改布局）
      <PreviewAreaProvider sessionId={node.sessionId}>
        <StudioChatRow sessionId={node.sessionId} loading />
      </PreviewAreaProvider>
    );
  }

  // workspace 语义：群聊（groupRender）/ leader 单聊 → team；mate 单聊 → personal
  //   对端 member = chrome.members.find(id===memberId)（studio_member 时 memberId 非空）
  const peer = chrome.memberId ? chrome.members.find((m) => m.id === chrome.memberId) : undefined;
  const workspaceSemantic: 'team' | 'personal' =
    chrome.capabilities.groupRender || peer?.role === 'leader' ? 'team' : 'personal';

  return (
    // [Task 3 偏离] PreviewAreaProvider 顶层包整行（兄弟节点消费 context；透明容器不改布局）
    <PreviewAreaProvider sessionId={node.sessionId}>
      <StudioChatRow
        sessionId={node.sessionId}
        workspaceSemantic={workspaceSemantic}
        chrome={chrome}
        prefill={prefill}
        onBack={onBack}
      />
    </PreviewAreaProvider>
  );
}

/**
 * Studio chat 四槽布局行（Provider 内消费 PreviewAreaContext）。
 * [v0.0.329 门模型] 读 context door：chatCollapsed=door==='left' 传引擎；
 *   door==='left' 时 SectionStudioChat 不渲染（chat 宽 0、preview 占满门框）。
 */
function StudioChatRow({ sessionId, loading = false, workspaceSemantic = 'team', chrome, prefill, onBack }: {
  sessionId: string;
  /** loading 占位分支（chrome 未到位） */
  loading?: boolean;
  workspaceSemantic?: 'team' | 'personal';
  chrome?: ReturnType<typeof useChatChrome>['chrome'];
  prefill?: MentionAttrs[] | string;
  onBack?: () => void;
}) {
  // [v0.0.329 门模型] 读 context door（无 Provider/tabs 时缺省 center → 不影响布局）
  const preview = usePreviewArea();
  const door = preview?.door ?? 'center';
  const chatCollapsed = door === 'left';

  // 三栏响应式布局 hook（中+右两槽场景，hasLeft=false；[v0.0.320] previewPresent=true → 4 槽引擎）
  //   hasLeft=false → 引擎 left=null；rightPresent=true 恒为真（studio 右栏无条件挂载）
  //   [v0.0.329] chatCollapsed 透传（door=left → chat 宽 0、preview 吞并门框）
  const threeCol = useThreeColLayout({ hasLeft: false, rightPresent: true, previewPresent: true, chatCollapsed });

  return (
    <div ref={threeCol.containerRef} className="flex-1 min-w-0 min-h-0 overflow-x-auto">
      <div
        className="flex h-full w-full"
        style={{ minWidth: threeCol.rowMinWidth }}
      >
        {loading ? (
          <div className="flex flex-1 items-center justify-center text-[12px] text-muted">
            …
          </div>
        ) : (
          // [view 稳定性] key={sessionId}：任何 chat 节点切换 = remount = fresh state
          // [v0.0.329] door==='left' → chat 槽隐藏（条件不渲染；middleWidth=0 preview 占满门框）
          !chatCollapsed && (
            <SectionStudioChat
              key={sessionId}
              sessionId={sessionId}
              chrome={chrome!}
              prefill={prefill}
              onBack={onBack}
            />
          )
        )}
        {/* [v0.0.320] 预览区（中|preview|right 三槽；SectionStudioChat 后插） */}
        <SectionPreviewArea
          sessionId={sessionId}
          renderWidth={threeCol.previewRenderWidth}
          dragMaxWidth={threeCol.previewDragMaxWidth}
          onLayoutChange={threeCol.reportPreviewPanel}
          onDragModeChange={threeCol.setPreviewDragging}
        />
        <SectionRightTabs
          sessionId={sessionId}
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

/** [v0.0.268] memo 包装：props（node/prefill/onBack）引用稳定 → page-studio SSE re-render 不级联 chat 树 */
export const StudioChatRouter = memo(StudioChatRouterImpl);

export default StudioChatRouter;
