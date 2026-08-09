/**
 * component-chat-link-viewer —— chat markdown 链接点击的内置 viewer 挂载层（v0.0.253 / v0.0.280 去强制只读）
 * 参考: specs/tech/version_logs/v0.0.253/change_plan.md 模块 G/H
 *       specs/tech/version_logs/v0.0.280/change_plan.md 行 29（去 readOnly + image/.url 分支 + onSave 双源）
 *       specs/ui/components/common/component-modal-md-editor.md（readOnly 可选能力，组件零改动）
 *       specs/prd/version_logs/v0.0.280/prd.md D2/D3（老板铁律：聊天链 ≡ 右侧文件区——可编辑保存）
 *
 * 职责：
 *   1. ComponentChatLinkViewer —— 按 ChatLinkTarget.source 分流取内容：
 *      'workspace' → readWorkspaceFile HTTP；'absolute' → window.rockyShell.readFileText IPC。
 *      reqId 防竞态（范本 ws-file-editor）。
 *   2. 渲染分流（[v0.0.280]）：isImagePath → ComponentWsImageViewer（source 透传）；否则 → ComponentModalMdEditor
 *      （去 readOnly 可编辑 + onSave：workspace→saveWorkspaceFile / absolute→writeFileText）+ 成功 toast「已保存」。
 *   3. ChatLinkHandlerProvider —— Context Provider 便利包装（message-stream 用）。
 *
 * 边界：[v0.0.280] 覆盖 v0.0.253「强制只读」（readOnly 不再传）；保存 last-write-wins + toast（与右侧一致）；
 *   非 Electron absolute 读/写友好错误；不改 ComponentModalMdEditor 组件本身。
 *
 * 注：Context + useChatLinkHandler 在独立文件 chat-link-handler-context.ts（断开 primitive-markdown-view 循环依赖）。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatLinkTarget } from '../../lib/link-target';
import { getFileFormat, isImagePath } from '../../lib/file-format';
import { ComponentModalMdEditor } from '../common/component-modal-md-editor';
import { ComponentWsImageViewer, type WsImageTarget } from './component-ws-image-viewer';
import { readWorkspaceFile, saveWorkspaceFile } from '../../lib/chat-api';
import { ChatLinkHandlerContext, type ChatLinkHandlerContextValue } from './chat-link-handler-context';

interface ViewerProps {
  /** 当前点击的链接 target（null = 不渲染） */
  target: ChatLinkTarget | null;
  /** 当前 session（workspace 相对路径走 HTTP readWorkspaceFile 用） */
  sessionId: string;
  onClose: () => void;
}

/**
 * Chat 链接 viewer 挂载层：按 target.source 分流取内容 → 渲染
 * ComponentModalMdEditor（去 readOnly 可编辑 + onSave 双源）或 ComponentWsImageViewer（image 分支）。
 * - source='workspace' → readWorkspaceFile(sessionId, {path})（HTTP，后端白名单校验）；save → saveWorkspaceFile
 * - source='absolute'  → window.rockyShell.readFileText(path)（Electron IPC；非 Electron → 友好错误）；save → writeFileText
 * 用递增 reqId 屏蔽过期响应（target 快速切换时旧请求覆盖新值，范本 ws-file-editor L48/64）。
 */
export function ComponentChatLinkViewer({ target, sessionId, onClose }: ViewerProps) {
  const { t } = useTranslation('chat');
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  // flash toast（复用 ws-file-editor 范式：2.6s 自动消失）
  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    if (!target) {
      setContent('');
      setError(null);
      setLoading(false);
      return;
    }
    // [v0.0.280] image 分支不需要文本内容（WsImageViewer 内部 readFileBinary，读文本反而对二进制文件
    // 失败 → error pill 挡住 image viewer）。直接清态走渲染分流，对齐右侧 handleOpen（image 直接 onImageViewer）。
    if (isImagePath(target.path)) {
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

  // 保存回调（[v0.0.280] 去强制只读）：workspace → saveWorkspaceFile HTTP；absolute → rockyShell.writeFileText IPC
  // last-write-wins 直接覆盖；失败 throw（组件内 catch 显 saveError，textarea 保留供重试）
  const handleSave = useCallback(
    async (newValue: string) => {
      if (!target) return;
      if (target.source === 'absolute') {
        const api = typeof window !== 'undefined' ? window.rockyShell : undefined;
        if (!api) throw new Error(t('linkViewer.writeFail'));
        const res = await api.writeFileText(target.path, newValue);
        if (!res.ok) {
          const reason = res.reason ?? 'unknown';
          throw new Error(reason === 'not-found' ? t('linkViewer.fileNotFound', { path: target.path }) : t('linkViewer.writeFail'));
        }
      } else {
        await saveWorkspaceFile(sessionId, { path: target.path, content: newValue });
      }
      flash(t('linkViewer.saved'));
    },
    [target, sessionId, t, flash],
  );

  const handleClose = useCallback(() => {
    setContent('');
    setError(null);
    setLoading(false);
    onClose();
  }, [onClose]);

  if (!target) return null;

  // loading / error 态（轻量内联 pill；L3 modal 由 ComponentModalMdEditor / WsImageViewer 接管）
  const statusMsg = loading ? t('workspace.mdEditor.loading') : error;
  if (statusMsg) {
    return (
      <div className="fixed bottom-6 left-1/2 z-[var(--z-modal)] -translate-x-1/2 bg-fg px-4 py-2.5 rounded-lg text-[12.5px] text-surface shadow-xl">
        {statusMsg}
      </div>
    );
  }

  // [v0.0.280] 渲染分流：image 6 格式 → 内置只读 viewer（source 透传）；否则 → 可编辑 editor
  if (isImagePath(target.path)) {
    const imgTarget: WsImageTarget = {
      path: target.path,
      fileName: target.fileName,
      subtitle: target.path,
      source: target.source,
    };
    return (
      <>
        <ComponentWsImageViewer sessionId={sessionId} target={imgTarget} onClose={handleClose} />
        {toast && (
          <div className="fixed bottom-6 left-1/2 z-[300] -translate-x-1/2">
            <div className="flex items-center gap-2 rounded-lg bg-fg px-4 py-2.5 text-[12.5px] text-surface shadow-xl">{toast}</div>
          </div>
        )}
      </>
    );
  }

  // getFileFormat 返 null（如 .url 降级 txt 场景）走 'txt' 兜底（对齐右侧 .url 降级 txt plain 语义）
  const fmt = getFileFormat(target.path) ?? 'txt';

  return (
    <>
      <ComponentModalMdEditor
        open
        fileName={target.fileName}
        subtitle={target.path}
        initialValue={content}
        versionLabel={target.fileName}
        format={fmt}
        filePath={target.path}
        sessionId={sessionId}
        onSave={handleSave}
        onClose={handleClose}
      />
      {/* toast（保存成功最小可见反馈） */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-[300] -translate-x-1/2">
          <div className="flex items-center gap-2 rounded-lg bg-fg px-4 py-2.5 text-[12.5px] text-surface shadow-xl">{toast}</div>
        </div>
      )}
    </>
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
