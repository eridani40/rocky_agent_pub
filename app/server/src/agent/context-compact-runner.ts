/**
 * ContextEngine.compact 执行路径（v0.0.16 从 context-engine.ts 拆出，满足 ≤300 行约束）
 * 参考: specs/tech/agent/context/[P0]context_compact_detail.md §2 §3
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_side_run.md（旁路 run 不变量）
 *       specs/tech/agent/session/[P0]session_task_lock.md（统一锁）
 *
 * 职责：compact 单步执行——SessionTaskLock.acquire('compact') CAS → sideRun(summary run)
 *   → extractTag → bakeSummaryBlock 烘焙 → setSummary（含 block）→ accumulateUsage("forked")
 *   → lock.markDone / markFailed → **后置阶段**（context-compact-post-phase.ts）：
 *   postSnapshot 合成（假装 assemble 压缩后视图）→ updateContextWindowUsage 立即写回
 *   → post-compact EP 派发（consolidate，fire-and-forget）。
 * ContextEngine.compact 仅薄壳调用本函数（保留 public API 不破坏既有调用）。
 * 手动/自动两路径统一走本函数 → 两路径都触发 post-compact EP（手动不再漏 consolidate）。
 *
 * compact 是**纯生产者**：只 setSummary + accumulateUsage('forked') write + usage 写回，
 *   不产任何 transcript 消息；后置阶段失败只 log 不翻转 compact 结果。
 *
 * 旁路不变量（agent_loop_side_run）：
 *   - snapshot 是**唯一信息源**（system + messages + reminder 已在旁路 buffer 中）
 *   - compact task message 是**纯 directive**（"概括上面对话历史"），不复述对话历史
 *   - 故 runCompact 不调 serializeMessages()，也不取 oldSummary 注入 prompt
 *   - LLM 实际收到：[system, ...snapshot.messages, reminder, directive(纯指令)]——对话历史只出现一次
 */
import type { Message } from '../message/types';
import type { SessionStore } from './session-store';
import type { SessionTaskLock } from './session-task-lock';
import type { ContextSnapshot, SessionConfig } from './context-types';
import type { Usage, ContextWindowUsage } from '../message/types';
// SessionConfig 保留：runCompact 形参 config 仍用于 sessionId + taskLock（v0.0.158 change_plan §F）
// [v0.0.54] serializeMessages 已删（compact 不复述 snapshot，函数无消费方 → 删死代码）
import { extractTag } from './context-compact-helpers';
// [v0.0.186] compact 烘焙 summary block（preamble+head+tail 完整文本，持久化到 summary 记录
//   block 字段；组装期 msg[0] 直接读，零计算 → prompt 缓存前缀逐字节稳定）。
import { bakeSummaryBlock, type SummaryBakeInput } from './summary-block';
// compact 后置阶段（postSnapshot 合成 + usage 立即更新 + post-compact EP 派发）
import { buildPostCompactSnapshot, dispatchPostCompact } from './context-compact-post-phase';
import type { CompactPluginContext } from './compact-types';
// v0.0.22：压缩指令模板正文（NO_TOOLS preamble + 9 板块 + 输出约束 + NO_TOOLS trailer）
// 经 CompactHandler 读 prompts/content/compact.md（spec prompt_content_files §4 / context_compact_detail §3.0）
// [v0.0.54] CompactHandler.build() 改纯 directive 调用（不再传 serialized_transcript/old_summary vars）
import { CompactHandler } from '../prompts/handlers/compact-handler';

/**
 * v0.0.15 T5 compact 走 AgentManager.sideRun 的回调签名（与 context-engine.ts 同步）。
 *
 * v0.0.158 change_plan §F：删除 `config` 字段——bootstrap setSideRunner 闭包内部
 *   `await agentManager.resolveConfigBySid(input.sessionId)` 自 resolve（唯一入口收敛）。
 *   caller（summary_do_compact / handleSessionCompact）不再传 config。
 */
