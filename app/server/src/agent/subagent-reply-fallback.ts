/**
 * subagent-reply-fallback — async subagent 回报兜底（系统代发）
 * 参考: specs/tech/version_logs/v0.0.255/change_plan.md（设计总述 + 判定规则）
 *       specs/tech/multi_agent/[P1]a2a_protocol.md §4.2（needReply 语义）
 *
 * 背景：async spawn 的 subagent 结果回传靠 LLM 自觉调 send_message（prompt 层约定
 * needReply=true 必回），无代码兜底，LLM 违约则 parent 静默收不到。本模块把回传
 * 可靠性拉到与 sync 同级：run 结束（非 tool_pending）时对本 run drain 到的
 * needReply 请求按 sender 去重，若本 run child 未向该 sender deliverTo 过
 * （判据 A = A2aReplyTracker 出站投递追踪，不翻 transcript、不对账 inReplyTo）
 * → 系统以 child 身份代发一条回报：
 *   - 成功（no_tool_call/no_new_messages）→ final text（复用 getFinalAnswerFromStore；
 *     取不到退化为结局通知文案）
 *   - 失败/中断（error/interrupted/doom_loop/max_iterations）→ 结局通知
 *     （stopReason + displayReason 一句原因）
 *   - tool_pending（HITL 悬挂）→ 不进本模块（caller 拦，stash 跨 run 携带）
 *
 * 全程 best-effort：单 sender 失败 catch 续下一条，MUST NOT 阻断 run 收尾主链。
 */
import { ulid } from '../config/ulid';
import type { Message } from '../message/types';
import type { AgentReplyRequest, LoopState } from './loop-ports';
import type { StopReason } from './agent-event-types';
import type { A2aReplyTracker } from './a2a-reply-tracker';
import { getFinalAnswerFromStore } from './tools/spawn-action';

/** 结算 reason：tool_pending 由 caller 拦截（只 stash 不代发），类型层钉死不进入本模块 */
export type ReplySettleReason = Exclude<StopReason, 'tool_pending'>;

/**
 * settle 依赖契约（全注入可测）。
 * deliverTo 签名对齐 AgentManagerImpl.deliverTo 前二参（返回值忽略）。
 * carried = buildRunDeps 装配时 takePending 出的跨 run 未决请求。
 */
export interface ReplyFallbackDeps {
  /** child（本 run 所属 subagent）session id */
  childSid: string;
  /** session store（成功 reason 取 final text 用，getFinalAnswerFromStore 读 transcript） */
  store: Parameters<typeof getFinalAnswerFromStore>[0];
  /** 统一投递口（经 enrichForInbox 补全 sender.agent.ref；MUST NOT 直调 inbox.append） */
  deliverTo(targetSid: string, msg: Message): Promise<unknown>;
  /** 判据 A 数据源（出站投递追踪） */
  tracker: A2aReplyTracker;
  /** run 装配时的 epoch 快照（本 run 的投递 mark 全部晚于它） */
  baseline: number;
  /** 跨 run 携带的未决请求（上一 run tool_pending stash 的） */
  carried: AgentReplyRequest[];
}

/**
 * 结算入口：合并 carried + 本 run drain 收集 → 按 fromSessionId 去重（每 sender 取最新 M.id）
 * → 判据 A 已履约跳过 → 否则构造代发消息 + deliverTo。
 */
export async function settleAgentReplyFallback(
  state: LoopState,
  deps: ReplyFallbackDeps,
  reason: ReplySettleReason,
): Promise<void> {
  const all = [...deps.carried, ...(state.agentReplyRequests ?? [])];
  if (all.length === 0) return;
  // 按发送方去重：同 sender 多条取最新 M.id（后写覆盖先写；本 run 收集晚于 carried）
  const latestByFrom = new Map<string, string>();
  for (const r of all) latestByFrom.set(r.fromSessionId, r.messageId);

  for (const [fromSid, messageId] of latestByFrom) {
    try {
      // 判据 A：本 run child 已向该 sender 投递过 → 履约，跳过（不重复代发）
      if (deps.tracker.hasDeliverySince(deps.childSid, fromSid, deps.baseline)) continue;
      const msg = await buildFallbackMessage(deps, fromSid, reason, messageId, state.error?.displayReason);
      await deps.deliverTo(fromSid, msg);
    } catch (e) {
      // best-effort：单 sender 失败续下一条，MUST NOT 阻断 run 收尾主链
      console.warn(
        `[reply-fallback] deliver to ${fromSid} failed (ignored):`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
}

/**
 * 构造系统代发 Message：以 child 身份（sender.agent.ref.sessionId=childSid；
 * type='subagent' 占位 + name 空串由 enrichForInbox 反查补全）、needReply=false
 * （防回话风暴，成功/失败同）、inReplyTo 指回该 sender 最新 M.id。
 */
export async function buildFallbackMessage(
  deps: ReplyFallbackDeps,
  targetSid: string,
  reason: ReplySettleReason,
  inReplyToId: string,
  errorDisplayReason?: string,
): Promise<Message> {
  const succeeded = reason === 'no_tool_call' || reason === 'no_new_messages';
  let text: string;
  if (succeeded) {
    let finalText = '';
    try {
      finalText = await getFinalAnswerFromStore(deps.store, deps.childSid);
    } catch {
      // transcript 读失败退化为结局通知文案（不阻断代发）
    }
    text = finalText.trim().length > 0
      ? finalText
      : '子任务已结束，但未产出文本结果。';
  } else {
    const cause = errorDisplayReason ? `；原因：${errorDisplayReason}` : '';
    text = `子任务未顺利完成（结束原因：${reason}）${cause}`;
  }
  return {
    id: ulid(),
    sessionId: targetSid,
    role: 'user',
    content: [{ type: 'text', text }],
    sender: {
      source: 'agent',
      agent: {
        // 以 child 身份代发（MUST NOT 用 parent ref）；type 占位/name 空串由 enrichForInbox 反查补全
        ref: { type: 'subagent', sessionId: deps.childSid, name: '' },
        needReply: false,
        inReplyTo: inReplyToId,
      },
    },
  };
}
