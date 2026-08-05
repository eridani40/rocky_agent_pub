/**
 * migration-error-modal —— 启动期迁移错误提示 modal（v0.0.150）
 * 参考: specs/ui/components/framework/migration-error-modal.md（设计要求 + testid 契约）
 *       specs/tech/version_logs/v0.0.150/change_plan.md §C（前端报错通道）
 *
 * 受控 modal：show 状态由 caller（AppShell）管。errors.length > 0 时 caller 渲染本组件。
 *
 * 走 createPortal（<Portal> 包到 overlay-root）——避 pointer-events 祖先链坑
 * （memory `css-pointer-events-inherits-dom-not-position`：modal 在 pointer-events:none
 * 祖先链里不可交互，必须 portal 脱离）。
 *
 * 多错聚合一条：「N 个迁移失败，详情见日志」+ 可展开列表（默认折叠）。
 * 主按钮「确定」+ 次按钮「打开日志目录」。
 */
import { useState } from 'react';
import { Portal } from '../../../lib/portal';

/** 错误条目（与后端 migrationErrors schema 对齐） */
export interface MigrationErrorItem {
  id: string;
  message: string;
  stack?: string;
}

interface MigrationErrorModalProps {
  /** 错误列表；空数组时 caller 不渲染（本组件不做空数组兜底，由 caller 管显示门控） */
  errors: MigrationErrorItem[];
  /** 确认按钮 → caller 关闭 modal */
  onConfirm: () => void;
  /** 打开日志目录按钮 → caller 走 IPC 打开 DATA_DIR/logs（无现成通道则 noop + TODO） */
  onOpenLogDir: () => void;
}

/**
 * 迁移错误提示 modal。
 *
 * 多错聚合：标题「迁移失败」+ 说明「N 个迁移失败，详情见日志。」
 * + 可展开详情列表（默认折叠，点「查看详情」切换）。
 *
 * 不点遮罩关闭（强制用户点「确定」确认——避免误触吞掉错误提示）。
 */
export function MigrationErrorModal({
  errors,
  onConfirm,
  onOpenLogDir,
}: MigrationErrorModalProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Portal>
      <div

        // z=`--z-modal`(1000) + pointer-events-auto（与其他 L3 modal 统一，避祖先 none 链）
        className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/40 pointer-events-auto"
      >
        <div
          className="bg-surface border border-border rounded-xl shadow-lg max-w-[440px] w-[90%] p-5"
          onClick={(e) => e.stopPropagation()}
        >
          <h3 className="text-[15px] font-semibold text-fg mb-2">迁移失败</h3>
          <p className="text-[13px] text-muted leading-relaxed mb-3">
            {errors.length} 个迁移失败，详情见日志。
          </p>
          <button
            type="button"
            data-action-key="framework.migration-error.toggle-detail"
            onClick={() => setExpanded((v) => !v)}
            className="text-[12px] text-accent underline mb-3"
          >
            {expanded ? '收起详情' : '查看详情'}
          </button>
          {expanded && (
            <ul className="mb-4 max-h-[200px] overflow-auto space-y-1">
              {errors.map((e, i) => (
                <li
                  key={`${e.id}-${i}`}

                  className="text-[12px] text-muted"
                >
                  <span className="font-mono">{e.id}</span>: {e.message}
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              data-action-key="framework.migration-error.open-log-directory"
              onClick={onOpenLogDir}
              className="px-3 py-1.5 rounded-lg text-[13px] text-muted hover:bg-bg-warm transition-colors"
            >
              打开日志目录
            </button>
            <button
              type="button"
              data-action-key="framework.migration-error.confirm"
              onClick={onConfirm}
              className="px-3 py-1.5 rounded-lg text-[13px] text-white bg-accent hover:bg-accent-strong transition-colors"
            >
              确定
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

export default MigrationErrorModal;
