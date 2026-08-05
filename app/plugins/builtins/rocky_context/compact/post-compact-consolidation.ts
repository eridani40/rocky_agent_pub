/**
 * builtin rocky_context plugin — context_post_compact: memory_skill_consolidation
 * 参考: specs/tech/agent/context/[P0]context_compact_detail.md §2d.3
 *       specs/tech/agent/memory/[P0]consolidation_tier1.md §3 §4 §5
 *
 * 职责：compact 成功完成后启动 fork-2 整理旁路 run——
 *   1. 读 consolidation.md 模板（ConsolidationHandler）构造 fork-2 task message
 *      （纯 directive——对话历史由 snapshot 经旁路 buffer 唯一承载，prompt 不复述）
 *   2. fire-and-forget 调 ctx.consolidateRunner（runKind='consolidate' + allowed tools
 *      =[skill_manage, memory_manage]）启动 fork-2
 *   3. fork-2 在推理过程中直接调 skill_manage / memory_manage 工具落盘（不审批，
 *      受 evolvable 治理 + 容量上限约束）
 *
 * **触发点**：runCompact 末尾统一派发（手动/自动 compact 两路径共享；由
 *   context-compact-post-phase.ts dispatchPostCompact 按 scope 读配置调 handle）。
 *
 * **双 snapshot**：ctx.prevSnapshot = 压缩前完整对话（本 handler 用它做整理——原始信息
 *   最全）；ctx.postSnapshot = 压缩后视图（本 handler 不用，预留给需要的 handler）。
 *
 * **fire-and-forget**：fork-2 不 await（void promise.catch 吞异常），handler 同步返回，
 *   不阻塞 compact / agent loop。fork-2 失败不影响 compact 已完成的 summary（spec
 *   consolidation_tier1 §5 失败隔离 + context_compact_detail §2d.5）。
 *
 * **复用 session model**：fork-2 不引入便宜 aux model（consolidation_tier1 §6 resolve）。
 *
 * EP: context_post_compact（ordered）。无 configSchema。
 */
import {
  ContextImplBase,
  type PostCompactHandler,
  type PostCompactCtx,
} from '../types';
import { ulid } from '../../../../server/src/config/ulid';
import { ConsolidationHandler } from '../../../../server/src/prompts/handlers/consolidation-handler';
import { resolveAgentProfileInput } from '../prompt/agent_profile';
import {
  renderScopeTableForPrompt,
  resolveBizScopeKind,
} from '../../../../server/src/agent/biz-scope-rules';

/**
 * fork-2 runKind（RunKind 扁平闭合枚举 'consolidate'，区别 fork-1 的 'summary'）。
 * side-run-reminder-injector 据此选择 reminder 文案。
 */
const CONSOLIDATION_RUN_KIND = 'consolidate';

