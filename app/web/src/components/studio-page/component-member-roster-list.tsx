/**
 * component-member-roster-list —— 统一成员列表组件（v0.0.288 抽取）
 * 参考: specs/ui/components/studio-page/component-member-roster-list.md（组件契约）
 *       specs/prd/version_logs/v0.0.288.studio_layout/prd.md §D2/F5-F9
 *       specs/tech/version_logs/v0.0.288.studio_layout/change_plan.md（裁决1）
 *
 * 职责：
 *   - PanelRowView：单行渲染（整行 button 进对话；hover chat icon；防套娃；三分区 variant 灰度策略）
 *   - MemberRosterList：三分区分组渲染（running/idle/benched），showBenched 控制是否渲染 benched 区
 *
 * 统一消费方：chat 弹层（showBenched=false）+ 首页 SeatsBody 成员卡（showBenched=view==='all'）
 * 从 squad-status-modal.tsx 迁出 PanelRowView（isIdle 二元 → variant 三元 'running'|'idle'|'benched'）。
 */
import { useTranslation } from 'react-i18next';
import { MemberAvatar, type MemberAvatarRole } from '../common/member-avatar';
import { SpinnerRing } from '../common/spinner-ring';
import type { PanelRow, PanelRows } from './squad-status-utils';
import { Icon } from './studio-icons';

/** 行 variant 三态（对应三分区；各自灰度策略） */
export type PanelRowVariant = 'running' | 'idle' | 'benched';

/**
 * 面板单行渲染（整行 button 进入对话；hover 显示 chat icon；防套娃行不渲染 icon）
 * [v0.0.288] 从 squad-status-modal.tsx 迁出 + isIdle 二元 → variant 三元
 *   - running：正常色 + SpinnerRing 动态标识
 *   - idle：弱化 opacity-[0.85] + text-fg-2 + 色块降透明度（idle 口径不变）
 *   - benched：更灰 opacity-[0.55] + text-muted-2 + avatar grayscale（比 idle 更难看清）
 * export 供单测直接构造行验证。
 */