export type CompactSideRunner = (input: {
  sessionId: string;
  snapshot: ContextSnapshot;
  userMessage: Message;
  /**
   * [v0.0.80.t1] 触发点 msg id（caller=summary_do_compact 从 CompactCtx 透传）。
   * 用于 forked trace metadata.inputMessageIds 反查触发点。缺省兜底 []。
   */
  triggerMessageId?: string;
  /**
   * [v0.0.80.t1] 触发时 context window 用量（同 triggerMessageId 透传）。
   * 用于 forked trace metadata.triggerUsage。缺省跳过该字段。
   */
  triggerUsage?: ContextWindowUsage;
}) => Promise<{ answer: string; usage: Usage }>;

/**
 * compact 执行路径（spec context_compact_detail §2 + session_task_lock §3.1 CAS）。
 *
 * @param store session 存储
 * @param taskLock SessionTaskLock 统一锁（可空，UT fixture 极端场景 → 不做 CAS 守卫）
 * @param config session context
 * @param snapshot compact 用的快照（caller 复用 main 的 state.snapshot 深拷贝；手动入口由
 *   ContextEngine.compact 先 assemble 产）。compact 不再重新 assemble——main snapshot 已是
 *   prepareStage assemble 过的产物（append 分支 messages 已稳定），直接复用即可。
 * @param sideRunner manager.sideRun 回调（v0.0.15 T5；可空 → 抛错降级）
 * @param triggerMessageId [v0.0.80.t1] 触发点 msg id（透传给 sideRunner → forked trace meta）
 * @param triggerUsage [v0.0.80.t1] 触发时 context window 用量（透传给 sideRunner → forked trace meta）
 * @param bakeConfig [v0.0.186] 烘焙参数（tokenCap/candidateLimit，do_compact impl cfg 透传）；
 *   缺省 → 用默认（手动 compact 入口 contextEngine.compact 不传也烘焙）
 * @param pluginCtx compact 后置阶段插件上下文（scopeId/pluginManager/consolidateRunner/store/taskLock）。
 *   手动/自动两路径统一传入 → 两路径都在 compact 末尾触发 post-compact EP（consolidate）。
 *   缺省（UT fixture）→ 跳过 EP 派发（postSnapshot 合成 + usage 更新仍执行）。
 * @returns true=完成；false=CAS 失败（已有 compact 在跑，跳过不重复执行）
 */
