/**
 * component-case-table —— 每 case 评估结果行式表（分数 tag + 题目 + 正/负/中 标签）
 * 参考: specs/ui/components/academy-page/component-case-table.md
 *       demo 04-training-observe.html `.case-table / .case-row`
 */
import { useTranslation } from 'react-i18next';

/** case 行（section 从 TrainingTurnEntity.gradeResults + dataset items join 派生） */
export interface CaseRow {
  id: string;
  /** 0-10 分 */
  score: number;
  /** 题目（ellipsis） */
  question: string;
  level: 'positive' | 'negative' | 'neutral';
  /** 评估理由（可选，title 悬浮看） */
  reasoning?: string;
}

interface Props {
  cases: CaseRow[];
  /** 截断展示时提供 total > cases.length → 末行「… 共 N 条」 */
  total?: number;
}

/** 分数 → tag 配色（demo：>=8 sage / 6-7 gold / <=5 danger） */
function scoreCls(score: number): string {
  if (score >= 8) return 'bg-sage-bg text-sage';
  if (score >= 6) return 'bg-gold-bg text-[#b45309]';
  return 'bg-danger-light text-danger';
}

/** level → 标签配色 + i18n key */
const LEVEL_MAP = {
  positive: { cls: 'text-sage', key: 'caseTable.positive' },
  negative: { cls: 'text-danger', key: 'caseTable.negative' },
  neutral: { cls: 'text-[#b45309]', key: 'caseTable.neutral' },
} as const;

/** case 评估结果表（demo .case-table：border rounded-md overflow-hidden；行 bottom border） */
export function ComponentCaseTable({ cases, total }: Props) {
  const { t } = useTranslation('academy');
  const shown = cases.length;
  const truncated = total !== undefined && total > shown;
  return (
    <div>
      <div className="text-[11.5px] font-semibold text-fg-2 mb-1.5">
        {t('caseTable.title', { count: total ?? shown })}
      </div>
      <div className="border border-border rounded-md overflow-hidden bg-surface">
        {cases.map((c, i) => (
          <div
            key={c.id}
            title={c.reasoning}
            className={`flex items-center gap-[9px] px-[11px] py-[7px] text-[12px] ${i < cases.length - 1 || truncated ? 'border-b border-border' : ''}`}
          >
            <span className={`inline-flex items-center h-5 px-[7px] rounded-sm text-[11px] font-medium font-mono ${scoreCls(c.score)}`}>
              {c.score}
            </span>
            <span className="flex-1 min-w-0 truncate text-fg">{c.question}</span>
            <span className={`text-[12px] ${LEVEL_MAP[c.level].cls}`}>{t(LEVEL_MAP[c.level].key)}</span>
          </div>
        ))}
        {truncated && (
          <div className="flex items-center justify-center px-[11px] py-[7px] text-[12px] text-muted">
            {t('caseTable.total', { count: total })}
          </div>
        )}
      </div>
    </div>
  );
}

export default ComponentCaseTable;
