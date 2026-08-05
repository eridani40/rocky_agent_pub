/**
 * component-modal-md-editor —— 通用文件 viewer/editor 弹层（v0.0.241 扩展，文件名保留 md-editor 历史）
 * 参考: specs/ui/components/common/component-modal-md-editor.md
 *       demo 09-version-edit.html（720px / view 13.5px-1.75 / edit mono 13px-1.7 / mode-toggle）
 *       specs/prd/version_logs/v0.0.241.md §2-3（格式分类 + 格式功能详述）
 *
 * view 模式按 format 分流：md → PrimitiveMarkdownView（chat-page 共享渲染内核同款）；
 * structured/plain → <pre> 朴素预览（PRD §2.2 极简风格，无高亮/行号/折叠）。
 * edit 模式全宽 textarea；「保存」按钮仅 edit 模式渲染；「格式化」「校验」按钮仅 edit + structured 渲染
 * （plain/md 用 visibility:hidden 占位保布局稳定，禁 display:none 致位移——CLAUDE.md 布局稳定性硬规则）。
 * L3 modal 走 Portal + 根节点显式 pointer-events-auto（`specs/ui/components/_conventions.md` §13：
 * 脱离祖先 pointer-events/stacking 链；overlay-root 为 pointer-events:none 且可继承，漏 auto 则全穿透）。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileFormat, FileFormatCategory } from '../../lib/file-format';
import { getCategory } from '../../lib/file-format';
import { formatText, validateText } from '../../lib/file-format/index';
import { Portal } from '../../lib/portal';
import { PrimitiveMarkdownView } from './primitive-markdown-view';
import { BTN_PRIMARY, BTN_SECONDARY, ICON_BTN } from '../academy-page/academy-styles';

interface Props {
  open: boolean;
  /** mono 文件名（如 'AGENTS.md' / 'notes.md' / 'config.json'） */
  fileName: string;
  /** 副标题（学生 · 版本 · 字段，如 '小红书文案 · v2.0 · system prompt'） */
  subtitle: string;
  /** 原文（markdown 源码 / 配置文本） */
  initialValue: string;
  /** 版本号（hint 文案用，如 'v2.0'） */
  versionLabel: string;
  /** 覆盖默认 hint 文案：academy 不传走默认版本号模板；workspace 等文件场景传值覆盖 */
  hint?: string;
  /**
   * 文件格式（v0.0.241 新增，缺省 'md' 向后兼容 academy）：
   * 决定 view 分流（md → PrimitiveMarkdownView / 其余 → <pre>）+ edit 模式是否显示「格式化」「校验」按钮
   * （仅 structured 显示，plain/md 用 visibility:hidden 占位）。
   */
  format?: FileFormat;
  /** 只读（process 版本）→ 隐藏编辑切换 + 保存 */
  readOnly?: boolean;
  /** 保存回调（edit 模式「保存」；成功后父级关弹层或切回 view） */
  onSave?: (newValue: string) => Promise<void> | void;
  onClose: () => void;
}

/** 校验/格式化结果状态机（v0.0.241）：idle 默认 → ok 正向反馈 → error 显 msg */
type ValidateState =
  | { kind: 'idle' }
  | { kind: 'ok' }
  | { kind: 'error'; msg: string };

