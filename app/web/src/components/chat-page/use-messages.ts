/**
 * use-messages —— 会话消息流 area-hook（ctx+buffer 双通道）
 * 参考: specs/tech/app/frontend/[P0]chat_area_hooks.md §3（多订阅 + 领域 reducer）
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.10（useLifecycle 四方法 + 不变量①/⑥/⑦/⑧）
 *       specs/tech/app/frontend/[P0]lifecycle_data_shapes.md §3.2（流式 reducer 不套 applyCrud）
 *       specs/tech/version_logs/v0.0.95.lifecycle_buffer/change_plan.md §T2 §C
 *
 * 职责：唯一订 agent_loop（流式消息）的 area-hook，同时订 session_panel 只处理两类：
 *   - messages_cleared → 清对话区（clear 端点 emit）
 *   - session_status_update 进终态（idle/error/interrupted）→ 强制 runActive=false, loadingPhase=null
 *     （治 D7 sticky run_start 孤儿；session 卡死时 run_end 不到达，靠 session_panel 终态互补）
 * 不碰 sessionRunning（归 useRunState）/ usage（归 useUsage）/ summary（归 useSummary）。
 *
 * 双通道：
 *   - ctx（渲染通道，commitCtx→setCtx）：{messages, hasMore, runActive, loadingPhase, lastRunFinish, enqueueItems}
 *   - buffer（工作内存通道，commitBuffer→bufferRef，**不渲染**）：{runCtx: RunContext|null}
 *     承担 reducer 跨帧累积的中间态（半截 toolCallRawArgs / pendingError 防闪屏）。
 *   - onEvent 签名 `(ctx, event, from, buffer)` 调纯化 reducer
 *     `applyAgentEventToMessages(ctx.messages, buffer.runCtx, evt, ctx)` → 同帧 return `{ctx, buffer}`（双写）。
 *   - 命令式 setMessages 走 mutateCtx。
 *
 * enqueue 队列纯 API+SSE 驱动：
 *   - onInit 在 GET /messages 成功块之后追加 GET /inbox seed enqueueItems（contentBlocksToPreviewText 入口
 *     转 string）；subscribe-first 顺序（D8：subscribe → GET /messages → GET /inbox → 返回 ctx，
 *     GET 返回到 subscribe 间 fire 的 message_enqueued 既不在 GET 快照又没订阅到会丢）。
 *   - 队列加/移项只由 SSE 驱动（无命令式 add/remove 方法，INV-1/INV-5）；
 *     reducer message_enqueued 内置 some(enqueueId) 幂等，防 GET seed 与 SSE 双计。
 *
 * 不变量①ref-latest 由 useLifecycle ctxRef 持续同步：onEvent 每帧收 ctxRef.current（最新非 React 快照），
 *   保证 agent_loop 高频 text_delta 不丢字。
 */
import { useCallback } from 'react';
import { useLifecycle } from '../../lib/use-lifecycle';
import { getMessages, getInbox, getPendingToolCall, postMessage } from '../../lib/chat-api';
import {
  applyAgentEventToMessages,
  contentBlocksToPreviewText,
  type AgentEvent,
  type ReducerState,
  type RunContext,
} from '../../store/chat-slice-reducer';
import type { SessionEvent } from '../../store/session-slice-reducer';
import type { EnqueueItem, FeedbackAnswer, LoadingPhase, Message, PendingToolCallView, RunFinish, RunRetryStatus } from './types';
// by-id merge：防 transcript fetch 重置 SSE 累积态
import { mergeMessagesById } from './merge-messages-by-id';
// [CHAT-DEBUG] 临时观测（定位 tool_call 回放渲染缺失；排查完连同 lib/chat-debug-log 整体删除）
import { CHAT_DEBUG, chatDebug, countToolCallBlocks, dbgIds, resetChatSseStats, trackChatSseEvent } from '../../lib/chat-debug-log';