export function PanelRowView({
  row,
  currentMemberId,
  onEnterChat,
  variant = 'running',
}: {
  row: PanelRow;
  currentMemberId?: string;
  onEnterChat: (memberId: string) => void;
  /** 分区 variant（running/idle/benched 各自灰度策略） */
  variant?: PanelRowVariant;
}) {
  const { t } = useTranslation('studio');
  // presence 文字：currentWork 优先，空则 seats.status.{presence} i18n fallback（与 seats 同源）
  const statusText =
    row.statusTextSource.kind === 'currentWork'
      ? row.statusTextSource.text
      : t(`seats.status.${row.presence}` as const);
  // 防套娃：当前查看 chat 会话所属 member 行不显示进入对话 icon（用户已在其中）
  const isSelf = row.member.id === currentMemberId;

  // [v0.0.292] Leader 行反色高亮——优先级最高，覆盖 variant 灰度策略（leader 恒反色 bg-fg-2，同 user 气泡色系）
  if (row.isLeader) {
    return (
      <button
        type="button"
        data-testid={`squad-status-row-${row.member.id}`}
        onClick={() => onEnterChat(row.member.id)}
        className="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors bg-fg-2 hover:bg-fg-2/90"
      >
        {/* avatar 保持原色不反色（角色色在黑底上辨识度更好） */}
        <span>
          <MemberAvatar
            name={row.member.name}
            role={row.member.role as MemberAvatarRole}
            id={row.member.id}
            size="sm"
            showName={false}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span className="truncate text-[12.5px] font-medium text-surface">
              {row.member.name}
            </span>
            {/* Leader badge 强化：半透明白底 + 白字 + 加大 + semibold */}
            <span className="shrink-0 rounded-xs px-1 py-px font-mono text-[10.5px] font-semibold bg-white/15 text-white/80">
              {t('role.leader')}
            </span>
            {/* running 动态标识保持（leader 恒在 running 分区首位） */}
            {variant === 'running' && <SpinnerRing size="sm" />}
          </span>
          <span className="block truncate text-[11px] text-white/60">{statusText}</span>
        </span>
        {/* hover 进入对话 icon：白字色调适配反色底 */}
        {!isSelf && (
          <span className="shrink-0 text-white/70 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden>
            <Icon name="chat" size={14} />
          </span>
        )}
      </button>
    );
  }

  // benched 比 idle 更灰：opacity 更低 + 文字更淡 + avatar 灰度
  const isBenched = variant === 'benched';
  // idle 弱化（offline 不叠加——防御：弹层/在岗无 offline 行；保持现状语义）
  const isIdle = variant === 'idle' && row.presence !== 'offline';
  return (
    <button
      type="button"
      data-testid={`squad-status-row-${row.member.id}`}
      onClick={() => onEnterChat(row.member.id)}
      className={[
        'group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2',
        isBenched ? 'opacity-[0.55]' : isIdle ? 'opacity-[0.85]' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* 色卡（avatar）：idle 降透明度 / benched 灰度滤镜+额外降透明度（色块变灰，叠乘于行根 opacity） */}
      <span className={isBenched ? 'opacity-50 grayscale' : isIdle ? 'opacity-70' : ''}>
        <MemberAvatar
          name={row.member.name}
          role={row.member.role as MemberAvatarRole}
          id={row.member.id}
          size="sm"
          showName={false}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1">
          {/* title（成员名）：idle → text-fg-2 / benched → text-muted-2（比 idle 更淡） */}
          <span
            className={[
              'truncate text-[12.5px] font-medium',
              isBenched ? 'text-muted-2' : isIdle ? 'text-fg-2' : 'text-fg',
            ].join(' ')}
          >
            {row.member.name}
          </span>
          {/* 色块（role badge）：idle/benched 底色降透明度（变灰） */}
          <span
            className={[
              'shrink-0 rounded-xs px-1 py-px font-mono text-[10px] text-muted',
              isBenched || isIdle ? 'bg-bg-warm/50' : 'bg-bg-warm',
            ].join(' ')}
          >
            {t('role.mate')}
          </span>
          {/* running 动态标识：running 分区行渲染 SpinnerRing（accent 旋转环 + shrink-0 占位防位移） */}
          {variant === 'running' && <SpinnerRing size="sm" />}
        </span>
        <span className="block truncate text-[11px] text-muted">{statusText}</span>
      </span>
      {/* hover 进入对话 icon：opacity 切换保留占位（布局稳定，不位移）；防套娃行不渲染 */}
      {!isSelf && (
        <span className="shrink-0 text-fg-2 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden>
          <Icon name="chat" size={14} />
        </span>
      )}
    </button>
  );
}

/** MemberRosterList 组件 Props */
export interface MemberRosterListProps {
  /** 三分区派生结果（derivePanelRows 返回值） */
  rows: PanelRows;
  /** 当前查看 chat 会话所属 member id（防套娃；弹层=chrome.memberId，首页=undefined 全显 icon） */
  currentMemberId?: string;
  /** 进入对话回调 */
  onEnterChat: (memberId: string) => void;
  /** false=弹层/在岗（running+idle）；true=全部（三分区含 benched） */
  showBenched: boolean;
}

/**
 * 统一成员列表组件：按 running/idle/benched 三分区渲染（每区分区标题 + 行列表）。
 * showBenched=false 只渲染 running+idle（弹层/在岗视图）；showBenched=true 渲染三分区（全部视图）。
 * 某区无成员 → 不渲染该区标题和行；三区全空 → 空态文案（seats.emptyMembers）。
 */
export function MemberRosterList({
  rows,
  currentMemberId,
  onEnterChat,
  showBenched,
}: MemberRosterListProps) {
  const { t } = useTranslation('studio');
  const hasRunning = rows.running.length > 0;
  const hasIdle = rows.idle.length > 0;
  const hasBenched = showBenched && rows.benched.length > 0;
  const isEmpty = !hasRunning && !hasIdle && !hasBenched;

  if (isEmpty) {
    return <div className="px-4 py-6 text-center text-xs text-muted">{t('seats.emptyMembers')}</div>;
  }

  return (
    <div className="flex flex-col">
      {/* running 区（上） */}
      {hasRunning && (
        <div className="pb-1 pt-1">
          <div className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
            running · {rows.running.length}
          </div>
          {rows.running.map((row) => (
            <PanelRowView
              key={row.member.id}
              row={row}
              currentMemberId={currentMemberId}
              onEnterChat={onEnterChat}
              variant="running"
            />
          ))}
        </div>
      )}
      {/* idle 区（中） */}
      {hasIdle && (
        <div className="pb-1 pt-1">
          <div className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
            idle · {rows.idle.length}
          </div>
          {rows.idle.map((row) => (
            <PanelRowView
              key={row.member.id}
              row={row}
              currentMemberId={currentMemberId}
              onEnterChat={onEnterChat}
              variant="idle"
            />
          ))}
        </div>
      )}
      {/* benched 区（下；showBenched=true 时渲染） */}
      {hasBenched && (
        <div className="pb-1 pt-1">
          <div className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
            benched · {rows.benched.length}
          </div>
          {rows.benched.map((row) => (
            <PanelRowView
              key={row.member.id}
              row={row}
              currentMemberId={currentMemberId}
              onEnterChat={onEnterChat}
              variant="benched"
            />
          ))}
        </div>
      )}
    </div>
  );
}
