/**
 * session-store-usage-impl — SessionStore 的 usage/summary 维度方法实现
 *
 * 纯 move 自 session-store.ts（v0.0.156 结构性拆分）。函数体 100% copy-paste，
 * 签名 + 内部逻辑不变。class 内方法改为单行委托到本文件 standalone 函数。
 * 参考: specs/tech/version_logs/v0.0.156/change_plan.md §4.4-4.5 + INV-S-4
 *
 * 方法组（grep 已核实）：
 *   - getSummary / setSummary（summary CRUD）
 *   - accumulateUsage / updateContextWindowUsage（纯 write 不 emit；只写不推场景用——compact 纯生产者）
 *   - updateUsage（写 + 推一体统一接口，caller 只 set 不推）/ notifyUsageChanged（纯推）
 *   - getRatio / getUsageView / persistUsage
 *
 * INV-S-4：accumulateUsage 三分区累加 + ratio 滑动 3 中位数 + statusBus emit 语义全部保留。
 *
 * packaged 护栏（INV-PKG-1/2）：不读 process.env；不拼接相对路径；store 作入参。
 */
import { ulid } from '../config/ulid';
import { SessionSchema, SummarySchema, RunSchema } from './schema_defs';
import type { SummaryRecord } from './schema_defs';
import type { Usage, ContextWindowUsage } from '../message/types';
import type { SessionStore } from './session-store';
import type { SummaryInfo, SessionUsageView, UsagePartition, UpdateUsageOpts } from './session-store-types';
import { ZERO_USAGE_VIEW } from './session-store-types';
import { toSummary } from './session-store-converters';
import type { ReplayableEventBus } from './event-bus';
import type { SessionUsageUpdateEvent } from './session-event-types';
// [v0.0.194] token 统计 subscriber（fire-and-forget 异步写 token_usage_stat）
import { notifyTokenUsageSubscriber } from '../squad/token-usage/token-usage-subscriber';
import {
  normalizeMeta, normalizePartition, accumulatePartition, computeRatioSample, pushRatioSample,
  deriveUsageView, normalizeContextWindowUsage,
} from './session-usage-helper';

/** 读 summary；不存在返 null */
export async function sessionStoreGetSummary(
  store: SessionStore,
  sessionId: string,
): Promise<SummaryInfo | null> {
  const got = store.crud.get(SummarySchema, sessionId, sessionId);
  if (!got) return null;
  return toSummary(got as never);
}

/** 写/覆盖 summary（upsert 语义；id 固定为 sessionId） */
export async function sessionStoreSetSummary(
  store: SessionStore,
  sessionId: string,
  summary: { content: string; summaryUpTo: string | null; block?: string },
): Promise<void> {
  const rec: SummaryRecord = {
    id: sessionId,
    sessionId,
    summaryUpTo: summary.summaryUpTo ?? undefined,
    content: summary.content,
    // [v0.0.186] 烘焙 block 文本（compact 传入时落盘；未传 → 不写字段，旧记录形态不变）
    ...(summary.block !== undefined ? { block: summary.block } : {}),
  };
  // putAsync 串行化（spec §6.1 [wait]）：compaction 后写 summary
  await store.crud.putAsync(SummarySchema, rec);
}

/**
 * 累加 usage 到某分区（write/notify 分离，spec session_usage.md §6）。
 *   1. 读 session.usage 的 type 分区 + 各字段 Σ + llmCallCount++ + 写回
 *   2. type=current 时学 ratio（§7）
 *   3. 有 parentSessionId → 递归 accumulateUsage(parent, "sub", usage)
 *   4. **不 emit**（纯 write 不推）——常规 caller 走 updateUsage（写+推一体）；
 *      只写不推场景（compact 纯生产者）直接用本方法，推送由下一轮 assemble 携带
 *
 * @param type current=自己 loop / sub=子 agent 上报 / forked=forked agent（compact/memory）
 * @returns 本次 write 涉及的 sid 链（含自身 + 递归 parent，顶层最后），供调用方 batch notify。
 *   session 不存在时返回空数组（容错静默）。
 */
