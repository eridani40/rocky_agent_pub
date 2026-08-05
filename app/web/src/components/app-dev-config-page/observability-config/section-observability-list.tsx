/**
 * section-observability-list — 可观测性列表视图
 * 参考: specs/ui/components/app-dev-config-page/observability-config/section-observability-list.md
 *       设计稿视觉基线: reqs/v0.0.11/easy-opc-config-v10.html L399-458（list 视图）
 *
 * 职责：标题区 + provider-card 列表（component-obs-item）+ 「添加配置」卡 + 删除确认 modal。
 * 每项点击进入详情；启停 toggle 即时；删除经 modal 二次确认。
 * 边界：不管详情编辑（→ section-observability-detail）；不直接落库（归 tech manager / page）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ComponentObsItem } from './component-obs-item';
import { ComponentObsDeleteModal } from './component-obs-delete-modal';
import type { ObservabilityConfig } from './types';

interface SectionObservabilityListProps {
  /** 当前可观测性配置列表 */
  configs: ObservabilityConfig[];
  /** 点列表项 → 进 detail */
  onSelect: (id: string) => void;
  /** 点「添加配置」→ 进 detail（new） */
  onAdd: () => void;
  /** toggle 即时生效（不计 dirty） */
  onToggle: (id: string, enabled: boolean) => void;
  /** modal 确认后调用 */
  onDelete: (id: string) => void;
}

/** 列表视图 */
export function SectionObservabilityList({
  configs,
  onSelect,
  onAdd,
  onToggle,
  onDelete,
}: SectionObservabilityListProps) {
  // 待删项（modal 打开时持有；null 时 modal 不挂载）
  const [delTarget, setDelTarget] = useState<ObservabilityConfig | null>(null);
  // [v0.0.62 i18n] observability 文案走 app-dev-config ns
  const { t } = useTranslation('app-dev-config');

  return (
    <div className="flex flex-col">
      {/* 标题区 */}
      <div className="pt-0 px-1 pb-4">
        <p className="text-[12px] font-mono text-muted mt-0">
          {t('observability.sectionDesc')}
        </p>
      </div>

      {/* provider-card 列表 */}
      <div className="mt-4">
        {configs.map((c) => (
          <ComponentObsItem
            key={c.id}
            config={c}
            onSelect={onSelect}
            onToggle={onToggle}
            onDeleteRequest={(target) => setDelTarget(target)}
          />
        ))}

        {/* 添加配置卡（dashed border）— 列表为空时也显示（空列表态） */}
        <button
          type="button"
          data-action-key="settings.observability.create"
          onClick={onAdd}
          className="w-full border border-dashed border-border-strong rounded-[10px] px-5 py-4 mb-2 flex items-center gap-3.5 transition-colors hover:border-accent hover:bg-accent-surface"
        >
          {/* dashed icon 占位（设计稿 .add-card-icon：40×40 dashed muted） */}
          <div className="w-10 h-10 rounded-[10px] border border-dashed border-border-strong flex items-center justify-center shrink-0 text-muted">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
          </div>
          <div className="text-left">
            {/* 副标题文案对齐设计稿 inline（line 432）：「接入 Langfuse 等链路追踪平台」 */}
            <div className="text-[13px] font-semibold text-fg">{t('observability.addTitle')}</div>
            <div className="text-[11px] font-mono text-muted mt-0.5">
              {t('observability.addSubtitle')}
            </div>
          </div>
        </button>
      </div>

      {/* 删除 modal（条件渲染） */}
      {delTarget && (
        <ComponentObsDeleteModal
          target={delTarget}
          onCancel={() => setDelTarget(null)}
          onConfirm={(id) => {
            setDelTarget(null);
            onDelete(id);
          }}
        />
      )}
    </div>
  );
}

export default SectionObservabilityList;