export async function runCompact(
  store: SessionStore,
  taskLock: SessionTaskLock | undefined,
  config: SessionConfig,
  snapshot: ContextSnapshot,
  sideRunner: CompactSideRunner | null,
  triggerMessageId?: string,
  triggerUsage?: ContextWindowUsage,
  bakeConfig?: Pick<SummaryBakeInput, 'tokenCap' | 'candidateLimit'>,
  pluginCtx?: CompactPluginContext,
): Promise<boolean> {
  const sid = config.sessionId;
  const runId = `compact:${Date.now()}`;

  // v0.0.55：SessionTaskLock.acquire('compact') CAS（subsumes 旧 markSummaryRunning）。
  //   CAS WHERE state ∈ {idle,done,failed} → running；返 false = 已被占（并发第二个 compact 跳过）。
  //   taskLock 缺省（极端 UT fixture）→ 不做 CAS 守卫，兼容旧 fixture。
  const cas = taskLock ? taskLock.acquire(sid, 'compact', runId) : true;
  if (!cas) return false;

  try {
    // [v0.0.54] compact task message = 纯 directive（forked 不变量）。
    // NO_TOOLS preamble + 9 板块 + 输出约束 + NO_TOOLS trailer 经 CompactHandler 读 compact.md。
    // **不复述 serialized_transcript、不注入 old_summary**——对话历史已在 forked buffer 中
    // （snapshot.messages 在 sideRunner 内被注入 CanonicalRequest.messages），prompt 只下指令。
    // spec: agent_loop_forked §1 + context_compact_detail §3.0
    const compactText = new CompactHandler().build().content;
    const taskMessage: Message = {
      id: `compact-task:${runId}`,
      sessionId: sid,
      role: 'user',
      content: [{ type: 'text', text: compactText }],
    };

    // v0.0.15 T5：改走 AgentManager.sideRun（runKind="summary" / NO_TOOLS / maxIter=1）。
    if (!sideRunner) {
      throw new Error('ContextEngine.compact: sideRunner not configured (bootstrap should call setSideRunner)');
    }
    // v0.0.158：sideRunner input 删 config 字段（bootstrap 闭包内部自 resolve）；
    //   本函数 config 形参保留仅用于 sessionId + taskLock CAS。
    const forkedResult = await sideRunner({
      sessionId: sid,
      snapshot,
      userMessage: taskMessage,
      // [v0.0.80.t1] 透传 trigger meta 给 sideRun → forked trace metadata（change_plan §2.6 改进#1）
      triggerMessageId,
      triggerUsage,
    });

    // 提取 <summary>...</summary>（容错：无标签取全文）
    const summaryText = extractTag(forkedResult.answer, 'summary');

    // 推进 summaryUpTo 到 snapshot 末尾 messageId（不含 taskMessage）；version 由 store 自增
    const lastMsg = snapshot.messages[snapshot.messages.length - 1];
    const summaryUpTo = lastMsg ? lastMsg.id : null;

    // [v0.0.186] 烘焙 summary block：用当时的 ratio + 锚定候选 + tokenCap 一次构建完整文本，
    //   持久化到 summary 记录 block 字段。组装期 msg[0] 直接读它（不再逐轮 pickHead/pickTail/
    //   budget 判定）——ratio 漂移 / transcript 增长都不再影响 msg[0]，prompt 缓存前缀稳定。
    const block = await bakeSummaryBlock(store, config, {
      content: summaryText,
      summaryUpTo,
      ...bakeConfig,
    });

    await store.setSummary(sid, {
      content: summaryText,
      summaryUpTo,
      block,
    });

    // [v0.0.81.compaction_bug] compact_notice 留痕已删——compact 是纯生产者，不再 appendMessages。
    //   summary / version / summaryUpTo 已在 SummaryInfo + accumulateUsage 信号里，UI 不需要额外 message。

    // usage 累计（D2.5；v0.0.14 accumulate 已激活，真落 forked 分区）
    // [v0.0.80.t1 §1.0 纯生产者原则] accumulateUsage **write 保留**（forked cost 必须落盘）；
    //   caller accumulateUsage 拿到 sid 链后对链上每个 sid 调 notifyUsageChanged
    //   （让 forked 分区增量即时可见，不依赖下一轮 main assemble）。先 await write 完再 notify
    //   （读全量 view emit，spec §3 顺序契约）。
    const chain = await store.accumulateUsage(sid, 'forked', forkedResult.usage);
    for (const s of chain) await store.notifyUsageChanged(s);

    // v0.0.55：markSummaryDone → lock.markDone（subsumes；内存 CAS running → done）
    if (taskLock) taskLock.markDone(sid, 'compact');

    // —— compact 后置阶段（失败隔离：异常只 log，不影响已完成的 compact）——
    //   1. 「假装 assemble」合成 postSnapshot（压缩后视图，镜像 base_builder rebuild 产出）
    //   2. postSnapshot 重算 contextWindowUsage 立即写回主 session store（消 usage 面板时滞）
    //   3. post-compact EP 派发（consolidate 等 handler，fire-and-forget；prevSnapshot=入口
    //      传入的压缩前快照 + postSnapshot 压缩后视图，handler 自行决定用哪个）
    try {
      const postSnapshot = await buildPostCompactSnapshot(store, config, snapshot, block);
      await store.updateContextWindowUsage(sid, postSnapshot.contextWindowUsage);
      dispatchPostCompact(pluginCtx, config, snapshot, postSnapshot, triggerMessageId, triggerUsage);
    } catch (postErr) {
      const postMsg = postErr instanceof Error ? postErr.message : String(postErr);
      console.warn(`[runCompact post-phase] ${postMsg}`);
    }
    return true;
  } catch (err) {
    // 失败 → lock.markFailed + rethrow（caller 可观测；summaryUpTo 不推进，下次 compact 仍可重试）
    const msg = err instanceof Error ? err.message : String(err);
    if (taskLock) taskLock.markFailed(sid, 'compact', msg);
    throw err;
  }
}
