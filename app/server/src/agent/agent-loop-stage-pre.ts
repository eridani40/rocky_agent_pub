/**
 * AgentLoop stage ①：drain inbox + cancel 配对（agent-loop 拆分模块）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_enqueue_cancel.md §4
 *       specs/tech/version_logs/v0.0.12/change_log.md（cancel 配对）
 *       specs/tech/version_logs/v0.0.101/change_log.md 模块 E（HITL tool_reply 回填）
 *
 * 职责：把 stagePreProcess 的纯逻辑（drain → 建 cancelSet → 逐条分流 → 返回 newMessages）
 * 抽离，主类只保留副作用编排（emit/ingest）。
 *
 * 设计：
 *   - drainAndPartition 是纯函数（无副作用）：drain inbox + 建 cancelSet + 返回结构化结果
 *   - 主类 AgentLoop.stagePreProcess 调用本函数，再做 emit / ingest（副作用归主类）
 *
 * [v0.0.101 T4] tool_reply 识别：drain 时按 sender.source==='tool_reply' 分到
 *   toolReplyMessages（不进 userMessages/systemMessages/newMessages，不入 transcript ingest），
 *   由 caller 调 handleToolReply 编辑占位 block（INV-6：编辑而非 append）。
 */
import { ulid } from '../config/ulid';
import type { Message, MessageInput } from '../message/types';
import type { InboxStore } from './inbox';
import type { EmitContext } from './agent-loop-emitters';
import { emitUserMessageBlocks, emitEnqueuedProcessed, emitEnqueuedCanceled } from './agent-loop-emitters';
import { toMessageInput } from './agent-loop-helpers';
import type { AgentReplyRequest } from './loop-ports';

/** drain 后的分流结果（纯数据结构，无副作用） */
export interface DrainResult {
  /**
   * 需要 ingest 的消息列表。
   * [v0.0.161] 全部 source（user/agent/system/approval）在 drain 阶段重写 messageId=ulid()。
   * user 分支不再保留 HTTP-in 时刻的 throwaway id — 与 agent/system/approval 对称化。
   */
  newMessages: MessageInput[];
  /** 被 cancel 作废的 enqueueId 列表（caller emit canceled） */
  canceledEnqueueIds: string[];
  /** 需要通知 processed 的（enqueueId, messageId, role）列表（caller emit processed） */
  processed: { enqueueId: string; messageId: string; role: Message['role'] }[];
  /**
   * user query 消息（source='user'）。caller emit message_start/blocks/end 用。
   * [v0.0.161] message.id = drain 时 reissue 的新 ulid（与 agent/system/approval 对称）；
   *   enqueueId 保留 inbox 分配的原值不变（I1：enqueueId 与 msgId 严格独立）。
   *   write-in 时刻（POST /messages / channel plugin）分配的 id 是 throwaway，drain 时丢弃。
   */
  userMessages: { enqueueId: string; message: Message }[];
  /**
   * [v0.0.58.cron-fix] system/agent/approval 消息（source!=='user'，重写新 id；caller emit message_start/blocks/end）。
   *
   * 离线/在线统一原则：drain 的**所有** message（含 cron / heartbeat tick / a2a 等 system-source 消息）
   * 都 emit SSE——与 GET /messages 返回的 store 内容同源。前端通过 message-flatten filter 决定是否展示
   * （system_reminder 已是此模式：后端发，前端滤；cron/tick 走 user 分支默认展示）。
   *
   * 之前只 user-source 走 emit，导致 GET 看得到但 SSE 实时看不到 → 重新进入 session 才发现系统消息。
   */
  systemMessages: Message[];
  /**
   * [v0.0.101 T4] tool_reply 回填消息（sender.source==='tool_reply'）。
   * 不走 userMessages/systemMessages 分支（不进 transcript ingest）；
   * caller（prepareStage）逐条调 handleToolReply 编辑占位 block（INV-6 编辑而非 append）。
   * 仍 emit processed（前端 enqueue-view 幂等移除 enqueued 项）。
   */
  toolReplyMessages: Message[];
  /**
   * 本批 drain 到的待回 a2a 请求（source='agent' && needReply=true）。
   * 纯数据投影（无该来源时为空数组）；messageId=drain reissue 后新 id。
   * caller（prepareStage）并入 state.agentReplyRequests，结算归 run 收尾 replySettle。
   */
  agentReplyRequests: AgentReplyRequest[];
}

/**
 * drain inbox + cancel 配对判定（纯函数，无 emit/ingest 副作用）。
 *
 * v0.0.12 cancel 配对（agent_enqueue_cancel.md §4）：
 *   - 同批 drain 一次性读取所有 entry（message + cancel），扫 cancel 建集合
 *   - message.enqueueId ∈ cancelSet → 作废（不生成 messageId / 不 emit processed）
 *   - 否则正常分流（user=保留原 id / agent=ulid 新 id）
 *
 * 原子性：drain 已原子清空 inbox，无需加锁。
 *
 * @param inbox inbox store
 * @param sessionId session id
 * @returns DrainResult（caller 负责 emit + ingest）
 */
