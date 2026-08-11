/**
 * component-export-team-picker-modal — 团队导出选择器 modal（v0.0.321）
 * 参考: specs/tech/version_logs/v0.0.321/change_plan.md D2（导出选择器）
 *       specs/prd/v0.0.321-team-export-picker.md UC-1（点导出 → 选团队 → 下载）
 *
 * 受控组件（open 由父级管理）：点「导出团队」后弹团队列表，
 * 选择一个团队 → 确定 → 父级调用 exportSquad 下载 zip。
 *
 * 4 态：loading（加载中）/ error（失败 + 重试）/ empty（无团队）/ normal（列表）。
 * 视觉对齐 ConfirmModal（fixed inset-0 遮罩 + 居中 card）。
 * 范式：即时操作 + L3 modal，无 SaveBar（team_sync 页 TAB_KV_GROUPS.team_sync = []）。
 */
import { useTranslation } from 'react-i18next';
import type { SquadSummary } from '../studio-page/squad-types';

export interface ExportTeamPickerModalProps {
  open: boolean;
  loading: boolean;
  error: string | null;
  squads: SquadSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onRetry: () => void;
}

/** 导出选择器父级状态（v0.0.321 D2：弹层 → listSquads → 选团队 → exportSquad） */
export interface ExportPickerState {
  open: boolean;
  loading: boolean;
  error: string | null;
  squads: SquadSummary[];
  selectedId: string | null;
}

/** 团队导出选择器（受控 modal；列表行点击高亮，底部确定/取消） */
export function ExportTeamPickerModal({
  open,
  loading,
  error,
  squads,
  selectedId,
  onSelect,
  onConfirm,
  onCancel,
  onRetry,
}: ExportTeamPickerModalProps) {
  const { t } = useTranslation('app-dev-config');
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="export-picker-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div className="rounded-lg bg-surface border border-border p-6 max-w-md w-full mx-4 shadow-lg">
        <h3 className="text-[15px] font-semibold text-fg mb-2">
          {t('team_sync.export_picker.title')}
        </h3>

        {/* 4 态：loading / error+重试 / empty / 列表 */}
        {loading ? (
          <p className="text-[13px] text-muted-2 py-6 text-center" data-testid="export-picker-loading">
            {t('team_sync.export_picker.loading')}
          </p>
        ) : error ? (
          <div className="py-4 flex flex-col items-center gap-3" data-testid="export-picker-error">
            <p className="text-[13px] text-red-500 m-0">{error}</p>
            <button
              type="button"
              data-testid="export-picker-retry-btn"
              onClick={onRetry}
              className="px-4 py-1.5 rounded-md text-sm border border-border text-fg-2 hover:bg-bg-warm"
            >
              {t('team_sync.export_picker.retry')}
            </button>
          </div>
        ) : squads.length === 0 ? (
          <p className="text-[13px] text-muted-2 py-6 text-center" data-testid="export-picker-empty">
            {t('team_sync.export_picker.empty')}
          </p>
        ) : (
          <ul
            data-testid="export-picker-list"
            className="max-h-[60vh] overflow-y-auto flex flex-col gap-1 mb-4"
          >
            {squads.map((s) => {
              const active = s.id === selectedId;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    data-testid={`export-picker-item-${s.id}`}
                    onClick={() => onSelect(s.id)}
                    className={`w-full text-left px-3 py-2 rounded-md border text-sm flex items-center justify-between gap-2 ${
                      active
                        ? 'border-accent bg-accent/10 text-fg'
                        : 'border-transparent hover:bg-bg-warm text-fg-2'
                    }`}
                  >
                    <span className="truncate">{s.name}</span>
                    <span className="text-[12px] text-muted-2 shrink-0">
                      {t('team_sync.export_picker.member_count', { count: s.memberCount })}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-action-key="common.confirm-modal.cancel"
            onClick={onCancel}
            className="px-4 py-1.5 rounded-md text-sm border border-border text-fg-2 hover:bg-bg-warm"
          >
            {t('team_sync.cancel_btn')}
          </button>
          <button
            type="button"
            data-testid="export-picker-confirm-btn"
            disabled={!selectedId || loading}
            onClick={onConfirm}
            className="px-4 py-1.5 rounded-md text-sm bg-accent text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('team_sync.export_picker.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ExportTeamPickerModal;
