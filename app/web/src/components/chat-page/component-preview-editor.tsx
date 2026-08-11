/**
 * component-preview-editor —— 预览区 edit 模式（内嵌非弹层）（v0.0.320 D6；[老板第三批] 删顶栏行+悬浮按钮）
 * 参考: specs/tech/version_logs/v0.0.320/change_plan.md D6（editor 契约）
 *       + component-modal-md-editor（弹层时代功能基线：格式化/校验/结果反馈）
 *
 * 功能（[老板试玩修复5] 对齐弹层）：textarea 全宽编辑 + 校验结果反馈 + 保存错误显示。
 *   [老板试玩修复6] textarea 浅底色（bg-bg-warm 极浅灰）。
 *
 * [老板第三批反馈①②] 删除顶部「文件路径 + 保存/取消/格式化/校验按钮」整行——
 *   保存/撤销迁移到正文区悬浮按钮（component-preview-floating-actions），
 *   格式化/校验也迁移到悬浮按钮组（编辑态）。
 *   格式化/校验命令通过 useImperativeHandle 暴露给容器（容器组装悬浮按钮）。
 *   校验/错误反馈 hint 区保留（editor 内部状态）。
 *
 * 约束（D6 MUST）：编辑模式 = textarea；保存失败留在 edit 显示错误；NOT 复用 modal（非弹层内嵌）。
 */
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PreviewTab } from './preview-tabs-types';
import { getCategory } from '../../lib/file-format';
import { formatText, validateText } from '../../lib/file-format/index';

/** 校验/格式化结果状态机（对齐 modal-md-editor：idle → ok → error） */
type ValidateState =
  | { kind: 'idle' }
  | { kind: 'ok' }
  | { kind: 'error'; msg: string };

interface ComponentPreviewEditorProps {
  tab: PreviewTab;
  /** 保存回调（容器接 usePreviewTabs.saveTab；抛错 → 本组件显示错误留在 edit） */
  onSave: () => Promise<void>;
  /** 取消 → 回 view */
  onCancel: () => void;
  /** 更新 draft（容器接 usePreviewTabs.setDraft） */
  onDraftChange: (draft: string) => void;
}

/** editor 暴露给悬浮按钮的命令接口 */
export interface PreviewEditorHandle {
  format: () => void;
  validate: () => void;
  save: () => void;
  saving: boolean;
  isStructured: boolean;
}

/**
 * 预览区 edit 模式。[老板第三批] 顶部操作栏删除，保存/撤销/格式化/校验迁移到悬浮按钮。
 * [老板试玩修复6] textarea bg-bg-warm 浅底色（替代纯白 bg-surface）。
 * 格式化/校验/保存命令通过 ref 暴露（容器 → 悬浮按钮）。
 */
export const ComponentPreviewEditor = forwardRef<PreviewEditorHandle, ComponentPreviewEditorProps>(
  function ComponentPreviewEditor({ tab, onSave, onCancel, onDraftChange }, ref) {
    const { t } = useTranslation('chat');
    const taRef = useRef<HTMLTextAreaElement>(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [validateResult, setValidateResult] = useState<ValidateState>({ kind: 'idle' });

    const category = getCategory(tab.format);
    const isStructured = category === 'structured';

    // textarea 内容自适应高度（复用 modal-md-editor 逻辑：先 auto 重置再测 scrollHeight）
    useLayoutEffect(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.style.height = 'auto';
      ta.style.height = `${ta.scrollHeight}px`;
    }, [tab.draft]);

    const handleSave = async () => {
      if (saving) return;
      setSaving(true);
      setSaveError(null);
      try {
        await onSave();
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : t('workspace.preview.saveFail'));
      } finally {
        setSaving(false);
      }
    };

    const handleFormat = () => {
      const res = formatText(tab.format, tab.draft);
      if (res.ok) {
        onDraftChange(res.output);
        setValidateResult({ kind: 'ok' });
      } else {
        setValidateResult({ kind: 'error', msg: t('workspace.preview.formatFail') });
      }
    };

    const handleValidate = () => {
      const res = validateText(tab.format, tab.draft);
      if (res.ok) {
        setValidateResult({ kind: 'ok' });
      } else if (typeof res.line === 'number') {
        setValidateResult({ kind: 'error', msg: t('workspace.preview.validateFailLine', { line: res.line, msg: res.error }) });
      } else {
        setValidateResult({ kind: 'error', msg: t('workspace.preview.validateFail', { msg: res.error }) });
      }
    };

    // 暴露命令给容器（悬浮按钮通过 ref 调用）
    const savingRef = useRef(saving);
    savingRef.current = saving;
    useImperativeHandle(ref, () => ({
      format: handleFormat,
      validate: handleValidate,
      save: () => void handleSave(),
      get saving() { return savingRef.current; },
      isStructured,
    }), [isStructured, tab.format, tab.draft, t]);

    // 状态优先级：saveError > validateResult.error > validateResult.ok
    const hintDisplay =
      saveError ??
      (validateResult.kind === 'error' ? validateResult.msg
        : validateResult.kind === 'ok' ? t('workspace.preview.validateOk') : null);

    return (
      <div className="pv-editor flex flex-col min-h-0 flex-1" data-testid="pv-editor">
        {/* 校验/保存错误反馈（[老板试玩修复5] 对齐弹层 hint 区） */}
        {hintDisplay && (
          <div data-testid="pv-editor-hint" className={`px-3 py-1 text-[11.5px] border-b border-border shrink-0 ${
            saveError || validateResult.kind === 'error' ? 'text-red-500 bg-red-50' : 'text-green-600 bg-green-50'
          }`}>
            {hintDisplay}
          </div>
        )}
        {/* [老板试玩修复6] textarea 浅底色 + [老板边框修复] 有明确边框框线（对齐弹层视觉） */}
        <textarea
          ref={taRef}
          data-testid="pv-editor-textarea"
          value={tab.draft}
          onChange={(e) => onDraftChange(e.target.value)}
          className="flex-1 min-h-0 w-full px-4 py-3 border border-border rounded-lg mx-3 my-2 outline-none resize-none font-mono text-[13px] leading-[1.7] text-fg bg-bg-warm overflow-y-auto"
          spellCheck={false}
        />
      </div>
    );
  },
);

export default ComponentPreviewEditor;
