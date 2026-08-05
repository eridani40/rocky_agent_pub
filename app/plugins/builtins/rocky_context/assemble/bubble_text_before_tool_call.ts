/**
 * builtin rocky_context plugin — clean_view_reducer: bubble_text_before_tool_call
 * 参考: specs/tech/agent/context/[P0]context_assemble_detail.md §5b
 *       specs/tech/version_logs/v0.0.256/change_plan.md
 *
 * 职责：assistant message 的 content block 级重排——把 text block 冒泡到 tool_call 之前。
 * 背景：stall 掐断留半截 tool_call（arguments 为 {_raw}）落库，prefill 续写在其后
 *   追加 text+tool_call，assistant content 出现 text 夹在 tool_call 之间；anthropic-compatible
 *   provider 要求 tool_use 后块级紧跟 tool_result，text 夹中间即 400。orphan_tool_call 只做
 *   配对过滤 + message 级邻接，不碰 content 内 block 顺序；本 reducer 在其后做确定性重排兜底。
 *
 * 语义（change_plan 拍板 1-3）：
 *   - 只处理 role==='assistant'；user/tool/system 原样透传
 *   - 单遍分三桶 [reasoning…][text…][其余(含 tool_call)…] 拼接，桶内各保原相对顺序
 *     （reasoning 最前：Anthropic 要求 thinking 在 assistant content 最前，think_remove
 *     缺席的 scope 下本重排也正确）
 *   - 丢弃 trim 后空的 text block（Anthropic 对空 text 400；fill_empty_text 只兜 user/tool）
 *   - 不合并 text block；不删 message（全丢空交 empty_message 兜底）
 *   - 分区结果与原序一致且无丢弃 → 返原 message 引用（省分配）；不 mutate input
 *
 * EP: context_clean_view_reducer，order 4（orphan_tool_call 后、think_remove 前；
 *   由 ContextEngine.getCleanSnapshot 在深克隆副本上跑）。
 */
import type { ContentBlock, Message } from '../../../../server/src/message/types';
import { AssembleData, AssembleCtx, AssembleReducer, ContextImplBase } from '../types';

/**
 * bubble_text_before_tool_call reducer：assistant text 块冒泡到 tool_call 前。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class BubbleTextBeforeToolCallReducer
  extends ContextImplBase
  implements AssembleReducer
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  reduce(_data: AssembleData, input: Message[] | null, _ctx: AssembleCtx): Message[] {
    if (input === null) return []; // base_builder 未跑过 → 空（理论不会发生）
    let changed = false;
    const out = input.map((m) => {
      if (m.role !== 'assistant') return m; // 非 assistant 原样透传（引用不变）
      const bubbled = bubbleAssistantContent(m.content);
      if (bubbled === m.content) return m; // 该 message 无需变更 → 返原引用
      changed = true;
      return { ...m, content: bubbled }; // 变更时返新 message 对象（不 mutate input）
    });
    // 全链无变化 → 返原数组引用（对齐 orphan/dedup 零命中省分配约定）
    return changed ? out : input;
  }
}

/**
 * 单条 assistant content 的三段稳定分区重排：[reasoning…][text…][其余(含 tool_call)…]。
 * 单遍分桶 + 同步检测「原序是否已合法（无跨桶错位）」与「是否有空 text 被丢弃」：
 * 两者皆无 → 返原数组引用；否则返新拼接数组。桶内各保原相对顺序（稳定分区）。
 */
function bubbleAssistantContent(content: ContentBlock[]): ContentBlock[] {
  const reasoning: ContentBlock[] = [];
  const texts: ContentBlock[] = [];
  const rest: ContentBlock[] = [];
  let dropped = false;
  let misordered = false;
  let maxPhase = 0; // 0=reasoning 段 / 1=text 段 / 2=其余段；低 phase 块出现在高 phase 后 = 错位
  for (const b of content) {
    if (b.type === 'reasoning') {
      if (maxPhase > 0) misordered = true;
      reasoning.push(b);
    } else if (b.type === 'text') {
      if (b.text.trim() === '') {
        dropped = true; // 丢弃 trim 后空的 text block（交 empty_message 兜空 message）
        continue;
      }
      if (maxPhase > 1) misordered = true;
      else maxPhase = 1;
      texts.push(b);
    } else {
      maxPhase = 2;
      rest.push(b);
    }
  }
  if (!dropped && !misordered) return content; // 原序已合法且无丢弃 → 返原引用
  return [...reasoning, ...texts, ...rest];
}
