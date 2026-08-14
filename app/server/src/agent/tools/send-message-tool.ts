/**
 * send_message 工具 —— a2a 投递（v0.0.28 task-2 / v0.0.33.2 T5 加 squad clique 校验）
 * 参考: specs/tech/multi_agent/[P1]subagent_derivation.md §5（send_message 工具签名 + 流程）
 *       specs/tech/multi_agent/[P1]a2a_protocol.md §2.2（别名解析）+ §6（工具层校验）
 *
 * 语义：agent→agent 投递 = 普通 inbox 入队 + activate；sender.source='agent' 承载 a2a 信封
 * （AgentRef + needReply + inReplyTo）。流程：resolve target（含 squad 别名）→ 校验 reachable
 * （subagent→parent / squad clique）→ manager.deliverTo(target.sid, msg) → 返 { messageId }。
 */
import { ulid } from '../../config/ulid';
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from '../../tools/types';
import { errorResult, textResult } from '../../tools/types';
import {
  readRuntimeContext, selfAgentRef, resolveAgentRefWithSquad,
} from './runtime-context';
import type { Message, ContentBlock } from '../../message/types';

/**
 * send_message 工具（单例导出，registry defaultTools 引用）。
 * 工具 run 时从 ctx.config.agentToolContext 读 runtime context。
 */
