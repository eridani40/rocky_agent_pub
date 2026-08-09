/**
 * build-render-rows —— 视图元素 → 渲染行序列（RenderRow）折叠 helper
 * 参考: specs/ui/components/chat-page/_overview.md §2 rule5/6（连续 tool-call-item 合并为一条 tool-batch row）
 *
 * 职责：把 flatten 产出的 ViewElement[] 折叠为 ComponentMessageStream 渲染用的 RenderRow 序列：
 *   连续 tool-call-item 合并为一条 tool-batch row（按 elementBatch 分组，可跨消息边界）；
 *   user-text / agent-answer 各成一行。tool-batch row 无 text（contentSignature 计算跳过）。
 *
 * 抽离动机：component-message-stream.tsx 装配滚动引导气泡后超 300 行上限（code-review Critical），
 *   将本纯折叠逻辑独立成模块，组件内一行调用（v0.0.262 code-review 拆分）。
 */
import type { ViewElement } from './types';

/** 渲染单元；user-text.name=[v0.0.107] IM 渠道来源徽标（非 client type，如 'feishu'；client/无 channel=undefined 不渲染） */
export type RenderRow =
  | { type: 'user-text'; key: string; messageId: string; text: string; name?: string }
  | { type: 'agent-answer'; key: string; messageId: string; textIndex: number; text: string }
  | { type: 'tool-batch'; key: string; messageId: string; calls: Extract<ViewElement, { kind: 'tool-call-item' }>[] };

/**
 * 把 elements 折叠为 RenderRow 序列：连续 tool-call-item 合并为一条 tool-batch row
 * （按 elementBatch 分组，可跨消息边界）；user-text / agent-answer 各成一行。
 * @param elements flatten 产出的视图元素序列
 * @param elementBatch 每个 element 所属 batch key（非 tool 元素为 null）
 * @param batches tool-batch 分组（每组 = 连续 tool-call-item 的 element-key 数组）
 */
export function buildRenderRows(
  elements: ViewElement[],
  elementBatch: Map<string, string | null>,
  batches: { key: string; elementKeys: string[] }[],
): RenderRow[] {
  // batch key → 该 batch 内的 tool-call-item 组
  const batchCallsByKey = new Map<string, Extract<ViewElement, { kind: 'tool-call-item' }>[]>();
  for (const b of batches) {
    const calls: Extract<ViewElement, { kind: 'tool-call-item' }>[] = [];
    for (const ek of b.elementKeys) {
      const e = elements.find((x) => x.key === ek);
      if (e && e.kind === 'tool-call-item') calls.push(e);
    }
    batchCallsByKey.set(b.key, calls);
  }

  const rows: RenderRow[] = [];
  let i = 0;
  while (i < elements.length) {
    const el = elements[i]!;
    if (el.kind === 'tool-call-item') {
      const batchKey = elementBatch.get(el.key);
      if (batchKey) {
        const calls = batchCallsByKey.get(batchKey) ?? [];
        rows.push({
          type: 'tool-batch',
          key: `row-${batchKey}`,
          messageId: calls[0]?.messageId ?? el.messageId,
          calls,
        });
        while (i < elements.length && elementBatch.get(elements[i]!.key) === batchKey) i++;
        continue;
      }
      i++;
      continue;
    }
    if (el.kind === 'user-text') {
      rows.push({
        type: 'user-text',
        key: el.key,
        messageId: el.messageId,
        text: el.text,
        name: el.name,
      });
    } else if (el.kind === 'agent-answer') {
      rows.push({ type: 'agent-answer', key: el.key, messageId: el.messageId, textIndex: el.textIndex, text: el.text });
    }
    i++;
  }
  return rows;
}

export default buildRenderRows;
