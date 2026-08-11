/**
 * component-ws-file-editor-fallback —— workspace 文件 editor 降级弹层（v0.0.320 Task 3 偏离，leader 已确认）
 * 参考: specs/ui/components/common/component-modal-md-editor.md（组件契约，view 按 format 分流 + 结构化格式按钮）
 *       specs/tech/version_logs/v0.0.320/change_plan.md D7（无 Provider 降级弹层）/ D13（弹层退役）
 *
 * [Task 3 偏离背景] D13 删除 component-ws-file-editor.tsx（弹层退役），但 D7 要求「无 Provider 降级弹层」
 * （academy section-version-chat L159 用 SectionWorkspacePanel 无预览区 Provider）。
 * 本文件为降级路径的独立挂载层：逻辑 1:1 复用原 ws-file-editor（readWorkspaceFile + ComponentModalMdEditor +
 * last-write-wins 保存 + flash toast），仅改文件名/注释——仅无 Provider 场景渲染，避免死代码 + 保留 academy 降级。
 *
 * component-modal-md-editor（common/）**保留**（D13 MUST NOT 删）：academy skill-browser / academy-modals 仍用。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileFormat } from '../../lib/file-format';
import { looksBinary } from '../../lib/file-format';
import { ComponentModalMdEditor } from '../common/component-modal-md-editor';
import { readWorkspaceFile, saveWorkspaceFile } from '../../lib/chat-api';

/** workspace 文件 editor 拦截目标（SectionWorkspacePanel.handleOpen 降级路径设置） */
export interface WsFileTarget {
  /** 相对 workspaceDir 的路径（save 时原样回传 + subtitle 用） */
  path: string;
  /** basename（如 'notes.md' / 'config.json'），fileName/versionLabel 传值 */
  fileName: string;
  /** 副标题：相对 workspaceDir 路径 */
  subtitle: string;
  /** 文件格式：决定 modal view 分流 + edit 格式按钮显隐；handleOpen 已确定非空 */
  format: FileFormat;
}

interface Props {
  sessionId: string;
  /** 目标（null = 不渲染） */
  target: WsFileTarget | null;
  onClose: () => void;
}

/** workspace 文件 editor 降级挂载层：读内容 → 渲染 ComponentModalMdEditor（透传 format）→ 保存落盘 + flash toast */
export function ComponentWsFileEditorFallback({ sessionId, target, onClose }: Props) {
  const { t } = useTranslation('chat');
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // 二进制检测（读内容后 looksBinary；true → 占位 pill 不渲染 editor modal）
  const [binary, setBinary] = useState(false);
  // 标记是否已有读请求在飞；避免竞态（target 快速切换时旧请求覆盖新值）
  const reqIdRef = useRef(0);

  // flash toast（复用 studio page-studio.tsx 范式：2.6s 自动消失）
  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  // target 变化 → 每次重新读（禁 stale）；用递增 reqId 屏蔽过期响应
  useEffect(() => {
    if (!target) {
      setContent('');
      setError(null);
      setLoading(false);
      setBinary(false);
      return;
    }
    const myId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    readWorkspaceFile(sessionId, { path: target.path })
      .then((res) => {
        if (myId !== reqIdRef.current) return; // 过期响应丢弃
        setContent(res.content);
        setBinary(looksBinary(res.content));
        setLoading(false);
      })
      .catch((e) => {
        if (myId !== reqIdRef.current) return;
        setError(e instanceof Error ? e.message : t('workspace.mdEditor.loadFail'));
        setLoading(false);
      });
  }, [sessionId, target, t]);

  // 保存回调：last-write-wins 直接覆盖；失败 throw（组件内 catch 显 saveError，textarea 保留供重试）
  const handleSave = useCallback(
    async (newValue: string) => {
      if (!target) return;
      await saveWorkspaceFile(sessionId, { path: target.path, content: newValue });
      flash(t('workspace.mdEditor.saved'));
    },
    [sessionId, target, flash, t],
  );

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

  // 二进制降级：内容含 NUL/替换符 → 占位 pill（复用 statusMsg pill 范式），不渲染 editor modal
  if (binary) {
    return (
      <div className="fixed bottom-6 left-1/2 z-[var(--z-modal)] -translate-x-1/2 bg-fg px-4 py-2.5 rounded-lg text-[12.5px] text-surface shadow-xl">
        {t('workspace.mdEditor.binaryUnsupported')}
      </div>
    );
  }

  return (
    <>
      <ComponentModalMdEditor
        open
        fileName={target.fileName}
        subtitle={target.subtitle}
        initialValue={content}
        versionLabel={target.fileName}
        hint={t('workspace.mdEditor.hint')}
        format={target.format}
        filePath={target.path}
        sessionId={sessionId}
        onSave={handleSave}
        onClose={onClose}
      />
      {/* toast（保存成功最小可见反馈） */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-[300] -translate-x-1/2">
          <div className="flex items-center gap-2 rounded-lg bg-fg px-4 py-2.5 text-[12.5px] text-surface shadow-xl">
            {toast}
          </div>
        </div>
      )}
    </>
  );
}

export default ComponentWsFileEditorFallback;