export const sendMessageTool: Tool = {
  definition: {
    name: 'send_message',
    description:
      'Send a message to another agent (a2a). target = AgentRef | sessionId | "parent". ' +
      'needReply (default:true): true = recipient must reply via send_message; false = fyi. Usually needReply is true, unless asked to be false. ' +
      'content is an array of {type:"text", text:string} blocks, e.g. [{"type":"text","text":"hi"}]. Each block MUST include the "type" field. ' +
      'Returns { messageId } immediately (fire-and-forget). Sub-agents can only target parent.',
    intro: 'Send a message to another agent by session id',
    inputSchema: {
      type: 'object',
      // [v0.0.68 R5] needReply 移出 required，改 default:true（D5 default-fill 在 engine.validateInput 末尾注入）
      required: ['target', 'content'],
      properties: {
        target: {
          description: 'AgentRef {type,sessionId,name} | sessionId string | "parent" alias',
        },
        content: {
          // [v0.0.311] 去掉 type:'array' 硬约束——engine.ts checkPrimitive 会在 tool.run() 前
          // 拦截非数组 content（string/object），导致 normalizeSendMessageInput 容错永远没机会执行。
          // 保留 items 供 LLM 参考结构，类型检查由 normalizeSendMessageInput 兜底（string/object→array）。
          description: 'message content blocks (array of {type:"text", text:string})',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: '"text"' },
              text: { type: 'string', description: 'message text' },
            },
            required: ['type', 'text'],
          },
        },
        // [v0.0.68 R5] default:true：LLM 不填时 engine.validateInput default-fill 注入 true
        needReply: {
          type: 'boolean',
          default: true,
          description: 'TOP-LEVEL boolean (default:true). true=recipient must reply; false=fyi/notice. Do NOT put inside content.',
        },
        inReplyTo: {
          type: 'string',
          description: 'original message.id (thread link)',
        },
      },
    },
  },

  async run(input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> {
    let rtc;
    try {
      rtc = readRuntimeContext(ctx.config);
    } catch (e) {
      return errorResult(`send_message: ${e instanceof Error ? e.message : String(e)}`);
    }

    // [BUG-031] 入参容错：LLM 常见异常形态 → 规范化为 spec §5.1 权威形态。
    // 异常形态（来自真 LLM 实测）：
    //   A. content 当对象（{item:{...}, needReply:true}）→ 提取 content 内嵌 needReply 到顶层，
    //      content 取 .item 或当单 block
    //   B. content 是单 block 对象（{type:"text",text:"..."}）→ 包成 [block]
    //   C. content 是字符串 → 包成 [{type:"text",text:str}]
    //   D. needReply 嵌在 content 对象里而非顶层 → 提取到顶层
    const normalized = normalizeSendMessageInput(input);
    if (normalized.error) {
      return errorResult(normalized.error);
    }
    const { target, content, needReply, inReplyTo } = normalized;

    if (target === undefined || target === null) {
      return errorResult('send_message: target is required');
    }

    // resolve target → sessionId（a2a_protocol §2.2 别名优先级 1-5 全集）。
    // [v0.0.33.2] 改 async 包装：先同步（sessionId/'parent'/struct），未命中走 squad 别名
    // （'squadchat'/'leader'/member name），后者需读 squadStore/memberStore（架构 §2.F 改动3）。
    const targetSid = await resolveAgentRefWithSquad(target, rtc);
    if (!targetSid) {
      return errorResult('send_message: cannot resolve target');
    }

    // 校验 target ∈ caller.reachable_agents（a2a §6 + 架构 §2.F 改动1）：
    // subagent→parent 既有硬约束 + squad clique 同 squad 互相可达 + 跨 squad 拒绝。
    const reachableCheck = await checkReachable(rtc, targetSid);
    if (reachableCheck !== null) {
      return errorResult(reachableCheck);
    }

    // 构造 a2a 消息（sender.source='agent' + agent 子结构承载 ref/needReply/inReplyTo）
    const msg: Message = {
      id: ulid(),
      sessionId: targetSid,
      role: 'user',
      content: content as ContentBlock[],
      // [BUG-032] sender.agent.ref 必须是 caller self（发送方身份），不是 parent。
      // enrichForInbox 用 ref.sessionId 反查 sender session record 补全 type/name——
      // sessionId 是 caller self → 反查 caller self → 得到正确的发送方 type/name。
      // 旧实现误用 parentAgentRef（对 subagent caller 返回 parentSessionId=接收方，
      // 导致 enrich 反查接收方 → sender.agent.ref 指向接收方自己）。
      sender: {
        source: 'agent',
        agent: {
          ref: selfAgentRef(rtc),
          needReply,
          ...(typeof inReplyTo === 'string' && inReplyTo.length > 0 ? { inReplyTo } : {}),
        },
      },
    };

    try {
      // deliverTo 统一投递（inbox.append + activate），fire-and-forget 忽略返回的 run
      await rtc.agentManager.deliverTo(targetSid, msg);
      // [v0.0.311] 返回 targetName 供前端信封显示可读名（覆盖 subagent 等 non-squad-member 场景）
      // 优先级：AgentRef object 的 .name → session record 的 .title → undefined（前端 fallback '...'）
      const targetName = await resolveTargetDisplayName(target, targetSid, rtc);
      return textResult(JSON.stringify({ messageId: msg.id, ...(targetName ? { targetName } : {}) }));
    } catch (e) {
      return errorResult(`send_message: deliverTo failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

/**
 * 校验 target ∈ caller.reachable_agents（a2a_protocol §6 + 架构 §2.F 改动1）。三层分流：
 *   1. subagent scope（parentScope==='subagent'）→ 仅可达 parent（既有不变）
 *   2. squad clique（selfType∈{squad,leader,mate}）→ checkSquadClique（同 squad 4 type 互相可达）
 *   3. 顶层 standalone → null（reachable_agents 为空，LLM 不会调）
 * @returns null=可达；非空串=拒绝原因
 */
async function checkReachable(
  rtc: ReturnType<typeof readRuntimeContext>,
  targetSid: string,
): Promise<string | null> {
  // 分流 1：subagent 仅可达 parent（a2a §3/§6，既有拦截保留）
  if (rtc.parentScope === 'subagent') {
    if (targetSid !== rtc.parentSessionId) {
      return 'subagent can only send to parent (sender.parentSessionId)';
    }
    return null;
  }
  // 分流 2：squad clique 校验
  if (rtc.selfType === 'squad' || rtc.selfType === 'leader' || rtc.selfType === 'mate') {
    return checkSquadClique(rtc, targetSid);
  }
  return null;
}

/**
 * [v0.0.33.2] squad clique 拓扑校验（架构 §2.F 改动1 + a2a §2.3/§6）。
 * 同 squad 内 squad/leader/mate 互相可达；跨 squad 或 target 非 clique type（subagent/undefined）拒绝。
 * 数据来源：caller.selfSquadId + target session record（rtc.store.getSession）。
 */
async function checkSquadClique(
  rtc: ReturnType<typeof readRuntimeContext>,
  targetSid: string,
): Promise<string | null> {
  if (!rtc.selfSquadId) {
    return 'send_message: caller has no selfSquadId (squad clique validation cannot proceed)';
  }
  const target = await rtc.store.getSession(targetSid);
  if (!target) {
    return `send_message: target session not found (${targetSid})`;
  }
  // 跨 squad 拒绝（a2a §2.3）
  if (target.squadId !== rtc.selfSquadId) {
    return 'cross-squad a2a not allowed (caller and target must be in the same squad)';
  }
  // target 必须 ∈ clique type（subagent 是 mate 私产子 agent，不在 squad clique）
  // [v0.0.56] role 替代旧 type 判定
  if (target.role !== 'squad' && target.role !== 'leader' && target.role !== 'mate') {
    return `target not in squad clique (target.role=${target.role ?? 'undefined'}; expected squad|leader|mate)`;
  }
  return null;
}

/**
 * [v0.0.331] 规范化 send_message content（语义唯一来源，与工具定义同文件防漂移）。
 * 从 normalizeSendMessageInput 内循环抽出，行为逐字段一致：
 *   - array：每块校验 object + text 是 string，缺 type 补 `type:'text'`（未知 type 不透传）
 *   - string → [{type:'text',text:str}]（形态 C）
 *   - object（非数组）→ `.item ?? obj` 解包；解包后仍单 block object → 包数组（形态 A/B）
 *   - 其他（number/null/undefined 等）→ error 形态（由调用方处理，不抛）
 * @returns ContentBlock[]（成功）| { error: string }（失败，语义与 normalizeSendMessageInput 原 error 一致）
 */
export function normalizeContentBlocks(
  rawContent: unknown,
): ContentBlock[] | { error: string } {
  // 形态 A/B：object（非数组）→ 解包 .item ?? obj
  let content: unknown = rawContent;
  if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
    const obj = content as Record<string, unknown>;
    content = obj.item ?? obj;
  }
  // 形态 C：字符串 → 单 text block
  if (typeof content === 'string') {
    content = [{ type: 'text', text: content }];
  }
  // 形态 B：单 block 对象 → 包成数组
  if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
    content = [content];
  }
  // 此刻 content 必须是数组（其他形态 → error）
  if (!Array.isArray(content)) {
    return {
      error: 'send_message: content must be array of {type:"text",text:string} blocks (or a single block/string)',
    };
  }
  // 校验每个 block 至少有 text 字段（容错：缺 type 补 'text'）
  const blocks: ContentBlock[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') {
      return { error: 'send_message: content block must be object' };
    }
    const b = block as Record<string, unknown>;
    const text = b.text;
    if (typeof text !== 'string') {
      return { error: 'send_message: content block missing text string' };
    }
    // send_message 容错只产出 text block（LLM 误传的未知 type 不透传——避免脏数据落库）
    blocks.push({ type: 'text', text });
  }
  if (blocks.length === 0) {
    return { error: 'send_message: content must be non-empty array' };
  }
  return blocks;
}

/**
 * [BUG-031] 规范化 send_message 入参：把 LLM 常见异常形态转成 spec §5.1 权威形态。
 *
 * 处理的异常形态（真 LLM 实测）：
 *   A. content 是对象（非数组）→ 视为「包裹信封」（提取内嵌 needReply/inReplyTo + payload 取 .item 或本身当单 block）
 *   B. content 是单 block 对象（{type:"text",text:...}）→ 包成 [block]
 *   C. content 是字符串 → 包成 [{type:"text",text:str}]；D. 数组保留原样
 *   E. [v0.0.68 R5] needReply 缺失（顶层 + content 内都无）→ default:true（spec §5.1 default:true）
 *      显式 boolean（含 false）保留不变（UC-14：false 不被覆盖）
 *
 * content 形态统一交给 normalizeContentBlocks（v0.0.331 抽出，语义唯一来源）。
 *
 * @returns 成功：{target, content:ContentBlock[], needReply, inReplyTo}；失败：{error}
 */
function normalizeSendMessageInput(input: ToolInput): {
  target: unknown;
  content: ContentBlock[];
  needReply: boolean;
  inReplyTo?: string;
  error?: string;
} {
  const target = input.target;
  let needReply: unknown = input.needReply;
  let inReplyTo: unknown = input.inReplyTo;

  // 形态 A/D：content 是对象（非数组、非 null）→ 提取嵌套在 content 里的 needReply/inReplyTo
  if (input.content !== null && typeof input.content === 'object' && !Array.isArray(input.content)) {
    const obj = input.content as Record<string, unknown>;
    // 提取嵌套的 needReply / inReplyTo（LLM 误把顶层字段嵌进 content）
    if (typeof obj.needReply === 'boolean' && typeof needReply !== 'boolean') {
      needReply = obj.needReply;
    }
    if (typeof obj.inReplyTo === 'string' && typeof inReplyTo !== 'string') {
      inReplyTo = obj.inReplyTo;
    }
  }

  // 形态 A/B/C/D 统一交给 normalizeContentBlocks（解包/包数组/补 type/error 语义一致）
  const normalizedContent = normalizeContentBlocks(input.content);
  if ('error' in normalizedContent) {
    return {
      target,
      content: [],
      needReply: false,
      error: normalizedContent.error,
    };
  }
  const content = normalizedContent;

  // [v0.0.68 R5] needReply 改可选 default:true（spec §5.1）。
  //   - engine.validateInput default-fill 已在 tool.run 前注入 input.needReply=true（缺省时）
  //   - 此处兜底：直接调 run（绕过 engine，如 UT）或 normalize 内 needReply 仍非 boolean → default true
  //   - 显式 boolean（含 false）保留：false 不被 default 覆盖（UC-14 关键）
  // 用 const 收敛 boolean 类型（let unknown 在跨函数体不被 TS narrow）
  const finalNeedReply: boolean = typeof needReply === 'boolean' ? needReply : true;

  const result: ReturnType<typeof normalizeSendMessageInput> = {
    target,
    content,
    needReply: finalNeedReply,
  };
  if (typeof inReplyTo === 'string' && inReplyTo.length > 0) {
    result.inReplyTo = inReplyTo;
  }
  return result;
}

/**
 * [v0.0.311] 解析 target 的可读显示名（供前端信封 targetName）。
 * 优先级：① AgentRef object 的 .name（LLM 已填）→ ② memberStore 反查（target session 是 squad 成员时，
 *   [v0.0.340 决策 1] 读单一源：成员名权威源 = memberStore，不再把 session.title 当成员名读）→
 *   ③ session record 的 .title（non-squad-member：subagent/squad chat/standalone fallback）→ ④ undefined
 * 覆盖 subagent 等 non-squad-member 场景（前端只有 squad members 列表，查不到 subagent）。
 */
async function resolveTargetDisplayName(
  target: unknown,
  targetSid: string,
  rtc: ReturnType<typeof readRuntimeContext>,
): Promise<string | undefined> {
  // 优先级 1：AgentRef object 带 .name
  if (target && typeof target === 'object') {
    const name = (target as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  // 优先级 2：target session 是 squad 成员 → memberStore 反查实时名（改名后不依赖 title 快照）
  try {
    const session = await rtc.store.getSession(targetSid);
    if (session) {
      if (
        session.squadId !== undefined &&
        session.memberId !== undefined &&
        rtc.memberStore
      ) {
        try {
          const member = await rtc.memberStore.getMember(session.squadId, session.memberId);
          if (member?.name && member.name.length > 0) return member.name;
        } catch {
          // member 反查失败（member 已删/读失败）静默 fallback，不抛错
        }
      }
      // 优先级 3：session.title fallback（subagent/squad chat/standalone 等 non-squad-member）
      if (session.title && session.title.length > 0) return session.title;
    }
  } catch {
    // getSession 失败不阻塞投递结果，fallback undefined
  }
  return undefined;
}
