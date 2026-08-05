/**
 * compact 后置阶段 — postSnapshot 合成（假装 assemble）+ usage 立即更新 + post-compact EP 派发
 * 参考: specs/tech/agent/context/[P0]context_compact_detail.md §2d（post-compact EP）
 *       specs/tech/agent/context/[P0]context_assemble_detail.md §6（summary block + recent 产出结构）
 *
 * 职责：runCompact 成功（setSummary + accumulateUsage + markDone）后的统一后置处理，
 *   手动（ContextEngine.compact）/ 自动（tryCompact → summary_do_compact）两路径共享：
 *
 *   1. buildPostCompactSnapshot：不真跑 assemble 链，基于 compact 产出（烘焙 summary block）
 *      + transcript 本地合成「压缩后视图」快照——镜像 base_builder rebuild 的产出结构
 *      （[summaryMsg, ...recent]，msg[0] 文本 = 烘焙 block，与下次真 assemble 逐字节一致）。
 *   2. usage 立即更新：postSnapshot 的消息重算 contextWindowUsage 写回主 session 持久 store
 *      （消「等下次 assemble 才更新」的时滞；注意这里写的是 runCompact 的主 session store，
 *      不是 fork-1 summary run 的 in_memory store——后者 updateContextWindowUsage 是 no-op）。
 *   3. dispatchPostCompact：getExtensionImpls(ContextPostCompactPoint, scopeId) 按 scope 读
 *      配置取 handler，fire-and-forget 调 handle（失败只 log 不 rethrow，不影响已完成的
 *      compact）。EP 可插拔：default scope 激活 memory_skill_consolidation；summary/consolidate
 *      scope 激活 noop_post_compact（空操作，保证 consolidate 不再递归触发整理）。
 */
import type { Message, ContextWindowUsage } from '../message/types';
import type { SessionStore } from './session-store';
import type { ContextSnapshot, SessionConfig, AppConfigLike } from './context-types';
import { ContextPostCompactPoint } from '../plugin/extension-point';
import type {
  CompactPluginContext,
  PostCompactCtx,
  PostCompactHandler,
} from './compact-types';
import {
  getEstimatedOutput,
  pickRecentWithinBudget,
  SUMMARY_BUDGET_RATIO,
} from './summary-block';
import {
  estimateChars,
  estimateMessageChars,
  estimateToolChars,
  computeContextWindowUsage,
} from './context-usage-calc';
import { firstText } from './assemble-pipeline';

/**
 * 「假装 assemble」合成 postSnapshot（压缩后视图）。
 *
 * 镜像 base_builder rebuild 产出（烘焙 block 路径）：
 *   - msg[0] = summaryMsg（role=user，文本 = 烘焙 block，id = `summary:${version}`）
 *   - recent = transcript 中 summaryUpTo 之后的消息（新→旧累加至剩余 budget，超额丢最旧）
 *   - system 复用 prevSnapshot.system（compact 不动 system prompt）
 *   - contextWindowUsage 用 post 消息集重算（与 assemble 同算式：char×ratio 三分项）
 *
 * @param store 主 session 持久 store（读 freshSummary/transcript/ratio）
 * @param config session context（tokenLimit/appConfig/tools）
 * @param prevSnapshot runCompact 入口传入的压缩前快照（system/tools 复用源）
 * @param bakedBlock runCompact 刚烘焙的 summary block 文本（freshSummary 缺 block 时兜底）
 */
