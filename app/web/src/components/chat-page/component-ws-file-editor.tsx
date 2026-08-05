/**
 * component-ws-file-editor —— workspace 侧通用文件 editor 挂载层（v0.0.241 改名自 component-ws-md-editor）
 * 参考: specs/ui/components/common/component-modal-md-editor.md（组件契约，view 按 format 分流 + 结构化格式按钮）
 *       specs/prd/version_logs/v0.0.241.md §2-3（11 格式分类 + 格式功能详述）
 *       specs/ui/overall/04-agent-session.md §2.6.7（file 读/存端点契约，零改）
 *
 * 仿 component-academy-modals.tsx 挂载层模式：父级（SectionWorkspacePanel）持 fileEditorTarget
 * state，本组件按 target 是否为空渲染；target 变化 → readWorkspaceFile 取最新内容 →
 * 灌给 ComponentModalMdEditor（透传 format 决定 view 分流 + edit 格式按钮显隐）。
 *
 * 落盘走 saveWorkspaceFile（last-write-wins）；成功 flash「已保存」复用 studio page-studio
 * 自造 toast 范式（useState + setTimeout 2.6s，零第三方依赖，决策#3）。
 * 后端读写端点不限扩展名（通用 UTF-8 + 路径白名单），格式判定是纯前端拦截（v0.0.227 已确立）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileFormat } from '../../lib/file-format';
import { ComponentModalMdEditor } from '../common/component-modal-md-editor';
import { readWorkspaceFile, saveWorkspaceFile } from '../../lib/chat-api';

/** workspace 文件 editor 拦截目标（SectionWorkspacePanel.handleOpen 设置，v0.0.241 加 format） */
export interface WsFileTarget {
  /** 相对 workspaceDir 的路径（save 时原样回传 + subtitle 用） */
  path: string;
  /** basename（如 'notes.md' / 'config.json'），fileName/versionLabel 传值 */
  fileName: string;
  /** 副标题：相对 workspaceDir 路径（PRD §6.1） */
  subtitle: string;
  /** 文件格式（v0.0.241）：决定 modal view 分流 + edit 格式按钮显隐；handleOpen 已确定非空 */
  format: FileFormat;
}

interface Props {
  sessionId: string;
  /** 目标（null = 不渲染） */
  target: WsFileTarget | null;
  onClose: () => void;
}

/** workspace 文件 editor 挂载层：读内容 → 渲染 ComponentModalMdEditor（透传 format）→ 保存落盘 + flash toast */
export function ComponentWsFileEditor({ sessionId, target, onClose }: Props) {
  const { t } = useTranslation('chat');
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // 标记是否已有读请求在飞；避免竞态（target 快速切换时旧请求覆盖新值）
  const reqIdRef = useRef(0);

  // flash toast（复用 studio page-studio.tsx 范式：2.6s 自动消失）
  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  // target 变化 → 每次重新读（PRD §2.3 禁 stale）；用递增 reqId 屏蔽过期响应
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
    readWorkspaceFile(sessionId, { path: target.path })
      .then((res) => {
        if (myId !== reqIdRef.current) return; // 过期响应丢弃
        setContent(res.content);
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

export default ComponentWsFileEditor;
