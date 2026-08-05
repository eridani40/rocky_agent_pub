/**
 * component-run-state-bar —— 运行态控制条（run 态「引擎数据 → UI 组件」组装层）
 * 参考: specs/tech/app/frontend/[P0]component_architecture.md §3.5 / §3.7（两层状态 UI）
 *       specs/ui/components/chat-page/_overview.md §4.10（on-message spinner）/ §4.11a（enqueue 排队区）/ §4.11b（abort 按钮）
 *
 * loading UI 由 ComponentMessageStream 内 on-message spinner 接管（贴流式尾部，run 层 agent_loop 数据驱动）；
 * 本组件只持 enqueue 排队区（session 层）+ 导出 ComponentRunStateAbortSlot（sessionState 透传圆环减速反馈）。
 *
 * 收拢范围（仅剩一块——enqueue 排队区，占排版流右对齐，不依赖 caller 的 textarea/send 布局，可完整封装）：
 *   1. enqueue 排队区（ComponentEnqueueView）——running 且 items 非空时显示。
 *
 * 停止按钮（ComponentAbortBtn）牵涉 caller 自己 input-row 的 flex 布局（在 textarea 与 send 之间，
 *   两边 send 样式不同不抽），故位置仍由 caller 内联；但「sessionRunning && sessionId 才渲染」的**判断逻辑**
 *   由同文件导出的 `ComponentRunStateAbortSlot` 统一吃掉（防某消费方漏写条件）。
 *
 * 命名沿用 ComponentRunStateBar（历史命名，避免改 testid 破坏 ET）；实际只剩 enqueue 区。
 */
import type { EnqueueItem } from './types';
import { ComponentEnqueueView } from './component-enqueue-view';
import { ComponentAbortBtn, type AbortSessionState } from './component-abort-btn';
import { CHAT_ACTION_BTN_CLS } from './action-button-styles';

/** 运行态控制条 props（数据来自 run 态 area-hooks；caller 仅透传） */
export interface RunStateBarProps {
  /** session 是否 running（session_panel 权威源）——门控 enqueue 区可见性（§4.11a） */
  sessionRunning: boolean;
  /** enqueue 排队项（running 时排队消息） */
  enqueueItems: EnqueueItem[];
  /**
   * 取消排队项（点 cancel 按钮触发）。cancel 仅 POST /cancel（fire-and-forget），
   * 队列移项靠 SSE enqueued_message_canceled（不进 store）。ComponentEnqueueView 本地维护转圈态。
   */
  onEnqueueCancel?: (enqueueId: string) => void;
  /**
   * 是否渲染 enqueue 排队区（默认 true）。playground readOnly mode（subagent 只读页）传 false——
   * 隐藏排队区（随 input-bar 一并隐藏，_overview §4.3）。
   *
   * loading 由 ComponentMessageStream 内部渲染（on-message spinner），本组件仅剩 enqueue 区；
   *   readOnly mode 传 showEnqueue=false 后整个控制条不渲染任何 UI。
   */
  showEnqueue?: boolean;
}

/**
 * 运行态控制条：仅 enqueue 排队区。
 *
 * loading（on-message spinner）由 ComponentMessageStream 渲染；
 * enqueue 区按 showEnqueue 挂载、内部再按 running && items.length>0 决定是否真正渲染。
 * 渲为 Fragment（零定位上下文侵入）。
 */
export function ComponentRunStateBar({
  sessionRunning,
  enqueueItems,
  onEnqueueCancel,
  showEnqueue = true,
}: RunStateBarProps) {
  return (
    <>
      {/* loading 的 on-message spinner 由 ComponentMessageStream 内部渲染（贴流式尾部） */}
      {/* enqueue 排队区（§4.11a）：showEnqueue 时挂载，组件内部再按 running && items.length>0 门控可见 */}
      {showEnqueue && (
        <ComponentEnqueueView
          items={enqueueItems}
          running={sessionRunning}
          onCancel={onEnqueueCancel}
        />
      )}
    </>
  );
}

/** 停止按钮 slot props（判断逻辑统一收拢，位置仍由 caller 内联） */
export interface RunStateAbortSlotProps {
  /** session 是否 running（session_panel 权威源） */
  sessionRunning: boolean;
  /** 当前 session id（null 时不渲染，与 sessionRunning 共同门控） */
  sessionId: string | null;
  /**
   * session 状态（running / interrupting）—— 切换 abort-btn 圆环 animation-duration 做减速视觉反馈。
   * 默认 'running'（caller 未透传 sessionState 时按正常速度转）。
   */
  sessionState?: AbortSessionState;
  /** 点击 abort 回调（Caller 发 POST /abort，fire-and-forget） */
  onAbort: (sessionId: string) => void;
}

/**
 * 停止按钮 slot：统一「sessionRunning && sessionId 才渲染」判断（消除两消费方各写一遍同款条件+JSX）。
 * caller 把它内联摆在自己 input-row 内（textarea 与 send 之间）——位置由 caller 的 flex 布局决定，
 * 但「是否渲染」的判断逻辑收拢到此处，防止某个消费方漏写条件（如单聊曾漏接 enqueue 那类问题）。
 *
 * 透传 sessionState 给 ComponentAbortBtn（圆环减速视觉反馈）。
 */
export function ComponentRunStateAbortSlot({
  sessionRunning,
  sessionId,
  sessionState = 'running',
  onAbort,
}: RunStateAbortSlotProps) {
  // 槽位始终预留：idle / 无 session 时渲染不可见占位（同 21px 尺寸，
  //   visibility:hidden 保排版空间），picker/send/stop 位置固定不随 stop 显隐位移。
  //   占位 span 无 testid（chat-abort 仍只在 running 时存在）+ aria-hidden（屏幕阅读器忽略）。
  if (!sessionRunning || !sessionId) {
    return (
      <span
        aria-hidden

        className={CHAT_ACTION_BTN_CLS + ' invisible'}
      />
    );
  }
  return (
    <ComponentAbortBtn
      sessionId={sessionId}
      sessionState={sessionState}
      onAbort={onAbort}
    />
  );
}

export default ComponentRunStateBar;
