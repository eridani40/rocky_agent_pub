/**
 * component-pending-question-card —— HITL 悬挂型 tool 提问卡（ask-question）
 * 权威 spec: specs/ui/components/chat-page/component-pending-question-card.md
 * 契约: specs/api/overall/04-agent-session.md §3.2（POST /messages toolReply）/ §3.6（GET /pending-tool-call）
 *
 * 挂 chat-input-bar composer 上方（互斥 enqueue-view，pendingToolCalls>0 挂本卡）；SSE require_human_input 驱动 mount，
 * 提交后乐观清 unmount（多 pending 串行 INV-4）。
 * 多问题 = 左侧竖向步骤导航（component-pending-question-nav，竖滚=鼠标滚轮原生方向，题数无上限），
 * 一次只渲染 active 题的选项区块；单题不渲染导航列、内容区独占；底栏常驻「已答 X/N + 提交」；
 * 卡片 max-height 封顶、导航列/内容区各自内滚。
 * 单选=radio / 多选=checkbox；每题末位恒定渲染「其他」toggle（不再受 allowOther 门控），展开 textarea，值 `其他：<text>`。
 * 单选题「其他」也排他：radio 同组 + 选普通项关其他 / 选其他清普通项。提交 payload=FeedbackAnswer.selections{[qId]:string[]}。
 * 单选题选中普通选项（新选中）后自动前进到下一道未答题（多选 / 再点切掉 / 选「其他」不跳）。
 */
import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { FeedbackAnswer, PendingToolCallView, PendingQuestion } from './types';
import { isFeedbackData } from './types';
import { PrimitiveTooltip } from '../common/primitive-tooltip';
import { PendingQuestionBlock } from './component-pending-question-block';
import { PendingQuestionNav } from './component-pending-question-nav';

/** 「其他」selection 值前缀（值格式 `其他：<text>`，全角冒号）——strip 谓词与构造须共用此常量，避免二者漂移 */
const OTHER_PREFIX = '其他：';

type SubmitHandleType = 'direct_result' | 'approval' | 'callback';

interface PendingQuestionCardProps {
  /** 队首悬挂 tool call（subState='need_feedback'，data=FeedbackData） */
  pending: PendingToolCallView;
  /** 提交回填（b 路径）：toolCallId + handleType + FeedbackAnswer payload */
  onSubmit: (toolCallId: string, handleType: SubmitHandleType, payload: FeedbackAnswer) => void;
}

/**
 * 提问卡容器。仅渲染 subState='need_feedback' + data 为 FeedbackData 的悬挂；
 * need_approval 交审批卡（component-pending-approval-card），本卡防御性返回 null。
 * key=toolCallId：切换不同 pending 时天然 remount（selections + activeQuestionId 全重置到初值，多 pending 串行 INV-4）。
 */
export function ComponentPendingQuestionCard({ pending, onSubmit }: PendingQuestionCardProps) {
  const { t } = useTranslation('chat');
  // 仅消费 need_feedback（spec §1）；need_approval 交审批卡，本卡不渲染
  if (pending.subState !== 'need_feedback' || !isFeedbackData(pending.data)) return null;

  return (
    <PendingQuestionCardInner
      key={pending.toolCallId}
      pending={pending}
      questions={pending.data.questions}
      prompt={pending.data.prompt}
      onSubmit={onSubmit}
      t={t}
    />
  );
}

interface InnerProps {
  pending: PendingToolCallView;
  questions: PendingQuestion[];
  prompt?: string;
  onSubmit: (toolCallId: string, handleType: SubmitHandleType, payload: FeedbackAnswer) => void;
  t: ReturnType<typeof useTranslation>['t'];
}

/**
 * 内层组件（已校验 data 为 FeedbackData）：管理 selections 本地态 + activeQuestionId（竖向导航切题）+ 全答完才可提交。
 */