/**
 * memory_skill_consolidation handler：compact 完成后启动 fork-2 整理 agent。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class MemorySkillConsolidationHandler
  extends ContextImplBase
  implements PostCompactHandler
{
  async handle(ctx: PostCompactCtx): Promise<void> {
    const runner = ctx.consolidateRunner;
    // 缺依赖（UT fixture / 未装配）→ 跳过整理（不抛错，spec §2d.3 impl 容错）
    if (!runner) return;
    if (!ctx.toolDefinitions || ctx.toolDefinitions.length === 0) return;
    // [v0.0.80.t1] acquire 'tier1_consolidation' 锁（spec session_task_lock §6 实接）：
    //   - taskLock 缺省（UT fixture）→ 跳过锁守卫，直接启动 fork-2（兼容旧 fixture）
    //   - 锁占用 → 静默 return（fire-and-forget 不阻塞，per-task 锁 CAS 语义 change_plan §1.2 #3）
    //   - fork-2 完成 → markDone / 失败 → markFailed（与 'compact' 锁对称）
    //   - emit 由 SessionTaskLock 内部 emitTaskUpdate 承担（v0.0.78.bug 已实装），handler 不重复 emit
    const sid = ctx.config.sessionId;
    const taskLock = ctx.taskLock;
    if (taskLock) {
      const runId = `consolidation:${Date.now()}`;
      if (!taskLock.acquire(sid, 'tier1_consolidation', runId)) return; // 锁占用 → 静默跳过
    }
    // fire-and-forget：异步启动 fork-2，不 await（handler 同步返回不阻塞 compact 主链）
    // 同步异常（如 prompt 模板读失败）也吞掉，避免影响 compact 已完成的 summary
    try {
      void this.startConsolidation(ctx).then(
        () => {
          // fork-2 成功完成 → release 锁（与 'compact' 锁对称）
          if (taskLock) taskLock.markDone(sid, 'tier1_consolidation');
        },
        (err) => {
          // fork-2 失败 → markFailed（spec 失败隔离：整理失败不阻断 compact，但锁必须释放）
          const msg = err instanceof Error ? err.message : String(err);
          if (taskLock) taskLock.markFailed(sid, 'tier1_consolidation', msg);
        },
      );
    } catch {
      // 同步异常防御（startConsolidation 内部不应抛，但 try 双保险）
      // 同步异常 release 锁避免遗留 running 态（极端场景，幂等 markFailed）
      if (taskLock) taskLock.markFailed(sid, 'tier1_consolidation', 'sync throw');
    }
  }

  /**
   * 启动 fork-2 整理 agent（异步执行，caller 不 await）。
   * 抛出的异常由 caller（handle）的 .catch 兜底吞掉。
   */
  private async startConsolidation(ctx: PostCompactCtx): Promise<void> {
    const runner = ctx.consolidateRunner!;
    const sid = ctx.config.sessionId;

    // 1. 构造 fork-2 task message（读 consolidation.md；纯 directive——旁路不变量：
    //    snapshot 经 side_run_builder 进 buffer 是唯一信息源，prompt 只下指令不复述对话历史，
    //    与 fork-1 summary 同契约）
    //    注入 agents_paths / scope_table 两段静态配置（O1）。
    const agentsPaths = renderAgentsPaths(ctx);
    const scopeTable = renderScopeTableForPrompt(resolveBizScopeKind(ctx.config));
    const taskText = new ConsolidationHandler().build({
      vars: { agents_paths: agentsPaths, scope_table: scopeTable },
    }).content;
    const userMessage = {
      id: ulid(),
      sessionId: sid,
      role: 'user' as const,
      content: [{ type: 'text' as const, text: taskText }],
    };

    // 2. 调 ctx.consolidateRunner 启动 fork-2（bootstrap 已 wrap agentManager.sideRun）
    //    fork-2 内部调 skill_manage / memory_manage 工具直接落盘（不审批）
    //    snapshot 用 ctx.prevSnapshot（压缩前完整对话——整理的原始信息最全；
    //    postSnapshot 是压缩后视图，本 handler 不用）。
    // 透传 triggerMessageId/triggerUsage → 旁路 run trace meta。
    const result = await runner({
      sessionId: sid,
      runKind: CONSOLIDATION_RUN_KIND,
      snapshot: ctx.prevSnapshot,
      userMessage,
      triggerMessageId: ctx.triggerMessageId,
      triggerUsage: ctx.triggerUsage,
    });

    // 3. fork-2 usage 总量一次性累计（与 fork-1 runCompact 同契约：旁路 run usage 由 caller
    //    按 run 结束总量累计，不经 lifecycle 逐调用——防「逐调用 + 总量」双计）。
    //    store 缺省（UT fixture）→ 跳过；生产 main compact 链必注入（loop-stage-context
    //    构造 CompactCtx store=spec.wireStore）。
    //    accumulateUsage 拿到 sid 链后对链上每个 sid 调 notifyUsageChanged，让 forked
    //    分区增量即时可见（不依赖下一轮 main assemble）。先 await write 完再 notify。
    //    tier2 三 run 不补（公共全局整理，不摊到单个 session usage——用户裁决）。
    if (ctx.store) {
      const chain = await ctx.store.accumulateUsage(sid, 'forked', result.usage);
      for (const s of chain) await ctx.store.notifyUsageChanged(s);
    }
  }
}

/**
 * 渲染 fork-2 task message 的「整理对象 — AGENTS.md」段（O1 + O7）。
 * 复用 agent_profile.resolveAgentProfileInput 单源（kind 分支已落定，禁平行实现）：
 *   - academy → 固定行「本场景不整理 AGENTS.md，仅 memory/skill」（O7：academy 课程文件 OUT）
 *   - playground/studio → 渲染团队/个人 AGENTS.md 路径 + 配置状态（已配置｜未配置·可选）
 *   - 未覆盖 kind / resolveAgentProfileInput 返 null → fallback 引导行
 * 纯文本段；缺 ctx.config（UT fixture）→ 返 fallback 引导行，不抛错。
 */
function renderAgentsPaths(ctx: PostCompactCtx): string {
  const biz = resolveBizScopeKind(ctx.config);
  if (biz === 'academy') {
    return '本场景（academy）不整理 AGENTS.md，仅整理 memory / skill。';
  }
  try {
    const input = resolveAgentProfileInput({ config: ctx.config } as never);
    if (!input || input.agentsLines.length === 0) {
      return '（本场景无 AGENTS.md 整理对象——仅整理 memory / skill。）';
    }
    const lines = input.agentsLines.map((l) => {
      const status = l.configured ? '已配置' : l.optional ? '未配置·可选' : '未配置';
      return `- ${l.label} AGENTS.md：${l.filePath}（${status}）—— ${l.note}`;
    });
    return lines.join('\n');
  } catch {
    return '（本场景无 AGENTS.md 整理对象——仅整理 memory / skill。）';
  }
}
