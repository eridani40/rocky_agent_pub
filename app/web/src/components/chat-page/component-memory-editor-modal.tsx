/**
 * component-memory-editor-modal —— memory entry 新建/编辑弹层（app config global scope 用）
 * 参考: specs/ui/components/chat-page/component-memory-editor-modal.md
 *       specs/ui/components/chat-page/component-memory-editor-fields.md（表单字段权威，v0.0.131 抽出）
 *       specs/api/overall/15-memory-ui.md §4（POST）/§5（PATCH）
 *
 * [v0.0.131] 表单字段委托给 ComponentMemoryEditorFields（DRY，字段/校验/testid 契约不变）；
 * 本组件仅保留 fixed 遮罩 + 居中卡片壳 + head（标题 + 关闭按钮）。app config
 * section-user-memory（global scope）用法完全不变（零行为回归）：受控 open + initial 由父持有，
 * open===true 才挂载 ComponentMemoryEditorFields（挂载即初始化表单，卸载即丢弃残留输入）。
 *
 * 视觉：固定遮罩 + 居中卡片（自含 shell，不依赖 studio ModalShell，chat-page 不应跨依赖）。
 */
import { useTranslation } from 'react-i18next';
import type { MemoryType, MemoryWriteInput } from '../../lib/memory-api';
import { ComponentMemoryEditorFields } from './component-memory-editor-fields';

export interface MemoryEditorInitial {
  /** undefined = 新建模式（name 可输入） */
  name?: string;
  /** 一句话摘要（v0.0.114 由 `description` 改名） */
  intro?: string;
  type?: MemoryType;
  body?: string;
  why?: string;
  howToApply?: string;
  /** 编辑态回填该条实际 evolvable；新建缺省 false */
  evolvable?: boolean;
}

export interface MemoryEditorModalProps {
  open: boolean;
  /** undefined → 新建；object → 编辑（name 锁定） */
  initial?: MemoryEditorInitial;
  /** 取消（取消按钮 / × 关闭按钮；遮罩点击不关闭，防误丢输入） */
  onClose: () => void;
  /** 保存 → 父调 POST/PATCH（成功后父负责 refetch + 关闭 modal） */
  onSave: (entry: MemoryWriteInput) => Promise<void> | void;
}

/**
 * 新建/编辑 modal。open=false 不渲染（含表单一并卸载，避免残留输入）；
 * open=true 挂载壳 + ComponentMemoryEditorFields（据 initial 初始化表单）。
 */
export function ComponentMemoryEditorModal({
  open,
  initial,
  onClose,
  onSave,
}: MemoryEditorModalProps) {
  const editing = !!initial?.name;
  const { t: tChat } = useTranslation('chat');
  const { t: tCommon } = useTranslation('common');

  if (!open) return null;

  return (
    // 遮罩：fixed 全屏 + 半透明。编辑器类弹窗禁用遮罩点击关闭（防误丢输入），仅走显式关闭入口
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-[rgba(30,25,20,0.45)] backdrop-blur-sm"
    >
      <div

        role="dialog"
        aria-modal="true"
        aria-label={editing ? tChat('memory.editor.editTitle') : tChat('memory.editor.createTitle')}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[88vh] w-[520px] max-w-[92vw] flex-col rounded-[14px] border border-border-2 bg-surface shadow-2xl"
      >
        {/* head */}
        <div className="flex shrink-0 items-center justify-between px-[22px] pt-[18px] pb-3">
          <div className="text-[15px] font-bold text-fg">
            {editing ? tChat('memory.editor.editTitle') : tChat('memory.editor.createTitle')}
          </div>
          <button
            type="button"

            aria-label={tCommon('modal.close')}
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg-warm hover:text-fg"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* body：表单字段委托 ComponentMemoryEditorFields（DRY，v0.0.131） */}
        <div className="flex flex-col gap-3 overflow-y-auto px-[22px] pb-5">
          <ComponentMemoryEditorFields
            initial={initial}

            onCancel={onClose}
            onSave={onSave}
          />
        </div>
      </div>
    </div>
  );
}

export default ComponentMemoryEditorModal;
