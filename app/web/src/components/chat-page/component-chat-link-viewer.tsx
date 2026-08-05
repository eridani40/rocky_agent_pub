/**
 * component-chat-link-viewer —— chat markdown 链接点击的内置 viewer 挂载层（v0.0.253）
 * 参考: specs/tech/version_logs/v0.0.253/change_plan.md 模块 G/H
 *       specs/ui/components/common/component-modal-md-editor.md（readOnly 能力，复用）
 *       specs/prd/version_logs/v0.0.253.md §3.3（强制只读 + 内容源分流）
 *
 * 职责：
 *   1. ComponentChatLinkViewer —— 挂 ComponentModalMdEditor（readOnly=true 强制）；
 *      按 ChatLinkTarget.source 分流取内容：'workspace' → readWorkspaceFile HTTP；
 *      'absolute' → window.rockyShell.readFileText IPC。reqId 防竞态（范本 ws-file-editor）。
 *   2. ChatLinkHandlerProvider —— Context Provider 便利包装（message-stream 用）。
 *
 * 边界：v1 强制只读（无 mode-toggle/保存按钮）；不实现写回链路（PRD §2.2）。
 *
 * 注：Context + useChatLinkHandler 在独立文件 chat-link-handler-context.ts（断开 primitive-markdown-view 循环依赖）。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatLinkTarget } from '../../lib/link-target';
import { getFileFormat } from '../../lib/file-format';
import { ComponentModalMdEditor } from '../common/component-modal-md-editor';
import { readWorkspaceFile } from '../../lib/chat-api';
import { ChatLinkHandlerContext, type ChatLinkHandlerContextValue } from './chat-link-handler-context';

interface ViewerProps {
  /** 当前点击的链接 target（null = 不渲染） */
  target: ChatLinkTarget | null;
  /** 当前 session（workspace 相对路径走 HTTP readWorkspaceFile 用） */
  sessionId: string;
  onClose: () => void;
}

/**
 * Chat 链接 viewer 挂载层：按 target.source 分流取内容 → 渲染 ComponentModalMdEditor（readOnly=true）。
 * - source='workspace' → readWorkspaceFile(sessionId, {path})（HTTP，后端白名单校验）
 * - source='absolute'  → window.rockyShell.readFileText(path)（Electron IPC；非 Electron → 友好错误）
 * 用递增 reqId 屏蔽过期响应（target 快速切换时旧请求覆盖新值，范本 ws-file-editor L48/64）。
 */
export function ComponentChatLinkViewer({ target, sessionId, onClose }: ViewerProps) {
  const { t } = useTranslation('chat');
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (!target) {
      setContent('');
      setError(null);
      setLoading(false);
      return;
    }
    const myId = ++reqIdRef.current;
    setLoading(true);
    setError(null);

    const isAbsolute = target.source === 'absolute';
    if (!isAbsolute) {
      // workspace 相对路径 → HTTP readWorkspaceFile（后端 whitelistResolve 校验）
      readWorkspaceFile(sessionId, { path: target.path })
        .then((res) => {
          if (myId !== reqIdRef.current) return;
          setContent(res.content);
          setLoading(false);
        })
        .catch((e) => {
          if (myId !== reqIdRef.current) return;
          setError(e instanceof Error ? e.message : t('linkViewer.loadFail'));
          setLoading(false);
        });
      return;
    }

    // absolute → Electron IPC readFileText；非 Electron → 友好错误
    const api = typeof window !== 'undefined' ? window.rockyShell : undefined;
    if (!api) {
      setError(t('linkViewer.loadFail'));
      setLoading(false);
      return;
    }
    api
      .readFileText(target.path)
      .then((res) => {
        if (myId !== reqIdRef.current) return;
        if (res.ok && typeof res.content === 'string') {
          setContent(res.content);
          setLoading(false);
        } else {
          const reason = res.reason ?? 'unknown';
          setError(
            reason === 'not-found'
              ? t('linkViewer.fileNotFound', { path: target.path })
              : t('linkViewer.loadFail'),
          );
          setLoading(false);
        }
      })
      .catch(() => {
        if (myId !== reqIdRef.current) return;
        setError(t('linkViewer.loadFail'));
        setLoading(false);
      });
  }, [target, sessionId, t]);

  const handleClose = useCallback(() => {
    setContent('');
    setError(null);
    setLoading(false);
    onClose();
  }, [onClose]);

  if (!target) return null;

  // loading / error 态（轻量内联 pill；L3 modal 由 ComponentModalMdEditor 接管）
  const statusMsg = loading ? t('workspace.mdEditor.loading') : error;
  if (statusMsg) {
    return (
      <div className="fixed bottom-6 left-1/2 z-[var(--z-modal)] -translate-x-1/2 bg-fg px-4 py-2.5 rounded-lg text-[12.5px] text-surface shadow-xl">
        {statusMsg}
      </div>
    );
  }

  // getFileFormat 返 null 走 'md' 兜底（classify 已过滤非 12 格式进 onLocalViewer）
  const fmt = getFileFormat(target.path) ?? 'md';

  return (
    <ComponentModalMdEditor
      open
      fileName={target.fileName}
      subtitle={target.path}
      initialValue={content}
      versionLabel={target.fileName}
      format={fmt}
      readOnly
      onClose={handleClose}
    />
  );
}

interface ProviderProps {
  value: ChatLinkHandlerContextValue;
  children: ReactNode;
}

/** 便利包装：包 ChatLinkHandlerContext.Provider（message-stream 用） */
export function ChatLinkHandlerProvider({ value, children }: ProviderProps) {
  return <ChatLinkHandlerContext.Provider value={value}>{children}</ChatLinkHandlerContext.Provider>;
}

export default ComponentChatLinkViewer;