export async function sessionStoreAccumulateUsage(
  store: SessionStore,
  sessionId: string,
  type: UsagePartition,
  usage: Usage,
): Promise<string[]> {
  const rec = store.crud.get(SessionSchema, sessionId);
  if (!rec) return []; // 容错：session 不存在静默忽略（返空链，无 sid 需 notify）
  const meta = normalizeMeta(rec.usage);
  // step1: 累加到对应分区
  const partitionKey = type; // current | sub | forked
  meta[partitionKey] = accumulatePartition(meta[partitionKey], usage);
  // step2: type=current 时学 ratio（仅自己 loop 的真实 LLM 调用喂窗口）
  if (type === 'current') {
    const sample = computeRatioSample(usage);
    if (sample !== null) {
      meta.ratio = pushRatioSample(meta.ratio, sample);
    }
  }
  // 写回 session.usage（spread existing 保留运行态字段）
  // putAsync 串行化（spec §6.1 [wait]）：usage read-modify-write 竞态
  await store.crud.putAsync(SessionSchema, store.stripEnvelope({
    ...rec,
    usage: meta as unknown,
  }));
  // step3: 递归 sub 上报 parent（spec session_usage.md §6.2）；返回全链
  const parentId = (rec as { parentSessionId?: string }).parentSessionId;
  if (parentId) {
    const parentChain = await sessionStoreAccumulateUsage(store, parentId, 'sub', usage);
    return [sessionId, ...parentChain];
  }
  return [sessionId];
}

/**
 * 更新 session 级 contextWindowUsage（写 session.contextWindowUsage meta）。
 * write/notify 分离：**纯 write，不 emit**——调用方在 write 完成后调 notifyUsageChanged。
 */
export async function sessionStoreUpdateContextWindowUsage(
  store: SessionStore,
  sessionId: string,
  cw: ContextWindowUsage,
): Promise<void> {
  await store.updateSession(sessionId, { contextWindowUsage: cw });
}

/**
 * 通知：读 getUsageView(sid) 全量 view → emit SessionEvent（type=session_usage_update）。
 * 与 write ops 独立解耦——调用方在 write 完成后显式触发（保证事件负载完整最新态、
 * 与 GET /session/:id/usage 同一权威源；spec session_usage.md §3/§6/§10）。
 * topic=session_panel，group=`session_id:<sid>`；session 不存在或 statusBus 未注入时静默 no-op。
 */
export async function sessionStoreNotifyUsageChanged(
  store: SessionStore,
  sessionId: string,
): Promise<void> {
  const statusBus: ReplayableEventBus | undefined = store.statusBus;
  if (!statusBus) return;
  const rec = store.crud.get(SessionSchema, sessionId);
  if (!rec) return; // session 不存在静默（与 accumulate 容错一致）
  const view = await sessionStoreGetUsageView(store, sessionId);
  const evt: SessionUsageUpdateEvent = {
    id: ulid(),
    type: 'session_usage_update',
    sessionId,
    createdAt: new Date().toISOString(),
    data: view,
  };
  statusBus.emit(`session_id:${sessionId}`, {
    data: evt,
    timestamp: new Date().toISOString(),
  });
  // [v0.0.194] fire-and-forget 触发 token 统计 subscriber（PRD P8/P10：异步写入不阻塞主流程，
  // 错误隔离——统计异常不崩主对话）。subscriber 自己决定记不记（subagent 跳过）。
  notifyTokenUsageSubscriber(sessionId, view, evt.createdAt).catch(() => {
    // 错误隔离：统计写入失败静默吞，不阻塞主对话
  });
}

