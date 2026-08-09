/**
 * component-ws-image-viewer —— workspace 图片只读查看器（v0.0.269 / v0.0.280 加 source）
 * 参考: specs/ui/components/chat-page/component-ws-image-viewer.md（T3 同步）
 *       specs/prd/version_logs/v0.0.269.file_dispatch_nav_status/prd.md §3.2/UC-1/2
 *       specs/tech/version_logs/v0.0.280/change_plan.md 行 30（source 分流）
 *
 * L3 modal（Portal + modal shell + 遮罩/Esc 关闭）：打开时读 base64 →
 * `data:image/{ext};base64,` → <img>（max-w/max-h 适配弹层保持纵横比）。只读——
 * 无编辑/保存/格式化/校验按钮（图片不可文本编辑，svg 防误编辑）。
 * 加载失败 → 轻量错误提示（非乱码/占位 pill）。
 *
 * [v0.0.280] source prop 缺省 'workspace'：workspace → readWorkspaceFileBinary（HTTP）；
 *   absolute → rockyShell.readFileBinary（Electron IPC，base64 同形态）。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Portal } from '../../lib/portal';
import { readWorkspaceFileBinary } from '../../lib/chat-api';
import { ICON_BTN } from '../academy-page/academy-styles';

/** image viewer 目标（handleOpen isImagePath 命中时设置，关闭置空） */
export interface WsImageTarget {
  /** 相对 workspaceDir 的路径（读取 + subtitle 用） */
  path: string;
  /** basename（如 'logo.png'），标题用 */
  fileName: string;
  /** 副标题：相对 workspaceDir 路径 */
  subtitle: string;
  /** [v0.0.280] 路径来源：缺省 workspace（HTTP readWorkspaceFileBinary）；absolute → IPC readFileBinary */
  source?: 'workspace' | 'absolute';
}

interface Props {
  sessionId: string;
  /** 目标（null = 不渲染） */
  target: WsImageTarget | null;
  onClose: () => void;
}

/** 扩展名 → media type（6 格式白名单闭合；兜底 octet-stream 防御） */
function mediaTypeFromPath(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  };
  return map[ext] ?? 'application/octet-stream';
}

/**
 * workspace 图片只读查看器。target 非空渲染 L3 modal；打开时读 base64 →
 * data URL → <img> 渲染；失败显示轻量错误。只读（无编辑/保存/格式化按钮）。
 */
export function ComponentWsImageViewer({ sessionId, target, onClose }: Props) {
  const { t } = useTranslation('chat');
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 打开 target（path 变化）→ 读二进制 → data URL；失败 → error（cancelled 防卸载后 setState）
  // [v0.0.280] source 分流：缺省 workspace → readWorkspaceFileBinary（HTTP）；absolute → rockyShell.readFileBinary（IPC，base64 同形态）
  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setDataUrl(null);
    setError(null);
    const load = async () => {
      if (target.source === 'absolute') {
        const api = typeof window !== 'undefined' ? window.rockyShell : undefined;
        if (!api) throw new Error('no rockyShell');
        const res = await api.readFileBinary(target.path);
        if (!res.ok || typeof res.content !== 'string') {
          throw new Error(res.reason ?? 'readFileBinary failed');
        }
        return res.content;
      }
      const r = await readWorkspaceFileBinary(sessionId, { path: target.path });
      return r.content;
    };
    load()
      .then((base64) => {
        if (cancelled) return;
        setDataUrl(`data:${mediaTypeFromPath(target.path)};base64,${base64}`);
      })
      .catch((e) => {
        console.warn('read image binary failed:', e);
        if (!cancelled) setError(t('workspace.wsImageViewer.loadFail'));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, target, t]);

  // Esc 关闭（L3 modal 统一）
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target, onClose]);

  if (!target) return null;

  return (
    <Portal>
      {/* 遮罩（对齐 modal-md-editor：rgba(10,10,10,.4)）。
          pointer-events-auto 必须显式声明：overlay-root 为 pointer-events:none 且可继承，漏则整棵子树不接事件。 */}
      <div
        className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center pointer-events-auto"
        style={{ background: 'rgba(10,10,10,.4)' }}
        data-testid="ws-image-viewer"
        data-action-key="ws-image-viewer.close"
        onClick={onClose}
      >
        {/* modal shell（640px / max-92vw / max-h-88vh，对齐 workspace editor 弹层） */}
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('workspace.wsImageViewer.title')}
          className="w-[640px] max-w-[92vw] max-h-[88vh] bg-surface rounded-xl shadow-lg flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* 标题：图标 + 文件名 + 相对路径 subtitle + ✕ */}
          <div className="flex items-center gap-[11px] px-[18px] py-[13px] border-b border-border shrink-0">
            <span className="text-[17px]">🖼️</span>
            <div className="min-w-0">
              <div className="font-mono text-[13.5px] font-semibold text-fg truncate">{target.fileName}</div>
              <div className="text-[11px] text-muted truncate">{target.subtitle}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('workspace.wsImageViewer.close')}
              data-action-key="ws-image-viewer.close-btn"
              className={ICON_BTN + ' ml-auto'}
            >
              ✕
            </button>
          </div>
          {/* 图片 body：loading / error / <img>（只读，max-w/max-h 保持纵横比） */}
          <div className="flex-1 overflow-auto min-h-[240px] bg-surface flex items-center justify-center p-[18px]">
            {error ? (
              <div data-testid="ws-image-viewer-error" className="text-[12.5px] text-muted">
                {error}
              </div>
            ) : dataUrl ? (
              <img
                data-testid="ws-image-viewer-img"
                src={dataUrl}
                alt={target.fileName}
                className="max-w-full max-h-[60vh] object-contain"
              />
            ) : (
              <div className="text-[12.5px] text-muted">{t('workspace.wsImageViewer.loading')}</div>
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}

export default ComponentWsImageViewer;
