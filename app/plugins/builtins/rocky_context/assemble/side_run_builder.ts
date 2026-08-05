/**
 * builtin rocky_context plugin — assemble_reducer: side_run_builder
 * 参考: specs/tech/agent/context_and_memory/[P0]context_assemble_detail.md §2
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_forked.md §4 §7
 *
 * 职责（旁路 scope 专属 assemble reducer，summary/consolidate runKind 共用）：
 *   - 复用**固定 parent snapshot**（ctx.prevSnapshot.messages，含 summaryMsg + recent）
 *   - 从 data.transcript 中取 summaryUpTo 之后的「增量」消息（id > summaryUpTo）
 *   - upsert 合并：同 id 替换（update），新 id 按 ULID 升序插入（insert）
 *
 * 算法：
 *   1. parentMsgs = ctx.prevSnapshot?.messages ?? []（含 summaryMsg + recent，保持原顺序）
 *   2. summaryUpTo = ctx.prevSnapshot?.summary?.summaryUpTo（parent summary 已总结到的 id）
 *   3. newMsgs = transcript 里 id > summaryUpTo 的消息（summaryUpTo 之前的已被 parent summary recap
 *      覆盖，忽略；summaryUpTo null/undefined → 全部 transcript）
 *   4. upsert：同 id update（替换内容）/ 新 id 按 ULID 升序 insert
 *
 * 多轮正确性关键：
 *   ctx.prevSnapshot 必须是**固定 parent**（LoopState.parentSnapshot，整 run 不变），不能是
 *   每轮漂移的 state.snapshot。prepareStage 每轮 state.snapshot = assemble(...) 会覆盖成 side run
 *   自己的输出。caller（build-run-deps wireInitState）负责传固定 parentSnapshot 作 prevSnapshot。
 *
 * 不变量：
 *   - MUST NOT mutate ctx.prevSnapshot.messages（用 .slice() 拷贝）
 *   - MUST NOT 全局 sort by id（summaryMsg 的非 ULID id 会被排乱）—— parent 原顺序 + newMsgs 按 id 插入
 *   - 无 parent snapshot（防御，旁路 run 不应发生）→ 退化 [...data.transcript]
 *   - parent.messages[0] 可能是 summaryMsg（id=`summary:${version}`，非 ULID）—— transcript 无同 id，
 *     summaryMsg 保持原位不动；newMsgs 是新 ULID，按升序插入到 recent 之后
 *
 * EP: context_assemble_reducer（与 base_builder 同 EP；旁路 scope 激活 side_run_builder，
 *   default scope 激活 base_builder——差异靠 scope EP impl 切换，主干零 if kind 分支）。
 */
import type { Message } from '../../../../server/src/message/types';
import {
  AssembleData,
  AssembleCtx,
  AssembleReducer,
  ContextImplBase,
} from '../types';

/**
 * side_run_builder reducer：复用固定 parent snapshot + summaryUpTo 后增量 upsert。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class SideRunBuilderReducer
  extends ContextImplBase
  implements AssembleReducer
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  reduce(data: AssembleData, input: Message[] | null, ctx: AssembleCtx): Message[] {
    // 链中后续 reducer 不会调本 reducer（forked EP 链只挂 side_run_builder 一个）；仍兼容 input != null
    if (input !== null) return input;

    const prev = ctx.prevSnapshot;
    // 防御：无 parent snapshot（forked 不应发生，wireInitState 总会设 parentSnapshot）→ 退化全 transcript
    if (!prev?.messages?.length) return [...data.transcript];

    // 拷贝 parent.messages（绝不 mutate ctx.prevSnapshot.messages）
    const parent: Message[] = prev.messages.slice();
    // parent summary 已总结到的 message id（forked curVersion 恒 null → 沿用 parent summary 上界）
    const summaryUpTo = prev.summary?.summaryUpTo;

    // newMsgs = transcript 里 summaryUpTo 之后的消息（id 字典序 > summaryUpTo）
    // summaryUpTo 为 null/undefined → 全部 transcript
    const newMsgs: Message[] = summaryUpTo
      ? data.transcript.filter((m) => m.id > summaryUpTo!)
      : data.transcript;

    if (newMsgs.length === 0) return parent;

    // id → index 加速查表（parent 现有 id）
    const idIdx = new Map<string, number>(parent.map((m, i) => [m.id, i]));

    for (const m of newMsgs) {
      const ex = idIdx.get(m.id);
      if (ex !== undefined) {
        // 同 id 已存在 → update（替换该条内容；HITL tool_reply 占位编辑后同 id 落 transcript 的场景）
        parent[ex] = m;
        continue;
      }
      // 新 id → 按 ULID 升序 insert：从末尾往前找第一个更小 id 的位置，插其后
      // summaryMsg.id = `summary:N` 非 ULID，跳过非 ULID 元素只与 ULID 比较，
      // 否则 splice 会把 summaryMsg 挤到非首位的语义冲突。
      let pos = parent.length;
      for (let i = parent.length - 1; i >= 0; i--) {
        const pid = parent[i]!.id;
        if (!isUlid(pid)) continue;
        if (pid < m.id) {
          pos = i + 1;
          break;
        }
        pos = i;
      }
      parent.splice(pos, 0, m);
      // 重建 idIdx（splice 后 index 偏移）
      idIdx.clear();
      for (let i = 0; i < parent.length; i++) idIdx.set(parent[i]!.id, i);
    }

    return parent;
  }
}

/**
 * ULID 格式判定：26 字符 + [0-9A-HJKMNP-TV-Z] 字符集（Crockford Base32）。
 * summaryMsg.id 形如 `summary:N` 不符合 → 返 false，upsert insert 跳过比较保其原位。
 */
function isUlid(id: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id);
}