export async function buildPostCompactSnapshot(
  store: SessionStore,
  config: SessionConfig,
  prevSnapshot: ContextSnapshot,
  bakedBlock: string,
): Promise<ContextSnapshot> {
  const sid = config.sessionId;
  // 重读 summary 记录拿 version（setSummary 刚写入）；msg id `summary:${version}` 与 base_builder 同形态
  const freshSummary = await store.getSummary(sid);
  const summaryText = freshSummary?.block ?? bakedBlock;
  const version = freshSummary?.version ?? prevSnapshot.summary?.version ?? 0;

  // recent：transcript 中 summaryUpTo 之后的消息（镜像 base_builder 切窗；
  //   掉出窗口（-1）时整个窗口都比 summaryUpTo 新 → 全作 recent）
  const summaryUpTo = freshSummary?.summaryUpTo ?? null;
  const page = await store.getMessages(sid, { limit: 10000 });
  const transcript = page.items; // 升序（旧→新）
  const upToIdx = summaryUpTo == null ? -1 : transcript.findIndex((m) => m.id === summaryUpTo);
  const recentAll = upToIdx >= 0 ? transcript.slice(upToIdx + 1) : transcript;

  // recent budget（与 base_builder / bakeSummaryBlock 同口径：0.95×tokenLimit − estimatedOutput）
  const ratio = await store.getRatio(sid);
  const tokenLimit = config.client.contextWindow;
  const estimatedOutput = getEstimatedOutput(config.appConfig);
  const budgetTokens = Math.max(0, SUMMARY_BUDGET_RATIO * tokenLimit - estimatedOutput);
  const budgetChars = ratio > 0 ? budgetTokens / ratio : budgetTokens;
  const recent = pickRecentWithinBudget(recentAll, Math.max(0, budgetChars - summaryText.length));

  // summary role=user（与 base_builder 同：对话 recap 是 user 提供的上下文，非 system 指令）
  const summaryMsg: Message = {
    id: `summary:${version}`,
    sessionId: sid,
    role: 'user',
    content: [{ type: 'text', text: summaryText }],
  };
  const messages = [summaryMsg, ...recent];

  // cw 重算（与 assemble 同算式：system 不变 + post 消息集 + tools；ratio 同源 store.getRatio）
  const systemCharCount = estimateChars(firstText(prevSnapshot.system));
  const messageCharCount = messages.reduce((n, m) => n + estimateMessageChars(m), 0);
  const toolCharCount = estimateToolChars(config.tools);
  const contextWindowUsage = await computeContextWindowUsage(
    store,
    sid,
    tokenLimit,
    { system: systemCharCount, message: messageCharCount, tool: toolCharCount },
    (config.appConfig ?? null) as AppConfigLike | null,
  );

  return {
    ...prevSnapshot,
    messages,
    summary: freshSummary ?? prevSnapshot.summary,
    contextWindowUsage,
    inputCharCount: systemCharCount + messageCharCount + toolCharCount,
  };
}

/**
 * post-compact EP 派发（fire-and-forget，失败隔离）。
 *
 * 按 pluginCtx.scopeId 读配置取 active handler（EP 可插拔，不硬编码 consolidate）；
 * 取首个 handler 调 handle（现状 exclusive 口径；ordered 多 handler 链式未启用）。
 * handler 收 PostCompactCtx（prevSnapshot 压缩前 + postSnapshot 压缩后，自行决定用哪个）。
 * 同步/异步异常都只 log 不 rethrow（caller runCompact 的后置 try/catch 双保险）。
 */
export function dispatchPostCompact(
  pluginCtx: CompactPluginContext | undefined,
  config: SessionConfig,
  prevSnapshot: ContextSnapshot,
  postSnapshot: ContextSnapshot,
  triggerMessageId?: string,
  triggerUsage?: ContextWindowUsage,
): void {
  const pm = pluginCtx?.pluginManager;
  if (!pluginCtx || !pm) return; // UT fixture 无 plugin → 跳过 EP 派发
  const handlers = pm.getExtensionImpls<PostCompactHandler>(
    ContextPostCompactPoint,
    pluginCtx.scopeId,
  );
  if (handlers.length === 0) return; // scope 未激活 post_compact → 静默跳过
  const ctx: PostCompactCtx = {
    config,
    prevSnapshot,
    postSnapshot,
    store: pluginCtx.store,
    scopeId: pluginCtx.scopeId,
    taskLock: pluginCtx.taskLock,
    consolidateRunner: pluginCtx.consolidateRunner ?? undefined,
    toolDefinitions: prevSnapshot.tools,
    triggerMessageId,
    triggerUsage,
  };
  void handlers[0]!.handle(ctx).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[post-compact handler] ${msg}`);
  });
}
