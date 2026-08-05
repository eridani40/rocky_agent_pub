/**
 * history_get_context 工具（read-only，按 messageId 回 transcript 取上下文窗）
 * 参考: specs/tech/agent/tools/[P1]history_get_context_tool.md（契约）
 *       specs/tech/version_logs/v0.0.126/change_plan.md 模块4 §historyGetContextTool
 *
 * 设计：
 *   - read-only / 免审批：profile toolBound 登记即用，不进 HITL 队列
 *   - around 窗口语义用组合调用实现（不改 MessageRange）：
 *       getMessages(beforeId=messageId, limit=before)  → 前 N 条
 *       getMessages(fromId=messageId,  limit=after+1)  → 含锚点在内的后 N+1 条
 *     合并去重保 id 升序输出（对应 spec decisions: MessageRange-around）
 *   - 输出格式：role + 完整文本（含 image/tool_use/tool_result 结构化透出）
 *   - 截断：单 message 文本 > MAX_MSG_CHARS → 截 + offload 标记；
 *     tool_result > MAX_TOOL_RESULT_CHARS → 截 + 标记；image → [image: omitted]
 */
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from './types';
import { errorResult, textResult } from './types';
import type { ContentBlock, Message } from '../message/types';
import { resolveHistoryDeps } from './history-search-tool';

/** 单 message 文本截断阈值（spec §4 一期简化 ~8k chars） */
const MAX_MSG_CHARS = 8000;
/** tool_result 内容截断阈值（spec §4 ~25k chars） */
const MAX_TOOL_RESULT_CHARS = 25000;

/** history_get_context 工具输入（宽松类型，run 内做判型校验） */
interface HistoryGetContextInput {
  sessionId?: unknown;
  messageId?: unknown;
  before?: unknown;
  after?: unknown;
}

/**
 * history_get_context 工具（单例导出，registry.defaultTools 引用）。
 * inputSchema 与 history_get_context_tool.md §2 一字不差（sessionId/messageId required）。
 * around 窗口语义通过两次 getMessages 组合实现（不改 MessageRange）。
 */
export const historyGetContextTool: Tool = {
  definition: {
    name: 'history_get_context',
    description:
      'Get the transcript context window around a specific message (by messageId anchor ' +
      'returned from history_search). Returns full structured ContentBlocks including images, ' +
      'tool_use, tool_result that the search index does not store. ' +
      'Use after history_search gave you a messageId you want to inspect in full.',
    intro: 'Get transcript context around a message.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'messageId'],
      properties: {
        sessionId: {
          type: 'string',
          description: '目标 session（来自 history_search hit.sessionId）',
        },
        messageId: {
          type: 'string',
          description: '锚点 messageId（来自 history_search hit.messageId）',
        },
        before: { type: 'number', default: 5, minimum: 0, maximum: 50, description: '前置消息数' },
        after: { type: 'number', default: 5, minimum: 0, maximum: 50, description: '后置消息数' },
      },
    },
  },

  async run(input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> {
    const deps = resolveHistoryDeps(ctx);
    if (!deps) {
      return errorResult(
        '[history_get_context] runtime error: historyToolDeps not injected',
      );
    }

    const typed = input as HistoryGetContextInput;
    const sessionId = typeof typed.sessionId === 'string' ? typed.sessionId : '';
    const messageId = typeof typed.messageId === 'string' ? typed.messageId : '';
    if (!sessionId || !messageId) {
      return errorResult('history_get_context: sessionId 和 messageId 必填');
    }

    const before =
      typeof typed.before === 'number' && typed.before >= 0
        ? Math.min(50, Math.floor(typed.before))
        : 5;
    const after =
      typeof typed.after === 'number' && typed.after >= 0
        ? Math.min(50, Math.floor(typed.after))
        : 5;

    // around 组合调用：
    //   before 段 = beforeId=messageId, limit=before（取 messageId 字典序之前的 N 条）
    //   after 段  = fromId=messageId, limit=after+1（含锚点在内的后 N+1 条）
    const beforePage = deps.sessionStore.getMessages(sessionId, {
      beforeId: messageId,
      limit: before,
    });
    const afterPage = deps.sessionStore.getMessages(sessionId, {
      fromId: messageId,
      limit: after + 1,
    });
    const [beforeRes, afterRes] = await Promise.all([beforePage, afterPage]);

    // 合并去重保 id 升序（beforeRes.items 不含锚点，afterRes.items 含锚点）
    const merged = mergeAroundWindow(
      (beforeRes.items as Message[]) ?? [],
      (afterRes.items as Message[]) ?? [],
    );
    // [history_search] 临时验证 log：get_context 调用 + 召回上下文窗
    try {
      console.log(
        `[history_search] get_context called: sessionId=${sessionId}, messageId=${messageId}, ` +
          `before=${before}, after=${after}, beforeItems=${beforeRes.items?.length ?? 0}, ` +
          `afterItems=${afterRes.items?.length ?? 0}, merged=${merged.length}`,
      );
    } catch {
      // log 本身不抛错
    }
    if (merged.length === 0) {
      return textResult(
        `history_get_context: session=${sessionId} 中未找到 messageId=${messageId}（可能已被删除或不在 transcript）`,
      );
    }
    return textResult(formatContextWindow(merged, messageId));
  },
};

