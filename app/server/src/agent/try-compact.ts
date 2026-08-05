/**
 * tryCompact 胶水 — runReActLoop 骨架统一调用
 * 参考: specs/tech/agent/context/[P0]context_compact_detail.md §2c.1（tryCompact 固定胶水）
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_unified.md §3.1
 *
 * 设计：tryCompact 是**非插件**的固定胶水函数，骨架对 compact 零感知。
 *   1. pluginManager.getExtensionImpls(ContextShouldCompactPoint, scopeId) 取谓词
 *      - 空（scope 未激活）→ 直接 return
 *      - 非空 → exclusive ≤1 active，调 predicates[0].check(ctx)
 *   2. 谓词返 false → return（不压、不 clone、不派发）
 *   3. 谓词返 true：
 *      - structuredClone(ctx.snapshot) 一次（summary run 与主 loop 隔离）
 *      - 构造 CompactPluginContext（post handler 依赖包，注入 sharedCtx.pluginCtx）
 *      - void runSummarySibling(pm, sharedCtx).catch(log)
 *      - 立即 return（summary 异步跑，主 loop 不阻塞）
 *
 * post-compact（consolidate）不收在本胶水——已收进 runCompact 内部末尾统一触发
 *   （手动/自动两路径共享；本胶水只负责把 CompactPluginContext 经 CompactCtx.pluginCtx
 *   传到 runCompact）。
 *
 * **防递归**：旁路 run（summary/consolidate）的 scope 不激活 shouldCompact EP
 *   → getExtensionImpls 返空 → 谓词检查处 return，结构上不可能递归 compact。
 *
 * **fire-and-forget 不变量**：
 *   - 触发点 caller（run-react-loop.ts）不 await 本函数
 *   - summary sibling void ... .catch(log)，异常不传播、不影响主 loop
 *   - per-task 锁：summary acquire 'compact'（runCompact 内部）；
 *     consolidation acquire 'tier1_consolidation'（post-compact handler 内部，runCompact 末尾派发）
 */
import type { PluginManager } from '../plugin/plugin-manager';
import {
  ContextShouldCompactPoint,
  ContextDoCompactPoint,
} from '../plugin/extension-point';
import type {
  CompactCtx,
  CompactPluginContext,
  ShouldCompactPredicate,
  DoCompactAction,
} from './compact-types';

/**
 * 固定胶水：shouldCompact EP + 谓词 true 后派发 summary sibling（fire-and-forget）。
 *
 * @param pluginManager plugin 注册表（可空 → 跳过；UT fixture 场景）
 * @param ctx CompactCtx（含 snapshot/store/scopeId + 动作运行时依赖 + consolidateRunner）
 */
export async function tryCompact(
  pluginManager: PluginManager | null,
  ctx: CompactCtx,
): Promise<void> {
  if (!pluginManager) return; // UT fixture 无 plugin → 跳过（保持现状回归绿）
  // 1. 谓词（exclusive ≤1）：scope 未激活 → 返空，跳过（旁路 scope 据此关 compact）
  const predicates = pluginManager.getExtensionImpls<ShouldCompactPredicate>(
    ContextShouldCompactPoint,
    ctx.scopeId,
  );
  if (predicates.length === 0) return;
  const should = await predicates[0]!.check(ctx);
  if (!should) return; // 谓词返 false → 不压、不 clone、不派发

  // 2. 谓词 true → deep clone snapshot（summary run 与主 loop snapshot 隔离，互不污染）。
  //    structuredClone 在 Node 17+/Bun 原生支持。
  const clonedSnapshot = structuredClone(ctx.snapshot);
  // CompactPluginContext：runCompact 末尾触发 post-compact EP（consolidate）的依赖包。
  //   store 缺省（旁路 UT fixture）→ 不构造（旁路 scope 谓词恒 false，本就到不了这里）。
  const pluginCtx: CompactPluginContext | undefined = ctx.store
    ? {
        scopeId: ctx.scopeId,
        pluginManager,
        consolidateRunner: ctx.consolidateRunner ?? null,
        store: ctx.store,
        taskLock: ctx.taskLock,
      }
    : undefined;
  const sharedCtx: CompactCtx = { ...ctx, snapshot: clonedSnapshot, pluginCtx };

  // 3. 派发 summary sibling（fire-and-forget）：default scope summary_do_compact 选中
  //    → runCompact acquire 'compact' 锁；post-compact 由 runCompact 末尾统一派发。
  void runSummarySibling(pluginManager, sharedCtx).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[summary sibling] ${msg}`);
  });
}

/**
 * 私有 sibling：执行 summary（doCompact EP active impl）。
 *
 * actions = pluginManager.getExtensionImpls(ContextDoCompactPoint, scopeId)；空返 return（容错）。
 * run 内部 runCompact 已 acquire 'compact' 锁 + markFailed/markDone（context-compact-runner.ts）
 * + 末尾触发 post-compact EP。异常仅 log（不 rethrow、不影响主 loop）。
 */
async function runSummarySibling(pm: PluginManager, ctx: CompactCtx): Promise<void> {
  const actions = pm.getExtensionImpls<DoCompactAction>(
    ContextDoCompactPoint,
    ctx.scopeId,
  );
  if (actions.length === 0) return; // 空 → 容错静默跳过
  await actions[0]!.run(ctx);
}
