/**
 * component-pending-question-block —— 提问卡「单题选项区块」（component-pending-question-card 的内容区）
 * 权威 spec: specs/ui/components/chat-page/component-pending-question-card.md
 *
 * 竖向步骤导航下只渲染 active 题的本区块。单选=radio / 多选=checkbox；选项点击走
 * label.onClick + preventDefault（统一 toggle 语义，radio 原生点击不变 checked 故需绕过）；input 受控
 * checked 由 selections 派生；「其他」恒定渲染为选项列表末位（不再受 allowOther 门控），
 * toggle 展开自适应 textarea，值 `其他：<text>`。
 */
import type { useTranslation } from 'react-i18next';
import type { PendingQuestion } from './types';

export interface PendingQuestionBlockProps {
  q: PendingQuestion;
  /** 该题当前 selection（含「其他：<text>」） */
  sel: string[];
  /** 该题「其他」是否展开 */
  isOpen: boolean;
  /** 该题「其他」输入框文本 */
  otherValue: string;
  toggleOption: (q: PendingQuestion, key: string) => void;
  toggleOther: (q: PendingQuestion) => void;
  setOther: (qId: string, text: string) => void;
  t: ReturnType<typeof useTranslation>['t'];
}

/**
 * 单题选项区块：题干 + 选项（radio/checkbox）+ 「其他」toggle/输入框。
 */
export function PendingQuestionBlock({ q, sel, isOpen, otherValue, toggleOption, toggleOther, setOther, t }: PendingQuestionBlockProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {/* 题目全标题 + 多选标记（导航项上标题可能被截断，内容区展示完整题干） */}
      <div className="flex items-center gap-1.5">
        <span className="text-[12.5px] font-medium text-fg">{q.title}</span>
        {q.type === 'multi' && (
          <span className="text-[10px] font-mono text-muted">[{t('pendingQuestion.multi', { defaultValue: '多选' })}]</span>
        )}
      </div>
      {/* 选项列表（radio / checkbox）—— 竖向堆叠（每项独占一行 pill，flex-col items-start） */}
      <div className="flex flex-col items-start gap-1.5">
        {q.options.map((opt) => {
          const checked = sel.includes(opt.key);
          return (
            <label
              key={opt.key}

              onClick={(e) => {
                e.preventDefault(); // 阻止原生 radio/checkbox 自动翻转（统一走 toggleOption）
                toggleOption(q, opt.key);
              }}
              className={
                'inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[12px] cursor-pointer transition-colors ' +
                (checked
                  ? 'border-[var(--color-accent)] bg-accent-light text-accent'
                  : 'border-border bg-surface text-fg-2 hover:border-[var(--color-accent)]')
              }
            >
              <input
                type={q.type === 'single' ? 'radio' : 'checkbox'}
                name={`pending-q-${q.id}`}
                checked={checked}
                onChange={() => toggleOption(q, opt.key)}
                // pointer-events 关闭：click 由 label 接管（统一 toggle，radio 原生 onChange 不支持切掉）
                style={{ pointerEvents: 'none' }}
                className="accent-[var(--color-accent)]"
                tabIndex={-1}
              />
              <span>{opt.label}</span>
            </label>
          );
        })}
        {/* 「其他」选项：恒定渲染为每题末位（前端不再消费 allowOther 字段）；单选用 radio（同组互斥）/ 多选用 checkbox */}
        <label
          onClick={(e) => {
            e.preventDefault();
            toggleOther(q);
          }}
          className={
            'inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[12px] cursor-pointer transition-colors ' +
            (isOpen
              ? 'border-[var(--color-accent)] bg-accent-light text-accent'
              : 'border-border bg-surface text-fg-2 hover:border-[var(--color-accent)]')
          }
        >
          <input
            type={q.type === 'single' ? 'radio' : 'checkbox'}
            name={`pending-q-${q.id}`}
            checked={isOpen}
            onChange={() => toggleOther(q)}
            style={{ pointerEvents: 'none' }}
            className="accent-[var(--color-accent)]"
            tabIndex={-1}
          />
          <span>{t('pendingQuestion.other', { defaultValue: '其他' })}</span>
        </label>
      </div>
      {/* 「其他」展开输入框（toggle 选中后可见）——自适应 textarea：1 行起，最高 ~5 行/120px 后内部滚动 */}
      {isOpen && (
        <textarea
          value={otherValue}
          onChange={(e) => {
            const el = e.target;
            setOther(q.id, el.value);
            el.style.height = 'auto';
            el.style.height = Math.min(el.scrollHeight, 120) + 'px';
          }}
          placeholder={t('pendingQuestion.otherPlaceholder', { defaultValue: '请输入其他答案' })}
          rows={1}
          className="ml-1 px-2 py-1 rounded-md border border-border bg-surface text-[12px] text-fg outline-none focus:border-[var(--color-accent)] max-w-[360px] w-full resize-none max-h-[120px] overflow-y-auto"
        />
      )}
    </div>
  );
}

export default PendingQuestionBlock;
