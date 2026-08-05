/**
 * inbox 入口 enrich（v0.0.31 task-2 功能 A 核心）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_inbox_enqueue.md §2.5
 *       specs/tech/agent/message/[P0]agent_message_interface.md §5（sender 判别联合）
 *       specs/tech/multi_agent/[P1]a2a_protocol.md §2（AgentRef 结构）
 *
 * 职责：对 sender.source === 'agent' 的 message normalize——确保 sender.agent 形态完整
 *   （type/name 反查发送方 session record 补全 + needReply 必填 + inReplyTo 透传）。
 *   调用方传了 type/name 则用反查结果校验，不一致 warn 不阻断（以反查为准）。
 *
 * 位置：AgentManager.deliverTo 内部、enqueue 之前（所有进 inbox 的 a2a message 必经此步）。
 *
 * 本质（程序构造性）：sender 信封由程序组装、非 LLM 构造。LLM 入口（spawn / send_message）
 *   只传 AgentRef + 工具入参；type/name 是反查出来的程序内部细节，不参与路由（路由只靠 sessionId）。
 *
 * 单文件 ≤300 行（纯函数 + type 映射 + name 推导）。
 */
import type { Message, MessageSender, AgentRef, MessageSenderAgent } from '../message/types';
import type { Session } from './session-store-types';

/**
 * enrichForInbox 反查发送方 session record 用到的 store 最小接口。
 * 生产环境注入 SessionStore；测试可注入 mock。
 */
export interface EnrichSessionLookup {
  /** 按 sessionId 读 session record（enrich 反查发送方 type/name 用） */
  getSession(sessionId: string): Promise<Session | null>;
}

/**
 * 把发送方 session 的 (role, derivation) 映射为 AgentRef.type
 * （[P0]agent_inbox_enqueue.md §2.5.2 伪代码 mapSessionTypeToAgentRefType）。
 *
 * [v0.0.56 hotfix] 直接从 senderSession 字段派生（删 sessionTypeStr 中间量）：
 *   - derivation='subagent' → 'subagent'
 *   - role='rocky' / 缺省 → 'rocky'（顶层 standalone parent；旧 'session' 已收敛到 'rocky'）
 *   - role='leader'/'mate'/'squad' → 同名
 *
 * @param senderSession 反查到的发送方 session record
 */
export function mapSessionTypeToAgentRefType(
  senderSession: Session,
): AgentRef['type'] {
  // derivation 是 subagent 判定的权威源
  if (senderSession.derivation === 'subagent') return 'subagent';
  // 顶层 standalone / rocky → 'rocky'（旧 'session' 占位已废）
  const role = senderSession.role ?? 'rocky';
  if (role === 'rocky') return 'rocky';
  // 'leader' | 'mate' | 'squad' 同名直通
  return role as AgentRef['type'];
}

/**
 * 推导发送方 AgentRef.name（[P0]agent_inbox_enqueue.md §2.5.3 name 反查规则）。
 *
 * | session.type | name 取值 |
 * |-------------|----------|
 * | 'subagent' | subAgentTemplateType（如 "explorer"）；为空 → "subagent" |
 * | undefined / 其他 | session.title；无标题 → "parent" |
 *
 * 约束：name 不参与路由、不要求唯一、**不取 sessionId 片段**（人类可读语义）。
 *
 * @param senderSession 反查到的发送方 session record
 */
export function deriveAgentRefName(senderSession: Session): string {
  // [v0.0.56] derivation 是 subagent 判定的权威源
  if (senderSession.derivation === 'subagent') {
    const templateType = senderSession.subAgentTemplateType;
    if (templateType && templateType.length > 0) return templateType;
    return 'subagent';
  }
  // 顶层 standalone / leader / mate / squad → title || 'parent'
  const title = senderSession.title;
  if (title && title.length > 0) return title;
  return 'parent';
}

/** AgentRef.type 已含 'session'（types.ts，v0.0.31 加——顶层 standalone 非角色 session 的 type），
 *  enrich 直接产出 AgentRef['type']，无需 cast。 */
