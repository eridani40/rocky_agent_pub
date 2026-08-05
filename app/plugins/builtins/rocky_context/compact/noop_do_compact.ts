/**
 * builtin rocky_context plugin — context_do_compact: noop_do_compact
 * 参考: specs/tech/agent/context/[P0]extension point and implementations.md §3.7
 *       specs/tech/agent/context/[P0]context_compact_detail.md §2c.3
 *
 * 职责：compact 执行动作的「空操作」实现——什么都不做。
 *   forked scope 显式选中本 impl 作 defense-in-depth：理论上不可达（同 scope 的
 *   reject_should_compact 谓词已恒返 false → tryCompact 在谓词检查处 return，永不到达动作），
 *   显式选中是为了让 context_do_compact 这个 exclusive EP 在 forked scope 也「总有人被选中」，
 *   不留 zero-active 态（与 reject_should_compact 同一设计原则，详见该文件 JSDoc）。
 *
 * EP: context_do_compact（exclusive）。无 configSchema。
 */
import {
  ContextImplBase,
  type DoCompactAction,
  type CompactCtx,
} from '../types';

/**
 * noop_do_compact 动作：空操作（不压缩）。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化），无配置可读。
 */
export default class NoopDoCompactAction
  extends ContextImplBase
  implements DoCompactAction
{
  /**
   * no-op：forked scope 的 should_compact 恒 false，本 action 结构上不可达；
   * 显式选中是为了让 exclusive EP 不留 zero-active 态（与 should_compact 同一设计原则）。
   * 入参 ctx 不使用，下划线前缀标注。
   */
  async run(_ctx: CompactCtx): Promise<void> {
    // 空操作：故意什么都不做
  }
}
