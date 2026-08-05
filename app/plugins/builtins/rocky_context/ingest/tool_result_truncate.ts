/**
 * builtin rocky_context plugin — ingest handler: tool_result_truncate
 * 参考: specs/tech/agent/context_and_memory/[P0]extension point and implementations.md §3.1/§4.2
 *       specs/tech/agent/context_and_memory/[P0]context_ingest_detail.md §3/§4
 *
 * 职责（context_ingest_detail.md §3 表 + §4 副作用契约）：
 *   截断过大的 tool_result block（在 tool 角色消息里）。
 *   - 触发条件：role="tool" 消息里 tool_result block 的 content 文本长度 > toolResultTruncateChars（默认 25000）
 *   - 副作用：offload 原文（SessionStore.saveContent("tool_result", contentId, ...)）→ 改写 content 为截断版
 *   - 截断版记 metadata.toolResultRef = contentId（指向 SessionStore 大内容）
 *   - 过长 tool_call 参数同理（context_ingest_detail §3 表注）
 *
 * 当前实现缺口（同 query_truncate）：SessionStore.saveContent v0.0.13 未实现，
 * offload 降级为「记 toolResultRef 但不真存原文」。截断行为本身已生效。
 *
 * EP: context_ingest_handler，priority 600。
 */
import type { ContentBlock, Message, ToolResultBlock } from '../../../../server/src/message/types';
import {
  ContextImplBase,
  type IngestCtx,
  type IngestHandler,
} from '../types';

/** 默认阈值（与 configSchema.default 一致；manifest §4.2） */
const DEFAULT_TOOL_RESULT_TRUNCATE_CHARS = 25000;

/** 截断后追加的尾部标记 */
const TRUNCATE_SUFFIX = '\n…[tool_result truncated by tool_result_truncate handler]';

/**
 * tool_result_truncate impl：截断过大 tool_result。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class ToolResultTruncateHandler
  extends ContextImplBase
  implements IngestHandler
{
  /** 截断阈值（char），cfg.toolResultTruncateChars 缺省 25000 */
  private readonly toolResultTruncateChars: number;

  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
    this.toolResultTruncateChars = this.getNumber(
      'toolResultTruncateChars',
      DEFAULT_TOOL_RESULT_TRUNCATE_CHARS,
    );
  }

  /**
   * 处理 messages：对 role=tool 消息里超阈值的 tool_result block 截断。
   * 截断 = 替换 block.content 为单 text 块（前阈值字符 + 尾标），
   * 记 metadata.toolResultRef（offload 当前 no-op）。
   */
  handle(messages: Message[], _ctx: IngestCtx): Message[] {
    const threshold = this.toolResultTruncateChars;
    let touched = false;
    const out = messages.map((m) => {
      if (m.role !== 'tool') return m;
      const newContent: ContentBlock[] = [];
      const meta: Record<string, unknown> = { ...(m.metadata ?? {}) };
      let msgTouched = false;
      for (const b of m.content) {
        if (b.type !== 'tool_result') {
          newContent.push(b);
          continue;
        }
        const len = sumSubContentChars(b.content);
        if (len <= threshold) {
          newContent.push(b);
          continue;
        }
        const fullText = concatSubContent(b.content);
        const truncated: ToolResultBlock = {
          type: 'tool_result',
          toolCallId: b.toolCallId,
          isError: b.isError,
          content: [
            { type: 'text', text: fullText.slice(0, threshold) + TRUNCATE_SUFFIX },
          ],
        };
        newContent.push(truncated);
        meta.toolResultRef = `tool_result:${b.toolCallId}`;
        msgTouched = true;
        touched = true;
      }
      if (!msgTouched) return m;
      return { ...m, content: newContent, metadata: meta };
    });
    return touched ? out : messages;
  }
}

/** 累加 tool_result.content 里所有子块的 text 字符数 */
function sumSubContentChars(subs: ContentBlock[]): number {
  return subs.reduce((n, b) => {
    if (b.type === 'text' || b.type === 'reasoning') return n + b.text.length;
    if (b.type === 'tool_result') return n + sumSubContentChars(b.content);
    return n;
  }, 0);
}

/** 拼接 tool_result.content 里所有子块的 text */
function concatSubContent(subs: ContentBlock[]): string {
  return subs
    .map((b) => {
      if (b.type === 'text' || b.type === 'reasoning') return b.text;
      if (b.type === 'tool_result') return concatSubContent(b.content);
      return '';
    })
    .filter(Boolean)
    .join('\n');
}
