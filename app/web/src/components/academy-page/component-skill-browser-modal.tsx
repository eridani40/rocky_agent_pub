/**
 * component-skill-browser-modal —— Academy 版本 Skills 浏览/编辑弹层（两级目录树）
 * 参考: specs/ui/components/academy-page/component-skill-browser-modal.md
 *       specs/api/overall/18-academy.md §1.8（文件树随版本内容返回）+ §1.11（单文件读/写）
 *
 * skill 的载体是「目录 + SKILL.md + 任意附属文件」，故左侧是两级树：
 *   skill 目录（顶层）→ 目录内文件/子目录（用 common/file-tree 的 buildFileTree 建子树后加 skill 名前缀）。
 * 右侧按扩展名分渲染：markdown → PrimitiveMarkdownView、text → mono <pre>、
 *   unknown 或后端标 binary → 「不可预览」（二进制判定只信后端 binary 标记，不做前端嗅探）。
 * markdown 渲染前经 `stripMarkdownFrontmatter` 剥离 YAML frontmatter（元信息，后端 gray-matter 已解析成
 *   name/description）；text 分支原样输出全部字符；**编辑态 textarea 恒为原文**，保存不丢 frontmatter。
 * formal 版本可「查看 / 编辑」单文件并保存（PATCH §1.11.2）；process 版本 readOnly 全程只读。
 *
 * 本弹层与 md 编辑器（component-modal-md-editor）**互不相通**：Skills 不经 md 编辑器通道，
 * 避免把目录名列表当 AGENTS.md 提交而覆盖 system prompt（历史数据丢失形态）。
 * L3 modal 走 Portal + 根节点显式 pointer-events-auto（`_conventions.md` §13：overlay-root 为
 * pointer-events:none 且可继承，漏写则整棵子树不接事件）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Portal } from '../../lib/portal';
import { ComponentFileTree } from '../common/component-file-tree';
import { collectDirPaths, findFirstFilePath } from '../common/file-tree';
import { PrimitiveMarkdownView } from '../common/primitive-markdown-view';
import type { SkillSummary, VersionSkillFileContent } from '../../lib/academy-api';
import { buildSkillsTree, classifySkillFile, splitSkillSelection, stripMarkdownFrontmatter } from './skill-file-view';
import { BTN_PRIMARY, BTN_SECONDARY, ICON_BTN } from './academy-styles';

interface Props {
  open: boolean;
  /** 版本内 skill 列表（目录 + 文件树，来自 GET .../version/:vid 的 content.skills） */
  skills: SkillSummary[];
  studentName: string;
  /** 版本号（如 'v2.0'） */
  versionLabel: string;
  /** process 版本只读 → 不渲染编辑/保存 */
  readOnly?: boolean;
  /** 按 skill + 相对 path 懒取文件内容 */
  onFetchFile: (skillName: string, path: string) => Promise<VersionSkillFileContent>;
  /** 保存单文件（仅 formal 渲染入口） */
  onSaveFile?: (args: { skillName: string; path: string; content: string }) => Promise<void>;
  onClose: () => void;
}

