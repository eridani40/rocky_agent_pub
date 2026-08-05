/**
 * builtin rocky_context plugin — context_should_compact: reject_should_compact
 * 参考: specs/tech/agent/context/[P0]extension point and implementations.md §3.7
 *       specs/tech/agent/context/[P0]context_compact_detail.md §2c.3
 *
 * 职责：compact 触发谓词的「拒绝」实现——恒返 false（永不触发 compact）。
 *   forked scope（summary/memory_extract 旁路 run）显式选中本 impl 表达「该 scope 永不 compact」，
 *   防止 summary run 自己再触发 compact（递归）。
 *
 * 设计动机（v0.0.40 修复）：context_should_compact 是 **exclusive** EP，UI（component-ext-impl-radio）
 *   是 radio 单选——只有「选中某项」交互，没有「取消勾选回到未选」交互。forked scope 若靠 disable 唯一实现
 *   （threshold_should_compact）制造 zero-active，是只能用 bootstrap 代码绕过 UI 语义强行造出的中间态，
 *   UI 上无法表达也无法恢复。改为新增本 dummy 实现并 setExclusive 显式选中——exclusive EP 在任何 scope
 *   下都「总有人被选中」，UI 正常显示 forked scope 当前选 reject。
 *
 * EP: context_should_compact（exclusive）。无 configSchema（无可调参数，恒 false）。
 */
import {
  ContextImplBase,
  type ShouldCompactPredicate,
  type CompactCtx,
} from '../types';

/**
 * reject_should_compact 谓词：恒返 false（永不触发 compact）。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化），无配置可读。
 */
export default class RejectShouldCompactPredicate
  extends ContextImplBase
  implements ShouldCompactPredicate
{
  /**
   * 恒返 false：forked scope 显式选中本 impl → tryCompact 谓词检查处 return，不触发 compact。
   * 入参 ctx 不使用（无论用量多少都不压），下划线前缀标注。
   */
  async check(_ctx: CompactCtx): Promise<boolean> {
    return false;
  }
}