/** useMessages 返回：消息流数据 + 命令式方法 */
export interface UseMessagesResult {
  /** 当前 session messages（升序，含 role='tool'；SSE 增量 + 初始 GET） */
  messages: Message[];
  /** transcript 分页 hasMore（上滑到顶 loadMore 用） */
  hasMore: boolean;
  /** run 进行中（agent_loop run_start→true / run_end→false，门控 loading 胶囊） */
  runActive: boolean;
  /** loading 阶段（thinking/answering/tool_calling/tool_executing） */
  loadingPhase: LoadingPhase | null;
  /** 最近一次 run 结束态（sessionRunning=false 时渲染 run-finish） */
  lastRunFinish: RunFinish | null;
  /** enqueue-view 排队项（running 时排队消息；GET /inbox seed + SSE message_enqueued/processed/canceled） */
  enqueueItems: EnqueueItem[];
  /**
   * [v0.0.101] HITL 悬挂 tool call 队首（ask-question 等）。
   * 来源：SSE require_human_input + onInit GET /pending-tool-call seed。
   * 非空 → 提问卡 mount（可见性主判定，pendingToolCall !== null）。
   */
  pendingToolCall: PendingToolCallView | null;
  /**
   * [v0.0.130.hang] 当前执行中的 tool 名列表（loadingPhase='tool_executing' 时供 spinner 渲染
   * 「运行工具: X」）。来源：SSE tool_execution_start（置）/ tool_execution_end + run_end（清）。
   * 旧回放无 execution 事件时保持空数组（spinner 仅显阶段图标+文案，无具体 tool 名）。
   */
  runningToolNames: string[];
  /**
   * [v0.0.144] 「重试中」叠加态（LLM 失败自动重试进度）。非空 → 运行气泡显「重试中 x/x」+ ！icon。
   * 来源：SSE llm_attempt（reducer 消费置态）；run_end/终态强制清同 loadingPhase。旧回放无此事件时恒 null（零回归）。
   */
  retryStatus: RunRetryStatus | null;
  /** 续载/初始化 transcript：prepend=true 前插旧消息（loadMore 用）；走 mergeMessagesById 去重 */
  setMessages: (messages: Message[], opts?: { hasMore?: boolean; prepend?: boolean }) => void;
  /**
   * [v0.0.101] 提交 HITL 回填（b 路径）：POST /messages body 含 toolReply + 乐观清 pendingToolCall。
   * 卡片立即 unmount；后端 pre-process 编辑占位 block + resolve 删一条 →
   *   仍有 pending → emit 下一个 require_human_input（reducer 收到再 mount 新卡）；
   *   无 pending → 续 LLM（loop 重新跑）。
   * @param toolCallId 关联 pendingToolCall.toolCallId（pre-process 匹配 key）
   * @param handleType 回填分发（direct_result=ask-question / approval / callback）
   * @param payload FeedbackAnswer（direct_result）| ApprovalDecision | unknown
   */
  submitReply: (toolCallId: string, handleType: 'direct_result' | 'approval' | 'callback', payload: FeedbackAnswer | unknown) => void;
  /**
   * [v0.0.101] 清空本地 pendingToolCall（c 路径用）。
   * 用户在提问态发普通 query（无 toolReply）→ 后端检测「有 pending + user query」清 pendingToolCalls +
   * 占位原样发 LLM；前端须同步清本地 pendingToolCall 让卡片 unmount。
   * 由 page-chat.handleSend 在 pendingToolCall 非空时调用。
   */
  clearPendingToolCall: () => void;
}

/** ctx 形状（渲染通道）：ReducerState + messages + hasMore（reducer 输出 messages 与状态切片同源） */
export interface MessagesCtx extends ReducerState {
  messages: Message[];
  hasMore: boolean;
}

/** buffer 形状（工作内存通道，不渲染）：跨帧累积 reducer 中间态 */
export interface MessagesBuffer {
  runCtx: RunContext | null;
}

/** 空 ctx（onInit 初值 / reset 用） */
function emptyCtx(): MessagesCtx {
  return {
    messages: [],
    loadingPhase: null,
    runActive: false,
    lastRunFinish: null,
    enqueueItems: [],
    pendingToolCall: null,
    hasMore: false,
    retryStatus: null,
  };
}

/** 空 buffer（onInit 初值） */
function emptyBuffer(): MessagesBuffer {
  return { runCtx: null };
}

