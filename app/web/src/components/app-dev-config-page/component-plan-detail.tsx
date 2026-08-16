/**
 * component-plan-detail — 方案详情独立页骨架（v0.0.347 T4 补丁）
 * 参考: components/providers/component-provider-detail.tsx（唯一风格基准，老板拍板「绝对一致」）
 *       specs/ui/components/app-dev-config-page/section-model-routing-plans.md
 *
 * 职责：组合方案详情页（面包屑回退 + logo 标题区 + 方案编辑器 + SaveBar）；
 *   风格逐项对齐 provider detail：面包屑（可点父级 / 标题）、logo 首字母块、
 *   mono 副标题、SaveBar variant="detail"（sticky bottom：dirty 状态 + 取消=重置 + 保存）。
 * 边界：不调后端；状态由父级 section 持有（快照回滚/保存流同 provider section 范式）。
 * [拆分报备] section 超 300 行门禁拆出 + 对称 provider 的 section/detail 文件结构。
 */
import { useTranslation } from 'react-i18next';
import { ModelRoutingPlanEditor } from './component-model-routing-plan-editor';
import { SaveBar } from '../common/component-save-bar';
import type { ModelRoutingPlan, ModelRoutingStatus } from './model-routing-types';
import type { ProviderItem } from '../../lib/providers';

export interface ComponentPlanDetailProps {
  /** 方案 draft（受控） */
  plan: ModelRoutingPlan;
  /** 与快照比对结果（SaveBar dirty 展示；取消按钮可见性） */
  dirty: boolean;
  /** 保存中（SaveBar saving） */
  saving: boolean;
  /** 方案红绿灯（详情打开时拉一次，item 行按 pid+mid 匹配，决策⑰） */
  status?: ModelRoutingStatus | null;
  /** [v0.0.349] providers 透传（dangling 存在性预检 + 逐行 invalid 红描边） */
  providers?: ProviderItem[];
  /** 服务端 400 透传 */
  serverError?: string | null;
  /** draft 变更 */
  onChange: (next: ModelRoutingPlan) => void;
  /** 面包屑回列表（决策⑨：快照回滚 + 退出；新建未保存 = 移除） */
  onBack: () => void;
  /** SaveBar 保存（PUT → 清快照 → 回列表） */
  onSave: () => void;
  /** SaveBar 取消（回快照，留在详情页——provider 同语义） */
  onReset: () => void;
}

/** 方案详情独立页（provider detail 风格基准） */
export function ComponentPlanDetail({
  plan, dirty, saving, status, serverError, providers, onChange, onBack, onSave, onReset,
}: ComponentPlanDetailProps) {
  const { t } = useTranslation('app-dev-config');
  const title = plan.name;

  return (
    <div className="flex flex-col" data-testid="plan-detail">
      {/* 面包屑：模型组合方案库（可点回退）/ {title}（provider detail 同款） */}
      <div className="mb-3 flex items-center gap-2 text-[13px]">
        <button
          type="button"
          data-testid="detail-back"
          data-action-key="settings.models.plan.back"
          onClick={onBack}
          className="font-mono text-muted transition-colors hover:text-accent"
        >
          {t('group.model_routing_plans.label')}
        </button>
        <span className="text-border-strong">/</span>
        <span data-testid="detail-title" className="font-medium text-fg">{title}</span>
      </div>

      {/* logo + 标题区（provider detail 同款：首字母块 + 标题 + mono 副标题） */}
      <div className="mb-4 flex items-center gap-3">
        <div
          aria-hidden
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px] bg-sage-bg text-sage"
        >
          <span className="font-sans text-[24px] font-bold leading-none">
            {title[0]?.toUpperCase() ?? '?'}
          </span>
        </div>
        <div className="min-w-0">
          <div className="truncate text-[16px] font-semibold text-fg">{title}</div>
          <div className="font-mono text-[11px] text-muted">plan · model routing</div>
        </div>
      </div>

      {/* 方案编辑器主体（条目 7 列行 + 熔断区，冻结不动） */}
      <ModelRoutingPlanEditor
        value={plan}
        onChange={onChange}
        serverError={serverError}
        status={status}
        providers={providers}
      />

      {/* SaveBar（provider detail 同款：sticky bottom + 取消=重置 + 保存） */}
      <SaveBar
        variant="detail"
        dirty={dirty}
        saving={saving}
        saveTestId="plan-editor-save"
        cancelTestId="plan-editor-cancel"
        onSave={onSave}
        onCancel={onReset}
      />
    </div>
  );
}

export default ComponentPlanDetail;
