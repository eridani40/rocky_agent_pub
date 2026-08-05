/**
 * base_builder 共享 helper
 * 参考: specs/tech/agent/context/[P0]context_assemble_detail.md §6
 *
 * pickRecentWithinBudget 算法单源在 server `agent/summary-block.ts`
 *   （summary block 算法群单源——compact 烘焙 / 组装 fallback / postSnapshot 合成共用；
 *   server 不能反向 import plugin，故算法落 server，本文件仅 re-export 保 import 路径稳定）。
 */
export { pickRecentWithinBudget } from '../../../../server/src/agent/summary-block';