function PendingQuestionCardInner({ pending, questions, prompt, onSubmit, t }: InnerProps) {
  // selections 本地态：{ [questionId]: 选中的 key 列表（含「其他：<text>」） }
  // 草稿不缓存（O8 代决 YAGNI）：切走切回只保证题目恢复（peek 队首），中间态不持久化。
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  // 「其他」选项的输入框文本（每个 questionId 独立，键 = qId）
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  // 「其他」toggle 是否展开（每个 qId 独立——「其他」恒定渲染，每题都可能展开）
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});
  // 竖向步骤导航：当前展示的题（默认第一题）；切换不同 pending 由 key remount 天然重置到首题
  const [activeQuestionId, setActiveQuestionId] = useState<string>(questions[0]?.id ?? '');

  /** 切换选项（single=替换 / multi=增删） */
  const toggleOption = (q: PendingQuestion, key: string) => {
    // 单选「新选中」判定（本次操作后该题即已答）：驱动答完自动前进；再点同 key 切掉不算
    const isNewSinglePick = q.type === 'single' && (selections[q.id] ?? [])[0] !== key;
    setSelections((prev) => {
      const cur = prev[q.id] ?? [];
      if (q.type === 'single') {
        // 单选：替换为 [key]；若同 key 再点为切掉（允许空答，但提交要求至少 1 项）
        return { ...prev, [q.id]: cur[0] === key ? [] : [key] };
      }
      // 多选：增删
      const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
      return { ...prev, [q.id]: next };
    });
    // 单选题「其他」与普通选项互斥：选普通项 → closeOther 关展开态 + 清「其他：<text>」selection + 文本
    if (q.type === 'single') closeOther(q.id);
    // 单选新选中普通项 → 自动前进到下一道未答题（按 questions 顺序找第一个未答的，排除当前题；无未答题不跳）。
    // 多选 / 再点切掉 / 选「其他」（toggleOther 不经本函数）均不跳。
    // 其余题的已答态读当前 selections 快照即可——本次操作只改当前题（改后即已答），不动其他题。
    if (isNewSinglePick) {
      const nextUnanswered = questions.find((o) => o.id !== q.id && (selections[o.id]?.length ?? 0) === 0);
      if (nextUnanswered) setActiveQuestionId(nextUnanswered.id);
    }
  };

  /** 收起某题「其他」：关展开态 + 清该 qId 的「其他：<text>」selection + 文本（单选互斥 / 收起共用） */
  const closeOther = (qId: string) => {
    setOtherOpen((prev) => (prev[qId] ? { ...prev, [qId]: false } : prev));
    setSelections((s) => {
      const cur = s[qId] ?? [];
      const stripped = cur.filter((k) => !k.startsWith(OTHER_PREFIX));
      return stripped.length === cur.length ? s : { ...s, [qId]: stripped };
    });
    setOtherText((o) => {
      if (!(qId in o)) return o;
      const next = { ...o };
      delete next[qId];
      return next;
    });
  };

  /** 切换「其他」展开/收起（收起清 selection+文本，走 closeOther；单选打开时清普通项 selection 保排他） */
  const toggleOther = (q: PendingQuestion) => {
    if (otherOpen[q.id]) {
      // 已开 → 收起（清「其他：<text>」+ 文本）
      closeOther(q.id);
      return;
    }
    // 打开「其他」：单选题清空普通项 selection（radio 互斥，整题只留「其他」），多选保留已选项
    setOtherOpen((prev) => ({ ...prev, [q.id]: true }));
    if (q.type === 'single') {
      setSelections((s) => {
        const cur = s[q.id] ?? [];
        const kept = cur.filter((k) => k.startsWith(OTHER_PREFIX)); // 只保留「其他：」项（普通项清掉）
        return kept.length === cur.length ? s : { ...s, [q.id]: kept };
      });
    }
  };

  /** 「其他」输入框 onChange：更新文本 + 同步 selection（「其他：<text>」单条替换） */
  const setOther = (q: string, text: string) => {
    setOtherText((prev) => ({ ...prev, [q]: text }));
    setSelections((prev) => {
      const cur = prev[q] ?? [];
      const stripped = cur.filter((k) => !k.startsWith(OTHER_PREFIX));
      // 空文本不加 selection（用户未真正输入）；非空才合成「其他：<text>」
      return { ...prev, [q]: text.trim() === '' ? stripped : [...stripped, `${OTHER_PREFIX}${text}`] };
    });
  };

  /** 某题是否已答（≥1 项 selection）——导航状态圆点用（进度/allAnswered 由 answeredCount 派生） */
  const isAnswered = (qId: string) => (selections[qId]?.length ?? 0) > 0;

  // 已答数 + 全答完判定：每题至少 1 项 selection（无选项的题视为已答，防御性——理论 questions[].options>=1）
  const answeredCount = useMemo(
    () => questions.filter((q) => (selections[q.id]?.length ?? 0) > 0).length,
    [questions, selections],
  );
  const allAnswered = answeredCount === questions.length;
  // 多题 = 左侧序号导航 + 内容区套 bg-surface 面板；单题不渲染导航、不套面板（维持原样）
  const isMulti = questions.length > 1;

  /** 提交按钮：构造 FeedbackAnswer + 调 onSubmit（未答完 aria-disabled，onClick 内拦截） */
  const handleSubmit = () => {
    if (!allAnswered) return;
    const payload: FeedbackAnswer = {
      selections: questions.reduce<Record<string, string[]>>((acc, q) => {
        acc[q.id] = selections[q.id] ?? [];
        return acc;
      }, {}),
    };
    onSubmit(pending.toolCallId, pending.handleType, payload);
  };

  const activeQuestion = questions.find((q) => q.id === activeQuestionId) ?? questions[0];

  // 提交按钮：禁用态用 aria-disabled（非原生 disabled），保证外层 wrapper hover 可触发提示
  const submitBtn = (
    <button
      type="button"
      data-action-key="chat.question.submit"
      aria-disabled={!allAnswered}
      onClick={handleSubmit}
      className={
        'shrink-0 px-3 py-1 rounded-md text-[12px] font-medium transition-colors ' +
        (allAnswered
          ? 'bg-[var(--color-accent)] text-surface cursor-pointer hover:opacity-90'
          : 'bg-bg-warm text-muted cursor-not-allowed')
      }
    >
      {t('pendingQuestion.submit', { defaultValue: '提交' })}
    </button>
  );

  return (
    <div
      className="bg-accent-light border border-[var(--color-accent)] rounded-xl px-3 py-2.5 flex flex-col gap-2 max-w-[820px] mx-auto w-full max-h-[360px] overflow-hidden"
    >
      {/* 头部：prompt 存在 → 标题；否则 → mono pulse hint（awaitInput）；常驻不滚 */}
      {prompt ? (
        <div className="text-[12px] text-fg-2 leading-snug shrink-0">{prompt}</div>
      ) : (
        <div className="flex items-center gap-1.5 text-[10px] font-mono text-accent shrink-0">
          <span
            className="inline-block w-1.5 h-1.5 rounded-full bg-accent"
            style={{ animation: 'qpulse 1.2s ease-in-out infinite' }}
          />
          <span>{t('pendingQuestion.awaitInput', { defaultValue: '等待你的回答' })}</span>
        </div>
      )}

      {/* 中部：多题 = 左侧竖向序号导航 + 右侧内容区（无 gap——active tab 顶到内容区左缘同色连通，各自竖滚）；
          单题 = 内容区独占（不渲染导航列，也不套 bg-surface 面板，维持原样） */}
      <div className="flex-1 min-h-0 flex">
        {isMulti && (
          <PendingQuestionNav
            questions={questions}
            activeQuestionId={activeQuestion?.id ?? ''}
            isAnswered={isAnswered}
            onSelect={setActiveQuestionId}
          />
        )}
        {/* 内容区：只渲染 active 题的选项区块；多题时套 bg-surface 面板浮在卡片 accent-light 底上形成区隔，
            左缘不圆角（rounded-r-lg）保与 active 导航 tab 无缝连通；选项过多仅本区内滚 */}
        {activeQuestion && (
          <div
            className={
              'flex-1 min-w-0 overflow-y-auto scrollbar-thin' +
              (isMulti ? ' bg-surface rounded-r-lg px-3 py-2' : '')
            }
          >
            <PendingQuestionBlock
              q={activeQuestion}
              sel={selections[activeQuestion.id] ?? []}
              isOpen={!!otherOpen[activeQuestion.id]}
              otherValue={otherText[activeQuestion.id] ?? ''}
              toggleOption={toggleOption}
              toggleOther={toggleOther}
              setOther={setOther}
              t={t}
            />
          </div>
        )}
      </div>

      {/* 底栏（常驻 shrink-0）：左侧进度「已答 X/N」+ 右侧提交（无取消按钮 INV-7；未答完 tooltip 承接 hover 弹提示） */}
      <div className="flex items-center justify-between gap-2 shrink-0">
        <span className="text-[11px] font-mono text-muted">
          {t('pendingQuestion.progress', { answered: answeredCount, total: questions.length, defaultValue: '已答 {{answered}}/{{total}}' })}
        </span>
        <div className="shrink-0">
          {allAnswered ? (
            submitBtn
          ) : (
            <PrimitiveTooltip
              content={t('pendingQuestion.submitHint', { defaultValue: '请回答完问题再提交' })}
            >
              {submitBtn}
            </PrimitiveTooltip>
          )}
        </div>
      </div>
      {/* qpulse keyframes（与 component-enqueue-view 同名，<style> 注册幂等；本地保留保自包含——互斥渲染不依赖对方） */}
      <style>{`@keyframes qpulse {0%,100%{opacity:1}50%{opacity:.3}}`}</style>
    </div>
  );
}

export default ComponentPendingQuestionCard;