/** Skills 浏览弹层（左两级树 250px + 右内容面板） */
export function ComponentSkillBrowserModal({
  open, skills, studentName, versionLabel, readOnly = false, onFetchFile, onSaveFile, onClose,
}: Props) {
  const { t } = useTranslation('academy');
  const root = useMemo(() => buildSkillsTree(skills), [skills]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => collectDirPaths(root));
  const [selPath, setSelPath] = useState<string | null>(() => findFirstFilePath(root));
  const [file, setFile] = useState<VersionSkillFileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState(false);
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const sel = selPath ? splitSkillSelection(selPath) : null;
  const kind = sel ? classifySkillFile(sel.path) : 'unknown';
  const fileCount = skills.reduce((n, s) => n + s.fileCount, 0);

  // 父级常传内联箭头（身份每次 render 都变）→ 用 ref 存最新回调，取内容 effect 只依赖 selPath，
  // 避免「effect 每次 render 重跑 → setState → 再 render」的死循环。
  const fetchRef = useRef(onFetchFile);
  fetchRef.current = onFetchFile;

  // 选中文件变化 → 懒取内容（每次回到 view 模式 + 清保存提示）
  useEffect(() => {
    let cancelled = false;
    setMode('view');
    setSaveMsg(null);
    setReadError(false);
    if (!sel) {
      setFile(null);
      return;
    }
    setLoading(true);
    setFile(null);
    fetchRef.current(sel.skillName, sel.path)
      .then((r) => {
        if (cancelled) return;
        setFile(r);
        setDraft(r.content);
      })
      .catch(() => {
        if (!cancelled) setReadError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  // 可编辑 = formal + 已取到文本内容（binary/unknown/读失败一律不给编辑面）
  const editable = !readOnly && !!onSaveFile && !!sel && !!file && !file.binary && kind !== 'unknown';

  const handleSave = async () => {
    if (!editable || !onSaveFile || !sel || saving) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      await onSaveFile({ skillName: sel.skillName, path: sel.path, content: draft });
      setMode('view');
      setFile((prev) => (prev ? { ...prev, content: draft } : prev));
      setSaveMsg(t('skillBrowser.saved'));
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : t('skillBrowser.saveFail'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Portal>
      {/* 遮罩：pointer-events-auto 必须显式（overlay-root 为 pointer-events:none 且可继承） */}
      <div
        className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center pointer-events-auto"
        style={{ background: 'rgba(10,10,10,.4)' }}
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('skillBrowser.title', { student: studentName })}
          className="w-[820px] max-w-[94vw] h-[560px] max-h-[88vh] bg-surface rounded-xl shadow-lg flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* head：title + sub + mode-toggle（formal）+ ✕ */}
          <div className="flex items-center gap-[11px] px-[18px] py-[13px] border-b border-border shrink-0">
            <div className="min-w-0">
              <div className="text-[13.5px] font-semibold text-fg truncate">
                {t('skillBrowser.title', { student: studentName })}
              </div>
              <div className="text-[11px] text-muted truncate font-mono">
                {t('skillBrowser.sub', { label: versionLabel, skills: skills.length, files: fileCount })}
              </div>
            </div>
            {editable && (
              <span className="ml-auto flex border border-border rounded-md overflow-hidden shrink-0">
                <button
                  type="button"
                  aria-pressed={mode === 'view'}
                  onClick={() => setMode('view')}
                  className={`px-[13px] py-[5px] text-[12px] ${mode === 'view' ? 'bg-accent text-white' : 'text-muted'}`}
                >
                  {t('skillBrowser.view')}
                </button>
                <button
                  type="button"
                  data-action-key="academy.version.edit-skill-file"
                  aria-pressed={mode === 'edit'}
                  onClick={() => setMode('edit')}
                  className={`px-[13px] py-[5px] text-[12px] ${mode === 'edit' ? 'bg-accent text-white' : 'text-muted'}`}
                >
                  {t('skillBrowser.edit')}
                </button>
              </span>
            )}
            <button
              type="button"
              data-action-key="academy.version.close-skill-browser"
              onClick={onClose}
              aria-label={t('skillBrowser.close')}
              className={ICON_BTN + (editable ? '' : ' ml-auto')}
            >
              ✕
            </button>
          </div>

          {/* body：左两级树 250px + 右内容 */}
          <div className="flex flex-1 min-h-0">
            <div className="w-[250px] shrink-0 border-r border-border overflow-y-auto py-2 px-[6px] bg-surface-2">
              {root.children.length === 0 ? (
                <div className="text-center text-[12px] text-muted font-mono py-4">{t('skillBrowser.emptyTree')}</div>
              ) : (
                <ComponentFileTree
                  nodes={root.children}
                  expanded={expanded}
                  selPath={selPath}
                  onToggleExpand={(p) => setExpanded((prev) => ({ ...prev, [p]: !prev[p] }))}
                  onSelect={setSelPath}
                />
              )}
            </div>

            <div className="flex-1 min-w-0 flex flex-col">
              {sel ? (
                <>
                  <div className="text-[11px] text-muted px-4 py-2 border-b border-border bg-surface-2 shrink-0 truncate font-mono">
                    {selPath}
                  </div>
                  <div className="flex-1 min-h-0 overflow-auto">
                    {mode === 'edit' ? (
                      <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        className="w-full h-full min-h-[280px] px-[18px] py-[14px] border-none outline-none resize-none font-mono text-[12px] leading-[1.6] text-fg bg-surface"
                      />
                    ) : (
                      <FileContentView
                        loading={loading}
                        readError={readError}
                        file={file}
                        kind={kind}
                      />
                    )}
                  </div>
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center text-muted text-[12px] font-mono">
                  {t('skillBrowser.selectHint')}
                </div>
              )}
            </div>
          </div>

          {/* foot：提示 + 关闭 +（edit 模式）保存 */}
          <div className="flex items-center gap-2.5 px-[18px] py-3 border-t border-border shrink-0">
            <span className="text-[11.5px] text-muted truncate">
              {saveMsg ?? (readOnly ? t('skillBrowser.readOnlyHint') : '')}
            </span>
            <span className="ml-auto flex gap-[9px]">
              <button type="button" onClick={onClose} className={BTN_SECONDARY}>
                {t('skillBrowser.close')}
              </button>
              {mode === 'edit' && editable && (
                <button
                  type="button"
                  data-action-key="academy.version.save-skill-file"
                  disabled={saving}
                  onClick={() => void handleSave()}
                  className={BTN_PRIMARY}
                >
                  {saving ? t('skillBrowser.saving') : t('skillBrowser.save')}
                </button>
              )}
            </span>
          </div>
        </div>
      </div>
    </Portal>
  );
}

/** 右侧只读内容渲染：markdown / mono pre / 不可预览（含 loading 与读失败态） */
function FileContentView({ loading, readError, file, kind }: {
  loading: boolean;
  readError: boolean;
  file: VersionSkillFileContent | null;
  kind: ReturnType<typeof classifySkillFile>;
}) {
  const { t } = useTranslation('academy');
  const hint = (text: string) => (
    <div className="px-[18px] py-[14px] text-[12px] text-muted font-mono">{text}</div>
  );
  if (loading) return hint(t('skillBrowser.loading'));
  if (readError) return hint(t('skillBrowser.readFail'));
  if (!file) return hint(t('skillBrowser.selectHint'));
  if (file.binary) return hint(t('skillBrowser.binary'));
  if (kind === 'unknown') return hint(t('skillBrowser.unpreviewable'));
  const tail = file.truncated ? t('skillBrowser.truncated') : '';
  if (kind === 'markdown') {
    return (
      <div className="px-[22px] py-[18px] text-[13.5px] leading-[1.75] text-fg">
        <PrimitiveMarkdownView source={stripMarkdownFrontmatter(file.content)} />
        {tail && <div className="mt-3 text-[11.5px] text-muted font-mono">{tail}</div>}
      </div>
    );
  }
  return (
    <pre
      className="m-0 px-[18px] py-[14px] font-mono text-[12px] leading-[1.6] text-fg-2 bg-surface"
      style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
    >
      {file.content}
      {tail ? '\n\n' + tail : ''}
    </pre>
  );
}

export default ComponentSkillBrowserModal;
