/** apply-agent-event —— SSE AgentEvent → messages 纯函数 reducer（从 chat-slice-reducer 拆出；设计原则 / 拆分背景见 barrel chat-slice-reducer.ts 顶部）。参考 specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md §9 */
import type { Message } from '../../components/chat-page/types';
import type { AgentEvent } from './agent-event-types';
import type { ReducerFullResult, ReducerState, RunContext } from './reducer-state';
import { contentBlocksToPreviewText } from './message-preview';

/**
 * 把一条 AgentEvent 应用到 messages（纯函数，便于单测）。
 *
 * v0.0.95 纯化（change_plan §B）：runCtx 改值传递（不再 mutate ctxRef.current）。
 *   - 各 case 把副作用改为「构造新 runCtx 进返回值」；消费方负责把返回的 runCtx 写回自己的 buffer。
 *   - rawArgs 累积语义严格不变（BUG-002 链路不回归）：delta 拷贝旧 Map entries + set；end 读 + 删 key。
 *   - tool_call_end 返回删了对应 key 的新 Map（D2 落地：reducer 内清理）。
 * @param msgs 当前 messages
 * @param runCtx 当前 run 上下文（runId / 累积的 toolCallRawArgs / pendingError），可为 null（run 未开始）
 * @param evt SSE AgentEvent
 * @param state 当前状态切片（loadingPhase/runActive/lastRunFinish/enqueueItems）
 * @returns ReducerFullResult：新 messages + 新 state 切片 + 新 runCtx
 */