/**
 * 统一更新 usage 并推送（写 + 推一体，caller 只 set 不推）。
 *
 * 封装边界：caller 不再显式「先 write 再 notify」——本方法内部连写带推：
 *   1. usagePartition+usage 成对传入 → accumulateUsage（三分区累加 + ratio 学习 + 递归 sub
 *      上报 parent），拿到 sid 链（含自身 + 递归 parent，顶层最后）
 *   2. contextWindowUsage 传入 → updateContextWindowUsage（纯 write）
 *   3. 全部写完后，对涉及的 sid 集合逐个 notifyUsageChanged（读 getUsageView 全量 emit——
 *      改 A 时 B 必为 store 最新值，天然不被置旧）
 *
 * 失败隔离：单 sid notify 失败仅 warn，不翻已完成的 write、不阻断链上其余 sid 推送。
 * 空 opts（无任何字段）→ 零写零推。
 *
 * 只写不推场景（compact 纯生产者：推送由下一轮 assemble 携带）不走本方法，
 * 直接调 accumulateUsage / updateContextWindowUsage。
 */
export async function sessionStoreUpdateUsage(
  store: SessionStore,
  sessionId: string,
  opts: UpdateUsageOpts,
): Promise<void> {
  const sidsToNotify: string[] = [];
  if (opts.usagePartition && opts.usage) {
    const chain = await sessionStoreAccumulateUsage(store, sessionId, opts.usagePartition, opts.usage);
    sidsToNotify.push(...chain);
  }
  if (opts.contextWindowUsage !== undefined) {
    await sessionStoreUpdateContextWindowUsage(store, sessionId, opts.contextWindowUsage);
    if (!sidsToNotify.includes(sessionId)) sidsToNotify.push(sessionId);
  }
  for (const sid of sidsToNotify) {
    try {
      await sessionStoreNotifyUsageChanged(store, sid);
    } catch (err) {
      // 失败隔离：推送失败不翻 write、不阻断链上其余 sid
      console.warn(
        `[updateUsage] notifyUsageChanged(${sid}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * 读当前 char/token ratio（spec session_usage.md §7）。
 * 窗口未满返 1.0（冷启动）；满 3 取中位数。
 */
export async function sessionStoreGetRatio(
  store: SessionStore,
  sessionId: string,
): Promise<number> {
  const rec = store.crud.get(SessionSchema, sessionId);
  if (!rec) return 1.0;
  return normalizeMeta(rec.usage).ratio.current;
}

/**
 * 聚合 usage view（spec session_usage.md §8）。
 * 从三分区 + ratio + 最近 contextWindowUsage 派生 SessionUsageView。
 * cw 反序列化经 normalizeContextWindowUsage 兜底（兼容旧 3 字段 record）。
 */
export async function sessionStoreGetUsageView(
  store: SessionStore,
  sessionId: string,
): Promise<SessionUsageView> {
  const rec = store.crud.get(SessionSchema, sessionId);
  if (!rec) return ZERO_USAGE_VIEW;
  const meta = normalizeMeta(rec.usage);
  // normalize 兜底：旧 record（3 字段）补全 7 字段
  const cw = rec.contextWindowUsage !== undefined
    ? normalizeContextWindowUsage(rec.contextWindowUsage)
    : undefined;
  return deriveUsageView(meta, cw);
}

/**
 * run 结束落 run 级 contextWindowUsage + 累计 token usage。
 * run schema 带 token usage 字段，崩溃恢复可重建（spec session_usage.md §10）。
 */
export async function sessionStorePersistUsage(
  store: SessionStore,
  sessionId: string,
  runId: string,
  cw: ContextWindowUsage,
  runUsage?: Usage,
): Promise<void> {
  if (runUsage) {
    // run 级累加（崩溃恢复 / 历史查询重建累计视图用）
    const run = store.crud.get(RunSchema, runId, sessionId);
    if (run) {
      const existing = normalizePartition(run.usage);
      const accumulated = accumulatePartition(existing, runUsage);
      // putAsync 串行化（spec §6.1 [wait]）：run 级 usage read-modify-write 竞态
      await store.crud.putAsync(RunSchema, store.stripEnvelope({
        ...run,
        contextWindowUsage: cw as unknown,
        usage: accumulated as unknown,
      }));
      return;
    }
  }
  await store.updateRun(sessionId, runId, { contextWindowUsage: cw });
}
