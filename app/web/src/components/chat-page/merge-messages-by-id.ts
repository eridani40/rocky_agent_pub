/**
 * mergeMessagesById —— by-id merge 工具
 * 参考: specs/tech/version_logs/v0.0.81.compaction_bug/change_plan.md §3（变更 E）
 *
 * 职责：transcript fetch / loadMore prepend 路径的消息合并——按 id 去重保序，
 *   同 id 时优先保留现有消息（SSE 累积态比 transcript fetch 初始态更全，含 tool_call 增量等）。
 *   SSE reducer（chat-slice-reducer.ts）已按 id dedup，本 helper 只管 transcript/loadMore 路径。
 */
import type { Message } from './types';

/**
 * 按 id 合并消息：
 *   - 同 id 时取 prev（保留 SSE 累积态：tool_call rawArgs / pendingError 等）
 *   - incoming 段先按序展开（去重），prev 中独有 id 按原序补回
 *   - prepend=true（loadMore 续载）：incoming 段在前；prepend=false（transcript fetch 整体替换）：
 *     只保留 incoming 中存在的 id（prev 中不在 incoming 的 id 丢弃——transcript 是权威最新 list）。
 *
 * @param prevMsgs 现有 messages（SSE 累积态）
 * @param incoming 新拉取的 messages（transcript fetch / loadMore）
 * @param prepend true=loadMore 前插；false=整体替换
 */
export function mergeMessagesById(
  prevMsgs: Message[],
  incoming: Message[],
  prepend: boolean,
): Message[] {
  if (incoming.length === 0) return prevMsgs;
  const prevById = new Map(prevMsgs.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const out: Message[] = [];
  // incoming 段（同 id 取 prev 累积态；incoming 自身去重）
  for (const m of incoming) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(prevById.get(m.id) ?? m);
  }
  if (prepend) {
    // loadMore 续载：prev 中独有 id 按原序补回（保 SSE 增量的近期消息不被丢）
    for (const m of prevMsgs) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        out.push(m);
      }
    }
  }
  // prepend=false：整体替换语义，不补 prev 独有 id（transcript 是权威最新 list）
  return out;
}