export function applyAgentEventToMessages(
  msgs: Message[],
  runCtx: RunContext | null,
  evt: AgentEvent,
  state: ReducerState,
): ReducerFullResult {
  let { loadingPhase, runActive, lastRunFinish, enqueueItems, pendingToolCall, runningToolNames, retryStatus } = state;
  let messages = msgs;
  // v0.0.95：默认保持原引用（无变化）；按需赋新对象（immutable return）
  let nextRunCtx: RunContext | null = runCtx;

  const findMsg = (id: string) => messages.find((m) => m.id === id);
  const patchMsg = (id: string, fn: (m: Message) => Message) => {
    messages = messages.map((m) => (m.id === id ? fn(m) : m));
  };

  switch (evt.type) {
    case 'run_start': {
      runActive = true;
      loadingPhase = 'thinking';
      // immutable：返新 runCtx（不再 mutate ctxRef.current）
      nextRunCtx = { runId: evt.runId };
      break;
    }
    case 'message_start': {
      // [v0.0.12] 对话区只渲染服务端 SSE message_start 的 messageId（ULID 唯一来源）。
      // 移除旧 BUG-006 启发式（用 local-* 乐观消息配对替换）——发消息不再本地 push，
      // message_start(role=user) 像其他 role 一样按 messageId 幂等入列。
      // 透传 metadata：业务侧系统消息（如 cron tick / heartbeat）携带的 meta，前端按需读。
      //   [v0.0.81.compaction_bug] compact_notice 留痕分支已删（消息全段砍，不再有 metadata.kind
      //   === 'compact_notice' 来源）。
      if (!findMsg(evt.messageId)) {
        // [v0.0.119] sender 重建优先级：
        //   1. evt.sender（新字段）—— a2a 消息携带 agent.ref，isA2aInbox 需要此字段（BUG-001 修复）
        //   2. evt.origin（旧字段）—— user channel（飞书等 IM 入站），写 sender.channel
        //   3. 无 sender（web client user / LLM assistant / tool）→ sender 字段缺省
        const messageSender = evt.sender?.source === 'agent'
          ? {
              source: 'agent' as const,
              agent: {
                ref: evt.sender.agent.ref,
                // needReply 前端只用于回复判断，SSE 路径不依赖；填 false 满足类型约束
                needReply: false,
              },
            }
          : evt.origin
            ? { source: 'user' as const, channel: { type: evt.origin.type, configId: evt.origin.configId } }
            : undefined;
        messages = [...messages, {
          id: evt.messageId,
          sessionId: evt.sessionId,
          role: evt.role,
          content: [],
          ...(evt.metadata ? { metadata: evt.metadata } : {}),
          ...(messageSender ? { sender: messageSender } : {}),
          runId: runCtx?.runId,
          createdAt: new Date().toISOString(),
        }];
      }
      if (evt.role === 'assistant' && runCtx) {
        // immutable：拷贝 runCtx 写 currentAssistantMessageId（不 mutate 原 runCtx）
        nextRunCtx = { ...runCtx, currentAssistantMessageId: evt.messageId };
        loadingPhase = 'answering';
      }
      // [v0.0.144] 重试成功恢复：assistant 回复开始 → 退出重试态（回落原 4 态）
      if (evt.role === 'assistant') retryStatus = null;
      break;
    }
    case 'text_block_delta': {
      patchMsg(evt.messageId, (m) => {
        const blocks = [...m.content];
        const last = blocks[blocks.length - 1];
        if (last && last.type === 'text') {
          blocks[blocks.length - 1] = { type: 'text', text: last.text + evt.delta };
        } else {
          blocks.push({ type: 'text', text: evt.delta });
        }
        return { ...m, content: blocks };
      });
      loadingPhase = 'answering';
      // [v0.0.144] 正常运行事件覆盖重试态
      retryStatus = null;
      break;
    }
    case 'tool_call_start': {
      // [v0.0.28 BUG-fix] tool_call_* 一律用 evt.messageId（事件自带）锚定，
      // 不再依赖 runCtx.currentAssistantMessageId（仅 message_start role=assistant 时才设）。
      // 真因：切到进行中的 run（如 subagent 只读页）时 message_start 已发完，
      // runCtx.currentAssistantMessageId 永远没设 → tool_call part 静默丢失。
      // text_block_delta 早已用 evt.messageId，本处对齐。
      const targetId = evt.messageId;
      if (targetId) {
        // 兜底：错过 message_start（headless / 后切页）时先建 assistant message，
        // 再 patchMsg 追加 tool_call part（之前会因 targetId=undefined 静默丢弃）。
        if (!findMsg(targetId)) {
          messages = [...messages, {
            id: targetId,
            sessionId: '',
            role: 'assistant',
            content: [],
            runId: runCtx?.runId,
            createdAt: new Date().toISOString(),
          }];
        }
        patchMsg(targetId, (m) => ({
          ...m,
          content: [...m.content, { type: 'tool_call', id: evt.toolCallId, name: evt.toolName, arguments: {} }],
        }));
        // immutable：同步 currentAssistantMessageId（让 tool_call_delta/end 仍可经 runCtx 工作）
        if (runCtx) {
          nextRunCtx = { ...runCtx, currentAssistantMessageId: targetId };
        }
      }
      loadingPhase = 'tool_calling';
      // [v0.0.144] 正常运行事件覆盖重试态
      retryStatus = null;
      break;
    }
    case 'tool_call_delta': {
      // [v0.0.28 BUG-fix] rawArgs 缓存 key 是 toolCallId（与 messageId 无关），
      // 但仍要求 runCtx 已由 run_start / tool_call_start 兜底建好。
      // v0.0.95 纯化：拷贝旧 Map entries + set 累积（不 mutate 原 Map），返新 runCtx。
      if (runCtx) {
        const prevMap = runCtx.toolCallRawArgs ?? new Map<string, string>();
        const newMap = new Map(prevMap);
        newMap.set(evt.toolCallId, (newMap.get(evt.toolCallId) ?? '') + evt.delta);
        nextRunCtx = { ...runCtx, toolCallRawArgs: newMap };
      }
      break;
    }
    case 'tool_call_end': {
      // [v0.0.28 BUG-fix] 用 evt.messageId 锚定 patchMsg（与 start 对齐，不依赖 runCtx.currentAssistantMessageId）。
      // rawArgs 缓存读 runCtx（key=toolCallId，由 delta 写入）。
      const targetId = evt.messageId;
      const rawMap = runCtx?.toolCallRawArgs;
      if (targetId && rawMap) {
        const raw = rawMap.get(evt.toolCallId);
        let args: Record<string, unknown> = {};
        if (raw) {
          try {
            args = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            args = { _raw: raw };
          }
        }
        patchMsg(targetId, (m) => ({
          ...m,
          content: m.content.map((b) =>
            b.type === 'tool_call' && b.id === evt.toolCallId
              ? { type: 'tool_call', id: b.id, name: b.name, arguments: args }
              : b,
          ),
        }));
        // D2 落地：返删了该 key 的新 Map（reducer 内清理，消费方写回即可）
        const cleanedMap = new Map(rawMap);
        cleanedMap.delete(evt.toolCallId);
        if (runCtx) nextRunCtx = { ...runCtx, toolCallRawArgs: cleanedMap };
      }
      break;
    }
    case 'tool_result_start': {
      const newMsg: Message = {
        id: evt.messageId,
        sessionId: '',
        role: 'tool',
        content: [{ type: 'tool_result', toolCallId: evt.toolCallId, content: [], isError: false }],
        runId: runCtx?.runId,
        createdAt: new Date().toISOString(),
      };
      if (!findMsg(evt.messageId)) messages = [...messages, newMsg];
      // [v0.0.130.hang] phase 兜底保留：旧回放录制无 tool_execution_start 事件时，
      // 仍靠 tool_result_start 兜底进 tool_executing（无具体 tool 名可显，runningToolNames 不动）。
      loadingPhase = 'tool_executing';
      // [v0.0.144] 正常运行事件覆盖重试态
      retryStatus = null;
      break;
    }
    case 'tool_result_delta': {
      patchMsg(evt.messageId, (m) => ({
        ...m,
        content: m.content.map((b) => {
          if (b.type !== 'tool_result' || b.toolCallId !== evt.toolCallId) return b;
          const blocks = [...b.content];
          const last = blocks[blocks.length - 1];
          if (last && last.type === 'text') {
            blocks[blocks.length - 1] = { type: 'text', text: last.text + evt.delta };
          } else {
            blocks.push({ type: 'text', text: evt.delta });
          }
          return { ...b, content: blocks };
        }),
      }));
      break;
    }
    case 'tool_result_end': {
      patchMsg(evt.messageId, (m) => ({
        ...m,
        content: m.content.map((b) =>
          b.type === 'tool_result' && b.toolCallId === evt.toolCallId
            ? { ...b, isError: evt.isError }
            : b,
        ),
      }));
      break;
    }
    case 'tool_execution_start': {
      // [v0.0.130.hang] 执行开始即置 tool_executing（早于 tool_result_start），修 hang 时
      // UI 永停「思考中」——loop_tools_begin breadcrumb 同址 emit，见 agent-event-types.md。
      loadingPhase = 'tool_executing';
      runningToolNames = evt.toolNames;
      // [v0.0.144] 正常运行事件覆盖重试态
      retryStatus = null;
      if (runCtx) {
        nextRunCtx = { ...runCtx, runningToolNames: evt.toolNames };
      }
      break;
    }
    case 'tool_execution_end': {
      // 清运行中 tool 名（loadingPhase 保持不变，待后续 tool_result_* 事件覆盖具体阶段）
      runningToolNames = undefined;
      if (runCtx) {
        nextRunCtx = { ...runCtx, runningToolNames: undefined };
      }
      break;
    }
    case 'error': {
      // [v0.0.25] SSE error 事件映射到 RunFinish.error 新契约（向后兼容旧 message/code）：
      //   优先用新字段（errorCategory/displayReason/errorDetail），缺失则用旧字段兜底
      //   （displayReason ← message；category ← errorCategory ?? code；code 透传；detail ← errorDetail）。
      //   参考 specs/tech/agent/llm_caller/[P0]llm_caller_overview.md §3.2 + llm_caller_rev2_changes.md §3。
      // v0.0.95 纯化：返含 pendingError 的新 runCtx 对象（不 mutate 原 runCtx）
      if (runCtx) {
        nextRunCtx = {
          ...runCtx,
          pendingError: {
            category: evt.errorCategory ?? evt.code ?? 'UNKNOWN',
            displayReason: evt.displayReason ?? evt.message ?? '执行出错',
            ...(evt.errorDetail ? { detail: evt.errorDetail } : {}),
            ...(evt.code ? { code: evt.code } : {}),
          },
        };
      }
      break;
    }
    case 'run_end': {
      runActive = false;
      loadingPhase = null;
      // [v0.0.130.hang] run 结束兜底归零（正常路径已由 tool_execution_end 清，此处防悬挂）
      runningToolNames = undefined;
      // [v0.0.144] run 结束兜底清重试态（FAIL 终态交棒 run-finish；成功恢复已由正常事件清）
      retryStatus = null;
      const pendingError = runCtx?.pendingError;
      lastRunFinish = {
        stopReason: evt.stopReason,
        ...(evt.stopReason === 'error' && pendingError ? { error: pendingError } : {}),
      };
      // immutable：runCtx 重置（不再 ctxRef.current = null）
      nextRunCtx = null;
      break;
    }
    // [v0.0.12] enqueue 级三事件（design §3.4 / agent_event.md §4.3）
    case 'message_enqueued': {
      // 建项：按 enqueueId 幂等入列（同 enqueueId 重复入列无副作用）
      // BUG-007：content 拍平为预览字符串（EnqueueItem.content 仍为 string），
      // 避免 enqueue-view 把 ContentBlock[] / {type,text} 对象当 React child 渲染崩树。
      if (!enqueueItems.some((it) => it.enqueueId === evt.enqueueId)) {
        enqueueItems = [
          ...enqueueItems,
          { enqueueId: evt.enqueueId, content: contentBlocksToPreviewText(evt.content) },
        ];
      }
      break;
    }
    case 'enqueued_message_processed':
    case 'enqueued_message_canceled': {
      // 移项：按 enqueueId 幂等移除（processed 与 canceled 二者只可能到达其一；已乐观移除则无操作）
      enqueueItems = enqueueItems.filter((it) => it.enqueueId !== evt.enqueueId);
      break;
    }
    case 'require_human_input': {
      // [v0.0.101] HITL 悬挂：loop pending.length>0 emit 队首单个 → mount 提问卡。
      //   多 pending 串行（INV-4 peek 队首）：resolve 一条后后端 emit 下一个驱动切换。
      //   pending 直接替换（last-write-wins，事件携带的就是当前队首）。
      pendingToolCall = evt.pending;
      break;
    }
    case 'llm_attempt': {
      // [v0.0.144] LLM 失败重试外显：重试类动作（RETRY/ROTATE_KEY/FALLBACK）置「重试中」态；
      //   FAIL 终态无「下一次」可等 → 不进本态，维持当前显示直至 run_end 由 run-finish 交棒。
      //   G4 clamp：分子 math.min(attempt, maxAttempts)，MANDATORY 绝不出 4/3 越界。
      if (evt.action === 'RETRY' || evt.action === 'ROTATE_KEY' || evt.action === 'FALLBACK') {
        retryStatus = {
          attempt: Math.min(evt.attempt, evt.maxAttempts),
          maxAttempts: evt.maxAttempts,
          message: evt.message,
        };
      }
      break;
    }
    default:
      break;
  }

  return { messages, loadingPhase, runActive, lastRunFinish, enqueueItems, pendingToolCall, runningToolNames, retryStatus, runCtx: nextRunCtx };
}
