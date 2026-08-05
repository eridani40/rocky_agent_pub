/**
 * component-skill-preview-modal — Skill 内容预览 modal（左文件树 + 右内容）
 * 参考: specs/ui/components/skill-page/component-skill-preview-modal.md
 *       设计稿视觉基线: reqs/v0.0.21/easy-opc-skill-v10.html .pv-overlay/.pv-modal/.pv-header/.pv-tree/.pv-content/.pv-filepath/.pv-pre/.pv-empty/.pv-item/.pv-twisty/.pv-ico/.pv-name (:106-126)
 *
 * 预览树一次性整树（API GET /skill/:name/tree 返回扁平数组，前端 buildFileTree 转嵌套）；
 * 文件内容按 path 懒取（GET /skill/:name/file?path=）。
 * 默认所有 dir 展开（collectDirPaths 预填）；默认选中深度优先第一个文件（findFirstFilePath）。
 *
 * 左树 = 复用 `common/file-tree`（纯函数）+ `common/component-file-tree`（递归视图），
 * 与 academy skill browser 同一实现；右侧 `<pre>` 内容面板本页自持（各页渲染策略不同，不共享）。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SkillEntry } from '../../lib/api-client';
import { buildFileTree, collectDirPaths, findFirstFilePath } from '../common/file-tree';
import { ComponentFileTree } from '../common/component-file-tree';
import type { SkillFileNode } from './skill-types';

interface SkillPreviewModalProps {
  /** skill（id + name） */
  skill: SkillEntry;
  /** 文件树（API 扁平数组，组件内 buildFileTree 转嵌套） */
  tree: SkillFileNode[];
  /** 关闭 */
  onClose: () => void;
  /** 按 path 取文件内容（懒，page 转发到 GET /skill/:name/file） */
  onFetchFile: (skillName: string, path: string) => Promise<{ content: string; binary: boolean; truncated: boolean }>;
}

/**
 * 渲染预览 modal。视觉对齐设计稿 .pv-modal：820×560（max 94vw/88vh），flex 纵向 overflow hidden。
 * header(title + close) → body(左树 250px + 右 filepath + pre)。
 */
export function ComponentSkillPreviewModal({ skill, tree, onClose, onFetchFile }: SkillPreviewModalProps) {
  // 通用关闭 aria-label 走 common ns；预览态文案走 skill ns
  const { t } = useTranslation('common');
  const { t: ts } = useTranslation('skill');
  // 扁平数组 → 嵌套树（memo，tree 不变不重算）
  const root = useMemo(() => buildFileTree(tree), [tree]);
  // dir 展开态：默认全展开（collectDirPaths 预填）
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => collectDirPaths(root));
  // 当前选中文件 path：默认深度优先第一个文件
  const [selPath, setSelPath] = useState<string | null>(() => findFirstFilePath(root));
  const [content, setContent] = useState('');
  const [binary, setBinary] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);

  // selPath 变化 → 懒取文件内容
  useEffect(() => {
    let cancelled = false;
    if (!selPath) {
      setContent('');
      setBinary(false);
      return;
    }
    setLoading(true);
    setContent('');
    onFetchFile(skill.name, selPath)
      .then((r) => {
        if (cancelled) return;
        setContent(r.content);
        setBinary(r.binary);
        setTruncated(r.truncated);
      })
      .catch(() => {
        if (!cancelled) {
          setContent(ts('previewModal.readFail'));
          setBinary(false);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selPath, skill.name, onFetchFile]);

  const toggleExpand = (path: string) =>
    setExpanded((prev) => ({ ...prev, [path]: !prev[path] }));

  return (
    <div

      className="fixed inset-0 flex items-center justify-center z-[200]"
      style={{ background: 'rgba(30,25,20,0.45)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div

        className="flex flex-col overflow-hidden rounded-[14px] border border-border-2 bg-surface"
        style={{
          width: '820px',
          maxWidth: '94vw',
          height: '560px',
          maxHeight: '88vh',
          boxShadow: '0 20px 56px rgba(40,30,20,0.24)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header：title（星形 + name）+ close */}
        <div className="flex items-center justify-between px-[18px] py-[14px] border-b border-border shrink-0">
          <div

            className="flex items-center gap-2 text-[15px] font-bold text-fg"
          >
            <span
              className="w-[15px] h-[15px] flex items-center justify-center text-accent"
              aria-hidden
            >
              <SkillStarIcon />
            </span>
            {skill.name}
          </div>
          <button
            type="button"
            data-action-key="skill.skill.close-preview"
            onClick={onClose}
            aria-label={t('modal.close')}
            className="w-7 h-7 rounded-md flex items-center justify-center text-muted hover:bg-bg-warm hover:text-fg transition-colors"
          >
            <CloseIcon />
          </button>
        </div>

        {/* body：左树 250px + 右内容 */}
        <div className="flex flex-1 min-h-0">
          {/* 左：文件树 */}
          <div

            className="w-[250px] shrink-0 border-r border-border overflow-y-auto py-2 px-[6px] bg-surface-2"
          >
            {root.children.length === 0 ? (
              <div className="text-center text-[12px] text-muted font-mono py-4">{ts('previewModal.emptyTree')}</div>
            ) : (
              <ComponentFileTree
                nodes={root.children}
                expanded={expanded}
                selPath={selPath}
                onToggleExpand={toggleExpand}
                onSelect={setSelPath}
              />
            )}
          </div>

          {/* 右：filepath + pre 内容 */}
          <div className="flex-1 min-w-0 flex flex-col">
            {selPath ? (
              <>
                <div

                  className="text-[11px] text-muted px-4 py-2 border-b border-border bg-surface-2 shrink-0 whitespace-nowrap overflow-hidden text-ellipsis font-mono"
                >
                  {selPath}
                </div>
                <pre

                  className="flex-1 overflow-auto m-0 px-[18px] py-[14px] font-mono text-[12px] leading-[1.6] text-fg-2 bg-surface"
                  style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                >
                  {loading
                    ? ts('previewModal.loading')
                    : binary
                      ? ts('previewModal.binary')
                      : (content || ts('previewModal.emptyFile'))}
                  {truncated && !loading && !binary ? '\n\n' + ts('previewModal.truncated') : ''}
                </pre>
              </>
            ) : (
              <div

                className="flex-1 flex items-center justify-center text-muted text-[12px] font-mono"
              >
                {ts('previewModal.selectHint')}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// —— 内联图标 ——
function SkillStarIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2L14 10 22 12 14 14 12 22 10 14 2 12 10 10Z" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

export default ComponentSkillPreviewModal;
