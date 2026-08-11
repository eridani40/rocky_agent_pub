/**
 * preview-area-provider —— 预览区 Provider 上移层（v0.0.320 Task 3 偏离，leader 已确认）
 * 参考: specs/tech/version_logs/v0.0.320/change_plan.md D3/D7/D12（Provider 契约）
 *
 * [Task 3 偏离背景] 原 D3 将 PreviewAreaContext.Provider 挂在 SectionPreviewArea 容器内，
 * 但 D7/D12 消费方（SectionWorkspacePanel / ComponentMessageStream）是 SectionPreviewArea 的
 * **兄弟节点**——React Context 只能向下传，兄弟节点 usePreviewArea() 永远返 null。
 * 本组件把 usePreviewTabs + Provider 提升到 page-chat / studio-chat-router 顶层（包整行），
 * 消费方（workspace-panel / message-stream）与容器（section-preview-area）都从 context 取。
 *
 * 渲染：纯 Context Provider，**不渲染任何 DOM**（children 原样透传，不改父级 flex 布局）。
 * 职责：usePreviewTabs 状态机实例化 + 组装 PreviewAreaContextValue + Provider 包裹。
 */
import type { ReactNode } from 'react';
import { usePreviewTabs } from './use-preview-tabs';
import { PreviewAreaContext } from './preview-area-context';

interface PreviewAreaProviderProps {
  /** 当前 session（workspace 源 HTTP 读写用；tab id 前缀也用） */
  sessionId: string;
  /** 子节点（整个三栏/四栏 flex 行，透明包裹） */
  children: ReactNode;
}

/**
 * 预览区 Context Provider（透明容器，不渲染 DOM）。
 * 内部 usePreviewTabs 单例：tabs 状态机生命周期与 page-chat / studio-chat-router 对齐
 * （sessionId 变化 → 状态机重建？——usePreviewTabs 以 sessionId 为参数，openTab 内部
 * readFileContent 用 sessionId；切 session 时 Provider 重挂载语义由 key 驱动，同 Task 2 挂载点）。
 */
export function PreviewAreaProvider({ sessionId, children }: PreviewAreaProviderProps) {
  const {
    tabs,
    activeTabId,
    dirtyPending,
    conflictPending,
    collapsed,
    setCollapsed,
    door,
    setDoor,
    openTab,
    closeTab,
    activateTab,
    saveTab,
    resolveDirty,
    resolveConflict,
    setDraft,
    setMode,
    retryLoad,
  } = usePreviewTabs({ sessionId });

  return (
    <PreviewAreaContext.Provider
      value={{
        openTab,
        closeTab,
        activateTab,
        tabs,
        activeTabId,
        sessionId,
        dirtyPending,
        conflictPending,
        collapsed,
        setCollapsed,
        door,
        setDoor,
        saveTab,
        resolveDirty,
        resolveConflict,
        setDraft,
        setMode,
        retryLoad,
      }}
    >
      {children}
    </PreviewAreaContext.Provider>
  );
}

export default PreviewAreaProvider;
