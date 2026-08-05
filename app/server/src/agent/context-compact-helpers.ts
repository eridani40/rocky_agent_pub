/**
 * compact 辅助函数（v0.0.13 从 context-engine.ts 拆出，满足 ≤300 行约束）
 * 参考: specs/tech/agent/context/[P0]context_compact_detail.md §3.1
 *
 * 旁路 run（fork-1 summary / fork-2 整理）task message 均为纯 directive——对话历史由
 * 旁路 buffer 唯一承载（snapshot 单一信息源），prompt 不复述（agent_loop_forked §1 不变量）。
 *
 * context-engine.ts 通过 re-export 保留对外 API（extractTag）。
 */
import type { Message, ContentBlock } from '../message/types';

/**
 * 从文本中提取 <tag>...</tag> 标签内文本（容错：无标签则返回原文 trimmed）。
 * 用于 compact 解析 LLM 返回的 <summary>（context_compact_detail.md §3.1）。
 */
export function extractTag(text: string, tag: string): string {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const startIdx = text.indexOf(open);
  const endIdx = text.lastIndexOf(close);
  if (startIdx >= 0 && endIdx > startIdx) {
    return text.slice(startIdx + open.length, endIdx).trim();
  }
  // 容错：无标签取全文（compact_detail §3.1 — 模型可能漏标）
  return text.trim();
}

/** 把 resp.message.content（protocol ContentBlock 联合）里所有 text 块拼起来 */
export function extractAllText(content: unknown[]): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      const block = b as { type?: string; text?: string };
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      return '';
    })
    .join('\n');
}

/**
 * business Message → protocol Message（compact 调 client.call 需要的形态）。
 * 剥离 sessionId/runId/sender/metadata/信封字段；保留 role + content。
 * 返 unknown 因 business/protocol ContentBlock 联合未完全统一（见 context-engine compact 注释）。
 */
export function toProtocolMessage(m: Message): unknown {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
  };
}

/** 累加一个 content block 内的 text 字符数（char 估算用） */
export function blockCharCount(b: ContentBlock): number {
  switch (b.type) {
    case 'text':
    case 'reasoning':
      return b.text.length;
    case 'usage':
      return JSON.stringify(b.usage).length;
    case 'tool_call':
      return JSON.stringify(b.arguments).length;
    case 'tool_result':
      return b.content.reduce((n, sub) => n + blockCharCount(sub), 0);
    default:
      return 0;
  }
}
