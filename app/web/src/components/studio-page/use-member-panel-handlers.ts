/**
 * use-member-panel-handlers —— member 面板保存 handler
 * 参考: specs/api/overall/11a-squad-endpoints.md §2（PATCH /member）
 *
 * [v0.0.116] 删除 onSaveHeartbeat（per-member heartbeat 端点废弃；心跳改走 PATCH /squad heartbeatConfig）。
 */
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { PatchMemberBody, SquadDetail } from './squad-types';
import { patchMember } from '../../lib/squad-api';

interface UseMemberPanelHandlersOpts {
  squadId: string | null;
  detail: SquadDetail | null;
  /** 保存成功后刷新（page-studio.refresh：重拉 detail + 列表 + bump） */
  onSaved: () => Promise<void>;
  flash: (msg: string) => void;
}

/** member 面板保存 handler */
export function useMemberPanelHandlers({ squadId, detail, onSaved, flash }: UseMemberPanelHandlersOpts) {
  const { t } = useTranslation('studio');
  const onSaveMember = useCallback(
    async (memberId: string, patch: PatchMemberBody) => {
      if (!squadId) return;
      await patchMember(squadId, memberId, patch);
      await onSaved();
      flash(t('toast.roleSaved'));
    },
    [squadId, onSaved, flash, t],
  );

  return {
    onSaveMember,
    squadTimezone: detail?.timezone,
    squadEnableHeartBeat: detail?.enableHeartBeat,
  };
}
