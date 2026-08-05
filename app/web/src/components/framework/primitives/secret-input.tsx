/**
 * primitive-secret-input — 敏感值四态机输入 primitive
 * 参考: specs/ui/components/framework/primitive-secret-input.md
 *
 * 与 primitive-key-input 的区别：
 *   - key-input 是 schema type=string 的通用明文文本输入（每次输入都上抛 onChange）
 *   - secret-input 是敏感值（API key / token）：展示态 mask、编辑态明文、
 *     Enter/✓ 才 commit（提交 ≠ 落库，只标 dirty）
 *
 * 四态机（实际只两种 mode: display / editing）：
 *   - 空（value undefined/''）+ display：展示 placeholder，点击控件 → editing
 *   - 非空 + display：展示 mask + 「✎ 编辑」按钮；点编辑 → editing（draft 清空等重输）
 *   - editing：明文 input + 「✓ commit」按钮；Enter/✓ commit → onCommit；Esc / blur cancel
 *
 * blur 语义（编辑态 input 焦点离开 = 放弃编辑）：draft 丢弃，value 还原展示原值 mask。
 * ✓ commit 按钮用 onMouseDown preventDefault 阻止焦点迁移，避免点 ✓ 时先 blur → cancel
 * 卸载编辑态 UI 而吞掉 click(commit)。只有显式 ✓ / Enter 才算提交。
 *
 * 提交语义：✓ = commit（写回父级 value + 标 dirty），**不立即落库**。
 * 落库由表单级 save 触发（父级 component 控制）。
 *
 * mask 纯函数 maskSecret 单独导出供 UT 直接覆盖。
 *
 * [v0.0.90.ui] 当前版本仅产出独立组件 + UT，不接入任何调用点（v0.0.89 重构配置页
 * 时由 orchestrator 替换接入 + 删旧 password/key-input 调用）。
 */

import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * 把敏感值脱敏为展示文本：前 ≤4 位原文 + 中间 * + 后 ≤4 位原文，总长 = 真实长。
 *
 * 短值降级（避免泄露比例过大）：
 *   - len === 0 → ''
 *   - len ≤ 4   → '*'.repeat(len)（全脱敏）
 *   - 4 < len ≤ 8 → 首 1 + '*'.repeat(len-2) + 末 1
 *   - len > 8   → 首 4 + '*'.repeat(len-8) + 末 4
 *
 * 抽成纯函数便于单测覆盖短值/边界/长值。
 */
export function maskSecret(value: string): string {
  const len = value.length;
  if (len === 0) return '';
  if (len <= 4) return '*'.repeat(len);
  if (len <= 8) return value[0] + '*'.repeat(len - 2) + value[len - 1];
  return value.slice(0, 4) + '*'.repeat(len - 8) + value.slice(-4);
}

interface SecretInputProps {
  /** 当前已提交值；undefined / '' / null 均视为「空」态 */
  value?: string;
  /** 提交新值回调（Enter / ✓ 触发）；父级据此更新 value + 标 dirty（待表单级 save） */
  onCommit: (next: string) => void;
  /** 取消编辑回调（Esc 触发；draft 丢弃，value 不变）；通常无需处理 */
  onCancel?: () => void;
  /** 副文本（key 说明，可选；由父级负责 i18n） */
  desc?: string;
  /** 编辑态 placeholder（可选；默认走 i18n framework:secretInput.placeholder） */
  placeholder?: string;
  /** 禁用整个控件（可选） */
  disabled?: boolean;
  /** ET 稳定语义锚点 data-action-key（命名见 specs/ui/components/_conventions.md §12），挂根容器，可选透传 */
  actionKey?: string;
}

type Mode = 'display' | 'editing';

/**
 * 敏感值四态机输入控件。
 *
 * 状态流转：
 *   - display + 空 → click → editing（draft 清空）
 *   - display + 非空 → click「✎ 编辑」 → editing（draft 清空，编辑 secret = 重输）
 *   - editing → Enter / ✓ commit → onCommit(draft) → display（✓ 用 onMouseDown preventDefault 保住焦点）
 *   - editing → Esc / blur cancel → display（draft 丢弃，value 不变）
 */
