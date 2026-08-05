/**
 * chat-link-handler-context —— chat markdown 链接点击回调 Context（v0.0.253）
 * 参考: specs/tech/version_logs/v0.0.253/change_plan.md 模块 G（Context 透传决策）
 *
 * 独立文件（不与 component-chat-link-viewer.tsx 合并）以断开循环依赖：
 *   primitive-markdown-view → useChatLinkHandler（本文件，纯 TS 无 JSX）
 *   component-chat-link-viewer → 本文件 + ComponentModalMdEditor → primitive-markdown-view
 * 若合在一起，primitive-markdown-view 会被 component-modal-md-editor 间接导入形成环。
 *
 * 无 Provider 返 null（其它消费方如 md-editor viewer / skill 预览 / feishu doc 降级：链接走系统打开）。
 */
import { createContext, useContext } from 'react';
import type { ChatLinkTarget } from '../../lib/link-target';

/** Context value：消费方注入 onLocalViewer 回调 + sessionId（viewer 内部 workspace 读用） */
export interface ChatLinkHandlerContextValue {
  /** 12 格式本地链接点击回调（消费方挂本 viewer） */
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