/** 统一文件弹层（mode-toggle 二段「👁 查看 / ✏️ 编辑」，激活黑底白字） */
export function ComponentModalMdEditor({ open, fileName, subtitle, initialValue, versionLabel, hint, format, readOnly = false, onSave, onClose }: Props) {
  const { t } = useTranslation('academy');
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [draft, setDraft] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [validateResult, setValidateResult] = useState<ValidateState>({ kind: 'idle' });

  // 派生一次：format + category（避免多次调用 getCategory）
  const fmt: FileFormat = format ?? 'md';
  const category: FileFormatCategory = getCategory(fmt);

  // open 变化时重置内部态（每次打开回到 view + 最新原文 + 清校验结果）
  useEffect(() => {
    if (open) {
      setMode('view');
      setDraft(initialValue);
      setSaveError(null);
      setValidateResult({ kind: 'idle' });
    }
  }, [open, initialValue]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  // 格式化：成功替换 draft + 显 ok；失败不动 draft（PRD §3.1 关键不变量：解析失败不可格式化，防洗空坏内容）
  const handleFormat = () => {
    const res = formatText(fmt, draft);
    if (res.ok) {
      setDraft(res.output);
      setValidateResult({ kind: 'ok' });
    } else {
      setValidateResult({ kind: 'error', msg: t('fileEditor.formatFail') });
    }
  };

  // 校验：成功显 ok；失败显 msg（含行号走 validateFailLine template，否则 validateFail）。不阻塞保存
  const handleValidate = () => {
    const res = validateText(fmt, draft);
    if (res.ok) {
      setValidateResult({ kind: 'ok' });
    } else if (typeof res.line === 'number') {
      setValidateResult({ kind: 'error', msg: t('fileEditor.validateFailLine', { line: res.line, msg: res.error }) });
    } else {
      setValidateResult({ kind: 'error', msg: t('fileEditor.validateFail', { msg: res.error }) });
    }
  };

  const handleSave = async () => {
    if (!onSave || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(draft);
      setMode('view');
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : t('mdEditor.saveFail'));
    } finally {
      setSaving(false);
    }
  };

  // hint 区状态机优先级（v0.0.241）：saveError > validateResult.error > validateResult.ok > 默认 hint/versionLabel
  const hintDisplay =
    saveError ??
    (validateResult.kind === 'error' ? validateResult.msg
      : validateResult.kind === 'ok' ? t('fileEditor.validateOk')
      : (hint ?? t('mdEditor.hint', { label: versionLabel })));

  return (
    <Portal>
      {/* 遮罩（demo overlay：rgba(10,10,10,.4)）。编辑器类弹窗禁用遮罩点击关闭（防误丢输入），
          关闭仅走显式入口：Esc / 右上角 ✕ / foot 关闭 / 保存成功自动关闭。
          pointer-events-auto 必须显式声明：overlay-root 容器为 pointer-events:none，
          该属性可继承——漏写则整棵子树不接事件，所有按钮 click 全穿透（仅 ESC 可关）。 */}
      <div
        className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center pointer-events-auto"
        style={{ background: 'rgba(10,10,10,.4)' }}
      >
        {/* modal shell（720px / max-92vw / max-h-88vh / rounded-xl / shadow-lg / column flex） */}
        <div
          role="dialog"
          aria-modal="true"
          aria-label={fileName}
          className="w-[720px] max-w-[92vw] max-h-[88vh] bg-surface rounded-xl shadow-lg flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* md-head：icon + 文件名 mono + sub + mode-toggle + ✕ */}
          <div className="flex items-center gap-[11px] px-[18px] py-[13px] border-b border-border shrink-0">
            <span className="text-[17px]">📝</span>
            <div className="min-w-0">
              <div className="font-mono text-[13.5px] font-semibold text-fg truncate">{fileName}</div>
              <div className="text-[11px] text-muted truncate">{subtitle}</div>
            </div>
            {!readOnly && (
              <span className="ml-auto flex border border-border rounded-md overflow-hidden shrink-0">
                <button
                  type="button"
                  aria-pressed={mode === 'view'}
                  onClick={() => setMode('view')}
                  className={`px-[13px] py-[5px] text-[12px] flex items-center gap-[5px] ${mode === 'view' ? 'bg-accent text-white' : 'text-muted'}`}
                >
                  {t('mdEditor.view')}
                </button>
                <button
                  type="button"
                  aria-pressed={mode === 'edit'}
                  onClick={() => setMode('edit')}
                  className={`px-[13px] py-[5px] text-[12px] flex items-center gap-[5px] ${mode === 'edit' ? 'bg-accent text-white' : 'text-muted'}`}
                >
                  {t('mdEditor.edit')}
                </button>
              </span>
            )}
            <button type="button" onClick={onClose} aria-label={t('mdEditor.close')} className={ICON_BTN + (readOnly ? ' ml-auto' : '')}>
              ✕
            </button>
          </div>

          {/* md-body：view 按 format 分流（md→PrimitiveMarkdownView / 其余→<pre>）/ edit=mono textarea */}
          <div className="flex-1 overflow-y-auto min-h-[280px]">
            {mode === 'view' ? (
              category === 'md' ? (
                // md 走 markdown 渲染（academy 不传 format 缺省 'md'，回归保护）
                <div className="px-[22px] py-[18px] text-[13.5px] leading-[1.75] text-fg">
                  <PrimitiveMarkdownView source={draft} />
                </div>
              ) : (
                // structured/plain 走 <pre> 朴素预览（无高亮/行号/折叠，PRD §2.2）
                <pre className="px-[22px] py-[18px] font-mono text-[13px] leading-[1.7] text-fg whitespace-pre-wrap break-words">{draft}</pre>
              )
            ) : (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="w-full h-full min-h-[280px] px-[22px] py-[18px] border-none outline-none resize-none font-mono text-[13px] leading-[1.7] text-fg bg-surface"
              />
            )}
          </div>

          {/* md-foot：hint + [格式化 + 校验]（edit + structured 显示，其余 visibility:hidden 占位）+ 关闭 + 保存（仅 edit） */}
          <div className="flex items-center gap-2.5 px-[18px] py-3 border-t border-border shrink-0">
            <span className="text-[11.5px] text-muted truncate min-w-0 flex-1">
              {hintDisplay}
            </span>
            <span className="ml-auto flex gap-[9px]">
              {/* 格式按钮（v0.0.241）：edit + structured 显示；plain/md 用 visibility:hidden 占位保布局；view 模式一律不渲染 */}
              {mode === 'edit' && !readOnly && (
                <>
                  <button
                    type="button"
                    data-action-key="ws.file.format"
                    onClick={handleFormat}
                    className={BTN_SECONDARY + (category !== 'structured' ? ' invisible' : '')}
                  >
                    {t('fileEditor.format')}
                  </button>
                  <button
                    type="button"
                    data-action-key="ws.file.validate"
                    onClick={handleValidate}
                    className={BTN_SECONDARY + (category !== 'structured' ? ' invisible' : '')}
                  >
                    {t('fileEditor.validate')}
                  </button>
                </>
              )}
              <button type="button" onClick={onClose} className={BTN_SECONDARY}>
                {t('mdEditor.close')}
              </button>
              {mode === 'edit' && !readOnly && (
                <button type="button" data-action-key="academy.version.save" disabled={saving} onClick={() => void handleSave()} className={BTN_PRIMARY}>
                  {saving ? t('mdEditor.saving') : t('mdEditor.save')}
                </button>
              )}
            </span>
          </div>
        </div>
      </div>
    </Portal>
  );
}

export default ComponentModalMdEditor;
