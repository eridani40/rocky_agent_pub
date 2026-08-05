/**
 * order-utils — effective order 公共算法（plugin-manager + plugin-config-service 共用）
 * 参考: specs/tech/config/[P0]plugin_config_service.md §3.1（默认补位算法）
 *       specs/tech/plugin_system/[P0]plugin_manager_interface.md（ordered/exclusive 读 effective order）
 *       design §1.2 / §1.3 / §3.1
 *
 * v0.0.18 决策：删除 ExtImpl.priority 后，order 默认源从 manifest.priority 改为
 * 「末尾补位算法」。inventory 与运行时（plugin-manager ordered/exclusive）共用同一套
 * 求值逻辑，避免两套实现漂移（design §3.1）。
 *
 * 算法（design §1.2，per ext point 组内）：
 *   known   = allOfPoint 中有 order record 的 impl
 *   unknown = allOfPoint 中无 order record 的 impl
 *   1. known 按其 record 值（允许稀疏）
 *   2. unknown 接到末尾，按 registry 登记序补位 order = max(known) + 1, +2, ...
 *
 * effective order 返回 1..n 连续正整数（design §0 决策 2：从 1 开始）。
 */
import type { RegisteredExtImpl } from './manifest';
import type { ExtImplPolicyData } from './plugin-policy-store';

/**
 * 计算某 point 全组所有 impl 的 effective order 映射（implId → 1..n 连续值）。
 *
 * 实现细节：
 *   - 读 store 取每条 impl 的 order record（known）；allEntriesOfPoint 提供登记序（unknown 补位序）
 *   - known 取其 record 值；按 record 值升序排序后，重新分配 1..n（保证连续 + 稳定）
 *   - unknown 全部接尾，按 allEntriesOfPoint 登记序补位
 *   - 最终输出 1..n 连续，且 known 之间的相对顺序 = record 值顺序，unknown 之间 = 登记序
 *
 * 设计选择（连续化策略）：直接采用 record 值可能导致稀疏（如 2,5,8）或冲突。
 * 为保证 UI/运行时所见即所得且 1..n 连续，采用「按 record 值排序后重新分配 1..n」：
 *   - 同 record 值冲突时按登记序稳定（先登记者靠前）
 *   - unknown 一律排到所有 known 之后
 *
 * @param allEntriesOfPoint 某 point 的全部 registry 登记条目（登记序 = 数组顺序）
 * @param getImplPolicy 取 impl policy record 的回调（注入 store.getImpl，避免循环依赖）
 * @returns Map<implId, effectiveOrder>，effectiveOrder ∈ 1..n
 */
export function computeEffectiveOrders(
  allEntriesOfPoint: RegisteredExtImpl[],
  getImplPolicy: (implId: string) => ExtImplPolicyData | undefined,
): Map<string, number> {
  const result = new Map<string, number>();
  if (allEntriesOfPoint.length === 0) return result;

  // 1. 拆分 known / unknown（保留登记序）
  const known: { implId: string; recordOrder: number; regIdx: number }[] = [];
  const unknown: { implId: string; regIdx: number }[] = [];
  allEntriesOfPoint.forEach((entry, idx) => {
    const implId = entry.manifest.implId;
    const rec = getImplPolicy(implId)?.order;
    if (typeof rec === 'number' && Number.isFinite(rec)) {
      known.push({ implId, recordOrder: rec, regIdx: idx });
    } else {
      unknown.push({ implId, regIdx: idx });
    }
  });

  // 2. known 按 (recordOrder 升序, regIdx 升序) 稳定排序
  known.sort((a, b) => {
    if (a.recordOrder !== b.recordOrder) return a.recordOrder - b.recordOrder;
    return a.regIdx - b.regIdx;
  });

  // 3. 分配 1..n：known 先（按排序），unknown 接尾（按登记序）
  let next = 1;
  for (const k of known) {
    result.set(k.implId, next++);
  }
  for (const u of unknown) {
    result.set(u.implId, next++);
  }
  return result;
}