/**
 * 合并 before + after 两段结果，去重保 id 升序。
 * beforeRes 不含锚点（beforeId 是「之前」），afterRes 含锚点（fromId 是「起始含」）。
 */
function mergeAroundWindow(before: Message[], after: Message[]): Message[] {
  const seen = new Set<string>();
  const out: Message[] = [];
  for (const m of before) {
    if (m.id && !seen.has(m.id)) {
      seen.add(m.id);
      out.push(m);
    }
  }
  for (const m of after) {
    if (m.id && !seen.has(m.id)) {
      seen.add(m.id);
      out.push(m);
    }
  }
  // ULID 字典序 = 时间序（旧→新）
  return out.sort((a, b) => (a.id as string).localeCompare(b.id as string));
}

/**
 * 把 Message[] 格式化为 LLM 可读文本（围绕锚点 messageId）。
 * 截断策略（spec §4，两层独立生效）：
 *   - block 级：tool_result > MAX_TOOL_RESULT_CHARS → 截 + 标记；image → [image: omitted]
 *   - message 级：单 message 的纯 text 块累加 > MAX_MSG_CHARS → 截 + offload 标记
 *     （仅看 text 块累加长度，不含已 block 级截断的 tool_result/image —— 避免 message 级截断
 *      把 block 级截断标记也吃掉）
 * 与 history_get_context_tool.md §4 输出格式对齐。
 */
export function formatContextWindow(messages: Message[], anchorId: string): string {
  const lines: string[] = [`session=${messages[0]?.sessionId ?? ''}  围绕 msg=${anchorId}：`];
  for (const m of messages) {
    const isAnchor = m.id === anchorId;
    const tag = isAnchor ? ' *' : ''; // 锚点行末标 *
    lines.push(`[${m.id} role=${m.role}]${tag}`);
    // 先做 block 级截断（tool_result / image 处理）
    const blockText = blocksToText(m.content ?? []);
    // message 级只看纯 text 块累加（text-only 累加超 8k 才整体截断）
    const textOnlyLen = (m.content ?? [])
      .filter((b) => b.type === 'text')
      .reduce((sum, b) => sum + (((b as { text?: string }).text ?? '').length), 0);
    if (textOnlyLen > MAX_MSG_CHARS) {
      const truncated = blockText.slice(0, MAX_MSG_CHARS);
      lines.push(
        `${truncated}\n[... offloaded: message ${m.id} 超 ${MAX_MSG_CHARS} chars，已截断]`,
      );
    } else {
      lines.push(blockText);
    }
  }
  return lines.join('\n');
}

/**
 * 把 ContentBlock[] 渲染成单条字符串（透出 text + tool_use + tool_result；image 替换为标记）。
 * tool_result 超 MAX_TOOL_RESULT_CHARS 截断（一期简化策略）。
 */
function blocksToText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'text': {
        const tb = b as { type: 'text'; text: string };
        parts.push(tb.text ?? '');
        break;
      }
      case 'image': {
        parts.push('[image: omitted]');
        break;
      }
      case 'tool_call': {
        const tcb = b as {
          type: 'tool_call';
          name?: string;
          arguments?: unknown;
        };
        const argStr = safeJson(tcb.arguments);
        parts.push(`<tool_use name=${tcb.name ?? '?'}>${argStr}</tool_use>`);
        break;
      }
      case 'tool_result': {
        const trb = b as {
          type: 'tool_result';
          content?: unknown;
          isError?: boolean;
        };
        const raw = typeof trb.content === 'string' ? trb.content : safeJson(trb.content);
        const errTag = trb.isError ? ' isError' : '';
        const truncated =
          raw.length > MAX_TOOL_RESULT_CHARS
            ? `${raw.slice(0, MAX_TOOL_RESULT_CHARS)}\n[... tool_result 超 ${MAX_TOOL_RESULT_CHARS} chars，已截断]`
            : raw;
        parts.push(`<tool_result${errTag}>${truncated}</tool_result>`);
        break;
      }
      case 'tool_reply': {
        const trpb = b as { type: 'tool_reply'; payload?: unknown };
        parts.push(`<tool_reply>${safeJson(trpb.payload)}</tool_reply>`);
        break;
      }
      case 'reasoning': {
        // reasoning 块一期不透出（避免灌爆 LLM 上下文）
        break;
      }
      case 'usage': {
        // usage 块不透出
        break;
      }
      default: {
        // 兜底：未识别块输出类型标记
        parts.push(`[block:${(b as { type?: string }).type ?? 'unknown'}]`);
      }
    }
  }
  return parts.join('\n');
}

/** 安全序列化 JSON（异常或 undefined 返占位） */
function safeJson(v: unknown): string {
  if (v === undefined) return '(undefined)';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return '(unserializable)';
  }
}
