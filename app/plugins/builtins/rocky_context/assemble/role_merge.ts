/**
 * builtin rocky_context plugin — clean_view_reducer: role_merge
 * 参考: specs/tech/agent/context/[P0]context_assemble_detail.md §5b
 *       specs/tech/agent/context/[P0]extension point and implementations.md §3.10
 *
 * 职责（§5b 表）：相邻同 role 合并（user/user、assistant/assistant、tool/tool）。
 *   - 后者 content blocks 并入前者（前者 id 保留）
 *   - system 不合（恒首条，summary msg 也 role=system 但不与相邻 system 合并）
 *
 * EP: context_clean_view_reducer，order 6（链尾；由 ContextEngine.getCleanSnapshot 在深克隆副本上跑，原 snapshot 不被 mutate → 不再吞 id → 不再乱序）。
 */
import type { Message } from '../../../../server/src/message/types';
import { AssembleData, AssembleCtx, AssembleReducer, ContextImplBase } from '../types';

/**
 * role_merge reducer：相邻同 role 合并。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class RoleMergeReducer
  extends ContextImplBase
  implements AssembleReducer
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  reduce(_data: AssembleData, input: Message[] | null, _ctx: AssembleCtx): Message[] {
    if (input === null) return [];
    const out: Message[] = [];
    for (const m of input) {
      // system 角色不合（恒独立保留）
      if (m.role === 'system') {
        out.push(m);
        continue;
      }
      const last = out[out.length - 1];
      if (last && last.role === m.role) {
        // 合并：后者 content 并入前者
        last.content = [...last.content, ...m.content];
      } else {
        out.push({ ...m, content: [...m.content] });
      }
    }
    return out;
  }
}
