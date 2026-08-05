/**
 * component-skill-drop-zone — Skill 安装区（拖拽 + 选择文件/文件夹）
 * 参考: specs/ui/components/skill-page/component-skill-drop-zone.md
 *       设计稿视觉基线: reqs/v0.0.21/easy-opc-skill-v10.html .drop-zone/.drop-icon/.drop-title/.drop-sub/.drop-actions (:85-92)
 *
 * [v0.0.21] 决策：安装走后端 API（POST /skill/install multipart），不在前端解压。
 * 设计稿的 JSZip installFromArchive/installFromFolder/installFromDataTransfer 是 mock，生产不照搬。
 * 本组件只管收集 file/folder/zip → onInstall 回调（page 转发到后端）。
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** 安装 payload 类型（kind 决定后端如何处理 files） */
export interface SkillInstallPayload {
  /** files = 单/多文件（.md/.zip/.skill）；folder = 文件夹（多 file 带 webkitRelativePath）；zip = 单 zip */
  kind: 'files' | 'folder' | 'zip';
  files: File[];
}

interface SkillDropZoneProps {
  /** 收集到 file/folder/zip 后回调（page 转发到后端 install API） */
  onInstall: (payload: SkillInstallPayload) => void;
  /** 上传中禁用 + 提示（v0.0.21 可选） */
  uploading?: boolean;
}

/** 从 DataTransfer 判断是文件夹还是文件（用 webkitGetAsEntry） */
function detectDropKind(dt: DataTransfer): { kind: 'files' | 'folder' | 'zip'; files: File[] } {
  const items = dt.items ? Array.from(dt.items) : [];
  // 优先用 webkitGetAsEntry 判断是否有目录
  let hasDir = false;
  for (const it of items) {
    const entry = (it as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.();
    if (entry?.isDirectory) hasDir = true;
  }
  const files = Array.from(dt.files ?? []);
  // 单个 zip 文件 → zip；含目录 → folder；其余 → files
  if (hasDir) return { kind: 'folder', files };
  const first = files[0];
  if (files.length === 1 && first && /\.zip$/i.test(first.name)) return { kind: 'zip', files };
  return { kind: 'files', files };
}

/**
 * 渲染 drop-zone。视觉对齐设计稿 .drop-zone：1.5px dashed 边 + rounded-14px，
 * 纵向居中 flex，图标(44×44) → 标题 → sub → 两按钮。
 * hover/dragOver：accent 边 + accent-surface 底；dragOver 额外 4px accent-light 外发光圈。
 */
export function ComponentSkillDropZone({ onInstall, uploading = false }: SkillDropZoneProps) {
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  // [v0.0.62 i18n] drop-zone 文案走 skill ns
  const { t } = useTranslation('skill');

  const triggerFile = () => fileInputRef.current?.click();
  const triggerFolder = () => folderInputRef.current?.click();

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (uploading) return;
    const { kind, files } = detectDropKind(e.dataTransfer);
    if (files.length === 0) return;
    onInstall({ kind, files });
  };

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // 清空允许重复选同名
    if (files.length === 0) return;
    const first = files[0];
    const kind = files.length === 1 && first && /\.zip$/i.test(first.name) ? 'zip' : 'files';
    onInstall({ kind, files });
  };

  const onPickFolder = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    onInstall({ kind: 'folder', files });
  };

  // 外层 state class（hover 用 CSS group-hover；dragOver 用条件 class）
  const containerClass =
    'drop-zone group flex flex-col items-center gap-2 rounded-[14px] px-6 py-7 mb-[22px] text-center transition-all cursor-pointer ' +
    'border-[1.5px] border-dashed bg-surface-2 ' +
    (dragOver
      ? 'border-accent bg-accent-surface shadow-[0_0_0_4px_var(--color-accent-light)]'
      : 'border-border-strong hover:border-accent hover:bg-accent-surface');

  return (
    <div

      className={containerClass}
      onDragOver={(e) => {
        e.preventDefault();
        if (!uploading) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {/* 上传图标：默认 bg-warm + muted；hover/dragOver → accent-light 底 + accent 字（设计稿 .drop-icon） */}
      <div

        className={
          'w-11 h-11 rounded-[12px] flex items-center justify-center transition-colors ' +
          (dragOver
            ? 'bg-accent-light text-accent'
            : 'bg-bg-warm text-muted-2 group-hover:bg-accent-light group-hover:text-accent')
        }
      >
        <UploadIcon />
      </div>
      <div className="text-[14px] font-semibold text-fg">
        {t('dropzone.title')}
      </div>
      <div

        className="text-[11px] text-muted font-mono"
      >
        {t('dropzone.subtitle')}
      </div>
      <div className="flex gap-2 mt-2">
        <button
          type="button"
          data-action-key="skill.skill.select-file"
          disabled={uploading}
          onClick={(e) => {
            e.stopPropagation();
            triggerFile();
          }}
          className="btn-secondary inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-[12px] font-semibold border border-border-2 bg-surface-2 text-fg-3 hover:border-accent hover:text-accent transition-colors disabled:opacity-50"
        >
          <FileMiniIcon /> {t('dropzone.selectFile')}
        </button>
        <button
          type="button"
          data-action-key="skill.skill.select-folder"
          disabled={uploading}
          onClick={(e) => {
            e.stopPropagation();
            triggerFolder();
          }}
          className="btn-secondary inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-[12px] font-semibold border border-border-2 bg-surface-2 text-fg-3 hover:border-accent hover:text-accent transition-colors disabled:opacity-50"
        >
          <FolderMiniIcon /> {t('dropzone.selectFolder')}
        </button>
      </div>
      {/* hidden inputs：accept 限制文件类型；folder 用 webkitdirectory */}
      <input
        ref={fileInputRef}

        type="file"
        accept=".zip,.skill,.md,.json,.txt"
        multiple
        className="hidden"
        onChange={onPickFiles}
      />
      <input
        ref={folderInputRef}

        type="file"
        multiple
        className="hidden"
        // webkitdirectory 非标准属性，用 spread 注入；TS 类型缺，加 @ts-ignore
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={onPickFolder}
      />
    </div>
  );
}

// —— 内联图标（对齐设计稿 Icon upload/file/folder）——
function UploadIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}
function FileMiniIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}
function FolderMiniIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export default ComponentSkillDropZone;
