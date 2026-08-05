/**
 * builtin rocky_context plugin — ingest handler: query_truncate
 * 参考: specs/tech/agent/context_and_memory/[P0]extension point and implementations.md §3.1/§4.1
 *       specs/tech/agent/context_and_memory/[P0]context_ingest_detail.md §3/§4
 *
 * 职责（context_ingest_detail.md §3 表 + §4 副作用契约）：
 *   截断过长的 user query message。
 *   - 触发条件：role="user" 且 content 文本长度 > queryTruncateChars（默认 8000）
 *   - 副作用：offload 原文（SessionStore.saveContent("raw", contentId, ...)）→ 改写 content 为截断版
 *   - 截断版记 metadata.rawRef = contentId（指向 SessionStore 大内容）
 *
 * 当前实现缺口（D1.1/范围限制）：SessionStore.saveContent 在 v0.0.13 未实现，
 * offload 降级为「记录 rawRef 但不真存原文」（contentId 仍生成，原文暂丢，后续接 saveContent 后恢复）。
 * 截断行为本身已生效（满足 AT「改 query_truncate 阈值后真 LLM 对话验证 truncate 行为变化」）。
 *
 * EP: context_ingest_handler，priority 800（query 先于 tool_result，因同一 msg 不会同时是两者）。
 */
import type { ContentBlock, Message } from '../../../server/src/message/types';
import {
  ContextImplBase,
  type IngestCtx,
  type IngestHandler,
} from '../types';

/** 默认阈值（与 configSchema.default 一致；manifest §4.1） */
const DEFAULT_QUERY_TRUNCATE_CHARS = 8000;

/** 截断后追加的尾部标记（让 LLM 知道被裁了） */
const TRUNCATE_SUFFIX = '\n…[query truncated by query_truncate handler]';

/**
 * query_truncate impl：截断过长 user query。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class QueryTruncateHandler
  extends ContextImplBase
  implements IngestHandler
{
  /** 截断阈值（char），cfg.queryTruncateChars 缺省 8000 */
  private readonly queryTruncateChars: number;

  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
    this.queryTruncateChars = this.getNumber(
      'queryTruncateChars',
      DEFAULT_QUERY_TRUNCATE_CHARS,
    );
  }

  /**
   * 处理 messages：对 role=user 的 message，若 content 总字符数超阈值则截断。
   * 截断 = 拼接所有 text 块为单 text 块（保留前 queryTruncateChars 字符 + 尾标），
   * 记 metadata.rawRef 指向 offload contentId（offload 当前 no-op，仅生成 id 不落盘）。
   */
  handle(messages: Message[], _ctx: IngestCtx): Message[] {
    const threshold = this.queryTruncateChars;
    return messages.map((m) => {
      if (m.role !== 'user') return m;
      const textLen = sumTextChars(m.content);
      if (textLen <= threshold) return m;
      // 超阈值：截断为单 text 块 + 标记
      const fullText = concatText(m.content);
      const truncated = fullText.slice(0, threshold) + TRUNCATE_SUFFIX;
      // offload 当前 no-op：生成 contentId 但不调 saveContent（SessionStore 未实现）
      const contentId = `raw:${m.id}`;
      return {
        ...m,
        content: [{ type: 'text', text: truncated }],
        metadata: { ...(m.metadata ?? {}), rawRef: contentId },
      };
    });
  }
}

/** 累加 content 里所有 text 块的字符数（text/reasoning） */
function sumTextChars(blocks: ContentBlock[]): number {
  return blocks.reduce((n, b) => {
    if (b.type === 'text' || b.type === 'reasoning') return n + b.text.length;
    return n;
  }, 0);
}

/** 拼接 content 里所有 text 块为单 string（用于截断） */
function concatText(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === 'text' || b.type === 'reasoning') return b.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}
