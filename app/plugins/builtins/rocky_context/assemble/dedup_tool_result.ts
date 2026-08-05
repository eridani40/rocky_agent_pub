/**
 * builtin rocky_context plugin — clean_view_reducer: dedup_tool_result
 * 参考: specs/tech/agent/context/[P0]context_assemble_detail.md §5b
 *       specs/tech/version_logs/v0.0.207/change_plan.md §T3
 *
 * 职责：同 toolCallId 多 tool_result 去重（兜底 reducer）。
 *   v0.0.207 bug 根因：abort 后 loop 与 abort api 各写一条 tool_result（同 toolCallId）→ 畸形消息
 *   发给 LLM。T2 已从源头根治（吊销 loop 副作用），本 reducer 作为兜底防御：
 *   历史脏数据 / 漏网场景下同 toolCallId 多 result → 挑 keeper，过滤其他。
 *
 * 选择策略：
 *   - 优先 `isError===false`（完整结果）> `isError===true`（interrupted 占位）
 *   - 全 isError=true → 保留首条（按 message 内顺序）
 *   - 单 result → 不动（零命中）
 *
 * 不可变：input 不变，返新数组；非 keeper 从对应 message.content 过滤。
 * 命中时写 error log（鸭子类型 ctx.config.logWriter，try/catch fail-silent，与 fill_empty_text 同模式）。
 *
 * EP: context_clean_view_reducer，order 0（**必须排在 orphan_tool_call 之前**——dedup 先去重，
 * orphan 才能正确判配对；否则 orphan 见双 result 都当 paired 全留，T3 兜底失效）。
 */
import type { Message } from '../../../../server/src/message/types';
import { AssembleData, AssembleCtx, AssembleReducer, ContextImplBase } from '../types';

/**
 * dedup_tool_result reducer：同 toolCallId 多 tool_result 去重。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class DedupToolResultReducer
  extends ContextImplBase
  implements AssembleReducer
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  reduce(_data: AssembleData, input: Message[] | null, ctx: AssembleCtx): Message[] {
    if (input === null) return [];

    // pass1：扫所有 role='tool' message 内 tool_result block，按 toolCallId 分组
    // 记录结构：toolCallId → [{msgIdx, blkIdx, isError}, ...]
    const groups = new Map<string, Array<{ msgIdx: number; blkIdx: number; isError: boolean }>>();
    for (let mi = 0; mi < input.length; mi++) {
      const m = input[mi];
      if (m.role !== 'tool') continue;
      for (let bi = 0; bi < m.content.length; bi++) {
        const b = m.content[bi];
        if (b.type !== 'tool_result') continue;
        const list = groups.get(b.toolCallId);
        const entry = { msgIdx: mi, blkIdx: bi, isError: b.isError };
        if (list) list.push(entry);
        else groups.set(b.toolCallId, [entry]);
      }
    }

    // 挑 keeper：每个 toolCallId 多 result 时选一条
    //   - 优先 isError=false（完整结果）
    //   - 全 isError=true → 首条（按 pass1 入序）
    const killSet = new Set<string>(); // key = `${msgIdx}:${blkIdx}`
    let hitCount = 0;
    for (const [toolCallId, entries] of groups) {
      if (entries.length <= 1) continue; // 单 result 不动
      const keeper = pickKeeper(entries);
      for (const e of entries) {
        if (e === keeper) continue;
        killSet.add(`${e.msgIdx}:${e.blkIdx}`);
        hitCount++;
      }
    }

    if (hitCount === 0) return input; // 零命中：原样返回

    // pass2：过滤——killSet 内的 block 从对应 message.content 剔除（不可变：返新数组）
    const out = input.map((m, mi) => {
      if (m.role !== 'tool') return m;
      let mutated = false;
      const newContent = m.content.filter((b, bi) => {
        if (b.type !== 'tool_result') return true;
        if (killSet.has(`${mi}:${bi}`)) {
          mutated = true;
          return false;
        }
        return true;
      });
      return mutated ? { ...m, content: newContent } : m;
    });

    writeErrorLog(ctx, {
      reducer: 'dedup_tool_result',
      sessionId: ctx.config?.sessionId,
      duplicates: hitCount,
      toolCallIds: [...groups.entries()].filter(([, e]) => e.length > 1).map(([id]) => id),
    });
    return out;
  }
}

/**
 * 从同 toolCallId 多 entries 中挑 keeper。
 *   - 优先 isError=false（完整结果）
 *   - 全 isError=true → 首条（按 pass1 入序，即 entries[0]）
 */
function pickKeeper(
  entries: Array<{ msgIdx: number; blkIdx: number; isError: boolean }>,
): { msgIdx: number; blkIdx: number; isError: boolean } {
  for (const e of entries) {
    if (!e.isError) return e;
  }
  return entries[0];
}

/**
 * 经 ctx.config.logWriter 写一条 error 级日志（鸭子类型能力探测 + fail-silent）。
 * 与 fill_empty_text.ts 同模式：try/catch 吞异常，绝不影响 assembly 主流程。
 */
function writeErrorLog(ctx: AssembleCtx, record: Record<string, unknown>): void {
  try {
    const config = ctx.config as { logWriter?: unknown };
    if (!config || !config.logWriter || typeof config.logWriter !== 'object') return;
    const w = config.logWriter as { write?: (type: string, rec: Record<string, unknown>) => void };
    if (typeof w.write !== 'function') return;
    w.write('error', record);
  } catch {
    // 日志失败绝不影响 assembly 主流程
  }
}
