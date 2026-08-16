/**
 * mate-exit-notify —— mate run 退出通知 leader hook（v0.0.273 块1）
 * 参考: specs/tech/version_logs/v0.0.273/change_plan.md（R1-R5）
 *       specs/tech/version_logs/v0.0.362/change_plan.md（run-end 汇报去重）
 *       specs/tech/multi_agent/[P1]a2a_protocol.md（send_message 信封构造）
 *       app/server/src/agent/tools/send-message-tool.ts（sender.source='agent' + selfAgentRef）
 *
 * 语义：mate 顶级 run 统一退出口（RunLifecyclePort.onRunEnd/onInterrupted）触发系统级投递——
 * 私聊 leader 通知（stopReason + 最后消息 block 摘要前后 500 截断 + 耗时 + tool_pending 时 pendingToolCalls）。
 *
 * 纯函数（truncateText/formatMateExitNotify）零副作用可 UT；notifyMateExit 执行通知
 * （readRuntimeContext → 两跳解析 leader sessionId → 构造 Message → deliverTo），
 * 解析/投递失败 try/catch 仅 warn，绝不阻断 run 退出主链。
 */
import { ulid } from '../config/ulid';
import type { Message, ContentBlock } from '../message/types';
import type { StopReason } from './agent-event-types';
import type { SessionStore } from './session-store';
import type { SessionConfig } from './context-types';
import type { LoopState } from './loop-ports';
import type { PendingToolCall } from '../tools/types';
import { readRuntimeContext, selfAgentRef } from './tools/runtime-context';

/** block 过滤白名单（7 类取 5；reasoning/usage 排除） */
const NOTIFY_BLOCK_TYPES = new Set<ContentBlock['type']>(['text', 'tool_call', 'tool_result', 'tool_reply', 'image']);

/**
 * 文本前后各 limit 字符截断，中间省略标记 + 省略字符数。
 * 长度 ≤ limit*2 原样返回；省略后保留首尾（便于 leader 看最后动作 + 开头上下文）。
 */
export function truncateText(text: string, limit = 500): string {
  if (text.length <= limit * 2) return text;
  const head = text.slice(0, limit);
  const tail = text.slice(-limit);
  const omitted = text.length - limit * 2;
  return `${head}...（省略 ${omitted} 字符）...${tail}`;
}

/** 提取 tool_result.content 内层 text（递归浅展平，供通知摘要） */
function extractText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'tool_result') parts.push(extractText(b.content));
  }
  return parts.join(' ');
}

/** 单个 block → 通知行文本；过滤外类型（reasoning/usage）返 null（不渲染） */
function renderBlock(block: ContentBlock): string | null {
  switch (block.type) {
    case 'text':
      return `text: ${truncateText(block.text)}`;
    case 'tool_call':
      return `tool_call: ${block.name}(${JSON.stringify(block.arguments)})`;
    case 'tool_result':
      return `tool_result: ${truncateText(extractText(block.content))}`;
    case 'tool_reply':
      return `tool_reply: ${block.handleType}`;
    case 'image':
      return `image: ${block.mediaType}`;
    default:
      return null; // reasoning / usage 排除
  }
}

/** formatMateExitNotify 输入（纯数据；name/role 从 runtime context 投影） */
export interface MateExitNotifyInput {
  /** mate 名（selfName） */
  name: string;
  /** mate role（selfType） */
  role: string;
  /** 退出原因（7 种 stopReason 之一） */
  stopReason: StopReason;
  /** 耗时（秒） */
  durationSec: number;
  /** 最后 assistant 消息 content blocks（state.lastAssistantContent） */
  lastContent?: ContentBlock[];
  /** tool_pending 时 Session.pendingToolCalls 摘要 */
  pendingToolCalls?: PendingToolCall[];
}

/**
 * 构造通知 markdown（纯函数）：
 * ```
 * 【mate 退出通知】{name}（{role}）run 已退出
 * 退出原因: {stopReason}
 * 耗时: {durationSec}s
 * 最后消息:
 * - text: ...
 * - tool_call: xxx({...})
 * [待审批] 悬挂工具: xxx(id)
 * ```
 * block 过滤 5 类（text/tool_call/tool_result/tool_reply/image），每块前后 500 截断；
 * reasoning/usage 不渲染；输出 minimal（不带 runId/迭代轮数）。
 */
export function formatMateExitNotify(input: MateExitNotifyInput): string {
  const lines: string[] = [];
  lines.push(`【mate 退出通知】${input.name}（${input.role}）run 已退出`);
  // v0.0.338 M1：interrupted 追加提示（由用户中断，老板钦定文案），其他 6 种 reason 输出逐字节不变
  const reasonLine =
    input.stopReason === 'interrupted'
      ? `退出原因: ${input.stopReason}（由用户主动中断，无需处理）`
      : `退出原因: ${input.stopReason}`;
  lines.push(reasonLine);
  lines.push(`耗时: ${input.durationSec}s`);
  if (input.lastContent && input.lastContent.length > 0) {
    lines.push('最后消息:');
    for (const block of input.lastContent) {
      if (!NOTIFY_BLOCK_TYPES.has(block.type)) continue;
      const rendered = renderBlock(block);
      if (rendered !== null) lines.push(`- ${rendered}`);
    }
  }
  if (input.pendingToolCalls && input.pendingToolCalls.length > 0) {
    const tools = input.pendingToolCalls.map((p) => `${p.toolName}(${p.toolCallId})`).join(', ');
    lines.push(`[待审批] 悬挂工具: ${tools}`);
  }
  return lines.join('\n');
}

