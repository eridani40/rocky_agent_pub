/**
 * component-plan-card — 方案卡片（v0.0.347 模型路由 UI v2 外层列表）
 * 参考 specs/prd/model-routing-demo-v2.html（冻结视觉契约：plan-card）
 *       specs/tech/version_logs/v0.0.347/change_plan.md 决策⑨/⑩/⑯
 *
 * 职责：单张方案卡片的展示 + 交互回调（无数据流逻辑）：
 *   名称（rename inline 态 input）/ N 个模型 / 模型名 · join / 挂载徽章 / ⋯ 菜单
 *   （重命名/复制/删除）/ chevron；整卡点击进详情。
 * 边界：受控展示组件；状态（菜单开合/重命名草稿/挂载数据）由父级 section 持有。
 * [拆分报备] section 超 300 行硬门禁拆出（change_plan 风险点 6 授权）。
 */
import { useTranslation } from 'react-i18next';
import type { ModelRoutingPlan } from './model-routing-types';

export interface PlanCardProps {
  /** 方案数据 */
  plan: ModelRoutingPlan;
  /** 挂载名列表（空 = 未挂载；listPlanMounts 聚合，决策⑯） */
  mounted: string[];
  /** ⋯ 菜单开合（父级单开态） */
  menuOpen: boolean;
  /** 重命名草稿（planId 匹配本卡 = inline input 态；BUG-002 受控语义） */
  renameDraft: { planId: string; value: string } | null;
  /** 整卡点击进详情 */
  onOpen: () => void;
  /** ⋯ 菜单开合切换 */
  onMenuToggle: () => void;
  /** 进入重命名态（草稿初值 = 原名） */
  onRenameStart: () => void;
  /** 重命名输入变化（受控） */
  onRenameChange: (value: string) => void;
  /** 重命名提交（Enter/blur；空/未变更不 PUT 由父级校验） */
  onRenameCommit: () => void;
  /** 重命名取消（Escape） */
  onRenameCancel: () => void;
  /** 复制 */
  onCopy: () => void;
  /** 删除（父级弹 ConfirmModal） */
  onDeleteRequest: () => void;
}

/** 单张方案卡片（demo plan-card 形态） */
export function PlanCard({
  plan, mounted, menuOpen, renameDraft,
  onOpen, onMenuToggle, onRenameStart, onRenameChange, onRenameCommit, onRenameCancel, onCopy, onDeleteRequest,
}: PlanCardProps) {
  const { t } = useTranslation('app-dev-config');
  const renaming = renameDraft?.planId === plan.id;
  const names = plan.items.map((it) => it.modelId).filter(Boolean);
  return (
    <div
      data-testid="plan-card"
      data-plan-id={plan.id}
      className="flex cursor-pointer items-center gap-3.5 rounded-lg border border-border bg-surface px-[18px] py-4 transition-colors hover:border-border-strong hover:shadow-sm"
      onClick={onOpen}
    >
      {/* 主区：名称（rename inline 态）+ meta（模型数 + 模型名 join） */}
      <div className="min-w-0 flex-1" onClick={(e) => renaming && e.stopPropagation()}>
        {renaming ? (
          <input
            data-testid="plan-rename-input"
            className="w-40 rounded border border-border-2 bg-surface px-1.5 py-0.5 text-[14px] font-semibold text-fg outline-none"
            value={renameDraft!.value}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onRenameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRenameCommit();
              if (e.key === 'Escape') onRenameCancel();
            }}
            onBlur={onRenameCommit}
          />
        ) : (
          <div data-testid="plan-card-name" className="mb-0.5 text-[14px] font-semibold text-fg">{plan.name}</div>
        )}
        <div className="flex items-baseline gap-2.5 text-[12px] text-muted">
          <span className="shrink-0">{t('modelRouting.list.modelsCount', { count: plan.items.length })}</span>
          <span className="truncate font-mono text-[11px] text-fg-3">{names.length > 0 ? names.join(' · ') : '—'}</span>
        </div>
      </div>
      {/* 挂载徽章（listPlanMounts 聚合；空 = 未挂载灰） */}
      <span
        data-testid="plan-mount-badge"
        className={
          'shrink-0 whitespace-nowrap rounded px-2 py-[3px] text-[11px] ' +
          (mounted.length > 0 ? 'bg-success-light text-success' : 'bg-surface-2 text-muted')
        }
      >
        {mounted.length > 0 ? t('modelRouting.list.mountedTo', { names: mounted.join('、') }) : t('modelRouting.list.unmounted')}
      </span>
      {/* ⋯ 菜单（决策⑩：重命名/复制/删除） */}
      <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          data-testid="plan-card-menu"
          data-keep-popover
          aria-label={t('modelRouting.list.moreActions')}
          className="flex h-7 w-7 items-center justify-center rounded text-[18px] leading-none text-muted hover:bg-surface-2 hover:text-fg-2"
          onClick={onMenuToggle}
        >
          ⋯
        </button>
        {menuOpen && (
          <div
            data-testid="plan-menu"
            data-keep-popover
            className="absolute right-0 top-full z-[var(--z-popover)] mt-1 min-w-[120px] overflow-hidden rounded-lg border border-border-2 bg-surface shadow-lg"
          >
            <button type="button" data-testid="plan-rename" className="block w-full px-3.5 py-2 text-left text-[13px] hover:bg-surface-2" onClick={onRenameStart}>
              {t('modelRouting.list.rename')}
            </button>
            <button type="button" data-testid="plan-copy" className="block w-full px-3.5 py-2 text-left text-[13px] hover:bg-surface-2" onClick={onCopy}>
              {t('modelRouting.list.copy')}
            </button>
            <button type="button" data-testid="plan-delete" className="block w-full px-3.5 py-2 text-left text-[13px] text-danger hover:bg-danger-light" onClick={onDeleteRequest}>
              {t('modelRouting.list.delete')}
            </button>
          </div>
        )}
      </div>
      <span className="shrink-0 text-[16px] text-muted-2">›</span>
    </div>
  );
}

export default PlanCard;
