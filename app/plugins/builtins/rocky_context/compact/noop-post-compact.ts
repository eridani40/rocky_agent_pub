/**
 * builtin rocky_context plugin — context_post_compact: noop_post_compact
 * 参考: specs/tech/agent/context/[P0]context_compact_detail.md §2d.4
 *       specs/tech/agent/context/[P0]extension point and implementations.md §3.7
 *
 * 职责：post-compact handler 的「空操作」实现——什么都不做。
 *   forked scope 显式 disable memory_skill_consolidation 后，本 impl 作为 ordered EP
 *   在 forked scope 下唯一激活的 handler，让 context_post_compact 在 forked scope
 *   「总有 handler 跑」（虽实际效果=跳过），与 reject_should_compact / noop_do_compact
 *   的 defense-in-depth 同模式（spec §2d.4 注：forked scope 必须跳过 post-compact handler，
 *   防整理 fork 再触发 compact → 再整理的递归；forked scope 的 reject_should_compact
 *   谓词已阻断 compact 链，本 impl 是防御性 noop）。
 *
 * EP: context_post_compact（ordered）。无 configSchema。
 */
import {
  ContextImplBase,
  type PostCompactHandler,
  type PostCompactCtx,
} from '../types';

/**
 * noop_post_compact handler：空操作（summary/consolidate scope 防递归 defense-in-depth）。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化），无配置可读。
 */
export default class NoopPostCompactHandler
  extends ContextImplBase
  implements PostCompactHandler
{
  /**
   * no-op：旁路 scope 不应启动整理 fork（reject_should_compact 已阻断 compact 链，
   * post-compact EP 触发条件不满足；本 impl 是 ordered EP 在旁路 scope 的占位，
   * 保证 consolidate scope 的 compact 不再递归触发整理）。
   * 入参 ctx 不使用，下划线前缀标注。
   */
  async handle(_ctx: PostCompactCtx): Promise<void> {
    // 空操作：故意什么都不做
  }
}