/**
 * [v0.0.362] run-end 汇报去重判定（纯函数，零 IO）：
 * 最近 N 轮 assistant message 内是否有 send_message→leader 的 tool_call。
 *
 * 数据源：snapshot.messages 过滤 assistant + lastAssistantContent 拼伪消息补末轮
 * （run 的最终 assistant 回复不在 snapshot 内——snapshot 是发给 LLM 的输入侧，
 * 不补则最常见的末轮 send_message 永不命中）→ slice(-window) 窗口。
 *
 * target 命中三形态（req 口径）：字符串 'parent'（mate 的 parent 即 leader）/
 * 字符串显式 sessionId===leaderSid / AgentRef.sessionId===leaderSid。
 * name 形态 AgentRef 不解析比对（避免每条 tool_call 异步 store 解析，老板拍板已知限制）；
 * 只看 tool_use 存在性，不看 needReply/发送成败。
 */
export function hasRecentLeaderReport(
  snapshotMessages: Message[] | null | undefined,
  lastAssistantContent: ContentBlock[] | undefined,
  leaderSid: string,
  window = 3,
): boolean {
  // snapshot null（理论不达，防御）→ 视为未命中照发
  if (!snapshotMessages) return false;
  const rounds: ContentBlock[][] = snapshotMessages
    .filter((m) => m.role === 'assistant')
    .map((m) => m.content);
  // 末轮补拼：最终 assistant 回复不在 snapshot 内，非空时追加为伪消息
  if (lastAssistantContent && lastAssistantContent.length > 0) rounds.push(lastAssistantContent);
  const recent = rounds.slice(-window);
  for (const blocks of recent) {
    for (const b of blocks) {
      if (b.type !== 'tool_call' || b.name !== 'send_message') continue;
      const t = b.arguments?.target;
      // 三形态命中：'parent' 直命中（mate 的 parent 即 leader）/ 字符串 ===leaderSid / AgentRef.sessionId===leaderSid
      if (t === 'parent' || t === leaderSid) return true;
      if (
        typeof t === 'object' && t !== null && !Array.isArray(t) &&
        (t as { sessionId?: unknown }).sessionId === leaderSid
      ) return true;
    }
  }
  return false;
}

/** notifyMateExit 执行参数 */
export interface NotifyMateExitOpts {
  config: SessionConfig;
  /** 装配时注入的 squadId（buildRunDeps 从 sessionContext.squadId 取） */
  squadId: string;
  stopReason: StopReason;
  durationSec: number;
  pendingToolCalls?: PendingToolCall[];
}

/**
 * 执行 mate 退出通知：两跳解析 leader sessionId（getSquad.leaderId → getMember.sessionId，
 * 仿 runtime-context resolveSquadAlias 'leader'）→ 构造 Message（sender.source='agent' +
 * selfAgentRef + needReply:false）→ deliverTo。失败 try/catch 仅 warn，不抛（不阻断主链）。
 */
export async function notifyMateExit(
  state: LoopState,
  opts: NotifyMateExitOpts,
): Promise<void> {
  try {
    const rtc = readRuntimeContext(opts.config);
    const squad = await rtc.squadStore?.getSquad(opts.squadId);
    if (!squad) {
      console.warn(`[mateExitNotify] squad not found (${opts.squadId}), skip notify`);
      return;
    }
    const leader = await rtc.memberStore?.getMember(squad.id, squad.leaderId);
    const leaderSid = leader?.sessionId;
    if (!leaderSid) {
      console.warn(`[mateExitNotify] leader session not found (squad ${opts.squadId}, leaderId ${squad.leaderId}), skip notify`);
      return;
    }
    // [v0.0.362] run-end 汇报去重：最近 3 轮 assistant 内已有 send_message→leader 调用
    // 则认定已汇报过，跳过本次投递（只看 tool_use 存在性，不看 needReply/成败）
    if (hasRecentLeaderReport(state.snapshot?.messages, state.lastAssistantContent, leaderSid)) {
      console.log('[mateExitNotify] recent send_message to leader found, skip run-end report (dedup)');
      return;
    }
    const markdown = formatMateExitNotify({
      name: rtc.selfName,
      role: rtc.selfType ?? 'mate',
      stopReason: opts.stopReason,
      durationSec: opts.durationSec,
      lastContent: state.lastAssistantContent,
      pendingToolCalls: opts.pendingToolCalls,
    });
    const msg: Message = {
      id: ulid(),
      sessionId: leaderSid,
      role: 'user',
      content: [{ type: 'text', text: markdown }],
      // a2a 信封：sender 身份 = 该 mate（self），needReply=false（fyi 通知不要求回复）
      sender: {
        source: 'agent',
        agent: { ref: selfAgentRef(rtc), needReply: false },
      },
    };
    await rtc.agentManager.deliverTo(leaderSid, msg);
  } catch (e) {
    console.warn('[mateExitNotify] notify failed (ignored):', e instanceof Error ? e.message : String(e));
  }
}