/**
 * 冷读 seed lastRunFinish：倒序找最后一条带 stopReason 的消息（GET /messages 后端 join run 下发）。
 * 全部 stopReason 原样接收（后端不筛选）；展示与 SSE run_end 走同一 ComponentRunFinish，
 * error 映射对齐 reducer run_end 分支的 RunFinish.error 契约（category/displayReason/detail）。
 */
function seedRunFinishFromMessages(items: Message[]): RunFinish | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i];
    if (!m?.stopReason) continue;
    return {
      stopReason: m.stopReason as RunFinish['stopReason'],
      ...(m.stopReason === 'error' && m.runError
        ? {
            error: {
              category: m.runError.errorCategory,
              displayReason: m.runError.displayReason,
              ...(m.runError.errorDetail ? { detail: m.runError.errorDetail } : {}),
            },
          }
        : {}),
    };
  }
  return null;
}

/** 终态集合（session 卡死时 run_end 不到达，靠 session_panel 终态清 sticky 孤儿） */
const TERMINAL_STATES: ReadonlySet<string> = new Set(['idle', 'error', 'interrupted']);

/**
 * 运行态集合——对齐 sessionRunning 口径（running bool ⟺ state ∈ {running, interrupting}）。
 * suspended 排除（HITL 合法等待态，INV-2），用于下方 session_panel 分支清 HITL 悬挂。
 */
const RUNNING_STATES: ReadonlySet<string> = new Set(['running', 'interrupting']);

/**
 * 会话消息流 area-hook。sessionId 变化时 useLifecycle 自动重订阅 + 重拉初值 + 重置 ctx+buffer。
 * @param sessionId 当前查看的 session id（playground viewedSessionId = activeSubId ?? activeSessionId）
 */
