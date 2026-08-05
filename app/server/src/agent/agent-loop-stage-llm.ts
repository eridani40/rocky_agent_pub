/**
 * EOS 双保险 helper（SquadChat 保留字 token 协议）
 * 参考: specs/tech/squad/[P1]agent_squad_chat.md §5.1（<EOS> 协议）
 *
 * 现行生产接线在 build-run-deps.ts：main + squad 的 run 装配时
 *   spec.stopSequences = [EOS_STOP_TOKEN]（保险一：LLM stop seq）
 *   spec.eosStripper = stripEosToken（保险二：ingest 前 strip 兜底）
 * 本模块只承载这两个纯函数/常量，不含 LLM 请求编排（主对话路径见
 * run-react-loop.ts + agent-loop-call-main.ts）。
 */
import type { ContentBlock, TextBlock } from '../message/types';

/**
 * SquadChat EOS 保留字 token（agent_squad_chat §5.1）。
 * SquadChat session（kind.role='squad'）路由完毕输出 `<EOS>` 结束当轮 run：
 *   1. 装配层注入 stop=['<EOS>']（token stream 自然停）
 *   2. LLM 返回后 ingest 前 strip 尾部 `<EOS>`（兜底 + provider 不支持 stop seq 时）
 */
export const EOS_STOP_TOKEN = '<EOS>';

/**
 * strip `<EOS>` 尾标记 from assistant content（EOS 双保险 · 保险二）。
 *
 * 入参 mutate（content block 数组是 LLM 调用刚产出的新对象，安全 mutate）。
 * 逻辑：遍历 text block，对末尾出现的 `<EOS>`（含可选环绕空白）做 strip。
 *   - stop seq 命中 → `<EOS>` 必在 stream 末尾（最后一个 text block 尾部）
 *   - provider 不支持 stop seq → 模型按 system prompt 在尾部输出 `<EOS>`，strip 兜底
 *   - `<EOS>` 是保留字 token，正常 answer 不会包含，故只 strip 尾标记安全
 * 非 text block（tool_call/reasoning/image...）原样保留；text block 内非尾部 `<EOS>` 不动
 * （理论上不会出现；若出现属模型异常，strip 尾部已满足「不展示」契约）。
 *
 * @param blocks  assistantMsg.content（mutate）
 */
export function stripEosToken(blocks: ContentBlock[]): void {
  for (const block of blocks) {
    if (block.type === 'text') {
      const tb = block as TextBlock;
      // strip 尾部 `<EOS>`（前导/尾随可选空白一并清掉，避免残留空行进 transcript）
      const stripped = tb.text.replace(/\s*<EOS>\s*$/, '');
      if (stripped !== tb.text) {
        tb.text = stripped;
      }
    }
  }
}
