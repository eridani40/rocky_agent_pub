/**
 * component-pending-question-nav —— 提问卡「竖向步骤导航」（component-pending-question-card 的左列）
 * 权威 spec: specs/ui/components/chat-page/component-pending-question-card.md
 *
 * 竖向导航取代原横向 tab 条（桌面鼠标滚轮无法横滚）：竖滚 = 滚轮原生方向，题数无上限（不硬截断）。
 * 左列收窄为纯序号竖 tab：每格只放序号 Q01（两位 padStart，font-mono 等宽不跳变）+ 状态圆点
 * （未答=accent 橙 / 已答=sage 绿，提交前一眼看出哪题没答）；题目标题不在导航重复——内容区有完整题干。
 * 去胶囊走经典竖 tab 切换：active 项 bg-surface 与右侧内容区（同 bg-surface）无缝连通成一体；
 * 非 active 透明底 text-muted + hover bg-surface/60 过渡。
 * focus-follows：onClick + onFocus 都切 active 题；稳定 key=q.id + active 变更不 remount → 焦点不丢、Tab 序列连续。
 */
import type { PendingQuestion } from './types';

export interface PendingQuestionNavProps {
  questions: PendingQuestion[];
  /** 当前展示的题 id（active 项 bg-surface 高亮，与内容区连通） */
  activeQuestionId: string;
  /** 某题是否已答（状态圆点用） */
  isAnswered: (qId: string) => boolean;
  /** 切换 active 题（click 与 focus 共用同一入口） */
  onSelect: (qId: string) => void;
}

/**
 * 竖向步骤导航列：固定宽 w-14（~56px）不收缩、无右 padding（tab 顶到内容区左缘），题多仅本列纵向滚动。
 */
export function PendingQuestionNav({ questions, activeQuestionId, isAnswered, onSelect }: PendingQuestionNavProps) {
  return (
    <div className="w-14 shrink-0 overflow-y-auto scrollbar-thin flex flex-col">
      {questions.map((q, qi) => {
        const active = q.id === activeQuestionId;
        const answered = isAnswered(q.id);
        return (
          <button
            key={q.id}
            type="button"
            data-testid={`pending-q-nav-${q.id}`}
            // focus-follows：键盘 Tab/Shift+Tab 焦点落到哪项（原生 button 可聚焦，
            // 无 tabIndex=-1 阻断），onFocus 即切 active 题 → 内容区跟着换题。
            onClick={() => onSelect(q.id)}
            onFocus={() => onSelect(q.id)}
            className={
              // 方块 tab：w-full 定高 h-9（shrink-0 防题多被压扁，交给竖滚）、居中序号+圆点；
              // rounded-l-md 只圆左缘——右缘与内容区贴合（active 时同色 bg-surface 连通）
              'flex w-full h-9 shrink-0 items-center justify-center gap-1.5 rounded-l-md text-[12px] cursor-pointer transition-colors ' +
              (active
                ? 'bg-surface text-accent'
                : 'text-muted hover:bg-surface/60 hover:text-fg-2')
            }
          >
            {/* 状态圆点：未答=accent 橙点 / 已答=sage 绿点（一眼看出还差哪题） */}
            <span
              aria-hidden
              className={
                'inline-block w-1.5 h-1.5 rounded-full shrink-0 ' +
                (answered ? 'bg-[var(--color-sage)]' : 'bg-accent')
              }
            />
            {/* 序号 Q01 起两位 padStart：font-mono 等宽，两位宽度预留不跳变（Q11+ 差异微小） */}
            <span className="font-mono">{`Q${String(qi + 1).padStart(2, '0')}`}</span>
          </button>
        );
      })}
    </div>
  );
}

export default PendingQuestionNav;