export function useMessages(sessionId: string): UseMessagesResult {
  const { ctx, mutateCtx } = useLifecycle<MessagesCtx, AgentEvent | SessionEvent, MessagesBuffer>({
    deps: [sessionId],
    onInit: async ({ signal, subscribe }) => {
      // [CHAT-DEBUG] INIT 锚点：切走切回=一次新 onInit，统计归零（回放 burst 紧随其后）
      resetChatSseStats(sessionId);
      // 多订阅（不变量⑥）：onEvent 按 from.topic switch
      // [v0.0.204] groupKey current→main（modeKey 退役→runKind，main run 发 _amt:main）
      subscribe('agent_loop', `session_id:${sessionId}_amt:main`);
      subscribe('session_panel', `session_id:${sessionId}`);
      if (!sessionId) return { ctx: emptyCtx(), buffer: emptyBuffer() };
      // 初始基线（失败不阻塞 SSE；成功后写 ctx.messages + hasMore）
      let initial = emptyCtx();
      try {
        const { items, hasMore } = await getMessages(sessionId, { limit: 50 });
        if (signal.aborted) return { ctx: emptyCtx(), buffer: emptyBuffer() };
        // [CHAT-DEBUG] 基线计数：GET /messages limit=50 拉回几条 + 其中 tool_call block 几个
        chatDebug(`baseline GET /messages items=${(items ?? []).length} toolCallBlocks=${countToolCallBlocks(items ?? [])} hasMore=${hasMore}（limit=50，100+ tool_call 会话基线必然只含尾部）`);
        // seed lastRunFinish：冷读恢复最后一次 run 的结束态（切走切回 / 重启后 run-finish 不丢）。
        // SSE run_end（含 sticky 回放）到达时 reducer 会覆盖为同值，无冲突。
        initial = {
          ...initial,
          messages: items ?? [],
          hasMore,
          lastRunFinish: seedRunFinishFromMessages(items ?? []),
        };
      } catch {
        // 拉取失败：SSE 仍可推增量（保空基线）
      }
      // GET /inbox seed enqueueItems（subscribe-first D8；GET /messages 之后）。
      //   content 经 contentBlocksToPreviewText 转 string（EnqueueItem.content 为 string）。
      //   reducer message_enqueued 内置 some(enqueueId) 幂等，防 GET seed 与 SSE 双计。
      //   失败降级空不阻塞（enqueueItems 保持空，SSE message_enqueued 仍可推增量）。
      try {
        const { items: inboxItems } = await getInbox(sessionId);
        if (signal.aborted) return { ctx: emptyCtx(), buffer: emptyBuffer() };
        initial = {
          ...initial,
          enqueueItems: (inboxItems ?? []).map((it) => ({
            enqueueId: it.enqueueId,
            content: contentBlocksToPreviewText(it.content),
          })),
        };
      } catch {
        // inbox 拉取失败：enqueueItems 降级空（不阻塞，SSE 仍可推）
      }
      // [v0.0.101] GET /pending-tool-call seed pendingToolCall（recover d 路径）。
      //   类比 GET /inbox：切走切回 / 重启后 SSE 无 sticky replay → 主动拉队首重渲染提问卡。
      //   失败降级 null 不阻塞（提问卡保持 unmount，SSE require_human_input 仍可推）。
      try {
        const { pending } = await getPendingToolCall(sessionId);
        if (signal.aborted) return { ctx: emptyCtx(), buffer: emptyBuffer() };
        initial = { ...initial, pendingToolCall: pending ?? null };
      } catch {
        // pending-tool-call 拉取失败：pendingToolCall 降级 null（不阻塞）
      }
      return { ctx: initial, buffer: emptyBuffer() };
    },
    // onEvent（签名：ctx, event, from, buffer）双通道写回
    onEvent: (ctx, event, from, buffer) => {
      // [CHAT-DEBUG] ctx null 丢弃观测：init 窗口（onInit 未 resolve）内到达的帧在此被静默 return，
      //   是「后端 replayed=139 但前端少」的首要嫌疑点——有输出即实锤丢帧
      if (!ctx) {
        chatDebug(`DROP(ctx null) topic=${from.topic} type=${(event as { type?: string })?.type} ${dbgIds(event)}`);
        return;
      }
      if (from.topic === 'agent_loop') {
        const evt = event as AgentEvent;
        // [CHAT-DEBUG] 逐事件打点：seq=全局序号，+ms=距 INIT（回放 burst=一排小 ms）
        const dbg = trackChatSseEvent(evt.type);
        chatDebug(`sse #${dbg.seq} +${dbg.sinceInitMs}ms type=${evt.type} ${dbgIds(evt)}`);
        // 流式领域 reducer（值传递 runCtx，返 ReducerFullResult）
        // buffer 可能 undefined（兼容无 buffer 调用方），fallback null
        const r = applyAgentEventToMessages(
          ctx.messages,
          buffer?.runCtx ?? null,
          evt,
          ctx,
        );
        // [CHAT-DEBUG] reducer 产出核对：tool_call_start 后 messages 里 tool_call block 总数应递增；
        //   若 sse 计数涨而 blocks 不涨 = reducer 没建节点（断在 reducer）
        if (CHAT_DEBUG && evt.type === 'tool_call_start') {
          chatDebug(`reducer add tool_call id=${evt.toolCallId} → messages=${r.messages.length} toolCallBlocks=${countToolCallBlocks(r.messages)}`);
        }
        // 双写：ctx 渲染通道（messages/hasMore/runActive/loadingPhase/lastRunFinish/enqueueItems），
        //       buffer 工作内存通道（runCtx 累积，不渲染）
        return {
          ctx: { ...ctx, ...r },
          buffer: { runCtx: r.runCtx },
        };
      }
      if (from.topic === 'session_panel') {
        const evt = event as SessionEvent;
        if (evt.type === 'messages_cleared') {
          // clear 端点 emit：清对话区（避免逐条 message_deleted）；buffer 不变（runCtx 累积保持）
          // [v0.0.101] pendingToolCall 一并清（clear 后无悬挂 tool，提问卡 unmount）
          return { ctx: { ...ctx, messages: [], lastRunFinish: null, enqueueItems: [], pendingToolCall: null } };
        }
        if (evt.type === 'session_status_update' && TERMINAL_STATES.has(evt.data?.state)) {
          // 终态强制清 sticky run_start 孤儿（治 D7）：runActive=false, loadingPhase=null。
          // [v0.0.144] 一并清 retryStatus（终态无重试可等，同 loadingPhase 强制清）。
          // 幂等跳渲染：已是终态时返原 ctx（normalizeMutation 识别 ctx 字段，引用相同时 React bailout）
          if (!ctx.runActive && ctx.loadingPhase === null && !ctx.retryStatus) return;
          return { ctx: { ...ctx, runActive: false, loadingPhase: null, retryStatus: null } };
        }
        if (evt.type === 'session_status_update' && RUNNING_STATES.has(evt.data?.state)) {
          // session 进入运行态 → 清 HITL 悬挂（治悬挂卡片不消失）。session_status_update 是
          // sessionRunning 权威源（useRunState），挂钩此处单点修覆盖两卡——base-chat-input-bar §4：
          // need_feedback/need_approval 都 gate 在 pendingToolCall（场景：子 agent / 另一个 tab /
          // 后台激活进 running，原清除只挂本客户端显式动作 → 提问/权限卡悬挂）。
          // 幂等跳渲染：无 pendingToolCall 时返原 ctx（同终态分支写法，避免无谓 re-render）。
          if (!ctx.pendingToolCall) return;
          return { ctx: { ...ctx, pendingToolCall: null } };
        }
      }
      // 其余（usage/summary/workspace/read 等）归各 area-hook，本 hook 忽略
      return;
    },
    // onDestroy：无自 new 业务资源（订阅/timer 由 useLifecycle 回收；ctx+buffer 由 lifecycle re-init 重置）
  });

  // —— 命令式方法（改走 mutateCtx：复用 commitCtx ref-latest 写回 + setCtx 渲染） —— //
  const setMessages = useCallback(
    (messages: Message[], opts?: { hasMore?: boolean; prepend?: boolean }) => {
      mutateCtx((c) => {
        if (!c) return; // ctx 未就绪跳过（onInit 完成前命令式调用无意义）
        // by-id merge：见 merge-messages-by-id（防 transcript fetch 重置 SSE 累积态）
        const merged = mergeMessagesById(c.messages, messages, opts?.prepend === true);
        return { ...c, messages: merged, hasMore: opts?.hasMore ?? c.hasMore };
      });
    },
    [mutateCtx],
  );

  /**
   * [v0.0.101] 提交 HITL 回填（b 路径）：
   *   乐观清 pendingToolCall（卡片立即 unmount，UX 即时反馈）+ POST /messages 含 toolReply。
   *   后端 pre-process 编辑占位 block + resolve → emit 下一个 require_human_input（多 pending）或续 LLM。
   *   失败仅 console warn 不阻塞（fire-and-forget 与 abort/cancel 同款；乐观清已生效）。
   */
  const submitReply = useCallback(
    (toolCallId: string, handleType: 'direct_result' | 'approval' | 'callback', payload: FeedbackAnswer | unknown) => {
      // 乐观清 pendingToolCall（unmount 卡片）；多 pending 时后端 emit 下一个会重新 mount
      mutateCtx((c) => {
        if (!c) return; // ctx 未就绪跳过
        return { ...c, pendingToolCall: null };
      });
      // 空 content 走空串（toolReply 不需要 user query 文本；后端按 sender.source='tool_reply' 识别）
      postMessage(sessionId, { content: '', toolReply: { toolCallId, handleType, payload } }).catch((e) =>
        console.warn('submitReply POST failed:', e),
      );
    },
    [mutateCtx, sessionId],
  );

  /** [v0.0.101] 清空本地 pendingToolCall（c 路径用，page-chat.handleSend 调） */
  const clearPendingToolCall = useCallback(() => {
    mutateCtx((c) => {
      if (!c || !c.pendingToolCall) return; // 无 pending 跳过（避免无谓 re-render）
      return { ...c, pendingToolCall: null };
    });
  }, [mutateCtx]);

  return {
    messages: ctx?.messages ?? [],
    hasMore: ctx?.hasMore ?? false,
    runActive: ctx?.runActive ?? false,
    loadingPhase: ctx?.loadingPhase ?? null,
    lastRunFinish: ctx?.lastRunFinish ?? null,
    enqueueItems: ctx?.enqueueItems ?? [],
    pendingToolCall: ctx?.pendingToolCall ?? null,
    runningToolNames: ctx?.runningToolNames ?? [],
    retryStatus: ctx?.retryStatus ?? null,
    setMessages,
    submitReply,
    clearPendingToolCall,
  };
}
