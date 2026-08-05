/**
 * component-skill-source-filter — 「我的」列表上方的来源筛选条
 * 参考: specs/ui/components/skill-page/component-skill-source-filter.md
 *
 * 受控组件：父 page-skill 下发 active + onChange，自身不持有状态。
 * 导出纯函数 filterSkillsBySource（UT 友好）+ SkillSourceFilter type。
 * Rocky tab 复用 common/primitive-tooltip 挂 hover。
 */
import { useTranslation } from 'react-i18next';
import type { SkillEntry } from '../../lib/api-client';
import { PrimitiveTooltip } from '../common/primitive-tooltip';

/** 来源筛选类型：4 类标识符，与 PRD §2.2 来源映射表一一对应 */
export type SkillSourceFilter = 'all' | 'builtin' | 'market' | 'rocky';

/**
 * 按 filter 过滤 skills 数组（纯函数无副作用）。
 * 来源映射（严格对齐 PRD §2.2）：
 *   - 'all'     → 原数组 passthrough（不拷贝，调用方不 mutate）
 *   - 'builtin' → scope === 'builtin'
 *   - 'market'  → Boolean(marketRef)
 *   - 'rocky'   → productionMethod === 'consolidation'
 * 边界：productionMethod undefined 不归 rocky；4 类按精确单一条件，不做交集。
 */
export function filterSkillsBySource(
  skills: SkillEntry[],
  filter: SkillSourceFilter,
): SkillEntry[] {
  switch (filter) {
    case 'all':
      return skills;
    case 'builtin':
      return skills.filter((s) => s.scope === 'builtin');
    case 'market':
      return skills.filter((s) => Boolean(s.marketRef));
    case 'rocky':
      return skills.filter((s) => s.productionMethod === 'consolidation');
    default:
      return skills;
  }
}

interface SourceFilterProps {
  /** 当前激活的来源筛选 */
  active: SkillSourceFilter;
  /** 切换筛选回调 */
  onChange: (filter: SkillSourceFilter) => void;
}

/** 4 个选项的 id 列表（顺序对应「全部/内置/市场/Rocky」） */
const FILTERS: SkillSourceFilter[] = ['all', 'builtin', 'market', 'rocky'];

/**
 * 渲染来源筛选条。视觉与 component-skill-tabs 同色系（13px/600 + accent 激活 + 底 2px 下划线）。
 * Rocky tab 包一层 PrimitiveTooltip，hover/focus 显示「来自于 Rocky 的自我迭代和进化」。
 */
export function ComponentSkillSourceFilter({ active, onChange }: SourceFilterProps) {
  const { t } = useTranslation('skill');
  return (
    <div
      role="radiogroup"
      aria-label={t('sourceFilter.ariaLabel')}
      className="flex gap-1 mb-[14px]"
    >
      {FILTERS.map((f) => {
        const isActive = f === active;
        // Rocky tab 文案外层包 tooltip（hover/focus 触发）
        const label = t(`sourceFilter.${f}`);
        const option = (
          <div
            key={f}
            data-action-key={`skill.skill.filter-${f}`}
            role="radio"
            aria-checked={isActive}
            tabIndex={0}
            onClick={() => onChange(f)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onChange(f);
              }
            }}
            className={
              'text-[12px] font-semibold px-[10px] py-[5px] border-b-2 -mb-px cursor-pointer transition-colors ' +
              (isActive
                ? 'text-accent border-accent'
                : 'text-muted-2 border-transparent hover:text-fg-2')
            }
          >
            {label}
          </div>
        );
        // Rocky 挂 tooltip
        return f === 'rocky' ? (
          <PrimitiveTooltip key={f} content={t('sourceFilter.rockyTooltip')} side="top">
            {option}
          </PrimitiveTooltip>
        ) : (
          option
        );
      })}
    </div>
  );
}

export default ComponentSkillSourceFilter;