export function SecretInput({
  value,
  onCommit,
  onCancel,
  desc,
  placeholder,
  disabled = false,
  actionKey,
}: SecretInputProps) {
  // [v0.0.62 i18n] placeholder / aria-label 走 framework:secretInput.*
  const { t } = useTranslation('framework');
  const [mode, setMode] = useState<Mode>('display');
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const isEmpty = !value; // undefined / '' / null 均视为空

  // 进入编辑态：清空 draft（编辑 secret = 重输，不预填旧值）
  const enterEditing = () => {
    if (disabled) return;
    setDraft('');
    setMode('editing');
  };

  // 编辑态自动 focus input（进入即输入）
  useEffect(() => {
    if (mode === 'editing') inputRef.current?.focus();
  }, [mode]);

  // 提交：draft.trim() → onCommit；空态下提交空 → 仅退出（不触发 onCommit，无变化）
  const commit = () => {
    const next = draft.trim();
    if (next === '' && isEmpty) {
      setMode('display');
      return;
    }
    onCommit(next);
    setMode('display');
    setDraft('');
  };

  // 取消：退出编辑态，draft 丢弃，value 不变
  const cancel = () => {
    setMode('display');
    setDraft('');
    onCancel?.();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  const editing = mode === 'editing';
  const masked = maskSecret(value ?? '');
  const placeholderText = placeholder ?? t('secretInput.placeholder');

  return (
    <div
      className="flex flex-col gap-1 w-full"
      data-action-key={actionKey}
      data-mode={mode}
      data-empty={isEmpty ? 'true' : 'false'}
    >
      {desc && <span className="text-muted text-xs">{desc}</span>}
      <div className="flex items-stretch gap-2">
        {editing ? (
          <input
            ref={inputRef}
            type="text"

            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={cancel}
            placeholder={placeholderText}
            autoComplete="off"
            spellCheck={false}
            className="flex-1 border border-border-2 rounded-md px-[12px] py-[8px] bg-surface-2 text-fg text-[13px] font-mono outline-none transition-colors focus:border-accent focus:shadow-[var(--shadow-focus)] hover:border-border-strong"
          />
        ) : (
          <div

            onClick={enterEditing}
            className={
              'flex-1 min-w-0 max-w-full overflow-x-auto border border-border-2 rounded-md px-[12px] py-[8px] bg-surface-2 text-[13px] font-mono transition-colors cursor-text hover:border-border-strong ' +
              (isEmpty ? 'text-muted' : 'text-fg')
            }
          >
            {isEmpty ? placeholderText : masked}
          </div>
        )}
        {/* 右侧固定 w-9 按钮槽：编辑态 ✓ / 展示非空 ✎ / 空态 invisible 占位防布局跳动 */}
        <div className="shrink-0 w-9 flex items-center justify-center">
          {editing ? (
            <button
              type="button"

              onClick={commit}
              onMouseDown={(e) => e.preventDefault()}
              aria-label={t('secretInput.commit')}
              title={t('secretInput.commit')}
              disabled={disabled}
              className="inline-flex items-center justify-center w-9 h-9 rounded-md border border-border-2 bg-surface text-fg hover:border-accent hover:text-accent transition-colors"
            >
              ✓
            </button>
          ) : !isEmpty && !disabled ? (
            <button
              type="button"

              onClick={enterEditing}
              aria-label={t('secretInput.edit')}
              title={t('secretInput.edit')}
              className="inline-flex items-center justify-center w-9 h-9 rounded-md border border-border-2 bg-surface text-fg hover:border-accent hover:text-accent transition-colors"
            >
              ✎
            </button>
          ) : (
            <span className="inline-block w-9 h-9 invisible" aria-hidden />
          )}
        </div>
      </div>
    </div>
  );
}

export default SecretInput;