export function drainAndPartition(
  inbox: InboxStore,
  sessionId: string,
): DrainResult {
  const drained = inbox.drain(sessionId);
  const result: DrainResult = {
    newMessages: [],
    canceledEnqueueIds: [],
    processed: [],
    userMessages: [],
    systemMessages: [],
    toolReplyMessages: [],
    agentReplyRequests: [],
  };
  if (drained.length === 0) return result;

  // 一次性扫本批 cancel 条目，建 cancelFor 集合（drain 原子性）
  const cancelSet = new Set<string>();
  for (const e of drained) {
    if (e.kind === 'cancel') cancelSet.add(e.cancelFor);
  }

  for (const entry of drained) {
    if (entry.kind === 'cancel') continue; // cancel 条目本身丢弃

    // cancel 配对：enqueueId 命中 → 作废
    if (cancelSet.has(entry.enqueueId)) {
      result.canceledEnqueueIds.push(entry.enqueueId);
      continue;
    }

    // [v0.0.31 task-3] drain 透传完整 sender（含 sender.agent.ref/needReply/inReplyTo）给下游。
    // source 仅用于分流判定（user=保留原 id / 其他=重写新 id）；toMessageInput 保留 sender 整体，
    // 不丢 agent 子结构——下游 llm/logical-view.toLogicalMessages 据此渲染 a2a 前缀
    // （a2a_protocol §5；[v0.0.50 T1] renderer 已迁入 llm/logical-view.ts）。
    const source = entry.message.sender?.source ?? 'user';
    // [v0.0.101 T4] tool_reply：分到独立分支，由 caller 调 handleToolReply 编辑占位 block。
    // 不进 userMessages/systemMessages/newMessages（不作为 transcript 条目 ingest）。
    if (source === 'tool_reply') {
      result.toolReplyMessages.push(entry.message);
      // emit processed（前端 enqueue-view 幂等移除 enqueued 项；不 emit message_*）
      result.processed.push({
        enqueueId: entry.enqueueId,
        messageId: entry.message.id,
        role: entry.message.role,
      });
      continue;
    }
    if (source === 'user') {
      // [v0.0.161] 与 agent/system/approval 对称化：user 分支也 reissue newId=ulid()。
      //   entry.message.id（HTTP-in 时刻的 throwaway ulid）被丢弃，drain 时刻分配全新 id。
      //   → 保证 msgId 顺序 = 实际 drain 处理顺序（transcript 按 id 升序时不再错位）。
      //   enqueueId 保留 entry.enqueueId 不变（I1 双 ID 独立）；msgId 通过 emitEnqueuedProcessed
      //   在 processed 事件里外泄给前端建立映射（I3；agent/system 分支早已在跑此路径）。
      // v0.0.12 BUG-008：source=user 也要配对 emit processed（前端 enqueue-view 幂等移除）
      const newId = ulid();
      const rewritten: Message = { ...entry.message, id: newId };
      result.userMessages.push({ enqueueId: entry.enqueueId, message: rewritten });
      result.processed.push({
        enqueueId: entry.enqueueId,
        messageId: newId,
        role: rewritten.role,
      });
      result.newMessages.push(toMessageInput(rewritten));
    } else {
      // agent / approval / system → 重新生成 messageId（透传完整 sender 含 agent 子结构）
      const newId = ulid();
      const rewritten: Message = { ...entry.message, id: newId };
      result.newMessages.push(toMessageInput(rewritten));
      // [v0.0.58.cron-fix] 离线/在线统一：system/agent/approval 也 emit SSE（见 DrainResult.systemMessages 注释）
      result.systemMessages.push(rewritten);
      result.processed.push({
        enqueueId: entry.enqueueId,
        messageId: newId,
        role: entry.message.role,
      });
      // 回报兜底：收集待回 a2a 请求（agent && needReply=true；用 reissue 后 id
      //   让 inReplyTo 指得回 transcript 真身；user/system/approval/tool_reply 不收集）
      if (rewritten.sender?.source === 'agent' && rewritten.sender.agent.needReply === true) {
        result.agentReplyRequests.push({
          messageId: rewritten.id,
          fromSessionId: rewritten.sender.agent.ref.sessionId,
        });
      }
    }
  }
  return result;
}

/**
 * 应用 DrainResult 的副作用（emit message_* / processed / canceled）。
 * 由主类 stagePreProcess 调用（emit 之前主类自己检查 isInterrupted）。
 *
 * [v0.0.58.cron-fix] 离线/在线统一：drain 的**所有** message（user + system/agent/approval）
 * 都 emit SSE message_start/blocks/end。emitUserMessageBlocks 名字保留（历史命名），实际支持任意 role
 * （内部 emitMessageStart 用 message.role）。与 GET /messages 同源 → 前端 filter 决定展示。
 */
export function emitDrainResult(ctx: EmitContext, result: DrainResult): void {
  for (const um of result.userMessages) {
    emitUserMessageBlocks(ctx, um.message);
  }
  // system/agent/approval source 消息也 emit SSE（cron / heartbeat tick / a2a 等实时可见）
  for (const sm of result.systemMessages) {
    emitUserMessageBlocks(ctx, sm);
  }
  for (const p of result.processed) {
    emitEnqueuedProcessed(ctx, p.enqueueId, p.messageId, p.role);
  }
  for (const enqueueId of result.canceledEnqueueIds) {
    emitEnqueuedCanceled(ctx, enqueueId);
  }
}
