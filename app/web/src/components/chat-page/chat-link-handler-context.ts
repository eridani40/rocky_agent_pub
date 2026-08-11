/**
 * chat-link-handler-context —— chat markdown 链接点击回调 Context（v0.0.253 / v0.0.320 D12）
 * 参考: specs/tech/version_logs/v0.0.253/change_plan.md 模块 G（Context 透传决策）
 *       specs/tech/version_logs/v0.0.320/change_plan.md D12（chat-link 迁移：复用预览区，弹层退役）
 *
 * 独立文件（不与 component-chat-link-viewer.tsx 合并）以断开循环依赖：
 *   primitive-markdown-view → useChatLinkHandler（本文件，纯 TS 无 JSX）
 *   消费方（message-stream）→ 本文件 + ComponentModalMdEditor → primitive-markdown-view
 * 若合在一起，primitive-markdown-view 会被 component-modal-md-editor 间接导入形成环。
 * [v0.0.320 D12] ChatLinkHandlerProvider 从 component-chat-link-viewer.tsx 迁移至此（该弹层退役）；
 *   本文件仍只依赖 react + Context，不 import 任何视图组件 → 环不成立。
 *
 * 无 Provider 返 null（其它消费方如 md-editor viewer / skill 预览 / feishu doc 降级：链接走系统打开）。
 */
import { createContext, createElement, useContext, type ReactNode } from 'react';
import type { ChatLinkTarget } from '../../lib/link-target';

/** Context value：消费方注入 onLocalViewer 回调 + sessionId（viewer 内部 workspace 读用） */
export interface ChatLinkHandlerContextValue {
  /** 12 格式本地链接点击回调（消费方注入：有预览区 Provider → preview.openTab；无 → 降级弹层/系统打开） */
  onLocalViewer: (target: ChatLinkTarget) => void;
  /** 当前 session（workspace 相对路径走 HTTP readWorkspaceFile 用） */
  sessionId: string;
}

/** 默认 null：无 Provider 时 useChatLinkHandler 返 null（其它消费方降级） */
export const ChatLinkHandlerContext = createContext<ChatLinkHandlerContextValue | null>(null);

/**
 * 取 chat 链接处理回调。primitive-markdown-view `<a>` onClick 经本 hook 拿 onLocalViewer。
 * 无 Provider（如 md-editor viewer / skill 预览 / feishu doc）返 null → 链接走默认 web/local 系统打开。
 */
export function useChatLinkHandler(): ChatLinkHandlerContextValue | null {
  return useContext(ChatLinkHandlerContext);
}

interface ChatLinkHandlerProviderProps {
  value: ChatLinkHandlerContextValue;
  children: ReactNode;
}

/** 便利包装：包 ChatLinkHandlerContext.Provider（message-stream 用；[v0.0.320 D12] 自 component-chat-link-viewer 迁移）。
 *  本文件为纯 TS（无 JSX），用 createElement 而非 JSX 语法（primitive-markdown-view 依赖本文件，保持 .ts 扩展断开循环）。 */
export function ChatLinkHandlerProvider({ value, children }: ChatLinkHandlerProviderProps) {
  return createElement(ChatLinkHandlerContext.Provider, { value }, children);
}