/**
 * inbox 入口 enrich：对 source='agent' 的 message normalize（a2a 形态补全）。
 *
 * - sender.source !== 'agent' → 原样返回（user/system/approval 无 agent 子结构，判别联合保证）
 * - sender.source === 'agent' → 校验 + 补全 sender.agent.ref（sessionId 路由权威必填；
 *   type/name 反查发送方 session record）；needReply 必填（a2a）；inReplyTo 可选透传
 *
 * @param message 待入队的 message（可能 sender.agent.ref 不完整：仅 sessionId 无 type/name）
 * @param lookup 反查发送方 session record 的最小接口（生产注入 SessionStore）
 * @returns normalize 后的 message（enrich 完成后送 enqueue）
 * @throws Error 当 source='agent' 且 sender.agent.ref.sessionId 缺失（路由权威不可缺失）
 * @throws Error 当 source='agent' 且发送方 session record 不存在
 * @throws Error 当 source='agent' 且 sender.agent.needReply 缺失（a2a 必填）
 */
export async function enrichForInbox(
  message: Message,
  lookup: EnrichSessionLookup,
): Promise<Message> {
  const sender: MessageSender | undefined = message.sender;
  if (!sender || sender.source !== 'agent') {
    // user/system/approval/tool_reply 不 enrich（判别联合保证无 agent 子结构）。
    // [v0.0.101 T4] tool_reply sender 只携 tool_reply.{toolCallId,runId}（由 POST /messages handler
    //   构造完整），不进 a2a 反查链路。pre-process drain 时按 sender.source 走 handleToolReply。
    return message;
  }

  const agent: MessageSenderAgent = sender.agent;
  const ref = agent.ref;

  // ── 路由权威：sessionId 必填 ──
  if (!ref.sessionId || ref.sessionId.length === 0) {
    throw new Error(
      "enrich: source='agent' but sender.agent.ref.sessionId missing (route authority)",
    );
  }

  // ── 反查发送方 session record ──
  const senderSession: Session | null = await lookup.getSession(ref.sessionId);
  if (!senderSession) {
    throw new Error(`enrich: sender session not found: ${ref.sessionId}`);
  }

  // [v0.0.56 hotfix] 反查补全 type：直接从 senderSession(role+derivation) 派生（无中间量）。
  const expectedType = mapSessionTypeToAgentRefType(senderSession);
  // 反查补全 name（req2.md §5 name 规则）
  const expectedName = deriveAgentRefName(senderSession);

  // ── 防幻觉契约：caller 传了 → 校验 warn 不一致；没传 → 反查补全 ──
  // 注：ref.type / ref.name 在 AgentRef 中是必填（types.ts），但 LLM 入口或 caller 可能
  //   传占位值。这里按「caller 传非空值就校验」处理：传空串/占位等同没传 → 反查补全。
  const callerType = ref.type;
  const callerName = ref.name;

  let finalType: AgentRef['type'] = expectedType;
  if (callerType && callerType.length > 0) {
    if (callerType !== expectedType) {
      console.warn(
        `enrich: sender.agent.ref.type mismatch (caller=${callerType}, actual=${expectedType}); using actual`,
      );
    }
    finalType = expectedType; // 反查结果覆盖（sessionId 权威延伸：type/name 不参与路由，以反查为准）
  }

  let finalName: string = expectedName;
  if (callerName && callerName.length > 0) {
    if (callerName !== expectedName) {
      console.warn(
        `enrich: sender.agent.ref.name mismatch (caller=${callerName}, actual=${expectedName}); using actual`,
      );
    }
    finalName = expectedName;
  }

  // ── needReply：a2a 必填（caller 未填 → error；enrich 不补默认值，由 caller 按场景定）──
  // 注：spawn sync/async 首任务的 needReply 在 buildFirstTaskMessage 阶段已定；
  //     send_message 工具的 needReply 由 LLM 必填（send-message-tool.ts inputSchema required）。
  //     enrich 只校验「已存在」不补默认——保持 caller 责任清晰。
  if (typeof agent.needReply !== 'boolean') {
    throw new Error(
      "enrich: source='agent' but sender.agent.needReply missing (required for a2a)",
    );
  }

  // ── inReplyTo：可选（thread 线索；首任务无 parent message 不填）──
  // enrich 不干预，原样透传

  // ── 返回 normalize 后的 message ──
  const enrichedSender: MessageSender = {
    source: 'agent',
    agent: {
      ref: {
        type: finalType,
        sessionId: ref.sessionId,
        name: finalName,
      },
      needReply: agent.needReply,
      ...(agent.inReplyTo ? { inReplyTo: agent.inReplyTo } : {}),
    },
  };

  return {
    ...message,
    sender: enrichedSender,
  };
}
